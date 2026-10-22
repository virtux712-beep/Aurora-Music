import { app } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  DEFAULT_DESKTOP_LYRICS,
  DEFAULT_DOWNLOAD_SETTINGS,
  DEFAULT_SYSTEM_INTEGRATION,
  SYSTEM_INTEGRATION_KEYS,
} from '../shared/types'
import { DEFAULT_HTTP_API, DEFAULT_UPDATE_CHECK, HTTP_API_PORT_MAX, HTTP_API_PORT_MIN } from '../shared/maintenance'
import { DEFAULT_QUALITY, isQualityTierId } from '../shared/quality'
import { clampLyricsOffset } from '../shared/lyrics'
import {
  DEFAULT_SOUND,
  PRESET_ID_PATTERN,
  clampCrossfadeSeconds,
  clampPreampDb,
  isLoudnessTarget,
  normalizeEqGains,
} from '../shared/sound'
import { setSourceAccessPolicy } from './sources/policy'
import type {
  AuroraSettings,
  AuroraSettingsPatch,
  DesktopLyricsSettings,
  DownloadSettings,
  HttpApiSettings,
  SoundSettings,
  SourceConfigValue,
  SystemIntegrationSettings,
  UpdateCheckSettings,
} from '../shared/types'

/**
 * Main-process owned settings. The renderer may patch them, but every value is validated here
 * first — a corrupt settings file must never break startup, and a hostile renderer must not be
 * able to store arbitrary payloads.
 */
/**
 * v6 adds the quality preference, v7 the sound block (EQ / loudness / output device / gapless /
 * crossfade), v8 the lyric offset; `sanitize` fills any missing field from `DEFAULTS`, so an older file
 * simply arrives without the new keys.
 */
const SETTINGS_VERSION = 9
const MAX_SOURCES = 64
const MAX_KEYS_PER_SOURCE = 32
const MAX_STRING_LENGTH = 512

const DEFAULTS: AuroraSettings = {
  sourceConfig: {},
  enabledSources: {},
  sourceOrder: [],
  allowOpenLicenseDownloads: true,
  autoHealthCheck: true,
  autoGrantSourceHosts: true,
  /*
   * 安全模式 starts off, on purpose.
   *
   * It is a real restriction, not a safer default: it refuses cleartext `http:` API requests, and most
   * of the aggregator sources this app is used with publish `http://` endpoints. Defaulting it on would
   * ship a player whose sources half-work with no explanation — the failure mode this whole source
   * layer tries to avoid. The switch is one row in 音源管理, and it says what it does.
   */
  safeMode: false,
  /*
   * Kept in main as well as in localStorage: the native title-bar strip is drawn before the page
   * loads, so the persisted value is what stops a light-theme launch from flashing a dark bar.
   */
  theme: 'dark',
  skin: 'aurora',
  /*
   * The playback-quality preference: which of the four tiers Aurora should ask a source for.
   * Defaults to 高清无损 rather than the top tier — a player that silently pulls 24/96 masters on a metered
   * connection is not being generous, and ① is one click away.
   */
  preferredQuality: DEFAULT_QUALITY,
  desktopLyrics: { ...DEFAULT_DESKTOP_LYRICS },
  downloads: { ...DEFAULT_DOWNLOAD_SETTINGS },
  systemIntegration: { ...DEFAULT_SYSTEM_INTEGRATION },
  sound: structuredClone(DEFAULT_SOUND),
  lyricsOffsetMs: 0,
  updateCheck: { ...DEFAULT_UPDATE_CHECK },
  httpApi: { ...DEFAULT_HTTP_API },
}

let settings: AuroraSettings = structuredClone(DEFAULTS)
let settingsFile = ''

/**
 * A fresh copy of the defaults.
 *
 * Exported so callers that need "settings-shaped object without reading the user's file" (the IPC
 * guard that refuses to hand settings to an untrusted sender) can reuse this one definition — a
 * hand-copied literal is how `preferredQuality` went missing for a while without any test noticing.
 */
export function defaultSettings(): AuroraSettings {
  return structuredClone(DEFAULTS)
}

/**
 * v1 stored a single `jamendoClientId` at the root; v2 keeps it under the source's config; v3 adds
 * the desktop-lyrics block; v4 adds the download block; v5 adds system integration (tray / taskbar /
 * media keys). Later versions need no migration step —
 * `sanitize` fills every missing field from `DEFAULTS`, so an older file simply arrives without the
 * new keys.
 */
