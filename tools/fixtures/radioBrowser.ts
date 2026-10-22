import type { AudioTrack, ResolvedStream, SearchOptions, SourceHealth, SourcePlaylist, SourcePlaylistDetail } from '../../src/shared/types'
import { fetchJsonFromMirrors } from '../../src/main/sources/http'
import { SourceError } from '../../src/main/sources/errors'
import { registerRemoteMedia } from '../../src/main/remote'
import { buildTrack, defineCapabilities, type MusicSource, type SourceContext } from '../../src/main/sources/types'

/**
 * Radio Browser — a community-maintained, open directory of public internet radio stations.
 * No API key required. Stations are public streams, so live radio has no duration and no seeking.
 *
 * Documented endpoints used here (json API on independent mirrors):
 *   /json/stations/search, /json/stations/byuuid, /json/tags, /json/stats
 * "Playlists" for this source are Radio Browser's own tag collections: real, API-provided
 * groupings of stations, not invented curated content.
 */
const MIRRORS = [
  'https://de1.api.radio-browser.info',
  'https://at1.api.radio-browser.info',
  'https://nl1.api.radio-browser.info',
  'https://fi1.api.radio-browser.info',
]

const UNPLAYABLE_SUFFIXES = ['.m3u', '.pls', '.m3u8', '.xspf', '.asx']
const STATION_CACHE_LIMIT = 2000
const LABEL = 'Radio Browser'

interface Station {
  stationuuid: string
  name: string
  url?: string
  url_resolved?: string
  favicon?: string
  country?: string
  tags?: string
  codec?: string
  bitrate?: number
  votes?: number
  clickcount?: number
}

interface TagEntry {
  name: string
  stationcount: number
}

interface RadioStats {
  stations?: number
  stations_broken?: number
  tags?: number
  countries?: number
}

/**
 * Stations seen during a search are remembered briefly so playback does not need a second API
 * round-trip just to look up a stream URL (search results are cached, so their ids stay valid).
 */
const stationCache = new Map<string, Station>()

function rememberStation(station: Station): void {
  if (stationCache.size >= STATION_CACHE_LIMIT) stationCache.clear()
  stationCache.set(station.stationuuid, station)
}

function endpoint(path: string): string[] {
  return MIRRORS.map((mirror) => `${mirror}${path}`)
}

function pickStreamUrl(station: Station): string {
  const candidate = station.url_resolved || station.url || ''
  return candidate.startsWith('http') ? candidate : ''
}

function isDirectlyPlayable(url: string): boolean {
  if (!url.startsWith('http')) return false
  const lower = url.toLowerCase()
  return !UNPLAYABLE_SUFFIXES.some((suffix) => lower.includes(suffix))
}

function toTrack(station: Station): AudioTrack | null {
  const streamUrl = pickStreamUrl(station)
  if (!isDirectlyPlayable(streamUrl)) return null
  rememberStation(station)
  const bitrateLabel = station.bitrate ? `${Math.round(station.bitrate)}kbps` : (station.codec ?? 'STREAM')
  return buildTrack('radio-browser', {
    id: `radio-browser:${station.stationuuid}`,
    title: station.name?.trim() || '未命名电台',
    artist: station.country?.trim() || '网络电台',
    album: station.tags ? station.tags.split(',').slice(0, 3).join(' · ') : '公共网络电台',
    duration: 0,
    format: bitrateLabel.toUpperCase().slice(0, 10),
    fileUrl: '',
    cover: station.favicon ? registerRemoteMedia(station.favicon, 'image', 'radio-browser') : undefined,
    sourceTrackId: station.stationuuid,
    homepage: 'https://www.radio-browser.info/',
  })
}

function stationQuery(query: string, options: SearchOptions, limit: number): URLSearchParams {
  const params = new URLSearchParams({
    limit: String(limit),
    hidebroken: 'true',
    order: 'clickcount',
    reverse: 'true',
  })
  const trimmed = query.trim()
  if (trimmed) params.set('name', trimmed)
  if (options.tag) params.set('tag', options.tag)
  // No keyword and no genre: fall back to the directory's most-clicked stations.
  if (!trimmed && !options.tag) params.set('tag', 'jazz')
  return params
}

async function searchStations(query: string, options: SearchOptions, limit: number): Promise<Station[]> {
  const params = stationQuery(query, options, limit)
  const payload = await fetchJsonFromMirrors<Station[]>(endpoint(`/json/stations/search?${params.toString()}`), {
    label: LABEL,
    timeoutMs: 10_000,
    retries: 0,
    sourceId: 'radio-browser',
  })
  if (!Array.isArray(payload)) throw new SourceError('INVALID_RESPONSE', `${LABEL}：返回格式不正确`)
  return payload
}

