/**
 * End-to-end smoke test for the **JavaScript source runtime** and the **Source Detector**.
 *
 * Everything here runs against real code: the real sandbox host (`main/scriptHost/host.ts`), the real
 * registry + store, the real permission layer, and a local HTTP server that serves real audio bytes.
 * No mocked search results, no hardcoded play URLs.
 *
 * What it proves, in order:
 *
 *   1. **Detection** — a `.js` file is recognised as a script, an invalid manifest is reported as an
 *      invalid *manifest*, and a random file is reported as an unknown *format* (never as "not
 *      approved").
 *   2. **Install ≠ network access** — a source installs with zero granted hosts, its first request is
 *      refused with a `PERMISSION` error and the host is recorded as pending; granting it makes the
 *      same request work, with no reinstall and no restart.
 *   3. **Real execution** — search / song detail / play URL / lyrics / cover all run *inside* the
 *      sandbox and come back through the bridge; the play URL is relayed and the bytes are fetched
 *      (status, content-type, length).
 *   4. **Isolation** — the script world has no `require`, no `process` and no Electron; a script that
 *      hangs is killed by the timeout and the *next* call rebuilds the host (Aurora survives); a
 *      script that returns garbage produces an error code instead of a crash.
 *   5. **LX compatibility** — an LX-style source (`globalThis.lx` + `EVENT_NAMES.inited`) is executed
 *      through the compatibility layer, including a synchronous md5 signature that the server
 *      verifies, so the crypto shim is checked against Node's own hashing.
 *   6. **Lifecycle** — disable/enable, delete (file + registry entry removed), and restart
 *      persistence, including a tamper check (edited file → blocked instead of silently running).
 *
 * Run with: npm run smoke:scripts
 */
import { app, net } from 'electron'
import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import type { AudioTrack } from '../src/shared/types'
import type { ScriptSourceManifest } from '../src/shared/scriptSource'
import { configureCoversDirectory, registerMediaProtocol, registerMediaScheme } from '../src/main/media'
import { initSourceStore } from '../src/main/sources/store'
import {
  describeSources,
  getSource,
  invalidateSourceRuntime,
  isEnabled,
  readErrorLog,
  searchAll,
  searchOne,
  resolveStream,
  sourceLyrics,
  toSourceErrorInfo,
  unregisterSource,
} from '../src/main/sources'
import { getEntry, listEntries } from '../src/main/sources/registry'
import { selfCheckSource } from '../src/main/sourceAdmin'
import { repairRefusedHosts, revokeSourceHosts } from '../src/main/sources/autoRepair'
import { resolvePlatformTrack } from '../src/main/platforms/resolver'
import { namePrefixed } from '../src/main/sources/errors'
import { readPendingHosts, clearPendingHosts, recordPendingHost } from '../src/main/sources/permissions'
import { initCustomSources } from '../src/main/customSources/store'
import {
  grantScriptHosts,
  importLxLibrary,
  initScriptSources,
  inspectScriptSource,
  listScriptSources,
  previewLxLibrary,
  probeScriptImport,
  reloadScriptSource,
  removeScriptSource,
  saveScriptSource,
} from '../src/main/scriptSources/store'
import { detectSourceText } from '../src/main/sourceAdmin'
import { disposeAllScriptHosts, disposeScriptHost } from '../src/main/scriptHost/host'
import { initSettings, updateSettings, getSettings } from '../src/main/settings'
import { initSecretStore } from '../src/main/secretStore'

const runDir = join(tmpdir(), `aurora-scripts-${Date.now()}`)
app.setPath('userData', runDir)

// A smoke test must never hang a `npm run verify`: hard exit if it overruns.
const watchdog = setTimeout(() => {
  console.error('FAIL  smoke:scripts 超时（90s），强制退出')
  app.exit(2)
}, 90_000)
watchdog.unref?.()

registerMediaScheme()

// The harness has no main window, so destroying the last sandbox host would otherwise trigger
// Electron's default "all windows closed → quit" and end the run early. The real app always has its
// own window, so this is a harness concern, not a product one.
app.on('window-all-closed', () => undefined)

// Crash triage: if a sandbox host dies, the smoke run must say so instead of exiting silently.
app.on('render-process-gone', (_event, _contents, details) => {
  console.error('render-process-gone', JSON.stringify(details))
})
app.on('child-process-gone', (_event, details) => {
  console.error('child-process-gone', JSON.stringify(details))
})

const checks: Array<{ name: string; ok: boolean; detail: unknown }> = []
function check(name: string, ok: boolean, detail: unknown = ''): void {
  checks.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${JSON.stringify(detail)}`)
}

/** A tiny but real RIFF/WAVE payload: 8-bit mono, 8000 Hz, one 40-sample silent chunk. */
function wavBytes(): Buffer {
  const samples = 40
  const data = Buffer.alloc(samples, 128)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(8000, 24)
  header.writeUInt32LE(8000, 28)
  header.writeUInt16LE(1, 32)
  header.writeUInt16LE(8, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

const AUDIO = wavBytes()
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)
const SIGN_SECRET = 'aurora-e2e-secret'

interface RawSong {
  songmid: string
  songname: string
  singer: string
  albumname: string
  interval: number
  img: string
  /** LX's spelling of the availability list. */
  qualitys?: (string | { type: string })[]
  /** Aurora's spelling of the same list. */
  qualities?: string[]
}

const SONGS: RawSong[] = [
  /*
   * Both spellings on purpose, and in the shapes real sources actually send them: LX uses `qualitys`
   * and mixes plain strings with `{ type }` objects, while Aurora-native scripts write `qualities`.
   * The adapter has to accept all of it — a row that reaches the UI without its availability list
   * shows no quality badge and gives the four-tier preference nothing to choose from.
   */
  {
    songmid: 's1',
    songname: '测试歌曲一',
    singer: '测试歌手',
    albumname: '测试专辑',
    interval: 215,
    img: '',
    qualitys: ['128k', { type: 'flac24bit' }, '128k'],
  },
  {
    songmid: 's2',
    songname: '测试歌曲二',
    singer: '另一位歌手',
    albumname: '另一张专辑',
    interval: 180,
    img: '',
    qualities: ['320k'],
  },
]

let server: Server

/** Real HTTP surface for the sources under test. */
async function startServer(): Promise<{ origin: string; host: string }> {
  server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const send = (status: number, body: Buffer | string, type: string): void => {
      response.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) })
      response.end(body)
    }

    if (url.pathname === '/search') {
      const keyword = url.searchParams.get('kw') ?? ''
      const page = Number(url.searchParams.get('page') ?? '1')
      const sign = url.searchParams.get('sign') ?? ''
      // The LX source signs its request with the synchronous md5 shim; verifying it here is what
      // proves the shim matches a real hash implementation.
      if (url.searchParams.get('signed') === '1') {
        const expected = createHash('md5').update(`${SIGN_SECRET}${keyword}${page}`).digest('hex')
        if (sign !== expected) {
          return send(403, JSON.stringify({ error: 'bad signature', expected, received: sign, keyword, page }), 'application/json')
        }
      }
      const results = SONGS.filter((song) => !keyword || song.songname.includes(keyword) || keyword.includes('测试'))
      /*
       * Rows carry a cover, because an LX-style row does (`img`) and the adapter has to relay it:
       * the renderer's CSP admits only `aurora-media:` for images, so a raw URL here means the UI draws
       * an empty artwork frame for every result of a script source. The URL is built from the request's
       * own Host header so it points at this server without threading `origin` through the closure.
       */
      const withCovers = results.map((song) => ({
        ...song,
        img: `http://${request.headers.host}/cover/${encodeURIComponent(song.songmid)}.png`,
      }))
      return send(200, JSON.stringify({ code: 0, data: { list: withCovers } }), 'application/json')
    }

    /*
     * A deliberately slow endpoint, for the "announces itself late" case.
     *
     * Published 洛雪 sources fetch their own platform config before calling `lx.send(inited)`, and the
     * host used to give that only ~2s before reporting "declared nothing". 2.5s here is just past the
     * old budget, so this endpoint fails the old behaviour and passes the new one.
     */
    if (url.pathname === '/late-config') {
      const delayMs = Number(url.searchParams.get('delay') ?? '2500')
      setTimeout(() => send(200, JSON.stringify({ code: 0, data: { ok: true } }), 'application/json'), delayMs)
      return
    }

    if (url.pathname === '/detail') {
      const id = url.searchParams.get('id') ?? ''
      const song = SONGS.find((item) => item.songmid === id)
      if (!song) return send(404, JSON.stringify({ error: 'not found' }), 'application/json')
      return send(200, JSON.stringify({ code: 0, data: { ...song, interval: 999 } }), 'application/json')
    }

    /*
     * 取播放地址要先请求一次——真实音源都是这个形状，而这一次请求正是可能被权限层拒绝的那一次。
     * 没有它，"自动修复"这条链路就测不到。
     */
    if (url.pathname === '/stream') {
      const id = url.searchParams.get('id') ?? ''
      return send(
        200,
        JSON.stringify({ code: 0, data: { url: `http://${request.headers.host}/audio/${encodeURIComponent(id)}.wav` } }),
        'application/json',
      )
    }

    if (url.pathname === '/lyric') {
      const id = url.searchParams.get('id') ?? ''
      return send(
        200,
        JSON.stringify({ code: 0, data: { lyric: `[00:01.00]${id} 第一行\n[00:02.00]${id} 第二行`, trans: '' } }),
        'application/json',
      )
    }

    if (url.pathname.startsWith('/audio/')) {
      const range = request.headers.range
      if (range) {
        const match = /bytes=(\d+)-(\d*)/.exec(range)
        const start = match ? Number(match[1]) : 0
        const end = Math.min(match && match[2] ? Number(match[2]) : AUDIO.length - 1, AUDIO.length - 1)
        const slice = AUDIO.subarray(start, end + 1)
        response.writeHead(206, {
          'Content-Type': 'audio/wav',
          'Content-Range': `bytes ${start}-${end}/${AUDIO.length}`,
          'Content-Length': slice.length,
        })
        response.end(slice)
        return
      }
      return send(200, AUDIO, 'audio/wav')
    }

    if (url.pathname.startsWith('/cover/')) return send(200, PNG, 'image/png')

    // Never answers: the timeout path.
    if (url.pathname === '/slow') return

    send(404, 'not found', 'text/plain')
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  const origin = `http://127.0.0.1:${port}`
  return { origin, host: `127.0.0.1:${port}` }
}

