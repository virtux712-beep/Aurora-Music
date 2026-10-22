import type { AudioTrack, AuroraSettings, PlaybackQuality, PlatformHealthSummary, ResolvedStream } from '../../shared/types'
import { getEnabledSources, getSource, isEnabled, orderedSources } from '../sources/manager'
import { repairRefusedHosts } from '../sources/autoRepair'
import { hostAutoGrantAllowed } from '../sources/policy'
import { logSourceError } from '../sources/log'
import { readPendingHosts } from '../sources/permissions'
import type { MusicSource } from '../sources/types'
import { SourceError, namePrefixed } from '../sources/errors'

const QUALITY_PREFERENCE: string[] = ['flac24bit', 'flac', '320k', '192k', '128k']

function preferredQuality(info: unknown, requested?: PlaybackQuality): string | undefined {
  if (requested) return requested
  const meta = (info as { meta?: { _qualitys?: Record<string, unknown> } } | null)?.meta
  const available = new Set(Object.keys(meta?._qualitys ?? {}))
  return QUALITY_PREFERENCE.find((quality) => available.has(quality))
}

/**
 * Every enabled source that declares this platform (or declares none at all, which means "I handle
 * whatever platform I am handed") and can actually produce a stream.
 *
 * The runtime kind is deliberately *not* checked: a 洛雪-style source and an Aurora-native source
 * are equally valid resolvers for a platform they declare. Gating on `runtime === 'lx'` is what used
 * to make a user's own script source unable to resolve the very tracks it produced.
 */
export function resolversForPlatform(platformId: string, settings: AuroraSettings): MusicSource[] {
  return orderedSources(settings).filter((source) => {
    if (typeof source.getPlayUrl !== 'function' && typeof source.resolve !== 'function') return false
    if (!isEnabled(source.meta.id, settings)) return false
    const platforms = source.meta.platforms ?? []
    return platforms.length === 0 || platforms.some((platform) => platform.id === platformId)
  })
}

export function resolversForTrack(track: AudioTrack, settings: AuroraSettings): MusicSource[] {
  const platformId = track.platform
  if (!platformId) return []
  const resolvers = resolversForPlatform(platformId, settings)
  // The source that produced the track goes first: it owns the id space in `metadata`, and a
  // different source declaring the same platform would often need a translation it cannot do.
  const producer = track.sourceId ? resolvers.find((source) => source.meta.id === track.sourceId) : undefined
  if (!producer) return resolvers
  return [producer, ...resolvers.filter((source) => source !== producer)]
}

export function platformResolverSummary(platformId: string, settings: AuroraSettings, secrets: Record<string, Record<string, string>>): PlatformHealthSummary {
  const resolvers = resolversForPlatform(platformId, settings)
  void secrets
  const ok = resolvers.length > 0
  return {
    platformId,
    resolverCount: resolvers.length,
    resolverNames: resolvers.map((item) => item.meta.name),
    health: {
      ok,
      latency: 0,
      checkedAt: Date.now(),
      message: ok ? `可搜索；播放地址由 ${resolvers.map((item) => item.meta.name).join('、')} 解析` : '可以搜索，但还没有支持该平台的音源，播放地址无法解析',
      ...(ok ? {} : { error: 'NO_RESOLVER' as unknown as undefined }),
    },
  }
}