function clampLimit(requested: number | undefined, fallback: number, max: number): number {
  const value = Number.isFinite(requested) ? Number(requested) : fallback
  return Math.min(Math.max(Math.trunc(value), 1), max)
}

async function resolveStation(trackId: string, context: SourceContext): Promise<ResolvedStream | null> {
  const cached = stationCache.get(trackId)
  if (cached && isDirectlyPlayable(pickStreamUrl(cached))) return streamFor(cached, context)
  const stations = await fetchJsonFromMirrors<Station[]>(endpoint(`/json/stations/byuuid?uuids=${encodeURIComponent(trackId)}`), {
    label: LABEL,
    timeoutMs: 10_000,
    retries: 1,
    sourceId: 'radio-browser',
  })
  const station = Array.isArray(stations) ? stations[0] : undefined
  if (!station || !isDirectlyPlayable(pickStreamUrl(station))) return null
  rememberStation(station)
  return streamFor(station, context)
}

function streamFor(station: Station, context: SourceContext): ResolvedStream | null {
  const streamUrl = pickStreamUrl(station)
  if (!isDirectlyPlayable(streamUrl)) return null
  return {
    url: registerRemoteMedia(streamUrl, 'audio', 'radio-browser'),
    license: '公共网络电台流',
    homepage: station.url,
    // Live radio is never downloadable, regardless of the global preference.
    downloadAllowed: false,
    live: true,
  }
}

export const radioBrowserSource: MusicSource = {
  meta: {
    id: 'radio-browser',
    name: 'Radio Browser',
    version: '1.0.0',
    apiVersion: '1',
    author: 'Aurora',
    icon: '📻',
    description: '全球公共网络电台目录，社区维护，无需 API Key',
    homepage: 'https://www.radio-browser.info/',
    license: '电台公开流（各电台自行提供）',
    capabilities: defineCapabilities({
      search: true,
      stream: true,
      radio: true,
      playlists: true,
      playlistDetail: true,
      recommendations: true,
    }),
    requiresConfig: false,
    builtin: true,
    kind: 'builtin',
    permissions: ['network'],
    qualities: ['unknown'],
  },

  async search(query, options): Promise<AudioTrack[]> {
    const stations = await searchStations(query, options, clampLimit(options.pageSize, 40, 100))
    return stations.map(toTrack).filter((track): track is AudioTrack => track !== null)
  },

  async getRecommendations(options): Promise<AudioTrack[]> {
    const stations = await searchStations('', { tag: options.tag }, clampLimit(options.pageSize, 12, 60))
    return stations.map(toTrack).filter((track): track is AudioTrack => track !== null)
  },

  async getPlaylists(): Promise<SourcePlaylist[]> {
    const tags = await fetchJsonFromMirrors<TagEntry[]>(
      endpoint('/json/tags?order=stationcount&reverse=true&hidebroken=true&limit=30'),
      { label: LABEL, timeoutMs: 10_000, retries: 0, sourceId: 'radio-browser' },
    )
    if (!Array.isArray(tags)) return []
    return tags
      .filter((tag) => tag?.name && Number.isFinite(tag.stationcount))
      .map((tag) => ({
        id: tag.name,
        sourceId: 'radio-browser',
        title: tag.name,
        description: `Radio Browser 标签「${tag.name}」下的公共电台`,
        creator: 'Radio Browser 社区',
        trackCount: tag.stationcount,
        tags: [tag.name],
        homepage: 'https://www.radio-browser.info/',
      }))
  },

  async getPlaylistDetail(playlistId): Promise<SourcePlaylistDetail | null> {
    const stations = await searchStations('', { tag: playlistId }, 60)
    const tracks = stations.map(toTrack).filter((track): track is AudioTrack => track !== null)
    return {
      playlist: {
        id: playlistId,
        sourceId: 'radio-browser',
        title: playlistId,
        description: `Radio Browser 标签「${playlistId}」下的公共电台`,
        creator: 'Radio Browser 社区',
        trackCount: tracks.length,
        tags: [playlistId],
        homepage: 'https://www.radio-browser.info/',
      },
      tracks,
    }
  },

  async resolve(trackId, context): Promise<ResolvedStream | null> {
    return resolveStation(trackId, context)
  },

  async healthCheck(): Promise<SourceHealth> {
    const started = Date.now()
    const stats = await fetchJsonFromMirrors<RadioStats>(endpoint('/json/stats'), {
      label: LABEL,
      timeoutMs: 6_000,
      retries: 0,
      sourceId: 'radio-browser',
    })
    const stations = Number(stats?.stations ?? 0)
    return {
      ok: true,
      latency: Date.now() - started,
      message: stations > 0 ? `目录中共 ${stations} 个电台` : '目录可访问',
      checkedAt: Date.now(),
    }
  },
}
