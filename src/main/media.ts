import { protocol } from 'electron'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { extname, join } from 'node:path'
import { AUDIO_EXTENSION_SET, MEDIA_SCHEME } from '../shared/constants'
import { relayRemote } from './remote'

/**
 * The renderer must never load media through a raw `file://` URL: Chromium blocks
 * local resource loads from the renderer origin. Instead every playable file is
 * registered here by an opaque id, and served back through a locked-down custom
 * scheme. Files that were never handed over by the user are not reachable.
 */
const authorizedAudio = new Map<string, string>()

const COVER_NAME_PATTERN = /^[a-f0-9]{40}\.(jpg|jpeg|png|webp|gif)$/

const MIME_TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  // Cover art. Chromium sniffs its way to the right decoder either way, but serving a scan as
  // `application/octet-stream` is wrong on its face and confuses anything that reads the type.
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

let coversDirectory = ''

export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true },
    },
  ])
}

export function configureCoversDirectory(directory: string): void {
  coversDirectory = directory
}

export function authorizeAudio(id: string, filePath: string): void {
  authorizedAudio.set(id, filePath)
}

export function releaseAudio(id: string): void {
  authorizedAudio.delete(id)
}

export function audioUrl(id: string): string {
  return `${MEDIA_SCHEME}://audio/${id}`
}

export function coverUrl(fileName: string): string {
  return `${MEDIA_SCHEME}://cover/${fileName}`
}

function mimeTypeFor(filePath: string): string {
  return MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

async function serveFile(filePath: string, request: Request): Promise<Response> {
  const info = await stat(filePath)
  if (!info.isFile()) return new Response('Not found', { status: 404 })

  const baseHeaders = {
    'Content-Type': mimeTypeFor(filePath),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
  }

  const rangeHeader = request.headers.get('range')
  if (!rangeHeader) {
    const stream = Readable.toWeb(createReadStream(filePath)) as unknown as ReadableStream<Uint8Array>
    return new Response(stream, {
      status: 200,
      headers: { ...baseHeaders, 'Content-Length': String(info.size) },
    })
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim())
  if (!match) {
    return new Response(null, { status: 416, headers: { ...baseHeaders, 'Content-Range': `bytes */${info.size}` } })
  }

  let start = match[1] ? Number(match[1]) : 0
  let end = match[2] ? Number(match[2]) : info.size - 1
  if (!match[1] && match[2]) {
    const suffixLength = Number(match[2])
    start = Math.max(0, info.size - suffixLength)
    end = info.size - 1
  }
  end = Math.min(end, info.size - 1)

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= info.size) {
    return new Response(null, { status: 416, headers: { ...baseHeaders, 'Content-Range': `bytes */${info.size}` } })
  }

  const stream = Readable.toWeb(createReadStream(filePath, { start, end })) as unknown as ReadableStream<Uint8Array>
  return new Response(stream, {
    status: 206,
    headers: {
      ...baseHeaders,
      'Content-Range': `bytes ${start}-${end}/${info.size}`,
      'Content-Length': String(end - start + 1),
    },
  })
}

export function registerMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      const name = url.pathname.replace(/^\/+/, '')

      if (url.hostname === 'audio') {
        const filePath = authorizedAudio.get(name)
        if (!filePath || !AUDIO_EXTENSION_SET.has(extname(filePath).toLowerCase())) {
          return new Response('Not found', { status: 404 })
        }
        return await serveFile(filePath, request)
      }

      if (url.hostname === 'cover') {
        if (!coversDirectory || !COVER_NAME_PATTERN.test(name)) return new Response('Not found', { status: 404 })
        return await serveFile(join(coversDirectory, name), request)
      }

      if (url.hostname === 'remote') {
        // Online sources: only URLs the main process registered can be relayed here.
        return await relayRemote(name, request)
      }

      return new Response('Not found', { status: 404 })
    } catch {
      return new Response('Unavailable', { status: 404 })
    }
  })
}
