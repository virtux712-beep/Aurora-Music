import type { SourceCapabilities, SourceConfigSchema } from './types'

/**
 * Declarative sources ("API 音源") — the JSON half of the source system.
 *
 * A declarative source is a manifest: URLs, query templates and JSON field mappings. Aurora never
 * executes user code for these, which is the whole point of the format: a declaration can be
 * validated completely before it runs.
 *
 * What this file decides is **format**, never permission. Concretely:
 *  - `allowedHosts` is *not* an admission list. An empty (or partial) list installs fine; hosts are
 *    granted at runtime, per request, by `main/sources/permissions.ts`, and the source manager
 *    offers a one-click grant for each refused host;
 *  - `permissions` defaults to `network` because every endpoint needs it, rather than making the
 *    author restate the obvious;
 *  - the remaining rules are contract rules that keep generated requests meaningful: an absolute
 *    `http(s)` URL, no forbidden headers, no `file:`/`data:` schemes, known placeholders only, and a
 *    declared capability has to be backed by an endpoint.
 *
 * Plain HTTP is deliberately *not* rejected. It used to be (except for loopback), on the theory that
 * an endpoint a user types should be HTTPS — but music aggregators publish `http://` endpoints
 * constantly, so the rule did not add safety, it just made working manifests unpasteable. The
 * transport question belongs to TLS, not to manifest validation.
 *
 * Ill-formed fields are rejected with actionable Chinese messages so the settings UI can show them.
 */

export const SUPPORTED_API_VERSIONS = ['1'] as const

export type CustomSourcePermission = 'network'

/** Built-in ids a custom manifest may not hijack. */
/**
 * Ids Aurora itself owns: `local` plus the platform search back-ends.
 *
 * They are reserved so a user source cannot shadow one by accident — not as a statement about which
 * platforms may exist. A source serving 酷我 under any *other* id is loaded like any other source.
 */
export const RESERVED_SOURCE_IDS = ['local', 'kw', 'wy', 'tx', 'kg', 'mg'] as const

export const FORBIDDEN_HEADERS = ['host', 'cookie', 'content-length', 'connection', 'transfer-encoding', 'upgrade'] as const

export const ALLOWED_PLACEHOLDERS = ['query', 'tag', 'id', 'limit', 'page'] as const

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,39}$/
const HOST_PATTERN = /^[a-z0-9.-]+(:\d{1,5})?$/
const MAX_QUALITIES = 8

export interface CustomFieldMap {
  /** Path to a unique id inside one result item, e.g. `id`. */
  id: string
  title: string
  artist?: string
  album?: string
  /**
   * JSON path to the cover (e.g. `image`), **or** a URL template such as
   * `https://archive.org/services/img/{id}` — a mapping containing `{placeholders}` is rendered as a
   * URL instead of being read as a path (see `URL_TEMPLATE_FIELDS`).
   */
  cover?: string
  duration?: string
  /** Defaults to seconds; `milliseconds` divides by 1000. */
  durationUnit?: 'seconds' | 'milliseconds'
  /** Direct stream URL inside the search response (optional; otherwise use `stream`). */
  streamUrl?: string
  homepage?: string
  license?: string
  year?: string
}

export interface CustomPlaylistFieldMap {
  id: string
  title: string
  description?: string
  cover?: string
  trackCount?: string
  creator?: string
}

export interface CustomRequestTemplate {
  /** Absolute URL template; `{query}` `{tag}` `{id}` `{limit}` `{page}` are substituted. */
  url: string
  method?: 'GET' | 'POST'
  query?: Record<string, string>
  headers?: Record<string, string>
  /** JSON path to the result array, e.g. `data.tracks` (empty/omitted = the response is the array). */
  resultsPath?: string
  /** JSON path to the result array inside playlist-detail responses (defaults to `resultsPath`). */
  tracksPath?: string
}

export interface CustomStreamSelection {
  /** JSON path to the candidate array (e.g. `files`). */
  list: string
  /** Keep only entries whose `field` equals one of `equals`; the first match wins. */
  match: { field: string; equals: string[] }
  /** JSON path, relative to the matched entry, of the playable value (e.g. `name`). */
  url: string
}

