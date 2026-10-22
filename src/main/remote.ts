import { net } from 'electron'
import { createHash } from 'node:crypto'
import { MEDIA_SCHEME } from '../shared/constants'

/**
 * Online sources hand back real CDN URLs, but the renderer must never see or construct them:
 * the renderer keeps talking only to `aurora-media://` (so CSP stays strict and the app works
 * through the system proxy). Every remote URL is registered here under an opaque token and
 * relayed by the main process, including HTTP Range passthrough for seeking.
 */
interface RemoteEntry {
  url: string
  kind: 'audio' | 'image'
  sourceId: string
  registeredAt: number
}

const MAX_ENTRIES = 2000
const registry = new Map<string, RemoteEntry>()

export function registerRemote(url: string, kind: RemoteEntry['kind'], sourceId: string): string {
  const token = createHash('sha1').update(`${kind}:${sourceId}:${url}`).digest('hex').slice(0, 32)
  if (registry.has(token)) return token
  if (registry.size >= MAX_ENTRIES) {
    // Cheap FIFO eviction keeps memory bounded during long browsing sessions.
    const oldest = registry.keys().next().value
    if (oldest) registry.delete(oldest)
  }
  registry.set(token, { url, kind, sourceId, registeredAt: Date.now() })
  return token
}

export function remoteUrl(token: string): string {
  return `${MEDIA_SCHEME}://remote/${token}`
}

/**
 * The reverse lookup: given an opaque `aurora-media://remote/<token>` URL, return what it stands for.
 *
 * The download manager and the tag writer need the *upstream* URL, because they stream bytes to disk
 * instead of handing a URL to a renderer. Keeping the map here means the opaque token stays the only
 * media address the rest of the app ever passes around, and an unknown token resolves to `null`
 * rather than being fetched speculatively.
 */
export function upstreamForMediaUrl(
  url: string,
): { url: string; kind: RemoteEntry['kind']; sourceId: string } | null {
  const prefix = `${MEDIA_SCHEME}://remote/`
  if (!url.startsWith(prefix)) return null
  const token = url.slice(prefix.length).split(/[?#]/)[0] ?? ''
  const entry = registry.get(token)
  return entry ? { url: entry.url, kind: entry.kind, sourceId: entry.sourceId } : null
}

export function registerRemoteMedia(url: string, kind: RemoteEntry['kind'], sourceId: string): string {
  return remoteUrl(registerRemote(url, kind, sourceId))
}

const FORWARDED_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'cache-control']

const DEFAULT_TYPES: Record<RemoteEntry['kind'], string> = {
  audio: 'audio/mpeg',
  image: 'image/jpeg',
}

export async function relayRemote(token: string, request: Request): Promise<Response> {
  const entry = registry.get(token)
  if (!entry) return new Response('Not found', { status: 404 })

  const headers: Record<string, string> = {}
  const range = request.headers.get('range')
  if (range) headers.Range = range

  let upstream: Response
  try {
    upstream = await net.fetch(entry.url, { headers, redirect: 'follow' })
  } catch {
    return new Response('Upstream unavailable', { status: 502 })
  }

  const responseHeaders = new Headers()
  for (const name of FORWARDED_HEADERS) {
    const value = upstream.headers.get(name)
    if (value) responseHeaders.set(name, value)
  }
  if (!responseHeaders.has('content-type')) responseHeaders.set('content-type', DEFAULT_TYPES[entry.kind])

  // Live radio streams often answer 200 to a range request; that is passed through as-is.
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders })
}
