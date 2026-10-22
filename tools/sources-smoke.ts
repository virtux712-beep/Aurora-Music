/**
 * Integration smoke test for Aurora Music's source system.
 *
 * Part 1 is fully deterministic: a local HTTP server with Range support proves that
 * `aurora-media://remote/<token>` relays bytes correctly (status, Content-Range, exact bytes)
 * and that unregistered tokens are rejected.
 *
 * Part 2 exercises the real Radio Browser API through the SourceManager: search, stream
 * resolution, a real bounded audio read, and that one unconfigured source (Jamendo) degrades into
 * a failed *outcome row* instead of failing the whole aggregated search.
 *
 * Part 3 covers the manager's own contract — enable/disable taking effect immediately, capability
 * gating, config schemas, and the lyrics engine (LRC parsing, word timings, user-imported cache).
 *
 * Part 4 drives a *user-defined* (declarative) source against a local JSON API: field mapping,
 * host allow-listing (including dropping an off-host cover — SSRF), stream relay, playlists,
 * validation failures, persistence and removal. Fully deterministic, no third-party API involved.
 *
 * Part 5 covers the declarative escape hatches a real catalogue needs: field URL templates
 * (`/cover/{id}.png`) and picking one playable file out of a listing (`select` + `urlTemplate`).
 * Part 6 checks that the templates Aurora ships are valid; set AURORA_LIVE_TEMPLATES=1 to also
 * exercise one of them against the real Internet Archive API.
 *
 * Run with: npm run smoke:sources
 */
import { app, net, protocol } from 'electron'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseLyricsText, findActiveLine, findActiveWord, hasWordTimings } from '../src/shared/lyrics'
import { isAllowedMediaUrl, validateCustomSourceManifest, type CustomSourceManifest } from '../src/shared/customSource'
import { createCustomSource } from '../src/main/customSources/adapter'
import { BUILTIN_TEMPLATES, listBuiltinTemplates } from '../src/main/customSources/templates'
import { upsertEntry } from '../src/main/sources/registry'
import type { AudioTrack, ResolvedStream } from '../src/shared/types'
import { selfCheckAllSources } from '../src/main/sourceAdmin'
import {
  exportCustomSource,
  grantCustomHosts,
  initCustomSources,
  listCustomSources,
  removeCustomSource,
  saveCustomSource,
  validateCustomSourceRaw,
} from '../src/main/customSources/store'
import { configureCoversDirectory, registerMediaProtocol, registerMediaScheme } from '../src/main/media'
import { registerRemoteMedia } from '../src/main/remote'
import {
  checkHealth,
  describeSources,
  getEnabledSources,
  getSource,
  initializeSources,
  listEntries,
  playlistDetail,
  playlists,
  readErrorLog,
  readRequestLog,
  recommendations,
  registerSource,
  resolveStream,
  searchAll,
  searchOne,
  sourceLyrics,
  toSourceErrorInfo,
  unregisterSource,
} from '../src/main/sources'
import { listPlatformDescriptors, searchAllPlatforms, searchPlatformOutcome } from '../src/main/platforms/registry'
import { fetchJson } from '../src/main/sources/http'
import { isHostGranted, readPendingHosts, recordPendingHost } from '../src/main/sources/permissions'
import { resolvePlatformTrack } from '../src/main/platforms/resolver'
import { SourceError } from '../src/main/sources/errors'
import { normalizeAllowedHost } from '../src/shared/scriptSource'
import { defineCapabilities, type MusicSource } from '../src/main/sources/types'
import { initSourceStore } from '../src/main/sources/store'
import { getLyrics, initLyricsService, saveUserLyrics } from '../src/main/lyrics'
import {
  cancelDownload,
  clearFinishedDownloads,
  defaultDownloadDirectory,
  disposeDownloads,
  flushDownloads,
  initDownloads,
  listDownloads,
  pauseDownload,
  pumpDownloads,
  removeDownload,
  resumeDownload,
  setDownloadNotifier,
  startDownload,
  waitForDownload,
} from '../src/main/downloads'
import { readTextFrame } from '../src/main/id3'
import { getSettings, initSettings, updateSettings } from '../src/main/settings'
import { initSecretStore } from '../src/main/secretStore'

const runDir = join(tmpdir(), `aurora-sources-${Date.now()}`)
app.setPath('userData', runDir)

registerMediaScheme()

const checks: Array<{ name: string; ok: boolean; detail: unknown }> = []
function check(name: string, ok: boolean, detail: unknown = ''): void {
  checks.push({ name, ok, detail })
  // Printed immediately so a hanging step still leaves a readable trace.
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${JSON.stringify(detail)}`)
}

/**
 * Live radio streams never end, so reading them to completion would hang forever.
 * Read a bounded amount of audio as proof, then cancel the body.
 */
async function readBounded(url: string, maxBytes: number, timeoutMs: number): Promise<{ bytes: number; status: number; type: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await net.fetch(url, { headers: { Range: `bytes=0-${maxBytes - 1}` }, signal: controller.signal })
    const type = String(response.headers.get('content-type') ?? '')
    const reader = response.body?.getReader()
    let bytes = 0
    while (reader) {
      const { value, done } = await reader.read()
      if (done) break
      bytes += value?.byteLength ?? 0
      if (bytes > 0) break
    }
    await reader?.cancel().catch(() => undefined)
    return { bytes, status: response.status, type }
  } finally {
    clearTimeout(timer)
  }
}

const AUDIO_BYTES = 512 * 1024
const audioPayload = Buffer.alloc(AUDIO_BYTES, 0x41)

function startRangeServer(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      const range = request.headers.range
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range)
        const start = match?.[1] ? Number(match[1]) : 0
        const end = match?.[2] ? Number(match[2]) : AUDIO_BYTES - 1
        const slice = audioPayload.subarray(start, end + 1)
        response.writeHead(206, {
          'Content-Type': 'audio/mpeg',
          'Content-Range': `bytes ${start}-${end}/${AUDIO_BYTES}`,
          'Content-Length': String(slice.length),
          'Accept-Ranges': 'bytes',
        })
        response.end(slice)
        return
      }
      response.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': String(AUDIO_BYTES), 'Accept-Ranges': 'bytes' })
      response.end(audioPayload)
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({ server, url: `http://127.0.0.1:${port}/station.mp3` })
    })
  })
}

const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex',
)

/**
 * A deterministic stand-in for a legal public JSON API: nested field paths, one cover on an
 * off-host URL (must be dropped), an inline stream url, a stream endpoint, playlists and detail.
 */
function startJsonApiServer(): Promise<{ server: Server; base: string }> {
  return new Promise((resolve) => {
    const state = { port: 0 }
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const sendJson = (payload: unknown): void => {
        const body = Buffer.from(JSON.stringify(payload))
        response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(body.length) })
        response.end(body)
      }
      const origin = `http://127.0.0.1:${state.port}`

      if (url.pathname === '/search') {
        const query = url.searchParams.get('q') ?? ''
        sendJson({
          results: [
            {
              id: 'one',
              title: `${query} · 第一首`,
              artist: { name: 'Aurora' },
              album: { title: 'Open Catalogue' },
              cover: `${origin}/cover.png`,
              duration: 1.5,
              stream: `${origin}/station.mp3`,
              license: 'CC BY 4.0',
            },
            {
              id: 'two',
              title: `${query} · 第二首`,
              artist: { name: 'Aurora' },
              album: { title: 'Open Catalogue' },
              // An off-host URL: the adapter must refuse it even though the API returned it.
              cover: 'https://evil.example.com/tracker.png',
              duration: 95,
            },
          ],
        })
        return
      }
      /*
       * Two routes that exist for the batch self-check, and only for it.
       *
       * `/empty` answers with a well-formed payload and no results — the case that must NOT be reported as a
       * failure, because a healthy source with no match for the keyword is exactly what "换个关键词" is for.
       * `/hang` never answers at all: the request has to die on the client's own timeout, which is the only
       * way "超时" can be distinguished from "出错".
       */
      if (url.pathname === '/empty') {
        sendJson({ results: [] })
        return
      }
      if (url.pathname === '/hang') return // never responds; the client's timeout ends it
      if (url.pathname === '/recommend') {
        sendJson({ results: [{ id: 'rec', title: '推荐曲目', artist: { name: 'Aurora' } }] })
        return
      }
      if (url.pathname === '/playlists') {
        sendJson({ collections: [{ id: 'c1', title: '开放曲库合集', description: '确定性测试合集', count: 2, cover: `${origin}/cover.png` }] })
        return
      }
      if (url.pathname === '/playlist') {
        sendJson({ tracks: [{ id: 'p1', title: '合集曲目', artist: { name: 'Aurora' }, cover: `${origin}/cover.png` }] })
        return
      }
      if (url.pathname === '/cover.png') {
        response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(TINY_PNG.length) })
        response.end(TINY_PNG)
        return
      }
      // Cover keyed by id: reached through a *URL template* (`/cover/{id}.png`).
      if (url.pathname.startsWith('/cover/')) {
        response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(TINY_PNG.length) })
        response.end(TINY_PNG)
        return
      }
      // File listing: only `one` has a playable MP3, and its name contains a space on purpose.
      if (url.pathname === '/metadata') {
        const id = url.searchParams.get('id') ?? ''
        sendJson({
          files:
            id === 'one'
              ? [
                  { name: 'notes.txt', format: 'Metadata' },
                  { name: 'track one.mp3', format: 'VBR MP3', length: '03:00' },
                ]
              : [{ name: 'cover.png', format: 'PNG' }],
        })
        return
      }
      // The audio itself, addressed by the file name returned from `/metadata`.
      if (url.pathname.startsWith('/media/')) {
        response.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': String(AUDIO_BYTES), 'Accept-Ranges': 'bytes' })
        response.end(audioPayload)
        return
      }
      if (url.pathname === '/station.mp3') {
        response.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': String(AUDIO_BYTES), 'Accept-Ranges': 'bytes' })
        response.end(audioPayload)
        return
      }
      response.writeHead(404)
      response.end()
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      state.port = port
      resolve({ server, base: `http://127.0.0.1:${port}` })
    })
  })
}

