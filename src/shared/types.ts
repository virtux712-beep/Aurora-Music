/**
 * Aurora's shared contract, used by the main process, the preload bridge and the renderer.
 *
 * Two ideas matter here:
 *  1. Every source returns the *same* shapes (`AudioTrack`, `SourcePlaylist`, `Lyrics`) — no source
 *     ever leaks its own API payload into the UI.
 *  2. A source declares what it can do through `SourceCapabilities`, so the UI never needs
 *     source-id branching: it asks the capability instead.
 */

import type { QualityTierId } from './quality'
import type { UserThemeRecord } from './theme'
import type { SoundSettings } from './sound'
import type {
  BackupApplyResult,
  BackupExportResult,
  BackupPickResult,
  BackupUserData,
  CacheAreaId,
  CacheClearResult,
  CacheReport,
  DatabaseStats,
  DiagnosticsExportResult,
  DiagnosticsReport,
  HttpApiSettings,
  HttpApiStatus,
  UpdateCheckResult,
  UpdateCheckSettings,
} from './maintenance'

/** Cache accounting, backup/restore, diagnostics, updates, the local API and the database. */
export * from './maintenance'
export type { SoundSettings }
export type { EqualizerSettings, LoudnessSettings } from './sound'

export type ThemeMode = 'dark' | 'light' | 'system'
export type { UserThemeRecord }

export type PlayMode = 'sequential' | 'list-loop' | 'single' | 'shuffle'

/** Source ids are open-ended strings: user plugins share one namespace. Platform ids live separately. */
export type SourceId = string

/** Canonical platform ids Aurora ships search for. A Source declares which of these it can resolve. */
export type PlatformId = string

/**
 * The platform search back-ends Aurora ships with (酷我 / 网易云 / QQ / 酷狗 / 咪咕).
 *
 * They cover search and metadata; a playable URL comes from a user-installed Source that declares
 * the platform. Platforms are *not* Sources — they are a separate registry, never installable.
 *
 * Kept here so the *code* can name them; the UI renders whatever the platform registry reports.
 */
export type BuiltinPlatformId = 'kw' | 'wy' | 'tx' | 'kg' | 'mg'

export type BuiltinSourceId = BuiltinPlatformId

/**
 * A platform Aurora can search. Platforms are identity + search capability only — they never
 * appear in the Source registry, are never installable, and never have enabled/health of their own.
 * Whether a platform track can *play* is derived from how many enabled Sources resolve that platform.
 */
export interface PlatformDescriptor {
  id: PlatformId
  name: string
  /** Two-character tab label, e.g. “酷我”. */
  shortLabel: string
  description: string
  qualities: PlaybackQuality[]
  icon?: string
}

/**
 * One chart a platform publishes (e.g. 网易云飙升榜). Only platforms with a working board endpoint
 * contribute entries, so the UI can render "whatever charts exist" instead of a fixed list.
 */
export interface BoardDescriptor {
  platformId: PlatformId
  platformName: string
  boardId: string
  name: string
}

/** The result of loading one chart. A failed chart names itself and never blocks the others. */
export interface BoardOutcome {
  platformId: PlatformId
  platformName: string
  boardId: string
  boardName: string
  ok: boolean
  tracks: AudioTrack[]
  error?: SourceErrorInfo
  latencyMs?: number
}

/** Health / resolver summary for a platform, computed at query time from enabled Sources. */
export interface PlatformHealthSummary {
  platformId: PlatformId
  resolverCount: number
  resolverNames: string[]
  health: SourceHealth
}

/** Search result for one platform — kept shape-compatible with SourceSearchOutcome so boards can unify. */
export interface PlatformSearchOutcome {
  platformId: PlatformId
  platformName: string
  ok: boolean
  tracks: AudioTrack[]
  error?: SourceErrorInfo
  latencyMs?: number
}

export type TrackOrigin = 'local' | 'online'

/* ------------------------------------------------------------------ capabilities */

export interface SourceCapabilities {
  /** Can search a catalogue by keyword. */
  search: boolean
  /** Can resolve a playable stream URL for one of its tracks. */
  stream: boolean
  /** Can provide lyrics for a track. */
  lyrics: boolean
  /** Can list playlists / collections. */
  playlists: boolean
  /** Can return the tracks of a playlist. */
  playlistDetail: boolean
  albums: boolean
  artists: boolean
  /** Can suggest tracks (charts, genres, moods). */
  recommendations: boolean
  /** Is a live radio directory (no duration, no seeking). */
  radio: boolean
  /** May offer downloads, limited by per-track licence. */
  download: boolean
  /**
   * Can identify a song from recorded audio ("listen and identify"). Declared by the source and
   * surfaced in the UI as an entry, never assumed: Aurora ships no recognition backend of its own.
   */
  recognize: boolean
}

/* ------------------------------------------------------------------ library administration */

/** What one local track gained from an automatic metadata pass. */

export interface ScrapeTrackOutcome {
  id: string
  /** Title as it read before the pass (so the UI can show what changed). */
  title: string
  artist: string
  /** True when a platform result was accepted as this track's match. */
  matched: boolean
  /** Where the match came from, and what it claimed to be. */
  match?: { platformId: string; platformName: string; title: string; artist: string; album: string }
  filledTitle: boolean
  filledArtist: boolean
  filledAlbum: boolean
  filledCover: boolean
  filledLyrics: boolean
  error?: string
}

export interface ScrapeReport {
  scanned: number
  matched: number
  covers: number
  lyrics: number
  outcomes: ScrapeTrackOutcome[]
}

export interface ScrapeRequest {
  /** Explicit track ids; omit to scan every local track that is still missing something. */
  ids?: string[]
  /** Fetch missing cover art (default true). */
  cover?: boolean
  /** Fetch missing lyrics (default true). */
  lyrics?: boolean
}

export interface ScrapeProgress {
  processed: number
  total: number
  matched: number
}

/** User edits for a local file's ID3 tags. Only MP3 files can be rewritten. */
export interface TrackTagPatch {
  id: string
  title?: string
  artist?: string
  album?: string
}

export interface TagWriteResult {
  ok: boolean
  error?: string
  /** The library entry after the write, when it succeeded. */
  track?: AudioTrack
}