interface LegacySettings {
  jamendoClientId?: unknown
  allowOpenLicenseDownloads?: unknown
  autoHealthCheck?: unknown
}

function migrate(parsed: { version?: number; settings?: unknown }): Partial<AuroraSettings> | null {
  const raw = parsed.settings
  if (!raw || typeof raw !== 'object') return null
  if (typeof parsed.version === 'number' && parsed.version >= 2) return raw as Partial<AuroraSettings>

  const legacy = raw as LegacySettings
  const migrated: Partial<AuroraSettings> = {}
  if (typeof legacy.allowOpenLicenseDownloads === 'boolean') {
    migrated.allowOpenLicenseDownloads = legacy.allowOpenLicenseDownloads
  }
  if (typeof legacy.autoHealthCheck === 'boolean') {
    migrated.autoHealthCheck = legacy.autoHealthCheck
  }
  if (typeof legacy.jamendoClientId === 'string' && legacy.jamendoClientId.trim()) {
    migrated.sourceConfig = { jamendo: { clientId: legacy.jamendoClientId.trim() } }
  }
  return migrated
}

export async function initSettings(): Promise<void> {
  settingsFile = join(app.getPath('userData'), 'settings.json')
  try {
    const raw = await readFile(settingsFile, 'utf8')
    const parsed = JSON.parse(raw) as { version?: number; settings?: unknown }
    const migrated = migrate(parsed)
    settings = sanitize(migrated ?? {}, { ...DEFAULTS })
  } catch {
    settings = structuredClone(DEFAULTS)
  }
  // Before anything can make a request: the policy the request path reads is installed from the file
  // that was just loaded, not from whatever the defaults happened to be at import time.
  publishAccessPolicy()
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(Math.max(parsed, min), max)
}

/** Only `#rgb` / `#rrggbb` / `#rrggbbaa` reach the renderer as a CSS colour. */
function sanitizeColor(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim().toLowerCase()
  return /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(trimmed) ? trimmed : fallback
}

/**
 * Validates the desktop-lyrics block field by field. `width`/`height`/`x`/`y` are deliberately
 * bounded rather than trusted: a window restored from a corrupt file would otherwise open off-screen
 * or at a size that cannot be dragged back. A negative `x`/`y` means "not placed yet".
 */
function sanitizeDesktopLyrics(patch: unknown, base: DesktopLyricsSettings): DesktopLyricsSettings {
  const next: DesktopLyricsSettings = { ...base }
  if (!patch || typeof patch !== 'object') return next
  const candidate = patch as Record<string, unknown>
  if (typeof candidate.enabled === 'boolean') next.enabled = candidate.enabled
  if (typeof candidate.locked === 'boolean') next.locked = candidate.locked
  if (typeof candidate.alwaysOnTop === 'boolean') next.alwaysOnTop = candidate.alwaysOnTop
  if (typeof candidate.showTranslation === 'boolean') next.showTranslation = candidate.showTranslation
  if (typeof candidate.showNextLine === 'boolean') next.showNextLine = candidate.showNextLine
  next.fontSize = Math.round(clampNumber(candidate.fontSize, 14, 96, base.fontSize))
  next.background = clampNumber(candidate.background, 0, 1, base.background)
  next.color = sanitizeColor(candidate.color, base.color)
  next.inactiveColor = sanitizeColor(candidate.inactiveColor, base.inactiveColor)
  if (typeof candidate.fontFamily === 'string') next.fontFamily = candidate.fontFamily.slice(0, 120)
  next.width = Math.round(clampNumber(candidate.width, 320, 4000, base.width))
  next.height = Math.round(clampNumber(candidate.height, 90, 900, base.height))
  next.x = Math.round(clampNumber(candidate.x, -1, 20000, base.x))
  next.y = Math.round(clampNumber(candidate.y, -1, 20000, base.y))
  return next
}

/**
 * Validates the download block. The directory is taken as an opaque absolute path (the main process
 * decides whether it exists when a task starts), while the template is restricted to the three
 * names the manager can actually build — the string never reaches the filesystem unchecked.
 */