export async function resolvePlatformTrack(
  track: AudioTrack,
  quality: PlaybackQuality | undefined,
  settings: AuroraSettings,
  secrets: Record<string, Record<string, string>>,
): Promise<ResolvedStream> {
  const platformId = track.platform
  if (!platformId) throw new SourceError('UNSUPPORTED', '该曲目没有平台信息，无法解析播放地址')
  const info = (track.metadata as { lx?: unknown } | undefined)?.lx
  const resolvers = resolversForTrack(track, settings)
  if (resolvers.length === 0) {
    throw new SourceError('NEEDS_CONFIG', `还没有已启用的音源支持 ${platformId}。请到「设置 → 音源管理」安装并启用一个支持该平台的音源。`)
  }
  void secrets
  const failures: string[] = []
  /*
   * A refusal is the one failure the user can fix in a click, so it is remembered separately from the
   * general failure list and reported *as* a refusal.
   *
   * Reporting it as `NOT_FOUND` with every source's message concatenated (what this used to do) put
   * the actionable sentence in the middle of a paragraph, next to failures that were not the cause —
   * and the code said "not found", so nothing in the UI could offer the host that needs granting.
   * The refused host itself is not guessed from the message text: the permission layer already
   * recorded it, which is also where the one-click grant reads it from.
   */
  let refusal: { sourceName: string; hosts: string[] } | undefined
  const pickedQuality = (preferredQuality(info, quality) ?? quality) as PlaybackQuality | undefined
  const call = (source: MusicSource) =>
    source.getPlayUrl?.(
      track,
      pickedQuality,
      { config: {}, settings, allowDownloads: true } as unknown as import('../sources/types').SourceContext,
    )
  for (const source of resolvers) {
    try {
      const stream = await call(source)
      if (stream) return stream
      failures.push(`${source.meta.name}：没有返回地址`)
    } catch (error) {
      let failure = error
      /*
       * A refusal is the failure worth retrying: the host was refused because it was not granted
       * *yet*, and the pending record written by the refusal is enough to grant it. The retry has to
       * go through the freshly registered instance — granting hot-reloads the source, so the object
       * in this loop is already the old one and would refuse again.
       */
      if (error instanceof SourceError && error.code === 'PERMISSION' && hostAutoGrantAllowed()) {
        const repaired = await repairRefusedHosts(source.meta.id)
        const reloaded = repaired.granted.length > 0 ? getSource(source.meta.id) : undefined
        if (reloaded) {
          try {
            const stream = await call(reloaded)
            if (stream) {
              logSourceError(
                source.meta.id,
                'PERMISSION',
                `已自动允许 ${repaired.granted.join('、')} 并重新解析成功`,
                'resolve',
              )
              return stream
            }
          } catch (retryError) {
            failure = retryError
          }
        }
      }
      if (failure instanceof SourceError && failure.code === 'PERMISSION' && !refusal) {
        refusal = {
          sourceName: source.meta.name,
          hosts: readPendingHosts(source.meta.id).map((pending) => pending.host),
        }
      }
      failures.push(namePrefixed(source.meta.name, failure instanceof Error ? failure.message : String(failure)))
    }
  }
  if (refusal) {
    const hosts = refusal.hosts.slice(0, 3)
    throw new SourceError(
      'PERMISSION',
      hosts.length > 0
        ? `${platformId}：音源「${refusal.sourceName}」需要访问 ${hosts.join('、')}，尚未授权。请到「设置 → 音源管理」点「允许 ${hosts[0]}」后重试。`
        : `${platformId}：音源「${refusal.sourceName}」缺少 network 权限。请到「设置 → 音源管理」为该音源授权后重试。`,
    )
  }
  throw new SourceError('NOT_FOUND', `${platformId}：${resolvers.length} 个音源都无法解析播放地址 — ${failures.join('；')}`)
}

export async function lyricsForPlatformTrack(
  track: AudioTrack,
  settings: AuroraSettings,
  secrets: Record<string, Record<string, string>>,
): Promise<import('../../shared/lyrics').Lyrics | null> {
  for (const source of resolversForTrack(track, settings)) {
    if (typeof source.getLyrics !== 'function') continue
    try {
      const lyrics = await source.getLyrics(track, { config: {}, settings, allowDownloads: true } as unknown as import('../sources/types').SourceContext)
      void secrets
      if (lyrics && lyrics.lines.length > 0) return lyrics
    } catch {
      // try next resolver
    }
  }
  return null
}

export function listEnabledResolvers(settings: AuroraSettings): MusicSource[] {
  return getEnabledSources(settings).filter((source) => source.meta.kind === 'script' && source.meta.runtime === 'lx' && typeof source.getPlayUrl === 'function')
}
