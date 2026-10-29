import type { Lyrics } from '../../shared/lyrics'
import type {
  AudioTrack,
  AuroraSettings,
  PlaybackQuality,
  ResolvedStream,
  SearchOptions,
  SourceConfigValue,
  SourceDescriptor,
  SourceErrorInfo,
  SourceErrorLogEntry,
  SourceHealth,
  SourcePlaylist,
  SourcePlaylistDetail,
  SourceSearchOutcome,
  SourceStatus,
} from '../../shared/types'
import { caches } from '../cache'
import { secretStorageIsPlain } from '../secretStore'
import { getEntry } from './registry'
import { repairRefusedHosts } from './autoRepair'
import { hostAutoGrantAllowed } from './policy'
import { SourceError, toSourceErrorInfo } from './errors'
import { logSourceError, readErrorLog } from './log'
import { readPendingHosts } from './permissions'
import { findCapabilityGaps, type MusicSource, type SourceContext } from './types'

/**
 * The SourceManager is the single place that knows about *user* plugins.
 *
 * Platforms (kw/wy/tx/kg/mg) are NOT sources — they live in `main/platforms/`. This manager only
 * handles Source plugins (declarative + script). Platform search is a separate namespace; whether
 * a platform track can play is derived from how many enabled Sources resolve that platform.
 */
const sources = new Map<string, MusicSource>()
let registrationOrder: string[] = []
const health = new Map<string, SourceHealth>()
const lastFailures = new Map<string, { error: SourceErrorInfo; at: number }>()
const initializing = new Set<string>()
const FAILURE_TTL_MS = 60_000
const AGGREGATE_CONCURRENCY = 4

/**
 * Drops every cached payload. Called whenever a source is registered or unregistered: the caches are
 * keyed by `sourceId`, so keeping them across a reload would let the *previous* instance serve
 * results (including results from a source that was just deleted, or from a script that changed).
 * They are small and cheap to rebuild, so there is nothing to gain by being clever here.
 */
function dropCaches(): void {
  for (const cache of Object.values(caches)) cache.clear()
}

export function registerSource(source: MusicSource): void {
  if (!source.meta.id) return
  dropCaches()
  if (!sources.has(source.meta.id)) registrationOrder.push(source.meta.id)
  sources.set(source.meta.id, source)
  lastFailures.delete(source.meta.id)
  // A source that declares more than it implements is a real bug, and the UI has to be able to say
  // so instead of offering a button that always fails.
  const gaps = findCapabilityGaps(source)
  if (gaps.length > 0) {
    logSourceError(source.meta.id, 'UNSUPPORTED', `声明了能力但没有实现：${gaps.join(' / ')}`, 'register')
  }
}

export function unregisterSource(id: string): void {
  dropCaches()
  sources.delete(id)
  registrationOrder = registrationOrder.filter((item) => item !== id)
  health.delete(id)
  lastFailures.delete(id)
}

export function getSource(id: string): MusicSource | undefined {
  return sources.get(id)
}

export function listSources(): MusicSource[] {
  return [...sources.values()]
}

/* ------------------------------------------------------------------ config & ordering */

function schemaFields(source: MusicSource) {
  return source.meta.configSchema?.fields ?? []
}

/** Effective config: schema defaults <- user values <- decrypted secrets. */
export function resolveConfig(
  source: MusicSource,
  settings: AuroraSettings,
  secrets: Record<string, string> = {},
): Record<string, SourceConfigValue> {
  const config: Record<string, SourceConfigValue> = { ...(source.meta.configDefaults ?? {}) }
  const stored = settings.sourceConfig[source.meta.id] ?? {}
  for (const [key, value] of Object.entries(stored)) config[key] = value
  for (const [key, value] of Object.entries(secrets)) {
    if (value) config[key] = value
  }
  return config
}

export function isConfigured(source: MusicSource, config: Record<string, SourceConfigValue>): boolean {
  if (source.isConfigured) return source.isConfigured(config)
  if (!source.meta.requiresConfig) return true
  return schemaFields(source)
    .filter((field) => field.required !== false)
    .every((field) => String(config[field.key] ?? '').length > 0)
}

export function isEnabled(id: string, settings: AuroraSettings): boolean {
  return settings.enabledSources[id] !== false
}

