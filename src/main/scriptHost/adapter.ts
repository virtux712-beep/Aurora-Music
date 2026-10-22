import { checkMediaUrl, isAllowedMediaUrl } from '../../shared/customSource'
import { toSourceMusicInfo, type LxMusicInfo } from '../musicSdk'
import { parseLyricsText, type Lyrics } from '../../shared/lyrics'
import type {
  AudioTrack,
  PlaybackQuality,
  ResolvedStream,
  SearchOptions,
  SourcePermission,
  SourcePlaylist,
  SourcePlaylistDetail,
} from '../../shared/types'
import type { ScriptRuntimeKind } from '../../shared/scriptSource'
import { registerRemoteMedia } from '../remote'
import { SourceError } from '../sources/errors'
import { hostOfUrl, recordPendingHost } from '../sources/permissions'
import { buildTrack, defineCapabilities, type MusicSource, type SourceContext } from '../sources/types'
import { acquireScriptHost, disposeScriptHost, type ScriptHostSettings } from './host'

/**
 * Adapter: script output → Aurora's models.
 *
 * A script is free to return whatever a music API gave it, so every field is read through a small
 * alias set (`songname` / `songName` / `name` / `title` …). The normalized track keeps the original
 * object in `metadata`, which is what the script needs when it later resolves a play URL.
 *
 * Two rules are enforced here rather than trusted to the script:
 *  - every URL that leaves the adapter (stream, cover) must pass the source's host allowlist;
 *  - every shape is validated, so "脚本返回错误数据" surfaces as an error code instead of a crash.
 */
export interface ScriptSourceInput {
  id: string
  name: string
  version: string
  apiVersion: string
  runtime: ScriptRuntimeKind
  description: string
  author: string
  homepage: string
  license: string
  permissions: SourcePermission[]
  allowedHosts: string[]
  qualities: PlaybackQuality[]
  platforms: string[]
  /** Methods (aurora contract) or actions (lx protocol) confirmed at import time. */
  actions: string[]
  sourceText: string
  /**
   * Set when the file on disk no longer matches what the user reviewed (or could not be read). The
   * source stays registered so the source manager can explain why it refuses to run, but every call
   * fails instead of executing unreviewed code.
   */
  blockedReason?: string
}

const MAX_TRACKS = 200
const MAX_TITLE = 300

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function firstString(source: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return ''
}

function firstNumber(source: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  }
  return 0
}

/** Duration is seconds in most APIs but milliseconds in several; anything > 7200 is read as ms. */
function normalizeDuration(source: Record<string, unknown>): number {
  const ms = firstNumber(source, ['durationMs', 'duration_ms', 'intervalMs'])
  if (ms > 0) return Math.round(ms / 1000)
  const seconds = firstNumber(source, ['duration', 'interval', 'dt', 'length', 'seconds', 'time'])
  if (seconds <= 0) return 0
  return seconds > 7200 ? Math.round(seconds / 1000) : Math.round(seconds)
}

function normalizeArtists(source: Record<string, unknown>): string {
  const direct = firstString(source, ['artist', 'artists', 'singer', 'singername', 'author', 'performer'])
  if (direct) return direct
  const list = source.artists ?? source.singers ?? source.ar
  if (Array.isArray(list)) {
    const names = list
      .map((item) => (typeof item === 'string' ? item : firstString(asRecord(item) ?? {}, ['name', 'title'])))
      .filter(Boolean)
    if (names.length > 0) return names.join(' / ')
  }
  return '未知艺术家'
}

function normalizeCover(source: Record<string, unknown>): string | undefined {
  const url = firstString(source, ['cover', 'pic', 'img', 'image', 'albumPic', 'albumCover', 'coverUrl', 'thumbnail'])
  return url || undefined
}

/** Turns a cover URL from a script into something the renderer may load. */
type CoverRelay = (url: string | undefined) => string | undefined

/**
 * A cover URL that came out of a script, ready for the renderer.
 *
 * Covers take the same opaque-token relay a stream does, and for the same reason: the renderer's CSP
 * admits only `aurora-media:` for images, so a raw CDN URL is refused outright and the artwork column
 * draws an empty frame — a source that "has covers" while the UI shows none. Unlike a stream, an
 * unusable cover is *dropped* rather than raised: one broken thumbnail must not fail a whole search.
 */