/**
 * Turns a track id into a playable URL. Either read one value directly (`urlPath`), or choose one
 * entry out of a list response (`select`) — the latter is how Internet Archive items work: the
 * metadata endpoint describes every file, and only one of them is the MP3 to play.
 */
export interface CustomStreamTemplate {
  url: string
  method?: 'GET' | 'POST'
  query?: Record<string, string>
  headers?: Record<string, string>
  /** JSON path to a playable url inside the response (e.g. `data.url`). */
  urlPath?: string
  /** …or pick one entry from a list response. */
  select?: CustomStreamSelection
  /**
   * When what you read is a file name rather than an absolute URL, render it into this template:
   * `{value}` is the read/selected value, plus the usual placeholders (`{id}`, `{query}`, …).
   */
  urlTemplate?: string
}

/** Field mappings that are allowed to be URL templates rather than JSON paths. */
export const URL_TEMPLATE_FIELDS = ['cover', 'homepage', 'streamUrl'] as const

export function hasPlaceholders(value: string): boolean {
  return /\{[a-zA-Z0-9_]+\}/.test(value)
}

/** Placeholder-stripped form, so a template can still be parsed as a URL while validating. */
export function stripPlaceholders(value: string): string {
  return value.replace(/\{[a-zA-Z0-9_]+\}/g, 'x')
}

export interface CustomSourceManifest {
  manifestVersion?: number
  /** Plugin API version this manifest targets; must appear in `SUPPORTED_API_VERSIONS`. */
  apiVersion: string
  id: string
  name: string
  version: string
  author?: string
  description?: string
  icon?: string
  homepage: string
  license: string
  /** Declared capabilities; must be backed by a matching endpoint (extra ones are added automatically). */
  capabilities: Partial<SourceCapabilities>
  /** Only `network` exists in API v1; anything else is refused. */
  permissions: CustomSourcePermission[]
  allowedHosts: string[]
  search?: CustomRequestTemplate & { fields: CustomFieldMap }
  recommend?: CustomRequestTemplate
  stream?: CustomStreamTemplate
  playlists?: CustomRequestTemplate & { fields: CustomPlaylistFieldMap }
  playlistDetail?: CustomRequestTemplate & { fields: CustomFieldMap }
  /** Fields the user must fill in (e.g. an API key); secrets are encrypted at rest. */
  config?: SourceConfigSchema
  /**
   * Optional platform declarations. A platform is *metadata*: Aurora renders whatever the manifest
   * announces (id / name / icon / per-platform capabilities and qualities) and never invents one.
   */
  platforms?: CustomPlatformDeclaration[]
  /** Quality labels this source can resolve (free-form, e.g. `128k`, `320k`, `flac`). */
  qualities?: string[]
}

export interface CustomPlatformDeclaration {
  id: string
  name: string
  icon?: string
  capabilities?: Partial<SourceCapabilities>
  qualities?: string[]
}

export interface ManifestValidationResult {
  ok: boolean
  errors: string[]
  manifest?: CustomSourceManifest
}

/** Result shape for save/remove, always returning the full persisted list so the UI can refresh. */
export interface CustomSourceSaveResult {
  ok: boolean
  errors: string[]
  manifests: CustomSourceManifest[]
  /**
   * Whether 安全模式 actually disabled this source because it was **just installed** (see the same field on
   * `ScriptSourceSaveResult`). Truth from the main process, not a guess from the renderer's safe-mode flag.
   */
  disabledByPolicy?: boolean
}

/**
 * A ready-to-load starting point shipped with Aurora. It is only ever *offered* in the editor — the
 * user still has to save it, and it goes through the same validation as hand-written JSON.
 */
export interface CustomSourceTemplate {
  id: string
  name: string
  description: string
  /** The manifest as pretty JSON, ready to drop into the editor. */
  json: string
}

export function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase()
  } catch {
    return null
  }
}

/** Scheme + shape check for an endpoint URL (no host-allowlist check here). */
export function checkEndpointUrl(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return `不是合法的 URL：${url}`
  }
  if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return null
  return `不支持的协议 ${parsed.protocol}（只允许 http/https）：${url}`
}