export type ConvertFormat = 'mp3' | 'flac' | 'wav' | 'm4a' | 'ogg'

export interface ConvertResult {
  ok: boolean
  /** Newly produced file, when the conversion succeeded. */
  filePath?: string
  /** Library entry for the converted file (it is imported straight away). */
  track?: AudioTrack
  error?: string
  /** Set when the failure is simply "no encoder on this machine". */
  ffmpegMissing?: boolean
}

export interface FfmpegStatus {
  available: boolean
  path?: string
  version?: string
  source: 'env' | 'path' | 'none'
}

export type SourceStatus = 'disabled' | 'initializing' | 'ready' | 'error' | 'needs-config'

/**
 * How a source is hosted. Only user-installable kinds remain here; platforms are not sources.
 * The UI and registry switch on this instead of `builtin: boolean`, so a new kind never means a
 * new branch in every component.
 */
export type SourceKind = 'declarative' | 'script'

/**
 * What a source is allowed to do. Only `network` exists for declarative sources today; script
 * sources can ask for the (still non-privileged) compute/logging helpers.
 */
export type SourcePermission = 'network' | 'crypto' | 'storage'

/** Open-ended on purpose: a source declares what it actually offers (e.g. `128k`, `320k`, `flac`). */
export type PlaybackQuality = string

/**
 * A platform a source can serve (e.g. a catalogue id). Platforms are *declared by the source*, never
 * hardcoded in Aurora: the UI renders whatever a source announces and nothing else.
 */
export interface SourcePlatform {
  id: string
  name: string
  icon?: string
  /** Platform-level capability overrides; absent means "same as the source". */
  capabilities?: Partial<SourceCapabilities>
  qualities?: PlaybackQuality[]
}

/** Ring-buffered diagnostics for one source, surfaced in the source manager. */
export interface SourceErrorLogEntry {
  at: number
  code: SourceErrorCode
  message: string
  /** Which operation failed (`search` / `resolve` / `healthCheck` / `initialize` / `load`). */
  operation: string
}

/** One outbound request as seen by the bridge (host-rejected attempts included, with status 0). */
export interface SourceRequestLogEntry {
  at: number
  sourceId: string
  /** Sensitive query parameters are masked before they get here (see `redactUrl`). */
  url: string
  method?: string
  status: number
  durationMs: number
  /** Headers that were sent, with credentials masked. Omitted for requests that sent none. */
  headers?: Record<string, string>
}

export interface SourceHealth {
  ok: boolean
  /** Round-trip time of the health probe, in milliseconds. */
  latency?: number
  message?: string
  checkedAt: number
}

/* ------------------------------------------------------------------ source config */

export type SourceConfigValue = string | number | boolean

export type SourceConfigFieldType = 'text' | 'password' | 'url' | 'number' | 'boolean'

export interface SourceConfigField {
  key: string
  label: string
  type: SourceConfigFieldType
  required?: boolean
  placeholder?: string
  description?: string
  /** Secrets are encrypted with Electron `safeStorage` and never written to localStorage. */
  secret?: boolean
  default?: SourceConfigValue
  min?: number
  max?: number
}

export interface SourceConfigSchema {
  fields: SourceConfigField[]
}

/** A host a running source was refused, plus the URL that triggered the refusal. */
export interface SourcePendingHost {
  sourceId: string
  host: string
  url: string
  at: number
  attempts: number
  missingPermission?: SourcePermission
}

/**
 * One step of a source self-check.
 *
 * The steps are named and individually timed because "这个音源能不能用" is never one question: it is
 * installed / registered / enabled / configured / can search / can resolve a stream / has every host
 * it asked for. Reporting them separately is what lets the page offer the *right* fix instead of a
 * generic failure — a refusal is repairable, a missing config is not.
 */
export interface SourceSelfCheckStep {
  /** Stable key, so the UI can order or group steps without parsing labels. */
  key: 'installed' | 'registered' | 'enabled' | 'configured' | 'search' | 'stream' | 'hosts'
  label: string
  ok: boolean
  /**
   * The step could not be exercised *for this run* (e.g. no track to resolve because the probe
   * keyword returned nothing). It is not a failure — and it is not a pass either, which is why it is
   * its own state rather than an `ok: true` that would quietly claim the step worked.
   */
  skipped?: boolean
  /** Error code when the step failed, so the UI can match a fix to the reason. */
  code?: SourceErrorCode
  message: string
  ms: number
}

/** The result of a self-check, including what it repaired on the way. */
export interface SourceSelfCheckResult {
  id: string
  name: string
  ok: boolean
  at: number
  /** Keyword the search step used, so a zero-result search is distinguishable from a broken one. */
  keyword: string
  steps: SourceSelfCheckStep[]
  /** Hosts this check granted (only ever non-empty when the caller asked to repair). */
  repaired: string[]
  /**
   * Why the requested repair did **not** happen, when it was refused rather than unnecessary.
   *
   * 安全模式 refuses automatic grants, and an empty `repaired` list cannot say that on its own: "nothing
   * needed repairing" and "I am not allowed to repair" would look identical, and the second one is the
   * case where the user has to grant the host by hand. Reported so the page can say which it was.
   */
  repairBlocked?: string
  /** Hosts still waiting for approval after the check. */
  pendingHosts: string[]
  /** Recent error history, newest first: the "why" behind a failing step. */
  errors: SourceErrorLogEntry[]
}

/**
 * What a batch self-check concluded about one source, in the words a user would use.
 *
 * The single-source report already carries the detail; this is the *category*, and it exists because
 * "换了台机器/换了张网，谁还能用" is answered by a list of categories, not by eight full step reports.
 * The set is deliberately small and each member has a different next move: grant a host, wait and retry,
 * change the keyword, fill in the config, or nothing at all.
 */
export type SourceCheckVerdict =
  /** Search and resolve both worked. */
  | 'ok'
  /** A host it needs is not granted (the actionable one: a button fixes it). */
  | 'unauthorized'
  /** No answer inside the timeout: usually the network, not the source. */
  | 'timeout'
  /** Answered, but with nothing for this keyword — the source is fine. */
  | 'empty'
  /** Needs configuration the user has not filled in yet. */
  | 'unconfigured'
  /** Enabled in settings but not loaded/registered in the runtime. */
  | 'inactive'
  /** Anything else, with the real error code kept alongside. */
  | 'error'