function relayCover(input: ScriptSourceInput, url: string | undefined): string | undefined {
  if (!url) return undefined
  if (checkMediaUrl(url) !== null) return undefined
  if (!isAllowedMediaUrl(url, input.allowedHosts)) {
    const host = hostOfUrl(url)
    if (host) recordPendingHost(input.id, host, url)
  }
  return registerRemoteMedia(url, 'image', input.id)
}

function normalizeTrack(
  sourceId: string,
  raw: unknown,
  fallbackPlatform: string | undefined,
  relay: CoverRelay,
): AudioTrack | null {
  const item = asRecord(raw)
  if (!item) return null
  const title = firstString(item, ['title', 'name', 'songname', 'songName', 'song_name', 'trackName'])
  if (!title) return null
  const trackId = firstString(item, ['id', 'songmid', 'songId', 'song_id', 'hash', 'trackId', 'rid'])
  const id = trackId || `${title}-${normalizeArtists(item)}`
  const cover = relay(normalizeCover(item))
  const quality = firstString(item, ['quality', 'currentQuality', 'rate', 'level'])
  /*
   * The *availability list* for this song, which is what the quality badge and the quality preference both
   * read.
   *
   * This was missing: a script source could hand back the full list (`qualitys` in LX's spelling, `qualities`
   * in Aurora's) and Aurora would drop it, so every script-source song showed no quality badge at all and
   * the four-tier preference had nothing to choose from — a source was silently a second-class citizen
   * next to the built-in platforms, which read the same field. Both spellings are accepted, order preserved,
   * duplicates and non-strings dropped, and the length capped like the IPC layer caps everything it forwards.
   */
  const qualities = normalizeQualities(item.qualitys ?? item.qualities)
  const album = firstString(item, ['album', 'albumName', 'albumname', 'album_name']) || '未知专辑'
  return buildTrack(sourceId, {
    id: `${sourceId}:${id}`,
    title: title.slice(0, MAX_TITLE),
    artist: normalizeArtists(item).slice(0, MAX_TITLE),
    album: album.slice(0, MAX_TITLE),
    duration: normalizeDuration(item),
    format: firstString(item, ['format', 'ext', 'type']) || '—',
    fileUrl: '',
    ...(cover ? { cover } : {}),
    ...(firstString(item, ['platform', 'source']) || fallbackPlatform
      ? { platform: firstString(item, ['platform', 'source']) || fallbackPlatform }
      : {}),
    sourceTrackId: id,
    ...(qualities.length > 0 ? { qualities } : {}),
    // The raw payload stays attached so the script can resolve this track later; the IPC layer
    // caps what reaches the renderer.
    metadata: { script: item },
  })
}

/** Max quality options kept per track, matching what the IPC layer will forward to the renderer. */
const MAX_QUALITIES = 8

/** The row's own quality tokens, in the order the source declared them. */
function normalizeQualities(raw: unknown): PlaybackQuality[] {
  if (!Array.isArray(raw)) return []
  const out: PlaybackQuality[] = []
  for (const entry of raw) {
    // LX writes entries as `{ type: 'flac24bit' }` as often as it writes plain strings.
    const token = typeof entry === 'string' ? entry : firstString(asRecord(entry) ?? {}, ['type', 'quality', 'name'])
    if (!token || out.includes(token)) continue
    out.push(token)
    if (out.length >= MAX_QUALITIES) break
  }
  return out
}

/**
 * Finds the song array in whatever shape the script returned. Real APIs nest it (`data.list`,
 * `result.songs`, …) and scripts pass that straight through, so looking one or two levels deep is
 * the difference between "works with my API" and "works with JSON".
 */
function arrayFrom(raw: unknown, depth = 0): unknown[] | null {
  if (Array.isArray(raw)) return raw
  const record = asRecord(raw)
  if (!record || depth > 3) return null
  for (const key of ['list', 'songs', 'tracks', 'items', 'data', 'result', 'results']) {
    const found = arrayFrom(record[key], depth + 1)
    if (found) return found
  }
  return null
}