function buildContext(
  source: MusicSource,
  settings: AuroraSettings,
  secrets: Record<string, string>,
): SourceContext {
  return {
    config: resolveConfig(source, settings, secrets),
    settings,
    allowDownloads: settings.allowOpenLicenseDownloads,
  }
}

/** Ordered by the user's preference, then by registration order for stability. */
export function orderedSources(settings: AuroraSettings): MusicSource[] {
  const rank = new Map(settings.sourceOrder.map((id, index) => [id, index]))
  const fallback = new Map(registrationOrder.map((id, index) => [id, index]))
  return listSources().sort((a, b) => {
    const left = rank.get(a.meta.id) ?? Number.MAX_SAFE_INTEGER
    const right = rank.get(b.meta.id) ?? Number.MAX_SAFE_INTEGER
    if (left !== right) return left - right
    return (fallback.get(a.meta.id) ?? 0) - (fallback.get(b.meta.id) ?? 0)
  })
}

function statusFor(source: MusicSource, settings: AuroraSettings, secrets: Record<string, string>): SourceStatus {
  if (!isEnabled(source.meta.id, settings)) return 'disabled'
  if (initializing.has(source.meta.id)) return 'initializing'
  if (!isConfigured(source, buildContext(source, settings, secrets).config)) return 'needs-config'
  const failure = lastFailures.get(source.meta.id)
  if (failure && Date.now() - failure.at < FAILURE_TTL_MS) return 'error'
  return 'ready'
}

/**
 * @param secrets per-source decrypted secrets, so descriptors can report which secret fields are set
 *        without ever handing the values to the renderer.
 */
export function describeSources(
  settings: AuroraSettings,
  secretsBySource: Record<string, Record<string, string>> = {},
): SourceDescriptor[] {
  return orderedSources(settings).map((source, index) => {
    const secrets = secretsBySource[source.meta.id] ?? {}
    const context = buildContext(source, settings, secrets)
    const stored = settings.sourceConfig[source.meta.id] ?? {}
    const config: Record<string, SourceConfigValue> = {}
    for (const field of schemaFields(source)) {
      if (field.secret) continue
      const value = context.config[field.key]
      if (value !== undefined && value !== '') config[field.key] = value
    }
    const secretKeys: Record<string, boolean> = {}
    for (const field of schemaFields(source)) {
      if (!field.secret) continue
      secretKeys[field.key] = Boolean(secrets[field.key] ?? stored[field.key])
    }
    return {
      ...source.meta,
      builtin: false as const,
      configSchema: { fields: schemaFields(source) },
      config,
      secretKeys,
      secretsPlain: secretStorageIsPlain(source.meta.id),
      requiresConfig: source.meta.requiresConfig,
      configured: isConfigured(source, context.config),
      enabled: isEnabled(source.meta.id, settings),
      status: statusFor(source, settings, secrets),
      order: index,
      health: health.get(source.meta.id),
      kind: source.meta.kind,
      runtime: source.meta.runtime,
      permissions: source.meta.permissions ?? ['network'],
      platforms: source.meta.platforms ?? [],
      qualities: source.meta.qualities ?? [],
      capabilityGaps: findCapabilityGaps(source),
      errorLog: readErrorLog(source.meta.id),
      pendingHosts: readPendingHosts(source.meta.id).map((pending) => pending.host),
      /*
       * The granted hosts, so the UI can show what a source may reach and offer to take it back.
       * Before this, grants were only ever visible indirectly (as a count in a help text), which made
       * an automatic grant indistinguishable from a source that simply always worked.
       */
      allowedHosts: [...(getEntry(source.meta.id)?.allowedHosts ?? [])],
    }
  })
}

/** Splits a settings-page patch into persistable config and secret values to encrypt. */
export function splitConfigPatch(
  sourceId: string,
  patch: Record<string, SourceConfigValue>,
): { config: Record<string, SourceConfigValue>; secrets: Record<string, string> } {
  const source = sources.get(sourceId)
  const config: Record<string, SourceConfigValue> = {}
  const secrets: Record<string, string> = {}
  if (!source) return { config, secrets }

  const fields = schemaFields(source)
  for (const [key, raw] of Object.entries(patch)) {
    const field = fields.find((item) => item.key === key)
    if (!field) continue
    if (field.type === 'boolean') {
      config[key] = raw === true || raw === 'true'
      continue
    }
    if (field.type === 'number') {
      const minimum = field.min ?? 0
      const maximum = field.max ?? Number.MAX_SAFE_INTEGER
      const parsed = Number(raw)
      if (!Number.isFinite(parsed)) continue
      config[key] = Math.min(Math.max(parsed, minimum), maximum)
      continue
    }
    const value = String(raw ?? '').trim().slice(0, 512)
    if (field.secret) {
      if (value) secrets[key] = value
      continue
    }
    config[key] = value
  }
  return { config, secrets }
}