/** One row of a batch self-check. */
export interface SourceCheckSummary {
  id: string
  name: string
  /** Where this source came from, so two entries with the same name stay distinguishable. */
  kind: 'script' | 'declarative' | 'builtin'
  verdict: SourceCheckVerdict
  /** One sentence: what happened, in the same wording the detail page uses. */
  detail: string
  /** The step that decided the verdict, for "look here" in the UI. */
  step?: SourceSelfCheckStep['key']
  /** Error code when there is one — kept so the row can be matched to a fix. */
  code?: SourceErrorCode
  /** Hosts still waiting for approval, so the row can offer 「允许」 without a second round trip. */
  pendingHosts: string[]
  /** Hosts this run granted (only when the caller asked to repair). */
  repaired: string[]
  ms: number
}

/**
 * The result of checking **every enabled source** in one run.
 *
 * `skipped` is not a failure: a source the user turned off is not a source that is broken, and counting
 * it as either would make the summary lie about the machine.
 */
export interface SourceCheckAllResult {
  at: number
  keyword: string
  /** Enabled sources that were actually exercised. */
  checked: number
  /** Enabled-in-theory sources the runtime had nothing for (nothing to check). */
  skipped: number
  /** Per-verdict tallies, so the header can show them without scanning the rows. */
  counts: Record<SourceCheckVerdict, number>
  /** One sentence a toast can show, e.g. "4 个可用 · 1 个待授权 · 1 个超时". */
  headline: string
  sources: SourceCheckSummary[]
}

export interface SourceDescriptor {
  id: string
  name: string
  version: string
  /** Plugin API version the source targets; the settings page shows it and the loader checks it. */
  apiVersion: string
  author?: string
  icon?: string
  description: string
  homepage: string
  license: string
  capabilities: SourceCapabilities
  requiresConfig: boolean
  configured: boolean
  enabled: boolean
  status: SourceStatus
  /** Position in the user's source list; affects source ordering only. */
  order: number
  /** Deprecated: platforms are no longer a kind of source. Always false now. */
  builtin: false
  configSchema: SourceConfigSchema
  /** Non-secret configuration values, so the settings page can render a form. */
  config: Record<string, SourceConfigValue>
  /** Secret fields that already hold a value (`key -> true`); values are never sent to the UI. */
  secretKeys: Record<string, boolean>
  /** True when a stored secret for this source is kept unencrypted (this machine has no OS keychain). */
  secretsPlain?: boolean
  health?: SourceHealth
  /** How the source is hosted (`builtin` / `declarative` / `script`). */
  kind: SourceKind
  /** Script runtime contract, e.g. `aurora` or the LX Music compatibility shim. */
  runtime?: string
  /** Declared permissions, shown verbatim in the source manager. */
  permissions: SourcePermission[]
  /** Platforms the source serves; empty means "not a multi-platform source". */
  platforms: SourcePlatform[]
  /** Qualities the source can resolve, advertised to the player. */
  qualities: PlaybackQuality[]
  /**
   * Declared capabilities that no implementation backs. The registry reports them instead of
   * letting the UI promise a button that always fails.
   */
  capabilityGaps: string[]
  /** Most recent failures for this source (newest first, bounded). */
  errorLog: SourceErrorLogEntry[]
  /**
   * Hosts this source asked for but has not been granted yet. The runtime keeps `enabled` sources
   * working, so a refusal is a grant prompt rather than a failure.
   */
  pendingHosts: string[]
  /**
   * Hosts this source may reach. Shown (and revocable) in the source's own page — an automatic grant
   * is only acceptable if it is visible and undoable.
   */
  allowedHosts: string[]
}

/* ------------------------------------------------------------------ music data layer */

/**
 * Aurora's canonical track. `sourceId` is mandatory for online tracks so every row can be traced
 * back to the plugin that produced it.
 */
export interface AudioTrack {
  id: string
  origin: TrackOrigin
  title: string
  artist: string
  album: string
  duration: number
  format: string
  /**
   * Qualities this particular track is available in, when the producer knows (platform search
   * results carry them per song). Absent means "not advertised", never "none available".
   */
  qualities?: PlaybackQuality[]
  /** Local tracks: technical facts read from the file, used for lossless / hi-res grouping. */
  bitrate?: number
  sampleRate?: number
  bitsPerSample?: number
  /**
   * Player-ready URL. Local tracks point at `aurora-media://audio/...`; online tracks are
   * resolved through the main process right before playback because stream URLs expire.
   */
  fileUrl: string
  cover?: string
  addedAt: number
  /** Local tracks only. */
  filePath?: string
  /** Online tracks only. */
  sourceId?: SourceId
  /** Platform declared by the source that produced this track (absent for single-platform sources). */
  platform?: string
  sourceTrackId?: string
  license?: string
  homepage?: string
  year?: number
  /**
   * Raw per-source payload kept for playback resolution (e.g. a platform-specific id/hash pair a
   * script source needs when it resolves a stream). Never rendered directly.
   */
  metadata?: Record<string, unknown>
}

/** Alias kept for readability in the source/data layer — Aurora's `Song` *is* `AudioTrack`. */
export type Song = AudioTrack

export interface SourcePlaylist {
  id: string
  sourceId: SourceId
  title: string
  description?: string
  cover?: string
  creator?: string
  trackCount?: number
  playCount?: number
  favoriteCount?: number
  tags?: string[]
  homepage?: string
}

export interface SourcePlaylistDetail {
  playlist: SourcePlaylist
  tracks: AudioTrack[]
}

export interface SearchOptions {
  page?: number
  pageSize?: number
  type?: 'track' | 'album' | 'artist' | 'playlist'
  /** Optional genre/mood tag forwarded to source search (e.g. `jazz`, `lo-fi`). */
  tag?: string
}

export interface ResolvedStream {
  /** Opaque `aurora-media://remote/...` URL that the renderer can play directly. */
  url: string
  /** Quality this URL actually corresponds to, when the source can tell. */
  quality?: PlaybackQuality
  license?: string
  homepage?: string
  downloadAllowed: boolean
  /** Live radio has no known duration and cannot be seeked. */
  live: boolean
}

/* ------------------------------------------------------------------ errors */