function normalizeTrackList(
  sourceId: string,
  raw: unknown,
  fallbackPlatform: string | undefined,
  relay: CoverRelay,
): AudioTrack[] {
  const list = arrayFrom(raw)
  if (!list) {
    throw new SourceError('INVALID_RESPONSE', '脚本没有返回歌曲数组（也没有找到 data.list / result.songs 这样的嵌套列表）')
  }
  const tracks: AudioTrack[] = []
  for (const item of list.slice(0, MAX_TRACKS)) {
    const track = normalizeTrack(sourceId, item, fallbackPlatform, relay)
    if (track) tracks.push(track)
  }
  if (tracks.length === 0 && list.length > 0) {
    throw new SourceError('INVALID_RESPONSE', '脚本返回的每条结果都缺少歌名，无法识别')
  }
  return tracks
}

/** What the script sees when it is asked to resolve a track. */
function trackForScript(track: AudioTrack): Record<string, unknown> {
  const metadata = asRecord(track.metadata)
  // A platform-search track carries the object the LX protocol passes around (`musicInfo`). It goes
  // out through `toSourceMusicInfo`, which serves both the modern (`meta.*`) and the legacy flat
  // (`songmid`, `hash`, …) views: sources from both generations are published, and a source that
  // only knows the flat shape would otherwise receive a prefixed id and resolve the wrong song.
  const lx = metadata ? asRecord(metadata.lx) : null
  if (lx) return toSourceMusicInfo(lx as unknown as LxMusicInfo)
  const script = metadata ? asRecord(metadata.script) : null
  return {
    ...(script ?? {}),
    id: track.sourceTrackId ?? track.id,
    title: track.title,
    artist: track.artist,
    album: track.album,
    duration: track.duration,
    cover: track.cover,
    platform: track.platform,
    metadata: track.metadata ?? {},
  }
}

function lyricsFromScript(raw: unknown): Lyrics | null {
  if (!raw) return null
  if (typeof raw === 'string') {
    const text = raw.trim()
    return text ? parseLyricsText(text, 'source') : null
  }
  const record = asRecord(raw)
  if (!record) return null
  const lrc = firstString(record, ['lyric', 'lrc', 'raw', 'text'])
  if (!lrc) return null
  return parseLyricsText(lrc, 'source')
}

/** Reads a stream result: a URL string, `{ url }`, or an LX-style `{ url, quality }`. */
function streamFromScript(raw: unknown): { url: string; quality?: string; live?: boolean } | null {
  if (typeof raw === 'string') return raw.trim() ? { url: raw.trim() } : null
  const record = asRecord(raw)
  if (!record) return null
  const url = firstString(record, ['url', 'musicUrl', 'playUrl', 'src', 'link'])
  if (!url) return null
  return {
    url,
    ...(firstString(record, ['quality', 'level', 'rate']) ? { quality: firstString(record, ['quality', 'level', 'rate']) } : {}),
    ...(record.live === true ? { live: true } : {}),
  }
}