function sanitizeDownloads(patch: unknown, base: DownloadSettings): DownloadSettings {
  const next: DownloadSettings = { ...base }
  if (!patch || typeof patch !== 'object') return next
  const candidate = patch as Record<string, unknown>
  if (typeof candidate.directory === 'string') next.directory = candidate.directory.trim().slice(0, 400)
  if (candidate.nameTemplate === 'artist-title' || candidate.nameTemplate === 'title-artist' || candidate.nameTemplate === 'title') {
    next.nameTemplate = candidate.nameTemplate
  }
  next.concurrency = Math.round(clampNumber(candidate.concurrency, 1, 6, base.concurrency))
  if (typeof candidate.writeTags === 'boolean') next.writeTags = candidate.writeTags
  return next
}

/** Six independent booleans; anything else in the block is ignored rather than stored. */
function sanitizeSystemIntegration(
  patch: unknown,
  base: SystemIntegrationSettings,
): SystemIntegrationSettings {
  const next: SystemIntegrationSettings = { ...base }
  if (!patch || typeof patch !== 'object') return next
  const candidate = patch as Record<string, unknown>
  // Key list derived from the defaults in `shared/types.ts` — see the note there about why.
  for (const key of SYSTEM_INTEGRATION_KEYS) {
    if (typeof candidate[key] === 'boolean') next[key] = candidate[key]
  }
  return next
}

/**
 * The update feed is taken as an HTTPS URL or nothing: a plain-HTTP (or `file:`) feed would let whatever
 * is on the network answer for the vendor, and an empty string is the honest "not configured" state.
 */
function sanitizeUpdateCheck(patch: unknown, base: UpdateCheckSettings): UpdateCheckSettings {
  const next: UpdateCheckSettings = { ...base }
  if (!patch || typeof patch !== 'object') return next
  const candidate = patch as Record<string, unknown>
  if (typeof candidate.feedUrl === 'string') {
    const url = candidate.feedUrl.trim().slice(0, 400)
    next.feedUrl = url === '' || /^https:\/\//i.test(url) ? url : ''
  }
  if (typeof candidate.autoCheck === 'boolean') next.autoCheck = candidate.autoCheck
  return next
}

/** The token is an opaque hex string: nothing else may reach the HTTP layer as a credential. */
function sanitizeHttpApi(patch: unknown, base: HttpApiSettings): HttpApiSettings {
  const next: HttpApiSettings = { ...base }
  if (!patch || typeof patch !== 'object') return next
  const candidate = patch as Record<string, unknown>
  if (typeof candidate.enabled === 'boolean') next.enabled = candidate.enabled
  next.port = Math.round(clampNumber(candidate.port, HTTP_API_PORT_MIN, HTTP_API_PORT_MAX, base.port))
  if (typeof candidate.token === 'string') {
    const token = candidate.token.trim()
    next.token = /^[a-z0-9]{8,64}$/i.test(token) ? token : base.token
  }
  return next
}

/**
 * Validates the sound block. Every numeric field is clamped here rather than in the renderer, because
 * a gain of 400 dB — from a hand-edited file or a broken patch — would reach a `GainNode` and clip the
 * output into a square wave. The EQ keeps its band count fixed: a shorter array would leave filters
 * with no gain to read, and a longer one would silently drop bands the UI still draws sliders for.
 */
function sanitizeSound(patch: unknown, base: SoundSettings): SoundSettings {
  const next: SoundSettings = {
    equalizer: { ...base.equalizer, gains: [...base.equalizer.gains] },
    loudness: { ...base.loudness },
    outputDeviceId: base.outputDeviceId,
    gapless: base.gapless,
    crossfadeSeconds: base.crossfadeSeconds,
  }
  if (!patch || typeof patch !== 'object') return next
  const candidate = patch as Record<string, unknown>

  const equalizer = candidate.equalizer
  if (equalizer && typeof equalizer === 'object') {
    const eq = equalizer as Record<string, unknown>
    if (typeof eq.enabled === 'boolean') next.equalizer.enabled = eq.enabled
    if (typeof eq.preset === 'string' && PRESET_ID_PATTERN.test(eq.preset)) next.equalizer.preset = eq.preset
    if (Array.isArray(eq.gains)) next.equalizer.gains = normalizeEqGains(eq.gains, base.equalizer.gains)
    next.equalizer.preampDb = clampPreampDb(eq.preampDb ?? base.equalizer.preampDb)
  }

  const loudness = candidate.loudness
  if (loudness && typeof loudness === 'object') {
    const block = loudness as Record<string, unknown>
    if (typeof block.enabled === 'boolean') next.loudness.enabled = block.enabled
    if (isLoudnessTarget(block.targetDb)) next.loudness.targetDb = block.targetDb
  }

  if (typeof candidate.outputDeviceId === 'string') next.outputDeviceId = candidate.outputDeviceId.trim().slice(0, 200)
  if (typeof candidate.gapless === 'boolean') next.gapless = candidate.gapless
  next.crossfadeSeconds = clampCrossfadeSeconds(candidate.crossfadeSeconds ?? base.crossfadeSeconds)
  return next
}

