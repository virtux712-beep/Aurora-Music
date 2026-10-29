import { BrowserWindow, ipcMain, screen } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  DesktopLyricsSettings,
  DesktopLyricsTick,
  DesktopLyricsTrack,
  PlayerCommand,
  ReportedPlayerState,
} from '../shared/types'
import { getLyrics } from './lyrics'
import { getSettings, updateSettings } from './settings'

/**
 * The desktop-lyrics window: a separate, frameless, transparent, always-on-top strip that follows
 * the playback clock while the user works in other apps.
 *
 * Three rules shape this file:
 *
 *  1. **The app window owns the audio**, so this window never plays anything. It receives a
 *     *clock* (throttled ticks) and, once per track, the parsed lyric lines. Nothing about playback
 *     state is duplicated here — no second source of truth to drift.
 *  2. **It is a second renderer, so it gets its own minimal preload** (see
 *     `preload/desktop-lyrics.ts`). It never sees the library, the filesystem or the source runtime.
 *  3. **Locked means invisible to the mouse**: `setIgnoreMouseEvents(true, { forward: true })` lets
 *     clicks fall through to whatever is underneath, so a locked lyric cannot eat a click meant for
 *     the editor behind it.
 *
 * Lyrics are fetched **here**, not in the lyrics window: the main process already resolves lyrics
 * (user import → source → sidecar → embedded tags), so the window only renders.
 */

const __dirname = fileURLToPath(new URL('.', import.meta.url))

/** The clock is pushed at most this often; a 60 Hz report would be pure IPC churn. */
const TICK_INTERVAL_MS = 200

let lyricsWindow: BrowserWindow | null = null
let mainWindowGetter: (() => BrowserWindow | null) | null = null
let lastTrack: DesktopLyricsTrack | null = null
let lastTickAt = 0
let pendingTick: NodeJS.Timeout | null = null

/** Pushes options to the window and applies the parts the OS layer owns. */
function applyOptions(options: DesktopLyricsSettings): void {
  const window = lyricsWindow
  if (!window || window.isDestroyed()) return
  window.setAlwaysOnTop(options.alwaysOnTop, 'screen-saver')
  // A locked lyric must not intercept clicks: forward them so the app under it still works.
  window.setIgnoreMouseEvents(options.locked, { forward: true })
  window.webContents.send('desktop-lyrics:options', options)
}

/**
 * Default placement: horizontally centred, near the bottom of the current display, clear of the
 * taskbar. Only used when the settings carry no position yet (a negative x/y).
 */
function defaultBounds(settings: DesktopLyricsSettings): { x: number; y: number } {
  const display = screen.getPrimaryDisplay().workArea
  return {
    x: Math.round(display.x + (display.width - settings.width) / 2),
    y: Math.round(display.y + display.height - settings.height - 90),
  }
}

function createWindow(options: DesktopLyricsSettings): BrowserWindow {
  const display = screen.getPrimaryDisplay().workArea
  const fallback = defaultBounds(options)
  const x = options.x >= 0 ? Math.min(options.x, display.x + display.width - 120) : fallback.x
  const y = options.y >= 0 ? Math.min(options.y, display.y + display.height - 60) : fallback.y

  const window = new BrowserWindow({
    x,
    y,
    width: options.width,
    height: options.height,
    minWidth: 320,
    minHeight: 90,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: true,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: options.alwaysOnTop,
    title: 'Aurora 桌面歌词',
    webPreferences: {
      preload: join(__dirname, '../preload/desktop-lyrics.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // A lyric window that keeps painting while unfocused must not be throttled to 1 Hz.
      backgroundThrottling: false,
    },
  })

  // Nothing may navigate this window away or open popups from it.
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())

  const persistBounds = debounce(() => {
    const bounds = window.getBounds()
    void updateSettings({
      desktopLyrics: { ...getSettings().desktopLyrics, x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
    })
  }, 400)
  window.on('move', persistBounds)
  window.on('resize', persistBounds)

  window.on('closed', () => {
    if (lyricsWindow === window) lyricsWindow = null
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(`${process.env.ELECTRON_RENDERER_URL}/desktop-lyrics.html`)
  } else {
    void window.loadFile(join(__dirname, '../renderer/desktop-lyrics.html'))
  }

  window.once('ready-to-show', () => {
    window.showInactive()
    applyOptions(getSettings().desktopLyrics)
  })

  return window
}

function debounce(fn: () => void, ms: number): () => void {
  let timer: NodeJS.Timeout | null = null
  return () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      fn()
    }, ms)
  }
}

