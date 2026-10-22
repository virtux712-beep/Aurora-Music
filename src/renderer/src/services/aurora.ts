import type {
  CustomSourceManifest,
  CustomSourceSaveResult,
  CustomSourceTemplate,
  ManifestValidationResult,
} from '../../../shared/customSource'
import type { Lyrics, LyricsResolution } from '../../../shared/lyrics'
import type {
  LxLibraryImportResult,
  LxLibraryPreview,
  ScriptProbeOptions,
  ScriptProbeResult,
  ScriptSourceRecord,
  ScriptSourceSaveResult,
} from '../../../shared/scriptSource'
import type { SourceImportResult } from '../../../shared/sourceImport'
import { DEFAULT_QUALITY, type QualityTierId } from '../../../shared/quality'
import {
  DEFAULT_DESKTOP_LYRICS,
  DEFAULT_DOWNLOAD_SETTINGS,
  DEFAULT_SYSTEM_INTEGRATION,
} from '../../../shared/types'
import { DEFAULT_SOUND } from '../../../shared/sound'
import { DEFAULT_HTTP_API, DEFAULT_UPDATE_CHECK } from '../../../shared/maintenance'
import type {
  AppInfo,
  AudioTrack,
  AuroraSettings,
  BoardDescriptor,
  BoardOutcome,
  AuroraSettingsPatch,
  DesktopLyricsSettings,
  DownloadSettings,
  DownloadStartInput,
  DownloadTask,
  PlatformDescriptor,
  PlatformHealthSummary,
  PlatformSearchOutcome,
  SystemIntegrationSettings,
  SystemIntegrationStatus,
  PlayerCommand,
  ReportedPlayerState,
  ImportProgress,
  LibraryImportResult,
  SearchOptions,
  SourceCapabilities,
  SourceConfigValue,
  SourceDescriptor,
  SourceErrorLogEntry,
  SourceCheckAllResult,
  SourceHealth,
  SourceSelfCheckResult,
  SourceId,
  PlatformId,
  PlaybackQuality,
  ResolvedStream,
  SourcePlaylist,
  SourcePendingHost,
  SourcePlaylistDetail,
  SourceRequestLogEntry,
  SourceSearchOutcome,
  ScrapeProgress,
  ScrapeReport,
  ScrapeRequest,
  TagWriteResult,
  TrackTagPatch,
  ConvertFormat,
  ConvertResult,
  FfmpegStatus,
  UserThemeRecord,
} from '../../../shared/types'

/**
 * Aurora's application-service layer for the renderer.
 *
 * Views and stores talk to these functions — never to `window.aurora` and never to a concrete
 * source implementation. That keeps the dependency direction one-way:
 *
 *   View → Store → Service → (IPC) → SourceManager → Source plugin → HTTP bridge → 网络
 *
 * Every call degrades gracefully when the preload bridge is missing (for example when the UI is
 * rendered outside Electron), so no page can crash on `window.aurora.sources is undefined`.
 */
type Bridge = Window['aurora'] | undefined

function bridge(): Bridge {
  return typeof window === 'undefined' ? undefined : window.aurora
}

/**
 * A clone-safe copy of a value on its way across the process boundary.
 *
 * `contextBridge` refuses to marshal Vue's reactive proxies — it reports "An object could not be
 * cloned" and, worst of all, `ipcRenderer.invoke` then *never settles*: the caller's `await` hangs
 * forever (a confirm button stuck on "安装中…"). Anything a store builds and hands to the bridge is
 * therefore unwrapped to plain objects and arrays first. Values whose prototype is not a plain
 * object/array (Date, Map, …) are passed through untouched, so this only ever removes reactivity.
 */
function plain<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((item) => plain(item)) as unknown as T
  const proto: unknown = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return value
  const copy: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) copy[key] = plain(item)
  return copy as T
}

export const NO_CAPABILITIES: SourceCapabilities = {
  search: false,
  stream: false,
  lyrics: false,
  playlists: false,
  playlistDetail: false,
  albums: false,
  artists: false,
  recommendations: false,
  radio: false,
  download: false,
  recognize: false,
}

export function emptyOutcome(sourceId: SourceId, message = '音源当前不可用', sourceName = sourceId): SourceSearchOutcome {
  return { sourceId, sourceName, ok: false, tracks: [], error: { code: 'UNSUPPORTED', message } }
}