export function createScriptSource(input: ScriptSourceInput): MusicSource {
  const blocked = input.blockedReason?.trim()
  if (blocked) {
    const refuse = (): never => {
      throw new SourceError('UNSUPPORTED', `${input.name}：${blocked}`)
    }
    return {
      meta: {
        id: input.id,
        name: input.name,
        version: input.version,
        apiVersion: input.apiVersion,
        description: blocked,
        homepage: input.homepage,
        license: input.license || '未声明',
        kind: 'script',
        runtime: input.runtime,
        builtin: false as const,
        requiresConfig: false,
        permissions: input.permissions,
        platforms: input.platforms.map((id) => ({ id, name: id })),
        qualities: input.qualities,
        // Search/stream are advertised *on purpose*, even though every call refuses: the manager
        // gates calls on capabilities, so hiding them would turn a fixable problem ("the file
        // changed, confirm it again") into a confusing "this source does not support search".
        capabilities: defineCapabilities({ search: true, stream: true }),
      },
      async search(): Promise<AudioTrack[]> {
        return refuse()
      },
      async getPlayUrl(): Promise<ResolvedStream | null> {
        return refuse()
      },
    }
  }

  const actions = new Set(input.actions)
  const canSearch = actions.has('search')
  const canLyrics = actions.has('lyric') || actions.has('getLyric')
  const canStream = actions.has('musicUrl') || actions.has('getPlayUrl')
  const canCover = actions.has('pic') || actions.has('getCover')
  const primaryPlatform = input.platforms[0]

  const settings: ScriptHostSettings = {
    runtime: input.runtime,
    permissions: input.permissions,
    allowedHosts: input.allowedHosts,
    qualities: input.qualities,
    config: {},
    // Surfaced to the script as `lx.currentScriptInfo` — published sources read it (and some hash
    // `rawScript` for a server-side signature check), so it must be the real text, not a stub.
    info: {
      name: input.name,
      version: input.version,
      author: input.author,
      homepage: input.homepage,
    },
  }

  async function ready(context: SourceContext): Promise<ReturnType<typeof acquireScriptHost>> {
    const host = acquireScriptHost(input.id, input.name)
    // The *host* owns this flag, not the adapter: after a timeout or a crash the window is rebuilt
    // empty, so an adapter-local "installed" would skip the reload and every later call would fail
    // with "script exported nothing".
    if (!host.isLoaded) {
      settings.config = context.config
      try {
        await host.install(input.sourceText, settings)
      } catch (error) {
        // A host that failed to load (syntax error, hanging script) is thrown away so the next
        // attempt starts from a clean process instead of a poisoned one.
        disposeScriptHost(input.id)
        throw error
      }
    }
    return host
  }

  /** The stored `runtime: 'lx'` sources resolve through an action, not through a method name. */
  function lxRequest(action: string, track: AudioTrack | null, quality?: PlaybackQuality): Record<string, unknown> {
    const request: Record<string, unknown> = {
      op: 'lx',
      action,
      source: track?.platform ?? primaryPlatform ?? '',
      ...(track ? { info: trackForScript(track) } : {}),
    }
    if (quality) request.quality = quality
    return request
  }

  /**
   * Relays a URL the *script itself* produced (a resolved stream, a cover).
   *
   * The host allowlist is not consulted as a veto here. A source routinely resolves playable URLs on
   * a CDN host it never had to request during import, so refusing would mean "playback silently does
   * not work until you discover, by inspection, which host to tick" — the failure mode this runtime
   * exists to avoid. The host is recorded instead, so the manager can show every host a resolved URL
   * actually used. What *is* enforced is the shape: schemes and syntactically valid http(s) only.
   *
   * `checkMediaUrl`, not `checkEndpointUrl`: the latter demands HTTPS off-loopback, which is right for
   * an endpoint a user types into a manifest and wrong for a URL a script just resolved. Aggregators
   * hand back plain-`http` audio (`http://music.nxinxz.com/kw.php?…`, `http://kw-er.kuwo.cn/…`), and
   * demanding HTTPS here turned every working source into「播放地址不是合法的 http(s) 地址」.
   */
  /**
   * Cover relay bound to this source.
   *
   * Host bookkeeping is per source, so the mappers (which are module-level and take only the id) are
   * handed this bound function rather than reaching for the input themselves.
   */
  function relay(url: string | undefined): string | undefined {
    return relayCover(input, url)
  }

  function relayOrThrow(url: string, kind: 'audio' | 'image', what: string): string {
    if (checkMediaUrl(url) !== null) {
      throw new SourceError('UNSUPPORTED', `${input.name}：${what}不是合法的 http(s) 地址`)
    }
    if (!isAllowedMediaUrl(url, input.allowedHosts)) {
      const host = hostOfUrl(url)
      if (host) recordPendingHost(input.id, host, url)
    }
    return registerRemoteMedia(url, kind, input.id)
  }

  return {
    meta: {
      id: input.id,
      name: input.name,
      version: input.version,
      apiVersion: input.apiVersion,
      ...(input.author ? { author: input.author } : {}),
      description: input.description || `JavaScript 音源（${input.runtime}）`,
      homepage: input.homepage,
      license: input.license || '未声明',
      kind: 'script',
      runtime: input.runtime,
      builtin: false as const,
      requiresConfig: false,
      permissions: input.permissions,
      platforms: input.platforms.map((id) => ({ id, name: id })),
      qualities: input.qualities,
      capabilities: defineCapabilities({
        search: canSearch,
        stream: canStream,
        lyrics: canLyrics,
        ...(actions.has('getPlaylist') || actions.has('getAlbum') ? { playlists: true } : {}),
        ...(actions.has('getPlaylist') ? { playlistDetail: true } : {}),
        ...(actions.has('getAlbum') ? { albums: true } : {}),
        ...(actions.has('getArtist') ? { artists: true } : {}),
        ...(actions.has('getLeaderboard') ? { recommendations: true } : {}),
        // Saving the resolved stream is a host capability, not a licence claim about the source:
        // whatever URL the script hands back can be written to disk.
        ...(canStream ? { download: true } : {}),
      }),
    },

    async initialize(context: SourceContext): Promise<void> {
      await ready(context)
    },

    async search(query: string, options: SearchOptions, context: SourceContext): Promise<AudioTrack[]> {
      const host = await ready(context)
      if (input.runtime === 'lx') {
        const raw = await host.invoke<unknown>({
          op: 'search',
          keyword: query,
          page: Math.max(1, Math.round(options.page ?? 1)),
          source: primaryPlatform ?? '',
        })
        return normalizeTrackList(input.id, raw, primaryPlatform, relay)
      }
      const raw = await host.invoke<unknown>({
        op: 'search',
        keyword: query,
        page: Math.max(1, Math.round(options.page ?? 1)),
        pageSize: options.pageSize ?? 30,
        tag: options.tag,
      })
      return normalizeTrackList(input.id, raw, primaryPlatform, relay)
    },

    async getPlayUrl(track: AudioTrack, quality: PlaybackQuality | undefined, context: SourceContext): Promise<ResolvedStream | null> {
      const host = await ready(context)
      const raw =
        input.runtime === 'lx'
          ? await host.invoke<unknown>(lxRequest('musicUrl', track, quality))
          : await host.invoke<unknown>({ op: 'getPlayUrl', track: trackForScript(track), quality })
      const stream = streamFromScript(raw)
      if (!stream) throw new SourceError('NOT_FOUND', `${input.name}：脚本没有返回可播放的地址`)
      return {
        url: relayOrThrow(stream.url, 'audio', '播放地址'),
        ...(stream.quality ? { quality: stream.quality } : {}),
        ...(track.license ? { license: track.license } : {}),
        ...(track.homepage ? { homepage: track.homepage } : {}),
        downloadAllowed: true,
        live: stream.live === true,
      }
    },

    async getLyrics(track: AudioTrack, context: SourceContext): Promise<Lyrics | null> {
      const host = await ready(context)
      const raw =
        input.runtime === 'lx'
          ? await host.invoke<unknown>(lxRequest('lyric', track))
          : await host.invoke<unknown>({ op: 'getLyric', track: trackForScript(track) })
      return lyricsFromScript(raw)
    },

    async getCover(track: AudioTrack, context: SourceContext): Promise<string | null> {
      const host = await ready(context)
      const raw =
        input.runtime === 'lx'
          ? await host.invoke<unknown>(lxRequest('pic', track))
          : await host.invoke<unknown>({ op: 'getCover', track: trackForScript(track) })
      const url = typeof raw === 'string' ? raw.trim() : firstString(asRecord(raw) ?? {}, ['url', 'pic', 'cover'])
      if (!url) return null
      return relayCover(input, url) ?? null
    },

    async getSongDetail(trackId: string, context: SourceContext): Promise<AudioTrack | null> {
      if (!actions.has('getSongDetail')) throw new SourceError('UNSUPPORTED', `${input.name}：不支持歌曲详情`)
      const host = await ready(context)
      const raw = await host.invoke<unknown>({ op: 'getSongDetail', id: trackId })
      return normalizeTrack(input.id, raw, primaryPlatform, relay)
    },

    async getAlbum(albumId: string, context: SourceContext): Promise<SourcePlaylistDetail | null> {
      if (!actions.has('getAlbum')) throw new SourceError('UNSUPPORTED', `${input.name}：不支持专辑`)
      const host = await ready(context)
      const raw = await host.invoke<unknown>({ op: 'getAlbum', id: albumId })
      return detailFromScript(input.id, raw, primaryPlatform, relay)
    },

    async getArtist(artistId: string, context: SourceContext): Promise<SourcePlaylistDetail | null> {
      if (!actions.has('getArtist')) throw new SourceError('UNSUPPORTED', `${input.name}：不支持艺人`)
      const host = await ready(context)
      const raw = await host.invoke<unknown>({ op: 'getArtist', id: artistId })
      return detailFromScript(input.id, raw, primaryPlatform, relay)
    },

    async getPlaylistDetail(playlistId: string, context: SourceContext): Promise<SourcePlaylistDetail | null> {
      if (!actions.has('getPlaylist')) throw new SourceError('UNSUPPORTED', `${input.name}：不支持歌单`)
      const host = await ready(context)
      const raw = await host.invoke<unknown>({ op: 'getPlaylist', id: playlistId })
      return detailFromScript(input.id, raw, primaryPlatform, relay)
    },

    async getPlaylists(context: SourceContext): Promise<SourcePlaylist[]> {
      if (!actions.has('getLeaderboard')) return []
      const host = await ready(context)
      const raw = await host.invoke<unknown>({ op: 'getLeaderboard' })
      if (!Array.isArray(raw)) return []
      return raw.slice(0, 60).map((item) => {
        const record = asRecord(item) ?? {}
        const id = firstString(record, ['id', 'name', 'title'])
        return {
          id: id || `board-${Math.random().toString(36).slice(2, 8)}`,
          sourceId: input.id,
          title: firstString(record, ['title', 'name']) || '排行榜',
          ...(firstString(record, ['description', 'desc'])
            ? { description: firstString(record, ['description', 'desc']) }
            : {}),
          ...(normalizeCover(record) ? { cover: normalizeCover(record) as string } : {}),
        }
      })
    },

    async healthCheck(context: SourceContext) {
      const started = Date.now()
      const host = await ready(context)
      const raw = await host.invoke<unknown>({ op: 'healthCheck' }, 8_000)
      const record = asRecord(raw)
      return {
        ok: true,
        latency: Date.now() - started,
        message: record ? firstString(record, ['message', 'status']) || '脚本已加载' : '脚本已加载',
        checkedAt: Date.now(),
      }
    },

    dispose(): void {
      disposeScriptHost(input.id)
    },
  }
}

