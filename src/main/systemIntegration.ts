import { app, globalShortcut, Menu, Tray, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import { glyphImage, trayImage } from './mediaGlyphs'
import { getSettings, updateSettings } from './settings'
import type { ReportedPlayerState, SystemIntegrationSettings, SystemIntegrationStatus } from '../shared/types'

/**
 * Everything Aurora does outside its own window: the tray icon, the Windows taskbar thumbnail
 * buttons, and the global media keys.
 *
 * All three are the *same* feature from the user's point of view — "control playback without
 * switching to Aurora" — so they live in one module and all three drive playback the same way the
 * desktop-lyrics window does: by sending `player:command` to the app window, which owns the
 * `<audio>` element. There is no second playback path here, and no second source of truth about what
 * is playing: the tray renders `ReportedPlayerState`, which is the renderer's own report.
 *
 * Each piece is independently switchable and re-applied live when settings change, so turning the
 * tray off does not need a restart.
 */

type PlayerCommand = 'toggle-play' | 'next' | 'previous'

let tray: Tray | null = null
let mainWindowGetter: (() => BrowserWindow | null) | null = null
let forward: ((command: PlayerCommand) => void) | null = null
let lastState: ReportedPlayerState | null = null
let registeredKeys: string[] = []
/** The last string handed to `tray.setToolTip`. `Tray` has no getter, and a test asserting that the
 * tray follows the track needs something to read. */
let lastTooltip = ''

/** Menu labels follow the reported state, so they never disagree with the player bar. */
function trackLabel(state: ReportedPlayerState | null): string {
  if (!state || (!state.title && !state.artist)) return '没有播放中的曲目'
  const parts = [state.title, state.artist].filter((part) => part && part.trim())
  const label = parts.join(' — ')
  return label.length > 72 ? `${label.slice(0, 71)}…` : label
}

function buildTrayMenu(): Menu {
  const settings = getSettings().systemIntegration
  const state = lastState
  const items: MenuItemConstructorOptions[] = [
    { label: settings.showTrackInTray ? trackLabel(state) : 'Aurora 音乐播放器', enabled: false },
    { type: 'separator' },
    { label: state?.isPlaying ? '暂停' : '播放', click: () => forward?.('toggle-play') },
    { label: '上一首', click: () => forward?.('previous') },
    { label: '下一首', click: () => forward?.('next') },
    { type: 'separator' },
    {
      label: '显示 / 隐藏主窗口',
      click: () => {
        const window = mainWindowGetter?.() ?? null
        if (!window || window.isDestroyed()) {
          // No window at all (it can only happen while the app is tearing down). `activate` is the
          // one signal the shell understands for "bring the app forward", and index.ts rebuilds the
          // window on it — calling `createWindow` from here would invert the dependency.
          app.emit('activate')
          return
        }
        if (window.isVisible() && !window.isMinimized()) window.hide()
        else {
          if (window.isMinimized()) window.restore()
          window.show()
          window.focus()
        }
      },
    },
    { label: getSettings().desktopLyrics.enabled ? '关闭桌面歌词' : '开启桌面歌词', click: () => toggleDesktopLyricsFromTray() },
    { type: 'separator' },
    { label: '退出 Aurora', click: () => app.quit() },
  ]
  return Menu.buildFromTemplate(items)
}

function refreshTray(): void {
  if (!tray || tray.isDestroyed()) return
  const settings = getSettings().systemIntegration
  lastTooltip = settings.showTrackInTray ? `${trackLabel(lastState)}\nAurora 音乐播放器` : 'Aurora 音乐播放器'
  tray.setToolTip(lastTooltip)
  tray.setContextMenu(buildTrayMenu())
}

/** Tray is opt-out: the icon appears unless the user turned it off. */
function applyTray(settings: SystemIntegrationSettings): void {
  if (!settings.tray) {
    if (tray && !tray.isDestroyed()) tray.destroy()
    tray = null
    return
  }
  if (tray && !tray.isDestroyed()) {
    refreshTray()
    return
  }
  try {
    tray = new Tray(trayImage())
  } catch {
    // A missing tray (some Linux sessions without a status-notifier host) must not break startup.
    tray = null
    return
  }
  // Left click toggles the window; the menu is on right click. `click` is not emitted on all
  // platforms, so this is a convenience rather than the only way in.
  tray.on('click', () => {
    const window = mainWindowGetter?.() ?? null
    if (!window || window.isDestroyed()) return
    if (window.isVisible() && !window.isMinimized()) window.hide()
    else {
      if (window.isMinimized()) window.restore()
      window.show()
      window.focus()
    }
  })
  // Double click is the "bring it back" gesture people expect from a tray icon: it never hides the
  // window, so a double click while the window is open simply raises it.
  tray.on('double-click', () => {
    const window = mainWindowGetter?.() ?? null
    if (!window || window.isDestroyed()) {
      app.emit('activate')
      return
    }
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  })
  refreshTray()
}

/**
 * Taskbar thumbnail buttons (Windows only, and only when the window is not using a custom one).
 *
 * The images are generated 32px glyphs; Windows scales them to the button size.
 */
function applyTaskbarButtons(settings: SystemIntegrationSettings): void {
  const window = mainWindowGetter?.() ?? null
  if (!window || window.isDestroyed()) return
  if (process.platform !== 'win32' || typeof window.setThumbarButtons !== 'function') return
  if (!settings.taskbarButtons) {
    window.setThumbarButtons([])
    return
  }
  const ok = window.setThumbarButtons([
    { tooltip: '上一首', icon: glyphImage('previous', 32), click: () => forward?.('previous') },
    {
      tooltip: lastState?.isPlaying ? '暂停' : '播放',
      icon: glyphImage(lastState?.isPlaying ? 'pause' : 'play', 32),
      click: () => forward?.('toggle-play'),
    },
    { tooltip: '下一首', icon: glyphImage('next', 32), click: () => forward?.('next') },
  ])
  // `false` means the OS refused (e.g. a plain taskbar without thumbnails): nothing to do, and
  // nothing to report as an error either.
  void ok
}

function applyMediaKeys(settings: SystemIntegrationSettings): void {
  for (const accelerator of registeredKeys) {
    try {
      globalShortcut.unregister(accelerator)
    } catch {
      // already gone
    }
  }
  registeredKeys = []
  if (!settings.mediaKeys) return

  const bindings: Array<[string, PlayerCommand]> = [
    ['MediaPlayPause', 'toggle-play'],
    ['MediaNextTrack', 'next'],
    ['MediaPreviousTrack', 'previous'],
    ['MediaStop', 'toggle-play'],
  ]
  for (const [accelerator, command] of bindings) {
    try {
      if (globalShortcut.register(accelerator, () => forward?.(command))) registeredKeys.push(accelerator)
    } catch {
      // Another application may already own the key; that is not a startup failure.
    }
  }
}

/**
 * Start-with-the-system registration.
 *
 * Kept in the OS rather than in settings alone: the switch has to reflect what the OS will really do, so
 * the value is *applied* here and read back through `getLoginItemSettings()` for the UI. On Windows the
 * executable path is passed explicitly — an unpackaged dev run would otherwise register `electron.exe`
 * with no app to load.
 */
function applyLaunchAtLogin(settings: SystemIntegrationSettings): void {
  try {
    const current = app.getLoginItemSettings().openAtLogin
    if (current === settings.launchAtLogin) return
    app.setLoginItemSettings({
      openAtLogin: settings.launchAtLogin,
      path: process.execPath,
      args: app.isPackaged ? [] : [app.getAppPath()],
    })
  } catch {
    // A locked-down machine may refuse to write the registry key; the status read below reports that.
  }
}

/** True when closing the window should hide to the tray instead of ending the process. */
export function shouldHideOnClose(): boolean {
  const settings = getSettings().systemIntegration
  // Hiding to a tray that failed to register would leave no way back to the window.
  return settings.closeToTray && Boolean(tray && !tray.isDestroyed())
}

/** Reads settings and applies every piece. Used at startup, on toggle, and after a settings change. */
export function applySystemIntegration(): void {
  const settings = getSettings().systemIntegration
  applyTray(settings)
  applyTaskbarButtons(settings)
  applyMediaKeys(settings)
  applyLaunchAtLogin(settings)
}

async function toggleDesktopLyricsFromTray(): Promise<void> {
  // Imported lazily: desktopLyrics imports this module's settings, and a static cycle here would be
  // resolved by whichever module happened to load first.
  const { toggleDesktopLyrics } = await import('./desktopLyrics')
  await toggleDesktopLyrics()
  refreshTray()
}

/**
 * Called from the player report handler. This is the only input: the tray and the taskbar buttons
 * are a *view* of the player state, never a parallel copy of it.
 */
export function onPlayerStateForSystemIntegration(state: ReportedPlayerState): void {
  const previous = lastState
  lastState = state
  const playingChanged = (previous?.isPlaying ?? false) !== state.isPlaying
  const trackChanged = (previous?.title ?? '') !== state.title || (previous?.artist ?? '') !== state.artist
  if (!playingChanged && !trackChanged) return
  refreshTray()
  applyTaskbarButtons(getSettings().systemIntegration)
}

export function registerSystemIntegration(options: {
  getMainWindow: () => BrowserWindow | null
  /** The one command channel: it reaches the window that owns the `<audio>` element. */
  forwardCommand: (command: PlayerCommand) => void
}): void {
  mainWindowGetter = options.getMainWindow
  forward = options.forwardCommand
  applySystemIntegration()
}

/** Releases OS resources. Global shortcuts are process-wide, so they must be let go explicitly. */
export function disposeSystemIntegration(): void {
  try {
    globalShortcut.unregisterAll()
  } catch {
    // nothing registered
  }
  registeredKeys = []
  if (tray && !tray.isDestroyed()) tray.destroy()
  tray = null
  const window = mainWindowGetter?.() ?? null
  if (window && !window.isDestroyed() && process.platform === 'win32' && typeof window.setThumbarButtons === 'function') {
    window.setThumbarButtons([])
  }
}

/** What the OS says, which is the only trustworthy answer for a login item. */
function readLaunchAtLogin(): boolean {
  try {
    return app.getLoginItemSettings().openAtLogin
  } catch {
    return false
  }
}

/**
 * What is actually registered right now — not what the settings say should be.
 *
 * The settings page renders this, and the packaged-app test asserts on it, which is the point: a
 * tray icon that silently failed to appear (no status-notifier host, a media key another app already
 * owns) must show up as "not active" rather than as a checked switch.
 */
export function getSystemIntegrationStatus(): SystemIntegrationStatus {
  const window = mainWindowGetter?.() ?? null
  return {
    trayActive: Boolean(tray && !tray.isDestroyed()),
    launchAtLogin: readLaunchAtLogin(),
    trayTooltip: lastTooltip,
    mediaKeys: [...registeredKeys],
    taskbarButtons: Boolean(
      process.platform === 'win32' &&
        window &&
        !window.isDestroyed() &&
        typeof window.setThumbarButtons === 'function' &&
        getSettings().systemIntegration.taskbarButtons,
    ),
    platform: process.platform,
  }
}

/**
 * Re-applies after the settings UI changed something.
 *
 * `updateSettings` is called by the IPC layer before this; re-reading here means the tray reflects
 * exactly what was persisted (including a patch the sanitiser clamped).
 */
export async function refreshSystemIntegration(): Promise<SystemIntegrationSettings> {
  applySystemIntegration()
  return (await updateSettings({})).systemIntegration
}