function pushTrack(track: DesktopLyricsTrack | null): void {
  lastTrack = track
  if (lyricsWindow && !lyricsWindow.isDestroyed()) {
    lyricsWindow.webContents.send('desktop-lyrics:track', track)
  }
}

function pushTick(tick: DesktopLyricsTick): void {
  if (lyricsWindow && !lyricsWindow.isDestroyed()) {
    lyricsWindow.webContents.send('desktop-lyrics:tick', tick)
  }
}

/** Builds the payload the lyrics window renders, resolving lyrics through the normal pipeline. */
async function trackPayload(state: ReportedPlayerState): Promise<DesktopLyricsTrack | null> {
  const track = state.track
  if (!track || !track.id) return null
  let lines: DesktopLyricsTrack['lines'] = []
  try {
    const lyrics = await getLyrics(track, getSettings())
    lines = lyrics?.lines ?? []
  } catch {
    // A lyric lookup failure only means "no lyrics for this track", never a broken window.
    lines = []
  }
  return {
    trackId: track.id,
    title: track.title || state.title,
    artist: track.artist || state.artist,
    album: track.album ?? '',
    duration: Number.isFinite(state.duration) ? state.duration : (track.duration ?? 0),
    hasLyrics: lines.length > 0,
    lines,
  }
}

/**
 * Called for every player report from the app window.
 *
 * Track changes resolve lyrics once (async); the clock is forwarded on a timer, because the report
 * cadence is owned by the `<audio>` element and must not decide the IPC cadence of another window.
 */
export function handlePlayerReport(state: ReportedPlayerState): void {
  const tick: DesktopLyricsTick = {
    currentTime: Number.isFinite(state.currentTime) ? Math.max(state.currentTime, 0) : 0,
    isPlaying: state.isPlaying === true,
    duration: Number.isFinite(state.duration) ? Math.max(state.duration, 0) : 0,
    // Read per tick from settings rather than cached: the user may be adjusting it right now, and the
    // correction has to land on the next line, not on the next track.
    offsetMs: getSettings().lyricsOffsetMs,
  }

  if (!lyricsWindow || lyricsWindow.isDestroyed()) {
    // Keep the track identity fresh even while the window is closed, so opening it later is instant.
    if (state.track && state.track.id !== lastTrack?.trackId) {
      void trackPayload(state).then((payload) => pushTrack(payload))
    }
    return
  }

  const trackChanged = (state.track?.id ?? '') !== (lastTrack?.trackId ?? '')
  if (trackChanged) {
    void trackPayload(state).then((payload) => {
      // A newer track won the race while the lyrics were loading.
      if (payload && payload.trackId === (state.track?.id ?? '')) pushTrack(payload)
    })
  }

  const now = Date.now()
  if (now - lastTickAt >= TICK_INTERVAL_MS) {
    lastTickAt = now
    pushTick(tick)
    return
  }
  // Coalesce the reports that arrive inside the throttle window into one trailing tick.
  if (!pendingTick) {
    pendingTick = setTimeout(() => {
      pendingTick = null
      lastTickAt = Date.now()
      pushTick(tick)
    }, TICK_INTERVAL_MS - (now - lastTickAt))
  }
}

/**
 * The single way playback is driven from outside the renderer.
 *
 * The desktop-lyrics window and the OS integrations (tray, taskbar buttons, media keys) all call
 * this, so "a click that is not in the app window" has exactly one implementation and one target:
 * the window that owns the `<audio>` element.
 */
export function sendPlayerCommand(command: PlayerCommand): void {
  const window = mainWindowGetter?.() ?? null
  if (window && !window.isDestroyed()) window.webContents.send('player:command', command)
}

function forwardCommand(command: PlayerCommand): void {
  sendPlayerCommand(command)
}

/** Reads + clamps the requested patch, persists it and applies it to the live window. */
async function patchOptions(patch: Partial<DesktopLyricsSettings>): Promise<DesktopLyricsSettings> {
  const next = await updateSettings({ desktopLyrics: patch })
  const options = next.desktopLyrics
  applyOptions(options)
  const window = lyricsWindow
  if (window && !window.isDestroyed()) {
    const bounds = window.getBounds()
    if (bounds.width !== options.width || bounds.height !== options.height) {
      window.setBounds({ width: options.width, height: options.height })
    }
  }
  return options
}