/**
 * Scheme check for a URL a source *returned* (a resolved stream, a cover).
 *
 * Kept as its own function even though it now accepts exactly what `checkEndpointUrl` accepts: the
 * two answer different questions ("is this a URL we may call?" vs "is this a URL we may play?"), so
 * they are free to diverge again without the media path silently inheriting an endpoint rule — which
 * is precisely how demanding HTTPS here turned a working source into「播放地址不是合法的 http(s)
 * 地址」for every single request (`http://music.nxinxz.com/kw.php?…`, `http://kw-er.kuwo.cn/…`,
 * `http://d.musicapp.migu.cn/…`).
 */
export function checkMediaUrl(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return `不是合法的 URL：${url}`
  }
  if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return null
  return `不支持的协议 ${parsed.protocol}（只允许 http/https）：${url}`
}

/** Runtime guard for *any* URL a custom source hands back (stream, cover, ...). */
export function isAllowedMediaUrl(url: string, allowedHosts: string[]): boolean {
  if (checkMediaUrl(url) !== null) return false
  const host = hostOf(url)
  if (!host) return false
  return allowedHosts.some((allowed) => allowed.toLowerCase() === host)
}

function checkTemplate(
  template: CustomRequestTemplate,
  label: string,
  errors: string[],
  allowedHosts: string[],
  configKeys: string[],
): void {
  /*
   * Placeholders are stripped before the URL is parsed, because that is what the runtime does.
   *
   * `buildUrl` renders `template.url` with the request's values and *then* parses the result, so a host
   * that comes from a config field (`http://{base}/search` — a self-hosted instance, an API key that
   * picks a region) works at runtime. Validating the raw template instead rejected exactly those
   * manifests as「不是合法的 URL」: a source that would have parsed correctly could not be installed at
   * all, and the message pointed at the URL rather than at the placeholder, so there was nothing to
   * learn from it. `stripPlaceholders` substitutes a token that parses, so the shape is still checked
   * (scheme, host, no `file:`) while the values stay free to be filled in at request time.
   *
   * A template with no scheme at all (`{base}/search`) is still refused — that is genuinely ambiguous,
   * and the manifest should say which scheme it means.
   */
  const urlError = checkEndpointUrl(stripPlaceholders(template.url))
  if (urlError) {
    errors.push(`${label}：${urlError}`)
    return
  }
  // Note there is deliberately no host-vs-allowedHosts check here: a host that is not listed yet is
  // a missing *grant*, which the runtime prompts for, not an invalid manifest. `checkEndpointUrl`
  // above already rejected the schemes that would escape the HTTP bridge.
  void allowedHosts

  if (template.method && template.method !== 'GET' && template.method !== 'POST') {
    errors.push(`${label}：method 只支持 GET 或 POST`)
  }
  for (const [key, value] of Object.entries(template.query ?? {})) {
    if (typeof value !== 'string') errors.push(`${label}：query["${key}"] 必须是字符串`)
  }
  for (const [key, value] of Object.entries(template.headers ?? {})) {
    if (FORBIDDEN_HEADERS.includes(key.toLowerCase() as (typeof FORBIDDEN_HEADERS)[number])) {
      errors.push(`${label}：不允许设置请求头 ${key}`)
    }
    if (typeof value !== 'string') errors.push(`${label}：headers["${key}"] 必须是字符串`)
  }
  // Catch typos like `{querry}` early instead of sending a literal placeholder to the API.
  const known = new Set<string>([...ALLOWED_PLACEHOLDERS, ...configKeys])
  const haystack = [template.url, ...Object.values(template.query ?? {}), ...Object.values(template.headers ?? {})].join(' ')
  for (const match of haystack.matchAll(/\{([a-zA-Z0-9_]+)\}/g)) {
    if (!known.has(match[1]) && !known.has(match[1].toLowerCase())) {
      errors.push(
        `${label}：未知占位符 {${match[1]}}（可用：${ALLOWED_PLACEHOLDERS.join(', ')}${
          configKeys.length > 0 ? `，以及配置字段 ${configKeys.join(', ')}` : ''
        }）`,
      )
    }
  }
}