export type SourceErrorCode =
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'UNAUTHORIZED'
  | 'RATE_LIMITED'
  | 'NOT_FOUND'
  | 'INVALID_RESPONSE'
  | 'UNSUPPORTED'
  | 'NEEDS_CONFIG'
  /** The runtime refused a request (missing permission or ungranted host) — never an install veto. */
  | 'PERMISSION'
  | 'UNKNOWN'

/** Machine-readable error, safe to send to the renderer (no stack traces, no internals). */
export interface SourceErrorInfo {
  code: SourceErrorCode
  message: string
}

export interface SourceSearchOutcome {
  sourceId: SourceId
  sourceName: string
  ok: boolean
  tracks: AudioTrack[]
  error?: SourceErrorInfo
  latencyMs?: number
}

/* ------------------------------------------------------------------ settings */

export interface AuroraSettings {
  /** Per-source configuration (secrets excluded — those live in encrypted storage). */
  sourceConfig: Record<string, Record<string, SourceConfigValue>>
  /** `sourceId -> enabled`; absent means enabled by default. */
  enabledSources: Record<string, boolean>
  /** User-defined source order; ids missing here keep registration order. */
  sourceOrder: string[]
  /**
   * Legacy preference forwarded to sources as `context.allowDownloads` (kept so an older
   * `settings.json` round-trips and sources that read it keep working). The download manager itself
   * never gates on it — see `DownloadSettings` for the knobs that do matter.
   */
  allowOpenLicenseDownloads: boolean
  /** Periodic background health probe for enabled sources (default on). */
  autoHealthCheck: boolean
  /**
   * Whether a host a source asks for at play time is granted automatically and the request retried.
   *
   * On by default, because "I installed the source, so it should work" is what a music player owes
   * its user: hosts composed at runtime cannot be known at install time, and a first play that
   * dead-ends into an error message is a broken feature, not a security posture.
   *
   * The trade is deliberate and visible: an automatic grant is durable, appears in the source's
   * allowed-host list, and is revocable there, and turning this off restores the strict "refuse and
   * ask" behaviour. Nothing here lets a *script* widen its own list — the grant is made by the main
   * process, in response to a track the user asked to play.
   */
  autoGrantSourceHosts: boolean
  /**
   * 安全模式：平台访问的严格模式。
   *
   * Two enforced rules, both in the request path rather than in the UI: an un-granted host is never
   * granted automatically (regardless of `autoGrantSourceHosts`), and a cleartext `http:` **API** request
   * is refused. Audio bytes are out of scope on purpose — they are relayed against the same host
   * allowlist and never parsed, and most aggregators publish `http://` CDs, so refusing those would
   * break playback without raising the bar.
   */
  safeMode: boolean
  /**
   * Appearance, mirrored here so the native window chrome can match it at startup.
   *
   * The renderer owns the visual theme through `data-theme`; main owns the title-bar overlay and the
   * native control colour scheme, which CSS cannot reach. Both read this value, so switching themes
   * never leaves half the window on the other one.
   */
  theme: ThemeMode
  /**
   * The playback-quality preference: which of the four tiers to ask a source for.
   *
   * Kept in main so the *download* manager and a resolve started before the renderer has painted both agree
   * on it — a preference that only lived in `localStorage` would be invisible to the process doing the work.
   */
  preferredQuality: QualityTierId
  /**
   * The chosen skin (`aurora`, `star-dream`, or a user theme's id).
   *
   * Stored here as well as in `localStorage` because the native title strip is painted before the page
   * loads: main has to know which colour that strip should be on the very first frame, and only this
   * file is readable at that point.
   */
  skin: string
  /** The separate always-on-top lyrics window (LX-style desktop lyrics). */
  desktopLyrics: DesktopLyricsSettings
  /** Download manager: target directory, file naming and concurrency. */
  downloads: DownloadSettings
  /** 系统集成：托盘、任务栏按钮、全局媒体键。 */
  systemIntegration: SystemIntegrationSettings
  /**
   * 声音：均衡器、音量均衡、输出设备、无缝播放与淡入淡出。
   *
   * Kept in main for the same reason as `preferredQuality`: these are properties of *the player*, not of
   * one window, and the sanitizer is where a hand-edited file gets clamped back into range.
   */
  sound: SoundSettings
  /**
   * 歌词偏移（毫秒，±1000，100 ms 一档）：歌词显示时间 = 播放位置 + 该值。
   *
   * Kept in main, not in `localStorage`, because two windows need it and they do not share storage: the app
   * window's lyrics page reads it directly, and the separate desktop-lyrics window gets it on its clock tick.
   * One value, one home.
   */
  lyricsOffsetMs: number
  /** Where to ask about new versions, and whether to ask on launch. */
  updateCheck: UpdateCheckSettings
  /** The optional loopback-only read API (off unless the user turns it on). */
  httpApi: HttpApiSettings
}

/**
 * How far Aurora reaches into the operating system.
 *
 * A desktop music player is expected to be drivable while another window has focus — that is the
 * whole point of a tray icon and media keys. All three are individually switchable, because they are
 * the parts of a player most likely to be unwelcome (a tray icon someone did not ask for, or media
 * keys stolen from another player).
 */
export interface SystemIntegrationSettings {
  /** Tray icon + menu (play/pause, prev/next, show/hide, desktop lyrics, quit). */
  tray: boolean
  /** Windows taskbar thumbnail buttons on the app icon. Ignored on other platforms. */
  taskbarButtons: boolean
  /** Global play/pause + next/previous media keys. */
  mediaKeys: boolean
  /** Reflect the current track in the tray tooltip and menu. */
  showTrackInTray: boolean
  /** Start Aurora when the user signs in. Registered with the OS, not merely remembered. */
  launchAtLogin: boolean
  /** Closing the window hides to the tray instead of quitting. */
  closeToTray: boolean
}

export const DEFAULT_SYSTEM_INTEGRATION: SystemIntegrationSettings = {
  tray: true,
  taskbarButtons: true,
  mediaKeys: true,
  showTrackInTray: true,
  launchAtLogin: false,
  closeToTray: false,
}