/* ------------------------------------------------------------------ selection helpers */

export function getEnabledSources(settings: AuroraSettings, secrets: Record<string, Record<string, string>> = {}): MusicSource[] {
  return orderedSources(settings).filter(
    (source) =>
      isEnabled(source.meta.id, settings) &&
      isConfigured(source, buildContext(source, settings, secrets[source.meta.id] ?? {}).config),
  )
}

/** Enabled sources whose capabilities include `capability`, in user order. */
function sourcesWith<K extends keyof MusicSource>(
  settings: AuroraSettings,
  secrets: Record<string, Record<string, string>>,
  capability: keyof SourceDescriptor['capabilities'],
  operation: K,
): MusicSource[] {
  return getEnabledSources(settings, secrets).filter(
    (source) => source.meta.capabilities[capability] && typeof source[operation] === 'function',
  )
}

function recordFailure(id: string, error: unknown, operation: string): SourceErrorInfo {
  const info = toSourceErrorInfo(error, sources.get(id)?.meta.name ?? '音源')
  lastFailures.set(id, { error: info, at: Date.now() })
  logSourceError(id, info.code, info.message, operation)
  return info
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await worker(items[index])
    }
  })
  await Promise.all(runners)
  return results
}

function cacheKey(...parts: Array<string | number | undefined>): string {
  return parts.map((part) => String(part ?? '')).join('|')
}

/* ------------------------------------------------------------------ operations */

function searchKey(sourceId: string, query: string, options: SearchOptions): string {
  return cacheKey(sourceId, query.trim().toLowerCase(), options.page ?? 0, options.pageSize ?? 0, options.type ?? '', options.tag ?? '')
}

export async function searchOne(
  sourceId: string,
  query: string,
  options: SearchOptions,
  settings: AuroraSettings,
  secrets: Record<string, Record<string, string>> = {},
): Promise<SourceSearchOutcome> {
  const source = sources.get(sourceId)
  const started = Date.now()
  if (!source) {
    return {
      sourceId,
      sourceName: sourceId,
      ok: false,
      tracks: [],
      error: { code: 'NOT_FOUND', message: '音源不存在' },
    }
  }
  const name = source.meta.name
  if (!isEnabled(sourceId, settings)) {
    return { sourceId, sourceName: name, ok: false, tracks: [], error: { code: 'UNSUPPORTED', message: `${name} 已被禁用` } }
  }
  try {
    const context = buildContext(source, settings, secrets[sourceId] ?? {})
    if (!isConfigured(source, context.config)) {
      throw new SourceError('NEEDS_CONFIG', `${name} 尚未完成配置`)
    }
    if (!source.meta.capabilities.search || !source.search) {
      throw new SourceError('UNSUPPORTED', `${name} 不支持搜索`)
    }

    const key = searchKey(sourceId, query, options)
    const cached = caches.search.get(key) as AudioTrack[] | undefined
    if (cached) {
      return { sourceId, sourceName: name, ok: true, tracks: cached, latencyMs: Date.now() - started }
    }

    const tracks = await source.search(query, options, context)
    const list = Array.isArray(tracks) ? tracks : []
    caches.search.set(key, list)
    lastFailures.delete(sourceId)
    return { sourceId, sourceName: name, ok: true, tracks: list, latencyMs: Date.now() - started }
  } catch (error) {
    return { sourceId, sourceName: name, ok: false, tracks: [], error: recordFailure(sourceId, error, 'search') }
  }
}

/**
 * Fan-out search across every enabled source. A failing source never rejects the whole call:
 * each one resolves into its own outcome row.
 */