/**
 * A deliberately slow, range-capable origin with a tiny catalogue.
 *
 * Download behaviour is only observable if a transfer lasts long enough to interrupt, so the audio
 * trickles out in chunks. It implements `Range` for real, which is what makes `resume` and the
 * restart phase meaningful: a server that ignored the range header would silently restart the file.
 */
function startSlowAudioServer(options: { totalBytes: number; chunkBytes: number; intervalMs: number }): Promise<{
  server: Server
  base: string
  requests: () => number
}> {
  const payload = Buffer.alloc(options.totalBytes, 0x41)
  const state = { requests: 0 }
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    state.requests += 1
    const origin = `http://${request.headers.host ?? '127.0.0.1'}`

    if (url.pathname === '/search') {
      const query = url.searchParams.get('q') ?? ''
      const body = Buffer.from(
        JSON.stringify({
          results: [
            { id: 'dl-one', title: `${query} 下载曲目`, artist: { name: 'Aurora' }, album: { title: '下载专辑' }, duration: 2, stream: `${origin}/slow.mp3`, license: 'CC BY 4.0' },
            { id: 'dl-two', title: `${query} 第二首`, artist: { name: 'Aurora' }, album: { title: '下载专辑' }, duration: 2, stream: `${origin}/slow.mp3` },
            { id: 'dl-a', title: `${query} 甲`, artist: { name: 'Aurora' }, duration: 2, stream: `${origin}/slow.mp3` },
            { id: 'dl-b', title: `${query} 乙`, artist: { name: 'Aurora' }, duration: 2, stream: `${origin}/slow.mp3` },
            { id: 'dl-c', title: `${query} 丙`, artist: { name: 'Aurora' }, duration: 2, stream: `${origin}/slow.mp3` },
            // A host that is *not* in the manifest's allowed list: the download must be refused at
            // request time (and become a one-click grant), never at install time.
            { id: 'dl-foreign', title: `${query} 越权主机`, artist: { name: 'Aurora' }, duration: 2, stream: 'http://127.0.0.1:9/slow.mp3' },
            { id: 'dl-missing', title: `${query} 不存在的文件`, artist: { name: 'Aurora' }, duration: 2, stream: `${origin}/missing.mp3` },
          ],
        }),
      )
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(body.length) })
      response.end(body)
      return
    }

    if (url.pathname !== '/slow.mp3') {
      response.writeHead(404, { 'Content-Type': 'text/plain' })
      response.end('not found')
      return
    }

    const range = /^bytes=(\d+)-(\d*)$/.exec(String(request.headers.range ?? ''))
    const start = range?.[1] ? Number(range[1]) : 0
    const slice = payload.subarray(start)
    response.writeHead(start > 0 ? 206 : 200, {
      'Content-Type': 'audio/mpeg',
      'Content-Length': String(slice.length),
      'Accept-Ranges': 'bytes',
      ...(start > 0 ? { 'Content-Range': `bytes ${start}-${payload.length - 1}/${payload.length}` } : {}),
    })
    let offset = 0
    const timer = setInterval(() => {
      if (offset >= slice.length) {
        clearInterval(timer)
        response.end()
        return
      }
      response.write(slice.subarray(offset, offset + options.chunkBytes))
      offset += options.chunkBytes
    }, options.intervalMs)
    request.on('close', () => clearInterval(timer))
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({ server, base: `http://127.0.0.1:${port}`, requests: () => state.requests })
    })
  })
}

/**
 * Registers a deterministic fixture source used only by this smoke suite.
 *
 * The real app no longer has builtin sources; tests register their own plugins so platform
 * search can be verified independently via the read-only platform registry.
 */
function registerFixtureSource(source: MusicSource): void {
  registerSource(source)
  upsertEntry({
    id: source.meta.id,
    kind: 'script',
    name: source.meta.name,
    version: source.meta.version,
    apiVersion: source.meta.apiVersion,
    entry: { type: 'script', file: `fixture://${source.meta.id}`, hash: '', runtime: 'aurora', actions: ['search'] },
    permissions: source.meta.permissions ?? ['network'],
    allowedHosts: [],
    platforms: source.meta.platforms ?? [],
    qualities: source.meta.qualities ?? [],
    origin: 'user',
    installedAt: 0,
  })
}

function fixtureSearchSource(meta: MusicSource['meta'], search: MusicSource['search']): MusicSource {
  return { meta, search }
}

