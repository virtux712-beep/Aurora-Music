import {
  hasPlaceholders,
  isAllowedMediaUrl,
  type CustomFieldMap,
  type CustomRequestTemplate,
  type CustomSourceManifest,
  type CustomStreamSelection,
} from '../../shared/customSource'
import type {
  AudioTrack,
  ResolvedStream,
  SearchOptions,
  SourceHealth,
  SourcePlaylist,
  SourcePlaylistDetail,
} from '../../shared/types'
import { registerRemoteMedia } from '../remote'
import { SourceError } from '../sources/errors'
import { fetchJson } from '../sources/http'
import { buildTrack, type MusicSource, type SourceContext } from '../sources/types'

/**
 * Turns a declarative manifest into a real `MusicSource`.
 *
 * This adapter is the only thing a user-defined source can drive: URL templates, JSON paths and an
 * allow-list. No user JavaScript is executed and no Node API is reachable. Every URL — including
 * stream and cover URLs that come back *inside* API responses — is re-checked against the
 * manifest's `allowedHosts` before the main process will fetch it.
 */
const REQUEST_TIMEOUT_MS = 12_000
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const INLINE_STREAM_LIMIT = 500

/** Stream URLs seen in search responses, so playback needs no second request. */
const inlineStreams = new Map<string, string>()

function readPath(value: unknown, path: string | undefined): unknown {
  if (!path) return value
  let cursor: unknown = value
  for (const segment of path.split('.')) {
    if (!segment) continue
    if (cursor === null || cursor === undefined) return undefined
    if (Array.isArray(cursor)) {
      const index = Number(segment)
      if (!Number.isInteger(index)) return undefined
      cursor = cursor[index]
      continue
    }
    if (typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string, unknown>)[segment]
  }
  return cursor
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (value && typeof value === 'object') {
    // Some APIs wrap the array in a single-key object; unwrap only when it is unambiguous.
    const values = Object.values(value as Record<string, unknown>)
    if (values.length === 1 && Array.isArray(values[0])) return values[0]
  }
  return []
}

function asText(value: unknown, max = 300): string {
  // Catalogues such as Internet Archive legitimately return `creator` / `subject` as arrays.
  if (Array.isArray(value)) {
    for (const entry of value) {
      const text = asText(entry, max)
      if (text) return text
    }
    return ''
  }
  if (typeof value === 'string') return value.trim().slice(0, max)
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

/** Path placeholders must be percent-encoded; query values are encoded by URLSearchParams. */
function render(template: string, values: Record<string, string>, encode: boolean): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key: string) => {
    const value = values[key] ?? values[key.toLowerCase()]
    if (value === undefined) return match
    return encode ? encodeURIComponent(value) : value
  })
}

/**
 * Reads a mapped value: a URL template such as `https://archive.org/services/img/{id}` is rendered,
 * anything else is treated as a JSON path. Templates only ever produce URLs that are re-checked
 * against `allowedHosts` before use.
 */
function readMapped(
  item: unknown,
  mapping: string | undefined,
  values: Record<string, string>,
  max = 800,
): string {
  if (!mapping) return ''
  if (hasPlaceholders(mapping)) return render(mapping, values, true)
  return asText(readPath(item, mapping), max)
}

/** Picks the first list entry whose `match.field` is one of `match.equals`. */
function pickFromList(payload: unknown, selection: CustomStreamSelection): string {
  const candidates = readPath(payload, selection.list)
  if (!Array.isArray(candidates)) return ''
  for (const entry of candidates) {
    const candidate = asText(readPath(entry, selection.match.field), 120)
    if (!selection.match.equals.includes(candidate)) continue
    const value = asText(readPath(entry, selection.url), 800)
    if (value) return value
  }
  return ''
}

function configValues(manifest: CustomSourceManifest, context: SourceContext): Record<string, string> {
  const values: Record<string, string> = {}
  for (const field of manifest.config?.fields ?? []) {
    const value = context.config[field.key]
    if (value !== undefined) values[field.key] = String(value)
  }
  return values
}

