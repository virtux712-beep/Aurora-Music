import { app, BrowserWindow, Menu, nativeTheme, shell } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { configureCoversDirectory, registerMediaProtocol, registerMediaScheme } from './media'
import { importAudioFiles, initLibrary, setLibraryNotifier } from './library'
import { setScrapeNotifier } from './libraryScrape'
import { sweepTagTemps } from './libraryTools'
import { registerIpcHandlers } from './ipc'
import { getSettings, initSettings } from './settings'
import { applyWindowChrome, resolveThemeMode, titleBarOverlay } from './windowChrome'
import { initializeSources, startHealthMonitor, stopHealthMonitor } from './sources'
import { initSecretStore, allSecrets } from './secretStore'
import { initCustomSources } from './customSources/store'
import { initScriptSources } from './scriptSources/store'
import { disposeAllScriptHosts } from './scriptHost/host'
import { initLyricsService } from './lyrics'
import { disposeDesktopLyrics, initDesktopLyrics, sendPlayerCommand } from './desktopLyrics'
import { disposeSystemIntegration, registerSystemIntegration, shouldHideOnClose } from './systemIntegration'
import { closeDatabase, initDatabase } from './database'
import { initDiagnostics } from './diagnostics'
import { autoCheckUpdates } from './updates'
import { startHttpApi, stopHttpApi } from './httpApi'
import { disposeDownloads, initDownloads, setDownloadNotifier } from './downloads'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

let mainWindow: BrowserWindow | null = null

registerMediaScheme()

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload)
  }
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1060,
    minHeight: 680,
    show: false,
    backgroundColor: '#0d1016',
    /*
     * No native caption at all.
     *
     * A caption always brings the window icon with it — Windows draws the app icon (Electron's default
     * one here) inside the title bar and Electron exposes no way to hide just that icon. So the caption
     * is removed entirely and the three window buttons are drawn by Windows itself through
     * `titleBarOverlay`; the renderer paints the strip they sit on and provides the drag region.
     *
     * The overlay colour is the app's dark base, matching `.titlebar`, so the buttons blend into the
     * strip instead of sitting on a rectangle of a different shade.
     */
    titleBarStyle: 'hidden',
    // Opened with the *persisted* theme rather than a fixed dark strip, so a light-theme launch does
    // not paint a black bar for the first frame and then swap it. `whenReady` re-applies it once
    // settings are loaded; the renderer owns it from then on.
    titleBarOverlay: titleBarOverlay(resolveThemeMode(getSettings().theme)),
    // Blank on purpose: the caption carries no product text (the shell does the branding). The
    // renderer's <title> takes over once the page loads, so both are kept empty.
    title: ' ',
    webPreferences: {
      // Must stay .cjs: sandboxed preloads are CommonJS-only.
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      /*
       * Aurora is a music player: "start playing when I say so" is the whole product, and Chromium's
       * default policy is to withhold audio until the page has been interacted with. Beyond the
       * obvious (the play button appearing to do nothing on a fresh launch), it also decides whether
       * a plain `new AudioContext()` starts in `running` or sits in `suspended` — and a suspended
       * context can never have the analyser attached to it without silencing playback, which is what
       * made the spectrum view blank on some launches and fine on others.
       */
      autoplayPolicy: 'no-user-gesture-required',
    },
  })

  mainWindow = window
  window.once('ready-to-show', () => window.show())
  /*
   * 关闭到托盘 (opt-in). `preventDefault` keeps the window alive and `hide()` takes it off screen, so the
   * same window is restored — a destroyed-and-recreated window would lose every store it holds.
   */
  window.on('close', (event) => {
    if (mainWindow !== window) return
    if (!shouldHideOnClose()) return
    event.preventDefault()
    window.hide()
  })
  window.on('closed', () => {
    if (mainWindow !== window) return
    mainWindow = null
    // Closing Aurora's window means quitting Aurora. `window-all-closed` is not enough: a running
    // script source owns a hidden sandbox window, so "all windows" would never be reached and the
    // app would linger invisibly in the task manager.
    if (process.platform === 'darwin') return
    stopHealthMonitor()
    disposeDownloads()
    disposeAllScriptHosts()
    app.quit()
  })

  // The player never opens external pages in-app, and nothing may navigate the shell away.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event) => event.preventDefault())

  /*
   * Dev-only DevTools key.
   *
   * With no application menu there is no F12 anymore, and `npm run dev` would have no way into the
   * inspector. `ELECTRON_RENDERER_URL` is only set by the dev server, so the packaged app is untouched.
   */
  if (process.env.ELECTRON_RENDERER_URL) {
    window.webContents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') window.webContents.toggleDevTools()
    })
  }

  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadFile(join(__dirname, '../renderer/index.html'))
}