function auroraScript(origin: string): string {
  return `
// A real Aurora script source, run inside the sandbox host. Its only egress is the bridge.
globalThis.defineAuroraSource({
  name: 'E2E 测试音源',
  version: '1.0.0',
  description: '本地 E2E 音源',
  author: 'aurora-smoke',
  platforms: [{ id: 'e2e', name: 'E2E 平台' }],
  qualities: ['128k', '320k'],
  async search(keyword, page, api) {
    const body = await api.request.json('${origin}/search?kw=' + encodeURIComponent(keyword) + '&page=' + page)
    // Nested shape on purpose: the adapter has to find data.list itself.
    return body
  },
  async getSongDetail(id) {
    const body = await globalThis.auroraRequest.json('${origin}/detail?id=' + encodeURIComponent(id))
    return body.data
  },
  async getPlayUrl(track, quality) {
    return { url: '${origin}/audio/' + encodeURIComponent(track.id || track.songmid) + '.wav', quality: quality || '320k' }
  },
  async getLyric(track) {
    const body = await globalThis.auroraRequest.json('${origin}/lyric?id=' + encodeURIComponent(track.id || track.songmid))
    return body.data.lyric
  },
  async getCover(track) {
    return '${origin}/cover/' + encodeURIComponent(track.id || track.songmid) + '.png'
  },
  async healthCheck() {
    return { ok: true, message: 'e2e ok' }
  },
})
`
}

/**
 * 一个“先请求、再拿地址”的音源。
 *
 * 这是真实音源的形状，也是“装了音源却连不上”的形状：安装时的静态扫描看到的是脚本文本，而运行时
 * 真正要访问的主机是这次请求的目标，两者可以完全不同。
 */
function resolvingScript(origin: string, platformId = 'e2e'): string {
  return `
globalThis.defineAuroraSource({
  name: 'E2E 解析音源',
  version: '1.0.0',
  platforms: [{ id: '${platformId}', name: '${platformId} 平台' }],
  async search(keyword, page, api) {
    // 真的发一次请求：正是这一次会被权限层拒绝（零授权安装），也是自检的第一道真操作。
    const body = await api.request.json('${origin}/search?kw=' + encodeURIComponent(keyword) + '&page=' + (page || 1))
    return body
  },
  async getPlayUrl(track, quality) {
    const body = await globalThis.auroraRequest.json('${origin}/stream?id=' + encodeURIComponent(track.id))
    return { url: body.data.url, quality: quality || '320k' }
  },
})
`
}

function hangingScript(origin: string): string {
  return `
globalThis.defineAuroraSource({
  name: 'E2E 超时音源',
  version: '1.0.0',
  async search(keyword, page, api) {
    if (keyword === 'hang') {
      // Never resolves and never yields: the host must kill it.
      for (;;) {}
    }
    if (keyword === 'raw-fetch') {
      // Proof that the host session cancels the sandbox's own fetch: the bridge is the only egress.
      await fetch('${origin}/search?kw=x')
      return [{ songname: 'raw fetch 竟然成功了' }]
    }
    const body = await api.request.json('${origin}/search?kw=' + encodeURIComponent(keyword) + '&page=' + page)
    return body
  },
  async getPlayUrl(track) {
    return { url: '${origin}/audio/ok.wav' }
  },
})
`
}

function badDataScript(origin: string): string {
  return `
globalThis.defineAuroraSource({
  name: 'E2E 错误数据音源',
  version: '1.0.0',
  async search() {
    return { not: 'a list' }
  },
  async getPlayUrl() {
    return { url: '${origin}/audio/ok.wav' }
  },
})
`
}

/**
 * A source in the shape the wider plugin ecosystem uses: CommonJS export plus `getMediaSource`.
 *
 * Both halves matter. `module.exports` (rather than `defineAuroraSource`) and `getMediaSource`
 * (rather than `getPlayUrl`) are the MusicFree spellings; a host that only understands its own names
 * would report a complete plugin as "no source" / "no play capability".
 */
function aliasScript(origin: string): string {
  return `
module.exports = {
  name: '别名风格音源',
  version: '0.1.0',
  platform: 'custom',
  async search(query, page) {
    const body = await globalThis.auroraRequest.json('${origin}/search?kw=' + encodeURIComponent(query) + '&page=' + page)
    return { isEnd: true, data: body.data.list }
  },
  async getMediaSource(track) {
    return '${origin}/audio/' + encodeURIComponent(track.id || track.songmid || 'alias') + '.wav'
  },
  async getMusicInfo(id) {
    return { songmid: id, songname: '别名详情' }
  },
  async getLyric() {
    return '[00:01.00]别名风格歌词'
  },
}
`
}

/**
 * A script that loads fine and exports nothing — the shape that used to be refused at import.
 *
 * It is not a contrived case: minified sources whose global name is rewritten, and sources that only
 * announce themselves under a runtime this host does not speak, both look exactly like this on a
 * probe. Nothing here may be reported as "a source" either — the file is installed on the strength of
 * loading, and the manager re-probes it later.
 */
function opaqueScript(): string {
  return `
;(function () {
  var internal = { ready: false, note: 'no export on purpose' }
  return internal
})()
`
}

/**
 * A 洛雪 source that announces itself **after** its own slow request completes.
 *
 * This is the startup order real aggregators use, and the reason the host is allowed to wait: the
 * announcement arrives from a promise callback, long after the script body returned. The evidence
 * flags have to be part of the declaration on the 洛雪 path too, or the wait never happens.
 */
function lateLxScript(origin: string): string {
  return `
const { EVENT_NAMES, on, send, request } = globalThis.lx
on(EVENT_NAMES.request, async ({ action, info }) => {
  if (action === 'search') {
    const body = await request('${origin}/search?kw=' + encodeURIComponent((info && info.keyword) || '') + '&page=1')
    return body && body.body && body.body.data ? body.body.data.list : []
  }
  if (action === 'musicUrl') return '${origin}/audio/late.wav'
  if (action === 'lyric') return '[00:01.00]迟到音源歌词'
  throw new Error('unsupported action: ' + action)
})
console.log('late: 开始等待自身配置')
request('${origin}/late-config?delay=2500').then(() => {
  console.log('late: 配置已返回，现在声明')
  send(EVENT_NAMES.inited, {
    name: 'E2E 迟到音源',
    version: '1.0.0',
    sources: { late: { name: '迟到平台', type: 'music', actions: ['search', 'musicUrl', 'lyric'], qualitys: ['128k'] } },
  })
  console.log('late: 已声明')
}).catch((error) => console.error('late: 配置请求失败 ' + error))
`
}

function lxScript(origin: string, host: string): string {
  return `
// An LX-style source: the LX compatibility layer is the only reason this runs.
const { EVENT_NAMES, on, send, request, utils, env } = globalThis.lx
const SECRET = '${SIGN_SECRET}'
const ORIGIN = '${origin}'

on(EVENT_NAMES.request, async ({ source, action, info }) => {
  if (action === 'search') {
    const page = (info && info.page) || 1
    const keyword = (info && info.keyword) || ''
    // Synchronous md5 from the compat layer; the server verifies this signature.
    const sign = utils.crypto.md5(SECRET + keyword + page)
    const body = await request(ORIGIN + '/search?signed=1&kw=' + encodeURIComponent(keyword) + '&page=' + page + '&sign=' + sign)
    if (!body || !body.body || !body.body.data) {
      throw new Error('LX 搜索失败 status=' + (body && body.statusCode) + ' body=' + String((body && body.raw) || '').slice(0, 240))
    }
    return body.body.data.list
  }
  if (action === 'musicUrl') {
    const quality = (info && info.type) || '128k'
    // The aggregator case: a *public* host over plain HTTP. It is deliberately not loopback, so this
    // exercises the rule that used to reject it. Regression guard — every other fixture resolves to
    // 127.0.0.1, which the old HTTPS-only check exempted, so the bug it hid was invisible to tests.
    if (quality === 'plain-http') return 'http://music.agg-regression.test/wy.php?id=228908&level=exhigh&type=mp3'
    return '${origin}/audio/' + quality + '.wav'
  }
  if (action === 'lyric') {
    return '[00:03.00]LX 歌词第一行\\n[00:04.00]LX 歌词第二行'
  }
  if (action === 'pic') {
    return '${origin}/cover/lx.png'
  }
  throw new Error('unsupported action: ' + action)
})

send(EVENT_NAMES.inited, {
  name: 'E2E 洛雪音源',
  description: '本地洛雪协议音源',
  version: '2.0.0',
  author: 'aurora-smoke',
  homepage: '${origin}',
  sources: {
    e2eplat: {
      name: 'E2E 平台',
      actions: ['search', 'musicUrl', 'lyric', 'pic'],
      qualitys: ['128k', '320k'],
    },
  },
})

void ${JSON.stringify(host)}
`
}

async function confirm(manifest: ScriptSourceManifest, sourceText: string, hosts = manifest.allowedHosts) {
  return saveScriptSource({
    sourceText,
    manifest: { ...manifest, permissions: ['network'], allowedHosts: hosts },
  })
}

async function bytesOf(url: string): Promise<{ status: number; type: string; bytes: number }> {
  const response = await net.fetch(url, { headers: { Range: 'bytes=0-63' } })
  const buffer = Buffer.from(await response.arrayBuffer())
  return { status: response.status, type: String(response.headers.get('content-type') ?? ''), bytes: buffer.length }
}

