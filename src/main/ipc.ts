import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type {
  AppInfo,
  BackdropRect,
  SystemIntegrationSettings,
  AudioTrack,
  AuroraSettings,
  ConvertFormat,
  ConvertResult,
  FfmpegStatus,
  BoardDescriptor,
  BoardOutcome,
  PlatformDescriptor,
  ScrapeReport,
  TagWriteResult,
  PlatformHealthSummary,
  PlatformSearchOutcome,
  PlaybackQuality,
  ReportedPlayerState,
  ResolvedStream,
  SearchOptions,
  SourceConfigValue,
  SourceDescriptor,
  SourceHealth,
  SourcePlaylist,
  SourcePendingHost,
  SourcePlaylistDetail,
  SourceSearchOutcome,
  AuroraSettingsPatch,
  LibraryImportResult,
} from '../shared/types'
import type { Lyrics } from '../shared/lyrics'
import type { SourceCheckAllResult, SourceErrorLogEntry, SourceSelfCheckResult } from '../shared/types'
import type { CustomSourceSaveResult, ManifestValidationResult } from '../shared/customSource'
import { MAX_SCRIPT_BYTES } from '../shared/scriptSource'
import type {
  LxLibraryImportResult,
  LxLibraryPreview,
  ScriptProbeResult,
  ScriptSourceRecord,
  ScriptSourceSaveResult,
} from '../shared/scriptSource'
import type { SourceImportResult } from '../shared/sourceImport'
import { clearUserLyrics, getLyrics, matchLyrics, saveUserLyrics, searchLyricsOnline } from './lyrics'
import { clearCaches, measureCaches } from './storage'
import { applyBackup, commitBackup, exportBackup, pickBackup, revertBackup } from './backup'
import { clearDiagnostics, diagnosticsReport, exportDiagnostics, recordDiagnostics, revealLogFolder } from './diagnostics'
import { checkForUpdates, openUpdatePage } from './updates'
import { httpApiStatus, onPlayerStateForHttpApi, regenerateHttpToken, startHttpApi } from './httpApi'
import { databaseStats } from './database'
import type { BackupUserData, CacheAreaId } from '../shared/maintenance'
import type { LyricsResolution } from './lyricsEngine/manager'
import {
  exportCustomSource,
  listCustomSources,
  listTemplates,
  removeCustomSource,
  saveCustomSource,
  validateCustomSourceRaw,
} from './customSources/store'
import {
  exportScriptSource,
  importLxLibrary,
  inspectScriptSource,
  listScriptSources,
  previewLxLibrary,
  probeScriptImport,
  reloadScriptSource,
  removeScriptSource,
  saveScriptSource,
} from './scriptSources/store'
import { disposeScriptHost } from './scriptHost/host'
import {
  detectSourceText,
  grantSourceHosts,
  importSourceFromFile,
  pendingHostsFor,
  selfCheckAllSources,
  selfCheckSource,
} from './sourceAdmin'
import { revokeSourceHosts } from './sources/autoRepair'
import { readErrorLog } from './sources/log'
import {
  handlePlayerReport,
  getDesktopLyricsOptions,
  resetDesktopLyricsPosition,
  setDesktopLyricsEnabled,
  setDesktopLyricsOptions,
  toggleDesktopLyrics,
} from './desktopLyrics'
import {
  getSystemIntegrationStatus,
  onPlayerStateForSystemIntegration,
  refreshSystemIntegration,
} from './systemIntegration'
import {
  cancelDownload,
  chooseDownloadDirectory,
  clearFinishedDownloads,
  listDownloads,
  openDownloadDirectory,
  pauseDownload,
  pumpDownloads,
  removeDownload,
  resumeDownload,
  retryDownload,
  revealDownload,
  startDownload,
} from './downloads'
import { AUDIO_EXTENSIONS } from '../shared/constants'
import {
  DEFAULT_DESKTOP_LYRICS,
  DEFAULT_DOWNLOAD_SETTINGS,
  DEFAULT_SYSTEM_INTEGRATION,
  SYSTEM_INTEGRATION_KEYS,
} from '../shared/types'
import type { ThemeMode, UserThemeRecord } from '../shared/types'
import { applyWindowChrome } from './windowChrome'
import { sampleBackdrop } from './backdrop'
import { importUserTheme, listUserThemes, pickThemeFile, removeUserTheme, revealThemesDirectory } from './themes'
import { getTrackPath, importAudioFiles, importFolder, importPaths, listMissingIds, listTracks, removeTrack } from './library'
import { scrapeLocalTracks } from './libraryScrape'
import { convertTrack, ffmpegStatus, writeTrackTags } from './libraryTools'
import { defaultSettings, getSettings, updateSettings } from './settings'
import { allSecrets, writeSecrets } from './secretStore'
import {
  checkHealth,
  describeSources,
  getSource,
  initializeSources,
  invalidateSourceRuntime,
  isConfigured,
  playlistDetail,
  playlists,
  recommendations,
  resolveConfig,
  resolveStream,
  searchAll,
  searchOne,
  readRequestLog,
  splitConfigPatch,
  toSourceErrorInfo,
} from './sources'
import {
  fetchBoardOutcome,
  getPlatformDescriptor,
  listBoardDescriptors,
  listPlatformDescriptors,
  searchAllPlatforms,
  searchPlatformOutcome,
} from './platforms/registry'
import { platformResolverSummary, resolvePlatformTrack, lyricsForPlatformTrack } from './platforms/resolver'

let reported: ReportedPlayerState = {
  isPlaying: false,
  title: '',
  artist: '',
  currentTime: 0,
  duration: 0,
  trackId: '',
  track: null,
}

export function getReportedPlayerState(): ReportedPlayerState {
  return reported
}

/**
 * The library file a preview produced, kept so the import writes exactly what was reviewed.
 *
 * Only one at a time on purpose: "preview A, import B" would be a way to write sources the user never
 * saw, and there is no workflow that needs two open libraries.
 */
let pendingLxLibrary: { path: string; text: string } | null = null

/**
 * Only the top frame of our own window may call these handlers, so an injected
 * iframe or a stray renderer cannot reach the filesystem through IPC.
 *
 * The frame check alone only proves "top frame"; the URL check below proves it is *our* top
 * frame. Navigation away is already blocked (`will-navigate` is denied in main/index.ts), so
 * this is depth in depth: if a future window or webview ever loads remote content while
 * sharing this preload, these handlers stay unreachable from it.
 */