void app.whenReady().then(async () => {
  /*
   * No application menu: Aurora is a player, not a document editor, and every command it has lives in
   * the window itself (and the tray). Removing it also removes Chromium's default accelerators (reload,
   * close, zoom, DevTools), which is wanted — they are not part of this product's surface.
   */
  Menu.setApplicationMenu(null)

  setLibraryNotifier(broadcast)
  setScrapeNotifier(broadcast)
  setDownloadNotifier(broadcast)
  configureCoversDirectory(join(app.getPath('userData'), 'covers'))
  await initSettings()
  await initSecretStore(app.getPath('userData'))
  await initLyricsService()
  // Platforms are a read-only registry (main/platforms); user Sources are loaded from the unified registry (migrating the legacy file on first
  // run) and registered before anything can query them.
  await initCustomSources(app.getPath('userData'))
  // Script sources: the registry is loaded first (shared with every other kind), then each script
  // file is hash-checked before its sandbox host is allowed to run it.
  await initScriptSources(app.getPath('userData'), {
    preloadPath: join(__dirname, '../preload/script-host.cjs'),
  })
  // Restored downloads come back *paused*: the manager never restarts a transfer behind the user's
  // back, and the part files are already on disk waiting for a `resume`.
  await initDownloads(app.getPath('userData'))
  // The library's rows live in SQLite; opening it before `initLibrary` is what lets that function read
  // rows instead of the old JSON file (and import them on the first run after the upgrade).
  await initDatabase(app.getPath('userData'))
  // Crash log: installed before anything else can fail, and read back by the settings page.
  await initDiagnostics(app.getPath('userData'))
  await initLibrary()
  // Tag writes use a sibling temp file + rename; a crash in between leaves that sibling next to the
  // user's music, so every launch clears the ones it can name (best effort, never blocks startup).
  void sweepTagTemps()
  registerMediaProtocol()
  registerIpcHandlers(() => mainWindow)
  createWindow()

  /*
   * Native chrome follows the theme from here on: `system` has to be re-resolved whenever Windows
   * flips (the renderer re-sends its mode too, but a system-theme change never crosses the IPC
   * boundary on its own).
   */
  nativeTheme.on('updated', () => {
    if (getSettings().theme === 'system') applyWindowChrome(mainWindow, 'system')
  })
  applyWindowChrome(mainWindow, getSettings().theme)

  // The separate always-on-top lyrics window. It is restored here (after the app window exists, so
  // the very first player report is already available) and its channels are registered inside.
  await initDesktopLyrics(() => mainWindow)

  // Tray / taskbar buttons / media keys. They drive playback through the *same* command channel the
  // lyrics window uses, so there is exactly one path from "a click outside the app" to the
  // `<audio>` element.
  registerSystemIntegration({
    getMainWindow: () => mainWindow,
    forwardCommand: (command) => sendPlayerCommand(command),
  })

  // The local API is started only when it is enabled; a disabled server has no socket at all.
  await startHttpApi()

  // Plugin initialization never blocks the window: a slow API must not delay startup.
  void initializeSources(getSettings(), allSecrets()).catch(() => undefined)

  // Same rule for the update check: a network round trip must never be in the startup path.
  void autoCheckUpdates().catch(() => undefined)

  // Background health probe. It re-reads settings on every pass, so turning the toggle off (or
  // disabling a source) is picked up on the next tick rather than at the next launch.
  startHealthMonitor(() => getSettings(), () => allSecrets())

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    stopHealthMonitor()
    app.quit()
  }
})

app.on('before-quit', () => {
  stopHealthMonitor()
  void stopHttpApi()
  // Flushes the SQLite connection: a database left open leaves its lock directory behind.
  closeDatabase()
  // Global shortcuts and the tray belong to the OS, so they are released explicitly.
  disposeSystemIntegration()
  // Flushes the task index and aborts in-flight transfers before the process goes away.
  disposeDownloads()
  // Each script source owns a hidden renderer; leaving them behind would keep the process alive.
  disposeAllScriptHosts()
  // The lyrics window is another renderer: close it without rewriting `enabled`, so it comes back
  // next launch if it was on.
  disposeDesktopLyrics()
})

app.on('open-file', (event, filePath) => {
  event.preventDefault()
  void importAudioFiles([filePath])
})