export async function searchAll(
  query: string,
  options: SearchOptions,
  settings: AuroraSettings,
  secrets: Record<string, Record<string, string>> = {},
): Promise<SourceSearchOutcome[]> {
  const targets = orderedSources(settings).filter((source) => isEnabled(source.meta.id, settings))
  const results = await mapWithConcurrency(targets, AGGREGATE_CONCURRENCY, (source) =>
    searchOne(source.meta.id, query, options, settings, secrets),
  )
  return results.filter((outcome): outcome is SourceSearchOutcome => Boolean(outcome))
}

export async function recommendations(
  sourceId: string,
  options: SearchOptions,
  settings: AuroraSettings,
  secrets: Record<string, Record<string, string>> = {},
): Promise<AudioTrack[]> {
  const source = sources.get(sourceId)
  if (!source || !isEnabled(sourceId, settings)) return []
  if (!source.meta.capabilities.recommendations || !source.getRecommendations) return []
  const context = buildContext(source, settings, secrets[sourceId] ?? {})
  if (!isConfigured(source, context.config)) throw new SourceError('NEEDS_CONFIG', `${source.meta.name} 尚未完成配置`)
  const key = cacheKey('recommend', sourceId, options.tag ?? '', options.pageSize ?? 0)
  const cached = caches.recommendations.get(key) as AudioTrack[] | undefined
  if (cached) return cached
  try {
    const tracks = await source.getRecommendations(options, context)
    const list = Array.isArray(tracks) ? tracks : []
    caches.recommendations.set(key, list)
    lastFailures.delete(sourceId)
    return list
  } catch (error) {
    recordFailure(sourceId, error, 'recommendations')
    throw error
  }
}

/** Aggregated playlists/collections from every enabled source that supports them. */
export async function playlists(
  sourceId: string | undefined,
  settings: AuroraSettings,
  secrets: Record<string, Record<string, string>> = {},
): Promise<SourcePlaylist[]> {
  const targets = sourceId
    ? sourcesWith(settings, secrets, 'playlists', 'getPlaylists').filter((source) => source.meta.id === sourceId)
    : sourcesWith(settings, secrets, 'playlists', 'getPlaylists')

  const settled = await mapWithConcurrency(targets, AGGREGATE_CONCURRENCY, async (source) => {
    const key = cacheKey('playlists', source.meta.id)
    const cached = caches.playlists.get(key) as SourcePlaylist[] | undefined
    if (cached) return cached
    try {
      const list = await source.getPlaylists!(buildContext(source, settings, secrets[source.meta.id] ?? {}))
      const normalized = (Array.isArray(list) ? list : []).map((playlist) => ({ ...playlist, sourceId: source.meta.id }))
      caches.playlists.set(key, normalized)
      lastFailures.delete(source.meta.id)
      return normalized
    } catch (error) {
      recordFailure(source.meta.id, error, 'getPlaylists')
      return [] as SourcePlaylist[]
    }
  })

  return settled.flat()
}

export async function playlistDetail(
  sourceId: string,
  playlistId: string,
  settings: AuroraSettings,
  secrets: Record<string, Record<string, string>> = {},
): Promise<SourcePlaylistDetail | null> {
  const source = sources.get(sourceId)
  if (!source || !isEnabled(sourceId, settings)) return null
  if (!source.meta.capabilities.playlistDetail || !source.getPlaylistDetail) {
    throw new SourceError('UNSUPPORTED', `${source.meta.name} 不支持歌单详情`)
  }
  const context = buildContext(source, settings, secrets[sourceId] ?? {})
  if (!isConfigured(source, context.config)) throw new SourceError('NEEDS_CONFIG', `${source.meta.name} 尚未完成配置`)
  const key = cacheKey('playlistDetail', sourceId, playlistId)
  const cached = caches.playlistDetail.get(key) as SourcePlaylistDetail | null | undefined
  if (cached) return cached
  try {
    const detail = await source.getPlaylistDetail(playlistId, context)
    caches.playlistDetail.set(key, detail)
    lastFailures.delete(sourceId)
    return detail
  } catch (error) {
    recordFailure(sourceId, error, 'getPlaylistDetail')
    throw error
  }
}