export const libraryService = {
  list: (): Promise<AudioTrack[]> => bridge()?.library.list() ?? Promise.resolve([]),
  missing: (): Promise<string[]> => bridge()?.library.missing() ?? Promise.resolve([]),
  addFiles: (): Promise<LibraryImportResult> =>
    bridge()?.library.addFiles() ?? Promise.resolve({ added: [], duplicated: 0, failed: 0 }),
  addFolder: (): Promise<LibraryImportResult> =>
    bridge()?.library.addFolder() ?? Promise.resolve({ added: [], duplicated: 0, failed: 0 }),
  addPaths: (paths: string[]): Promise<LibraryImportResult> =>
    bridge()?.library.addPaths(paths) ?? Promise.resolve({ added: [], duplicated: 0, failed: 0 }),
  /** No bridge means no `webUtils`, which the drop handler reports as "cannot read the dropped files". */
  pathsForFiles: (files: File[]): string[] => bridge()?.library.pathsForFiles?.(files) ?? [],
  remove: (id: string): Promise<boolean> => bridge()?.library.remove(id) ?? Promise.resolve(false),
  reveal: (id: string): Promise<boolean> => bridge()?.library.reveal(id) ?? Promise.resolve(false),
  onImportProgress: (listener: (progress: ImportProgress) => void): (() => void) =>
    bridge()?.library.onImportProgress(listener) ?? (() => undefined),
  scrape: (request: ScrapeRequest): Promise<ScrapeReport> =>
    bridge()?.library.scrape(plain(request)) ?? Promise.resolve({ scanned: 0, matched: 0, covers: 0, lyrics: 0, outcomes: [] }),
  setTags: (patch: TrackTagPatch): Promise<TagWriteResult> =>
    bridge()?.library.setTags(plain(patch)) ?? Promise.resolve({ ok: false, error: '桥接不可用' }),
  convert: (id: string, format: ConvertFormat): Promise<ConvertResult> =>
    bridge()?.library.convert(id, format) ?? Promise.resolve({ ok: false, error: '桥接不可用' }),
  ffmpegStatus: (force = false): Promise<FfmpegStatus> =>
    bridge()?.library.ffmpegStatus(force) ?? Promise.resolve({ available: false, source: 'none' }),
  onScrapeProgress: (listener: (progress: ScrapeProgress) => void): (() => void) =>
    bridge()?.library.onScrapeProgress(listener) ?? (() => undefined),
  onChanged: (listener: (tracks: AudioTrack[]) => void): (() => void) =>
    bridge()?.library.onChanged(listener) ?? (() => undefined),
}

export const platformService = {
  list: (): Promise<PlatformDescriptor[]> => bridge()?.platforms.list() ?? Promise.resolve([]),
  searchAll: (query: string, options?: SearchOptions): Promise<PlatformSearchOutcome[]> =>
    bridge()?.platforms.searchAll(query, plain(options)) ?? Promise.resolve([]),
  searchOne: (platformId: PlatformId, query: string, options?: SearchOptions): Promise<PlatformSearchOutcome> =>
    bridge()?.platforms.searchOne(platformId, query, plain(options)) ??
    Promise.resolve({ platformId, platformName: platformId, ok: false, tracks: [], error: { code: 'UNSUPPORTED', message: '平台当前不可用' } }),
  health: (platformId: PlatformId): Promise<PlatformHealthSummary | null> =>
    bridge()?.platforms.health(platformId) ?? Promise.resolve(null),
  healthAll: (): Promise<PlatformHealthSummary[]> => bridge()?.platforms.healthAll() ?? Promise.resolve([]),
  boards: (): Promise<BoardDescriptor[]> => bridge()?.platforms.boards() ?? Promise.resolve([]),
  boardSongs: (platformId: PlatformId, boardId: string, limit?: number): Promise<BoardOutcome> =>
    bridge()?.platforms.boardSongs(platformId, boardId, limit) ??
    Promise.resolve({
      platformId,
      platformName: platformId,
      boardId,
      boardName: boardId,
      ok: false,
      tracks: [],
      error: { code: 'UNSUPPORTED', message: '榜单当前不可用' },
    }),
  resolve: (track: AudioTrack, quality?: PlaybackQuality): Promise<ResolvedStream | null> =>
    bridge()?.platforms.resolve(plain(track), quality) ?? Promise.resolve(null),
  lyrics: (track: AudioTrack) => bridge()?.platforms.lyrics(plain(track)) ?? Promise.resolve(null),
}