function sanitizeValue(value: unknown): SourceConfigValue | undefined {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string') return value.slice(0, MAX_STRING_LENGTH)
  return undefined
}

/**
 * Merges a patch into the current settings. `sourceConfig` merges per source (so updating one
 * plugin never wipes another plugin's configuration).
 */
function sanitize(patch: AuroraSettingsPatch, base: AuroraSettings = settings): AuroraSettings {
  const next: AuroraSettings = {
    sourceConfig: { ...base.sourceConfig },
    enabledSources: { ...base.enabledSources },
    sourceOrder: [...base.sourceOrder],
    allowOpenLicenseDownloads: base.allowOpenLicenseDownloads,
    autoHealthCheck: base.autoHealthCheck,
    autoGrantSourceHosts: base.autoGrantSourceHosts,
    // Sixth instance of the same trap this file keeps documenting: a field `sanitize` does not copy is
    // dropped on the way in, so 安全模式 would look saved and read back off on the next launch.
    safeMode: base.safeMode,
    theme: base.theme,
    skin: base.skin,
    preferredQuality: base.preferredQuality,
    desktopLyrics: { ...base.desktopLyrics },
    downloads: { ...base.downloads },
    systemIntegration: { ...base.systemIntegration },
    sound: structuredClone(base.sound),
    lyricsOffsetMs: base.lyricsOffsetMs,
    updateCheck: { ...base.updateCheck },
    httpApi: { ...base.httpApi },
  }

  if (patch.sourceConfig && typeof patch.sourceConfig === 'object') {
    for (const [sourceId, values] of Object.entries(patch.sourceConfig).slice(0, MAX_SOURCES)) {
      if (!sourceId || sourceId.length > 64) continue
      if (values === null || typeof values !== 'object') {
        delete next.sourceConfig[sourceId]
        continue
      }
      const bucket: Record<string, SourceConfigValue> = {}
      for (const [key, raw] of Object.entries(values).slice(0, MAX_KEYS_PER_SOURCE)) {
        if (!key || key.length > 64) continue
        const value = sanitizeValue(raw)
        if (value !== undefined && value !== '') bucket[key] = value
      }
      if (Object.keys(bucket).length === 0) delete next.sourceConfig[sourceId]
      else next.sourceConfig[sourceId] = bucket
    }
  }

  if (patch.enabledSources && typeof patch.enabledSources === 'object') {
    for (const [sourceId, enabled] of Object.entries(patch.enabledSources).slice(0, MAX_SOURCES)) {
      if (!sourceId || sourceId.length > 64 || typeof enabled !== 'boolean') continue
      next.enabledSources[sourceId] = enabled
    }
  }

  if (Array.isArray(patch.sourceOrder)) {
    const order: string[] = []
    for (const id of patch.sourceOrder.slice(0, MAX_SOURCES)) {
      if (typeof id === 'string' && id && id.length <= 64 && !order.includes(id)) order.push(id)
    }
    next.sourceOrder = order
  }

  if (typeof patch.allowOpenLicenseDownloads === 'boolean') {
    next.allowOpenLicenseDownloads = patch.allowOpenLicenseDownloads
  }

  if (typeof patch.autoHealthCheck === 'boolean') {
    next.autoHealthCheck = patch.autoHealthCheck
  }

  if (typeof patch.autoGrantSourceHosts === 'boolean') {
    next.autoGrantSourceHosts = patch.autoGrantSourceHosts
  }

  if (typeof patch.safeMode === 'boolean') {
    next.safeMode = patch.safeMode
  }

  // `sanitize` builds `next` field by field, so a key that is not carried here silently vanishes on
  // the way in — which is exactly what happened to `theme` until the packaged suite asserted that
  // the value survives a round trip.
  if (patch.theme === 'dark' || patch.theme === 'light' || patch.theme === 'system') {
    next.theme = patch.theme
  }
  // Same trap as `theme`: a key `sanitize` does not copy is dropped on the way in. Only a
  // well-formed id is stored; anything else resets to the default rather than persisting a skin the
  // renderer could never resolve.
  if (typeof patch.skin === 'string') {
    const skin = patch.skin.trim()
    next.skin = /^[a-z0-9_-]{2,40}$/i.test(skin) ? skin : 'aurora'
  }
  // Third time this trap has bitten: a field `sanitize` does not copy is dropped on the way in, and an
  // unknown tier resets to the default instead of persisting a preference nothing can honour.
  if (isQualityTierId(patch.preferredQuality)) {
    next.preferredQuality = patch.preferredQuality
  }

  if (patch.desktopLyrics) {
    next.desktopLyrics = sanitizeDesktopLyrics(patch.desktopLyrics, base.desktopLyrics)
  }

  if (patch.downloads) {
    next.downloads = sanitizeDownloads(patch.downloads, base.downloads)
  }

  if (patch.systemIntegration) {
    next.systemIntegration = sanitizeSystemIntegration(patch.systemIntegration, base.systemIntegration)
  }

  // Fourth time this trap could have bitten: a block `sanitize` does not copy is dropped on the way
  // in, so the EQ would look like it saves and then read back flat.
  if (patch.sound) {
    next.sound = sanitizeSound(patch.sound, base.sound)
  }

  /*
   * The lyric offset is clamped and snapped here, not merely stored: it is added to the playback clock, so
   * an out-of-range value from a hand-edited file would put the lyrics seconds away from the music and look
   * like a broken engine rather than a bad number.
   */
  if (patch.lyricsOffsetMs !== undefined) {
    next.lyricsOffsetMs = clampLyricsOffset(patch.lyricsOffsetMs)
  }

  // Fifth time this trap would have bitten: a block `sanitize` does not copy is dropped on the way in,
  // so the update feed and the API token would look saved and read back empty.
  if (patch.updateCheck) {
    next.updateCheck = sanitizeUpdateCheck(patch.updateCheck, base.updateCheck)
  }

  if (patch.httpApi) {
    next.httpApi = sanitizeHttpApi(patch.httpApi, base.httpApi)
  }

  return next
}