function buildValues(
  manifest: CustomSourceManifest,
  context: SourceContext,
  extra: Partial<Record<'query' | 'tag' | 'id' | 'limit' | 'page', string>>,
): Record<string, string> {
  return {
    query: '',
    tag: '',
    id: '',
    limit: '20',
    page: '1',
    ...configValues(manifest, context),
    ...extra,
  }
}

function buildUrl(template: CustomRequestTemplate, values: Record<string, string>): string {
  /*
   * Placeholders are encoded by default, with a raw fallback — and the fallback is the whole point.
   *
   * Encoding is what keeps a `{query}` containing `?` or `#` from rewriting the request's structure, so
   * it stays the first choice. But a placeholder in the **authority** position cannot be encoded at all:
   * `url: 'http://{base}/search'` with `base = 127.0.0.1:5000` renders `http://127.0.0.1%3A5000/…`, which
   * is not a URL, and `new URL` throws — turning a manifest that describes a self-hosted instance into
   *「自定义音源解析失败」with nothing in the message about the placeholder. The raw substitution is only
   * tried when the encoded one does not parse, and the result is *still* checked: `callTemplate` passes
   * the manifest's host allowlist down to `fetchJson`, which parses the final URL and refuses a host the
   * source was not granted.
   */
  let url: URL
  try {
    url = new URL(render(template.url, values, true))
  } catch {
    url = new URL(render(template.url, values, false))
  }
  for (const [key, value] of Object.entries(template.query ?? {})) {
    url.searchParams.set(key, render(value, values, false))
  }
  return url.toString()
}

async function callTemplate(
  manifest: CustomSourceManifest,
  template: CustomRequestTemplate,
  values: Record<string, string>,
): Promise<unknown> {
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(template.headers ?? {})) {
    if (!value) continue
    headers[key] = render(value, values, false)
  }
  return fetchJson<unknown>(buildUrl(template, values), {
    label: manifest.name,
    sourceId: manifest.id,
    timeoutMs: REQUEST_TIMEOUT_MS,
    maxBytes: MAX_RESPONSE_BYTES,
    retries: 1,
    headers,
    // A redirect could point at a host the manifest never declared: refuse instead.
    redirect: 'error',
    hostAllowlist: manifest.allowedHosts,
  })
}

function safeMedia(url: string, kind: 'image' | 'audio', manifest: CustomSourceManifest): string | undefined {
  if (!url) return undefined
  if (!isAllowedMediaUrl(url, manifest.allowedHosts)) return undefined
  return registerRemoteMedia(url, kind, manifest.id)
}

function rememberInlineStream(sourceId: string, trackId: string, url: string): void {
  if (inlineStreams.size >= INLINE_STREAM_LIMIT) inlineStreams.clear()
  inlineStreams.set(`${sourceId}:${trackId}`, url)
}

function mapTrack(
  manifest: CustomSourceManifest,
  item: unknown,
  fields: CustomFieldMap | undefined,
  context: SourceContext,
): AudioTrack | null {
  if (!fields) return null
  const rawId = asText(readPath(item, fields.id), 200)
  const title = asText(readPath(item, fields.title))
  if (!rawId || !title) return null

  // Field templates (e.g. a cover URL built from the item id) are rendered with the usual
  // placeholders plus the item's own id.
  const values = buildValues(manifest, context, { id: rawId })

  const durationRaw = fields.duration ? asNumber(readPath(item, fields.duration)) : undefined
  const duration = durationRaw === undefined ? 0 : fields.durationUnit === 'milliseconds' ? durationRaw / 1000 : durationRaw

  const coverUrl = readMapped(item, fields.cover, values)
  const inlineStreamField = readMapped(item, fields.streamUrl, values)
  if (inlineStreamField && safeMedia(inlineStreamField, 'audio', manifest)) {
    rememberInlineStream(manifest.id, rawId, inlineStreamField)
  }

  const year = fields.year ? asNumber(readPath(item, fields.year)) : undefined

  return buildTrack(manifest.id, {
    id: `${manifest.id}:${rawId}`,
    title,
    artist: asText(readPath(item, fields.artist)) || '未知艺术家',
    album: asText(readPath(item, fields.album)) || manifest.name,
    duration: Number.isFinite(duration) ? Math.max(0, Math.round(duration)) : 0,
    format: 'API',
    fileUrl: '',
    cover: safeMedia(coverUrl, 'image', manifest),
    sourceTrackId: rawId,
    license: asText(readPath(item, fields.license), 300) || manifest.license,
    homepage: readMapped(item, fields.homepage, values, 500) || manifest.homepage,
    year: year && Number.isFinite(year) ? year : undefined,
  })
}