export async function resolveStream(
  sourceId: string,
  trackId: string,
  settings: AuroraSettings,
  secrets: Record<string, Record<string, string>> = {},
  options: { quality?: PlaybackQuality; track?: AudioTrack } = {},
): Promise<ResolvedStream | null> {
  const source = sources.get(sourceId)
  if (!source || !source.meta.capabilities.stream) return null
  if (!source.getPlayUrl && !source.resolve) return null
  const context = buildContext(source, settings, secrets[sourceId] ?? {})
  if (!isConfigured(source, context.config)) throw new SourceError('NEEDS_CONFIG', `${source.meta.name} 尚未完成配置`)

  // The manager owns the fallbacks: a source may implement the richer `getPlayUrl` or the older
  // id-only `resolve`, and callers do not care which.
  let track = options.track
  if (!track) {
    track = {
      id: `${sourceId}:${trackId}`,
      origin: 'online',
      title: '未知曲目',
      artist: '未知艺术家',
      album: '未知专辑',
      duration: 0,
      format: '—',
      fileUrl: '',
      addedAt: Date.now(),
      sourceId,
      sourceTrackId: trackId,
    }
  }

  const call = (target: MusicSource) =>
    target.getPlayUrl
      ? target.getPlayUrl(track, options.quality, buildContext(target, settings, secrets[sourceId] ?? {}))
      : target.resolve!(trackId, context)

  try {
    const resolved = await call(source)
    lastFailures.delete(sourceId)
    if (resolved && options.quality && !resolved.quality) resolved.quality = options.quality
    return resolved
  } catch (error) {
    /*
     * Same repair as the platform path: a host a source composes at runtime cannot be known at
     * install time, so the first request is refused, and the useful answer is to grant what the
     * refusal recorded and retry once — not to fail a track the user asked to play.
     */
    if (error instanceof SourceError && error.code === 'PERMISSION' && hostAutoGrantAllowed()) {
      const repaired = await repairRefusedHosts(sourceId)
      const reloaded = repaired.granted.length > 0 ? sources.get(sourceId) : undefined
      if (reloaded) {
        try {
          const resolved = await call(reloaded)
          lastFailures.delete(sourceId)
          if (resolved && options.quality && !resolved.quality) resolved.quality = options.quality
          return resolved
        } catch (retryError) {
          recordFailure(sourceId, retryError, 'resolve')
          throw retryError
        }
      }
    }
    recordFailure(sourceId, error, 'resolve')
    throw error
  }
}

/** Lyrics owned by the source plugin (Aurora's own sidecar/embedded lookup lives in `lyrics.ts`). */
export async function sourceLyrics(
  track: AudioTrack,
  settings: AuroraSettings,
  secrets: Record<string, Record<string, string>> = {},
): Promise<Lyrics | null> {
  const sourceId = track.sourceId
  if (!sourceId) return null
  const source = sources.get(sourceId)
  if (!source || !source.meta.capabilities.lyrics || !source.getLyrics) return null
  if (!isEnabled(sourceId, settings)) return null
  const context = buildContext(source, settings, secrets[sourceId] ?? {})
  if (!isConfigured(source, context.config)) return null
  try {
    return await source.getLyrics(track, context)
  } catch (error) {
    recordFailure(sourceId, error, 'getLyrics')
    return null
  }
}

/** Cover resolution with the manager-owned fallback to whatever `search` already carried. */
export async function coverFor(
  track: AudioTrack,
  settings: AuroraSettings,
  secrets: Record<string, Record<string, string>> = {},
): Promise<string | null> {
  const sourceId = track.sourceId
  const source = sourceId ? sources.get(sourceId) : undefined
  if (!source || !source.getCover || !isEnabled(sourceId!, settings)) return track.cover ?? null
  const context = buildContext(source, settings, secrets[sourceId!] ?? {})
  if (!isConfigured(source, context.config)) return track.cover ?? null
  try {
    return (await source.getCover(track, context)) ?? track.cover ?? null
  } catch (error) {
    recordFailure(sourceId!, error, 'getCover')
    return track.cover ?? null
  }
}

/* ------------------------------------------------------------------ lifecycle & health */

export async function initializeSources(
  settings: AuroraSettings,
  secrets: Record<string, Record<string, string>> = {},
): Promise<void> {
  for (const source of getEnabledSources(settings, secrets)) {
    if (!source.initialize) continue
    initializing.add(source.meta.id)
    try {
      await source.initialize(buildContext(source, settings, secrets[source.meta.id] ?? {}))
    } catch (error) {
      recordFailure(source.meta.id, error, 'initialize')
    } finally {
      initializing.delete(source.meta.id)
    }
  }
}