function isAppFrameUrl(rawUrl: string): boolean {
  const devBase = process.env.ELECTRON_RENDERER_URL
  if (devBase) return rawUrl.startsWith(devBase)
  if (!rawUrl.startsWith('file://')) return false
  // Packaged pages live under out/renderer (index.html, desktop-lyrics.html); allow any page
  // of the bundle, with an optional query/hash (the SPA router never changes the path).
  return /\/out\/renderer\/[^/?#]+\.html(?:[?#]|$)/.test(rawUrl)
}

function assertTrustedSender(event: IpcMainInvokeEvent): boolean {
  if (event.senderFrame === null || event.senderFrame !== event.sender.mainFrame) return false
  return isAppFrameUrl(event.senderFrame.url)
}

/**
 * The renderer's half of a backup, coerced into shape.
 *
 * It is validated rather than trusted: this is the one place a renderer-supplied object is written into a
 * file the user will keep, and a malformed field there would be discovered much later, by a restore.
 */
function asBackupData(value: unknown): BackupUserData {
  const fallback: BackupUserData = { favorites: [], history: [], playlists: [], lyricColor: 'auto', lyricColorCustom: '' }
  if (!value || typeof value !== 'object') return fallback
  const candidate = value as Record<string, unknown>
  return {
    favorites: Array.isArray(candidate.favorites) ? candidate.favorites.filter((id): id is string => typeof id === 'string').slice(0, 100_000) : [],
    history: Array.isArray(candidate.history)
      ? candidate.history.flatMap((entry) => {
          if (!entry || typeof entry !== 'object') return []
          const record = entry as Record<string, unknown>
          if (typeof record.id !== 'string' || typeof record.playedAt !== 'number') return []
          return [{ id: record.id, playedAt: record.playedAt, playCount: Number(record.playCount) || 1 }]
        })
      : [],
    playlists: Array.isArray(candidate.playlists)
      ? candidate.playlists.flatMap((entry) => {
          if (!entry || typeof entry !== 'object') return []
          const record = entry as Record<string, unknown>
          if (typeof record.id !== 'string' || typeof record.name !== 'string') return []
          return [
            {
              id: record.id,
              name: record.name,
              trackIds: Array.isArray(record.trackIds) ? record.trackIds.filter((id): id is string => typeof id === 'string') : [],
              createdAt: Number(record.createdAt) || Date.now(),
              updatedAt: Number(record.updatedAt) || Date.now(),
            },
          ]
        })
      : [],
    lyricColor: typeof candidate.lyricColor === 'string' ? candidate.lyricColor.slice(0, 40) : 'auto',
    lyricColorCustom: typeof candidate.lyricColorCustom === 'string' ? candidate.lyricColorCustom.slice(0, 40) : '',
  }
}

function asId(value: unknown, maxLength = 64): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength ? value : null
}

function asSearchOptions(value: unknown): SearchOptions {
  if (!value || typeof value !== 'object') return {}
  const candidate = value as Record<string, unknown>
  const options: SearchOptions = {}
  if (typeof candidate.page === 'number' && Number.isFinite(candidate.page)) {
    options.page = Math.min(Math.max(Math.trunc(candidate.page), 0), 200)
  }
  if (typeof candidate.pageSize === 'number' && Number.isFinite(candidate.pageSize)) {
    options.pageSize = Math.min(Math.max(Math.trunc(candidate.pageSize), 1), 100)
  }
  if (typeof candidate.tag === 'string' && candidate.tag.trim()) options.tag = candidate.tag.trim().slice(0, 64)
  if (candidate.type === 'track' || candidate.type === 'album' || candidate.type === 'artist' || candidate.type === 'playlist') {
    options.type = candidate.type
  }
  return options
}

/**
 * Keeps the raw per-source payload bounded: a source may need it to resolve a stream, but the
 * renderer must not be able to push an unbounded blob through IPC.
 */
function asMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  try {
    const json = JSON.stringify(value)
    if (json.length > 4096) return undefined
    return JSON.parse(json) as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** Rebuilds a track from renderer input instead of trusting the object as-is. */
function asTrack(value: unknown): AudioTrack | null {
  // Also the sanitizer for play-URL resolution, so everything a resolver reads must be carried
  // through here — `platform`, `qualities` and `metadata` are all part of that contract.
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<AudioTrack>
  const id = asId(candidate.id, 200)
  if (!id) return null
  const origin = candidate.origin === 'local' ? 'local' : candidate.origin === 'online' ? 'online' : null
  if (!origin) return null
  const text = (input: unknown, fallback: string, max = 300): string =>
    typeof input === 'string' && input.trim() ? input.slice(0, max) : fallback
  return {
    id,
    origin,
    title: text(candidate.title, '未知曲目'),
    artist: text(candidate.artist, '未知艺术家'),
    album: text(candidate.album, '未知专辑'),
    duration: typeof candidate.duration === 'number' && Number.isFinite(candidate.duration) ? Math.max(0, candidate.duration) : 0,
    format: text(candidate.format, '—', 24),
    fileUrl: typeof candidate.fileUrl === 'string' ? candidate.fileUrl.slice(0, 500) : '',
    cover: typeof candidate.cover === 'string' ? candidate.cover.slice(0, 500) : undefined,
    addedAt: typeof candidate.addedAt === 'number' ? candidate.addedAt : Date.now(),
    filePath: typeof candidate.filePath === 'string' ? candidate.filePath : undefined,
    sourceId: typeof candidate.sourceId === 'string' ? candidate.sourceId.slice(0, 64) : undefined,
    // `platform` must survive the IPC boundary: it is the only key the main process has for picking
    // a resolver, so dropping it here would make every online track unplayable ("该曲目没有平台信息")
    // even when an enabled source can resolve it.
    platform: typeof candidate.platform === 'string' && candidate.platform.trim() ? candidate.platform.trim().slice(0, 64) : undefined,
    sourceTrackId: typeof candidate.sourceTrackId === 'string' ? candidate.sourceTrackId.slice(0, 200) : undefined,
    ...(Array.isArray(candidate.qualities) ? { qualities: candidate.qualities.filter((item): item is PlaybackQuality => typeof item === 'string').slice(0, 8) } : {}),
    license: typeof candidate.license === 'string' ? candidate.license.slice(0, 300) : undefined,
    homepage: typeof candidate.homepage === 'string' ? candidate.homepage.slice(0, 500) : undefined,
    year: typeof candidate.year === 'number' && Number.isFinite(candidate.year) ? candidate.year : undefined,
    metadata: asMetadata(candidate.metadata),
  }
}

function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'dark' || value === 'light' || value === 'system'
}

function asConfigPatch(value: unknown): Record<string, SourceConfigValue> {
  if (!value || typeof value !== 'object') return {}
  const patch: Record<string, SourceConfigValue> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>).slice(0, 32)) {
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') patch[key] = raw
  }
  return patch
}

const EMPTY_OUTCOME = (sourceId: string, message: string): SourceSearchOutcome => ({
  sourceId,
  sourceName: sourceId,
  ok: false,
  tracks: [],
  error: { code: 'UNSUPPORTED', message },
})