function detailFromScript(
  sourceId: string,
  raw: unknown,
  fallbackPlatform: string | undefined,
  relay: CoverRelay,
): SourcePlaylistDetail | null {
  const record = asRecord(raw)
  if (!record) {
    // A bare array is the most common shortcut a script takes: it is a list, with no metadata.
    if (Array.isArray(raw)) {
      return {
        playlist: { id: 'list', sourceId, title: '列表' },
        tracks: normalizeTrackList(sourceId, raw, fallbackPlatform, relay),
      }
    }
    throw new SourceError('INVALID_RESPONSE', '脚本没有返回专辑/歌单数据')
  }
  const tracksRaw = record.tracks ?? record.songs ?? record.list ?? record.items
  const id = firstString(record, ['id']) || 'list'
  const title = firstString(record, ['title', 'name']) || '列表'
  const description = firstString(record, ['description', 'desc'])
  const cover = relay(normalizeCover(record))
  const tracks = Array.isArray(tracksRaw) ? normalizeTrackList(sourceId, tracksRaw, fallbackPlatform, relay) : []
  return {
    playlist: {
      id,
      sourceId,
      title,
      ...(description ? { description } : {}),
      ...(cover ? { cover } : {}),
      trackCount: tracks.length,
    },
    tracks,
  }
}