export function getSettings(): AuroraSettings {
  return structuredClone(settings)
}

/**
 * Copies the two access booleans into the policy module, which is what the request path actually reads.
 *
 * Called after every settings load and every change — the request path (`sources/permissions.ts`,
 * `sources/http.ts`) has no settings object, so this is the one place the two can be kept in step.
 */
function publishAccessPolicy(): void {
  setSourceAccessPolicy({ safeMode: settings.safeMode, autoGrantHosts: settings.autoGrantSourceHosts })
}

/**
 * Applies 安全模式 to a source that was **just installed**: it starts disabled.
 *
 * Safe mode's promise is "nothing you install starts talking to the network before you say so". A
 * disabled source is not loaded, not registered and never asked to search — so that promise is kept by
 * the same switch the user already has, instead of by a second mechanism nobody can see.
 *
 * Only *new* installs are affected: re-saving a source the user already enabled is them editing
 * something they have already trusted, and silently disabling it would look like the edit failed.
 *
 * @returns whether the policy actually disabled the source (so the caller can say so in the UI).
 */
export async function enforceInstallPolicy(sourceId: string): Promise<boolean> {
  const id = typeof sourceId === 'string' ? sourceId.trim() : ''
  if (!id || !settings.safeMode) return false
  if (settings.enabledSources[id] === false) return true
  await updateSettings({ enabledSources: { [id]: false } })
  return true
}

export async function updateSettings(patch: AuroraSettingsPatch): Promise<AuroraSettings> {
  settings = sanitize(patch)
  publishAccessPolicy()
  try {
    await writeFile(settingsFile, JSON.stringify({ version: SETTINGS_VERSION, settings }, null, 2), 'utf8')
  } catch {
    // A failed write keeps the in-memory settings usable for this session.
  }
  return getSettings()
}