export const sourceService = {
  list: (): Promise<SourceDescriptor[]> => bridge()?.sources.list() ?? Promise.resolve([]),
  searchAll: (query: string, options?: SearchOptions): Promise<SourceSearchOutcome[]> =>
    bridge()?.sources.searchAll(query, plain(options)) ?? Promise.resolve([]),
  searchOne: (sourceId: SourceId, query: string, options?: SearchOptions): Promise<SourceSearchOutcome> =>
    bridge()?.sources.searchOne(sourceId, query, plain(options)) ?? Promise.resolve(emptyOutcome(sourceId)),
  recommendations: (sourceId: SourceId, options?: SearchOptions): Promise<SourceSearchOutcome> =>
    bridge()?.sources.recommendations(sourceId, plain(options)) ?? Promise.resolve(emptyOutcome(sourceId)),
  playlists: (sourceId?: SourceId): Promise<SourcePlaylist[]> => bridge()?.sources.playlists(sourceId) ?? Promise.resolve([]),
  playlistDetail: (sourceId: SourceId, playlistId: string): Promise<SourcePlaylistDetail | null> =>
    bridge()?.sources.playlistDetail(sourceId, playlistId) ?? Promise.resolve(null),
  /** Pass the whole track when the source needs `metadata`; a plain id still works. */
  resolve: (sourceId: SourceId, track: AudioTrack | string, quality?: PlaybackQuality): Promise<ResolvedStream | null> =>
    bridge()?.sources.resolve(sourceId, plain(track), quality) ?? Promise.resolve(null),
  requests: (sourceId?: SourceId): Promise<SourceRequestLogEntry[]> =>
    bridge()?.sources.requests(sourceId) ?? Promise.resolve([]),
  setEnabled: (sourceId: SourceId, enabled: boolean): Promise<SourceDescriptor[]> =>
    bridge()?.sources.setEnabled(sourceId, enabled) ?? Promise.resolve([]),
  setConfig: (sourceId: SourceId, patch: Record<string, SourceConfigValue>): Promise<SourceDescriptor[]> =>
    bridge()?.sources.setConfig(sourceId, plain(patch)) ?? Promise.resolve([]),
  setOrder: (order: SourceId[]): Promise<SourceDescriptor[]> =>
    bridge()?.sources.setOrder(plain(order)) ?? Promise.resolve([]),
  health: (sourceId: SourceId): Promise<SourceHealth> =>
    bridge()?.sources.health(sourceId) ?? Promise.resolve({ ok: false, message: '缺少桌面桥接', checkedAt: Date.now() }),
  /** Hosts the runtime refused for a source; each one can be granted with a click. */
  pendingHosts: (sourceId?: SourceId): Promise<SourcePendingHost[]> =>
    bridge()?.sources.pendingHosts(sourceId) ?? Promise.resolve([]),
  /** Grants hosts durably and hot-reloads the source (no restart). */
  grantHosts: (sourceId: SourceId, hosts: string[]): Promise<SourceDescriptor[]> =>
    bridge()?.sources.grantHosts(sourceId, plain(hosts)) ?? Promise.resolve([]),
  /** Takes a grant back; the automatic repair's grants are undoable through here. */
  revokeHosts: (sourceId: SourceId, hosts: string[]): Promise<SourceDescriptor[]> =>
    bridge()?.sources.revokeHosts(sourceId, plain(hosts)) ?? Promise.resolve([]),
  /** Real search + resolve with real error codes; `repair` also grants and retries refusals. */
  selfCheck: (sourceId: SourceId, options?: { repair?: boolean; keyword?: string }): Promise<SourceSelfCheckResult | null> =>
    bridge()?.sources.selfCheck(sourceId, options) ?? Promise.resolve(null),
  /** 全量自检。The fallback is an empty run rather than `null`: the page always gets a shape it can render. */
  selfCheckAll: (options?: { keyword?: string; repair?: boolean }): Promise<SourceCheckAllResult> =>
    bridge()?.sources.selfCheckAll(options) ??
    Promise.resolve({
      at: Date.now(),
      keyword: '',
      checked: 0,
      skipped: 0,
      counts: { ok: 0, unauthorized: 0, timeout: 0, empty: 0, unconfigured: 0, inactive: 0, error: 0 },
      headline: '缺少桌面桥接，无法自检',
      sources: [],
    }),
  errors: (sourceId: SourceId): Promise<SourceErrorLogEntry[]> =>
    bridge()?.sources.errors(sourceId) ?? Promise.resolve([]),
}