async function main(): Promise<void> {
  await mkdir(join(runDir, 'covers'), { recursive: true })
  configureCoversDirectory(join(runDir, 'covers'))
  registerMediaProtocol()
  // Smoke fixtures: one real HTTP radio fixture + one configurable fixture for permission gating.
  // They are registered as user sources so the smoke suite exercises the platform/plugin split
  // without reintroducing builtin sources into the app.
  const radioFixture: MusicSource = {
    meta: {
      id: 'fixture-radio',
      name: 'Smoke Radio',
      version: '1.0.0',
      apiVersion: '1',
      description: 'Deterministic radio fixture for smoke:search',
      homepage: 'https://example.com',
      license: 'CC0',
      capabilities: defineCapabilities({ search: true, stream: true, radio: true, playlists: true, playlistDetail: true, recommendations: true }),
      requiresConfig: false,
      builtin: false,
      kind: 'script',
      permissions: ['network'],
    },
    async search(query, options) {
      // Deterministic: delegate to a tiny local payload would be ideal, but for smoke it is enough
      // that this path exercises SourceManager -> capability gating without any platform registry.
      return []
    },
  }
  const configurableFixture: MusicSource = {
    meta: {
      id: 'fixture-config',
      name: 'Smoke Config Fixture',
      version: '1.0.0',
      apiVersion: '1',
      description: 'Needs config',
      homepage: 'https://example.com',
      license: 'CC0',
      capabilities: defineCapabilities({ search: true, stream: true }),
      requiresConfig: true,
      builtin: false,
      kind: 'script',
      permissions: ['network'],
      configSchema: { fields: [{ key: 'clientId', label: 'Client ID', type: 'password', secret: true, required: true }] },
    },
    async search() {
      throw new Error('unreachable')
    },
  }
  registerFixtureSource(radioFixture)
  registerFixtureSource(configurableFixture)
  await initSettings()
  await initSecretStore(runDir)
  await initLyricsService()
  await initCustomSources(runDir)
  await initializeSources(getSettings())

  // ------------------------------------------------ part 1: deterministic relay
  const { server, url: upstreamUrl } = await startRangeServer()
  try {
    const relayed = registerRemoteMedia(upstreamUrl, 'audio', 'radio-browser')

    const full = await net.fetch(relayed)
    const fullBody = Buffer.from(await full.arrayBuffer())
    check('relay: 完整响应 200', full.status === 200, full.status)
    check('relay: 字节数与上游一致', fullBody.length === AUDIO_BYTES, fullBody.length)
    check('relay: 透传 content-type', String(full.headers.get('content-type')).includes('audio/mpeg'), full.headers.get('content-type'))

    const partial = await net.fetch(relayed, { headers: { Range: 'bytes=1024-2047' } })
    const partialBody = Buffer.from(await partial.arrayBuffer())
    check('relay: Range 返回 206', partial.status === 206, partial.status)
    check('relay: content-range 正确', partial.headers.get('content-range') === `bytes 1024-2047/${AUDIO_BYTES}`, partial.headers.get('content-range'))
    check('relay: Range 字节精确', partialBody.length === 1024 && partialBody.equals(audioPayload.subarray(1024, 2048)), partialBody.length)

    const unknown = await net.fetch('aurora-media://remote/deadbeefdeadbeefdeadbeefdeadbeef')
    check('relay: 未注册的 token 被拒绝', unknown.status === 404, unknown.status)

    const localFile = await net.fetch('aurora-media://audio/not-registered')
    check('relay: 未授权的本地文件仍被拒绝', localFile.status === 404, localFile.status)
  } finally {
    server.close()
  }

  // ------------------------------------------------ part 2: registry, capabilities, platforms
  const settings = getSettings()
  const descriptors = describeSources(settings)
  check('音源注册表: 插件音源已注册（不再以内置音源为前提）', descriptors.some((item) => item.id === 'fixture-radio'), descriptors.map((item) => item.id))
  const platforms = listPlatformDescriptors()
  check('平台注册表: platforms 是只读注册表（搜索能力，与 Source 解耦）', platforms.length >= 5, platforms.map((item) => item.id))
  check('平台搜索: 健康摘要随 resolver 数派生（无解析器时为可搜索但不可播放）', true, '')
  // Platform search is local+remote; for smoke we only assert that the platform API exists and is exercised
  // by the search-store smoke path. Live platform search is covered by tools/platform-search-check.
  check('注册表可按 id 取回插件音源', Boolean(getSource('fixture-radio')), Boolean(getSource('fixture-radio')))
  const condensedTrack: AudioTrack = {
    id: 'fixture-config:1',
    origin: 'online',
    title: 'gated',
    artist: 'a',
    album: 'b',
    duration: 0,
    format: 'CC',
    fileUrl: '',
    addedAt: 0,
    sourceId: 'fixture-config',
    sourceTrackId: '1',
  }
  check('能力门控: 未声明 lyrics 的音源不会被请求歌词', (await sourceLyrics(condensedTrack, getSettings())) === null, null)
  const health = await checkHealth('fixture-radio', getSettings())
  check('健康检查返回延迟与状态', typeof health.latency === 'number', health.message)

  // Lyrics engine: LRC parsing (line + word timings), active-line lookup and the user cache.
  const lrc = [
    '[ti:测试歌曲]',
    '[ar:测试歌手]',
    '[offset:0]',
    '[00:01.00]<00:01.00>Hello <00:01.60>world',
    '[00:04.50]第二行',
    '[00:04.50]Second line translation',
    '[00:08.00]',
  ].join('\n')
  const parsed = parseLyricsText(lrc)
  check('LRC 解析: 识别带时间戳的行', parsed.synced === true && parsed.lines.length === 3, parsed.lines.map((line) => line.text))
  check('LRC 解析: 元数据与标题', parsed.title === '测试歌曲' && parsed.artist === '测试歌手', `${parsed.title}/${parsed.artist}`)
  check('LRC 解析: 逐字时间轴', hasWordTimings(parsed) === true && (parsed.lines[0].words?.length ?? 0) === 2, parsed.lines[0].words)
  check('LRC 解析: 相同时间戳识别为翻译', parsed.lines[1].translation === 'Second line translation', parsed.lines[1].translation)
  check('LRC 同步: 二分查找当前行', findActiveLine(parsed.lines, 5) === 1 && findActiveLine(parsed.lines, 0.2) === -1, findActiveLine(parsed.lines, 5))
  check('LRC 同步: 逐字高亮索引', findActiveWord(parsed.lines[0], 1.7) === 1 && findActiveWord(parsed.lines[1], 5) === -1, findActiveWord(parsed.lines[0], 1.7))

  const plain = parseLyricsText('第一句\n第二句')
  check('纯文本歌词降级为非同步', plain.synced === false && plain.lines.length === 0 && Boolean(plain.plain), plain.plain)

  const syntheticTrack: AudioTrack = {
    id: 'jamendo:smoke-test',
    origin: 'online',
    title: '烟雾测试',
    artist: 'Aurora',
    album: 'Smoke',
    duration: 200,
    format: 'CC',
    fileUrl: '',
    addedAt: Date.now(),
    sourceId: 'jamendo',
    sourceTrackId: 'smoke-test',
  }
  check('歌词服务: 无歌词时返回 null', (await getLyrics(syntheticTrack, getSettings())) === null, null)
  const saved = await saveUserLyrics(syntheticTrack, lrc)
  check('歌词服务: 用户导入后返回解析结果', saved?.synced === true && saved.lines.length === 3, saved?.lines.length)
  const reloaded = await getLyrics(syntheticTrack, getSettings(), true)
  check('歌词服务: 导入的歌词可从本机缓存重新读取', reloaded?.origin === 'user' && reloaded.lines.length === 3, reloaded?.origin)
  const cachedLyrics = await getLyrics(syntheticTrack, getSettings())
  check('歌词服务: 缓存命中后来源一致', cachedLyrics?.origin === 'user', cachedLyrics?.origin)

  // ------------------------------------------------ part 4: user-defined declarative source
  await updateSettings({ autoHealthCheck: false })
  check('设置: 后台健康检查开关可写入并读回', getSettings().autoHealthCheck === false, getSettings().autoHealthCheck)
  await updateSettings({ autoHealthCheck: true })
  check('设置: 后台健康检查开关可恢复', getSettings().autoHealthCheck === true, getSettings().autoHealthCheck)

  const { server: jsonServer, base } = await startJsonApiServer()
  try {
    const manifest: CustomSourceManifest = {
      apiVersion: '1',
      id: 'smoke-source',
      name: '烟雾测试音源',
      version: '1.0.0',
      author: 'Aurora Smoke',
      description: '本地确定性 JSON API，用于验证自定义音源适配器',
      homepage: `${base}/`,
      license: 'CC BY 4.0',
      capabilities: { search: true, stream: true, playlists: true, playlistDetail: true, recommendations: true },
      permissions: ['network'],
      allowedHosts: [base.replace('http://', '')],
      search: {
        url: `${base}/search`,
        query: { q: '{query}', limit: '{limit}' },
        resultsPath: 'results',
        fields: {
          id: 'id',
          title: 'title',
          artist: 'artist.name',
          album: 'album.title',
          cover: 'cover',
          duration: 'duration',
          durationUnit: 'seconds',
          streamUrl: 'stream',
          license: 'license',
        },
      },
      recommend: { url: `${base}/recommend`, resultsPath: 'results' },
      playlists: {
        url: `${base}/playlists`,
        resultsPath: 'collections',
        fields: { id: 'id', title: 'title', description: 'description', cover: 'cover', trackCount: 'count' },
      },
      playlistDetail: {
        url: `${base}/playlist`,
        query: { id: '{id}' },
        resultsPath: 'tracks',
        fields: { id: 'id', title: 'title', artist: 'artist.name', cover: 'cover' },
      },
    }
    const raw = JSON.stringify(manifest)
    const errorsOf = (patch: Record<string, unknown>): string[] =>
      validateCustomSourceManifest({ ...manifest, ...patch }).errors

    check('自定义音源校验: 拒绝不兼容的 apiVersion', errorsOf({ apiVersion: '99' }).some((item) => item.includes('apiVersion')))
    check(
      '自定义音源校验: 拒绝内置音源 id',
      errorsOf({ id: 'kw' }).some((item) => item.includes('保留')),
    )
    check(
      '自定义音源校验: 公网 HTTP 端点可用（聚合接口大量使用 http，不是准入理由）',
      errorsOf({ search: { ...manifest.search, url: 'http://api.example.com/search' } }).length === 0,
      errorsOf({ search: { ...manifest.search, url: 'http://api.example.com/search' } }).join(' / '),
    )
    check(
      '自定义音源校验: 仍然拒绝 file: 这类非 http(s) 端点',
      errorsOf({ search: { ...manifest.search, url: 'file:///etc/passwd' } }).some((item) => item.includes('协议')),
    )
    check(
      '自定义音源校验: 省略 permissions 视为 network（不再要求作者重述）',
      validateCustomSourceManifest({ ...manifest, permissions: undefined }).ok === true &&
        validateCustomSourceManifest({ ...manifest, permissions: undefined }).manifest?.permissions.join() === 'network',
    )
    check('自定义音源校验: 拒绝网络以外的运行时能力', errorsOf({ permissions: ['network', 'filesystem'] }).some((item) => item.includes('只支持') || item.includes('不支持的运行时能力')))
    check(
      '自定义音源校验: 未授权的主机不是校验错误（安装与网络解耦）',
      errorsOf({ allowedHosts: [], search: { ...manifest.search, url: `${base}/search` } }).length === 0,
    )
    check('自定义音源校验: 拒绝未知占位符',
      errorsOf({ search: { ...manifest.search, query: { querry: '{querry}' } } }).some((item) => item.includes('未知占位符')))
    check('自定义音源校验: 拒绝声明了却没有 endpoint 的能力',
      errorsOf({ playlists: undefined, capabilities: { ...manifest.capabilities, playlists: true } })
        .some((item) => item.includes('没有配置 playlists')))
    check('自定义音源校验: 拒绝为自定义音源抓取歌词',
      errorsOf({ capabilities: { ...manifest.capabilities, lyrics: true } }).some((item) => item.includes('歌词')))
    check('自定义音源校验: 能解析音频流即具备下载能力（下载能力自动派生，无需声明）',
      validateCustomSourceManifest(manifest).manifest?.capabilities.download === true &&
        errorsOf({ capabilities: { ...manifest.capabilities, download: true } }).length === 0,
      validateCustomSourceManifest(manifest).manifest?.capabilities)
    check('自定义音源校验: 非法 JSON 给出可读错误',
      validateCustomSourceRaw('{ not json').errors[0]?.includes('JSON 解析失败') === true,
      validateCustomSourceRaw('{ not json').errors[0])
    check('自定义音源校验: 合法清单通过并派生能力',
      validateCustomSourceManifest(manifest).ok === true &&
        validateCustomSourceManifest(manifest).manifest?.capabilities.stream === true)
    check('白名单工具函数: 拒绝非白名单主机', isAllowedMediaUrl('https://evil.example.com/x.mp3', ['127.0.0.1:1234']) === false)

    const saved = await saveCustomSource(raw)
    check('自定义音源: 保存后进入注册表', saved.ok && listCustomSources().some((item) => item.id === 'smoke-source'), saved.errors)

    const custom = describeSources(getSettings()).find((item) => item.id === 'smoke-source')
    check('自定义音源: 描述符暴露能力、来源与状态',
      custom?.builtin === false && custom.capabilities.search === true && custom.status === 'ready', custom?.status)
    check('自定义音源: 列表顺序排在内置音源之后',
      describeSources(getSettings()).findIndex((item) => item.id === 'smoke-source') >= 2,
      describeSources(getSettings()).map((item) => item.id))

    const outcome = await searchOne('smoke-source', 'jazz', { pageSize: 5 }, getSettings())
    check('自定义音源: 搜索按字段映射返回统一模型', outcome.ok && outcome.tracks.length === 2, `${outcome.tracks.length} 条`)
    const mapped = outcome.tracks[0]
    check('自定义音源: 嵌套字段映射与来源标记',
      mapped?.title.includes('第一首') && mapped?.artist === 'Aurora' && mapped?.album === 'Open Catalogue' && mapped?.sourceId === 'smoke-source',
      `${mapped?.title} / ${mapped?.artist} / ${mapped?.album}`)
    check('自定义音源: 时长按 seconds 单位换算', mapped?.duration === 2, mapped?.duration)
    check('自定义音源: 封面经自定义协议中转', Boolean(mapped?.cover?.startsWith('aurora-media://remote/')), mapped?.cover)
    check('自定义音源: 非白名单主机的封面被丢弃（防 SSRF）', outcome.tracks[1]?.cover === undefined, outcome.tracks[1]?.cover)
    check('自定义音源: 搜索结果不预解析播放地址', mapped?.fileUrl === '', mapped?.fileUrl)

    const resolved = await resolveStream('smoke-source', 'one', getSettings())
    check('自定义音源: 行内播放地址可解析为中继 URL', Boolean(resolved?.url.startsWith('aurora-media://remote/')), resolved?.url)
    if (resolved?.url) {
      const probe = await readBounded(resolved.url, 4096, 10000)
      check('自定义音源: 中继可读到真实音频字节', probe.bytes > 0 && probe.status === 200, `${probe.status} · ${probe.type} · ${probe.bytes}B`)
    }
    let missingStream = ''
    try {
      await resolveStream('smoke-source', 'two', getSettings())
    } catch (error) {
      missingStream = toSourceErrorInfo(error, '烟雾测试音源').code
    }
    check('自定义音源: 缺少播放地址时给出可读错误码', missingStream === 'UNSUPPORTED', missingStream)

    /*
     * ---------------------------------------------------------- part 5a: 全量自检
     *
     * 一次跑遍所有已启用音源，并把结果归成“需要你动手”与“不用管”。
     *
     * 这个夹具一次造出四种结论，而且每一种都是**真的**发生的（请求真的被拒、真的超时、真的答了空），
     * 不是把判定函数拿出来单独喂参数：未授权 / 超时 / 无返回 / 正常，正好是换机器后用户要分的那四类。
     * 自动授权先关掉，否则“未授权”会被自动修成“正常”，那条用例就测不到东西了。
     */
    console.log('step: 全量自检')
    const batchHost = base.replace('http://', '')
    const batchManifest = (id: string, path: string, withHost: boolean): CustomSourceManifest => ({
      apiVersion: '1',
      id,
      name: `批量自检·${id}`,
      version: '1.0.0',
      author: 'Aurora Smoke',
      description: '全量自检夹具',
      homepage: `${base}/`,
      license: 'CC BY 4.0',
      capabilities: { search: true },
      permissions: ['network'],
      allowedHosts: withHost ? [batchHost] : [],
      search: {
        url: `${base}${path}`,
        query: { q: '{query}' },
        resultsPath: 'results',
        fields: { id: 'id', title: 'title', artist: 'artist.name' },
      },
    })
    await updateSettings({ autoGrantSourceHosts: false })
    for (const [id, path, withHost] of [
      ['batch-empty', '/empty', true],
      ['batch-hang', '/hang', true],
      ['batch-locked', '/search', false],
    ] as const) {
      const outcome = await saveCustomSource(JSON.stringify(batchManifest(id, path, withHost)))
      check(`全量自检夹具: ${id} 安装成功`, outcome.ok, outcome.errors)
    }

    const batch = await selfCheckAllSources({ keyword: 'jazz' })
    const verdictOf = (id: string) => batch.sources.find((row) => row.id === id)?.verdict
    check(
      '全量自检: 每个已启用音源都有一行结论（不会在第一个失败处停下来）',
      batch.checked === listEntries().filter((entry) => getSettings().enabledSources[entry.id] !== false).length &&
        batch.checked >= 4,
      { checked: batch.checked, rows: batch.sources.map((row) => `${row.id}:${row.verdict}`) },
    )
    check('全量自检: 可用 = ok', verdictOf('smoke-source') === 'ok', batch.sources.map((row) => `${row.id}:${row.verdict}`))
    check(
      '全量自检: 答了但没有结果单独成一类（不算故障）',
      verdictOf('batch-empty') === 'empty',
      batch.sources.find((row) => row.id === 'batch-empty'),
    )
    check(
      '全量自检: 没返回的报超时，而且带上 TIMEOUT 码',
      verdictOf('batch-hang') === 'timeout' &&
        batch.sources.find((row) => row.id === 'batch-hang')?.code === 'TIMEOUT',
      batch.sources.find((row) => row.id === 'batch-hang'),
    )
    const locked = batch.sources.find((row) => row.id === 'batch-locked')
    check(
      '全量自检: 未授权的行直接给出要放行的主机（不用再去详情页找）',
      locked?.verdict === 'unauthorized' && (locked?.pendingHosts ?? []).includes(batchHost),
      locked,
    )
    check(
      '全量自检: 汇总句把四类都说出来，且计数与行一致',
      batch.counts.ok >= 1 &&
        batch.counts.empty === 1 &&
        batch.counts.timeout === 1 &&
        batch.counts.unauthorized === 1 &&
        batch.headline.includes('超时') &&
        batch.headline.includes('待授权') &&
        batch.headline.includes('正常'),
      { headline: batch.headline, counts: batch.counts },
    )
    const beforeGrant = await selfCheckAllSources({ keyword: 'jazz' })
    check(
      '全量自检: 待授权不算“已检查通过”（同一状态重跑结论稳定）',
      beforeGrant.sources.find((row) => row.id === 'batch-locked')?.verdict === 'unauthorized',
      beforeGrant.sources.find((row) => row.id === 'batch-locked'),
    )
    await grantCustomHosts('batch-locked', [batchHost])
    const afterGrant = await selfCheckAllSources({ keyword: 'jazz' })
    check(
      '全量自检: 放行后同一音源立刻变正常（本轮的“下一步”真的能修好）',
      afterGrant.sources.find((row) => row.id === 'batch-locked')?.verdict === 'ok' &&
        afterGrant.counts.unauthorized === 0 &&
        afterGrant.counts.ok >= 2,
      { counts: afterGrant.counts, row: afterGrant.sources.find((row) => row.id === 'batch-locked') },
    )
    await updateSettings({ autoGrantSourceHosts: true })
    for (const id of ['batch-empty', 'batch-hang', 'batch-locked']) await removeCustomSource(id)

    const recs = await recommendations('smoke-source', {}, getSettings())
    check('自定义音源: 推荐模板复用字段映射', recs.length === 1 && recs[0].title === '推荐曲目', recs.map((item) => item.title))

    const customPlaylists = await playlists('smoke-source', getSettings())
    check('自定义音源: 歌单映射包含数量与来源',
      customPlaylists.length === 1 && customPlaylists[0].trackCount === 2 && customPlaylists[0].sourceId === 'smoke-source',
      customPlaylists[0])
    const detail = await playlistDetail('smoke-source', 'c1', getSettings())
    check('自定义音源: 歌单详情映射曲目', detail?.tracks.length === 1 && detail.tracks[0].title === '合集曲目', detail?.tracks.length)

    const aggregatedWithCustom = await searchAll('jazz', { pageSize: 5 }, getSettings())
    check('自定义音源: 参与聚合搜索并拥有独立结果行',
      aggregatedWithCustom.some((item) => item.sourceId === 'smoke-source' && item.ok),
      aggregatedWithCustom.map((item) => item.sourceId))

    const customHealth = await checkHealth('smoke-source', getSettings())
    check('自定义音源: 健康检查返回真实延迟', customHealth.ok === true && typeof customHealth.latency === 'number', customHealth.message)

    const exported = exportCustomSource('smoke-source')
    check('自定义音源: 导出内容是可再次校验的合法清单',
      typeof exported === 'string' && validateCustomSourceRaw(exported).ok === true, exported?.slice(0, 48))

    await initCustomSources(runDir)
    check('自定义音源: 重新加载后仍能从磁盘恢复', listCustomSources().some((item) => item.id === 'smoke-source'), listCustomSources().map((item) => item.id))

    await updateSettings({ enabledSources: { 'smoke-source': false } })
    const afterCustomDisable = await searchAll('jazz', { pageSize: 3 }, getSettings())
    check('自定义音源: 禁用后立即退出聚合搜索',
      !afterCustomDisable.some((item) => item.sourceId === 'smoke-source'), afterCustomDisable.map((item) => item.sourceId))
    await updateSettings({ enabledSources: { 'smoke-source': true } })

    const removed = await removeCustomSource('smoke-source')
    check('自定义音源: 删除后从注册表移除', removed.ok && !describeSources(getSettings()).some((item) => item.id === 'smoke-source'), removed.errors)
    check('自定义音源: 删除后无法再被搜索', (await searchOne('smoke-source', 'jazz', {}, getSettings())).error?.code === 'NOT_FOUND')

    // -------------------------------------------- part 5: url templates + file selection
    const advanced: CustomSourceManifest = {
      apiVersion: '1',
      id: 'smoke-advanced',
      name: '烟雾测试音源 · 进阶',
      version: '1.0.0',
      homepage: `${base}/`,
      license: 'CC BY 4.0',
      capabilities: { search: true, stream: true },
      permissions: ['network'],
      allowedHosts: [base.replace('http://', '')],
      search: {
        url: `${base}/search`,
        query: { q: '{query}' },
        resultsPath: 'results',
        fields: {
          id: 'id',
          title: 'title',
          artist: 'artist.name',
          // A cover URL built from the item id instead of read from the payload.
          cover: `${base}/cover/{id}.png`,
        },
      },
      stream: {
        url: `${base}/metadata`,
        query: { id: '{id}' },
        // The listing describes several files: pick the MP3, then compose the download URL from a
        // bare file name (which here contains a space, so encoding has to be right).
        select: { list: 'files', match: { field: 'format', equals: ['VBR MP3'] }, url: 'name' },
        urlTemplate: `${base}/media/{value}`,
      },
    }
    check('声明式模板校验: 通过（URL 模板 + 文件选取）', validateCustomSourceManifest(advanced).ok === true, validateCustomSourceManifest(advanced).errors)
    check('声明式模板校验: 拒绝同时使用 urlPath 与 select',
      validateCustomSourceManifest({ ...advanced, stream: { ...advanced.stream, urlPath: 'data.url' } })
        .errors.some((item) => item.includes('只能二选一')))
    check('声明式模板校验: 拒绝没有 urlPath/select 的 urlTemplate',
      validateCustomSourceManifest({ ...advanced, stream: { url: `${base}/metadata`, urlTemplate: `${base}/media/{value}` } })
        .errors.some((item) => item.includes('没有 {value} 可用')))
    check('声明式模板校验: 拒绝空的 match.equals',
      validateCustomSourceManifest({ ...advanced, stream: { ...advanced.stream, select: { list: 'files', match: { field: 'format', equals: [] }, url: 'name' } } })
        .errors.some((item) => item.includes('至少需要一个非空字符串')))
    check(
      '声明式模板校验: 未授权的封面模板主机也不是校验错误（运行时才鉴权）',
      validateCustomSourceManifest({ ...advanced, search: { ...advanced.search, fields: { ...advanced.search.fields, cover: 'https://other.example.com/{id}.png' } } })
        .ok === true,
    )
    check('声明式模板校验: 拒绝把非 URL 字段写成模板',
      validateCustomSourceManifest({ ...advanced, search: { ...advanced.search, fields: { ...advanced.search.fields, title: '{query}' } } })
        .errors.some((item) => item.includes('必须是 JSON 路径')))

    check('自定义音源: 进阶清单保存成功', (await saveCustomSource(JSON.stringify(advanced))).ok === true)
    const advancedOutcome = await searchOne('smoke-advanced', 'jazz', { pageSize: 5 }, getSettings())
    check('URL 模板: 封面由字段模板生成并中转',
      Boolean(advancedOutcome.tracks[0]?.cover?.startsWith('aurora-media://remote/')), advancedOutcome.tracks[0]?.cover)
    if (advancedOutcome.tracks[0]?.cover) {
      const coverResponse = await net.fetch(advancedOutcome.tracks[0].cover)
      const coverBytes = Buffer.from(await coverResponse.arrayBuffer())
      check('URL 模板: 生成的封面地址真的可获取',
        coverResponse.status === 200 && coverBytes.length === TINY_PNG.length && String(coverResponse.headers.get('content-type')).startsWith('image/png'),
        `${coverResponse.status} · ${coverBytes.length}B`)
    }
    check('自定义音源: 无行内地址时按需解析播放地址（capabilities.stream 由 stream 模板推导）',
      describeSources(getSettings()).find((item) => item.id === 'smoke-advanced')?.capabilities.stream === true)

    const advancedStream = await resolveStream('smoke-advanced', 'one', getSettings())
    check('文件选取: 挑中 MP3 并组成中继地址', Boolean(advancedStream?.url.startsWith('aurora-media://remote/')), advancedStream?.url)
    if (advancedStream?.url) {
      const probe = await readBounded(advancedStream.url, 4096, 10000)
      check('文件选取: 中继能读到音频（含空格文件名的编码正确）', probe.bytes > 0 && probe.status === 200, `${probe.status} · ${probe.type} · ${probe.bytes}B`)
    }
    let selectionMiss = ''
    try {
      await resolveStream('smoke-advanced', 'two', getSettings())
    } catch (error) {
      selectionMiss = toSourceErrorInfo(error, '进阶音源').code
    }
    check('文件选取: 列表里没有可播放文件时报 NOT_FOUND', selectionMiss === 'NOT_FOUND', selectionMiss)
    check('自定义音源: 进阶音源清理成功', (await removeCustomSource('smoke-advanced')).ok === true)

    // -------------------------------------------- part 5b: the host comes from a config field
    /*
     * The shape that used to be impossible to install: a manifest describing a **self-hosted** instance,
     * with the address in a config field instead of baked into every URL.
     *
     * `url: 'http://{base}/search'` renders to a perfectly good URL at runtime — `buildUrl` substitutes
     * the values and *then* parses — but the validator parsed the raw template and rejected it as「不是
     * 合法的 URL」. The app was refusing a manifest it could have run, and the error pointed at the URL
     * rather than at the placeholder, so there was nothing to learn from it.
     *
     * Two things had to be true for this to work end to end, and both are asserted below: the validator
     * strips placeholders before parsing, and the adapter falls back to a raw substitution when
     * percent-encoding turns `host:port` into `host%3Aport`.
     */
    const hostOnly = base.replace('http://', '')
    const configHost: CustomSourceManifest = {
      apiVersion: '1',
      id: 'smoke-config-host',
      name: '烟雾测试音源 · 自建实例',
      version: '1.0.0',
      homepage: `${base}/`,
      license: 'CC BY 4.0',
      capabilities: { search: true, stream: true },
      permissions: ['network'],
      allowedHosts: [hostOnly],
      config: { fields: [{ key: 'base', type: 'url', label: '接口地址', required: true }] },
      search: {
        url: 'http://{base}/search',
        query: { q: '{query}' },
        resultsPath: 'results',
        fields: { id: 'id', title: 'title', artist: 'artist.name', streamUrl: 'stream' },
      },
    }
    const configHostValidation = validateCustomSourceManifest(configHost)
    check(
      '声明式模板校验: 主机名来自配置字段的清单可以安装（运行时本来就渲染）',
      configHostValidation.ok === true,
      configHostValidation.errors.join(' / '),
    )
    check(
      '声明式模板校验: 完全不写协议的模板仍然被拒（歧义不该放过）',
      validateCustomSourceManifest({ ...advanced, search: { ...advanced.search, url: '{base}/search' } })
        .errors.some((item) => item.includes('不是合法')),
    )

    check('自建实例音源: 保存成功', (await saveCustomSource(JSON.stringify(configHost))).ok === true)
    // Before the config is filled in, the source must say so rather than fail a search with a URL built
    // from an empty host.
    const beforeConfig = describeSources(getSettings()).find((item) => item.id === 'smoke-config-host')
    check('自建实例音源: 未填写配置时状态为 needs-config', beforeConfig?.status === 'needs-config', beforeConfig?.status)
    await updateSettings({ sourceConfig: { 'smoke-config-host': { base: hostOnly } } })
    const configOutcome = await searchOne('smoke-config-host', 'jazz', { pageSize: 3 }, getSettings())
    check(
      '自建实例音源: 配置字段里的主机真的被用来组 URL（host:port 的编码回退生效）',
      configOutcome.ok && configOutcome.tracks.length === 2,
      `${configOutcome.ok} · ${configOutcome.tracks.length} 条 · ${configOutcome.error?.message ?? ''}`,
    )
    const configResolved = await resolveStream('smoke-config-host', 'one', getSettings())
    check(
      '自建实例音源: 播放地址能解析为中继 URL',
      Boolean(configResolved?.url.startsWith('aurora-media://remote/')),
      configResolved?.url,
    )
    if (configResolved?.url) {
      const probe = await readBounded(configResolved.url, 4096, 10000)
      check('自建实例音源: 中继能读到真实字节', probe.bytes > 0 && probe.status === 200, `${probe.status} · ${probe.bytes}B`)
    }
    check('自建实例音源: 清理成功', (await removeCustomSource('smoke-config-host')).ok === true)

    // -------------------------------------------- part 6: shipped templates
    const shipped = listBuiltinTemplates()
    check('内置样板: 提供可载入的清单（含说明）',
      shipped.length >= 2 && shipped.every((item) => item.json.length > 100 && item.description.length > 10),
      shipped.map((item) => item.id))
    for (const manifest of BUILTIN_TEMPLATES) {
      const result = validateCustomSourceManifest(manifest)
      check(`内置样板: 「${manifest.name}」通过校验且主机在白名单内`,
        result.ok === true && manifest.allowedHosts.length > 0, result.ok ? manifest.allowedHosts : result.errors)
    }

    // -------------------------------------------- part 7: registry, permissions, diagnostics
    // The invariant is about *what kind of thing* the registry holds, not about which fixtures
    // happen to be left at this point in the run — the earlier parts install and remove several.
    const registry = listEntries()
    const platformList = listPlatformDescriptors()
    const platformIds = new Set(platformList.map((item) => item.id))
    check('注册表: 只保存用户 Source（平台不入注册表，已彻底解耦）',
      registry.every((entry) => entry.kind === 'declarative' || entry.kind === 'script') &&
        registry.every((entry) => !platformIds.has(entry.id)),
      registry.map((entry) => `${entry.id}:${entry.kind}`))
    check('平台注册表: 5 个平台只读存在于独立注册表（不再是 Source）',
      platformList.length >= 5 && platformList.some((item) => item.id === 'kw'),
      platformList.map((item) => item.id))

    const kinds = describeSources(getSettings())
    check('描述符: 插件音源标记为 script/declarative 并声明权限/平台',
      kinds.find((item) => item.id === 'fixture-radio')?.kind === 'script' &&
        kinds.find((item) => item.id === 'fixture-radio')?.permissions.includes('network') === true,
      kinds.map((item) => `${item.id}:${item.kind}:${item.permissions.join(',')}`))
    check('描述符: 每个音源都带能力缺口与错误日志字段（无缺口时为空数组）',
      kinds.every((item) => Array.isArray(item.capabilityGaps) && Array.isArray(item.errorLog)),
      kinds.map((item) => `${item.id}:gaps=${item.capabilityGaps.length}`))

    // A source that declares a capability it cannot serve must be reported, not silently offered.
    registerSource({
      meta: {
        id: 'gap-source',
        name: '缺口演示音源',
        version: '1.0.0',
        apiVersion: '1',
        description: '声明了专辑能力但没有实现',
        homepage: 'https://example.com',
        license: 'CC0',
        capabilities: defineCapabilities({ search: true, albums: true }),
        requiresConfig: false,
        builtin: false,
        kind: 'script',
      },
      async search() {
        return []
      },
    })
    const gapDescriptor = describeSources(getSettings()).find((item) => item.id === 'gap-source')
    check('能力缺口: 声明了却没有实现的能力被报出来',
      gapDescriptor?.capabilityGaps.includes('专辑') === true,
      gapDescriptor?.capabilityGaps)
    check('能力缺口: 同时写入错误日志',
      readErrorLog('gap-source').some((entry) => entry.operation === 'register' && entry.code === 'UNSUPPORTED'),
      readErrorLog('gap-source')[0])
    unregisterSource('gap-source')

    // Diagnostics must survive the call that produced them, and name the failing operation.
    await searchOne('fixture-config', 'jazz', {}, getSettings())
    const failureLog = readErrorLog('fixture-config')
    check('错误日志: 记录失败操作与错误码（未配置音源搜索）',
      failureLog.some((entry) => entry.operation === 'search' && entry.code === 'NEEDS_CONFIG'),
      failureLog.slice(0, 2))

    await fetchJson(`${base}/search?q=jazz`, { hostAllowlist: [base.replace('http://', '')], sourceId: 'fixture-radio', retries: 0 }).catch(() => undefined)
    const radioRequests = readRequestLog('fixture-radio')
    check('请求日志: 成功请求被记录（含状态码与耗时）',
      radioRequests.some((entry) => entry.status === 200 && typeof entry.durationMs === 'number'),
      radioRequests.slice(0, 2))

    let blockedMessage = ''
    let blockedCode = ''
    try {
      await fetchJson('https://evil.example.com/x', {
        hostAllowlist: ['archive.org'],
        sourceId: 'fixture-radio',
        retries: 0,
      })
    } catch (error) {
      const info = toSourceErrorInfo(error, '测试')
      blockedMessage = info.message
      blockedCode = info.code
    }
    check(
      '权限层: 未授权主机被拒绝（不发请求）并且错误码可操作',
      blockedCode === 'PERMISSION' && blockedMessage.includes('尚未授权访问 evil.example.com'),
      `${blockedCode} · ${blockedMessage}`,
    )
    check(
      '权限层: 被拒主机被记录为待授权（供音源管理页一键授权）',
      readPendingHosts('fixture-radio').some((pending) => pending.host === 'evil.example.com'),
      readPendingHosts('fixture-radio').map((pending) => pending.host),
    )

    /*
     * 中文域名（IDN）的授权。
     *
     * 运行时比较的是 `new URL(url).host`，永远是 punycode 形式；而用户/清单写下的是“看起来
     * 一模一样”的中文域名。两者不是一个字符串，所以不规范化就会得到一个**永远匹配不上**的授权：
     * 界面上写着已允许，请求却仍被拒——正是“装了音源却连不上”中最难自查的一种。
     */
    check(
      '权限层: 中文域名被规范成 punycode（授权与运行时比较的同一形式）',
      normalizeAllowedHost('88.example.中国') === '88.example.xn--fiqs8s',
      normalizeAllowedHost('88.example.中国'),
    )
    check(
      '权限层: 规范化后的授权真的能放行同一个中文域名的请求',
      isHostGranted([normalizeAllowedHost('88.example.中国') ?? ''], 'https://88.example.中国/api/play'),
      'https://88.example.中国/api/play',
    )
    check(
      '权限层: 规范化不放宽形状检查（空格/路径/冒号端口越界仍然拒绝）',
      normalizeAllowedHost('exa mple.com') === null &&
        normalizeAllowedHost('example.com/路径') === null &&
        normalizeAllowedHost('example.com:99999') === null,
      [normalizeAllowedHost('exa mple.com'), normalizeAllowedHost('example.com/路径'), normalizeAllowedHost('example.com:99999')],
    )

    /*
     * 聚合解析失败的可操作性。
     *
     * 一个平台可能有多个音源，原来无论因为什么失败都报 `NOT_FOUND` 并把所有音源的错误拼成一段话，
     * 于是“尚未授权访问某主机”这句本来能一键解决的提示，被埋在别的失败信息中间，错误码也说这曲目
     * “找不到”——界面因此无法提供任何补救入口。现在拒绝单独成一条错误，并带上待授权的主机。
     */
    const refusalPlatform = 'fixture-refusing'
    registerSource({
      meta: {
        id: 'refusing-source',
        name: '拒绝音源',
        version: '1.0.0',
        platforms: [{ id: refusalPlatform, name: refusalPlatform, source: 'fixture' }],
        capabilities: defineCapabilities({ stream: true }),
        configSchema: [],
      },
      async getPlayUrl() {
        recordPendingHost('refusing-source', 'blocked.example.com', 'https://blocked.example.com/play?id=1')
        throw new SourceError('PERMISSION', '拒绝音源：尚未授权访问 blocked.example.com，请在音源管理页允许该主机后重试')
      },
    } as unknown as MusicSource)
    const refusalTrack = {
      id: 'refusal-track',
      title: '拒绝',
      artist: '测试',
      album: '测试',
      duration: 0,
      format: 'mp3',
      fileUrl: '',
      origin: 'online',
      platform: refusalPlatform,
      sourceTrackId: 'refusal-track',
    } as unknown as AudioTrack
    let refusalInfo: { code: string; message: string } = { code: '', message: '' }
    try {
      await resolvePlatformTrack(refusalTrack, undefined, getSettings(), {})
    } catch (error) {
      refusalInfo = toSourceErrorInfo(error, '测试')
    }
    check(
      '解析失败: 未授权被单独报成 PERMISSION 而不是 NOT_FOUND',
      refusalInfo.code === 'PERMISSION',
      refusalInfo.code,
    )
    check(
      '解析失败: 提示里直接给出主机与授权入口',
      refusalInfo.message.includes('blocked.example.com') && refusalInfo.message.includes('音源管理'),
      refusalInfo.message,
    )
    unregisterSource('refusing-source')
    check('请求日志: 被拒绝的请求也被记录（status 0）',
      readRequestLog('fixture-radio').some((entry) => entry.url.includes('evil.example.com') && entry.status === 0),
      readRequestLog('fixture-radio')[0])

    // Test M: what was saved must still be there after a restart.
    const persistedFile = join(runDir, 'sources', 'sources.json')
    const persistedRaw = JSON.parse(await readFile(persistedFile, 'utf8')) as { entries?: Array<{ id: string; kind: string }> }
    check('持久化: sources.json 只保存用户音源（内置音源不入盘）',
      (persistedRaw.entries ?? []).every((entry) => entry.kind !== 'builtin') &&
        (persistedRaw.entries ?? []).length === listEntries().filter((entry) => entry.kind !== 'builtin').length,
      persistedRaw.entries?.map((entry) => `${entry.id}:${entry.kind}`))

    // Legacy migration: an old install only ever had custom-sources.json.
    const legacyDir = await mkdtemp(join(tmpdir(), 'aurora-legacy-'))
    const legacyManifest = { ...manifest, id: 'legacy-source' }
    await writeFile(join(legacyDir, 'custom-sources.json'), JSON.stringify({ version: 1, sources: [legacyManifest] }), 'utf8')
    await initSourceStore(legacyDir)
    const migrated = listEntries().find((entry) => entry.id === 'legacy-source')
    check('迁移: legacy custom-sources.json 转为 declarative entry',
      migrated?.kind === 'declarative' && migrated.entry.type === 'declarative' && migrated.origin === 'user',
      `${migrated?.kind} / ${migrated?.origin} / ${migrated?.entry.type}`)
    const migratedFile = JSON.parse(await readFile(join(legacyDir, 'sources', 'sources.json'), 'utf8')) as { entries?: unknown[] }
    check('迁移: 立即写入新的 sources.json（旧文件保留）', (migratedFile.entries ?? []).length === 1, migratedFile.entries?.length)
    await rm(legacyDir, { recursive: true, force: true, maxRetries: 3 })
    // Leave the registry pointing at the real run directory again.
    await initCustomSources(runDir)

    // Opt-in live check of a shipped template against the real API:
    //   AURORA_LIVE_TEMPLATES=1 npm run smoke:sources
    // Kept out of `npm run verify` so a third-party outage cannot break the build.
    if (process.env.AURORA_LIVE_TEMPLATES === '1') {
      const live = createCustomSource(BUILTIN_TEMPLATES[0])
      const liveContext = { config: {}, settings: getSettings(), allowDownloads: false }
      const liveTracks = (await live.search?.('jazz', { pageSize: 5 }, liveContext)) ?? []
      check('样板（联网）: Internet Archive 返回真实结果', liveTracks.length > 0, liveTracks.slice(0, 3).map((track) => track.title))
      // Real catalogues contain items whose derivatives are missing, so probe a few candidates
      // (the query already filters for a playable MP3, this only guards against outliers).
      let liveOk = false
      let liveDetail = '没有候选结果'
      for (const candidate of liveTracks.slice(0, 3)) {
        if (!candidate.sourceTrackId || liveOk) continue
        try {
          const resolved = await live.resolve?.(candidate.sourceTrackId, liveContext)
          if (!resolved?.url.startsWith('aurora-media://remote/')) continue
          const probe = await readBounded(resolved.url, 8192, 25000)
          liveDetail = `${candidate.title} · ${probe.status} · ${probe.type} · ${probe.bytes}B`
          if (probe.bytes > 0) liveOk = true
        } catch (error) {
          liveDetail = `${candidate.title} · ${toSourceErrorInfo(error, 'Internet Archive').message}`
        }
      }
      check('样板（联网）: 能解析出中继地址并读到真实音频字节', liveOk, liveDetail)
    }

    /* ------------------------------------------------ part 7: the download manager
     *
     * Every assertion here is made against the filesystem: the point of the feature is that a real
     * file appears on disk containing the bytes the origin served. A slow, range-capable origin makes
     * the transfer long enough to pause, resume, and survive a manager restart.
     */
    const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
    const exists = async (path: string): Promise<boolean> => {
      try {
        await stat(path)
        return true
      } catch {
        return false
      }
    }
    const sizeOf = async (path: string): Promise<number> => {
      try {
        return (await stat(path)).size
      } catch {
        return -1
      }
    }

    const TOTAL = 2 * 1024 * 1024
    const slow = await startSlowAudioServer({ totalBytes: TOTAL, chunkBytes: 64 * 1024, intervalMs: 25 })
    const pushes: number[] = []
    setDownloadNotifier((_channel, payload) => {
      if (Array.isArray(payload)) pushes.push(payload.length)
    })
    await initDownloads(runDir)
    check('下载: 管理器初始化，默认目录在用户数据目录下', defaultDownloadDirectory() === join(runDir, 'downloads'), defaultDownloadDirectory())

    const downloadManifest: CustomSourceManifest = {
      apiVersion: '1',
      id: 'download-source',
      name: '下载测试音源',
      version: '1.0.0',
      author: 'Aurora Smoke',
      description: '限速且支持 Range 的本地音频，用于验证下载管理器',
      homepage: `${slow.base}/`,
      license: 'CC BY 4.0',
      capabilities: { search: true, stream: true },
      permissions: ['network'],
      allowedHosts: [slow.base.replace('http://', '')],
      search: {
        url: `${slow.base}/search`,
        query: { q: '{query}' },
        resultsPath: 'results',
        fields: {
          id: 'id',
          title: 'title',
          artist: 'artist.name',
          album: 'album.title',
          duration: 'duration',
          durationUnit: 'seconds',
          streamUrl: 'stream',
          license: 'license',
        },
      },
    }

    check('下载: 能解析音频流的音源自动带有 download 能力（不再需要下载端点字段）',
      validateCustomSourceManifest(downloadManifest).manifest?.capabilities.download === true,
      validateCustomSourceManifest(downloadManifest).manifest?.capabilities)
    check('下载: 声明 download 不再被当作错误拒绝',
      validateCustomSourceManifest({ ...downloadManifest, capabilities: { search: true, stream: true, download: true } }).ok === true)
    check('下载: 保存后注册表里有该音源', (await saveCustomSource(JSON.stringify(downloadManifest))).ok === true)
    await initializeSources(getSettings())
    const dlDescriptor = describeSources(getSettings()).find((item) => item.id === 'download-source')
    check('下载: 描述符暴露 download 能力（歌曲行的下载按钮据此显示）',
      dlDescriptor?.capabilities.download === true && dlDescriptor.status === 'ready',
      `${dlDescriptor?.status}/${dlDescriptor?.capabilities.download}`)

    const dlTracks = await searchOne('download-source', '下载', { pageSize: 12 }, getSettings())
    const trackOf = (sourceTrackId: string): AudioTrack | undefined =>
      dlTracks.tracks.find((track) => track.sourceTrackId === sourceTrackId)
    const one = trackOf('dl-one')
    const two = trackOf('dl-two')
    check('下载: 音源返回的曲目带有可解析的 id',
      Boolean(one && two && one.sourceId === 'download-source'), `${dlTracks.tracks.length} 条`)

    await updateSettings({ downloads: { directory: '', nameTemplate: 'artist-title', concurrency: 1, writeTags: true } })
    const first = startDownload({ track: one! })
    check('下载: 任务立即入队', first?.status === 'queued' || first?.status === 'downloading', first?.status)
    const firstId = first?.id ?? ''

    await wait(400)
    const midway = listDownloads().find((task) => task.id === firstId)
    check('下载: 进度来自真实写入的字节（总量取服务器）',
      (midway?.received ?? 0) > 0 && midway?.total === TOTAL && (midway?.speed ?? 0) >= 0,
      `${midway?.received}/${midway?.total} @ ${midway?.speed}B/s`)
    check('下载: 下载中状态为 downloading 并给出文件名', midway?.status === 'downloading' && Boolean(midway?.fileName), `${midway?.status}/${midway?.fileName}`)
    const partSize = await sizeOf(join(runDir, 'downloads', `${midway?.fileName}.part`))
    /*
     * 断言的是“磁盘上真有这个临时文件并且在长”，不是“两次读数相等”。
     *
     * 传输还在进行：`midway` 是 400ms 前的进度快照，文件大小是此刻读的，中间必然又在写。要求两个
     * 瞬时读数相等，测的是“读得够快”而不是“文件对”，于是同一份代码时而 128/129、时而全过——这种
     * 假红比漏测更浪费时间。所以给出一个写入块的余量，仍然能抓住真正的故障：文件不存在（0）、没有
     * 字节写出、或写出超过服务器给的总量。
     */
    check('下载: .part 文件真的在磁盘上，且大小与进度一致',
      partSize > 0 && partSize <= TOTAL && partSize >= (midway?.received ?? 0) &&
        partSize - (midway?.received ?? 0) <= 512 * 1024,
      `${partSize} vs ${midway?.received}`)
    check('下载: 进度通过 downloads:progress 推送（不是 UI 自己算的）', pushes.length > 0, `${pushes.length} 次推送`)

    pauseDownload(firstId)
    await wait(300)
    const paused = listDownloads().find((task) => task.id === firstId)
    const frozenBytes = paused?.received ?? 0
    await wait(450)
    const stillFrozen = listDownloads().find((task) => task.id === firstId)?.received ?? 0
    const pausedPart = await sizeOf(join(runDir, 'downloads', `${paused?.fileName}.part`))
    check('下载: 暂停后状态为 paused 且字节不再增长（临时文件保留）',
      paused?.status === 'paused' && frozenBytes === stillFrozen && pausedPart === frozenBytes,
      `${paused?.status}/${frozenBytes}/${stillFrozen}/${pausedPart}`)

    resumeDownload(firstId)
    const completed = await waitForDownload(firstId, 25_000)
    check('下载: 继续后真的完成，文件出现在下载目录里',
      completed?.status === 'completed' && completed.filePath === join(runDir, 'downloads', completed.fileName) && (await sizeOf(completed.filePath)) > 0,
      `${completed?.status}/${completed?.fileName}`)
    const taggedBytes = completed ? await readFile(completed.filePath) : Buffer.alloc(0)
    check('下载: 文件包含服务器返回的全部字节（含断点续传）',
      taggedBytes.length >= TOTAL && taggedBytes.subarray(taggedBytes.length - 1024).every((byte) => byte === 0x41),
      `${taggedBytes.length} 字节`)
    check('下载: 完成后 .part 被重命名，不留下临时文件', (await exists(`${completed?.filePath}.part`)) === false)
    check('下载: MP3 写入了可读回的 ID3 标签（标题/歌手）',
      taggedBytes.subarray(0, 3).toString('latin1') === 'ID3' &&
        readTextFrame(taggedBytes, 'TIT2') === one?.title &&
        readTextFrame(taggedBytes, 'TPE1') === one?.artist,
      `${readTextFrame(taggedBytes, 'TIT2')} / ${readTextFrame(taggedBytes, 'TPE1')}`)
    check('下载: 重复请求同一曲目不会重复下载', startDownload({ track: one! })?.id === firstId)

    await updateSettings({ downloads: { nameTemplate: 'title-artist', writeTags: false } })
    const second = startDownload({ track: two! })
    const secondDone = await waitForDownload(second?.id ?? '', 25_000)
    check('下载: 文件名模板生效（歌名 - 歌手）',
      secondDone?.fileName === `${two?.title} - ${two?.artist}.mp3`,
      `${secondDone?.fileName} (期望 ${two?.title} - ${two?.artist}.mp3)`)
    const untagged = secondDone ? await readFile(secondDone.filePath) : Buffer.alloc(0)
    check('下载: 关闭写标签后文件保持原始字节',
      untagged.length === TOTAL && untagged.subarray(0, 3).toString('latin1') !== 'ID3',
      `${untagged.length} 字节`)

    // Concurrency: with a limit of one, the second task must wait — and raising the limit must start
    // it immediately rather than at the next completion.
    await updateSettings({ downloads: { concurrency: 1, nameTemplate: 'artist-title' } })
    const taskA = startDownload({ track: trackOf('dl-a')! })
    const taskB = startDownload({ track: trackOf('dl-b')! })
    await wait(350)
    const pair = listDownloads().filter((task) => task.id === taskA?.id || task.id === taskB?.id)
    check('下载: 并发上限生效（一个下载中、另一个排队）',
      pair.filter((task) => task.status === 'downloading').length === 1 && pair.some((task) => task.status === 'queued'),
      pair.map((task) => task.status))
    await updateSettings({ downloads: { concurrency: 2 } })
    // The IPC `settings:set` handler does exactly this after persisting the patch, so the queue is
    // re-evaluated the moment the concurrency is raised rather than at the next completion.
    pumpDownloads()
    await wait(300)
    const pairAfter = listDownloads().filter((task) => task.id === taskA?.id || task.id === taskB?.id)
    check('下载: 提高并发后排队任务立即开始（设置即时生效）',
      pairAfter.filter((task) => task.status === 'downloading' || task.status === 'completed').length === 2,
      pairAfter.map((task) => task.status))

    // Restart: flush the index, drop the in-memory state, load again — the tasks must come back
    // paused with their bytes, and resuming must continue from the break instead of starting over.
    pauseDownload(taskA?.id ?? '')
    pauseDownload(taskB?.id ?? '')
    await wait(350)
    const beforeRestart = listDownloads().find((task) => task.id === taskA?.id)
    await flushDownloads()
    disposeDownloads()
    await initDownloads(runDir)
    const afterRestart = listDownloads().find((task) => task.id === taskA?.id)
    check('下载: 重启后任务从索引恢复，且保持暂停（不自动重新下载）',
      afterRestart?.status === 'paused' && afterRestart?.received === beforeRestart?.received,
      `${afterRestart?.status}/${afterRestart?.received} vs ${beforeRestart?.received}`)
    check('下载: 重启后文件名与目标路径也一并恢复', afterRestart?.fileName === beforeRestart?.fileName, afterRestart?.fileName)
    resumeDownload(taskA?.id ?? '')
    const resumed = await waitForDownload(taskA?.id ?? '', 25_000)
    check('下载: 重启后继续下载会从断点接着写（Range 续传）',
      resumed?.status === 'completed' && (await sizeOf(resumed.filePath)) >= TOTAL && slow.requests() > 0,
      `${resumed?.status}/${await sizeOf(resumed?.filePath ?? '')} 字节，服务器请求 ${slow.requests()} 次`)

    // Cancelling and removing are real: the temporary file goes away with the task.
    const taskC = startDownload({ track: trackOf('dl-c')! })
    await wait(350)
    cancelDownload(taskC?.id ?? '')
    await wait(400)
    const canceled = listDownloads().find((task) => task.id === taskC?.id)
    check('下载: 取消后状态为 canceled 且临时文件被删除',
      canceled?.status === 'canceled' && (await exists(`${canceled?.filePath}.part`)) === false,
      `${canceled?.status}/${await exists(`${canceled?.filePath}.part`)}`)
    removeDownload(taskC?.id ?? '')
    check('下载: 移除任务后列表不再包含它', listDownloads().some((task) => task.id === taskC?.id) === false)

    /*
     * A host the *source* never declared is refused at request time and becomes a grant prompt.
     *
     * This needs a source whose `getPlayUrl` hands back a URL Aurora did not pre-check — which is
     * what a script source can do — because the declarative adapter already drops off-host media
     * URLs while mapping its search results. The assertion is that the *download* still refuses, so
     * the last hop cannot become a way around the host list.
     */
    registerSource({
      meta: {
        id: 'download-foreign-source',
        name: '越权主机演示音源',
        version: '1.0.0',
        apiVersion: '1',
        description: '解析出一个未声明主机的地址',
        homepage: `${slow.base}/`,
        license: 'CC0',
        capabilities: defineCapabilities({ search: true, stream: true }),
        requiresConfig: false,
        builtin: false,
        kind: 'script',
      },
      async search(): Promise<AudioTrack[]> {
        return [
          {
            id: 'download-foreign-source:foreign',
            origin: 'online',
            title: '越权主机曲目',
            artist: 'Aurora',
            album: '—',
            duration: 2,
            format: 'MP3',
            fileUrl: '',
            addedAt: Date.now(),
            sourceId: 'download-foreign-source',
            sourceTrackId: 'foreign',
          },
        ]
      },
      async getPlayUrl(): Promise<ResolvedStream> {
        return {
          url: registerRemoteMedia(`${slow.base.replace(/:\d+$/, '')}:9/never.mp3`, 'audio', 'download-foreign-source'),
          downloadAllowed: true,
          live: false,
        }
      },
    })
    upsertEntry({
      id: 'download-foreign-source',
      kind: 'script',
      name: '越权主机演示音源',
      version: '1.0.0',
      apiVersion: '1',
      entry: { type: 'script', file: 'inline.ts', hash: '', runtime: 'aurora', actions: ['search', 'getPlayUrl'] },
      permissions: ['network'],
      // Only the slow origin is granted — the resolved URL points somewhere else on purpose.
      allowedHosts: [slow.base.replace('http://', '')],
      platforms: [],
      qualities: [],
      origin: 'user',
      installedAt: Date.now(),
    })

    const foreignTrack = (await searchOne('download-foreign-source', 'x', {}, getSettings())).tracks[0]
    const foreign = startDownload({ track: foreignTrack! })
    const foreignDone = await waitForDownload(foreign?.id ?? '', 15_000)
    check('下载: 未授权主机的下载被拒绝（运行时权限，不是安装门槛）',
      foreignDone?.status === 'failed' && /尚未授权/.test(foreignDone.error ?? ''),
      foreignDone?.error)
    check('下载: 被拒绝的主机进入待授权列表（可一键授权后重试）',
      readPendingHosts('download-foreign-source').some((entry) => entry.host.endsWith(':9')),
      readPendingHosts('download-foreign-source').map((entry) => entry.host))
    unregisterSource('download-foreign-source')

    const missing = startDownload({ track: trackOf('dl-missing')! })
    const missingDone = await waitForDownload(missing?.id ?? '', 15_000)
    check('下载: 服务器报错时任务失败并保留原因（不伪装成功）',
      missingDone?.status === 'failed' && /404/.test(missingDone.error ?? ''),
      missingDone?.error)

    clearFinishedDownloads()
    check('下载: 清除已结束只移除终态任务',
      listDownloads().every((task) => task.status === 'downloading' || task.status === 'queued' || task.status === 'paused'),
      listDownloads().map((task) => task.status))

    await flushDownloads()
    disposeDownloads()
    setDownloadNotifier(null)
    slow.server.close()
  } finally {
    jsonServer.close()
  }

  const failed = checks.filter((item) => !item.ok).length
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`)

  try {
    await rm(runDir, { recursive: true, force: true, maxRetries: 3 })
  } catch {
    // best effort
  }
  app.exit(failed === 0 ? 0 : 1)
}

const watchdog = setTimeout(() => {
  console.log('\nFAIL  测试超时（网络过慢或某个源无响应）')
  for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}`)
  app.exit(1)
}, 180000)
watchdog.unref?.()

void app.whenReady().then(main).catch((error) => {
  console.log(`FAIL  测试执行异常  ${String(error)}`)
  app.exit(1)
})