/**
 * Every field of `SystemIntegrationSettings`, derived from the defaults instead of typed out again.
 *
 * The sanitizer in `main/settings.ts` and the IPC setter in `main/ipc.ts` each used to carry their own copy
 * of this list. Two hand-maintained copies of one whitelist means a new switch can be silently dropped by
 * whichever copy was forgotten — the value would look saved in the UI and never reach the file. Derived from
 * the object literal there is nothing to forget: add a field to the interface *and* the defaults, and both
 * sides accept it.
 *
 * The assertion below is what keeps the derivation honest. If a future field is not a boolean, the type
 * collapses to `never`, `true` stops being assignable, and the build fails here — instead of the sanitizer
 * quietly ignoring the field because it failed its `typeof === 'boolean'` test.
 */
export const SYSTEM_INTEGRATION_KEYS = Object.keys(
  DEFAULT_SYSTEM_INTEGRATION,
) as (keyof SystemIntegrationSettings)[]

const SYSTEM_INTEGRATION_IS_BOOLEAN_ONLY: SystemIntegrationSettings[keyof SystemIntegrationSettings] extends boolean
  ? true
  : never = true
void SYSTEM_INTEGRATION_IS_BOOLEAN_ONLY

/**
 * What the operating system actually accepted — reported separately from the settings on purpose.
 *
 * A tray icon can fail to appear (a session with no status-notifier host) and a media key can already
 * belong to another application. The UI shows this, so those cases read as "not active" instead of as
 * a switch that is on but does nothing.
 */
export interface SystemIntegrationStatus {
  /** Whether the OS really has Aurora registered as a login item. */
  launchAtLogin: boolean
  trayActive: boolean
  /** What the tray tooltip currently says (empty when no tray). */
  trayTooltip: string
  /** Accelerators that were really claimed, e.g. `MediaPlayPause`. */
  mediaKeys: string[]
  taskbarButtons: boolean
  platform: string
}

/**
 * A settings patch: every scalar block is optional, and the blocks the UI edits field-by-field
 * (desktop lyrics, downloads) may be sent partially — the main process clamps the rest.
 */
export type AuroraSettingsPatch = Partial<
  Omit<AuroraSettings, 'desktopLyrics' | 'downloads' | 'systemIntegration' | 'sound' | 'updateCheck' | 'httpApi'>
> & {
  desktopLyrics?: Partial<DesktopLyricsSettings>
  downloads?: Partial<DownloadSettings>
  systemIntegration?: Partial<SystemIntegrationSettings>
  updateCheck?: Partial<UpdateCheckSettings>
  httpApi?: Partial<HttpApiSettings>
  /** Field-by-field partials are allowed here too: the EQ block is edited band by band. */
  sound?: Partial<SoundSettings> & { equalizer?: Partial<import('./sound').EqualizerSettings>; loudness?: Partial<import('./sound').LoudnessSettings> }
}

/* ------------------------------------------------------------------ downloads */

export type DownloadStatus = 'queued' | 'downloading' | 'paused' | 'completed' | 'failed' | 'canceled'

/**
 * One download. This is the whole truth about a task's state, and every field is main-process owned:
 * the renderer renders it and asks for transitions, it never computes progress itself.
 *
 * `received` is what is really on disk (a resumed task starts above 0), so a paused or crashed
 * download keeps its bytes instead of restarting from scratch.
 */
export interface DownloadTask {
  id: string
  /** Track identity, so the UI can match a row against a task. */
  trackId: string
  sourceId?: string
  title: string
  artist: string
  album: string
  cover?: string
  /** Quality the user asked for, when the UI offered a choice. */
  requestedQuality?: PlaybackQuality
  /** Quality the source actually handed back. */
  quality?: PlaybackQuality
  status: DownloadStatus
  /** Bytes on disk (`.part` file included) — never a number the renderer guessed. */
  received: number
  /** Total size from the server, or 0 when it does not report one. */
  total: number
  /** Bytes per second, sampled over the last second. */
  speed: number
  /** Seconds remaining, or 0 when it cannot be estimated. */
  eta: number
  /** Absolute path of the finished file (empty until the task knows its name). */
  filePath: string
  fileName: string
  error?: string
  createdAt: number
  updatedAt: number
  /** Automatic retries already attempted for this task. */
  attempts: number
  /** True once title/artist/album/cover were written into the file's tags. */
  tagged?: boolean
}

/** Where downloads go and how they are named. */
export interface DownloadSettings {
  /** Absolute directory; empty means `<userData>/downloads`. */
  directory: string
  /** `歌手 - 歌名` / `歌名 - 歌手` / `歌名`. */
  nameTemplate: 'artist-title' | 'title-artist' | 'title'
  /** Simultaneous downloads; the rest stay queued. */
  concurrency: number
  /** Embed title/artist/album/cover into downloaded files (MP3). */
  writeTags: boolean
}

/** One source of truth for the download defaults (main validates against it, UI starts from it). */
export const DEFAULT_DOWNLOAD_SETTINGS: DownloadSettings = {
  directory: '',
  nameTemplate: 'artist-title',
  concurrency: 2,
  writeTags: true,
}

/** What the renderer hands over to start a download: the track, nothing else. */
export interface DownloadStartInput {
  track: AudioTrack
  quality?: PlaybackQuality
}

/* ------------------------------------------------------------------ ipc payloads */

export interface LibraryImportResult {
  added: AudioTrack[]
  duplicated: number
  failed: number
  /**
   * Files that were never music (a dropped `.txt`, a stray shortcut).
   *
   * Counted apart from `failed`: a file that is not audio did not fail to import, it was never a
   * candidate, and telling the user "导入失败" for it sends them looking for a problem that is not there.
   */
  unsupported?: number
}

export interface ImportProgress {
  scanning: boolean
  processed: number
  total: number
}

export interface ReportedPlayerState {
  isPlaying: boolean
  title: string
  artist: string
  /** Present on every report; the desktop-lyrics window follows this clock. */
  currentTime: number
  duration: number
  /** Identity of the playing track, so the lyrics window knows when to swap lyrics. */
  trackId: string
  /**
   * The full track, trimmed for IPC — the lyrics lookup needs source data, not a bare id.
   *
   * **Optional on purpose**: the renderer reports the clock several times a second and only attaches this
   * payload when the song actually changes. Absent means "nothing new" (main keeps the track it already
   * has); `null` still means "no track at all".
   */
  track?: AudioTrack | null
}