/**
 * JavaScript sources: the other half of the extensibility story.
 *
 * Import is a two-phase flow — probe (runs the script with no permissions) then confirm (persist the
 * reviewed text plus the permissions the user chose). The renderer never decides what a script may
 * do; it only presents what the runtime reports.
 */
/**
 * Tray / taskbar buttons / global media keys.
 *
 * `status()` is deliberately separate from `get()`: the settings page shows both what was asked for
 * and what the operating system actually accepted.
 */
export const systemIntegrationService = {
  get: (): Promise<SystemIntegrationSettings> =>
    bridge()?.systemIntegration.get() ?? Promise.resolve(DEFAULT_SYSTEM_INTEGRATION),
  set: (patch: Partial<SystemIntegrationSettings>): Promise<SystemIntegrationSettings> =>
    bridge()?.systemIntegration.set(plain(patch)) ?? Promise.resolve(DEFAULT_SYSTEM_INTEGRATION),
  status: (): Promise<SystemIntegrationStatus> =>
    bridge()?.systemIntegration.status() ??
    Promise.resolve({ trayActive: false, launchAtLogin: false, trayTooltip: '', mediaKeys: [], taskbarButtons: false, platform: '' }),
}

export const scriptSourceService = {
  list: (): Promise<ScriptSourceRecord[]> => bridge()?.scriptSources.list() ?? Promise.resolve([]),
  probe: (options: ScriptProbeOptions): Promise<ScriptProbeResult> =>
    bridge()?.scriptSources.probe(plain(options)) ?? Promise.resolve({ ok: false, errors: ['缺少桌面桥接'], warnings: [] }),
  save: (options: { sourceText: string; manifest: unknown }): Promise<ScriptSourceSaveResult> =>
    bridge()?.scriptSources.save(plain(options)) ?? Promise.resolve({ ok: false, errors: ['缺少桌面桥接'], sources: [] }),
  remove: (id: string): Promise<ScriptSourceSaveResult> =>
    bridge()?.scriptSources.remove(id) ?? Promise.resolve({ ok: false, errors: ['缺少桌面桥接'], sources: [] }),
  reload: (id: string): Promise<ScriptSourceSaveResult> =>
    bridge()?.scriptSources.reload(id) ?? Promise.resolve({ ok: false, errors: ['缺少桌面桥接'], sources: [] }),
  export: (id: string): Promise<string | null> => bridge()?.scriptSources.export(id) ?? Promise.resolve(null),
  inspect: (id: string): Promise<{ ok: boolean; message: string }> =>
    bridge()?.scriptSources.inspect(id) ?? Promise.resolve({ ok: false, message: '缺少桌面桥接' }),
  /*
   * 洛雪音源库（`user_api.json`）。
   *
   * Opening the file and reading it happen in the main process: this side only ever sees a summary
   * per source, and the import names ids. That is why there is no `text` parameter anywhere here —
   * the text that gets written is the text main read from disk.
   */
  lxLibraryOpen: (): Promise<LxLibraryPreview> =>
    bridge()?.scriptSources.lxLibraryOpen() ??
    Promise.resolve({ ok: false, errors: ['缺少桌面桥接'], fileName: '', items: [] }),
  lxLibraryImport: (ids: string[]): Promise<LxLibraryImportResult> =>
    bridge()?.scriptSources.lxLibraryImport(ids) ??
    Promise.resolve({ ok: false, errors: ['缺少桌面桥接'], added: 0, failed: [], sources: [] }),
  lxLibraryCancel: (): Promise<boolean> => bridge()?.scriptSources.lxLibraryCancel() ?? Promise.resolve(false),
}

/**
 * The Source Detector: hand Aurora a file (or pasted text) and get back what it recognised.
 * Detection is about format only — never about approving a host, platform or provider.
 */