function checkUrlTemplate(template: string, label: string, errors: string[], allowedHosts: string[]): void {
  const probe = stripPlaceholders(template)
  const urlError = checkEndpointUrl(probe)
  if (urlError) {
    errors.push(`${label}：${urlError}`)
    return
  }
  void allowedHosts
  void probe
}

function checkFieldMap(fields: CustomFieldMap | undefined, label: string, errors: string[], allowedHosts: string[]): void {
  if (!fields) {
    errors.push(`${label}：缺少 fields 字段映射`)
    return
  }
  if (!fields.id?.trim()) errors.push(`${label}：fields.id 必填（用于定位每首歌的唯一 id）`)
  if (!fields.title?.trim()) errors.push(`${label}：fields.title 必填`)
  if (fields.durationUnit && fields.durationUnit !== 'seconds' && fields.durationUnit !== 'milliseconds') {
    errors.push(`${label}：durationUnit 只支持 seconds 或 milliseconds`)
  }
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value !== 'string' || !hasPlaceholders(value)) continue
    if (!(URL_TEMPLATE_FIELDS as readonly string[]).includes(key)) {
      errors.push(`${label}：只有 ${URL_TEMPLATE_FIELDS.join(' / ')} 可以写成 URL 模板，${key} 必须是 JSON 路径`)
      continue
    }
    checkUrlTemplate(value, `${label}.fields.${key}`, errors, allowedHosts)
  }
}

function checkStreamSelection(stream: CustomStreamTemplate, errors: string[]): void {
  // Three shapes are legal: `urlPath` (read one address), `select` (pick a file from a list), or
  // neither — then `stream.url` *is* the audio URL (a plain stream endpoint).
  if (stream.urlPath && stream.select) errors.push('stream：urlPath 与 select 只能二选一')
  if (!stream.urlPath && !stream.select && stream.urlTemplate) {
    errors.push('stream：urlTemplate 需要配合 urlPath 或 select 使用，否则没有 {value} 可用')
  }
  if (!stream.select) return
  if (!stream.select.list?.trim()) errors.push('stream.select：list 必填（候选数组的 JSON 路径，例如 files）')
  if (!stream.select.url?.trim()) errors.push('stream.select：url 必填（匹配项中播放地址的字段路径，例如 name）')
  if (!stream.select.match?.field?.trim()) errors.push('stream.select：match.field 必填（用于筛选的字段，例如 format）')
  const equals = stream.select.match?.equals
  if (!Array.isArray(equals) || equals.filter((value) => typeof value === 'string' && value.trim()).length === 0) {
    errors.push('stream.select：match.equals 至少需要一个非空字符串（例如 ["VBR MP3"]）')
  }
}

function deriveCapabilities(manifest: CustomSourceManifest): Partial<SourceCapabilities> {
  const capabilities: Partial<SourceCapabilities> = { ...manifest.capabilities }
  if (manifest.search) {
    capabilities.search = true
    // A search endpoint alone is not playback: it needs a stream template or an inline stream url.
    capabilities.stream = Boolean(manifest.stream || manifest.search.fields?.streamUrl)
  }
  if (manifest.recommend) capabilities.recommendations = true
  if (manifest.playlists) capabilities.playlists = true
  if (manifest.playlistDetail) capabilities.playlistDetail = true
  // Saving a stream is a capability of the *host*, derived from the ability to resolve one — there
  // is no download endpoint to declare, and no licence to be judged.
  capabilities.download = Boolean(capabilities.stream || manifest.stream)
  return capabilities
}

/**
 * Validates a raw manifest. Returns every problem it can find at once (a settings form should not
 * make the user fix one line at a time).
 */
