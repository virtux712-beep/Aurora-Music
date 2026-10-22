import type { AudioTrack, ResolvedStream, SearchOptions, SourceHealth } from '../../src/shared/types'
import { fetchJson } from '../../src/main/sources/http'
import { SourceError } from '../../src/main/sources/errors'
import { registerRemoteMedia } from '../../src/main/remote'
import { buildTrack, defineCapabilities, type MusicSource, type SourceContext } from '../../src/main/sources/types'

/**
 * Jamendo — one of the two sources Aurora ships with. Requires the user to register a free client
 * id; Aurora never ships one, and the value is stored encrypted (see `secretStore.ts`).
 *
 * The `license` / `homepage` fields below are metadata about this catalogue; they are not an
 * admission rule for anyone else's source.
 *
 * Documented endpoints used here: `/tracks` (with `search` and `tags` filters, `order`).
 * Downloads are only offered when the author allowed them (`audiodownload_allowed`).
 */
const API_BASE = 'https://api.jamendo.com/v3.0'
const LABEL = 'Jamendo'

interface JamendoTrack {
  id: string
  name: string
  duration: number
  artist_name: string
  album_name?: string
  album_image?: string
  image?: string
  audio?: string
  audiodownload?: string
  audiodownload_allowed?: boolean
  license_ccurl?: string
  shareurl?: string
  releasedate?: string
}

interface JamendoResponse {
  headers: { status: string; error_message?: string; results_count?: number }
  results: JamendoTrack[]
}

function clientIdOf(context: SourceContext): string {
  const value = context.config.clientId
  const clientId = typeof value === 'string' ? value.trim() : ''
  if (!clientId) throw new SourceError('NEEDS_CONFIG', '请先在「设置 → 音源管理」填写 Jamendo client id')
  return clientId
}

async function callApi(query: string, context: SourceContext): Promise<JamendoTrack[]> {
  const clientId = clientIdOf(context)
  const url = `${API_BASE}/tracks/?client_id=${encodeURIComponent(clientId)}&format=json&include=musicinfo&audioformat=mp32&${query}`
  const payload = await fetchJson<JamendoResponse>(url, { label: LABEL, timeoutMs: 15_000, retries: 1, sourceId: 'jamendo' })
  if (payload.headers?.status !== 'success') {
    const message = payload.headers?.error_message ?? 'Jamendo 返回错误状态'
    if (message.toLowerCase().includes('client_id')) throw new SourceError('UNAUTHORIZED', `${LABEL}：client id 无效或缺失`)
    throw new SourceError('INVALID_RESPONSE', `${LABEL}：${message}`)
  }
  return Array.isArray(payload.results) ? payload.results : []
}

function toTrack(item: JamendoTrack): AudioTrack {
  const year = item.releasedate ? Number(item.releasedate.slice(0, 4)) : undefined
  const cover = item.image || item.album_image
  return buildTrack('jamendo', {
    id: `jamendo:${item.id}`,
    title: item.name?.trim() || '未命名曲目',
    artist: item.artist_name?.trim() || '未知艺术家',
    album: item.album_name?.trim() || 'Jamendo',
    duration: Number.isFinite(item.duration) ? item.duration : 0,
    format: year ? `CC · ${year}` : 'CC',
    fileUrl: '',
    cover: cover ? registerRemoteMedia(cover, 'image', 'jamendo') : undefined,
    sourceTrackId: item.id,
    license: item.license_ccurl,
    homepage: item.shareurl,
    year: Number.isFinite(year) ? year : undefined,
  })
}

function resolveStream(item: JamendoTrack, context: SourceContext): ResolvedStream | null {
  const directUrl = item.audio || item.audiodownload
  if (!directUrl) return null
  return {
    url: registerRemoteMedia(directUrl, 'audio', 'jamendo'),
    license: item.license_ccurl,
    homepage: item.shareurl,
    // Saving the stream is a host capability, not a licence verdict: the catalogue API only hands
    // back an audio URL at all when the item is playable, so a resolved URL is downloadable. (The
    // `audiodownload` variant, when present and authorised, is preferred for the highest quality.)
    downloadAllowed: true,
    live: false,
  }
}

export const jamendoSource: MusicSource = {
  meta: {
    id: 'jamendo',
    name: 'Jamendo',
    version: '1.0.0',
    apiVersion: '1',
    author: 'Aurora',
    icon: '🎧',
    description: 'Creative Commons 曲库，需要免费的 client id',
    homepage: 'https://developer.jamendo.com/v3.0',
    license: 'Creative Commons（逐曲标注）',
    capabilities: defineCapabilities({ search: true, stream: true, download: true, recommendations: true }),
    requiresConfig: true,
    builtin: true,
    kind: 'builtin',
    permissions: ['network'],
    qualities: ['128k', '320k'],
    configSchema: {
      fields: [
        {
          key: 'clientId',
          label: 'Client ID',
          type: 'password',
          secret: true,
          required: true,
          placeholder: '粘贴你的 Jamendo client id',
          description: '在 developer.jamendo.com 免费注册应用后获得；Aurora 不内置任何 key，保存后使用系统密钥链加密存储。',
        },
      ],
    },
  },

  isConfigured(config): boolean {
    return typeof config.clientId === 'string' && config.clientId.trim().length > 0
  },

  async search(query, options, context): Promise<AudioTrack[]> {
    const params = new URLSearchParams({
      search: query.trim() || 'chill',
      limit: String(Math.min(Math.max(options.pageSize ?? 40, 1), 50)),
      order: 'popularity_total',
    })
    if (options.tag) params.set('tags', options.tag)
    const results = await callApi(params.toString(), context)
    return results.map(toTrack)
  },

  async getRecommendations(options, context): Promise<AudioTrack[]> {
    const params = new URLSearchParams({
      limit: String(Math.min(Math.max(options.pageSize ?? 12, 1), 30)),
      order: 'popularity_total',
    })
    if (options.tag) params.set('tags', options.tag)
    const results = await callApi(params.toString(), context)
    return results.map(toTrack)
  },

  async resolve(trackId, context): Promise<ResolvedStream | null> {
    const results = await callApi(`id=${encodeURIComponent(trackId)}`, context)
    const item = results[0]
    if (!item) return null
    return resolveStream(item, context)
  },

  async healthCheck(context): Promise<SourceHealth> {
    const started = Date.now()
    // A single-track query is the cheapest authenticated probe the API offers.
    const results = await callApi('limit=1&order=popularity_total', context)
    return {
      ok: true,
      latency: Date.now() - started,
      message: `连接正常，可访问 ${results.length} 条样本`,
      checkedAt: Date.now(),
    }
  },
}