export const sourceImportService = {
  fromFile: (): Promise<SourceImportResult> =>
    bridge()?.sourceImport.fromFile() ??
    Promise.resolve({ ok: false, kind: 'unknown', fileName: '', summary: '缺少桌面桥接', errors: [] }),
  fromText: (text: string, fileName?: string): Promise<SourceImportResult> =>
    bridge()?.sourceImport.fromText(text, fileName) ??
    Promise.resolve({ ok: false, kind: 'unknown', fileName: '', summary: '缺少桌面桥接', errors: [] }),
}

/**
 * User-defined (declarative) sources. These are manifests, not code: nothing the user writes is
 * executed, so the renderer can treat this like any other data payload.
 */
export const customSourceService = {
  list: (): Promise<CustomSourceManifest[]> => bridge()?.customSources.list() ?? Promise.resolve([]),
  templates: (): Promise<CustomSourceTemplate[]> => bridge()?.customSources.templates() ?? Promise.resolve([]),
  validate: (raw: string): Promise<ManifestValidationResult> =>
    bridge()?.customSources.validate(raw) ?? Promise.resolve({ ok: false, errors: ['缺少桌面桥接'] }),
  save: (raw: string): Promise<CustomSourceSaveResult> =>
    bridge()?.customSources.save(raw) ?? Promise.resolve({ ok: false, errors: ['缺少桌面桥接'], manifests: [] }),
  remove: (id: string): Promise<CustomSourceSaveResult> =>
    bridge()?.customSources.remove(id) ?? Promise.resolve({ ok: false, errors: ['缺少桌面桥接'], manifests: [] }),
  export: (id: string): Promise<string | null> => bridge()?.customSources.export(id) ?? Promise.resolve(null),
}

export const lyricsService = {
  /** Fast half: local files, the fetch cache and the track's own source. Never blocks on a search. */
  get: (track: AudioTrack): Promise<Lyrics | null> => bridge()?.lyrics.get(plain(track)) ?? Promise.resolve(null),
  /** Slow half: public catalogues, used as background enrichment after a fast miss. */
  search: (track: AudioTrack): Promise<LyricsResolution | null> =>
    bridge()?.lyrics.search(plain(track)) ?? Promise.resolve(null),
  /** 「联网自动匹配」: the lyrics engine's full resolution, including what each provider did. */
  match: (track: AudioTrack): Promise<LyricsResolution | null> =>
    bridge()?.lyrics.match(plain(track)) ?? Promise.resolve(null),
  save: (track: AudioTrack, raw: string): Promise<Lyrics | null> =>
    bridge()?.lyrics.save(plain(track), raw) ?? Promise.resolve(null),
  clear: (track: AudioTrack): Promise<boolean> => bridge()?.lyrics.clear(plain(track)) ?? Promise.resolve(false),
}

export const settingsService = {
  get: (): Promise<AuroraSettings> =>
    bridge()?.settings.get() ??
    Promise.resolve({
      sourceConfig: {},
      enabledSources: {},
      sourceOrder: [],
      allowOpenLicenseDownloads: true,
      autoHealthCheck: true,
      autoGrantSourceHosts: true,
      safeMode: false,
      theme: 'dark' as const,
      skin: 'aurora',
      preferredQuality: DEFAULT_QUALITY,
      systemIntegration: { ...DEFAULT_SYSTEM_INTEGRATION },
      desktopLyrics: { ...DEFAULT_DESKTOP_LYRICS },
      downloads: { ...DEFAULT_DOWNLOAD_SETTINGS },
      sound: structuredClone(DEFAULT_SOUND),
      lyricsOffsetMs: 0,
      updateCheck: { ...DEFAULT_UPDATE_CHECK },
      httpApi: { ...DEFAULT_HTTP_API },
    }),
  /**
   * The last known settings, synchronously.
   *
   * A resolve happens inside a doublclick handler and cannot await a round trip just to learn which tier the
   * user prefers — so `get()` fills this cache once and everything on the playback path reads it from here.
   * `set()` refreshes it, so a preference changed in the UI applies to the very next song.
   */
  cached: (): AuroraSettings | null => settingsCache,
  refresh: async (): Promise<AuroraSettings> => {
    const next = await settingsService.get()
    settingsCache = next
    return next
  },
  set: (patch: AuroraSettingsPatch): Promise<AuroraSettings> => {
    const bridgeCall = bridge()?.settings.set(plain(patch))
    if (!bridgeCall) return settingsService.get()
    return bridgeCall.then((next) => {
      settingsCache = next
      return next
    })
  },
}