/** Shows/hides the window. Returns the settings so the caller (and UI) sees the real state. */
export async function setDesktopLyricsEnabled(enabled: boolean): Promise<DesktopLyricsSettings> {
  const next = await updateSettings({ desktopLyrics: { enabled } })
  const options = next.desktopLyrics

  if (!options.enabled) {
    if (lyricsWindow && !lyricsWindow.isDestroyed()) lyricsWindow.close()
    lyricsWindow = null
    return options
  }

  if (!lyricsWindow || lyricsWindow.isDestroyed()) {
    lyricsWindow = createWindow(options)
  } else {
    applyOptions(options)
  }
  return options
}

export async function toggleDesktopLyrics(): Promise<DesktopLyricsSettings> {
  return setDesktopLyricsEnabled(!getSettings().desktopLyrics.enabled)
}

export function getDesktopLyricsOptions(): DesktopLyricsSettings {
  return getSettings().desktopLyrics
}

export async function setDesktopLyricsOptions(patch: Partial<DesktopLyricsSettings>): Promise<DesktopLyricsSettings> {
  return patchOptions(patch)
}

/** Puts the window back to its default size and a sane position on the primary display. */
export async function resetDesktopLyricsPosition(): Promise<DesktopLyricsSettings> {
  const current = getSettings().desktopLyrics
  const bounds = defaultBounds(current)
  const options = await patchOptions({ x: bounds.x, y: bounds.y })
  if (lyricsWindow && !lyricsWindow.isDestroyed()) lyricsWindow.setPosition(bounds.x, bounds.y)
  return options
}

/**
 * Called once at startup: registers the channels this window may use, and reopens the window if the
 * user had it on when they last quit.
 *
 * The window is created **after** the app window is ready so the very first report is already
 * available; `ready` from the renderer then triggers a fresh push.
 */
export function registerDesktopLyrics(getMainWindow: () => BrowserWindow | null): void {
  mainWindowGetter = getMainWindow

  /** Only the lyrics window may talk about itself; another renderer has no business here. */
  const fromLyricsWindow = (event: { sender: Electron.WebContents }): boolean =>
    Boolean(lyricsWindow && !lyricsWindow.isDestroyed() && event.sender.id === lyricsWindow.webContents.id)

  // The lyric window's whole capability surface. It cannot reach anything else: its preload only
  // exposes these four channels plus the option setter.
  ipcMain.handle('desktop-lyrics:ready', (event) => {
    if (!fromLyricsWindow(event)) return
    lyricsWindow?.webContents.send('desktop-lyrics:options', getSettings().desktopLyrics)
    lyricsWindow?.webContents.send('desktop-lyrics:track', lastTrack)
  })

  /** The app window may also patch appearance (its settings UI owns the same controls). */
  const fromMainWindow = (event: { sender: Electron.WebContents }): boolean => {
    const main = mainWindowGetter?.() ?? null
    return Boolean(main && !main.isDestroyed() && event.sender.id === main.webContents.id)
  }

  // Shared with the app window's settings UI, so either of our two renderers may patch
  // appearance — but it still has to be one of ours, like every other channel here.
  ipcMain.handle('desktop-lyrics:set-options', (event, patch: unknown) => {
    if (!fromLyricsWindow(event) && !fromMainWindow(event)) return undefined
    return patchOptions((patch ?? {}) as Partial<DesktopLyricsSettings>)
  })

  ipcMain.handle('desktop-lyrics:hide', async (event) => {
    if (!fromLyricsWindow(event)) return
    await setDesktopLyricsEnabled(false)
  })

  ipcMain.on('desktop-lyrics:control', (event, command: unknown) => {
    if (!fromLyricsWindow(event)) return
    if (command === 'toggle-play' || command === 'next' || command === 'previous') forwardCommand(command)
  })
}

/** Startup hook: restores the window when the user left it enabled. */
export async function initDesktopLyrics(getMainWindow: () => BrowserWindow | null): Promise<void> {
  registerDesktopLyrics(getMainWindow)
  if (getSettings().desktopLyrics.enabled) {
    await setDesktopLyricsEnabled(true)
  }
}

/** Closes the window during shutdown without rewriting `enabled` (it stays on for next launch). */
export function disposeDesktopLyrics(): void {
  if (pendingTick) {
    clearTimeout(pendingTick)
    pendingTick = null
  }
  if (lyricsWindow && !lyricsWindow.isDestroyed()) lyricsWindow.destroy()
  lyricsWindow = null
}
