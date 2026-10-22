import { app } from 'electron'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { getSettings, updateSettings } from './settings'
import type { HttpApiStatus } from '../shared/maintenance'
import type { ReportedPlayerState } from '../shared/types'

/**
 * The optional local HTTP API.
 *
 * Rules, in the order they matter:
 *
 *  1. **Off by default, and off means no socket at all** — nothing is bound until the user turns it on.
 *  2. **Loopback only.** The server binds `127.0.0.1`, so it is reachable from this machine and from
 *     nowhere else; there is no LAN exposure to configure wrongly.
 *  3. **A token is required for every request but `/api/health`.** It is generated in main, persisted with
 *     the settings, and shown in the UI so the user can copy it into whatever is reading the API.
 *  4. **Read-only.** There is no endpoint that plays, pauses or deletes — a third-party integration must
 *     not be able to drive the player, so the surface is deliberately smaller than the app's own.
 */

const ENDPOINTS = ['/api/health', '/api/state', '/api/library']

let server: Server | null = null
let running = false
let startError = ''
let requests = 0
let lastRequestAt = 0
let lastRequestPath = ''
let lastState: ReportedPlayerState | null = null

function token(): string {
  const current = getSettings().httpApi.token
  if (current) return current
  // Generated once and persisted: a token that changes every launch would break whoever is reading it.
  const generated = randomBytes(16).toString('hex')
  void updateSettings({ httpApi: { ...getSettings().httpApi, token: generated } })
  return generated
}

function authorized(request: IncomingMessage): boolean {
  const expected = token()
  const header = request.headers.authorization ?? ''
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  const query = new URL(request.url ?? '/', 'http://127.0.0.1').searchParams.get('token') ?? ''
  const provided = bearer || query
  if (!provided || provided.length !== expected.length) return false
  // Constant-time comparison: the token is short enough that a timing oracle would be theoretical, but
  // the cost of not writing it that way is zero.
  let diff = 0
  for (let index = 0; index < expected.length; index += 1) diff |= provided.charCodeAt(index) ^ expected.charCodeAt(index)
  return diff === 0
}

function send(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  requests += 1
  lastRequestAt = Date.now()
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  lastRequestPath = url.pathname

  if (request.method !== 'GET') {
    send(response, 405, { error: 'method-not-allowed', detail: '本 API 只提供只读 GET 接口。' })
    return
  }
  if (url.pathname === '/api/health') {
    send(response, 200, { ok: true, name: app.getName(), version: app.getVersion() })
    return
  }
  if (!authorized(request)) {
    send(response, 401, { error: 'unauthorized', detail: '缺少或错误的 token，请在 Aurora 设置页复制。' })
    return
  }
  if (url.pathname === '/api/state') {
    send(response, 200, {
      isPlaying: lastState?.isPlaying ?? false,
      title: lastState?.title ?? '',
      artist: lastState?.artist ?? '',
      currentTime: lastState?.currentTime ?? 0,
      duration: lastState?.duration ?? 0,
      trackId: lastState?.trackId ?? '',
    })
    return
  }
  if (url.pathname === '/api/library') {
    // Imported lazily: the library module imports this one's settings for its own reasons, and a static
    // cycle here would depend on which module happened to load first.
    const { listTracks } = await import('./library')
    const tracks = listTracks()
    send(response, 200, {
      total: tracks.length,
      tracks: tracks.map((track) => ({
        id: track.id,
        title: track.title,
        artist: track.artist,
        album: track.album,
        duration: track.duration,
      })),
    })
    return
  }
  send(response, 404, { error: 'not-found', detail: `未知接口。可用：${ENDPOINTS.join(', ')}`, endpoints: ENDPOINTS })
}

export async function startHttpApi(): Promise<HttpApiStatus> {
  const settings = getSettings().httpApi
  await stopHttpApi()
  if (!settings.enabled) return httpApiStatus()
  startError = ''
  // The token is minted *before* the socket opens, not on the first request: the settings page has to be
  // able to show it while the server is running, and a token that only exists after someone has already
  // been refused is not something a user can copy.
  token()
  server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) send(response, 500, { error: 'internal' })
    })
  })
  await new Promise<void>((resolve) => {
    server?.once('error', (error: Error) => {
      startError = error.message
      server = null
      running = false
      resolve()
    })
    server?.listen(settings.port, '127.0.0.1', () => {
      running = true
      resolve()
    })
  })
  return httpApiStatus()
}

export async function stopHttpApi(): Promise<void> {
  const current = server
  server = null
  running = false
  if (!current) return
  await new Promise<void>((resolve) => {
    current.close(() => resolve())
    // A keep-alive connection from a reader would otherwise hold the close open forever.
    setTimeout(resolve, 300)
  })
}

export function httpApiStatus(): HttpApiStatus {
  const settings = getSettings().httpApi
  return {
    running,
    port: settings.port,
    url: `http://127.0.0.1:${settings.port}`,
    requests,
    lastRequestAt,
    lastRequestPath,
    error: startError,
    endpoints: ENDPOINTS,
  }
}

/** The same report the tray and desktop lyrics use; no second source of truth. */
export function onPlayerStateForHttpApi(state: ReportedPlayerState): void {
  lastState = state
}

export function regenerateHttpToken(): string {
  const generated = randomBytes(16).toString('hex')
  void updateSettings({ httpApi: { ...getSettings().httpApi, token: generated } })
  return generated
}