export function registerIpcHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('library:list', (event) => (assertTrustedSender(event) ? listTracks() : []))

  ipcMain.handle('library:missing', (event) => (assertTrustedSender(event) ? listMissingIds() : []))

  ipcMain.handle('library:add-files', async (event) => {
    if (!assertTrustedSender(event)) return { added: [], duplicated: 0, failed: 0 }
    const window = getWindow()
    if (!window) return { added: [], duplicated: 0, failed: 0 }
    const result = await dialog.showOpenDialog(window, {
      title: '添加本地音乐',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '音频文件', extensions: [...AUDIO_EXTENSIONS].map((extension) => extension.slice(1)) }],
    })
    if (result.canceled || result.filePaths.length === 0) return { added: [], duplicated: 0, failed: 0 }
    return importAudioFiles(result.filePaths)
  })

  /*
   * 拖入的路径：由渲染层把真实文件位置交上来，这里只做“展开目录 + 走同一条导入”。
   *
   * 校验放在前面且很严：这是渲染层唯一能直接给出文件系统路径的入口，所以它只接受字符串数组、限定条数
   * 与单项长度，剩下的（是不是音频、目录要不要递归）交给 library 层去判断。
   */
  ipcMain.handle('library:add-paths', async (event, raw: unknown): Promise<LibraryImportResult> => {
    if (!assertTrustedSender(event)) return { added: [], duplicated: 0, failed: 0 }
    if (!Array.isArray(raw)) return { added: [], duplicated: 0, failed: 0 }
    const paths = raw
      .filter((value): value is string => typeof value === 'string' && value.length > 0 && value.length <= 4096)
      .slice(0, 5000)
    if (paths.length === 0) return { added: [], duplicated: 0, failed: 0 }
    return importPaths(paths)
  })

  ipcMain.handle('library:add-folder', async (event) => {
    if (!assertTrustedSender(event)) return { added: [], duplicated: 0, failed: 0 }
    const window = getWindow()
    if (!window) return { added: [], duplicated: 0, failed: 0 }
    const result = await dialog.showOpenDialog(window, {
      title: '添加音乐文件夹',
      properties: ['openDirectory', 'multiSelections'],
    })
    if (result.canceled || result.filePaths.length === 0) return { added: [], duplicated: 0, failed: 0 }
    const summary = { added: [] as Awaited<ReturnType<typeof importFolder>>['added'], duplicated: 0, failed: 0 }
    for (const folder of result.filePaths) {
      const partial = await importFolder(folder)
      summary.added.push(...partial.added)
      summary.duplicated += partial.duplicated
      summary.failed += partial.failed
    }
    return summary
  })

  ipcMain.handle('library:remove', (event, id: unknown) => {
    if (!assertTrustedSender(event)) return false
    const trackId = asId(id)
    return trackId ? removeTrack(trackId) : false
  })

  ipcMain.handle('library:reveal', (event, id: unknown) => {
    if (!assertTrustedSender(event)) return false
    const trackId = asId(id)
    if (!trackId) return false
    const filePath = getTrackPath(trackId)
    if (!filePath) return false
    shell.showItemInFolder(filePath)
    return true
  })

  /**
   * "自动补齐信息": matches local entries against the platform search and fills only what is
   * missing. Runs in the main process because it needs the network, the cover cache and the
   * lyrics directory — the renderer only sees the per-track report.
   */
  ipcMain.handle('library:scrape', async (event, request: unknown): Promise<ScrapeReport> => {
    if (!assertTrustedSender(event)) return { scanned: 0, matched: 0, covers: 0, lyrics: 0, outcomes: [] }
    const raw = request && typeof request === 'object' ? (request as Record<string, unknown>) : {}
    const ids = Array.isArray(raw.ids)
      ? raw.ids.map((value) => asId(value)).filter((value): value is string => value !== null).slice(0, 5000)
      : undefined
    return scrapeLocalTracks(
      {
        ...(ids && ids.length > 0 ? { ids } : {}),
        cover: raw.cover !== false,
        lyrics: raw.lyrics !== false,
      },
      getSettings(),
    )
  })

  // Only the three text frames plus the cover the library already has: the writer refuses non-MP3
  // files outright, so no format check is needed here beyond the id.
  ipcMain.handle('library:set-tags', async (event, patch: unknown): Promise<TagWriteResult> => {
    if (!assertTrustedSender(event)) return { ok: false, error: '未授权的调用' }
    const raw = patch && typeof patch === 'object' ? (patch as Record<string, unknown>) : {}
    const id = asId(raw.id)
    if (!id) return { ok: false, error: '缺少曲目 id' }
    const text = (value: unknown): string | undefined =>
      typeof value === 'string' ? value.trim().slice(0, 300) : undefined
    return writeTrackTags({
      id,
      title: text(raw.title),
      artist: text(raw.artist),
      album: text(raw.album),
    })
  })

  ipcMain.handle('library:convert', async (event, id: unknown, format: unknown): Promise<ConvertResult> => {
    if (!assertTrustedSender(event)) return { ok: false, error: '未授权的调用' }
    const trackId = asId(id)
    const target = typeof format === 'string' ? format.toLowerCase() : ''
    if (!trackId) return { ok: false, error: '缺少曲目 id' }
    if (!['mp3', 'flac', 'wav', 'm4a', 'ogg'].includes(target)) return { ok: false, error: '不支持的目标格式' }
    return convertTrack(trackId, target as ConvertFormat)
  })

  ipcMain.handle('library:ffmpeg-status', async (event, force: unknown): Promise<FfmpegStatus> => {
    if (!assertTrustedSender(event)) return { available: false, source: 'none' }
    return ffmpegStatus(force === true)
  })

  ipcMain.handle('player:report', (event, state: unknown) => {
    if (!assertTrustedSender(event)) return
    if (typeof state !== 'object' || state === null) return
    const candidate = state as Partial<ReportedPlayerState>
    reported = {
      isPlaying: candidate.isPlaying === true,
      title: typeof candidate.title === 'string' ? candidate.title.slice(0, 200) : '',
      artist: typeof candidate.artist === 'string' ? candidate.artist.slice(0, 200) : '',
      currentTime: typeof candidate.currentTime === 'number' && Number.isFinite(candidate.currentTime) ? candidate.currentTime : 0,
      duration: typeof candidate.duration === 'number' && Number.isFinite(candidate.duration) ? candidate.duration : 0,
      trackId: typeof candidate.trackId === 'string' ? candidate.trackId.slice(0, 200) : '',
      track: asTrack(candidate.track),
    }
    // The desktop-lyrics window is driven from here: it is the one place that sees both the clock
    // and the resolved lyrics, so nothing about playback is duplicated in a second renderer.
    handlePlayerReport(reported)
    // Tray tooltip / menu and the taskbar play-pause button are a *view* of this same report, so
    // they can never show a track the player bar is not showing.
    onPlayerStateForSystemIntegration(reported)
    // Same story for the local API: one report, three views.
    onPlayerStateForHttpApi(reported)
  })

  /* ---------------------------------------------------------------- system integration */

  ipcMain.handle('system-integration:get', (event): Promise<SystemIntegrationSettings> =>
    assertTrustedSender(event) ? Promise.resolve(getSettings().systemIntegration) : Promise.resolve({ ...DEFAULT_SYSTEM_INTEGRATION }),
  )

  ipcMain.handle('system-integration:status', (event) =>
    assertTrustedSender(event)
      ? getSystemIntegrationStatus()
      : { trayActive: false, launchAtLogin: false, trayTooltip: '', mediaKeys: [], taskbarButtons: false, platform: process.platform },
  )

  ipcMain.handle('system-integration:set', async (event, patch: unknown): Promise<SystemIntegrationSettings> => {
    if (!assertTrustedSender(event)) return getSettings().systemIntegration
    const clean = (patch ?? {}) as Record<string, unknown>
    // Same derived key list as the sanitizer, so the two can no longer disagree about what is settable.
    const next: Partial<SystemIntegrationSettings> = {}
    for (const key of SYSTEM_INTEGRATION_KEYS) {
      if (typeof clean[key] === 'boolean') next[key] = clean[key] as boolean
    }
    await updateSettings({ systemIntegration: next })
    // Applied here rather than lazily: the tray icon must appear/disappear the moment the switch
    // moves, which is the only behaviour a user can verify.
    return refreshSystemIntegration()
  })

  /* ---------------------------------------------------------------- desktop lyrics */

  // The app window drives the separate lyrics window. `set-options` is shared with the lyrics
  // window's own preload — both are Aurora renderers, and the patch is validated in either case.
  ipcMain.handle('desktop-lyrics:set-enabled', async (event, enabled: unknown) =>
    assertTrustedSender(event) ? setDesktopLyricsEnabled(enabled === true) : getDesktopLyricsOptions(),
  )

  ipcMain.handle('desktop-lyrics:toggle', async (event) =>
    assertTrustedSender(event) ? toggleDesktopLyrics() : getDesktopLyricsOptions(),
  )

  ipcMain.handle('desktop-lyrics:options', (event) =>
    assertTrustedSender(event) ? getDesktopLyricsOptions() : null,
  )

  ipcMain.handle('desktop-lyrics:reset-position', async (event) =>
    assertTrustedSender(event) ? resetDesktopLyricsPosition() : getDesktopLyricsOptions(),
  )

  /* ---------------------------------------------------------------- platforms (read-only, not installable) */

  ipcMain.handle('platforms:list', (event): PlatformDescriptor[] =>
    assertTrustedSender(event) ? listPlatformDescriptors() : [],
  )

  ipcMain.handle('platforms:search-all', async (event, query: unknown, options: unknown): Promise<PlatformSearchOutcome[]> => {
    if (!assertTrustedSender(event)) return []
    const text = typeof query === 'string' ? query.slice(0, 120) : ''
    return searchAllPlatforms(text, asSearchOptions(options))
  })

  ipcMain.handle(
    'platforms:search-one',
    async (event, platformId: unknown, query: unknown, options: unknown): Promise<PlatformSearchOutcome> => {
      const id = asId(platformId, 64)
      if (!assertTrustedSender(event) || !id) {
        return { platformId: 'unknown', platformName: 'unknown', ok: false, tracks: [], error: { code: 'UNSUPPORTED', message: '无效的平台' } }
      }
      const text = typeof query === 'string' ? query.slice(0, 120) : ''
      return searchPlatformOutcome(id, text, asSearchOptions(options))
    },
  )

  ipcMain.handle('platforms:health', async (event, platformId: unknown): Promise<PlatformHealthSummary | null> => {
    const id = asId(platformId, 64)
    if (!assertTrustedSender(event) || !id) return null
    return platformResolverSummary(id, getSettings(), allSecrets())
  })

  ipcMain.handle('platforms:health-all', (event): PlatformHealthSummary[] =>
    assertTrustedSender(event)
      ? listPlatformDescriptors().map((item) => platformResolverSummary(item.id, getSettings(), allSecrets()))
      : [],
  )

  ipcMain.handle('platforms:resolve', async (event, rawTrack: unknown, quality: unknown): Promise<ResolvedStream | null> => {
    if (!assertTrustedSender(event)) return null
    const track = asTrack(rawTrack)
    if (!track) return null
    const requestedQuality = typeof quality === 'string' && quality.length <= 16 && quality.trim() ? quality.trim() : undefined
    try {
      return await resolvePlatformTrack(track, requestedQuality, getSettings(), allSecrets())
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : '播放地址解析失败')
    }
  })

  ipcMain.handle('platforms:lyrics', async (event, rawTrack: unknown) => {
    if (!assertTrustedSender(event)) return null
    const track = asTrack(rawTrack)
    if (!track) return null
    return lyricsForPlatformTrack(track, getSettings(), allSecrets())
  })

  ipcMain.handle('platforms:boards', (event): BoardDescriptor[] =>
    assertTrustedSender(event) ? listBoardDescriptors() : [],
  )

  ipcMain.handle(
    'platforms:board-songs',
    async (event, platformId: unknown, boardId: unknown, limit: unknown): Promise<BoardOutcome> => {
      const platform = asId(platformId, 64)
      const board = asId(boardId, 64)
      const size = typeof limit === 'number' && Number.isFinite(limit) ? Math.round(limit) : 50
      if (!assertTrustedSender(event) || !platform || !board) {
        return {
          platformId: 'unknown',
          platformName: 'unknown',
          boardId: 'unknown',
          boardName: 'unknown',
          ok: false,
          tracks: [],
          error: { code: 'UNSUPPORTED', message: '无效的榜单' },
        }
      }
      return fetchBoardOutcome(platform, board, size)
    },
  )

  /* ---------------------------------------------------------------- sources (user plugins only) */

  ipcMain.handle('sources:list', (event): SourceDescriptor[] =>
    assertTrustedSender(event) ? describeSources(getSettings(), allSecrets()) : [],
  )

  ipcMain.handle('sources:search-all', async (event, query: unknown, options: unknown): Promise<SourceSearchOutcome[]> => {
    if (!assertTrustedSender(event)) return []
    const text = typeof query === 'string' ? query.slice(0, 120) : ''
    return searchAll(text, asSearchOptions(options), getSettings(), allSecrets())
  })

  ipcMain.handle(
    'sources:search-one',
    async (event, sourceId: unknown, query: unknown, options: unknown): Promise<SourceSearchOutcome> => {
      const id = asId(sourceId, 64)
      if (!assertTrustedSender(event) || !id) return EMPTY_OUTCOME('unknown', '无效的音源')
      const text = typeof query === 'string' ? query.slice(0, 120) : ''
      return searchOne(id, text, asSearchOptions(options), getSettings(), allSecrets())
    },
  )

  ipcMain.handle(
    'sources:recommendations',
    async (event, sourceId: unknown, options: unknown): Promise<SourceSearchOutcome> => {
      const id = asId(sourceId, 64)
      if (!assertTrustedSender(event) || !id) return EMPTY_OUTCOME('unknown', '无效的音源')
      const started = Date.now()
      const source = getSource(id)
      try {
        const tracks = await recommendations(id, asSearchOptions(options), getSettings(), allSecrets())
        return { sourceId: id, sourceName: source?.meta.name ?? id, ok: true, tracks, latencyMs: Date.now() - started }
      } catch (error) {
        return {
          sourceId: id,
          sourceName: source?.meta.name ?? id,
          ok: false,
          tracks: [],
          error: toSourceErrorInfo(error, source?.meta.name ?? '音源'),
        }
      }
    },
  )

  ipcMain.handle('sources:playlists', async (event, sourceId: unknown): Promise<SourcePlaylist[]> => {
    if (!assertTrustedSender(event)) return []
    const id = typeof sourceId === 'string' ? asId(sourceId, 64) : undefined
    return playlists(id ?? undefined, getSettings(), allSecrets())
  })

  ipcMain.handle(
    'sources:playlist-detail',
    async (event, sourceId: unknown, playlistId: unknown): Promise<SourcePlaylistDetail | null> => {
      if (!assertTrustedSender(event)) return null
      const id = asId(sourceId, 64)
      const listId = asId(playlistId, 120)
      if (!id || !listId) return null
      try {
        return await playlistDetail(id, listId, getSettings(), allSecrets())
      } catch (error) {
        throw new Error(error instanceof Error ? error.message : '歌单加载失败')
      }
    },
  )

  ipcMain.handle(
    'sources:resolve',
    async (event, sourceId: unknown, rawTrack: unknown, quality: unknown): Promise<ResolvedStream | null> => {
      if (!assertTrustedSender(event)) return null
      const id = asId(sourceId, 64)
      if (!id) return null
      // Two accepted shapes, both validated here: a bare track id (simple callers) or the whole
      // track, which is what a source needs when it resolves platform-specific ids.
      const asTrackInput =
        typeof rawTrack === 'object' && rawTrack !== null ? (asTrack(rawTrack) ?? undefined) : undefined
      const trackId = asTrackInput?.sourceTrackId ?? asId(rawTrack, 200)
      if (!trackId) return null
      const requestedQuality = typeof quality === 'string' && quality.length <= 16 && quality.trim() ? quality.trim() : undefined
      try {
        return await resolveStream(id, trackId, getSettings(), allSecrets(), {
          quality: requestedQuality,
          track: asTrackInput,
        })
      } catch (error) {
        throw new Error(error instanceof Error ? error.message : '音频流解析失败')
      }
    },
  )

  ipcMain.handle('sources:requests', (event, sourceId: unknown) => {
    if (!assertTrustedSender(event)) return []
    const id = typeof sourceId === 'string' ? asId(sourceId, 64) : undefined
    return readRequestLog(id ?? undefined).filter((entry) => !id || entry.sourceId === id)
  })

  ipcMain.handle('sources:set-enabled', async (event, sourceId: unknown, enabled: unknown): Promise<SourceDescriptor[]> => {
    if (!assertTrustedSender(event)) return describeSources(getSettings(), allSecrets())
    const id = asId(sourceId, 64)
    if (!id || typeof enabled !== 'boolean') return describeSources(getSettings(), allSecrets())
    await updateSettings({ enabledSources: { [id]: enabled } })
    // Enable/disable takes effect immediately: caches and runtime state are dropped right away.
    invalidateSourceRuntime(id)
    if (enabled) await initializeSources(getSettings(), allSecrets())
    return describeSources(getSettings(), allSecrets())
  })

  ipcMain.handle('sources:set-config', async (event, sourceId: unknown, patch: unknown): Promise<SourceDescriptor[]> => {
    const settings = getSettings()
    if (!assertTrustedSender(event)) return describeSources(settings, allSecrets())
    const id = asId(sourceId, 64)
    const source = id ? getSource(id) : undefined
    if (!id || !source) return describeSources(settings, allSecrets())

    const { config, secrets } = splitConfigPatch(id, asConfigPatch(patch))
    if (Object.keys(secrets).length > 0) await writeSecrets(id, secrets)
    else await writeSecrets(id, {})
    await updateSettings({ sourceConfig: { [id]: config } })
    invalidateSourceRuntime(id)
    const next = getSettings()
    if (isConfigured(source, resolveConfig(source, next, allSecrets()[id] ?? {}))) {
      await initializeSources(next, allSecrets())
    }
    return describeSources(next, allSecrets())
  })

  ipcMain.handle('sources:set-order', async (event, order: unknown): Promise<SourceDescriptor[]> => {
    if (!assertTrustedSender(event)) return describeSources(getSettings(), allSecrets())
    const list = Array.isArray(order) ? order.filter((item): item is string => typeof item === 'string') : []
    await updateSettings({ sourceOrder: list })
    return describeSources(getSettings(), allSecrets())
  })

  ipcMain.handle('sources:health', async (event, sourceId: unknown): Promise<SourceHealth> => {
    const id = asId(sourceId, 64)
    if (!assertTrustedSender(event) || !id) return { ok: false, message: '无效的音源', checkedAt: Date.now() }
    // Platforms are not sources; health by platform id goes through platforms:health.
    if (getPlatformDescriptor(id)) {
      const summary = platformResolverSummary(id, getSettings(), allSecrets())
      return summary.health
    }
    return checkHealth(id, getSettings(), allSecrets())
  })

  /* ---------------------------------------------------------------- custom sources */

  ipcMain.handle('custom-sources:list', (event) => (assertTrustedSender(event) ? listCustomSources() : []))

  ipcMain.handle('custom-sources:templates', (event) => (assertTrustedSender(event) ? listTemplates() : []))

  ipcMain.handle('custom-sources:validate', (event, raw: unknown): ManifestValidationResult => {
    if (!assertTrustedSender(event) || typeof raw !== 'string') return { ok: false, errors: ['无效的输入'] }
    return validateCustomSourceRaw(raw.slice(0, 256 * 1024))
  })

  ipcMain.handle('custom-sources:save', async (event, raw: unknown): Promise<CustomSourceSaveResult> => {
    if (!assertTrustedSender(event) || typeof raw !== 'string') {
      return { ok: false, errors: ['无效的输入'], manifests: listCustomSources() }
    }
    const result = await saveCustomSource(raw.slice(0, 256 * 1024))
    if (result.ok) invalidateSourceRuntime()
    return result
  })

  ipcMain.handle('custom-sources:remove', async (event, id: unknown): Promise<CustomSourceSaveResult> => {
    if (!assertTrustedSender(event)) return { ok: false, errors: ['无效的请求'], manifests: listCustomSources() }
    const sourceId = asId(id)
    if (!sourceId) return { ok: false, errors: ['无效的音源 id'], manifests: listCustomSources() }
    return removeCustomSource(sourceId)
  })

  ipcMain.handle('custom-sources:export', (event, id: unknown): string | null => {
    if (!assertTrustedSender(event)) return null
    const sourceId = asId(id)
    return sourceId ? exportCustomSource(sourceId) : null
  })

  /* ---------------------------------------------------------------- script sources */

  ipcMain.handle('script-sources:list', (event): ScriptSourceRecord[] =>
    assertTrustedSender(event) ? listScriptSources() : [],
  )

  ipcMain.handle('script-sources:probe', async (event, options: unknown): Promise<ScriptProbeResult> => {
    if (!assertTrustedSender(event)) return { ok: false, errors: ['无效的请求'], warnings: [] }
    const input = (options ?? {}) as Record<string, unknown>
    if (typeof input.sourceText !== 'string') return { ok: false, errors: ['缺少脚本内容'], warnings: [] }
    return probeScriptImport({
      sourceText: input.sourceText.slice(0, MAX_SCRIPT_BYTES),
      ...(typeof input.fileName === 'string' ? { fileName: input.fileName.slice(0, 120) } : {}),
      ...(input.runtime === 'lx' || input.runtime === 'aurora' ? { runtime: input.runtime } : {}),
      ...(typeof input.id === 'string' ? { id: input.id.slice(0, 48) } : {}),
    })
  })

  ipcMain.handle('script-sources:save', async (event, options: unknown): Promise<ScriptSourceSaveResult> => {
    if (!assertTrustedSender(event)) return { ok: false, errors: ['无效的请求'], sources: listScriptSources() }
    const input = (options ?? {}) as Record<string, unknown>
    if (typeof input.sourceText !== 'string') {
      return { ok: false, errors: ['缺少脚本内容'], sources: listScriptSources() }
    }
    return saveScriptSource({ sourceText: input.sourceText.slice(0, MAX_SCRIPT_BYTES), manifest: input.manifest })
  })

  ipcMain.handle('script-sources:remove', async (event, id: unknown): Promise<ScriptSourceSaveResult> => {
    if (!assertTrustedSender(event)) return { ok: false, errors: ['无效的请求'], sources: listScriptSources() }
    const sourceId = asId(id)
    if (!sourceId) return { ok: false, errors: ['无效的音源 id'], sources: listScriptSources() }
    return removeScriptSource(sourceId)
  })

  ipcMain.handle('script-sources:reload', async (event, id: unknown): Promise<ScriptSourceSaveResult> => {
    if (!assertTrustedSender(event)) return { ok: false, errors: ['无效的请求'], sources: listScriptSources() }
    const sourceId = asId(id)
    if (!sourceId) return { ok: false, errors: ['无效的音源 id'], sources: listScriptSources() }
    return reloadScriptSource(sourceId)
  })

  ipcMain.handle('script-sources:export', (event, id: unknown): Promise<string | null> => {
    if (!assertTrustedSender(event)) return Promise.resolve(null)
    const sourceId = asId(id)
    return sourceId ? exportScriptSource(sourceId) : Promise.resolve(null)
  })

  ipcMain.handle('script-sources:inspect', (event, id: unknown) => {
    const sourceId = asId(id)
    if (!assertTrustedSender(event) || !sourceId) return Promise.resolve({ ok: false, message: '无效的音源 id' })
    return inspectScriptSource(sourceId)
  })

  /*
   * Importing a whole 洛雪 library.
   *
   * The file is chosen, read and *held in the main process*: the preview returns only a summary per
   * source, and the import names ids. That keeps a megabyte of executable text out of the renderer,
   * and it means the text that gets written is the text main read from disk — never something the
   * renderer could have substituted between the two calls.
   */
  ipcMain.handle('script-sources:lx-library-open', async (event): Promise<LxLibraryPreview> => {
    const empty: LxLibraryPreview = { ok: false, errors: [], fileName: '', items: [] }
    if (!assertTrustedSender(event)) return { ...empty, errors: ['无效的请求'] }
    const window = getWindow()
    if (!window) return { ...empty, errors: ['窗口不可用'] }
    const result = await dialog.showOpenDialog(window, {
      title: '导入洛雪音源库',
      properties: ['openFile'],
      filters: [
        { name: '洛雪音源库', extensions: ['json'] },
        { name: '全部文件', extensions: ['*'] },
      ],
    })
    if (result.canceled || result.filePaths.length === 0) return empty
    const path = result.filePaths[0]
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      return { ...empty, errors: [`无法读取文件：${error instanceof Error ? error.message : '未知错误'}`] }
    }
    pendingLxLibrary = { path, text }
    const preview = await previewLxLibrary(text, basename(path))
    return { ...preview, fileName: basename(path) }
  })

  ipcMain.handle('script-sources:lx-library-import', async (event, ids: unknown): Promise<LxLibraryImportResult> => {
    const empty: LxLibraryImportResult = { ok: false, errors: [], added: 0, failed: [], sources: listScriptSources() }
    if (!assertTrustedSender(event)) return { ...empty, errors: ['无效的请求'] }
    if (!pendingLxLibrary) return { ...empty, errors: ['请先选择音源库文件'] }
    const list = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string').slice(0, 64) : []
    if (list.length === 0) return { ...empty, errors: ['没有选择任何音源'] }
    return importLxLibrary(pendingLxLibrary.text, list, basename(pendingLxLibrary.path))
  })

  ipcMain.handle('script-sources:lx-library-cancel', (event): boolean => {
    if (!assertTrustedSender(event)) return false
    pendingLxLibrary = null
    return true
  })

  /* ---------------------------------------------------------------- source detector & grants */

  ipcMain.handle('source-import:file', (event): Promise<SourceImportResult> => {
    if (!assertTrustedSender(event)) return Promise.resolve({ ok: false, kind: 'unknown', fileName: '', summary: '无效的请求', errors: [] })
    return importSourceFromFile(getWindow())
  })

  ipcMain.handle('source-import:text', (event, text: unknown, fileName: unknown): Promise<SourceImportResult> => {
    if (!assertTrustedSender(event) || typeof text !== 'string') {
      return Promise.resolve({ ok: false, kind: 'unknown', fileName: '', summary: '无效的请求', errors: [] })
    }
    return detectSourceText(text.slice(0, MAX_SCRIPT_BYTES), typeof fileName === 'string' ? fileName.slice(0, 120) : 'pasted.txt')
  })

  ipcMain.handle('sources:pending-hosts', (event, sourceId: unknown): SourcePendingHost[] => {
    if (!assertTrustedSender(event)) return []
    const id = typeof sourceId === 'string' ? asId(sourceId, 64) : undefined
    return pendingHostsFor(id ?? undefined)
  })

  ipcMain.handle('sources:grant-hosts', async (event, sourceId: unknown, hosts: unknown): Promise<SourceDescriptor[]> => {
    const descriptors = (): SourceDescriptor[] => describeSources(getSettings(), allSecrets())
    if (!assertTrustedSender(event)) return descriptors()
    const id = asId(sourceId, 64)
    const list = Array.isArray(hosts) ? hosts.filter((host): host is string => typeof host === 'string').slice(0, 24) : []
    if (!id || list.length === 0) return descriptors()
    await grantSourceHosts(id, list)
    // A granted host changes what the runtime may do, so the source is reloaded immediately.
    invalidateSourceRuntime(id)
    disposeScriptHost(id)
    return descriptors()
  })

  /*
   * Taking a grant back. The automatic repair makes this the interesting half of the pair: a host the
   * program granted for the user has to be removable by the user, otherwise "自动允许" would be a
   * one-way widening hidden behind a help text.
   */
  ipcMain.handle('sources:revoke-hosts', async (event, sourceId: unknown, hosts: unknown): Promise<SourceDescriptor[]> => {
    const descriptors = (): SourceDescriptor[] => describeSources(getSettings(), allSecrets())
    if (!assertTrustedSender(event)) return descriptors()
    const id = asId(sourceId, 64)
    const list = Array.isArray(hosts) ? hosts.filter((host): host is string => typeof host === 'string').slice(0, 24) : []
    if (!id || list.length === 0) return descriptors()
    await revokeSourceHosts(id, list)
    invalidateSourceRuntime(id)
    disposeScriptHost(id)
    return descriptors()
  })

  /** Real operations (search + resolve) with real error codes — the source page's 自检 button. */
  ipcMain.handle(
    'sources:self-check',
    async (event, sourceId: unknown, options: unknown): Promise<SourceSelfCheckResult | null> => {
      if (!assertTrustedSender(event)) return null
      const id = asId(sourceId, 64)
      if (!id) return null
      const candidate = (options ?? {}) as { repair?: unknown; keyword?: unknown }
      return selfCheckSource(id, {
        repair: candidate.repair === true,
        ...(typeof candidate.keyword === 'string' ? { keyword: candidate.keyword.slice(0, 60) } : {}),
      })
    },
  )

  /*
   * 全量自检：the same real check, run over every enabled source.
   *
   * It is its own channel rather than a loop in the renderer because the summary has to be composed in one
   * place: the categories, the counts and the sentence all come from the same run, and a renderer-side loop
   * would be able to disagree with the per-source pages it links to.
   */
  ipcMain.handle(
    'sources:self-check-all',
    async (event, options: unknown): Promise<SourceCheckAllResult> => {
      const empty: SourceCheckAllResult = {
        at: Date.now(),
        keyword: '',
        checked: 0,
        skipped: 0,
        counts: { ok: 0, unauthorized: 0, timeout: 0, empty: 0, unconfigured: 0, inactive: 0, error: 0 },
        headline: '没有权限或桥接不可用',
        sources: [],
      }
      if (!assertTrustedSender(event)) return empty
      const candidate = (options ?? {}) as { repair?: unknown; keyword?: unknown }
      return selfCheckAllSources({
        repair: candidate.repair === true,
        ...(typeof candidate.keyword === 'string' ? { keyword: candidate.keyword.slice(0, 60) } : {}),
      })
    },
  )

  /** The source's own error history, newest first — what the self-check points at when something failed. */
  ipcMain.handle('sources:errors', (event, sourceId: unknown): SourceErrorLogEntry[] => {
    if (!assertTrustedSender(event)) return []
    const id = asId(sourceId, 64)
    return id ? readErrorLog(id) : []
  })

  /* ---------------------------------------------------------------- downloads */

  ipcMain.handle('downloads:list', (event) => (assertTrustedSender(event) ? listDownloads() : []))

  ipcMain.handle('downloads:start', (event, input: unknown) => {
    if (!assertTrustedSender(event)) return null
    const track = asTrack((input as { track?: unknown } | null)?.track)
    if (!track) return null
    const quality = (input as { quality?: unknown } | null)?.quality
    return startDownload({
      track,
      ...(typeof quality === 'string' && quality.length <= 16 && quality.trim() ? { quality: quality.trim() } : {}),
    })
  })

  ipcMain.handle('downloads:pause', (event, id: unknown) => {
    const taskId = asId(id)
    return assertTrustedSender(event) && taskId ? pauseDownload(taskId) : listDownloads()
  })

  ipcMain.handle('downloads:resume', (event, id: unknown) => {
    const taskId = asId(id)
    return assertTrustedSender(event) && taskId ? resumeDownload(taskId) : listDownloads()
  })

  ipcMain.handle('downloads:retry', (event, id: unknown) => {
    const taskId = asId(id)
    return assertTrustedSender(event) && taskId ? retryDownload(taskId) : listDownloads()
  })

  ipcMain.handle('downloads:cancel', (event, id: unknown) => {
    const taskId = asId(id)
    return assertTrustedSender(event) && taskId ? cancelDownload(taskId) : listDownloads()
  })

  ipcMain.handle('downloads:remove', (event, id: unknown) => {
    const taskId = asId(id)
    return assertTrustedSender(event) && taskId ? removeDownload(taskId) : listDownloads()
  })

  ipcMain.handle('downloads:clear-finished', (event) =>
    assertTrustedSender(event) ? clearFinishedDownloads() : listDownloads(),
  )

  ipcMain.handle('downloads:reveal', (event, id: unknown) => {
    const taskId = asId(id)
    return assertTrustedSender(event) && taskId ? revealDownload(taskId) : false
  })

  ipcMain.handle('downloads:open-directory', (event) =>
    assertTrustedSender(event) ? openDownloadDirectory() : Promise.resolve(false),
  )

  ipcMain.handle('downloads:choose-directory', (event) =>
    assertTrustedSender(event) ? chooseDownloadDirectory(getWindow()) : Promise.resolve(null),
  )

  /* ---------------------------------------------------------------- lyrics */

  /**
   * The fast half of the lyrics engine: user import, sidecar `.lrc`, fetch cache, embedded tags, and
   * the track's own source. Never touches a public catalogue, so the page renders immediately.
   */
  ipcMain.handle('lyrics:get', async (event, track: unknown): Promise<Lyrics | null> => {
    if (!assertTrustedSender(event)) return null
    const parsed = asTrack(track)
    if (!parsed) return null
    return getLyrics(parsed, getSettings())
  })

  /**
   * The slow half, for background enrichment once the fast half came back empty: searches the public
   * catalogues and caches a hit. Safe to call on every track change — a hit is cached and a miss is
   * cached in memory, so the request happens at most once per track per session.
   */
  ipcMain.handle('lyrics:search', async (event, track: unknown): Promise<LyricsResolution | null> => {
    if (!assertTrustedSender(event)) return null
    const parsed = asTrack(track)
    if (!parsed) return null
    return searchLyricsOnline(parsed, getSettings())
  })

  /**
   * 「联网自动匹配」: the full LyricsManager resolution, including what each provider did.
   *
   * Returns the report rather than only the lyrics, because "still nothing" needs to be explainable
   * — the user is about to be told that no catalogue had this track, and that claim has to be backed
   * by the list of catalogues that were actually asked.
   */
  ipcMain.handle('lyrics:match', async (event, track: unknown): Promise<LyricsResolution | null> => {
    if (!assertTrustedSender(event)) return null
    const parsed = asTrack(track)
    if (!parsed) return null
    return matchLyrics(parsed, getSettings(), { force: true })
  })

  ipcMain.handle('lyrics:save', async (event, track: unknown, raw: unknown): Promise<Lyrics | null> => {
    if (!assertTrustedSender(event)) return null
    const parsed = asTrack(track)
    if (!parsed || typeof raw !== 'string') return null
    return saveUserLyrics(parsed, raw.slice(0, 512 * 1024))
  })

  ipcMain.handle('lyrics:clear', async (event, track: unknown): Promise<boolean> => {
    if (!assertTrustedSender(event)) return false
    const parsed = asTrack(track)
    return parsed ? clearUserLyrics(parsed) : false
  })

  /* ---------------------------------------------------------------- settings & app info */

  ipcMain.handle('settings:get', (event): AuroraSettings => {
    // An untrusted sender gets the defaults, never the user's file — and they come from the single
    // definition in `settings.ts`, so this answer cannot drift away from what the app really defaults to.
    if (!assertTrustedSender(event)) return defaultSettings()
    return getSettings()
  })

  ipcMain.handle('settings:set', async (event, patch: unknown): Promise<AuroraSettings> => {
    if (!assertTrustedSender(event)) return getSettings()
    const safe = typeof patch === 'object' && patch !== null ? (patch as AuroraSettingsPatch) : {}
    const next = await updateSettings(safe)
    if (typeof safe.allowOpenLicenseDownloads === 'boolean') invalidateSourceRuntime()
    // A changed download setting takes effect now: a raised concurrency starts waiting tasks, and a
    // new target directory is used by the very next file.
    if (safe.downloads) pumpDownloads()
    return next
  })

  /*
   * The renderer owns the visual theme (`data-theme` on <html>); this mirrors it into main, which is
   * the only side that can repaint the native title-bar strip and the native control colour scheme.
   * Persisted as well, so the next launch opens with the right chrome instead of flashing.
   */
  /*
   * `payload` carries the resolved chrome and skin id as well as the mode, because they are decided by
   * the *renderer*: the strip colour comes out of the generated token set, which is where user themes
   * live. Main stores all three, so the next launch can paint the right strip before the page loads.
   */
  ipcMain.handle('app:set-theme', async (event, payload: unknown): Promise<ThemeMode> => {
    const mode = typeof payload === 'string' ? payload : (payload as { mode?: unknown } | null)?.mode
    if (!assertTrustedSender(event) || !isThemeMode(mode)) return getSettings().theme
    const raw = (payload ?? {}) as { chrome?: unknown; skin?: unknown }
    const chrome =
      raw.chrome && typeof raw.chrome === 'object'
        ? (raw.chrome as { color?: unknown; symbolColor?: unknown })
        : null
    const skin = typeof raw.skin === 'string' ? raw.skin : undefined
    /*
     * The saved mode is always the user's own choice — `night` must not leak into it, or opening the
     * playback-detail page once would leave the app dark on the next launch. `night` only decides what
     * the strip and `nativeTheme` do right now, because that page is dark in every theme.
     */
    await updateSettings(skin ? { theme: mode, skin } : { theme: mode })
    const night = (raw as { night?: unknown }).night === true
    applyWindowChrome(
      getWindow(),
      night ? 'dark' : mode,
      chrome && typeof chrome.color === 'string' && typeof chrome.symbolColor === 'string'
        ? { color: chrome.color, symbolColor: chrome.symbolColor }
        : null,
    )
    return mode
  })

  /*
   * The shell's own backdrop, sampled from the compositor.
   *
   * The renderer cannot compute this: the playback-detail page's background is a stack of blurred
   * layers whose colour at a given point depends on the cover, the skin and the veil's height ramp.
   * Sampling is the only way the player bar and the native strip can be painted with what is genuinely
   * behind them. Capped at four regions and never called outside that page.
   */
  ipcMain.handle('app:sample-backdrop', async (event, rects: unknown): Promise<(string | null)[]> => {
    if (!assertTrustedSender(event) || !Array.isArray(rects)) return []
    const regions: BackdropRect[] = rects.slice(0, 4).map((raw) => {
      const item = (raw ?? {}) as Partial<Record<keyof BackdropRect, unknown>>
      const size = (value: unknown): number =>
        typeof value === 'number' && Number.isFinite(value) ? value : 0
      return { x: size(item.x), y: size(item.y), width: size(item.width), height: size(item.height) }
    })
    return sampleBackdrop(getWindow(), regions)
  })

  /*
   * Repaints the native overlay only.
   *
   * `app:set-theme` also persists the mode and switches `nativeTheme`, which must happen once per state
   * change and not once per frame. The renderer fades the strip itself when the cover changes (the OS
   * overlay takes a concrete colour and cuts otherwise), and those frames come through here.
   */
  ipcMain.handle('app:set-chrome', (event, payload: unknown): boolean => {
    if (!assertTrustedSender(event)) return false
    const raw = (payload ?? {}) as { color?: unknown; symbolColor?: unknown }
    const colour = (value: unknown): string | null =>
      typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value.trim()) ? value.trim() : null
    const color = colour(raw.color)
    if (!color) return false
    const symbolColor = colour(raw.symbolColor) ?? '#f1f2f7'
    applyWindowChrome(getWindow(), 'dark', { color, symbolColor })
    return true
  })

  // The user's themes folder. `list` is what 更多主题 shows; `import` copies a chosen file in.
  ipcMain.handle('themes:list', async (event): Promise<UserThemeRecord[]> =>
    assertTrustedSender(event) ? listUserThemes() : [],
  )

  ipcMain.handle('themes:import', async (event): Promise<UserThemeRecord | null> => {
    if (!assertTrustedSender(event)) return null
    const source = await pickThemeFile(getWindow())
    if (!source) return null
    return importUserTheme(source)
  })

  ipcMain.handle('themes:remove', async (event, id: unknown): Promise<UserThemeRecord[]> => {
    if (!assertTrustedSender(event) || typeof id !== 'string') return listUserThemes()
    await removeUserTheme(id)
    return listUserThemes()
  })

  ipcMain.handle('themes:reveal', async (event): Promise<string> =>
    assertTrustedSender(event) ? revealThemesDirectory() : '',
  )

  ipcMain.handle('app:info', (event): AppInfo => {
    if (!assertTrustedSender(event)) {
      return { name: '', version: '', electron: '', platform: '', arch: '', dataPath: '' }
    }
    return {
      name: app.getName(),
      version: app.getVersion(),
      electron: process.versions.electron,
      platform: process.platform,
      arch: process.arch,
      dataPath: app.getPath('userData'),
    }
  })

  /* ---------------------------------------------------------------- cache (B4) */

  ipcMain.handle('cache:report', async (event) =>
    assertTrustedSender(event) ? measureCaches() : { areas: [], totalFiles: 0, totalBytes: 0, checkedAt: Date.now() },
  )

  ipcMain.handle('cache:clear', async (event, areas: unknown) => {
    if (!assertTrustedSender(event)) return { report: await measureCaches(), freedFiles: 0, freedBytes: 0, memoryCaches: 0 }
    const ids = Array.isArray(areas) ? (areas.filter((id) => id === 'covers' || id === 'lyrics' || id === 'temp') as CacheAreaId[]) : undefined
    return clearCaches(ids)
  })

  /* ---------------------------------------------------------------- backup (B5) */

  ipcMain.handle('backup:export', async (event, data: unknown) => {
    if (!assertTrustedSender(event)) return { saved: false, canceled: true, path: '', bytes: 0, counts: { favorites: 0, history: 0, playlists: 0, tracks: 0, settings: 0 } }
    const payload = asBackupData(data)
    return exportBackup(getWindow(), payload, listTracks().length)
  })

  ipcMain.handle('backup:pick', async (event) => (assertTrustedSender(event) ? pickBackup(getWindow()) : { canceled: true, path: '', error: '', createdAt: '', appVersion: '', formatVersion: 0, counts: { favorites: 0, history: 0, playlists: 0, tracks: 0, settings: 0 }, warnings: [] }))

  ipcMain.handle('backup:apply', async (event) =>
    assertTrustedSender(event)
      ? applyBackup()
      : { applied: false, counts: { favorites: 0, history: 0, playlists: 0, tracks: 0, settings: 0 }, warnings: ['未授权的调用方'], data: null },
  )

  ipcMain.handle('backup:revert', async (event) => (assertTrustedSender(event) ? revertBackup() : false))

  ipcMain.handle('backup:commit', (event) => {
    if (!assertTrustedSender(event)) return false
    commitBackup()
    return true
  })

  /* ---------------------------------------------------------------- diagnostics (C2) */

  ipcMain.handle('diagnostics:report', async (event) =>
    assertTrustedSender(event) ? diagnosticsReport() : { logPath: '', bytes: 0, entries: [], version: '', total: 0 },
  )

  ipcMain.handle('diagnostics:clear', async (event) =>
    assertTrustedSender(event) ? clearDiagnostics() : { logPath: '', bytes: 0, entries: [], version: '', total: 0 },
  )

  ipcMain.handle('diagnostics:export', async (event) =>
    assertTrustedSender(event) ? exportDiagnostics(getWindow()) : { saved: false, canceled: true, path: '', bytes: 0 },
  )

  ipcMain.handle('diagnostics:reveal', (event) => (assertTrustedSender(event) ? revealLogFolder() : false))

  ipcMain.handle('diagnostics:record', (event, kind: unknown, message: unknown): boolean => {
    if (!assertTrustedSender(event)) return false
    const category = typeof kind === 'string' ? kind : 'renderer-error'
    const text = typeof message === 'string' ? message : ''
    if (!text) return false
    recordDiagnostics('renderer', category, text)
    return true
  })

  /* ---------------------------------------------------------------- updates (C3) */

  ipcMain.handle('updates:check', async (event, force: unknown) =>
    assertTrustedSender(event)
      ? checkForUpdates(force === true)
      : { status: 'unconfigured' as const, currentVersion: '', latestVersion: '', downloadUrl: '', notes: '', checkedAt: Date.now(), detail: '' },
  )

  ipcMain.handle('updates:open', (event, url: unknown) => (assertTrustedSender(event) && typeof url === 'string' ? openUpdatePage(url) : false))

  /* ---------------------------------------------------------------- local API (C4) */

  ipcMain.handle('http-api:status', (event) => (assertTrustedSender(event) ? httpApiStatus() : { running: false, port: 0, url: '', requests: 0, lastRequestAt: 0, lastRequestPath: '', error: '', endpoints: [] }))

  ipcMain.handle('http-api:set', async (event, patch: unknown) => {
    if (!assertTrustedSender(event)) return httpApiStatus()
    const clean = (patch ?? {}) as Record<string, unknown>
    const next: Record<string, unknown> = {}
    if (typeof clean.enabled === 'boolean') next.enabled = clean.enabled
    if (typeof clean.port === 'number') next.port = clean.port
    await updateSettings({ httpApi: next })
    // Started/stopped here rather than lazily: the switch has to take effect the moment it moves.
    return startHttpApi()
  })

  ipcMain.handle('http-api:regenerate-token', async (event) => {
    if (!assertTrustedSender(event)) return httpApiStatus()
    regenerateHttpToken()
    return startHttpApi()
  })

  /* ---------------------------------------------------------------- database (C1) */

  ipcMain.handle('database:stats', async (event) =>
    assertTrustedSender(event)
      ? databaseStats()
      : { engine: 'json' as const, path: '', bytes: 0, tracks: 0, favorites: 0, history: 0, playlists: 0, documents: 0, migratedFrom: '', migrationAt: 0 },
  )
}