app.whenReady().then(async () => {
  const { origin, host } = await startServer()
  await initSettings()
  await initSecretStore(runDir)
  configureCoversDirectory(join(runDir, 'covers'))
  registerMediaProtocol()
  await initCustomSources(runDir)
  // Shorter timeouts so the stuck-script case is provable in seconds.
  await initScriptSources(runDir, {
    preloadPath: join(fileURLToPath(new URL('.', import.meta.url)), 'script-host.cjs'),
    callTimeoutMs: 2500,
    installTimeoutMs: 4000,
  })
  const settings = getSettings()
  const secrets = {}

  /* ---------------------------------------------------------------- 1. detection */

  const asScript = await detectSourceText(auroraScript(origin), 'e2e-source.js')
  check(
    'detector: .js 文件被识别为脚本音源（并读到它声明的平台）',
    asScript.kind === 'script' && asScript.script?.platforms.some((platform) => platform.id === 'e2e'),
    { kind: asScript.kind, actions: asScript.script?.actions },
  )

  const asUnknown = await detectSourceText('this is not a source file at all', 'notes.txt')
  check(
    'detector: 无法识别的文件只报告「未知 Source 格式」，不报告任何“不合法/未批准”',
    asUnknown.kind === 'unknown' && /未知 Source 格式/.test(asUnknown.summary) && !/合法|批准|官方/.test(asUnknown.summary),
    asUnknown.summary,
  )

  /*
   * The two files that made someone ask "为什么这两个音源无法被识别": a Word document renamed to `.js`.
   *
   * The bytes below are the head of that real file — ZIP signature `PK\x03\x04` followed by the OOXML
   * container's first entry, which is what `[Content_Types].xml` is. Before this check the detector ran
   * them as JavaScript, failed to parse, and reported "script failed to execute … check the renderer
   * console": neither the cause nor anything the user could act on.
   */
  const officeBytes =
    'PK\u0003\u0004\u0014\u0000\u0006\u0000[Content_Types].xml\u0000word/document.xml\u0000word/styles.xml'
  const asOffice = await detectSourceText(officeBytes, '野草音源.js')
  check(
    'detector: 改名成 .js 的 Office 文档被指名说成压缩包（不是「未知格式」也不是沙箱错误）',
    asOffice.kind === 'unknown' && !asOffice.ok && /ZIP 压缩包|Office/.test(asOffice.summary) && /docx/.test(asOffice.summary),
    { summary: asOffice.summary, errors: asOffice.errors },
  )
  check(
    'detector: 它同时给出可执行的下一步（改名/截断/网盘预览），而不是让人去翻控制台',
    asOffice.errors.some((error) => /改名|截断|预览/.test(error)) && !asOffice.errors.some((error) => /renderer console/.test(error)),
    asOffice.errors,
  )

  const asBinary = await detectSourceText('\u00ff\u00fe\u0000\u0001\u0000\u0000binary payload', 'mystery.dat.js')
  check(
    'detector: 含 NUL 字节的文件被说成二进制文件',
    asBinary.kind === 'unknown' && /二进制/.test(asBinary.summary),
    asBinary.summary,
  )

  // A guard on the other side: plain *readable* text that simply is not a source must keep its old,
  // accurate answer. Calling every unrecognised file a binary blob would be a new way to mislead.
  check(
    'detector: 纯文本仍按「未知 Source 格式」报告，不被误判为二进制',
    asUnknown.kind === 'unknown' && /未知 Source 格式/.test(asUnknown.summary) && !/二进制|压缩包/.test(asUnknown.summary),
    asUnknown.summary,
  )

  const syntaxError = await detectSourceText(
    "globalThis.defineAuroraSource({ name: 'broken', async search( { return [] } })",
    'syntax-error.js',
  )
  check(
    'detector: 语法错误的 JS 被识别为「脚本音源但加载失败」（而不是“格式未知”）',
    syntaxError.kind === 'script' && !syntaxError.ok && syntaxError.errors.length > 0,
    { kind: syntaxError.kind, summary: syntaxError.summary, errors: syntaxError.errors.slice(0, 1) },
  )

  const badManifest = await detectSourceText('{"id":"x"}', 'broken.json')
  check(
    'detector: 不合法的清单报告的是清单错误（不是准入错误）',
    badManifest.kind === 'declarative' && badManifest.errors.length > 0,
    badManifest.errors.slice(0, 3),
  )

  /* ---------------------------------------------------------------- 2. probe declares, nothing granted */

  console.log('step: probe (no permissions)')
  const probe = await probeScriptImport({ sourceText: auroraScript(origin), fileName: 'e2e-source.js' })
  check(
    'probe: 无权限运行后报告能力（search/playUrl/lyric/cover）与平台',
    probe.ok && Boolean(probe.declaration) && ['search', 'getPlayUrl', 'getLyric', 'getCover'].every((m) => probe.declaration!.actions.includes(m)),
    probe.declaration?.actions,
  )
  check(
    'probe: 权限为空的探测不会写盘、也不会注册任何音源',
    !getEntry(probe.manifest?.id ?? '') && listScriptSources().length === 0,
    listScriptSources().length,
  )

  /* ---------------------------------------------------------------- 3. install with zero grants */

  const saved = await confirm(probe.manifest!, auroraScript(origin), [])
  const sourceId = probe.manifest!.id
  check('install: 没有授权任何主机也能安装成功（安装与网络解耦）', saved.ok && getEntry(sourceId)?.allowedHosts.length === 0, saved.errors)

  const descriptorBefore = describeSources(settings, secrets).find((item) => item.id === sourceId)
  check(
    'install: 描述符反映真实种类/运行时/能力',
    descriptorBefore?.kind === 'script' && descriptorBefore.runtime === 'aurora' && descriptorBefore.capabilities.search === true,
    { kind: descriptorBefore?.kind, runtime: descriptorBefore?.runtime, gaps: descriptorBefore?.capabilityGaps },
  )

  const refused = await searchOne(sourceId, '测试', {}, getSettings(), secrets)
  check(
    'permission: 未授权主机的请求被拒绝，并给出可操作的 PERMISSION 错误',
    !refused.ok && refused.error?.code === 'PERMISSION' && /允许/.test(refused.error.message),
    refused.error,
  )
  const pending = readPendingHosts(sourceId)
  check('permission: 被拒的主机被记为待授权', pending.length === 1 && pending[0].host === host, pending.map((item) => item.host))

  const granted = await grantScriptHosts(sourceId, [host])
  check('permission: 一键授权后主机进入白名单并热重载', granted.ok && granted.allowedHosts.includes(host), granted.errors)
  check('permission: 授权后待授权列表清空', readPendingHosts(sourceId).length === 0, readPendingHosts(sourceId).length)

  /*
   * ------------------------------------------- 3b. 自动修复：首次播放被拒 → 授权 → 重试
   *
   * 这是“别的电脑上装了音源却连不上”的那条路：安装时允许列表是空的（静态扫描看不到运行时才
   * 出现的主机），用户点一首歌，第一次请求被拒。修好之前这里的结局是一个错误提示 + 一张需要
   * 用户自己去找的授权页；修好之后应当直接能放，并且把授权如实记下来（可撤销、有审计）。
   */
  console.log('step: 自动修复')
  const autoId = 'auto-repair-source'
  const autoSaved = await confirm(
    { ...probe.manifest!, id: autoId, name: 'E2E 自动修复音源' },
    resolvingScript(origin),
    [],
  )
  check(
    '自动修复: 安装后允许列表为空（被拒的那台主机确实不在里面）',
    autoSaved.ok && (getEntry(autoId)?.allowedHosts.length ?? -1) === 0,
    getEntry(autoId)?.allowedHosts,
  )

  const autoTrack = {
    id: `${autoId}:track-1`,
    origin: 'online',
    title: '自动修复',
    artist: '测试',
    album: '测试',
    duration: 0,
    format: '—',
    fileUrl: '',
    addedAt: Date.now(),
    platform: 'e2e',
    sourceId: autoId,
    sourceTrackId: 'track-1',
  } as unknown as AudioTrack

  const autoResolved = await resolvePlatformTrack(autoTrack, undefined, getSettings(), secrets)
  // 拿到的是一个已登记的音频中继，不是原始 http 地址；真读一次字节才算“真的能放”。
  const autoBytes = autoResolved?.url ? await bytesOf(autoResolved.url) : { status: 0, bytes: 0, type: '' }
  check(
    '自动修复: 首次播放被拒后自动授权并重试，播放地址真的能读到字节',
    Boolean(autoResolved?.url) &&
      autoResolved!.url.startsWith('aurora-media://remote/') &&
      (autoBytes.status === 200 || autoBytes.status === 206) &&
      autoBytes.bytes > 0,
    { url: autoResolved?.url, ...autoBytes },
  )
  check(
    '自动修复: 授权写进音源记录（持久、可在音源管理页撤销）',
    (getEntry(autoId)?.allowedHosts ?? []).includes(host),
    getEntry(autoId)?.allowedHosts,
  )
  check(
    '自动修复: 待授权列表清空（不会反复提示）',
    readPendingHosts(autoId).length === 0,
    readPendingHosts(autoId).map((item) => item.host),
  )
  check(
    '自动修复: 留下审计记录（哪台主机、什么时候允许的）',
    readErrorLog(autoId).some((entry) => entry.operation === 'grant' && entry.message.includes(host)),
    readErrorLog(autoId).slice(0, 2),
  )
  const autoAgain = await resolvePlatformTrack(autoTrack, undefined, getSettings(), secrets)
  check(
    '自动修复: 第二次播放不需要任何授权动作',
    Boolean(autoAgain?.url) && readPendingHosts(autoId).length === 0,
    autoAgain?.url,
  )

  /*
   * 关掉开关之后必须回到“拒绝 + 告诉你去哪点”，而且不能偷偷授权。
   *
   * 这里改走**单音源路径**（`resolveStream`）而不是平台聚合：平台上还有别的已授权音源愿意代劳，
   * 聚合层会正常地回退到它并成功——那样测到的是多音源回退（那个行为本身是对的），不是开关。
   * 单音源路径只有一个候选，拒绝就是拒绝，而且它连带的正是下载/歌词旁边那条真实调用。
   */
  console.log('step: 关掉自动授权后仍然拒绝')
  await updateSettings({ autoGrantSourceHosts: false })
  await removeScriptSource(autoId)
  const offSaved = await confirm(
    { ...probe.manifest!, id: autoId, name: 'E2E 自动修复音源' },
    resolvingScript(origin),
    [],
  )
  check(
    '关闭自动授权: 音源可重新安装且授权为零（构造成可复现的“首次被拒”状态）',
    offSaved.ok && (getEntry(autoId)?.allowedHosts.length ?? -1) === 0,
    offSaved.errors,
  )
  let offError: { code: string; message: string } = { code: '', message: '' }
  try {
    await resolveStream(autoId, 'track-1', getSettings(), secrets, { track: autoTrack })
  } catch (error) {
    offError = toSourceErrorInfo(error, '测试')
  }
  check(
    '关闭自动授权: 仍然拒绝，而且没有偷偷把主机加进白名单',
    offError.code === 'PERMISSION' && (getEntry(autoId)?.allowedHosts.length ?? -1) === 0,
    { code: offError.code, hosts: getEntry(autoId)?.allowedHosts },
  )
  check(
    '关闭自动授权: 提示里给出主机名，并且主机已记为待授权（可手动允许）',
    offError.message.includes(host) && readPendingHosts(autoId).some((item) => item.host === host),
    readPendingHosts(autoId).map((item) => item.host),
  )

  /* 同一个调用、同一个音源，只把开关打回去：应当自己把主机允许了并重试。 */
  await updateSettings({ autoGrantSourceHosts: true })
  const managerRepaired = await resolveStream(autoId, 'track-1', getSettings(), secrets, { track: autoTrack })
  check(
    '自动修复: 单音源路径（下载/歌词旁的那条调用）同样会授权并重试',
    Boolean(managerRepaired?.url) && (getEntry(autoId)?.allowedHosts ?? []).includes(host),
    { url: managerRepaired?.url, hosts: getEntry(autoId)?.allowedHosts },
  )
  // 不把带授权的音源留给后面的用例，避免它们“被意外地代劳”。
  await removeScriptSource(autoId)

  /*
   * ------------------------------------------- 3b2. 安全模式（平台访问）
   *
   * Three promises, and each one is checked **where it is enforced** — in the request path, not in the
   * switch's own label. The fixture is plain `http://127.0.0.1`, which is exactly the traffic safe mode
   * exists to refuse, so this suite can observe all three without inventing an endpoint.
   */
  console.log('step: 安全模式')
  const safeId = 'safe-mode-source'
  await removeScriptSource(safeId)
  await updateSettings({ safeMode: false, autoGrantSourceHosts: true })
  const safeOffInstall = await confirm({ ...probe.manifest!, id: safeId, name: 'E2E 安全模式音源' }, resolvingScript(origin), [])
  check('安全模式: 关闭时新音源默认启用（不改变原有行为）', safeOffInstall.ok && isEnabled(safeId, getSettings()) === true, safeOffInstall.errors)
  await removeScriptSource(safeId)

  await updateSettings({ safeMode: true })
  check('安全模式: 开关写入设置并可读回', getSettings().safeMode === true, getSettings().safeMode)

  /*
   * ③ 新装音源默认禁用。用应用自己的安装入口（`confirm`）/ `saveScriptSource` 同一条路径，
   * 而不是直接写设置——否则测的是设置 API，不是安装策略。
   */
  const safeInstall = await confirm({ ...probe.manifest!, id: safeId, name: 'E2E 安全模式音源' }, resolvingScript(origin), [])
  check(
    '安全模式: 新装音源默认禁用（不加载、不联网，直到用户手动启用）',
    safeInstall.ok && isEnabled(safeId, getSettings()) === false && getSettings().enabledSources[safeId] === false,
    { ok: safeInstall.ok, enabled: getSettings().enabledSources[safeId] },
  )
  /*
   * 而且安装结果要把这件事**说出来**，而不是让渲染层从自己的安全模式开关去猜。
   *
   * 界面原来就是这么猜的，于是有一个它猜不对的情形：用户重新保存一个已启用的音源时，主进程故意不动它的状态
   * （编辑已经信任的东西不该被静默关掉），而页面仍然告诉他“新音源为禁用状态”。现在这个布尔值只能来自这里。
   */
  check(
    '安全模式: 安装结果如实带上“被策略禁用”，供界面原样转述',
    safeInstall.disabledByPolicy === true,
    safeInstall.disabledByPolicy,
  )
  const safeAggregate = await searchAll('测试', {}, getSettings(), secrets)
  check(
    '安全模式: 禁用状态下的新音源不参与聚合搜索',
    !safeAggregate.some((item) => item.sourceId === safeId),
    safeAggregate.map((item) => item.sourceId),
  )
  await updateSettings({ enabledSources: { [safeId]: true } })
  const safeAfterEnable = await searchAll('测试', {}, getSettings(), secrets)
  check(
    '安全模式: 手动启用后立即恢复（策略不等于永久禁用）',
    safeAfterEnable.some((item) => item.sourceId === safeId),
    safeAfterEnable.map((item) => item.sourceId),
  )
  /*
   * 已启用的音源再保存一次（用户改配置、改授权都会走到这里）：安全模式不该把它按回去，
   * 结果也必须如实说“这次没禁用”——这正是界面以前会讲错的那个情形。
   */
  const safeResave = await confirm({ ...probe.manifest!, id: safeId, name: 'E2E 安全模式音源' }, resolvingScript(origin), [])
  check(
    '安全模式: 重新保存已启用的音源不会被按回去，结果也说清没被禁用',
    safeResave.ok && safeResave.disabledByPolicy === false && isEnabled(safeId, getSettings()) === true,
    { ok: safeResave.ok, disabledByPolicy: safeResave.disabledByPolicy, enabled: isEnabled(safeId, getSettings()) },
  )

  /*
   * ② 明文 http 被拒，且报的是“安全模式”而不是“没授权”。
   *
   * `autoGrantSourceHosts` 在安全模式下是打开的——这条用例要证明的是它已经被盖过，而不是它本来就是关的。
   */
  let safeError: { code: string; message: string } = { code: '', message: '' }
  try {
    await resolveStream(safeId, 'track-1', getSettings(), secrets, { track: autoTrack })
  } catch (error) {
    safeError = toSourceErrorInfo(error, '测试')
  }
  check(
    '安全模式: 明确拒绝明文 http 接口请求，并说清是安全模式拒的',
    safeError.code === 'UNSUPPORTED' && safeError.message.includes('安全模式'),
    { code: safeError.code, message: safeError.message },
  )
  /*
   * 而且音源名只能出现一次。
   *
   * 这条断言是看了真实读数才写的：策略函数和它的调用方**各自**加了一遍前缀，于是用户看到的是
   * 「E2E 解析音源：E2E 解析音源：安全模式已开启…」。文本重复不会报错，只会让人以为这个提示坏了、
   * 于是不再读它——而这一段正是告诉他该去哪个开关的那句话。前缀的所有权现在唯一：调用方加，策略不加。
   */
  const namePrefix = 'E2E 解析音源'
  const nameOccurrences = safeError.message.split(namePrefix).length - 1
  check(
    '安全模式: 报错里音源名只说一遍（重复前缀会让用户以为提示坏了）',
    nameOccurrences === 1,
    { occurrences: nameOccurrences, message: safeError.message },
  )
  /*
   * 同一个名字叠加问题在**平台聚合**路径上也存在（那里把每个音源的失败拼成一句话，而拼进去的失败
   * 消息本身已经带了音源名），但**不能**在这里用一个端到端用例去“证明”它：上一句刚把这首歌解析成功，
   * 解析结果已经有缓存，再跑一次根本不会再发请求——我第一版就是这么写的，读数是 `occurrences: 0`
   * 加空消息，等于在空集上求通过。改成直接钉住那条共享规则本身。
   */
  check(
    '错误前缀规则: 已经带音源名的消息不会被加第二遍（也不会给空名字加）',
    namePrefixed('测试音源', '测试音源：出错了') === '测试音源：出错了' &&
      namePrefixed('测试音源', '出错了') === '测试音源：出错了' &&
      namePrefixed('', '出错了') === '出错了',
    [
      namePrefixed('测试音源', '测试音源：出错了'),
      namePrefixed('测试音源', '出错了'),
      namePrefixed('', '出错了'),
    ],
  )
  /*
   * ① 未授权主机在安全模式下不会被自动放行。主机名仍然被记下来（用户看得见要放行谁），但不写入任何白名单，
   * 也不会重试到成功。
   */
  check(
    '安全模式: 未授权主机不会被自动放行（自动授权开关被盖过）',
    (getEntry(safeId)?.allowedHosts.length ?? -1) === 0,
    getEntry(safeId)?.allowedHosts,
  )
  /*
   * 而且**每一条**自动授权的入口都要受它管。
   *
   * 播放那两条路径本来会先问策略再修；音源详情页的「自检并自动修复」按钮直接调 `repairRefusedHosts`，
   * 所以安全模式开着时它照样会把主机加进去——开关在界面上写着“未授权主机不再自动放行”，行为却相反。
   * 这里用那个按钮自己的入口（`selfCheckSource(..., { repair: true })`）去证明它现在也守规矩，并且
   * 把拒绝的原因带出来（否则空列表读起来像“一切正常”）。
   */
  const selfCheckUnderSafeMode = await selfCheckSource(safeId, { repair: true, keyword: '测试' }, getSettings(), secrets)
  check(
    '安全模式: 「自检并自动修复」不会悄悄授权（拒绝后白名单仍然是空的）',
    selfCheckUnderSafeMode !== null &&
      selfCheckUnderSafeMode.repaired.length === 0 &&
      (getEntry(safeId)?.allowedHosts.length ?? -1) === 0,
    {
      repaired: selfCheckUnderSafeMode?.repaired,
      repairBlocked: selfCheckUnderSafeMode?.repairBlocked,
      allowedHosts: getEntry(safeId)?.allowedHosts,
    },
  )
  /*
   * 但“自检没修”并不能证明那条分支守规矩：这一步的失败码是 UNSUPPORTED（安全模式拒了明文），
   * 而修修复只会因 PERMISSION 触发，两者不可互换（这是对的：明文不是靠授权能解决的事）。
   * 所以直接造出那条分支该处理的状态——记下一台待授权主机（请求被拒时会自动记）——再看它会不会被偷偷加进去。
   */
  recordPendingHost(safeId, 'pending.example.com', 'https://pending.example.com/api')
  const blockedRepair = await repairRefusedHosts(safeId)
  check(
    '安全模式: 修复入口本身也守规矩（说清是安全模式拒的，而不是静默什么都不做）',
    blockedRepair.granted.length === 0 &&
      Boolean(blockedRepair.blocked?.includes('安全模式')) &&
      (getEntry(safeId)?.allowedHosts ?? []).every((allowed) => !allowed.includes('pending.example.com')),
    {
      granted: blockedRepair.granted,
      blocked: blockedRepair.blocked,
      allowedHosts: getEntry(safeId)?.allowedHosts,
    },
  )

  /* 同一个音源、同一个调用，只把安全模式关掉：拒绝消失，自动授权恢复。 */
  await updateSettings({ safeMode: false })
  const safeRecovered = await resolveStream(safeId, 'track-1', getSettings(), secrets, { track: autoTrack })
  check(
    '安全模式: 关闭后同一调用立即恢复（授权与解析都回到原行为）',
    Boolean(safeRecovered?.url) && (getEntry(safeId)?.allowedHosts ?? []).includes(host),
    { url: safeRecovered?.url, hosts: getEntry(safeId)?.allowedHosts },
  )
  await removeScriptSource(safeId)

  /*
   * ------------------------------------------- 3c. 单个音源的管理页：自检与撤销
   *
   * 自检的每一步都是真操作，报告的就是当时真的发生了什么；修复只针对“未授权”，而且必须能撤销。
   */
  console.log('step: 单音源自检与撤销')
  const checkId = 'self-check-source'
  await confirm({ ...probe.manifest!, id: checkId, name: 'E2E 自检音源' }, resolvingScript(origin), [])

  /*
   * 关键词传 '测试'：fixture 服务器的搜索是按关键词过滤的，用默认关键词会返回 0 条，那样自检就
   * 停在“没有可解析的曲目”上——那是产品行为，不是这个用例要验的东西。默认关键词的行为单独验。
   */
  const beforeRepair = await selfCheckSource(checkId, { repair: false, keyword: '测试' })
  check(
    '自检: 未授权时如实报告失败，并指名是哪一步、什么错误码',
    !beforeRepair.ok &&
      beforeRepair.steps.some((step) => step.code === 'PERMISSION') &&
      beforeRepair.steps.filter((step) => !step.ok && !step.skipped).length > 0,
    { steps: beforeRepair.steps.map((step) => `${step.key}:${step.ok ? 'ok' : (step.skipped ? 'skipped' : (step.code ?? 'fail'))}`) },
  )
  check(
    '自检: 没被问到的步骤标为“跳过”（不把未执行说成失败）',
    beforeRepair.steps.some((step) => step.key === 'stream' && step.skipped === true),
    beforeRepair.steps.filter((step) => step.skipped).map((step) => step.key),
  )
  check(
    '自检: 报出未授权的主机（可一键允许）',
    beforeRepair.pendingHosts.includes(host) && beforeRepair.repaired.length === 0,
    { pending: beforeRepair.pendingHosts, hosts: getEntry(checkId)?.allowedHosts },
  )

  const repaired = await selfCheckSource(checkId, { repair: true, keyword: '测试' })
  check(
    '自检修复: 自动允许主机、重试并全部通过',
    repaired.ok && repaired.repaired.includes(host) && repaired.pendingHosts.length === 0,
    { ok: repaired.ok, repaired: repaired.repaired, pending: repaired.pendingHosts },
  )
  check(
    '自检修复: 搜索真的拿到结果、取地址真的成功（两步都不是跳过）',
    repaired.steps.every((step) => step.ok && !step.skipped) &&
      repaired.steps.some((step) => step.key === 'search' && /返回 [1-9]/.test(step.message)) &&
      repaired.steps.some((step) => step.key === 'stream' && step.ok),
    repaired.steps.map((step) => `${step.key}:${step.message}`),
  )
  check(
    '描述符: 已授权的主机在音源描述里可见（管理页据此列出并可撤销）',
    (describeSources(getSettings(), secrets).find((item) => item.id === checkId)?.allowedHosts ?? []).includes(host),
    describeSources(getSettings(), secrets).find((item) => item.id === checkId)?.allowedHosts,
  )

  /*
   * “搜索没结果”要单独验，而且必须在授权之后：零授权时第一个被拒的请求是搜索本身，自检根本走不到
   * 取地址那一步，测到的是权限报错而不是这个行为。这里关键词故意选一个 fixture 一定查不到的。
   */
  const zeroHit = await selfCheckSource(checkId, { keyword: '这个词不可能有结果' })
  check(
    '自检: 搜索无结果时取地址一步标为“跳过”而不是失败（不把健康音源说成坏的）',
    zeroHit.ok &&
      zeroHit.steps.some((step) => step.key === 'search' && step.ok) &&
      zeroHit.steps.some((step) => step.key === 'stream' && step.skipped === true),
    zeroHit.steps.map((step) => `${step.key}:${step.skipped ? 'skipped' : step.ok ? 'ok' : 'fail'}`),
  )

  const revoked = await revokeSourceHosts(checkId, [host])
  check('撤销: 授权真的从音源记录里去掉', revoked.granted.includes(host) && !(getEntry(checkId)?.allowedHosts ?? []).includes(host), getEntry(checkId)?.allowedHosts)
  /*
   * “撤销后重新被拒”只有在自动授权关掉时才能看到：开着的时候，那次拒绝会立即被自动修复（那是上一个
   * 用例验过的行为），于是请求又成功了。所以这里先关掉开关，验的才是“撤销本身真的生效了”。
   */
  await updateSettings({ autoGrantSourceHosts: false })
  let afterRevoke = ''
  try {
    await resolveStream(checkId, 'track-1', getSettings(), secrets, { track: autoTrack })
  } catch (error) {
    afterRevoke = toSourceErrorInfo(error, '测试').code
  }
  check('撤销: 撤销后请求重新被拒（撤销不是摆设）', afterRevoke === 'PERMISSION', afterRevoke)
  await updateSettings({ autoGrantSourceHosts: true })
  const revokeMissing = await revokeSourceHosts(checkId, ['never-granted.example.com'])
  check(
    '撤销: 撤销一个本就没授权的主机时如实报错（不假装成功）',
    !revokeMissing.granted.includes('never-granted.example.com') && readErrorLog(checkId).some((entry) => entry.operation === 'revoke'),
    readErrorLog(checkId).filter((entry) => entry.operation === 'revoke').slice(0, 1),
  )
  await removeScriptSource(checkId)

  /* ---------------------------------------------------------------- 4. real execution */

  const searched = await searchOne(sourceId, '测试', {}, getSettings(), secrets)
  check(
    'runtime: 脚本真实执行 search（字段 songname→title 归一化）',
    searched.ok && searched.tracks.length === 2 && searched.tracks[0].title === '测试歌曲一' && searched.tracks[0].artist === '测试歌手',
    searched.ok ? searched.tracks.map((track) => track.title) : searched.error,
  )

  check(
    'runtime: 脚本结果的可用音质被读取（qualitys/qualities 两种写法、对象与字符串混排、去重）',
    JSON.stringify(searched.tracks[0]?.qualities) === JSON.stringify(['128k', 'flac24bit']) &&
      JSON.stringify(searched.tracks[1]?.qualities) === JSON.stringify(['320k']),
    searched.tracks.map((track) => track.qualities),
  )

  check(
    'runtime: 搜索结果里的封面（img 字段）被中继为 aurora-media://',
    Boolean(searched.tracks[0]?.cover?.startsWith('aurora-media://remote/')) &&
      Boolean(searched.tracks[1]?.cover?.startsWith('aurora-media://remote/')),
    searched.tracks.map((item) => item.cover),
  )
  if (searched.tracks[0]?.cover) {
    // The relay is only worth anything if the bytes actually arrive: this fetches the token the
    // renderer would have put in an <img src>.
    const coverResponse = await net.fetch(searched.tracks[0].cover)
    const coverBytes = Buffer.from(await coverResponse.arrayBuffer())
    check(
      'runtime: 中继后的封面真的取到图片字节',
      coverResponse.status === 200 &&
        String(coverResponse.headers.get('content-type')).startsWith('image/png') &&
        coverBytes.length === PNG.length,
      { status: coverResponse.status, type: coverResponse.headers.get('content-type'), bytes: coverBytes.length },
    )
  }

  const track = searched.tracks[0]
  if (!track) throw new Error(`脚本搜索没有返回结果：${JSON.stringify(searched.error)}`)
  const resolved = await resolveStream(sourceId, track.sourceTrackId ?? track.id, getSettings(), secrets, {
    quality: '320k',
    track,
  })
  check(
    'runtime: getPlayUrl 返回的真实地址被中继为 aurora-media://',
    Boolean(resolved?.url?.startsWith('aurora-media://remote/')),
    resolved?.url,
  )

  const audio = resolved?.url ? await bytesOf(resolved.url) : { status: 0, type: '', bytes: 0 }
  check(
    'playback: 中继地址真的返回音频字节（206 + audio/wav + 内容）',
    audio.status === 206 && audio.type.includes('audio/wav') && audio.bytes === 64,
    audio,
  )

  const lyrics = await sourceLyrics({ ...track, sourceId } as AudioTrack, getSettings(), secrets)
  check(
    'runtime: getLyric 返回的 LRC 被解析为带时间轴的歌词',
    Boolean(lyrics && lyrics.lines.length === 2 && lyrics.lines[0].text.includes('第一行') && lyrics.lines[0].start === 1),
    lyrics?.lines.map((line) => `${line.start}:${line.text}`),
  )

  const detail = await searchOne(sourceId, '不存在的关键词', {}, getSettings(), secrets)
  check('runtime: 脚本拿不到结果时返回空列表而不是报错', detail.ok && detail.tracks.length === 0, {
    ok: detail.ok,
    count: detail.tracks.length,
  })

  /* ---------------------------------------------------------------- 5. sandbox integrity */

  const sandboxLine = (probe.declaration?.logs ?? []).find((line) => line.includes('sandbox:'))
  /*
   * What must hold here is *no Node surface*: `require`/`process` undefined, and `module` present
   * only as the plain `{ exports: {} }` shim that lets CommonJS-shaped bundles load — never Node's
   * module object (`moduleIsNode=false` proves it has no `require` on it). That shim is why the
   * assertion is "not Node's module" rather than the older, narrower `module=undefined`.
   *
   * `fetch` is deliberately **not** asserted as undefined: the bootstrap runs in the window's own
   * world, where `fetch` is a standard browser API. The invariant that matters is that it cannot
   * leave the machine — the host session cancels every request, which the `raw-fetch` check below
   * exercises for real. Asserting absence would have been asserting the wrong thing.
   */
  check(
    'sandbox: 脚本世界没有 require / process / Node 模块系统（只有桥）',
    Boolean(
      sandboxLine &&
        /require=undefined/.test(sandboxLine) &&
        /process=undefined/.test(sandboxLine) &&
        /moduleIsNode=false/.test(sandboxLine),
    ),
    sandboxLine,
  )

  /* ---------------------------------------------------------------- 6. bad data + hang + recovery */

  const badProbe = await probeScriptImport({ sourceText: badDataScript(origin), fileName: 'bad-data.js', id: 'e2e-bad-data' })
  const badSaved = await confirm(badProbe.manifest!, badDataScript(origin), [host])
  check('bad-data: 返回错误数据的音源可以安装（错误是运行时的）', badSaved.ok, badSaved.errors)
  const badSearch = await searchOne('e2e-bad-data', 'x', {}, getSettings(), secrets)
  check(
    'bad-data: 返回非数组时得到 INVALID_RESPONSE 错误码，而不是崩溃',
    !badSearch.ok && badSearch.error?.code === 'INVALID_RESPONSE',
    badSearch.error,
  )

  const hangProbe = await probeScriptImport({ sourceText: hangingScript(origin), fileName: 'hanging.js', id: 'e2e-hang' })
  const hangSaved = await confirm(hangProbe.manifest!, hangingScript(origin), [host])
  check('timeout: 会卡死的音源可以安装', hangSaved.ok, hangSaved.errors)
  const startedAt = Date.now()
  const hung = await searchOne('e2e-hang', 'hang', {}, getSettings(), secrets)
  const elapsed = Date.now() - startedAt
  check(
    'timeout: 死循环被超时强杀，主进程存活并得到 TIMEOUT',
    !hung.ok && hung.error?.code === 'TIMEOUT' && elapsed < 8000,
    { code: hung.error?.code, elapsed },
  )
  check('isolation: 主进程仍然可以正常聚合搜索（没有一起挂掉）', Array.isArray(await searchAll('测试', {}, getSettings(), secrets)), 'searchAll ok')

  const recovered = await searchOne('e2e-hang', '测试', {}, getSettings(), secrets)
  check(
    'isolation: 宿主被丢弃后下一次调用自动重建并能返回结果',
    recovered.ok && recovered.tracks.length === 2,
    recovered.ok ? recovered.tracks.length : recovered.error,
  )

  const rawFetch = await searchOne('e2e-hang', 'raw-fetch', {}, getSettings(), secrets)
  check(
    'sandbox: 脚本自己的 fetch 无法出网（只允许走桥）',
    !rawFetch.ok && !rawFetch.tracks.some((item) => item.title.includes('竟然成功')),
    rawFetch.error ?? rawFetch.tracks.map((item) => item.title),
  )

  /* ---------------------------------------------------------------- 6.5 crypto shim vs node:crypto */

  const cryptoProbeText = `
console.log('md5:abc=' + globalThis.lx.utils.crypto.md5('abc'))
console.log('md5:cjk=' + globalThis.lx.utils.crypto.md5('秘钥测试 Aurora'))
console.log('sha1:abc=' + globalThis.lx.utils.crypto.sha1('abc'))
globalThis.defineAuroraSource({ name: 'crypto probe', version: '1', async search() { return [] } })
`
  const cryptoProbe = await probeScriptImport({ sourceText: cryptoProbeText, fileName: 'crypto.js', id: 'e2e-crypto' })
  const logLine = (prefix: string): string =>
    (cryptoProbe.declaration?.logs ?? []).find((line) => line.includes(prefix))?.split('=')[1] ?? ''
  check(
    'crypto: 沙箱内同步 md5 与 node:crypto 一致（含多字节 UTF-8）',
    logLine('md5:abc=') === createHash('md5').update('abc').digest('hex') &&
      logLine('md5:cjk=') === createHash('md5').update('秘钥测试 Aurora', 'utf8').digest('hex'),
    { abc: logLine('md5:abc='), cjk: logLine('md5:cjk=') },
  )
  check(
    'crypto: 沙箱内同步 sha1 与 node:crypto 一致',
    logLine('sha1:abc=') === createHash('sha1').update('abc').digest('hex'),
    logLine('sha1:abc='),
  )

  /* ---------------------------------------------------------------- 7. LX compatibility layer */

  const lxText = lxScript(origin, host)
  const lxProbe = await probeScriptImport({ sourceText: lxText, fileName: 'lx-source.js' })
  check(
    'lx: 通过 globalThis.lx 协议被识别并声明平台/能力/音质',
    lxProbe.ok &&
      lxProbe.manifest?.runtime === 'lx' &&
      lxProbe.declaration?.platforms.some((platform) => platform.id === 'e2eplat') &&
      lxProbe.declaration?.actions.includes('musicUrl'),
    { runtime: lxProbe.manifest?.runtime, actions: lxProbe.declaration?.actions, errors: lxProbe.errors },
  )

  const lxSaved = await confirm(lxProbe.manifest!, lxText, [host])
  const lxId = lxProbe.manifest!.id
  check('lx: 安装后出现在同一个注册表里（kind=script, runtime=lx）', lxSaved.ok && getEntry(lxId)?.kind === 'script', lxSaved.errors)

  const lxSearch = await searchOne(lxId, '测试', {}, getSettings(), secrets)
  check(
    'lx: 搜索经过兼容层执行，并用到同步 md5 签名（服务端校验通过）',
    lxSearch.ok && lxSearch.tracks.length === 2 && lxSearch.tracks[0].title === '测试歌曲一',
    lxSearch.ok ? lxSearch.tracks.map((item) => item.title) : lxSearch.error,
  )

  const lxTrack = lxSearch.tracks[0]
  if (!lxTrack) throw new Error(`LX 搜索没有返回结果：${JSON.stringify(lxSearch.error)}`)
  const lxStream = await resolveStream(lxId, lxTrack.sourceTrackId ?? lxTrack.id, getSettings(), secrets, { track: lxTrack })
  const lxAudio = lxStream?.url ? await bytesOf(lxStream.url) : { status: 0, type: '', bytes: 0 }
  check('lx: musicUrl 解析出的地址可以真正读到音频字节', lxAudio.status === 206 && lxAudio.type.includes('audio/wav'), lxAudio)

  /*
   * Plain-HTTP media URLs on a public host must be relayed, not refused.
   *
   * This is the exact shape real aggregators return
   * (`http://music.nxinxz.com/kw.php?id=…`, `http://kw-er.kuwo.cn/…`). The adapter used to validate
   * them with the *endpoint* rule, which demands HTTPS off-loopback, so a working source produced
   * 「播放地址不是合法的 http(s) 地址」 for every request. Asserting on the relay URL (not on a fetch)
   * keeps the check offline while still pinning the behaviour that matters.
   */
  const plainHttp = await resolveStream(lxId, lxTrack.sourceTrackId ?? lxTrack.id, getSettings(), secrets, {
    quality: 'plain-http',
    track: lxTrack,
  }).catch((error: unknown) => ({ url: `拒绝：${error instanceof Error ? error.message : String(error)}` }))
  check(
    'lx: 公网 HTTP 播放地址会被中继（聚合接口的常见形态，不是错误）',
    Boolean(plainHttp?.url?.startsWith('aurora-media://remote/')),
    plainHttp?.url ?? '(被拒绝了)',
  )

  const lxLyrics = await sourceLyrics({ ...lxTrack, sourceId: lxId } as AudioTrack, getSettings(), secrets)
  check('lx: lyric 动作返回的 LRC 被解析', Boolean(lxLyrics && lxLyrics.lines.length === 2), lxLyrics?.lines.map((line) => line.text))

  /* ------------------------------------------------- 7b. 洛雪音源库（user_api.json）导入 */

  /*
   * The real-world entry point: a user has twenty sources in one file, not twenty `.js` files.
   *
   * The fixture is built the way LX builds it — `gz_` + base64(zlib deflate) — because that encoding
   * (not gzip, despite the prefix) is exactly the thing that silently fails if it is guessed wrong.
   * Three entries cover the three outcomes: one importable, one whose script is broken, one whose
   * payload cannot be decoded at all.
   */
  const libraryJson = JSON.stringify({
    userApis: [
      {
        id: 'lib-good',
        name: '库里可用的音源',
        version: '2.5.0',
        author: 'aurora-smoke',
        script: `gz_${deflateSync(Buffer.from(lxScript(origin, host), 'utf8')).toString('base64')}`,
      },
      {
        id: 'lib-broken',
        name: '库里坏掉的音源',
        version: '0.0.1',
        script: `gz_${deflateSync(Buffer.from('this is not javascript at all ((', 'utf8')).toString('base64')}`,
      },
      { id: 'lib-undecodable', name: '库里无法解码的音源', script: '这不是 base64，也不是脚本' },
    ],
  })

  const preview = await previewLxLibrary(libraryJson, 'user_api.json')
  const good = preview.items.find((item) => item.id === 'lib-good')
  const broken = preview.items.find((item) => item.id === 'lib-broken')
  check(
    '洛雪音源库: 三个条目都被读出来（解码失败的不静默丢弃）',
    preview.items.length === 3 && preview.errors.length === 1,
    { items: preview.items.map((item) => `${item.id}:${item.ok}`), errors: preview.errors },
  )
  check(
    '洛雪音源库: gz_+deflate 的脚本被真实执行，声明了平台与动作',
    Boolean(good?.ok && good.platforms.some((platform) => platform.id === 'e2eplat') && good.actions.includes('musicUrl')),
    { ok: good?.ok, platforms: good?.platforms.map((platform) => platform.id), actions: good?.actions },
  )
  check(
    '洛雪音源库: 库里的名称优先于脚本内声明（用户认得的是前者）',
    good?.name === '库里可用的音源' && good?.version === '2.5.0',
    `${good?.name} / ${good?.version}`,
  )
  check('洛雪音源库: 坏脚本被标记为加载失败并给出原因', broken?.ok === false && broken.errors.length > 0, broken?.errors)
  check(
    '洛雪音源库: 预览不写任何东西（导入前注册表未变）',
    getEntry('lib-good') === undefined,
    getEntry('lib-good'),
  )

  const imported = await importLxLibrary(libraryJson, ['lib-good', 'lib-broken', 'lib-undecodable'], 'user_api.json')
  check(
    '洛雪音源库: 只导入勾选的、有内容可写的条目（无法解码的不会被写进磁盘）',
    imported.added === 2 && imported.failed.length === 0 && getEntry('lib-undecodable') === undefined,
    { added: imported.added, failed: imported.failed, undecodable: getEntry('lib-undecodable') },
  )
  /*
   * A script that does not run still *installs* — its failure belongs to the runtime, not to the
   * installer.
   *
   * This is the separation the whole source system is built on: installation answers "is this a
   * source file we can read", and running answers "does it work". Refusing to install a broken
   * source would be the admission gate in a new costume.
   */
  const brokenSearch = await searchOne('lib-broken', '测试', {}, getSettings(), secrets)
  check(
    '洛雪音源库: 坏脚本安装成功，但调用时真实报错（安装与运行是两个阶段）',
    !brokenSearch.ok && typeof brokenSearch.error?.message === 'string' && brokenSearch.error.message.length > 0,
    brokenSearch.error ?? brokenSearch.tracks.map((item) => item.title),
  )

  const librarySearch = await searchOne('lib-good', '测试', {}, getSettings(), secrets)
  check(
    '洛雪音源库: 导入后的音源立刻可以搜索（走的是同一套运行时）',
    librarySearch.ok && librarySearch.tracks.length === 2,
    librarySearch.ok ? librarySearch.tracks.map((item) => item.title) : librarySearch.error,
  )
  const libraryTrack = librarySearch.tracks[0]
  const libraryStream = libraryTrack
    ? await resolveStream('lib-good', libraryTrack.sourceTrackId ?? libraryTrack.id, getSettings(), secrets, {
        track: libraryTrack,
      })
    : null
  const libraryAudio = libraryStream?.url ? await bytesOf(libraryStream.url) : { status: 0, type: '', bytes: 0 }
  check(
    '洛雪音源库: 导入后的音源能解析出真实音频字节',
    libraryAudio.status === 206 && libraryAudio.type.includes('audio/wav'),
    libraryAudio,
  )

  /*
   * Duplicate ids inside one library must not collapse into one entry: LX ids are unique, but a
   * hand-edited file is a legitimate thing to have, and silently overwriting would lose a source.
   */
  const duplicates = await previewLxLibrary(
    JSON.stringify({
      userApis: [
        { id: 'dup', name: '重名一', script: `gz_${deflateSync(Buffer.from(lxScript(origin, host), 'utf8')).toString('base64')}` },
        { id: 'dup', name: '重名二', script: `gz_${deflateSync(Buffer.from(lxScript(origin, host), 'utf8')).toString('base64')}` },
      ],
    }),
    'dup.json',
  )
  check(
    '洛雪音源库: 同 id 的条目被区分开（不会覆盖）',
    duplicates.items.length === 2 && duplicates.items[0].id !== duplicates.items[1].id,
    duplicates.items.map((item) => item.id),
  )

  await removeScriptSource('lib-good')
  await removeScriptSource('lib-broken')

  /* ---------------------------------------------------------------- 8. enable / disable */

  await updateSettings({ enabledSources: { [sourceId]: false } })
  invalidateSourceRuntime(sourceId)
  const afterDisable = await searchOne(sourceId, '测试', {}, getSettings(), secrets)
  check('lifecycle: 禁用后不再发起请求', !afterDisable.ok, afterDisable.error?.message)

  await updateSettings({ enabledSources: { [sourceId]: true } })
  invalidateSourceRuntime(sourceId)
  const afterEnable = await searchOne(sourceId, '测试', {}, getSettings(), secrets)
  check('lifecycle: 重新启用后立即恢复', afterEnable.ok && afterEnable.tracks.length === 2, afterEnable.ok)

  /* ---------------------------------------------------------------- 9. reload + tamper */

  const inspected = await inspectScriptSource(sourceId)
  check('lifecycle: inspect 报告文件与评审时一致', inspected.ok, inspected.message)

  const tampered = auroraScript(origin).replace("name: 'E2E 测试音源'", "name: 'E2E 测试音源（被改动）'")
  await writeFile(join(runDir, 'sources', sourceId, 'source.js'), tampered, 'utf8')
  const tamperInspect = await inspectScriptSource(sourceId)
  check('tamper: 文件被改动后被识别为需要重新确认', !tamperInspect.ok && /修改/.test(tamperInspect.message), tamperInspect.message)

  // Restart the registry while the file is tampered: the source must come up *blocked*, explaining
  // why, instead of silently running code the user never reviewed.
  disposeAllScriptHosts()
  unregisterSource(sourceId)
  await initSourceStore(runDir)
  await initScriptSources(runDir, {
    preloadPath: join(fileURLToPath(new URL('.', import.meta.url)), 'script-host.cjs'),
  })
  const blockedSearch = await searchOne(sourceId, '测试', {}, getSettings(), secrets)
  check(
    'tamper: 重启后被改动的脚本处于“需要重新确认”状态，调用明确报错',
    !blockedSearch.ok && /修改/.test(blockedSearch.error?.message ?? ''),
    blockedSearch.error,
  )

  const reloadResult = await reloadScriptSource(sourceId)
  check('tamper: 重新加载后恢复（重新推导能力并写回哈希）', reloadResult.ok, reloadResult.errors)
  const afterReload = await searchOne(sourceId, '测试', {}, getSettings(), secrets)
  check('tamper: 重新加载后可以正常搜索', afterReload.ok && afterReload.tracks.length === 2, afterReload.ok)

  /* ---------------------------------------------------------------- 10. delete */

  const removed = await removeScriptSource('e2e-bad-data')
  check(
    'lifecycle: 删除后注册表与脚本文件都被移除',
    removed.ok && !getEntry('e2e-bad-data') && !getSource('e2e-bad-data') && !existsSync(join(runDir, 'sources', 'e2e-bad-data')),
    removed.errors,
  )

  /* ---------------------------------------------------------------- 11. restart persistence */

  // Simulate a restart: drop every runtime object, then re-load from disk.
  disposeAllScriptHosts()
  // Every entry is user-owned now (declarative or script): the platform registry is read-only and
  // never lives in this table, so a restart drops all of them and reloads from disk.
  for (const entry of listEntries()) {
    unregisterSource(entry.id)
  }
  for (const entry of listEntries()) {
    if (entry.kind === 'script') disposeScriptHost(entry.id)
  }
  clearPendingHosts(sourceId)
  invalidateSourceRuntime()
  await initSourceStore(runDir)
  await initScriptSources(runDir, {
    preloadPath: join(fileURLToPath(new URL('.', import.meta.url)), 'script-host.cjs'),
  })
  const restartedSettings = getSettings()
  check(
    'restart: 磁盘上的 sources.json 是唯一真相（脚本音源重新注册）',
    Boolean(getEntry(sourceId) && getSource(sourceId) && getEntry(lxId) && getSource(lxId)),
    listEntries().map((entry) => `${entry.id}:${entry.kind}`),
  )
  const afterRestart = await searchOne(sourceId, '测试', {}, restartedSettings, secrets)
  check(
    'restart: 重启后仍然能真实搜索（授权主机也被保留）',
    afterRestart.ok && afterRestart.tracks.length === 2,
    afterRestart.ok ? afterRestart.tracks.length : afterRestart.error,
  )
  const lxAfterRestart = await searchOne(lxId, '测试', {}, restartedSettings, secrets)
  check('restart: 洛雪音源同样恢复', lxAfterRestart.ok && lxAfterRestart.tracks.length === 2, lxAfterRestart.ok)

  /* ---------------------------------------------------------------- 11.5 unknown platform / provider */

  // Aurora has no provider registry at all, so "unknown provider" cannot be a failure mode. The
  // closest thing to it is a source that declares a platform nobody has heard of — it must install,
  // search and resolve exactly like any other.
  const unknownText = auroraScript(origin).replace("platforms: [{ id: 'e2e', name: 'E2E 平台' }]", "platforms: [{ id: 'never-heard-of-it', name: '某个没人听过的平台' }]")
  const unknownProbe = await probeScriptImport({ sourceText: unknownText, fileName: 'unknown-platform.js', id: 'e2e-unknown-platform' })
  const unknownSaved = await confirm(unknownProbe.manifest!, unknownText, [host])
  const unknownSearch = await searchOne('e2e-unknown-platform', '测试', {}, getSettings(), secrets)
  const unknownDescriptor = describeSources(getSettings(), secrets).find((item) => item.id === 'e2e-unknown-platform')
  check(
    'unknown platform: 未知平台/未知来源没有 provider 注册表，也能安装、启用与搜索',
    unknownSaved.ok &&
      unknownSearch.ok &&
      unknownSearch.tracks.length === 2 &&
      unknownDescriptor?.platforms.some((platform) => platform.id === 'never-heard-of-it') === true,
    { installed: unknownSaved.ok, found: unknownSearch.ok ? unknownSearch.tracks.length : unknownSearch.error },
  )

  /* ------------------------------------------------- 11.6 更宽的导入面（种类，而不是审批） */

  /*
   * Three shapes that used to be refused with an error nobody could act on. Each one is asserted on
   * the *outcome* (installed? searched? bytes?) rather than on a message, because the point is that
   * the source works, not that it is described well.
   *
   * This section runs last on purpose: it installs sources, and the suite's earlier assertions count
   * what is registered.
   */

  // (a) Loaded, but declared nothing → installable, and honestly reported as not-ready.
  const opaqueText = opaqueScript()
  const opaqueDetected = await detectSourceText(opaqueText, 'opaque.js')
  check(
    'wider import: 已加载但未声明能力的脚本被识别为脚本（可安装），提示为警告而非错误',
    opaqueDetected.ok &&
      opaqueDetected.kind === 'script' &&
      opaqueDetected.errors.length === 0 &&
      (opaqueDetected.warnings ?? []).length > 0,
    {
      kind: opaqueDetected.kind,
      summary: opaqueDetected.summary,
      warnings: opaqueDetected.warnings,
      errors: opaqueDetected.errors.slice(0, 1),
    },
  )
  const opaqueProbe = await probeScriptImport({ sourceText: opaqueText, fileName: 'opaque.js', id: 'e2e-opaque' })
  check(
    'wider import: 未声明能力不是对“源”的误判（不会把内部对象当成音源）',
    opaqueProbe.ok && opaqueProbe.declaration?.actions.length === 0,
    { ok: opaqueProbe.ok, actions: opaqueProbe.declaration?.actions, warnings: opaqueProbe.warnings },
  )
  const opaqueSaved = await confirm(opaqueProbe.manifest!, opaqueText, [])
  const opaqueDescriptor = describeSources(getSettings(), secrets).find((item) => item.id === 'e2e-opaque')
  check(
    'wider import: 它可以安装，且在音源管理里如实显示为“未就绪”（能力全为 false）',
    opaqueSaved.ok &&
      opaqueDescriptor !== undefined &&
      opaqueDescriptor.capabilities.search === false &&
      opaqueDescriptor.capabilities.stream === false,
    { installed: opaqueSaved.ok, errors: opaqueSaved.errors, capabilities: opaqueDescriptor?.capabilities },
  )

  // (b) Threw while loading → the one real refusal, and it says why.
  const throwingText = "throw new Error('这个脚本一加载就抛错')"
  const throwingDetected = await detectSourceText(throwingText, 'throwing.js')
  check(
    'wider import: 加载时抛错的脚本是唯一被拦下的情况，且原因是真实的可读错误',
    !throwingDetected.ok &&
      throwingDetected.kind === 'script' &&
      throwingDetected.errors.some((line) => line.includes('这个脚本一加载就抛错')),
    { kind: throwingDetected.kind, summary: throwingDetected.summary, errors: throwingDetected.errors.slice(0, 1) },
  )

  // (c) CommonJS export + getMediaSource: installs, searches, and plays for real.
  const aliasText = aliasScript(origin)
  const aliasDetected = await detectSourceText(aliasText, 'alias.js')
  check(
    'wider import: module.exports + getMediaSource 被识别为音源，getMediaSource 归入 getPlayUrl',
    aliasDetected.ok &&
      aliasDetected.kind === 'script' &&
      ['search', 'getPlayUrl'].every((action) => (aliasDetected.script?.actions ?? []).includes(action)),
    { kind: aliasDetected.kind, actions: aliasDetected.script?.actions },
  )
  const aliasProbe = await probeScriptImport({ sourceText: aliasText, fileName: 'alias.js', id: 'e2e-alias' })
  const aliasSaved = await confirm(aliasProbe.manifest!, aliasText, [host])
  check('wider import: 别名风格的音源可以安装', aliasSaved.ok, aliasSaved.errors)
  const aliasSearch = await searchOne('e2e-alias', '测试', {}, getSettings(), secrets)
  check(
    'wider import: 别名风格音源真实搜索（嵌套 {isEnd,data} 也被归一化）',
    aliasSearch.ok && aliasSearch.tracks.length === 2 && aliasSearch.tracks[0].title === '测试歌曲一',
    aliasSearch.ok ? aliasSearch.tracks.map((item) => item.title) : aliasSearch.error,
  )
  const aliasTrack = aliasSearch.ok ? aliasSearch.tracks[0] : undefined
  if (!aliasTrack) throw new Error(`别名风格音源没有返回结果：${JSON.stringify(aliasSearch.error)}`)
  const aliasStream = await resolveStream('e2e-alias', aliasTrack.sourceTrackId ?? aliasTrack.id, getSettings(), secrets, {
    track: aliasTrack,
  })
  const aliasAudio = aliasStream?.url ? await bytesOf(aliasStream.url) : { status: 0, type: '', bytes: 0 }
  check(
    'wider import: getMediaSource 解析出的地址可以真正读到音频字节',
    aliasAudio.status === 206 && aliasAudio.type.includes('audio/wav'),
    aliasAudio,
  )

  // (d) 洛雪 source that announces itself only after its own slow request → waited for, not rejected.
  const lateText = lateLxScript(origin)
  const lateStartedAt = Date.now()
  const lateProbe = await probeScriptImport({ sourceText: lateText, fileName: 'late.js', id: 'e2e-late' })
  const lateElapsed = Date.now() - lateStartedAt
  check(
    'wider import: 延迟声明的洛雪音源被等到（宽限期真的在等，而不是立刻判定未声明）',
    lateProbe.ok &&
      lateProbe.manifest?.runtime === 'lx' &&
      (lateProbe.declaration?.platforms.length ?? 0) === 1 &&
      lateElapsed >= 2000,
    {
      ok: lateProbe.ok,
      runtime: lateProbe.manifest?.runtime,
      elapsed: lateElapsed,
      platforms: lateProbe.declaration?.platforms.map((platform) => platform.id),
      errors: lateProbe.errors.slice(0, 1),
      logs: (lateProbe.declaration?.logs ?? []).filter((line) => line.includes('late:')),
    },
  )
  const lateSaved = await confirm(lateProbe.manifest!, lateText, [host])
  const lateSearch = await searchOne('e2e-late', '测试', {}, getSettings(), secrets)
  check(
    'wider import: 等到声明后它真的能搜索（迟到不等于不可用）',
    lateSaved.ok && lateSearch.ok && lateSearch.tracks.length === 2,
    lateSearch.ok ? lateSearch.tracks.map((item) => item.title) : lateSearch.error,
  )

  // (e) One size limit, not two: a file the runtime accepts must not be refused by the detector.
  const bigText = `/*${'x'.repeat(1_100_000)}*/\n${aliasScript(origin)}`
  const bigDetected = await detectSourceText(bigText, 'big.js')
  check(
    'wider import: 1–2MB 的脚本不再被判为“未知格式/文件过大”（探测器与运行时限一致）',
    bigDetected.ok && bigDetected.kind === 'script' && (bigDetected.script?.actions ?? []).includes('search'),
    { kind: bigDetected.kind, summary: bigDetected.summary, bytes: bigText.length, errors: bigDetected.errors.slice(0, 1) },
  )

  await updateSettings({ enabledSources: { 'e2e-opaque': false } })
  await removeScriptSource('e2e-opaque')
  await removeScriptSource('e2e-alias')
  await removeScriptSource('e2e-late')

  /* ---------------------------------------------------------------- 12. error surface */

  const descriptors = describeSources(getSettings(), secrets)
  const scriptDescriptors = descriptors.filter((item) => item.kind === 'script')
  check(
    'diagnostics: 音源管理能读到脚本音源的真实状态、权限与平台',
    scriptDescriptors.length >= 2 &&
      scriptDescriptors.every((item) => item.permissions.includes('network') && Array.isArray(item.platforms)),
    scriptDescriptors.map((item) => `${item.id}:${item.status}:${item.pendingHosts.length}`),
  )

  /* ---------------------------------------------------------------- summary */

  await updateSettings({ enabledSources: {} })
  clearTimeout(watchdog)
  disposeAllScriptHosts()
  server.close()
  await rm(runDir, { recursive: true, force: true }).catch(() => undefined)

  const failed = checks.filter((item) => !item.ok)
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
  if (failed.length > 0) {
    console.log('FAILURES:')
    for (const item of failed) console.log(` - ${item.name}: ${JSON.stringify(item.detail)}`)
  }
  app.exit(failed.length === 0 ? 0 : 1)
})