export function validateCustomSourceManifest(value: unknown): ManifestValidationResult {
  const errors: string[] = []
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: ['manifest 必须是一个 JSON 对象'] }
  }
  const raw = value as Record<string, unknown>
  const manifest = raw as unknown as CustomSourceManifest

  if (typeof manifest.apiVersion !== 'string' || !SUPPORTED_API_VERSIONS.includes(manifest.apiVersion as '1')) {
    errors.push(`apiVersion 不兼容：支持 ${SUPPORTED_API_VERSIONS.join(' / ')}，收到 ${String(manifest.apiVersion ?? '缺失')}`)
  }
  if (typeof manifest.id !== 'string' || !ID_PATTERN.test(manifest.id)) {
    errors.push('id 必须是小写字母或数字开头、长度 2-40 的标识符（允许 . _ -）')
  } else if ((RESERVED_SOURCE_IDS as readonly string[]).includes(manifest.id)) {
    errors.push(`id「${manifest.id}」是 Aurora 内置音源保留的标识符`)
  }
  for (const key of ['name', 'version', 'homepage', 'license'] as const) {
    if (typeof manifest[key] !== 'string' || !manifest[key]?.trim()) errors.push(`${key} 不能为空`)
  }
  if (typeof manifest.name === 'string' && manifest.name.length > 60) errors.push('name 不能超过 60 个字符')
  if (typeof manifest.homepage === 'string' && checkEndpointUrl(manifest.homepage) !== null) {
    errors.push(`homepage：${checkEndpointUrl(manifest.homepage)}`)
  }

  // Runtime capabilities. Omitted means "network", because an endpoint that is not allowed to make
  // a request is not an endpoint; anything else is a schema error, not a permission decision.
  const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : []
  for (const permission of permissions) {
    if (permission !== 'network') errors.push(`不支持的运行时能力「${String(permission)}」：目前只有 network`)
  }

  // Hosts are grants, so an empty list is a perfectly valid install — the permission layer will
  // refuse the first request and ask the user instead. Only the *shape* of each entry is checked.
  const allowedHosts = Array.isArray(manifest.allowedHosts)
    ? manifest.allowedHosts.filter((host): host is string => typeof host === 'string').map((host) => host.toLowerCase())
    : []
  for (const host of allowedHosts) {
    if (!HOST_PATTERN.test(host)) errors.push(`allowedHosts 中的主机名不合法：${host}`)
  }

  // Config field declarations are validated first: their keys are legal `{placeholders}` in URLs,
  // headers and query values (that is how a user API key reaches the request).
  const configKeys: string[] = []
  for (const field of manifest.config?.fields ?? []) {
    if (typeof field?.key !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(field.key)) {
      errors.push('config.fields[].key 必须以字母开头，只包含字母/数字/下划线')
      continue
    }
    if (!['text', 'password', 'url', 'number', 'boolean'].includes(field.type)) {
      errors.push(`config.fields.${field.key}：type 只支持 text / password / url / number / boolean`)
      continue
    }
    configKeys.push(field.key)
  }

  const platformIds = new Set<string>()
  if (manifest.platforms !== undefined) {
    if (!Array.isArray(manifest.platforms)) {
      errors.push('platforms 必须是数组')
    } else {
      let index = 0
      for (const platform of manifest.platforms) {
        index += 1
        const label = `platforms[${index - 1}]`
        if (!platform || typeof platform !== 'object') {
          errors.push(`${label}：必须是对象`)
          continue
        }
        if (typeof platform.id !== 'string' || !ID_PATTERN.test(platform.id)) {
          errors.push(`${label}：id 必须是小写字母或数字开头的标识符`)
        } else if (platformIds.has(platform.id)) {
          errors.push(`${label}：平台 id「${platform.id}」重复`)
        } else {
          platformIds.add(platform.id)
        }
        if (typeof platform.name !== 'string' || !platform.name.trim()) errors.push(`${label}：name 不能为空`)
        if (platform.qualities !== undefined && !Array.isArray(platform.qualities)) {
          errors.push(`${label}：qualities 必须是字符串数组`)
        }
      }
    }
  }

  if (manifest.qualities !== undefined) {
    if (!Array.isArray(manifest.qualities)) {
      errors.push('qualities 必须是字符串数组（例如 ["128k", "320k"]）')
    } else if (manifest.qualities.length > MAX_QUALITIES) {
      errors.push(`qualities 最多 ${MAX_QUALITIES} 项`)
    } else if (manifest.qualities.some((quality) => typeof quality !== 'string' || !quality.trim())) {
      errors.push('qualities 不能包含空值')
    }
  }

  if (!manifest.search && !manifest.recommend) {
    errors.push('至少需要提供 search 或 recommend 之一，否则这个音源无法返回任何内容')
  }
  if (manifest.recommend && !manifest.search) {
    errors.push('recommend 复用 search 的字段映射，请同时配置 search')
  }
  if (manifest.search) {
    checkTemplate(manifest.search, 'search', errors, allowedHosts, configKeys)
    checkFieldMap(manifest.search.fields, 'search', errors, allowedHosts)
  }
  if (manifest.recommend) checkTemplate(manifest.recommend, 'recommend', errors, allowedHosts, configKeys)
  if (manifest.playlists) {
    checkTemplate(manifest.playlists, 'playlists', errors, allowedHosts, configKeys)
    if (!manifest.playlists.fields?.id || !manifest.playlists.fields?.title) {
      errors.push('playlists：fields.id 与 fields.title 必填')
    }
  }
  if (manifest.playlistDetail) {
    checkTemplate(manifest.playlistDetail, 'playlistDetail', errors, allowedHosts, configKeys)
    checkFieldMap(manifest.playlistDetail.fields, 'playlistDetail', errors, allowedHosts)
    if (manifest.playlistDetail.fields?.streamUrl) {
      errors.push('playlistDetail：不需要 streamUrl，播放地址请通过 stream 模板解析')
    }
  }
  if (manifest.stream) {
    checkTemplate(manifest.stream, 'stream', errors, allowedHosts, configKeys)
    checkStreamSelection(manifest.stream, errors)
    if (manifest.stream.urlTemplate) {
      checkUrlTemplate(manifest.stream.urlTemplate, 'stream.urlTemplate', errors, allowedHosts)
    }
  }

  // A declared capability without the endpoint that backs it would make the UI promise something
  // it cannot deliver (e.g. a lyrics button that always fails).
  const declared = manifest.capabilities ?? {}
  if (declared.search && !manifest.search) errors.push('capabilities.search 为 true，但没有配置 search 模板')
  if (declared.stream && !manifest.stream && !manifest.search?.fields?.streamUrl) {
    errors.push('capabilities.stream 为 true，但没有配置 stream 模板（或在 search.fields.streamUrl 中提供）')
  }
  if (declared.playlists && !manifest.playlists) errors.push('capabilities.playlists 为 true，但没有配置 playlists 模板')
  if (declared.playlistDetail && !manifest.playlistDetail) {
    errors.push('capabilities.playlistDetail 为 true，但没有配置 playlistDetail 模板')
  }
  if (declared.recommendations && !manifest.recommend) {
    errors.push('capabilities.recommendations 为 true，但没有配置 recommend 模板')
  }
  if (declared.radio && !manifest.search) {
    errors.push('capabilities.radio 需要配置 search 模板')
  }
  // Capabilities that this *source format* has no endpoint for. This is an implementation gap, not
  // a permission decision: declarative v1 simply has no field that could carry a lyrics request, so
  // declaring it would make the UI promise something no request could fulfil.
  //
  // `download` is deliberately *not* in this list: saving a stream is a host capability, and it is
  // derived from `stream` (see `deriveCapabilities`) rather than from a download endpoint.
  if (declared.lyrics) {
    errors.push('capabilities.lyrics：声明式音源没有歌词端点字段（请用脚本音源实现 getLyric）')
  }

  if (errors.length > 0) return { ok: false, errors }

  return {
    ok: true,
    errors: [],
    manifest: {
      ...manifest,
      permissions: ['network'],
      allowedHosts,
      platforms: manifest.platforms?.map((platform) => ({
        id: platform.id,
        name: platform.name.trim().slice(0, 60),
        icon: typeof platform.icon === 'string' ? platform.icon.slice(0, 8) : undefined,
        capabilities: platform.capabilities,
        qualities: Array.isArray(platform.qualities)
          ? platform.qualities.filter((quality): quality is string => typeof quality === 'string').slice(0, MAX_QUALITIES)
          : undefined,
      })),
      qualities: Array.isArray(manifest.qualities)
        ? [...new Set(manifest.qualities.filter((quality): quality is string => typeof quality === 'string'))]
        : undefined,
      capabilities: deriveCapabilities(manifest),
      config: manifest.config && Array.isArray(manifest.config.fields) ? manifest.config : undefined,
    },
  }
}