/* ------------------------------------------------------------------ desktop lyrics */

/**
 * Positioning and appearance of the separate always-on-top lyrics window.
 *
 * Persisted in main-process settings so the window comes back exactly where the user left it —
 * a desktop lyric that jumps to the screen centre on every launch is worse than none.
 */
export interface DesktopLyricsSettings {
  enabled: boolean
  /** Locked windows stay where they are and let every click pass through to what is underneath. */
  locked: boolean
  alwaysOnTop: boolean
  /** Current line size in px. */
  fontSize: number
  /** Empty means the app font stack. */
  fontFamily: string
  /** Active line colour, `#rrggbb`. */
  color: string
  /** Inactive (already sung / upcoming) line colour, `#rrggbb`. */
  inactiveColor: string
  /** 0.2 – 1: how opaque the backing plate is behind the text. */
  background: number
  showTranslation: boolean
  showNextLine: boolean
  x: number
  y: number
  width: number
  height: number
}

/**
 * One source of truth for the desktop-lyrics defaults: the main process validates against them, the
 * renderer falls back to them without a bridge, and the settings UI starts from them.
 */
export const DEFAULT_DESKTOP_LYRICS: DesktopLyricsSettings = {
  enabled: false,
  locked: false,
  alwaysOnTop: true,
  fontSize: 34,
  fontFamily: '',
  color: '#8fd0ff',
  inactiveColor: '#e8edf5',
  background: 0.32,
  showTranslation: true,
  showNextLine: true,
  x: -1,
  y: -1,
  width: 900,
  height: 150,
}

/** Pushed when the playing track changes: everything the lyric window needs to render lines. */
export interface DesktopLyricsTrack {
  trackId: string
  title: string
  artist: string
  album: string
  duration: number
  hasLyrics: boolean
  lines: import('./lyrics').LyricLine[]
}

/** Pushed on the playback clock (throttled in the main process). */
export interface DesktopLyricsTick {
  currentTime: number
  isPlaying: boolean
  duration: number
  /**
   * The lyric offset in force, so the strip applies the same correction the app window does.
   *
   * Sent with the clock rather than folded into `currentTime`: the strip also draws a progress bar, and a
   * progress bar that reports a shifted position is a different (and wrong) claim from a lyric that is
   * deliberately early.
   */
  offsetMs: number
}

/** Actions the desktop-lyrics window can ask the app window to perform. */
export type PlayerCommand = 'toggle-play' | 'next' | 'previous'

/** Everything the desktop-lyrics window is allowed to do — nothing else crosses this boundary. */
export interface DesktopLyricsBridge {
  /** "I am ready": main answers with the current track + options immediately. */
  ready: () => Promise<void>
  onTrack: (listener: (track: DesktopLyricsTrack) => void) => () => void
  onTick: (listener: (tick: DesktopLyricsTick) => void) => () => void
  onOptions: (listener: (options: DesktopLyricsSettings) => void) => () => void
  /** Quick controls from the window itself (font size, lock, translation, close). */
  setOptions: (patch: Partial<DesktopLyricsSettings>) => Promise<DesktopLyricsSettings>
  /** Play/pause/next/previous — forwarded to the app window, which owns the audio element. */
  control: (command: PlayerCommand) => void
  hide: () => void
}

export interface AppInfo {
  name: string
  version: string
  electron: string
  platform: string
  arch: string
  dataPath: string
}

/** Platforms: identity + search only, never installable. Resolver counts are derived from enabled Sources. */
export interface PlatformApi {
  list: () => Promise<PlatformDescriptor[]>
  searchAll: (query: string, options?: SearchOptions) => Promise<PlatformSearchOutcome[]>
  searchOne: (platformId: PlatformId, query: string, options?: SearchOptions) => Promise<PlatformSearchOutcome>
  health: (platformId: PlatformId) => Promise<PlatformHealthSummary>
  healthAll: () => Promise<PlatformHealthSummary[]>
  resolve: (track: AudioTrack, quality?: PlaybackQuality) => Promise<ResolvedStream | null>
  lyrics: (track: AudioTrack) => Promise<import('./lyrics').Lyrics | null>
  /** Charts every platform publishes; empty when no board endpoint answers. */
  boards: () => Promise<BoardDescriptor[]>
  boardSongs: (platformId: PlatformId, boardId: string, limit?: number) => Promise<BoardOutcome>
}

