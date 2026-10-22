/**
 * Aurora's maintenance surface: cache accounting, backup/restore, crash reports, the update check,
 * the optional local HTTP API and the database that now backs the library.
 *
 * These live in one module rather than in `types.ts` because they share a property `types.ts` does
 * not: every one of them is *reported*, not merely configured. A cache manager that cannot say how
 * many bytes it is about to delete, or a database that cannot say which engine it opened, would be
 * the kind of button this project refuses to ship.
 */

/* ------------------------------------------------------------------ 缓存 (B4) */

export type CacheAreaId = 'covers' | 'lyrics' | 'temp'

/** One measured area of the cache. `path` is shown in the UI, so "clear" is never a black box. */
export interface CacheArea {
  id: CacheAreaId
  label: string
  /** What clearing this area costs the user — the part a bare byte count does not say. */
  detail: string
  path: string
  files: number
  bytes: number
}

export interface CacheReport {
  areas: CacheArea[]
  totalFiles: number
  totalBytes: number
  checkedAt: number
}

export interface CacheClearResult {
  report: CacheReport
  freedFiles: number
  freedBytes: number
  /** In-memory TTL entries dropped as well; reported so a 0-byte area still proves it did something. */
  memoryCaches: number
}

/* ------------------------------------------------------------------ 备份 / 恢复 (B5) */

export const BACKUP_KIND = 'aurora-backup'
export const BACKUP_FORMAT_VERSION = 1

export interface BackupHistoryEntry {
  id: string
  playedAt: number
  playCount: number
}

export interface BackupPlaylist {
  id: string
  name: string
  trackIds: string[]
  createdAt: number
  updatedAt: number
}

/**
 * The renderer-owned half of a backup.
 *
 * Settings are deliberately *not* here: the main process owns them, writes them itself, and never
 * hands a whole settings object to the renderer on the way in (see `main/backup.ts`).
 */
export interface BackupUserData {
  favorites: string[]
  history: BackupHistoryEntry[]
  playlists: BackupPlaylist[]
  lyricColor: string
  lyricColorCustom: string
}

export interface BackupCounts {
  favorites: number
  history: number
  playlists: number
  tracks: number
  settings: number
}

export interface BackupExportResult {
  saved: boolean
  canceled: boolean
  path: string
  bytes: number
  counts: BackupCounts
}

/**
 * What a picked file turned out to be.
 *
 * `error` is a sentence for the user ("这不是 Aurora 的备份文件"), not a code: a restore that silently
 * does nothing is worse than one that refuses out loud.
 */
export interface BackupPickResult {
  canceled: boolean
  path: string
  error: string
  createdAt: string
  appVersion: string
  formatVersion: number
  counts: BackupCounts
  warnings: string[]
}

export interface BackupApplyResult {
  applied: boolean
  counts: BackupCounts
  warnings: string[]
  /** The renderer's own half, handed over only after the settings have been written. */
  data: BackupUserData | null
}

/* ------------------------------------------------------------------ 诊断 (C2) */

export type DiagnosticsSource = 'main' | 'renderer'

export interface DiagnosticsEntry {
  id: string
  at: number
  source: DiagnosticsSource
  /** `uncaught-exception` / `unhandled-rejection` / `renderer-error` — a category, never a stack. */
  kind: string
  message: string
  version: string
}

export interface DiagnosticsReport {
  logPath: string
  bytes: number
  entries: DiagnosticsEntry[]
  version: string
  /** How many entries the log holds beyond the ones returned; keeps the list bounded, not lying. */
  total: number
}

export interface DiagnosticsExportResult {
  saved: boolean
  canceled: boolean
  path: string
  bytes: number
}

/* ------------------------------------------------------------------ 更新检查 (C3) */

export interface UpdateCheckSettings {
  /** Any URL returning a version manifest: a GitHub releases API URL, or `{version,url,notes}` JSON. */
  feedUrl: string
  autoCheck: boolean
}

export const DEFAULT_UPDATE_CHECK: UpdateCheckSettings = { feedUrl: '', autoCheck: false }

export interface UpdateCheckResult {
  status: 'unconfigured' | 'up-to-date' | 'available' | 'error'
  currentVersion: string
  latestVersion: string
  downloadUrl: string
  notes: string
  checkedAt: number
  /** The sentence the UI shows; for `error` it is the real reason (HTTP status, DNS, timeout). */
  detail: string
}

/* ------------------------------------------------------------------ 本地 API (C4) */

export interface HttpApiSettings {
  enabled: boolean
  port: number
  /** Bearer token; generated in main and never logged. Empty means "not started yet". */
  token: string
}

export const DEFAULT_HTTP_API: HttpApiSettings = { enabled: false, port: 47821, token: '' }
export const HTTP_API_PORT_MIN = 1024
export const HTTP_API_PORT_MAX = 65535

export interface HttpApiStatus {
  running: boolean
  port: number
  url: string
  requests: number
  lastRequestAt: number
  lastRequestPath: string
  /** Non-empty only when the last start attempt failed (port taken, for instance). */
  error: string
  endpoints: string[]
}

/* ------------------------------------------------------------------ 数据库 (C1) */

export interface DatabaseStats {
  engine: 'sqlite' | 'json'
  path: string
  bytes: number
  tracks: number
  favorites: number
  history: number
  playlists: number
  documents: number
  /** The file the rows were imported from, empty when this database was created empty. */
  migratedFrom: string
  migrationAt: number
}

/* ------------------------------------------------------------------ 迷你播放器 (C5) */

export interface MiniPlayerSettings {
  enabled: boolean
  alwaysOnTop: boolean
}

export const DEFAULT_MINI_PLAYER: MiniPlayerSettings = { enabled: false, alwaysOnTop: true }