export async function checkHealth(
  sourceId: string,
  settings: AuroraSettings,
  secrets: Record<string, Record<string, string>> = {},
): Promise<SourceHealth> {
  const source = sources.get(sourceId)
  const context = source ? buildContext(source, settings, secrets[sourceId] ?? {}) : null
  if (!source || !context) return { ok: false, message: '音源不存在', checkedAt: Date.now() }
  if (!isEnabled(sourceId, settings)) return { ok: false, message: '音源已被禁用', checkedAt: Date.now() }
  if (!isConfigured(source, context.config)) return { ok: false, message: '尚未完成配置', checkedAt: Date.now() }

  const started = Date.now()
  try {
    let result: SourceHealth
    if (source.healthCheck) {
      const probed = await source.healthCheck(context)
      result = { ...probed, latency: probed.latency ?? Date.now() - started, checkedAt: Date.now() }
    } else if (source.meta.capabilities.search && source.search) {
      await source.search('jazz', { pageSize: 1 }, context)
      result = { ok: true, latency: Date.now() - started, checkedAt: Date.now() }
    } else {
      result = { ok: true, latency: 0, message: '该音源无需连通性检查', checkedAt: Date.now() }
    }
    health.set(sourceId, result)
    if (result.ok) lastFailures.delete(sourceId)
    else {
      lastFailures.set(sourceId, { error: { code: 'UNKNOWN', message: result.message ?? '健康检查失败' }, at: Date.now() })
      logSourceError(sourceId, 'UNKNOWN', result.message ?? '健康检查失败', 'healthCheck')
    }
    return result
  } catch (error) {
    const info = recordFailure(sourceId, error, 'healthCheck')
    const result: SourceHealth = { ok: false, message: info.message, checkedAt: Date.now(), latency: Date.now() - started }
    health.set(sourceId, result)
    return result
  }
}

/* ------------------------------------------------------------------ health monitor */

let healthTimer: NodeJS.Timeout | null = null
let healthKickoff: NodeJS.Timeout | null = null
let healthPassRunning = false

/**
 * Runs one health probe per enabled source, sequentially, so a slow API cannot flood the network.
 * Errors are already normalised into `SourceHealth` objects by `checkHealth`.
 */
export async function runHealthPass(
  settings: AuroraSettings,
  secrets: Record<string, Record<string, string>> = {},
): Promise<SourceHealth[]> {
  if (healthPassRunning) return []
  healthPassRunning = true
  const results: SourceHealth[] = []
  try {
    for (const source of getEnabledSources(settings, secrets)) {
      results.push(await checkHealth(source.meta.id, settings, secrets))
    }
  } finally {
    healthPassRunning = false
  }
  return results
}

/**
 * Periodic background health check. Settings are read fresh on every pass so a user turning the
 * feature off (or disabling a source) takes effect on the next tick instead of on restart.
 */
export function startHealthMonitor(
  readSettings: () => AuroraSettings,
  readSecrets: () => Record<string, Record<string, string>>,
  options: { intervalMs?: number; initialDelayMs?: number } = {},
): void {
  stopHealthMonitor()
  const { intervalMs = 10 * 60_000, initialDelayMs = 20_000 } = options
  const pass = (): void => {
    const settings = readSettings()
    if (!settings.autoHealthCheck) return
    void runHealthPass(settings, readSecrets()).catch(() => undefined)
  }
  healthKickoff = setTimeout(pass, initialDelayMs)
  healthKickoff.unref?.()
  healthTimer = setInterval(pass, intervalMs)
  healthTimer.unref?.()
}

export function stopHealthMonitor(): void {
  if (healthKickoff) {
    clearTimeout(healthKickoff)
    healthKickoff = null
  }
  if (healthTimer) {
    clearInterval(healthTimer)
    healthTimer = null
  }
}

/**
 * Drops cached payloads (all of them — they are small) and forgets runtime state for one source.
 * Called after a source is enabled, disabled or reconfigured so the next request is always fresh.
 */
export function invalidateSourceRuntime(sourceId?: string): void {
  for (const cache of Object.values(caches)) cache.clear()
  if (sourceId) {
    lastFailures.delete(sourceId)
    health.delete(sourceId)
  } else {
    lastFailures.clear()
    health.clear()
  }
}