let settingsCache: AuroraSettings | null = null

/**
 * The download manager.
 *
 * `start` is given the whole track and the main process resolves the stream itself, so a media URL
 * never crosses this boundary. Progress arrives as a push (`onProgress`), because the numbers are
 * produced by the transfer rather than requested by the UI.
 */
export const downloadService = {
  list: (): Promise<DownloadTask[]> => bridge()?.downloads.list() ?? Promise.resolve([]),
  start: (input: DownloadStartInput): Promise<DownloadTask | null> =>
    bridge()?.downloads.start(plain(input)) ?? Promise.resolve(null),
  pause: (id: string): Promise<DownloadTask[]> => bridge()?.downloads.pause(id) ?? Promise.resolve([]),
  resume: (id: string): Promise<DownloadTask[]> => bridge()?.downloads.resume(id) ?? Promise.resolve([]),
  retry: (id: string): Promise<DownloadTask[]> => bridge()?.downloads.retry(id) ?? Promise.resolve([]),
  cancel: (id: string): Promise<DownloadTask[]> => bridge()?.downloads.cancel(id) ?? Promise.resolve([]),
  remove: (id: string): Promise<DownloadTask[]> => bridge()?.downloads.remove(id) ?? Promise.resolve([]),
  clearFinished: (): Promise<DownloadTask[]> => bridge()?.downloads.clearFinished() ?? Promise.resolve([]),
  reveal: (id: string): Promise<boolean> => bridge()?.downloads.reveal(id) ?? Promise.resolve(false),
  openDirectory: (): Promise<boolean> => bridge()?.downloads.openDirectory() ?? Promise.resolve(false),
  chooseDirectory: (): Promise<DownloadSettings | null> => bridge()?.downloads.chooseDirectory() ?? Promise.resolve(null),
  /** Reports (never computes) progress: the list comes straight from the manager. */
  onProgress: (listener: (tasks: DownloadTask[]) => void): (() => void) =>
    bridge()?.downloads.onProgress(listener) ?? (() => undefined),
}

/**
 * The user's themes folder.
 *
 * `list` returns records rather than themes so a file that failed to parse still appears — with its
 * reason. "My theme is not in the list" and "my theme is in the list and rejected because …" are very
 * different experiences to debug.
 */
export const themesService = {
  list: (): Promise<UserThemeRecord[]> => bridge()?.themes.list() ?? Promise.resolve([]),
  import: (): Promise<UserThemeRecord | null> => bridge()?.themes.import() ?? Promise.resolve(null),
  remove: (id: string): Promise<UserThemeRecord[]> => bridge()?.themes.remove(id) ?? Promise.resolve([]),
  reveal: (): Promise<string> => bridge()?.themes.reveal() ?? Promise.resolve(''),
}

export const appService = {
  info: (): Promise<AppInfo | null> => bridge()?.app.info() ?? Promise.resolve(null),
  /** The player reports its whole state; the desktop-lyrics window is fed from this in main. */
  reportPlayerState: (state: ReportedPlayerState): Promise<void> =>
    bridge()?.player.report(plain(state)) ?? Promise.resolve(),
  /** Play/pause, next or previous requested from outside this window. */
  onPlayerCommand: (listener: (command: PlayerCommand) => void): (() => void) =>
    bridge()?.player.onCommand(listener) ?? (() => undefined),
}

/** The separate desktop-lyrics window. */
export const desktopLyricsService = {
  options: (): Promise<DesktopLyricsSettings | null> => bridge()?.desktopLyrics.options() ?? Promise.resolve(null),
  setEnabled: (enabled: boolean): Promise<DesktopLyricsSettings | null> =>
    bridge()?.desktopLyrics.setEnabled(enabled) ?? Promise.resolve(null),
  toggle: (): Promise<DesktopLyricsSettings | null> => bridge()?.desktopLyrics.toggle() ?? Promise.resolve(null),
  setOptions: (patch: Partial<DesktopLyricsSettings>): Promise<DesktopLyricsSettings | null> =>
    bridge()?.desktopLyrics.setOptions(plain(patch)) ?? Promise.resolve(null),
  resetPosition: (): Promise<DesktopLyricsSettings | null> =>
    bridge()?.desktopLyrics.resetPosition() ?? Promise.resolve(null),
}