export interface AuroraApi {
  library: {
    list: () => Promise<AudioTrack[]>
    missing: () => Promise<string[]>
    addFiles: () => Promise<LibraryImportResult>
    addFolder: () => Promise<LibraryImportResult>
    /**
     * Imports an explicit list of paths — files and folders mixed, which is what a drop hands over.
     *
     * Separate from `addFiles` / `addFolder` because those two open a native dialog: a drop already knows
     * what it is holding, and routing it through a picker would ask the user to say it twice.
     */
    addPaths: (paths: string[]) => Promise<LibraryImportResult>
    /**
     * Turns dropped `File` objects into real paths.
     *
     * Chromium's `File.path` is gone (Electron 32+), so the only supported way to learn where a dropped file
     * lives is `webUtils.getPathForFile` — which only exists in the preload. Optional in the type so the
     * renderer has to cope with its absence instead of assuming it.
     */
    pathsForFiles?: (files: File[]) => string[]
    remove: (id: string) => Promise<boolean>
    reveal: (id: string) => Promise<boolean>
    onImportProgress: (listener: (progress: ImportProgress) => void) => () => void
    /** "自动补齐信息": fills missing cover/lyrics from the platform layer. */
    scrape: (request: ScrapeRequest) => Promise<ScrapeReport>
    /** Rewrites an MP3's ID3 tags with the user's edits. */
    setTags: (patch: TrackTagPatch) => Promise<TagWriteResult>
    /** Transcodes a local file (needs ffmpeg on this machine). */
    convert: (id: string, format: ConvertFormat) => Promise<ConvertResult>
    ffmpegStatus: (force?: boolean) => Promise<FfmpegStatus>
    onScrapeProgress: (listener: (progress: ScrapeProgress) => void) => () => void
    /** Fires when the library changed outside an import (download sync, scrape, conversion). */
    onChanged: (listener: (tracks: AudioTrack[]) => void) => () => void
  }
  platforms: PlatformApi
  sources: {
    list: () => Promise<SourceDescriptor[]>
    /** Aggregated search across every enabled source, isolated with `Promise.allSettled`. */
    searchAll: (query: string, options?: SearchOptions) => Promise<SourceSearchOutcome[]>
    searchOne: (sourceId: SourceId, query: string, options?: SearchOptions) => Promise<SourceSearchOutcome>
    recommendations: (sourceId: SourceId, options?: SearchOptions) => Promise<SourceSearchOutcome>
    playlists: (sourceId?: SourceId) => Promise<SourcePlaylist[]>
    playlistDetail: (sourceId: SourceId, playlistId: string) => Promise<SourcePlaylistDetail | null>
    /**
     * Resolves a playable URL. Pass a track id for simple sources, or the whole track when the
     * source needs its `metadata` (script sources resolving platform-specific ids).
     */
    resolve: (sourceId: SourceId, track: AudioTrack | string, quality?: PlaybackQuality) => Promise<ResolvedStream | null>
    /** Recent outbound requests, for the source manager's diagnostics panel. */
    requests: (sourceId?: SourceId) => Promise<SourceRequestLogEntry[]>
    setEnabled: (sourceId: SourceId, enabled: boolean) => Promise<SourceDescriptor[]>
    setConfig: (sourceId: SourceId, patch: Record<string, SourceConfigValue>) => Promise<SourceDescriptor[]>
    setOrder: (order: SourceId[]) => Promise<SourceDescriptor[]>
    health: (sourceId: SourceId) => Promise<SourceHealth>
    /**
     * Hosts the runtime refused for being ungranted. Refusing is a *runtime* decision: the source
     * stays installed and enabled, and each entry here can be granted with one click.
     */
    pendingHosts: (sourceId?: SourceId) => Promise<SourcePendingHost[]>
    /** Grants hosts durably and hot-reloads the source; no restart and no reinstall. */
    grantHosts: (sourceId: SourceId, hosts: string[]) => Promise<SourceDescriptor[]>
    /** Takes grants back. The pair matters because automatic grants must be undoable by hand. */
    revokeHosts: (sourceId: SourceId, hosts: string[]) => Promise<SourceDescriptor[]>
    /**
     * Runs the source through its real operations (search, resolve) and reports each step separately.
     * `repair: true` grants refused hosts and retries the steps that failed because of them.
     */
    selfCheck: (
      sourceId: SourceId,
      options?: { repair?: boolean; keyword?: string },
    ) => Promise<SourceSelfCheckResult | null>
    /**
     * The same check, run over **every enabled source** and summarised as categories.
     *
     * Its reason to exist is the morning after a machine or network change: "which of my sources still
     * work, and which need me?" — one list, each row with a verdict and the next move.
     */
    selfCheckAll: (options?: {
      keyword?: string
      repair?: boolean
    }) => Promise<SourceCheckAllResult>
    /** This source's own error history, newest first. */
    errors: (sourceId: SourceId) => Promise<SourceErrorLogEntry[]>
  }
  lyrics: {
    /** Fast half: local files, the fetch cache and the track's own source. No catalogue request. */
    get: (track: AudioTrack) => Promise<import('./lyrics').Lyrics | null>
    /** Slow half: searches the public catalogues and caches a hit (background enrichment). */
    search: (track: AudioTrack) => Promise<import('./lyrics').LyricsResolution | null>
    /** 「联网自动匹配」: the whole chain, and a report of what every provider did. */
    match: (track: AudioTrack) => Promise<import('./lyrics').LyricsResolution | null>
    save: (track: AudioTrack, raw: string) => Promise<import('./lyrics').Lyrics | null>
    /** Clears the stored import *and* the fetched cache entry for a track. */
    clear: (track: AudioTrack) => Promise<boolean>
  }
  /** Declarative user-defined sources (JSON API manifests — no user code is ever executed). */
  customSources: {
    list: () => Promise<import('./customSource').CustomSourceManifest[]>
    /** Built-in starting points offered by the editor. */
    templates: () => Promise<import('./customSource').CustomSourceTemplate[]>
    /** Parse + validate without saving, so the UI can show every problem at once. */
    validate: (raw: string) => Promise<import('./customSource').ManifestValidationResult>
    save: (raw: string) => Promise<import('./customSource').CustomSourceSaveResult>
    remove: (id: string) => Promise<import('./customSource').CustomSourceSaveResult>
    export: (id: string) => Promise<string | null>
  }
  /**
   * JavaScript sources. Aurora stores and runs user code in a sandboxed host; the import flow is
   * two-phase (probe → confirm) because the *declaration* is what the user reviews, not the code.
   */
  scriptSources: {
    list: () => Promise<import('./scriptSource').ScriptSourceRecord[]>
    /** Runs the script with no permissions and reports what it declares. Nothing is written. */
    probe: (options: import('./scriptSource').ScriptProbeOptions) => Promise<import('./scriptSource').ScriptProbeResult>
    /** Persists the reviewed script + confirmed manifest and registers it immediately. */
    save: (options: { sourceText: string; manifest: unknown }) => Promise<import('./scriptSource').ScriptSourceSaveResult>
    remove: (id: string) => Promise<import('./scriptSource').ScriptSourceSaveResult>
    reload: (id: string) => Promise<import('./scriptSource').ScriptSourceSaveResult>
    /** The stored script text, for editing or exporting. */
    export: (id: string) => Promise<string | null>
    inspect: (id: string) => Promise<{ ok: boolean; message: string }>
    /**
     * 洛雪音源库（`user_api.json`）。
     *
     * The dialog and the file read both happen in the main process: the renderer receives a summary
     * per source and nothing else, and the import names ids. That is why no `text` crosses this
     * boundary — the bytes written are the bytes main read from disk.
     */
    lxLibraryOpen: () => Promise<import('./scriptSource').LxLibraryPreview>
    lxLibraryImport: (ids: string[]) => Promise<import('./scriptSource').LxLibraryImportResult>
    lxLibraryCancel: () => Promise<boolean>
  }
  /**
   * 系统集成：托盘 / 任务栏按钮 / 全局媒体键。
   *
   * `status` answers what the OS *actually* registered, so the settings page can show an honest
   * state instead of echoing the switch back at the user.
   */
  systemIntegration: {
    get: () => Promise<SystemIntegrationSettings>
    set: (patch: Partial<SystemIntegrationSettings>) => Promise<SystemIntegrationSettings>
    status: () => Promise<SystemIntegrationStatus>
  }
  /** The Source Detector: pick a `.js` / `.json` file and get back what Aurora recognised. */
  sourceImport: {
    fromFile: () => Promise<import('./sourceImport').SourceImportResult>
    /** Runs the same detection on text the user pasted into the UI. */
    fromText: (text: string, fileName?: string) => Promise<import('./sourceImport').SourceImportResult>
  }
  settings: {
    get: () => Promise<AuroraSettings>
    set: (patch: AuroraSettingsPatch) => Promise<AuroraSettings>
  }
  player: {
    report: (state: ReportedPlayerState) => Promise<void>
    /** Play/pause, next or previous — asked for by the desktop lyrics window or media keys. */
    onCommand: (listener: (command: PlayerCommand) => void) => () => void
  }
  /** Desktop-lyrics window control, exposed to the app window (toggle, options, position reset). */
  desktopLyrics: {
    /** Shows or hides the separate lyrics window; returns the settings after applying. */
    setEnabled: (enabled: boolean) => Promise<DesktopLyricsSettings>
    toggle: () => Promise<DesktopLyricsSettings>
    options: () => Promise<DesktopLyricsSettings>
    setOptions: (patch: Partial<DesktopLyricsSettings>) => Promise<DesktopLyricsSettings>
    /** Puts the window back at its default size/position. */
    resetPosition: () => Promise<DesktopLyricsSettings>
  }
  /**
   * The download manager. `start` takes a track and resolves its stream in the main process, so the
   * renderer never sees (or stores) a real media URL.
   */
  downloads: {
    list: () => Promise<DownloadTask[]>
    start: (input: DownloadStartInput) => Promise<DownloadTask | null>
    pause: (id: string) => Promise<DownloadTask[]>
    resume: (id: string) => Promise<DownloadTask[]>
    retry: (id: string) => Promise<DownloadTask[]>
    cancel: (id: string) => Promise<DownloadTask[]>
    remove: (id: string) => Promise<DownloadTask[]>
    clearFinished: () => Promise<DownloadTask[]>
    reveal: (id: string) => Promise<boolean>
    openDirectory: () => Promise<boolean>
    chooseDirectory: () => Promise<DownloadSettings | null>
    /** Progress pushes (`downloads:progress`), throttled in the main process. */
    onProgress: (listener: (tasks: DownloadTask[]) => void) => () => void
  }
  app: {
    info: () => Promise<AppInfo>
    /**
     * Tells main which theme the renderer resolved, so it can repaint the native chrome (title-bar
     * overlay colour, native control colour scheme) and remember it for the next launch.
     *
     * `chrome` is the skin's own background/symbol colours. It has to come from the renderer because
     * it is derived from the *generated* token set — main cannot compute a user theme's colours — and
     * without it the strip would keep the default dark bar under a light skin.
     */
    /**
     * `night` marks the playback-detail page, which is always dark: it repaints the native strip and
     * `nativeTheme` dark for as long as that page is open, while `mode` (the persisted preference)
     * stays whatever the user chose.
     */
    setTheme: (mode: ThemeMode, chrome?: ThemeChrome | null, skin?: string, night?: boolean) => Promise<ThemeMode>
    /**
     * Averages the window's own backdrop over a few small regions, so the shell can be painted with the
     * colour that is genuinely behind it rather than an approximation of it.
     *
     * One entry per requested region; `null` means the compositor had nothing to give (a frame that had
     * not painted yet, a minimised window), in which case the caller keeps its previous colour.
     */
    sampleBackdrop: (rects: BackdropRect[]) => Promise<(string | null)[]>
    /**
     * Repaints the native window strip, without persisting the theme or moving `nativeTheme`.
     *
     * The OS overlay takes a concrete colour and cannot be transitioned, so the renderer fades it by
     * sending a few frames. Those frames must not each write settings, which is why this exists next to
     * `setTheme` rather than being folded into it.
     */
    setChrome: (chrome: ThemeChrome) => Promise<boolean>
  }
  /** The user's themes folder: 更多主题 is a real loader, not a placeholder. */
  themes: {
    list: () => Promise<UserThemeRecord[]>
    import: () => Promise<UserThemeRecord | null>
    remove: (id: string) => Promise<UserThemeRecord[]>
    reveal: () => Promise<string>
  }
  /** Cache accounting and deletion: every number comes from the same walk that deletes. */
  cache: {
    report: () => Promise<CacheReport>
    clear: (areas?: CacheAreaId[]) => Promise<CacheClearResult>
  }
  /** Backup and restore. `pick` validates; only then may `apply` write anything. */
  backup: {
    export: (data: BackupUserData) => Promise<BackupExportResult>
    pick: () => Promise<BackupPickResult>
    apply: () => Promise<BackupApplyResult>
    /** Puts the settings back after a restore whose renderer half failed. */
    revert: () => Promise<boolean>
    commit: () => Promise<boolean>
  }
  diagnostics: {
    report: () => Promise<DiagnosticsReport>
    clear: () => Promise<DiagnosticsReport>
    export: () => Promise<DiagnosticsExportResult>
    reveal: () => Promise<boolean>
    /** Renderer-side failures; scrubbed and categorised in main before they are written. */
    record: (kind: string, message: string) => Promise<boolean>
  }
  updates: {
    check: (force?: boolean) => Promise<UpdateCheckResult>
    open: (url: string) => Promise<boolean>
  }
  httpApi: {
    status: () => Promise<HttpApiStatus>
    set: (patch: Partial<HttpApiSettings>) => Promise<HttpApiStatus>
    regenerateToken: () => Promise<HttpApiStatus>
  }
  database: {
    stats: () => Promise<DatabaseStats>
  }
}

export interface ThemeChrome {
  color: string
  symbolColor: string
}

/** A region of the window in device-independent pixels, matching Electron's `capturePage` rect. */
export interface BackdropRect {
  x: number
  y: number
  width: number
  height: number
}