function mapTracks(
  manifest: CustomSourceManifest,
  payload: unknown,
  template: CustomRequestTemplate,
  fields: CustomFieldMap | undefined,
  context: SourceContext,
): AudioTrack[] {
  return asArray(readPath(payload, template.resultsPath))
    .map((item) => mapTrack(manifest, item, fields, context))
    .filter((track): track is AudioTrack => track !== null)
}

export function createCustomSource(manifest: CustomSourceManifest): MusicSource {
  const label = manifest.name
  const searchFields = manifest.search?.fields

  async function runSearch(query: string, options: SearchOptions, context: SourceContext): Promise<AudioTrack[]> {
    const template = manifest.search
    if (!template) throw new SourceError('UNSUPPORTED', `${label}：未配置 search 模板`)
    const values = buildValues(manifest, context, {
      query,
      tag: options.tag ?? '',
      limit: String(Math.min(Math.max(options.pageSize ?? 20, 1), 100)),
      page: String(Math.max(options.page ?? 1, 1)),
    })
    const payload = await callTemplate(manifest, template, values)
    return mapTracks(manifest, payload, template, searchFields, context)
  }

  const source: MusicSource = {
    meta: {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      apiVersion: manifest.apiVersion,
      author: manifest.author,
      icon: manifest.icon || '🧩',
      description: manifest.description || `用户自定义音源（${manifest.homepage}）`,
      homepage: manifest.homepage,
      license: manifest.license,
      capabilities: {
        search: Boolean(manifest.capabilities.search),
        stream: Boolean(manifest.capabilities.stream),
        lyrics: false,
        playlists: Boolean(manifest.capabilities.playlists),
        playlistDetail: Boolean(manifest.capabilities.playlistDetail),
        albums: false,
        artists: false,
        recommendations: Boolean(manifest.capabilities.recommendations),
        radio: Boolean(manifest.capabilities.radio),
        // `download` describes whether Aurora can save the stream this source resolves — not a
        // licence verdict. The manifest derives it from `stream`.
        download: Boolean(manifest.capabilities.download ?? manifest.capabilities.stream),
        // The declarative format has no recognition endpoint, so it never claims the capability.
        recognize: false,
      },
      requiresConfig: (manifest.config?.fields.length ?? 0) > 0,
      builtin: false as const,
      kind: 'declarative',
      permissions: ['network'],
      platforms: manifest.platforms,
      qualities: manifest.qualities,
      configSchema: manifest.config,
    },

    isConfigured(config): boolean {
      const fields = manifest.config?.fields ?? []
      return fields.every((field) => (field.required === false ? true : String(config[field.key] ?? '').trim().length > 0))
    },

    async healthCheck(context): Promise<SourceHealth> {
      const started = Date.now()
      if (manifest.search) {
        const tracks = await runSearch('a', { pageSize: 1 }, context)
        return { ok: true, latency: Date.now() - started, message: `连接正常，返回 ${tracks.length} 条样本`, checkedAt: Date.now() }
      }
      if (manifest.recommend) {
        const values = buildValues(manifest, context, { limit: '1' })
        const payload = await callTemplate(manifest, manifest.recommend, values)
        const count = asArray(readPath(payload, manifest.recommend.resultsPath)).length
        return { ok: true, latency: Date.now() - started, message: `连接正常，返回 ${count} 条样本`, checkedAt: Date.now() }
      }
      return { ok: true, latency: 0, message: '该音源没有可探测的接口', checkedAt: Date.now() }
    },
  }

  if (manifest.search) {
    source.search = (query, options, context) => runSearch(query, options, context)
  }

  if (manifest.recommend) {
    source.getRecommendations = async (options, context) => {
      const template = manifest.recommend!
      const values = buildValues(manifest, context, {
        tag: options.tag ?? '',
        limit: String(Math.min(Math.max(options.pageSize ?? 12, 1), 60)),
        page: String(Math.max(options.page ?? 1, 1)),
      })
      const payload = await callTemplate(manifest, template, values)
      return mapTracks(manifest, payload, template, searchFields, context)
    }
  }

  if (manifest.stream || searchFields?.streamUrl) {
    source.resolve = async (trackId, context): Promise<ResolvedStream | null> => {
      const base = { license: manifest.license, homepage: manifest.homepage, downloadAllowed: true, live: false }
      const cached = inlineStreams.get(`${manifest.id}:${trackId}`)
      if (cached) {
        const relayed = safeMedia(cached, 'audio', manifest)
        if (relayed) return { url: relayed, ...base }
      }
      const stream = manifest.stream
      if (!stream) throw new SourceError('UNSUPPORTED', `${label}：未配置 stream 模板，无法解析播放地址`)
      let direct = ''
      if (stream.urlPath || stream.select) {
        const values = buildValues(manifest, context, { id: trackId })
        const payload = await callTemplate(manifest, stream, values)
        const found = stream.select ? pickFromList(payload, stream.select) : asText(readPath(payload, stream.urlPath), 800)
        // The value may be a file name rather than a URL: render it into the template (encoded).
        direct = found && stream.urlTemplate ? render(stream.urlTemplate, { ...values, value: found }, true) : found
      } else {
        direct = render(stream.url, buildValues(manifest, context, { id: trackId }), false)
      }
      if (!direct) throw new SourceError('NOT_FOUND', `${label}：没有返回可播放的地址`)
      const relayed = safeMedia(direct, 'audio', manifest)
      if (!relayed) throw new SourceError('UNSUPPORTED', `${label}：播放地址不在声明的主机/协议范围内`)
      return { url: relayed, ...base }
    }
  }

  if (manifest.playlists) {
    const template = manifest.playlists
    source.getPlaylists = async (context): Promise<SourcePlaylist[]> => {
      const payload = await callTemplate(manifest, template, buildValues(manifest, context, { limit: '30' }))
      return asArray(readPath(payload, template.resultsPath)).flatMap((item) => {
        const id = asText(readPath(item, template.fields.id), 200)
        const title = asText(readPath(item, template.fields.title))
        if (!id || !title) return []
        const count = template.fields.trackCount ? asNumber(readPath(item, template.fields.trackCount)) : undefined
        const playlist: SourcePlaylist = {
          id,
          sourceId: manifest.id,
          title,
          description: template.fields.description ? asText(readPath(item, template.fields.description), 300) : undefined,
          cover: safeMedia(asText(readPath(item, template.fields.cover), 800), 'image', manifest),
          creator: template.fields.creator ? asText(readPath(item, template.fields.creator)) : undefined,
          trackCount: count && Number.isFinite(count) ? count : undefined,
          tags: [],
          homepage: manifest.homepage,
        }
        return [playlist]
      })
    }
  }

  if (manifest.playlistDetail) {
    const template = manifest.playlistDetail
    source.getPlaylistDetail = async (playlistId, context): Promise<SourcePlaylistDetail | null> => {
      const values = buildValues(manifest, context, { id: playlistId, limit: '100' })
      const payload = await callTemplate(manifest, template, values)
      const tracks = mapTracks(
        manifest,
        payload,
        { ...template, resultsPath: template.tracksPath ?? template.resultsPath },
        template.fields,
        context,
      )
      return {
        playlist: {
          id: playlistId,
          sourceId: manifest.id,
          title: playlistId,
          creator: manifest.name,
          trackCount: tracks.length,
          homepage: manifest.homepage,
        },
        tracks,
      }
    }
  }

  return source
}
