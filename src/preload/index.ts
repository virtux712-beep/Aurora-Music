import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AuroraApi,
  AudioTrack,
  BackdropRect,
  ConvertFormat,
  DownloadTask,
  ImportProgress,
  PlayerCommand,
  ScrapeProgress,
  ScrapeRequest,
  SearchOptions,
  SourceConfigValue,
  SourceId,
  ThemeChrome,
  ThemeMode,
  TrackTagPatch,
} from '../shared/types'

/**
 * The renderer's only capability surface. Everything goes through IPC: the renderer has no network
 * access, no filesystem access and no Node APIs (`sandbox: true`, `contextIsolation: true`).
 */
const api: AuroraApi = {
  library: {
    list: () => ipcRenderer.invoke('library:list'),
    missing: () => ipcRenderer.invoke('library:missing'),
    addFiles: () => ipcRenderer.invoke('library:add-files'),
    addFolder: () => ipcRenderer.invoke('library:add-folder'),
    addPaths: (paths: string[]) => ipcRenderer.invoke('library:add-paths', paths),
    /*
     * The one call in this bridge that is not IPC.
     *
     * `webUtils.getPathForFile` lives in the preload because that is where Electron exposes it; a dropped
     * file's real location cannot be recovered from the renderer any other way (Chromium's `File.path` was
     * removed in Electron 32). Wrapped rather than handed over directly so a file the API cannot resolve
     * becomes an empty string here, where the caller's "no paths" branch already has to handle it.
     */
    pathsForFiles: (files: File[]) =>
      Array.from(files)
        .map((file) => {
          try {
            return webUtils.getPathForFile(file)
          } catch {
            return ''
          }
        })
        .filter((path) => path.length > 0),
    remove: (id) => ipcRenderer.invoke('library:remove', id),
    reveal: (id) => ipcRenderer.invoke('library:reveal', id),
    onImportProgress: (listener: (progress: ImportProgress) => void) => {
      const handler = (_event: unknown, progress: ImportProgress) => listener(progress)
      ipcRenderer.on('library:import-progress', handler)
      return () => ipcRenderer.removeListener('library:import-progress', handler)
    },
    scrape: (request: ScrapeRequest) => ipcRenderer.invoke('library:scrape', request),
    setTags: (patch: TrackTagPatch) => ipcRenderer.invoke('library:set-tags', patch),
    convert: (id: string, format: ConvertFormat) => ipcRenderer.invoke('library:convert', id, format),
    ffmpegStatus: (force?: boolean) => ipcRenderer.invoke('library:ffmpeg-status', force),
    onScrapeProgress: (listener: (progress: ScrapeProgress) => void) => {
      const handler = (_event: unknown, progress: ScrapeProgress) => listener(progress)
      ipcRenderer.on('library:scrape-progress', handler)
      return () => ipcRenderer.removeListener('library:scrape-progress', handler)
    },
    onChanged: (listener: (tracks: AudioTrack[]) => void) => {
      const handler = (_event: unknown, tracks: AudioTrack[]) => listener(tracks)
      ipcRenderer.on('library:changed', handler)
      return () => ipcRenderer.removeListener('library:changed', handler)
    },
  },
  platforms: {
    list: () => ipcRenderer.invoke('platforms:list'),
    searchAll: (query: string, options?: SearchOptions) => ipcRenderer.invoke('platforms:search-all', query, options),
    searchOne: (platformId: string, query: string, options?: SearchOptions) =>
      ipcRenderer.invoke('platforms:search-one', platformId, query, options),
    health: (platformId: string) => ipcRenderer.invoke('platforms:health', platformId),
    healthAll: () => ipcRenderer.invoke('platforms:health-all'),
    resolve: (track: AudioTrack, quality?: string) => ipcRenderer.invoke('platforms:resolve', track, quality),
    lyrics: (track: AudioTrack) => ipcRenderer.invoke('platforms:lyrics', track),
    boards: () => ipcRenderer.invoke('platforms:boards'),
    boardSongs: (platformId: string, boardId: string, limit?: number) =>
      ipcRenderer.invoke('platforms:board-songs', platformId, boardId, limit),
  },
  sources: {
    list: () => ipcRenderer.invoke('sources:list'),
    searchAll: (query: string, options?: SearchOptions) => ipcRenderer.invoke('sources:search-all', query, options),
    searchOne: (sourceId: SourceId, query: string, options?: SearchOptions) =>
      ipcRenderer.invoke('sources:search-one', sourceId, query, options),
    recommendations: (sourceId: SourceId, options?: SearchOptions) =>
      ipcRenderer.invoke('sources:recommendations', sourceId, options),
    playlists: (sourceId?: SourceId) => ipcRenderer.invoke('sources:playlists', sourceId),
    playlistDetail: (sourceId: SourceId, playlistId: string) =>
      ipcRenderer.invoke('sources:playlist-detail', sourceId, playlistId),
    resolve: (sourceId: SourceId, track: AudioTrack | string, quality?: string) =>
      ipcRenderer.invoke('sources:resolve', sourceId, track, quality),
    requests: (sourceId?: SourceId) => ipcRenderer.invoke('sources:requests', sourceId),
    setEnabled: (sourceId: SourceId, enabled: boolean) => ipcRenderer.invoke('sources:set-enabled', sourceId, enabled),
    setConfig: (sourceId: SourceId, patch: Record<string, SourceConfigValue>) =>
      ipcRenderer.invoke('sources:set-config', sourceId, patch),
    setOrder: (order: SourceId[]) => ipcRenderer.invoke('sources:set-order', order),
    health: (sourceId: SourceId) => ipcRenderer.invoke('sources:health', sourceId),
    pendingHosts: (sourceId?: SourceId) => ipcRenderer.invoke('sources:pending-hosts', sourceId),
    grantHosts: (sourceId: SourceId, hosts: string[]) => ipcRenderer.invoke('sources:grant-hosts', sourceId, hosts),
    revokeHosts: (sourceId: SourceId, hosts: string[]) =>
      ipcRenderer.invoke('sources:revoke-hosts', sourceId, hosts),
    selfCheck: (sourceId: SourceId, options?: { repair?: boolean; keyword?: string }) =>
      ipcRenderer.invoke('sources:self-check', sourceId, options),
    selfCheckAll: (options?: { keyword?: string; repair?: boolean }) =>
      ipcRenderer.invoke('sources:self-check-all', options),
    errors: (sourceId: SourceId) => ipcRenderer.invoke('sources:errors', sourceId),
  },
  customSources: {
    list: () => ipcRenderer.invoke('custom-sources:list'),
    templates: () => ipcRenderer.invoke('custom-sources:templates'),
    validate: (raw: string) => ipcRenderer.invoke('custom-sources:validate', raw),
    save: (raw: string) => ipcRenderer.invoke('custom-sources:save', raw),
    remove: (id: string) => ipcRenderer.invoke('custom-sources:remove', id),
    export: (id: string) => ipcRenderer.invoke('custom-sources:export', id),
  },
  scriptSources: {
    list: () => ipcRenderer.invoke('script-sources:list'),
    probe: (options) => ipcRenderer.invoke('script-sources:probe', options),
    save: (options) => ipcRenderer.invoke('script-sources:save', options),
    remove: (id: string) => ipcRenderer.invoke('script-sources:remove', id),
    reload: (id: string) => ipcRenderer.invoke('script-sources:reload', id),
    export: (id: string) => ipcRenderer.invoke('script-sources:export', id),
    inspect: (id: string) => ipcRenderer.invoke('script-sources:inspect', id),
    /** 洛雪音源库：预览在 main 里选文件并读取，import 只传被勾选的 id。 */
    lxLibraryOpen: () => ipcRenderer.invoke('script-sources:lx-library-open'),
    lxLibraryImport: (ids: string[]) => ipcRenderer.invoke('script-sources:lx-library-import', ids),
    lxLibraryCancel: () => ipcRenderer.invoke('script-sources:lx-library-cancel'),
  },
  systemIntegration: {
    get: () => ipcRenderer.invoke('system-integration:get'),
    set: (patch) => ipcRenderer.invoke('system-integration:set', patch),
    /** What the OS actually registered (tray present, media keys claimed), not what was asked for. */
    status: () => ipcRenderer.invoke('system-integration:status'),
  },
  sourceImport: {
    fromFile: () => ipcRenderer.invoke('source-import:file'),
    fromText: (text: string, fileName?: string) => ipcRenderer.invoke('source-import:text', text, fileName),
  },
  lyrics: {
    get: (track: AudioTrack) => ipcRenderer.invoke('lyrics:get', track),
    /** Background enrichment: searches the public catalogues and caches a hit. */
    search: (track: AudioTrack) => ipcRenderer.invoke('lyrics:search', track),
    /** 「联网自动匹配」: the whole chain, and a report of what each provider did. */
    match: (track: AudioTrack) => ipcRenderer.invoke('lyrics:match', track),
    save: (track: AudioTrack, raw: string) => ipcRenderer.invoke('lyrics:save', track, raw),
    clear: (track: AudioTrack) => ipcRenderer.invoke('lyrics:clear', track),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
  },
  player: {
    report: (state) => ipcRenderer.invoke('player:report', state),
    /** Play/pause, next or previous requested from outside this window (desktop lyrics, media keys). */
    onCommand: (listener: (command: PlayerCommand) => void) => {
      const handler = (_event: unknown, command: PlayerCommand): void => listener(command)
      ipcRenderer.on('player:command', handler)
      return () => ipcRenderer.removeListener('player:command', handler)
    },
  },
  desktopLyrics: {
    setEnabled: (enabled: boolean) => ipcRenderer.invoke('desktop-lyrics:set-enabled', enabled),
    toggle: () => ipcRenderer.invoke('desktop-lyrics:toggle'),
    options: () => ipcRenderer.invoke('desktop-lyrics:options'),
    // Same channel the lyrics window itself uses: both are our renderers, and the handler validates
    // the patch either way.
    setOptions: (patch) => ipcRenderer.invoke('desktop-lyrics:set-options', patch),
    resetPosition: () => ipcRenderer.invoke('desktop-lyrics:reset-position'),
  },
  downloads: {
    list: () => ipcRenderer.invoke('downloads:list'),
    start: (input) => ipcRenderer.invoke('downloads:start', input),
    pause: (id) => ipcRenderer.invoke('downloads:pause', id),
    resume: (id) => ipcRenderer.invoke('downloads:resume', id),
    retry: (id) => ipcRenderer.invoke('downloads:retry', id),
    cancel: (id) => ipcRenderer.invoke('downloads:cancel', id),
    remove: (id) => ipcRenderer.invoke('downloads:remove', id),
    clearFinished: () => ipcRenderer.invoke('downloads:clear-finished'),
    reveal: (id) => ipcRenderer.invoke('downloads:reveal', id),
    openDirectory: () => ipcRenderer.invoke('downloads:open-directory'),
    chooseDirectory: () => ipcRenderer.invoke('downloads:choose-directory'),
    onProgress: (listener: (tasks: DownloadTask[]) => void) => {
      const handler = (_event: unknown, tasks: DownloadTask[]): void => listener(tasks)
      ipcRenderer.on('downloads:progress', handler)
      return () => ipcRenderer.removeListener('downloads:progress', handler)
    },
  },
  app: {
    info: () => ipcRenderer.invoke('app:info'),
    // One payload rather than three arguments: the mode, the skin id and the strip colours are always
    // resolved together, and main needs all three to repaint the window and survive a restart.
    //
    // `night` is the odd one out — it says the playback-detail page is open, which is dark whatever the
    // theme is, so the *strip* must go dark even though the saved mode stays light. It is sent rather
    // than folded into `mode` precisely so main cannot persist it as the user's choice.
    setTheme: (mode: ThemeMode, chrome?: ThemeChrome | null, skin?: string, night?: boolean) =>
      ipcRenderer.invoke('app:set-theme', { mode, chrome: chrome ?? null, skin, night: Boolean(night) }),
    // The shell's backdrop, averaged over a few small regions. Returns `null` per region when the
    // compositor had nothing to give (see `src/main/backdrop.ts`), so the caller keeps its fallback.
    sampleBackdrop: (rects: BackdropRect[]) => ipcRenderer.invoke('app:sample-backdrop', rects),
    // Repaints the native overlay without persisting anything: this is what the strip fade is made of.
    setChrome: (chrome: ThemeChrome) => ipcRenderer.invoke('app:set-chrome', chrome),
  },
  themes: {
    list: () => ipcRenderer.invoke('themes:list'),
    import: () => ipcRenderer.invoke('themes:import'),
    remove: (id: string) => ipcRenderer.invoke('themes:remove', id),
    reveal: () => ipcRenderer.invoke('themes:reveal'),
  },
  cache: {
    report: () => ipcRenderer.invoke('cache:report'),
    clear: (areas) => ipcRenderer.invoke('cache:clear', areas),
  },
  backup: {
    export: (data) => ipcRenderer.invoke('backup:export', data),
    pick: () => ipcRenderer.invoke('backup:pick'),
    apply: () => ipcRenderer.invoke('backup:apply'),
    revert: () => ipcRenderer.invoke('backup:revert'),
    commit: () => ipcRenderer.invoke('backup:commit'),
  },
  diagnostics: {
    report: () => ipcRenderer.invoke('diagnostics:report'),
    clear: () => ipcRenderer.invoke('diagnostics:clear'),
    export: () => ipcRenderer.invoke('diagnostics:export'),
    reveal: () => ipcRenderer.invoke('diagnostics:reveal'),
    record: (kind: string, message: string) => ipcRenderer.invoke('diagnostics:record', kind, message),
  },
  updates: {
    check: (force?: boolean) => ipcRenderer.invoke('updates:check', force),
    open: (url: string) => ipcRenderer.invoke('updates:open', url),
  },
  httpApi: {
    status: () => ipcRenderer.invoke('http-api:status'),
    set: (patch) => ipcRenderer.invoke('http-api:set', patch),
    regenerateToken: () => ipcRenderer.invoke('http-api:regenerate-token'),
  },
  database: {
    stats: () => ipcRenderer.invoke('database:stats'),
  },
}

contextBridge.exposeInMainWorld('aurora', api)
