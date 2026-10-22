/**
 * Drives the packaged Windows build over the DevTools protocol and asserts that the real
 * production artifact works end to end: preload bridge present, IPC round trip to the main
 * process, CSP not blocking the renderer, and the media URL builder producing the custom scheme.
 *
 * Run with: node tools/packaged-app-check.mjs
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { deflateSync } from 'node:zlib'

const PORT = 9333
/*
 * Which artifact to test.
 *
 * Defaults to the unpacked build, but the portable and installer targets each embed their *own*
 * copy of the app (a compressed archive the launcher unpacks at startup), so "the unpacked build
 * passes" does not prove the file a user actually double-clicks works. Override this to test those:
 *
 *   AURORA_SMOKE_EXE="release/Aurora-Music-Portable-0.1.0-x64.exe" npm run smoke:app
 */
const exe = process.env.AURORA_SMOKE_EXE ?? 'release/win-unpacked/Aurora Music.exe'

/*
 * A real PNG, encoded here.
 *
 * The suite needs a *decodable* image to prove the cover path works in the packaged app — a route
 * that returns a few bytes would load as a broken image and every cover assertion would pass for the
 * wrong reason. Encoded with zlib rather than checked in as a binary blob so the file stays text.
 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value
  }
  return table
})()

function crc32(buffer) {
  let crc = -1
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/** A `size × size` RGB gradient. Not flat, so a dominant colour can actually be extracted from it. */
function coverPng(size = 96) {
  const stride = size * 3 + 1
  const raw = Buffer.alloc(size * stride)
  for (let y = 0; y < size; y += 1) {
    const row = y * stride
    raw[row] = 0 // filter: none
    for (let x = 0; x < size; x += 1) {
      raw[row + 1 + x * 3] = 30 + Math.round((x / (size - 1)) * 180)
      raw[row + 2 + x * 3] = 90 + Math.round((y / (size - 1)) * 120)
      raw[row + 3 + x * 3] = 200 - Math.round((x / (size - 1)) * 120)
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

const COVER_PNG = coverPng()
const COVER_EDGE = 96

/**
 * Refuses to run while another instance owns the debug port.
 *
 * A previous run can leave the app alive, and your own Aurora window counts too. When that happens this
 * suite attaches to *that* window, so the failures it reports (evaluate timeouts, DOM that "is not
 * there") describe a foreign instance rather than the build under test — which is exactly how this file
 * once produced two contradictory failures in a row. Failing fast with the real reason is better than
 * printing a result nobody can trust.
 */
async function assertDebugPortFree() {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/json/version`)
    if (!response.ok) return
  } catch {
    return // Nothing listening: the normal case.
  }
  console.error(
    `FAIL  调试端口 ${PORT} 已被另一个 Aurora 实例占用（上次运行的残留，或你自己开着的窗口）。\n` +
      '      请先关闭它再重跑，否则本次结果会指向那个实例而不是待测产物。',
  )
  process.exit(2)
}

await assertDebugPortFree()

// The packaged app must not touch the developer's real profile (installing a test source into it
// would pollute their app), so it runs against a throwaway `<user-data-dir>`.
const profileDir = await mkdtemp(join(tmpdir(), 'aurora-smoke-profile-'))
let child = null
/*
 * Set when the narrative throws.
 *
 * It is reported at the end on purpose: an exception in the middle of the suite skips every check after it,
 * and the summary then reads "213/217" — which looks like four small failures while it actually means "the
 * last third of the suite never ran". That misreading cost this project real debugging time, so the run now
 * says so out loud.
 */
let aborted = false
let abortWhere = ''

/** Starts the packaged app against the throwaway profile. Called twice: the restart phase reuses it. */
function launchApp() {
  /*
   * `--mute-audio` is deliberate: the suite plays real audio through the player, and it has to be silent for
   * whoever is at the machine. Chromium's flag mutes the *output stream*, not the audio graph, so the
   * analyser keeps receiving samples — which is exactly what the spectrum, energy and rotating-disc checks
   * measure. Muting at the element (`audio.muted`) would not do: a media element routed through WebAudio has
   * its own volume bypassed, so the graph would still reach the speakers.
   */
  child = spawn(exe, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profileDir}`, '--mute-audio'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  })
  child.stdout.on('data', (chunk) => process.stdout.write(`[main:out] ${String(chunk).trim()}\n`))
  child.stderr.on('data', (chunk) => process.stdout.write(`[main:err] ${String(chunk).trim()}\n`))
}
launchApp()

/** A real HTTP source for the script under test: search + a few seconds of real audio. */
function startSourceServer() {
  /*
   * ~3 seconds of **audible** audio: 90 Hz (inside the analyser's bass window at this rate), a quieter
   * 440 Hz partial, and a slow tremolo so the level visibly moves.
   *
   * This used to be digital silence (`Buffer.alloc(samples, 128)`). Silence quietly weakened two checks:
   * the spectrum canvas "proved" it was drawing by painting the flat baseline of a silent signal, and
   * `--music-energy` — the one input every "the theme moves with the music" rule multiplies by — was
   * measured against a track with no music in it, so a constant zero read as correct behaviour.
   */
  const rate = 44100
  const total = rate * 3
  const data = Buffer.alloc(total * 2)
  for (let index = 0; index < total; index += 1) {
    const time = index / rate
    const tremolo = 0.72 + 0.28 * Math.sin(2 * Math.PI * 1.5 * time)
    const sample = (Math.sin(2 * Math.PI * 90 * time) * 0.5 + Math.sin(2 * Math.PI * 440 * time) * 0.18) * tremolo
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample)) * 32767), index * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28) // byte rate
  header.writeUInt16LE(2, 32) // block align
  header.writeUInt16LE(16, 34) // bits per sample
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  const wav = Buffer.concat([header, data])

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const json = (body) => {
      const text = JSON.stringify(body)
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) })
      response.end(text)
    }
    if (url.pathname === '/search') {
      return json({
        code: 0,
        /*
         * Normal searches return the one playable row. The `hostile` keyword (used by a single check
         * near the end of the suite) returns a row whose cover is `javascript:alert(1)`: a source is
         * free to return any string there, and it must never reach an `src`, a `style` or an `href`.
         *
         * Keeping it behind a keyword rather than adding it to every response matters: the suite's
         * playback assertions act on the first search result, so a permanent second row silently
         * changes which track gets played.
         */
        data: {
          /*
           * The playable row declares the same four quality tokens the real platforms declare, which is what
           * lets the quality assertions below exercise the *product* vocabulary rather than a made-up one.
           */
          list: (url.searchParams.get('kw') ?? '').includes('hostile')
            ? [{ songmid: 'packaged-hostile', songname: '恶意封面测试', singer: 'E2E 歌手', albumname: 'E2E 专辑', interval: 3, img: 'javascript:alert(1)' }]
            : [
                {
                  songmid: 'packaged-1',
                  songname: '打包内测试歌曲',
                  singer: 'E2E 歌手',
                  albumname: 'E2E 专辑',
                  interval: 3,
                  img: `http://${request.headers.host}/cover.png`,
                  qualitys: ['128k', '320k', 'flac', 'flac24bit'],
                },
              ],
        },
      })
    }
    if (url.pathname === '/audio.wav') {
      /*
       * Recorded, not asserted here: the token the renderer asked for arrived as a query parameter, which is the
       * only place it can be observed from outside the app. The checks read `requestedQualities` afterwards.
       */
      requestedQualities.push({ token: url.searchParams.get('q') ?? '', at: Date.now() })
      seenRequests.push({ path: url.pathname + url.search, range: request.headers.range ?? '', at: Date.now() })
      /*
       * `no-store` on purpose, and it is what makes this record trustworthy.
       *
       * Without it the media element re-plays a URL it already fetched straight out of Chromium's media cache,
       * with no request reaching this server — so "nothing was asked for" would be reported for a resolve that
       * correctly chose the same tier a second time. A resolved stream URL is short-lived in practice anyway,
       * so a cacheable one is the unrealistic case.
       */
      const headers = { 'Cache-Control': 'no-store' }
      const range = request.headers.range
      if (range) {
        const match = /bytes=(\d+)-(\d*)/.exec(range)
        const start = match ? Number(match[1]) : 0
        const end = Math.min(match && match[2] ? Number(match[2]) : wav.length - 1, wav.length - 1)
        const slice = wav.subarray(start, end + 1)
        response.writeHead(206, {
          ...headers,
          'Content-Type': 'audio/wav',
          'Content-Range': `bytes ${start}-${end}/${wav.length}`,
          'Content-Length': slice.length,
        })
        return response.end(slice)
      }
      response.writeHead(200, { ...headers, 'Content-Type': 'audio/wav', 'Content-Length': wav.length })
      return response.end(wav)
    }
    if (url.pathname === '/lyric') return json({ code: 0, data: { lyric: '[00:00.50]打包内歌词行' } })
    if (url.pathname === '/cover.png') {
      response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': COVER_PNG.length })
      return response.end(COVER_PNG)
    }
    response.writeHead(404, { 'Content-Type': 'text/plain' })
    response.end('not found')
  })

  /** Every `?q=` the media endpoint was asked for, newest last — the outside view of the quality decision. */
  const requestedQualities = []
  /**
   * Every request this fixture saw, path and all.
   *
   * The quality checks only look at `requestedQualities`; this is here for the case where *nothing* reached the
   * media endpoint and the interesting question becomes whether the app asked for something else entirely (a
   * cached local file, a different URL shape) rather than which tier it chose.
   */
  const seenRequests = []

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ server, origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, requestedQualities, seenRequests })
    })
  })
}

/**
 * Picks Aurora's *app* window out of the page targets.
 *
 * There are now three kinds of page target: the app window, the separate desktop-lyrics window, and
 * one hidden sandbox host per running script source (`data:` URLs). Attaching to the wrong one would
 * make every dependent check meaningless, so this is explicit rather than "the first page".
 */
const isAppWindow = (url) =>
  url.includes('index.html') || (url.startsWith('http://localhost') && !url.includes('desktop-lyrics'))

/**
 * Finds a page target. `match` selects among several windows — see `isAppWindow` for why the choice
 * must never be left to whichever target happens to be listed first.
 */
async function findTarget(match = isAppWindow, attempts = 40) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const targets = await res.json()
      const page = targets.find(
        (target) =>
          target.type === 'page' && target.webSocketDebuggerUrl && match(String(target.url ?? '')),
      )
      if (page) return page
    } catch {
      // App still starting up.
    }
    await delay(500)
  }
  return null
}

// `id` is just the CDP request id; `timeoutMs` is generous because the packaged app can be busy
// starting renderers for script-source sandboxes while a check runs.
/**
 * Puts the fixture track back to *the beginning, playing* — the way a user would drag the progress bar.
 *
 * The packaged suite's track is three seconds long and a lot of work happens between starting it and
 * the checks that need real playback (the spectrum, the vinyl arm, the desktop strip). Being at the
 * very end is just as useless as being paused: a finished track makes the desktop strip show the song
 * name instead of a lyric line, and a check that reads that reports the sampling moment rather than
 * the feature. So this seeks to zero (through the real range input) and then starts playback.
 */
/**
 * Puts the fixture track back at 0:00 and genuinely playing, and *proves* it by watching the clock.
 *
 * Two things make this harder than clicking play:
 *
 *  - the button's title is the store's state, and the store can believe "playing" over an element
 *    that already ended (the 3-second fixture runs out during a long suite), in which case the click
 *    is skipped and nothing ever resumes — the clock then reads 0:00 forever and every check that
 *    depends on playback silently measures a stopped player;
 *  - a seek to 0 on a paused element leaves it paused, so "was it playing?" has to be re-read *after*
 *    the seek rather than before it.
 *
 * So the seek and the clicks are tried in a loop until the clock actually moves, and the result is
 * returned so callers can put the real outcome in their failure detail instead of guessing.
 */
async function ensurePlaying(ws, id) {
  let seeked = false
  let wasPlaying = false
  let clicked = 0

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const state = await evaluate(
      ws,
      `(() => {
         const range = document.querySelector('.progress-range')
         const button = document.querySelector('.player-bar .play-button')
         const wasPlaying = String(button?.title ?? '').includes('暂停')
         // Seeking to the start is what makes a short fixture usable again; the store seeks on input.
         if (range) {
           range.value = '0'
           range.dispatchEvent(new Event('input', { bubbles: true }))
         }
         return JSON.stringify({ wasPlaying, seeked: Boolean(range) })
       })()`,
      id + attempt * 4,
    )
    const parsed = JSON.parse(state?.value ?? '{}')
    seeked = seeked || parsed.seeked
    wasPlaying = wasPlaying || parsed.wasPlaying

    const first = await sampleClock(ws, id + attempt * 4 + 1)
    await delay(450)
    const second = await sampleClock(ws, id + attempt * 4 + 2)
    /*
     * A *meaningful* advance, not merely a different number: the seek writes the range directly and
     * the store then re-renders it, so two samples can differ by a rounding artefact while the audio
     * is genuinely stopped. 50 ms over a 450 ms window is unmistakably playback.
     */
    if (second.at > first.at + 0.05) {
      return { wasPlaying, seeked, clicked, title: '暂停', first: first.text, second: second.text }
    }

    // Not advancing: an ended element leaves the button reading "暂停", so press it and look again.
    await evaluate(ws, "document.querySelector('.player-bar .play-button')?.click(); 'ok'", id + attempt * 4 + 3)
    clicked += 1
    await delay(500)
  }

  const first = await sampleClock(ws, id + 40)
  await delay(450)
  const second = await sampleClock(ws, id + 41)
  const title = await evaluate(ws, "document.querySelector('.player-bar .play-button')?.title ?? ''", id + 42)
  return { wasPlaying, seeked, clicked, title: title?.value, first: first.text, second: second.text }
}

/**
 * How far into the track the player is, used as the "is audio really moving" probe.
 *
 * The visible readout is whole seconds, which is too coarse to tell "playing" from "stopped at
 * 0:00": a 450 ms sample of a 3-second fixture reads `0:00` either way. The seek range's value is
 * the same state at full resolution, so that is the number compared, and the text is kept alongside
 * it because a human reading a failure needs the clock they can see on screen.
 */
async function sampleClock(ws, id) {
  const value = await evaluate(
    ws,
    `(() => {
       const range = document.querySelector('.progress-range')
       const text = document.querySelector('.player-bar .progress-line span')?.textContent ?? ''
       return JSON.stringify({ at: Number(range?.value ?? 0), text })
     })()`,
    id,
  )
  try {
    return JSON.parse(value?.value ?? '{}')
  } catch {
    return { at: 0, text: '' }
  }
}

function evaluate(ws, expression, id, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    /*
     * A socket that is not OPEN is refused here, loudly.
     *
     * `WebSocket.send()` on a CLOSED socket does not throw — it discards the message. The evaluate then never
     * settles and surfaces 30 seconds later as `timeout: <expression>`, which reads exactly like the app
     * hanging. It was not: nine checks added after the restart phase still used the connection the suite had
     * closed at the restart, so the sound section waited out its timeout every single run. Naming the real
     * cause here is what keeps the next occurrence from costing an afternoon.
     */
    if (ws.readyState !== 1) {
      reject(
        new Error(
          `socket 不是 OPEN（readyState=${ws.readyState}）—— 这条用的是重启前的那条连接？表达式：${expression.slice(0, 80)}`,
        ),
      )
      return
    }
    const timer = setTimeout(() => reject(new Error(`timeout: ${expression}`)), timeoutMs)
    const onMessage = (event) => {
      const payload = JSON.parse(event.data)
      if (payload.id !== id) return
      clearTimeout(timer)
      ws.removeEventListener('message', onMessage)
      // A CDP-level error would otherwise resolve as `undefined` and read as a mysterious empty
      // detail on every dependent check.
      if (payload.error) {
        reject(new Error(`CDP ${payload.error.message ?? 'error'}: ${expression.slice(0, 120)}`))
        return
      }
      resolve(payload.result?.result)
    }
    ws.addEventListener('message', onMessage)
    ws.send(JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true },
    }))
  })
}

/**
 * A *real* mouse click at viewport coordinates, through the browser's own hit testing.
 *
 * This exists because `element.click()` is not a click: it dispatches a lone `click` event and skips
 * `pointerdown`/`mousedown` entirely. Any handler that runs on press — the "close this popover when the
 * press is outside it" pattern, which listens in the *capture* phase — is therefore invisible to it. That
 * gap let a real bug ship: the quality picker closed on the way down, so every row click was swallowed,
 * while every programmatic-click check stayed green. Use this whenever a control can be dismissed by a
 * press, or the test will agree with the code instead of with the user.
 */
function mouseEvent(ws, type, x, y, id) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${type}`)), 15000)
    const onMessage = (event) => {
      const payload = JSON.parse(event.data)
      if (payload.id !== id) return
      clearTimeout(timer)
      ws.removeEventListener('message', onMessage)
      resolve(payload.result)
    }
    ws.addEventListener('message', onMessage)
    ws.send(
      JSON.stringify({
        id,
        method: 'Input.dispatchMouseEvent',
        params: { type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 },
      }),
    )
  })
}

/**
 * Brings the app window to the front.
 *
 * The frame governor draws at 12 fps while the window is not the foreground window — a deliberate
 * power policy, not a bug — so every check that measures *how fast* the app draws has to own that
 * precondition instead of hoping the OS gave focus to a window nobody clicked. It failed exactly once
 * that way here (all three readings pinned at 13.2 fps, i.e. the background gate), which reads as a
 * broken frame-rate cap when the cap was fine.
 */
function bringToFront(ws, id) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout: Page.bringToFront')), 10000)
    const onMessage = (event) => {
      let payload
      try {
        payload = JSON.parse(event.data)
      } catch {
        return
      }
      if (payload.id !== id) return
      clearTimeout(timer)
      ws.removeEventListener('message', onMessage)
      resolve(payload.result)
    }
    ws.addEventListener('message', onMessage)
    ws.send(JSON.stringify({ id, method: 'Page.bringToFront', params: {} }))
  })
}

/**
 * Waits until `selector` exists in the page.
 *
 * A fixed delay is not enough for a hash route: its component is a dynamic `import()`, so on a cold
 * start the chunk may still be loading 900 ms after the hash changed — and a check would then fail
 * for a reason that has nothing to do with the app ("the textarea is missing" when the page has not
 * rendered yet). Ids start at 3000 so they cannot collide with the ones used by the checks.
 */
async function waitFor(ws, selector, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  for (let attempt = 0; Date.now() < deadline; attempt += 1) {
    const found = await evaluate(ws, `!!document.querySelector(${JSON.stringify(selector)})`, 3000 + attempt, 5000).catch(
      () => null,
    )
    if (found?.value === true) return true
    await delay(250)
  }
  return false
}

const checks = []
/**
 * `detail` is printed verbatim, so anything non-primitive is rendered here.
 *
 * It used to print `[object Object]` — which is precisely the case that matters most, since the
 * interesting checks report a whole state snapshot. A failing playback assertion that says
 * `[object Object]` tells you nothing about what the page actually showed.
 */
const check = (name, ok, detail) =>
  checks.push({
    name,
    ok,
    detail: typeof detail === 'object' && detail !== null ? JSON.stringify(detail) : detail,
  })

/** Everything the page logged or threw, so a silent failure stops being silent. */
const pageLog = []
function watchPage(ws) {
  ws.addEventListener('message', (event) => {
    let payload
    try {
      payload = JSON.parse(event.data)
    } catch {
      return
    }
    if (payload.method === 'Runtime.consoleAPICalled') {
      const text = (payload.params.args ?? []).map((arg) => arg.value ?? arg.description ?? '').join(' ')
      pageLog.push(`${payload.params.type}: ${String(text).slice(0, 300)}`)
    }
    if (payload.method === 'Runtime.exceptionThrown') {
      const details = payload.params.exceptionDetails ?? {}
      pageLog.push(`exception: ${String(details.exception?.description ?? details.text).slice(0, 300)}`)
    }
  })
  ws.send(JSON.stringify({ id: 900, method: 'Runtime.enable', params: {} }))
}

/**
 * Quits the app the way a user does — by closing its window — and waits for the process to go.
 * A hard `kill()` would lose the renderer's pending localStorage commits and make the restart
 * checks flaky for reasons that have nothing to do with persistence.
 */
async function closeApp(ws) {
  await evaluate(ws, "window.close(); 'closing'", 700, 8000).catch(() => undefined)
  const exited = await new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve(true)
    const timer = setTimeout(() => resolve(false), 12000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
  return exited
}

/** Attaches to a renderer (waiting for its bridge to come up) and starts watching its console. */
async function connect(match = isAppWindow, probe = 'typeof window.aurora') {
  const target = await findTarget(match)
  if (!target) return null
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', () => reject(new Error('websocket error')), { once: true })
  })
  watchPage(ws)
  // The page target exists before the preload bridge does; evaluating too early would fail for a
  // reason that has nothing to do with what is being tested.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const ready = await evaluate(ws, probe, 800 + attempt, 5000)
      if (ready?.value === 'object') break
    } catch {
      // Still starting up.
    }
    await delay(500)
  }
  return { ws, target }
}

try {
  const first = await connect(isAppWindow)
  check('打包应用启动并暴露渲染进程', Boolean(first), first?.target?.url ?? 'no target')
  if (!first) throw new Error('no devtools target')
  let ws = first.ws

  const bridge = await evaluate(ws, 'typeof window.aurora', 1)
  check('preload 桥接存在 (window.aurora)', bridge?.value === 'object', bridge?.value)

  const library = await evaluate(ws, 'window.aurora.library.list().then((t) => Array.isArray(t))', 2)
  check('IPC 往返成功 (library.list)', library?.value === true, JSON.stringify(library?.value ?? library))

  const info = await evaluate(ws, 'window.aurora.app.info()', 3)
  check('主进程返回版本信息', Boolean(info?.value?.version), JSON.stringify(info?.value))

  // The preload bridge exists before Vue mounts, so this waits for the shell instead of sampling once
  // (a cold start after a fresh build can take longer than the bridge does).
  const shellReady = await waitFor(ws, '.app-shell')
  const mounted = await evaluate(ws, "!!document.querySelector('.app-shell') && !!document.querySelector('.player-bar')", 4)
  check('Vue 应用已挂载（外壳与播放栏存在）', shellReady && mounted?.value === true, mounted?.value)

  // 侧边栏不带品牌字标。它曾经是一个紫色圆角块 + 三条白柱 + 粗体 "Aurora"，与窗口标题重复又
  // 占掉整列顶部。按“删除”断言而不是“隐藏”，是为了让重新加回来这种回归直接失败。
  const sidebarBrand = await evaluate(
    ws,
    `(() => JSON.stringify({
       brandNodes: document.querySelectorAll('.sidebar .brand, .brand-mark').length,
       // 侧边栏文本里不该出现 “Aurora” 这个词；页面其它位置（如关于/设置）不受此限制。
       wordmark: /Aurora/i.test(document.querySelector('.sidebar')?.textContent ?? ''),
       firstNode: document.querySelector('.sidebar')?.firstElementChild?.className ?? '',
     }))()`,
    5,
  )
  let sidebar = {}
  try {
    sidebar = JSON.parse(sidebarBrand?.value ?? '{}')
  } catch {
    sidebar = {}
  }
  check(
    '侧边栏左上角不再有图标与 Aurora 字标',
    sidebar.brandNodes === 0 && sidebar.wordmark === false && sidebar.firstNode === 'nav-group',
    JSON.stringify(sidebar),
  )

  const views = await evaluate(ws, "location.hash = '#/library'; 'ok'", 5)
  await waitFor(ws, '.welcome-row h1')
  // `/library` is now an alias of the local page, so what is asserted is that the *local* page
  // rendered — its heading, its four library tabs and its two smart playlists.
  const localPage = await evaluate(
    ws,
    `(() => JSON.stringify({
       redirected: location.hash === '#/' || location.hash === '#/library',
       heading: document.querySelector('.welcome-row h1')?.textContent?.trim() ?? '',
       tabs: [...document.querySelectorAll('.library-tabs .chip')].map((chip) => chip.textContent.trim()),
       stats: document.querySelectorAll('.stat-grid .stat-card').length,
       smart: document.querySelectorAll('.smart-card').length,
       // 顶栏的曲库动作在本地页会与欢迎区重复，所以这里看的是“它还在不在”，而其余页面看的是
       // “它有没有回来”（见下方 nonLocalActions）——只断言隐藏会漏掉“全站都消失了”这种回归。
       topActions: [...document.querySelectorAll('.top-actions button')].map((button) => button.textContent.trim()),
       welcomeActions: [...document.querySelectorAll('.welcome-actions button')].map((button) => button.textContent.replace(/\\s+/g, ' ').trim()),
     }))()`,
    6,
  )
  const local = (() => {
    try {
      return JSON.parse(localPage?.value ?? '{}')
    } catch {
      return {}
    }
  })()
  check('本地音乐页渲染（原 #/library 已并入首页）', local.heading.includes('本地音乐'), `${views?.value} / ${local.heading}`)
  const homeLibraryActions = ['添加文件', '添加文件夹', '随机播放全部']
  check(
    '本地音乐页：顶栏不再重复同一组曲库动作（欢迎区已提供）',
    !(local.topActions ?? []).some((text) => homeLibraryActions.includes(text)) &&
      homeLibraryActions.every((text) => (local.welcomeActions ?? []).some((label) => label.includes(text))),
    JSON.stringify({ top: local.topActions, welcome: local.welcomeActions }),
  )
  // 同一组按钮在别的页面上必须回来：本地页藏起它们，理由是本页已有更好的入口，而不是把它们删掉。
  await evaluate(ws, "location.hash = '#/playlists'; 'ok'", 90)
  /*
   * Wait for the *playlists* page, not for the top bar.
   *
   * `.topbar` is part of the shell, so it is already on screen when the hash changes — waiting for it
   * made this read a top bar that belonged to the page being left, which is how "the actions came back"
   * failed while nothing had actually changed.
   */
  await evaluate(
    ws,
    `(async () => {
       for (let attempt = 0; attempt < 40; attempt += 1) {
         if ((document.querySelector('.view-actions')?.textContent ?? '').includes('导出 JSON')) return 'ready'
         await new Promise((resolve) => setTimeout(resolve, 100))
       }
       return 'timeout'
     })()`,
    90,
  )
  const elsewhere = await evaluate(
    ws,
    "JSON.stringify([...document.querySelectorAll('.top-actions button')].map((button) => button.textContent.trim()))",
    91,
  )
  const elsewhereActions = (() => {
    try {
      return JSON.parse(elsewhere?.value ?? '[]')
    } catch {
      return []
    }
  })()
  check(
    '其它页面的顶栏仍保留曲库动作（入口没有被一并删掉）',
    homeLibraryActions.every((text) => elsewhereActions.includes(text)),
    JSON.stringify(elsewhereActions),
  )
  /*
   * 浅色/深色两套主题必须都完整，而不是“深色做得很好、浅色只剩个白底”。
   *
   * 这里驱动的是真实入口（顶栏 ◐ → 浅色主题），然后查四件事：页面主题标记、原生窗口外观、
   * 卡片与背景是否真的分层、以及播放栏那一排控件没有被挤到换行（“队列 20”曾经被压成一个圆，
   * 里面 队 / 列 / 20 竖着排三行）。
   *
   * `prefers-color-scheme` 是关键一条：它由主进程的 `nativeTheme.themeSource` 驱动，CSS 改不到
   * 它，所以它是“主进程真的收到并应用了主题”的唯一可信证据。
   */
  const themeProbe = async () => {
    const raw = await evaluate(
      ws,
      `(() => {
         const shell = document.querySelector('.app-shell')
         // A surface that exists on every page: the sidebar paints --panel next to the page's --bg,
         // so it proves the two still separate without depending on which page the probe runs on.
         const card = document.querySelector('.sidebar, .stat-card, .card, .track-row')
         const queue = document.querySelector('.queue-button')
         const rgb = (node) => (node ? getComputedStyle(node).backgroundColor : '')
         return JSON.stringify({
           dataset: document.documentElement.dataset.theme ?? '',
           prefersDark: window.matchMedia('(prefers-color-scheme: dark)').matches,
           bodyBg: rgb(document.body),
           cardBg: rgb(card),
           textColor: card ? getComputedStyle(card).color : '',
           shell: Boolean(shell),
           queueBox: queue ? { w: Math.round(queue.offsetWidth), h: Math.round(queue.offsetHeight) } : null,
           queueText: queue ? queue.textContent.trim() : '',
         })
       })()`,
      93,
    )
    try {
      return JSON.parse(raw?.value ?? '{}')
    } catch {
      return {}
    }
  }

  const themeSetting = await evaluate(
    ws,
    `(async () => {
       document.querySelector('.theme-control .icon-button')?.click()
       await new Promise((resolve) => setTimeout(resolve, 250))
       const button = [...document.querySelectorAll('.theme-menu button')].find((b) => b.textContent.includes('浅色主题'))
       button?.click()
       await new Promise((resolve) => setTimeout(resolve, 600))
       const stored = await window.aurora.settings.get()
       return JSON.stringify({ clicked: Boolean(button), stored: stored.theme })
     })()`,
    94,
  )
  const lightClick = (() => {
    try {
      return JSON.parse(themeSetting?.value ?? '{}')
    } catch {
      return {}
    }
  })()
  const light = await themeProbe()
  check(
    '浅色主题：走真实菜单入口切换，页面与原生窗口外观一起跟上',
    lightClick.clicked === true &&
      lightClick.stored === 'light' &&
      light.dataset === 'light' &&
      light.prefersDark === false &&
      light.shell === true,
    JSON.stringify({ ...lightClick, ...light, prefersDark: light.prefersDark }),
  )
  // 分层：卡片底色必须与页面底色不同，否则浅色下所有东西糊成一块白。
  const parsedRgb = (value) => (String(value).match(/\d+/g) ?? []).slice(0, 3).map(Number)
  const [bodyR, bodyG, bodyB] = parsedRgb(light.bodyBg)
  const [cardR, cardG, cardB] = parsedRgb(light.cardBg)
  const separates = [bodyR, bodyG, bodyB].some((channel, index) => Math.abs(channel - [cardR, cardG, cardB][index]) >= 6)
  check(
    '浅色主题：卡片与页面底色分层（不是白底白卡）',
    separates && String(light.textColor) !== String(light.cardBg),
    JSON.stringify({ body: light.bodyBg, card: light.cardBg, text: light.textColor }),
  )
  // 播放栏不该被挤到换行：单行高度、宽度大于高度（圆形就是被压坏了）。
  check(
    '播放栏控件不被挤压换行（“队列 N”保持单行胶囊）',
    Boolean(light.queueBox) && light.queueBox.h <= 32 && light.queueBox.w > light.queueBox.h,
    JSON.stringify({ box: light.queueBox, text: light.queueText }),
  )

  /*
   * 切回深色：后面的断言都在深色下写就，产物也必须以深色启动。
   *
   * 走同一个真实菜单入口、而不是 `location.reload()`：重载是异步的，evaluate 一返回就继续跑，
   * 紧接着的 `waitFor('.topbar')` 会在**旧文档**上立即命中，于是量到的还是切换前的状态——这正是
   * 本块第一版把自己测成红色的原因。
   */
  await evaluate(
    ws,
    `(async () => {
       document.querySelector('.theme-control .icon-button')?.click()
       await new Promise((resolve) => setTimeout(resolve, 250))
       const button = [...document.querySelectorAll('.theme-menu button')].find((b) => b.textContent.includes('深色主题'))
       button?.click()
       await new Promise((resolve) => setTimeout(resolve, 600))
       return JSON.stringify({ clicked: Boolean(button), stored: (await window.aurora.settings.get()).theme })
     })()`,
    95,
  )
  await delay(500)
  const backToDark = await themeProbe()
  check(
    '切回深色后原生外观与页面一起回来（主进程没有停在浅色）',
    backToDark.dataset === 'dark' && backToDark.prefersDark === true,
    JSON.stringify(backToDark),
  )

  /*
   * 主题中心。
   *
   * `AURORA_SKIP_THEME=1` skips this whole phase. It exists for one reason: when a *later* phase fails,
   * the first question is whether this block's extra UI interaction and ~10s of waiting caused it —
   * a question this flag answers by rerunning without it instead of by argument.
   *
   * 这一块查的是"主题系统是否真的在运行"，而不是"设置页有没有那几个字"：
   *
   *  - 切皮肤后 `data-skin` 变、**计算出来的颜色也变**（只查属性名会把一套没生效的主题放过去）；
   *  - 选择写回了主进程 settings（重启能恢复的唯一可信证据）；
   *  - 浅色主题下原生标题栏也跟着变淡（以前它写死深色，就是"浅色看起来很割裂"的根源）；
   *  - 氛围粒子层真的在画（读画布像素），关掉后真的停止绘制；
   *  - 播放栏是毛玻璃（backdrop-filter 生效且底色半透）。
   */
  if (process.env.AURORA_SKIP_THEME !== '1') {
  await evaluate(ws, "location.hash = '#/settings'; 'ok'", 92)
  await waitFor(ws, '.skin-grid')
  const skinCenter = await evaluate(
    ws,
    `(() => {
       const cards = [...document.querySelectorAll('.skin-card')]
       return JSON.stringify({
         count: cards.length,
         ids: cards.map((card) => card.dataset.skinId),
         names: cards.map((card) => card.querySelector('.skin-title strong')?.textContent?.trim() ?? ''),
         swatches: cards.map((card) => card.querySelectorAll('.skin-swatch i').length),
         active: document.querySelector('.skin-card.active')?.dataset.skinId ?? '',
         moreTheme: Boolean(document.querySelector('.theme-more')),
       })
     })()`,
    96,
  )
  const center = (() => {
    try {
      return JSON.parse(skinCenter?.value ?? '{}')
    } catch {
      return {}
    }
  })()
  const expectedSkins = ['aurora', 'star-dream', 'autumn-leaf', 'ocean-morning', 'jiangnan-rain', 'sunset-song']
  // `>=` rather than `===`: the themes folder ships a working example, and it is a *real* user theme, so
  // it belongs in the list. The assertion is that every built-in is there and none of them is empty.
  check(
    '主题中心列出全部六套内置主题，每张卡都有自己的色板，并标出当前主题',
    center.count >= expectedSkins.length &&
      expectedSkins.every((id) => (center.ids ?? []).includes(id)) &&
      (center.swatches ?? []).every((count) => count >= 1) &&
      center.active !== '',
    JSON.stringify({ count: center.count, names: center.names, active: center.active, swatches: center.swatches }),
  )
  check('主题中心提供「更多主题」入口（不是摆设：下面会真的导入一个）', center.moreTheme === true, String(center.moreTheme))

  /*
   * 切到星河入梦。断言分三层：皮肤标记、**计算色**、以及主进程 storaged 的值。
   *
   * 计算色是关健：`data-skin` 只是一个属性，即使样式表没加载也会变。这里读的是真实绘制出来的
   * 页面底色与强调色，并和该皮肤自己声明的 token 对比。
   */
  const skinSwitch = await evaluate(
    ws,
    `(async () => {
       const card = [...document.querySelectorAll('.skin-card')].find((node) => node.dataset.skinId === 'star-dream')
       card?.click()
       await new Promise((resolve) => setTimeout(resolve, 700))
       const root = document.documentElement
       const styles = getComputedStyle(root)
       const stored = await window.aurora.settings.get()
       return JSON.stringify({
         clicked: Boolean(card),
         dataset: root.dataset.skin ?? '',
         mode: root.dataset.theme ?? '',
         bg: styles.getPropertyValue('--bg').trim(),
         accent: styles.getPropertyValue('--accent').trim(),
         bodyBg: getComputedStyle(document.body).backgroundColor,
         strip: styles.getPropertyValue('--titlebar-bg').trim(),
         storedSkin: stored.skin,
         storedTheme: stored.theme,
         generatedBlocks: document.getElementById('aurora-skins')?.textContent?.includes('data-skin="star-dream"') ?? false,
       })
     })()`,
    97,
  )
  const switched = (() => {
    try {
      return JSON.parse(skinSwitch?.value ?? '{}')
    } catch {
      return {}
    }
  })()
  check(
    '切换到「星河入梦」：皮肤生效、生成的样式表里真有它的规则',
    switched.clicked === true &&
      switched.dataset === 'star-dream' &&
      switched.generatedBlocks === true &&
      String(switched.bg).toLowerCase() === '#070a16' &&
      String(switched.accent).toLowerCase() === '#8ea2ff',
    JSON.stringify({ dataset: switched.dataset, bg: switched.bg, accent: switched.accent, generated: switched.generatedBlocks }),
  )
  check(
    '切换皮肤后再一次向主进程持久化（重启后能恢复）',
    switched.storedSkin === 'star-dream',
    JSON.stringify({ skin: switched.storedSkin, theme: switched.storedTheme }),
  )
  // The strip colour is the one thing CSS cannot paint by itself, and it is what used to leave a black
  // band on a light window.
  check(
    '原生标题栏颜色跟随皮肤（不再永远是那条深色）',
    String(switched.strip).toLowerCase() === '#070a16',
    String(switched.strip),
  )

  /*
   * 浅色主题下的纯净度：标题栏与主要表面都得是亮的。
   *
   * 这条是用户反复提到的"浅色很割裂"的可量化版本：量真实亮度，而不是看一眼截图。
   */
  const lightPurity = await evaluate(
    ws,
    `(async () => {
       // Scoped to 主题中心 on purpose: the desktop-lyrics section also has 开启/关闭 style buttons, and a
       // loose selector would quietly drive the wrong control while still "passing".
       const modeButton = () => [...document.querySelectorAll('.theme-center .segmented button')].find((b) => b.textContent.includes('浅色'))
       modeButton()?.click()
       await new Promise((resolve) => setTimeout(resolve, 700))
       const root = document.documentElement
       const styles = getComputedStyle(root)
       // Handles both the hex a custom property holds and the rgb()/rgba() a computed style returns —
       // parsing hex digits as if they were channel numbers is how a "black title bar" gets reported
       // for a colour that is actually near-white.
       const lum = (value) => {
         const text = String(value).trim()
         let r = 0
         let g = 0
         let b = 0
         const hex = text.match(/^#([0-9a-f]{6})$/i)
         if (hex) {
           const int = parseInt(hex[1], 16)
           r = (int >> 16) & 255
           g = (int >> 8) & 255
           b = int & 255
         } else {
           /*
            * color-mix() comes back as "color(srgb 1 1 1 / 0.72)" — channels in 0…1, not 0…255.
            * Treating them as bytes reports a white sidebar as pure black, which is exactly the
            * mistake this probe first made.
            */
           const nums = (text.match(/[0-9.]+/g) ?? []).slice(0, 3).map(Number)
           const scale = text.startsWith('color(') ? 255 : 1
           ;[r, g, b] = [(nums[0] ?? 0) * scale, (nums[1] ?? 0) * scale, (nums[2] ?? 0) * scale]
         }
         return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
       }
       const sidebar = document.querySelector('.sidebar')
       const bar = document.querySelector('.player-bar')
       return JSON.stringify({
         mode: root.dataset.theme ?? '',
         strip: styles.getPropertyValue('--titlebar-bg').trim(),
         stripLum: lum(styles.getPropertyValue('--titlebar-bg')),
         bodyLum: lum(getComputedStyle(document.body).backgroundColor),
         sidebarLum: sidebar ? lum(getComputedStyle(sidebar).backgroundColor) : -1,
         cardBg: styles.getPropertyValue('--card').trim(),
         playerBg: styles.getPropertyValue('--player-bg').trim(),
         playerBlur: bar ? getComputedStyle(bar).backdropFilter : '',
       })
     })()`,
    98,
  )
  const purity = (() => {
    try {
      return JSON.parse(lightPurity?.value ?? '{}')
    } catch {
      return {}
    }
  })()
  check(
    '浅色主题：原生标题栏与页面底色都变亮（顶部不再有一条黑带）',
    purity.mode === 'light' && purity.stripLum > 0.7 && purity.bodyLum > 0.7,
    JSON.stringify({ strip: purity.strip, stripLum: purity.stripLum, bodyLum: purity.bodyLum }),
  )
  check(
    '浅色主题：侧边栏也是亮的（没有黑色导航条污染浅色体验）',
    purity.sidebarLum > 0.6,
    JSON.stringify({ sidebarLum: purity.sidebarLum }),
  )
  // Translucency is read from the alpha channel, not guessed from the string's shape: the whole point of
  // glass is that the colour behind it shows through, and an opaque background would defeat the blur.
  const glassAlpha = Number((String(purity.playerBg).match(/rgba\([^)]*,\s*([0-9.]+)\s*\)/) ?? [])[1] ?? 1)
  check(
    '播放栏是真正的毛玻璃（毛玻璃滤镜生效 + 半透底色）',
    String(purity.playerBlur).includes('blur') && glassAlpha > 0 && glassAlpha < 1,
    JSON.stringify({ playerBg: purity.playerBg, playerBlur: purity.playerBlur, alpha: glassAlpha }),
  )

  /*
   * 氛围层：开 → 画布真的被绘制，关 → 真的停下来。
   *
   * 读回像素而不是看 DOM 里有没有 canvas：一个永远空白的画布和一个在动的粒子场在 DOM 上是
   * 同一个东西（这正是频谱那条断言存在的理由，这里用同样的方法）。
   */
  const ambientOn = await evaluate(
    ws,
    `(() => {
       const canvas = document.querySelector('.ambient-layer')
       let painted = 0
       if (canvas && canvas.width > 0) {
         const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
         for (let index = 3; index < data.length; index += 4) if (data[index] > 8) painted += 1
       }
       return JSON.stringify({ canvas: Boolean(canvas), bitmap: canvas ? canvas.width + 'x' + canvas.height : '', painted, glow: getComputedStyle(document.querySelector('.ambient-glow') ?? document.body).opacity })
     })()`,
    99,
  )
  const ambient = (() => {
    try {
      return JSON.parse(ambientOn?.value ?? '{}')
    } catch {
      return {}
    }
  })()
  check(
    '氛围层真的在画粒子（按皮肤自己的粒子类型与密度）',
    ambient.canvas === true && Number(ambient.painted) > 0,
    JSON.stringify({ bitmap: ambient.bitmap, painted: ambient.painted }),
  )

  const ambientOff = await evaluate(
    ws,
    `(async () => {
       // The animation-level row, by its own level names. The old on/off switch this check was written
       // against no longer exists in the product (only a migration key), so "关闭" here has to mean the
       // level that actually stops the drawing.
       const off = document.querySelector('.theme-center .segmented button[data-level="off"]')
       off?.click()
       await new Promise((resolve) => setTimeout(resolve, 900))
       const canvas = document.querySelector('.ambient-layer')
       let painted = 0
       if (canvas && canvas.width > 0) {
         const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
         for (let index = 3; index < data.length; index += 4) if (data[index] > 8) painted += 1
       }
       const glow = document.querySelector('.ambient-glow')
       return JSON.stringify({ clicked: Boolean(off), painted, glow: Boolean(glow), stored: localStorage.getItem('aurora:animation-level') ?? '', level: document.documentElement.dataset.anim ?? '' })
     })()`,
    100,
  )
  const ambientDisabled = (() => {
    try {
      return JSON.parse(ambientOff?.value ?? '{}')
    } catch {
      return {}
    }
  })()
  check(
    '把动画等级切到「关闭」后粒子真的停了（不是只改了个开关文案）',
    ambientDisabled.clicked === true &&
      Number(ambientDisabled.painted) === 0 &&
      ambientDisabled.glow === false &&
      ambientDisabled.stored === 'off' &&
      ambientDisabled.level === 'off',
    JSON.stringify(ambientDisabled),
  )

  /*
   * The dynamic-effect plan, measured on the live window.
   *
   * 星河入梦 is the skin active here, so the root has to carry *its* recipes (nebula / halo / focus) and
   * the numbers that go with them — and the immersive page has to actually be running the room animation,
   * not merely be told which one to run. Both halves matter: an attribute with no rule behind it and an
   * animation-name with no duration are the two ways this looks finished while doing nothing.
   */
  // Back to the standard budget first: the check above left the level at 关闭 on purpose.
  await evaluate(
    ws,
    `(async () => {
       document.querySelector('.segmented button[data-level="standard"]')?.click()
       await new Promise((resolve) => setTimeout(resolve, 500))
       return 'ok'
     })()`,
    103,
  )
  await evaluate(ws, "location.hash = '#/lyrics'; 'ok'", 103)
  await waitFor(ws, '.lyrics-page')
  await delay(700)
  const roomProbe = `(() => {
     const root = document.documentElement
     const inline = getComputedStyle(root)
     const fieldNode = document.querySelector('.ambient-field')
     const field = fieldNode ? getComputedStyle(fieldNode) : null
     const line = document.querySelector('.lyric-line.active')
     const grain = document.querySelector('.ambient-grain')
     const art = document.querySelector('.artwork')
     return JSON.stringify({
       skin: root.dataset.skin ?? '',
       anim: root.dataset.anim ?? '',
       bg: root.dataset.bg ?? '',
       pulse: root.dataset.pulse ?? '',
       lyric: root.dataset.lyric ?? '',
       immersive: root.dataset.immersive ?? '',
       strength: inline.getPropertyValue('--pulse-strength').trim(),
       react: inline.getPropertyValue('--pulse-react').trim(),
       drift: inline.getPropertyValue('--bg-art-drift').trim(),
       speed: inline.getPropertyValue('--fx-speed').trim(),
       playing: root.dataset.playing ?? '',
       fieldName: field ? field.animationName : '',
       fieldDuration: field ? field.animationDuration : '',
       grainName: grain ? getComputedStyle(grain).animationName : '',
       lineName: line ? getComputedStyle(line).animationName : '',
       artShadow: art ? getComputedStyle(art).boxShadow.slice(0, 40) : '',
     })
   })()`
  const roomRaw = await evaluate(ws, roomProbe, 103)
  const room = (() => {
    try {
      return JSON.parse(roomRaw?.value ?? '{}')
    } catch {
      return {}
    }
  })()
  check(
    '主题的动效配方落到根元素上（星河入梦 = 星云背景 / 光环 / 星光聚焦 / 星云空间）',
    room.skin === 'star-dream' &&
      room.anim === 'standard' &&
      room.bg === 'nebula' &&
      room.pulse === 'halo' &&
      room.lyric === 'focus' &&
      room.immersive === 'nebula',
    JSON.stringify({ skin: room.skin, anim: room.anim, bg: room.bg, pulse: room.pulse, lyric: room.lyric, immersive: room.immersive }),
  )
  check(
    '配方带着可用的数值（光环强度与音乐联动都不是 0，节奏来自皮肤自己）',
    Number(room.strength) > 0 && Number(room.react) > 0 && /^\d+s$/.test(String(room.drift)) && parseFloat(room.drift) === 120,
    JSON.stringify({ strength: room.strength, react: room.react, drift: room.drift }),
  )
  check(
    '沉浸页真的在跑这个主题的房间动画（不只是写了个属性）',
    room.fieldName === 'fx-immersive-nebula' && parseFloat(room.fieldDuration) > 10,
    JSON.stringify({ name: room.fieldName, duration: room.fieldDuration }),
  )
  check(
    '封面在沉浸页带着主题的空间光（星河是冷紫外光，不是默认空阴影）',
    String(room.artShadow).length > 10,
    room.artShadow,
  )
  check(
    '不是"落日"的皮肤不会画出胶片颗粒（颗粒是那个空间的材质，不是全局装饰）',
    room.grainName === 'none',
    JSON.stringify({ grain: room.grainName, immersive: room.immersive }),
  )

  await evaluate(ws, "location.hash = '#/settings'; 'ok'", 103)
  await waitFor(ws, '.theme-center')
  await delay(400)
  const downgraded = await evaluate(
    ws,
    `(async () => {
       const button = document.querySelector('.segmented button[data-level="saver"]')
       button?.click()
       await new Promise((resolve) => setTimeout(resolve, 600))
       const root = document.documentElement
       const inline = getComputedStyle(root)
       return JSON.stringify({
         clicked: Boolean(button),
         anim: root.dataset.anim ?? '',
         bg: root.dataset.bg ?? '',
         pulse: root.dataset.pulse ?? '',
         lyric: root.dataset.lyric ?? '',
         immersive: root.dataset.immersive ?? '',
         hasStrength: Boolean(inline.getPropertyValue('--pulse-strength').trim()),
         hasReact: Boolean(inline.getPropertyValue('--pulse-react').trim()),
         hasLyric: Boolean(inline.getPropertyValue('--lyric-duration').trim()),
         drift: inline.getPropertyValue('--bg-art-drift').trim(),
         stored: localStorage.getItem('aurora:animation-level') ?? '',
       })
     })()`,
    104,
  )
  const saver = (() => {
    try {
      return JSON.parse(downgraded?.value ?? '{}')
    } catch {
      return {}
    }
  })()
  check('动画等级可切到「节能」，档位被真实写入并持久化', saver.clicked === true && saver.anim === 'saver' && saver.stored === 'saver', JSON.stringify({ anim: saver.anim, stored: saver.stored }))
  check(
    '降档后重配方真的撤下（属性回到 plain，光环与歌词变量被移除而不是留成 0）',
    saver.bg === 'plain' &&
      saver.pulse === 'plain' &&
      saver.lyric === 'plain' &&
      saver.immersive === 'plain' &&
      saver.hasStrength === false &&
      saver.hasReact === false &&
      saver.hasLyric === false,
    JSON.stringify(saver),
  )
  check('降档只收走重配方，不丢掉主题自己的节奏', saver.drift === '168s', saver.drift)
  await evaluate(
    ws,
    `(async () => {
       document.querySelector('.segmented button[data-level="standard"]')?.click()
       await new Promise((resolve) => setTimeout(resolve, 500))
       return 'ok'
     })()`,
    105,
  )
  const restored = await evaluate(ws, "document.documentElement.dataset.bg + '/' + document.documentElement.dataset.anim", 106)
  check('改回「标准」后配方回来（降档不是单向的门）', restored?.value === 'nebula/standard', restored?.value)

  /*
   * The animation level's storage rule, in the packaged app.
   *
   * This is the regression that cost a real install every effect: the automatic fallback wrote itself
   * into the slot the user's own choice lives in, so a busy session became the preference, and nothing
   * said so. The rule now is "two slots" — proven here by writing the session slot the way the watchdog
   * does, reloading, and checking both that it applied for the session and that it was consumed.
   */
  const slotAfterManual = await evaluate(
    ws,
    "JSON.stringify({ chosen: localStorage.getItem('aurora:animation-level') ?? '', auto: localStorage.getItem('aurora:animation-level:auto') ?? '' })",
    206,
  )
  const manual = (() => {
    try {
      return JSON.parse(slotAfterManual?.value ?? '{}')
    } catch {
      return {}
    }
  })()
  check(
    '手动切换只写「选择槽」，并清掉在场残留的会话降档',
    manual.chosen === 'standard' && manual.auto === '',
    JSON.stringify(manual),
  )

  /*
   * 自动降档的“一次会话”规则，在真实应用里验证。
   *
   * 这里调用的就是启动时跑的那个函数（`ui.initTheme()`），而不是“重载页面再读”：驱动一个导航会把挂起的
   * CDP 求值丢掉，前两版写法因此要么卡住、要么读到重载之前的旧状态（表现为“键还在、档位没变”，看起来像产品
   * 没生效，其实是什么都没发生）。直接调用启动路径，测的就是真正要发生的事。
   */
  const autoConsume = await evaluate(
    ws,
    `(() => {
       localStorage.setItem('aurora:animation-level:auto', 'saver')
       const ui = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('ui')
       ui.initTheme()
       return JSON.stringify({
         anim: document.documentElement.dataset.anim ?? '',
         chosen: localStorage.getItem('aurora:animation-level') ?? '',
         auto: localStorage.getItem('aurora:animation-level:auto') ?? '',
         // Read from the store, not from a control: this runs from whichever page the suite is on, and the
         // settings row only exists on the settings page.
         storeLevel: ui.animationLevel,
       })
     })()`,
    207,
    15000,
  )
  const autoSession = (() => {
    try {
      return JSON.parse(autoConsume?.value ?? '{}')
    } catch {
      return {}
    }
  })()
  check(
    '自动降档在本次会话真的生效（启动路径把它降到了「节能」）',
    autoSession.anim === 'saver' && autoSession.storeLevel === 'saver',
    JSON.stringify({ anim: autoSession.anim, storeLevel: autoSession.storeLevel }),
  )
  check(
    '自动降档不覆盖用户的选择，也不会活到下一次启动',
    autoSession.chosen === 'standard' && autoSession.auto === '',
    JSON.stringify({ chosen: autoSession.chosen, auto: autoSession.auto }),
  )
  const autoRestart = await evaluate(
    ws,
    `(() => {
       // Nothing but the launch path again: the choice slot is what a fresh start reads, and the session
       // slot was consumed above — so this is exactly the state the next launch would find.
       const ui = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('ui')
       ui.initTheme()
       return document.documentElement.dataset.anim ?? ''
     })()`,
    208,
    15000,
  )
  check(
    '再启动一次就回到用户自己的档位（降档不跨会话累积）',
    autoRestart?.value === 'standard',
    autoRestart?.value,
  )
  // The showpiece level has to be reachable by one click, and be the level that is actually applied.
  const immersivePick = await evaluate(
    ws,
    `(async () => {
       location.hash = '#/settings'
       await new Promise((resolve) => setTimeout(resolve, 700))
       document.querySelector('.segmented button[data-level="immersive"]')?.click()
       await new Promise((resolve) => setTimeout(resolve, 600))
       const root = document.documentElement
       return JSON.stringify({
         anim: root.dataset.anim ?? '',
         stored: localStorage.getItem('aurora:animation-level') ?? '',
         particles: Number(getComputedStyle(root).getPropertyValue('--pulse-react')) || 0,
       })
     })()`,
    211,
    20000,
  )
  const immersivePickData = (() => {
    try {
      return JSON.parse(immersivePick?.value ?? '{}')
    } catch {
      return {}
    }
  })()
  check(
    '「沉浸」一档可达，且真的写进选择槽并生效',
    immersivePickData.anim === 'immersive' && immersivePickData.stored === 'immersive' && immersivePickData.particles > 1,
    JSON.stringify(immersivePickData),
  )
  // Left at 标准 for the rest of the suite: the checks after this one measure timing, and the heaviest
  // level would make their failures about the machine instead of about the code.
  await evaluate(
    ws,
    `(async () => {
       document.querySelector('.segmented button[data-level="standard"]')?.click()
       await new Promise((resolve) => setTimeout(resolve, 500))
       return 'ok'
     })()`,
    212,
  )

  /*
   * Aurora Visual Engine：帧率上限与 Aurora Lab。
   *
   * 这一组检查的是“调速器真的在调速”，而不是“设置里多了一排按钮”。两件事都只能从应用自己报出的数字上验：
   *
   *  1. Lab（Ctrl+Shift+A）开后要给出真实帧率与粒子数，关后节点要真的消失；
   *  2. 选 30 档后，Lab 报的“允许绘制”必须真的掉到 30 附近，并且在切回“跟随”后自己长回去。
   *
   * 数字来自面板自己的行（它轮询调速器），所以只要面板显示 30、而数据集里存的是 30，就说明“设置→调速器→
   * 画布门的门闸”整条链是通的——旧版那个只改文案不生效的毛病会在这一条上当场失败。
   */
  // 量“多快在画”之前先把窗口带到前台，否则量到的是省电档的 12fps。
  await bringToFront(ws, 210).catch(() => undefined)
  await delay(1000)
  const frameEngine = await evaluate(
    ws,
    `(async () => {
       const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
       const labRows = () => {
         const root = document.querySelector('[data-aurora-lab]')
         if (!root) return null
         const rows = {}
         for (const dt of root.querySelectorAll('dt')) {
           rows[dt.textContent.trim()] = (dt.nextElementSibling?.textContent ?? '').trim()
         }
         return rows
       }
       const toggleLab = async () => {
         window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', ctrlKey: true, shiftKey: true, bubbles: true }))
         await delay(700)
         return labRows()
       }
       /*
        * 读数走 <html> 上的 data-fx-* 镜像，而不是面板的 DOM。
        *
        * 面板是 Vue 渲染的，而窗口被其他窗口挡住时 Chromium 会节流定时器：面板就停在上一帧的读数上继续当成
        * “当前值”显示（实测过一次：同一份快照里预算已经是 33ms，实绘帧率却还是 141，正是冻结在加限制前的那一帧）。
        * 镜像由帧循环自己写，不经过 Vue，所以这里读到的一定是刚量到的值。
        */
       const live = () => {
         const root = document.documentElement
         return {
           fps: Number(root.dataset.fxFps) || 0,
           draw: Number(root.dataset.fxDraw) || 0,
           budget: Number(root.dataset.fxBudget) || 0,
           // 实际生效的门闸：预算抬高到暂停/离焦地板之后的那一个。暂停态能证明的就是它。
           gate: Number(root.dataset.fxGate) || 0,
           hz: Number(root.dataset.fxHz) || 0,
           grade: root.dataset.fxGrade ?? '',
         }
       }

       // 粒子只在这一档确定存在；没有粒子，绘制频率就没意义。
       document.querySelector('.segmented button[data-level="immersive"]')?.click()
       await delay(800)

       const opened = await toggleLab()
       const closed = (await toggleLab()) === null
       const rows = await toggleLab()

       const before = live().draw
       const screen = rows?.['屏幕'] ?? ''
       document.querySelector('.segmented button[data-frame-rate="30"]')?.click()
       await delay(3200)
       const capped = live()
       // 面板要跟着重绘，所以行也要重新读，而不是沿用选档前那一份。
       const cappedRows = labRows()
       /*
        * 自定义帧率：不是一个装饰性输入框。输入 85 之后，预算必须变成它（受屏幕上限约束）且写入存储，
        * 而且按钮要把这个*非预设*的数字显示出来——以前它只会显示成「没有一档被选中」。
        */
       document.querySelector('button[data-frame-rate="custom"]')?.click()
       await delay(300)
       const customInput = document.querySelector('[data-frame-rate-input]')
       if (customInput) {
         customInput.value = '85'
         customInput.dispatchEvent(new Event('input', { bubbles: true }))
       }
       document.querySelector('[data-frame-rate-apply]')?.click()
       await delay(1400)
       const customLive = live()
       const customStored = localStorage.getItem('aurora:frame-rate') ?? ''
       const customLabel = document.querySelector('button[data-frame-rate="custom"]')?.textContent?.trim() ?? ''

       document.querySelector('.segmented button[data-frame-rate="follow"]')?.click()
       await delay(2500)
       const restored = live()

       document.querySelector('.segmented button[data-level="standard"]')?.click()
       await delay(500)
       const levelRows = labRows()
       await toggleLab()

       return JSON.stringify({
         opened,
         closed,
         before,
         capped,
         restored,
         liveGrade: capped.grade,
         liveHz: capped.hz,
         stored: localStorage.getItem('aurora:frame-rate') ?? '',
         custom: { budget: customLive.budget, stored: customStored, label: customLabel, hz: customLive.hz },
         screen,
         budget: cappedRows?.['帧预算'] ?? '',
         particles: Number((rows?.['当前粒子'] ?? '').split(' ')[0]) || 0,
         p95: Number((rows?.['帧耗时 p95'] ?? '').split(' ')[0]) || 0,
         grade: rows?.['负载判定'] ?? '',
         // The row pairs the label with a note, so the level itself is the first token.
         level: (levelRows?.['当前档位'] ?? '').split(' ')[0],
         gate: cappedRows?.['门闸压力'] ?? '',
         anim: document.documentElement.dataset.anim ?? '',
       })
     })()`,
    213,
    30000,
  )
  const frameEngineData = (() => {
    try {
      return JSON.parse(frameEngine?.value ?? '{}')
    } catch {
      return {}
    }
  })()
  check(
    'Aurora Lab 快捷键开合，并报告真实的帧率、帧耗时与画布上的粒子数',
    Boolean(frameEngineData.opened) &&
      frameEngineData.closed === true &&
      frameEngineData.particles > 0 &&
      frameEngineData.p95 > 0 &&
      typeof frameEngineData.grade === 'string' &&
      frameEngineData.grade !== '',
    JSON.stringify({ particles: frameEngineData.particles, p95: frameEngineData.p95, grade: frameEngineData.grade, closed: frameEngineData.closed }),
  )
  const cappedDraw = frameEngineData.capped?.draw ?? 0
  const restoredDraw = frameEngineData.restored?.draw ?? 0
  /*
   * 这一条在暂停态只能证明「接线」，不能证明「上限压住了绘制」——之前的写法两者混在一起，于是新策略
   * （暂停门闸 = 30fps 地板，见 `budget.ts`）一上就让它在测一个暂停态里本来就不该存在的差别：用户选
   * 「跟随」还是「上限 30」，暂停时都跑 30，这不是上限失效，而是候选状态选错了。所以这里留下暂停态
   * 真正拥有的证据（选择写盘 + 预算与门闸跟着走），而上限对绘制的作用放到真在播放的尾段去量。
   */
  check(
    '选 30 档后预算与门闸真的跟着走，切回「跟随」也真的切回来（暂停态两者同受 30fps 地板）',
    frameEngineData.stored === 'follow' &&
      Math.abs((frameEngineData.capped?.budget ?? 0) - 33.33) < 0.2 &&
      (frameEngineData.restored?.budget ?? 0) < 10 &&
      Math.abs((frameEngineData.capped?.gate ?? 0) - 33.33) < 0.2 &&
      Math.abs((frameEngineData.restored?.gate ?? 0) - 33.33) < 0.2,
    JSON.stringify({
      实绘帧率: { 跟随: frameEngineData.before, 上限30: cappedDraw, 切回: restoredDraw },
      预算ms: { 上限30: frameEngineData.capped?.budget, 切回: frameEngineData.restored?.budget },
      门闸ms: { 上限30: frameEngineData.capped?.gate, 切回: frameEngineData.restored?.gate },
      屏幕Hz: { 实测: frameEngineData.liveHz ?? 0, 切回: frameEngineData.restored?.hz ?? 0 },
      判定: frameEngineData.liveGrade,
      存储: frameEngineData.stored,
      门闸压力: frameEngineData.gate,
    }),
  )
  /*
   * 自定义帧率（真实输入，不是预设列表）。
   *
   * 预算按「自定义值与屏幕刷新率取小」算——所以在 60Hz 机器上写 85 得到的是 16.67ms，在 165Hz 上是
   * 11.76ms。期望值是当场按实测 Hz 算出来的，不是写死的常数，这样这条断言在两种屏幕上都是真的。
   */
  const customRate = frameEngineData.custom ?? {}
  const customHz = Number(customRate.hz) || 60
  const expectedCustomBudget = 1000 / Math.min(85, customHz)
  check(
    '自定义帧率：输入的 85 真的生效（预算按自定义值与屏幕取小）并写入存储',
    customRate.stored === '85' &&
      Number.isFinite(customRate.budget) &&
      Math.abs((customRate.budget ?? 0) - expectedCustomBudget) < 0.5,
    JSON.stringify({ 存储: customRate.stored, 预算: customRate.budget, 期望: Number(expectedCustomBudget.toFixed(2)), 屏幕Hz: customHz }),
  )
  check(
    '自定义帧率：非预设值也显示在档位上（不会变成“没有一档选中”）',
    String(customRate.label ?? '').includes('85'),
    String(customRate.label ?? ''),
  )
  check(
    'Lab 报的档位就是页面真正生效的档位（面板不会自己说谎）',
    frameEngineData.level === '标准' && frameEngineData.anim === 'standard',
    JSON.stringify({ lab: frameEngineData.level, applied: frameEngineData.anim }),
  )

  /*
   * 彩蛋与陪伴记录。
   *
   * 这三条检查的都是“规则真的在应用里生效”，而不是“设置页多了一张卡片”：
   *
   *  1. 推荐按钮无论推荐还是不推荐，都必须把理由说出来——静默地换主题、或者静默地不动，都是同一个毛病；
   *  2. 陪伴记录必须是真实累计并落盘的（播放次数、首次日期、时长文案）；
   *  3. 雨夜窗户必须跟真实时钟一致，不能是写死的。
   */
  const companions = await evaluate(
    ws,
    `(async () => {
       const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
       const toasts = () => [...document.querySelectorAll('.toast span')].map((node) => node.textContent ?? '').join(' | ')
       /*
        * 这里不自己造一首正在播的歌。
        *
        * 试过：在这个位置双击一行开始播放，结果把整套用例的播放节奏打乱了——后面的歌词、频谱、唱盘全部失在
        * “根本没在放歌”上（同一个应用实例的播放状态是有剧本的，不该被一条无关的检查提前启动）。所以这里只测
        * 不依赖播放的事：推荐的解释、卡片渲染、时钟规则。“记录真的在累加”放到后面已经确定播过歌的位置。
        */
       const skinBefore = document.documentElement.dataset.skin ?? ''
       const cards = [...document.querySelectorAll('.skin-card')].map((node) => node.getAttribute('data-skin-id') ?? '')

       const storedBefore = localStorage.getItem('aurora:companion') ?? ''
       document.querySelector('[data-recommend-theme]')?.click()
       await delay(700)
       const toast = toasts()
       const skinAfter = document.documentElement.dataset.skin ?? ''

       const stored = JSON.parse(localStorage.getItem('aurora:companion') ?? '{}')
       const card = document.querySelector('[data-companion]')?.textContent?.trim() ?? ''
       const summary = document.querySelector('[data-companion-summary]')?.textContent?.replace(/\\s+/g, ' ').trim() ?? ''
       const hour = new Date().getHours()
       const shouldBeNight = hour >= 22 || hour < 4
       const windowFlag = document.documentElement.getAttribute('data-easter-window') === 'true'

       return JSON.stringify({
         skinBefore,
         skinAfter,
         cards,
         toast,
         // 三种都算“说清了”：推荐了并给理由 / 信息不足以推荐 / 没有在播的歌。唯一不合格的是静默。
         explain: toast.includes('这首歌适合') || toast.includes('没有足够的信息') || toast.includes('还没有正在播放的歌曲'),
         storedBefore: storedBefore.length > 0,
         plays: Number(stored.plays) || 0,
         first: String(stored.firstPlayedAt ?? ''),
         card,
         summary,
         summaryHasPlays: /播放 \\d+ 首/.test(summary),
         hour,
         shouldBeNight,
         windowFlag,
       })
     })()`,
    214,
    25000,
  )
  const companionData = (() => {
    try {
      return JSON.parse(companions?.value ?? '{}')
    } catch {
      return {}
    }
  })()
  check(
    '按当前歌曲推荐主题：无论推荐与否都把理由说出来，且只落在真的装了的皮肤上',
    companionData.explain === true &&
      (companionData.skinAfter === companionData.skinBefore || companionData.cards.includes(companionData.skinAfter)),
    JSON.stringify({ before: companionData.skinBefore, after: companionData.skinAfter, toast: companionData.toast }),
  )
  check(
    '音乐陪伴卡片渲染出真实的次数与时长（不是写死的文案）',
    companionData.summaryHasPlays === true && /陪伴/.test(companionData.summary),
    JSON.stringify({ summary: companionData.summary, card: companionData.card }),
  )
  check(
    '雨夜窗户跟着真实时钟（22:00–04:00 才是夜里），不是写死的',
    companionData.windowFlag === companionData.shouldBeNight,
    JSON.stringify({ hour: companionData.hour, flag: companionData.windowFlag, expected: companionData.shouldBeNight }),
  )

  /*
   * A second theme, on the same page, to prove the recipes are actually per-theme rather than one effect
   * renamed five times. 落日长歌 is the furthest from 星河入梦 in this build: film room, subtitle lyrics,
   * a warm sun flare — all three have to change at once when the card is clicked.
   */
  const sunsetRaw = await evaluate(
    ws,
    `(async () => {
       document.querySelector('.skin-card[data-skin-id="sunset-song"]')?.click()
       await new Promise((resolve) => setTimeout(resolve, 500))
       location.hash = '#/lyrics'
       await new Promise((resolve) => setTimeout(resolve, 900))
       const root = document.documentElement
       const fieldNode = document.querySelector('.ambient-field')
       const grain = document.querySelector('.ambient-grain')
       const line = document.querySelector('.lyric-line.active')
       return JSON.stringify({
         skin: root.dataset.skin ?? '',
         bg: root.dataset.bg ?? '',
         pulse: root.dataset.pulse ?? '',
         lyric: root.dataset.lyric ?? '',
         immersive: root.dataset.immersive ?? '',
         fieldName: fieldNode ? getComputedStyle(fieldNode).animationName : '',
         grainName: grain ? getComputedStyle(grain).animationName : '',
         grainOpacity: grain ? getComputedStyle(grain).opacity : '',
         lineName: line ? getComputedStyle(line).animationName : '',
         lyricDuration: line ? getComputedStyle(line).animationDuration : '',
       })
     })()`,
    107,
  )
  const sunset = (() => {
    try {
      return JSON.parse(sunsetRaw?.value ?? '{}')
    } catch {
      return {}
    }
  })()
  // The settings page has to be behind us again: the restore block below clicks cards that only exist
  // there, and a click on an unmounted page is a silent no-op (which is how "切回默认主题" failed once).
  await evaluate(ws, "location.hash = '#/settings'; 'ok'", 108)
  await waitFor(ws, '.theme-center')
  await delay(500)
  check(
    '换成「落日长歌」后一整套配方同时改（日落背景 / 暖色光晕 / 字幕歌词 / 胶片空间）',
    sunset.skin === 'sunset-song' &&
      sunset.bg === 'sunset' &&
      sunset.pulse === 'sun' &&
      sunset.lyric === 'subtitle' &&
      sunset.immersive === 'film',
    JSON.stringify({ skin: sunset.skin, bg: sunset.bg, pulse: sunset.pulse, lyric: sunset.lyric, immersive: sunset.immersive }),
  )
  check(
    '两套主题的房间动画确实是两条不同的动画（不是同一份换了个名字）',
    sunset.fieldName === 'fx-immersive-film' && sunset.fieldName !== room.fieldName,
    JSON.stringify({ film: sunset.fieldName, nebula: room.fieldName }),
  )
  check(
    '胶片颗粒只在“落日”里跑起来，并且真的加重了',
    sunset.grainName === 'fx-immersive-grain' && Number(sunset.grainOpacity) > 0.03,
    JSON.stringify({ name: sunset.grainName, opacity: sunset.grainOpacity }),
  )

  // Put the app back the way the rest of the suite expects it: default skin, dark, effects on.
  await evaluate(
    ws,
    `(async () => {
       const dark = [...document.querySelectorAll('.theme-center .segmented button')].find((b) => b.textContent.includes('深色'))
       dark?.click()
       await new Promise((resolve) => setTimeout(resolve, 400))
       document.querySelector('.theme-center .segmented button[data-level="standard"]')?.click()
       await new Promise((resolve) => setTimeout(resolve, 300))
       const aurora = [...document.querySelectorAll('.skin-card')].find((node) => node.dataset.skinId === 'aurora')
       aurora?.click()
       await new Promise((resolve) => setTimeout(resolve, 500))
       return 'ok'
     })()`,
    101,
  )
  const restoredSkin = await evaluate(
    ws,
    "JSON.stringify({ skin: document.documentElement.dataset.skin ?? '', effects: localStorage.getItem('aurora:animation-level') ?? '', stored: '' })",
    102,
  )
  const restoredState = (() => {
    try {
      return JSON.parse(restoredSkin?.value ?? '{}')
    } catch {
      return {}
    }
  })()
  const afterRestore = await themeProbe()
  check(
    '切回默认主题：皮肤、明暗、动效档位都回到默认（后续断言的环境干净）',
    afterRestore.dataset === 'dark' && restoredState.skin === 'aurora' && restoredState.effects === 'standard',
    JSON.stringify({ dataset: afterRestore.dataset, ...restoredState }),
  )
  }

  await evaluate(ws, "location.hash = '#/'; 'ok'", 92)

  // The dashboard (four tabs / statistics / smart playlists) only renders once the library has
  // content; a throwaway profile starts empty, so those are asserted after the download phase has
  // put a real file in it (see 本地音乐页看板 checks below).

  const cspErrors = await evaluate(
    ws,
    "performance.getEntriesByType('resource').filter((e) => e.name.includes('aurora-media')).length",
    7,
  )
  check('渲染层已加载自定义媒体协议资源或未产生 CSP 阻断', cspErrors?.value === 0, cspErrors?.value)

  // A throwaway profile has no user sources installed yet, so this asserts the *shape* of the
  // registry (and that platforms are not in it) rather than a count.
  const sources = await evaluate(
    ws,
    `(async () => {
       const list = await window.aurora.sources.list()
       const platforms = await window.aurora.platforms.list()
       const platformIds = platforms.map((item) => item.id)
       return JSON.stringify({
         ids: list.map((item) => item.id + ':' + item.kind),
         kindsOk: list.every((item) => item.kind === 'declarative' || item.kind === 'script'),
         noPlatforms: list.every((item) => !platformIds.includes(item.id)),
         capabilities: list.every((item) => typeof item.capabilities.search === 'boolean'),
       })
     })()`,
    8,
  )
  const sourceShape = (() => {
    try {
      return JSON.parse(sources?.value ?? '{}')
    } catch {
      return {}
    }
  })()
  check(
    '音乐源注册表通过 IPC 可用（只含用户插件，平台不在其中）',
    sourceShape.kindsOk === true && sourceShape.noPlatforms === true && sourceShape.capabilities === true,
    JSON.stringify(sourceShape),
  )

  const settings = await evaluate(ws, "window.aurora.settings.get().then((s) => typeof s.sourceConfig === 'object' && typeof s.enabledSources === 'object' && typeof s.allowOpenLicenseDownloads === 'boolean')", 9)
  check('设置读写接口可用', settings?.value === true, settings?.value)

  await evaluate(ws, "location.hash = '#/search'; 'ok'", 10)
  await waitFor(ws, '.hero-search input')
  const searchView = await evaluate(ws, "document.querySelectorAll('.source-tabs .chip').length", 11)
  check('在线音乐页渲染平台 Tab（全部 + 各在线平台，不含本地）', (searchView?.value ?? 0) >= 5, searchView?.value)

  const onlinePage = await evaluate(
    ws,
    `(() => JSON.stringify({
       topbar: Boolean(document.querySelector('.topbar')),
       hero: Boolean(document.querySelector('.hero-search input')),
       modes: [...document.querySelectorAll('.hero-modes .chip')].map((chip) => chip.textContent.trim()),
       localTab: [...document.querySelectorAll('.source-tabs .chip')].some((chip) => chip.textContent.includes('本地')),
     }))()`,
    12,
  )
  const online = (() => {
    try {
      return JSON.parse(onlinePage?.value ?? '{}')
    } catch {
      return {}
    }
  })()
  check('在线音乐页移除了全局 Header 栏', online.topbar === false, online.topbar)
  check('在线音乐页使用居中 Hero 搜索框', online.hero === true, online.hero)
  check('在线音乐页集成歌词搜索与听歌识曲入口', online.modes.includes('歌词搜索') && online.modes.includes('听歌识曲'), JSON.stringify(online.modes))
  check('在线音乐页不含「本地音乐库」Tab', online.localTab === false, online.localTab)

  /*
   * The platform tabs are display names: the ids (`kw` / `wy` / …) stay the routing key, but the tab
   * is expected to read the alias. Both halves are asserted — the aliases are present *and* none of
   * the old service names leaked through — because the second half is what actually catches a missed
   * display site.
   */
  const aliasTabs = await evaluate(
    ws,
    `(() => {
       const chips = [...document.querySelectorAll('.source-tabs .chip')].map((chip) => chip.textContent.trim())
       const chartHint = document.querySelector('.section-block p')?.textContent?.trim() ?? null
       return JSON.stringify({ chips, chartHint })
     })()`,
    13,
  )
  const aliases = (() => {
    try {
      return JSON.parse(aliasTabs?.value ?? '{}')
    } catch {
      return { chips: [] }
    }
  })()
  const wantedAliases = ['红云心语', '绿洲曲海', '蔚蓝声浪', '青空纯音']
  check(
    '平台 Tab 使用代号文案',
    wantedAliases.every((alias) => (aliases.chips ?? []).includes(alias)),
    JSON.stringify(aliases.chips),
  )
  check(
    '平台 Tab 不再出现旧服务名',
    !(aliases.chips ?? []).some((chip) => /网易云|酷我|酷狗|咪咕|QQ音乐/.test(chip)),
    JSON.stringify(aliases.chips),
  )
  check(
    '热榜副标题使用新文案',
    aliases.chartHint === null || String(aliases.chartHint).includes('探索多元音浪'),
    aliases.chartHint,
  )

  /*
   * 「热门搜索」角栏。
   *
   * 三件事必须同时成立，而第三条是这次改动真正的风险：角栏放在右上角、能收起展开；同时**它不得从热榜列表
   * 手里拿走列宽**。列表的列数是按自身容器宽度决定的（专辑列 ≥ 980px、格式列 ≥ 1180px），所以一个“看起来
   * 只是靠右”的常驻面板，很可能悄悄让列表少一列 —— 那比位置难看得多，所以它被写成了断言。
   *
   * 时间给到 600ms：展开的缓动是 320ms，留一倍余量，免得断言去追一个还在动的值。
   */
  const corner = await evaluate(
    ws,
    `(async () => {
       const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
       const panel = document.querySelector('.corner-panel')
       if (!panel) return JSON.stringify({ panel: false })
       const scroller = document.querySelector('.content-scroll')
       /*
        * 正文列的宽度才是“有没有被夺走空间”的那个数：热榜列表在本机不一定有曲目（没有登记的平台就只渲染空态），
        * 所以盯着一行曲目去量会让这条断言时灵时不灵。
        */
       const main = document.querySelector('.online-main')
       const list = document.querySelector('.track-list')
       const head = panel.querySelector('.corner-head')
       const read = () => {
         const rect = panel.getBoundingClientRect()
         const scope = scroller.getBoundingClientRect()
         return {
           collapsed: panel.classList.contains('collapsed'),
           width: Math.round(rect.width),
           rightGap: Math.round(scope.right - rect.right),
           rightHalf: rect.left + rect.width / 2 > scope.left + scope.width / 2,
           topGap: Math.round(rect.top - scope.top),
           chips: panel.querySelectorAll('.chip').length,
           expanded: head.getAttribute('aria-expanded'),
           bodyHeight: Math.round(panel.querySelector('.corner-body').getBoundingClientRect().height),
           divider: getComputedStyle(panel.querySelector('.corner-divider')).transform,
           bodyTransition: getComputedStyle(panel.querySelector('.corner-body')).transition,
           mainWidth: Math.round(main.getBoundingClientRect().width),
           rowColumns: list ? getComputedStyle(list.querySelector('.track-row')).gridTemplateColumns.split(' ').length : null,
         }
       }
       const open = read()
       head.click()
       await wait(600)
       const shut = read()
       head.click()
       await wait(600)
       const again = read()

       /*
        * 然后关掉过渡再量一次。
        *
        * 点一次就等 600ms 是不稳的：窗口被遮住时 Chromium 会节流渲染，而 grid-template-rows 的过渡不是合成器动画，
        * 它靠帧推进 —— 窗口不可见时它会停在半路，于是断言读到的是“动画中途”的值而不是结果。前面两次跑就是这原因一次过、
        * 一次红。下面这组量的是动画**收敛到的那一版**，与帧时钟无关；而“确实有过渡”由上面那个读到的 transition 声明来管。
        */
       const kill = document.createElement('style')
       kill.textContent = '.corner-panel, .corner-panel * { transition: none !important; animation: none !important; }'
       document.head.appendChild(kill)
       head.click()
       await wait(120)
       const settledShut = read()
       head.click()
       await wait(120)
       const settledOpen = read()
       kill.remove()

       return JSON.stringify({ open, shut, again, settledShut, settledOpen })
     })()`,
    14,
  )
  const cornerState = (() => {
    try {
      return JSON.parse(corner?.value ?? '{}')
    } catch {
      return { panel: false }
    }
  })()
  check(
    '「热门搜索」角栏位于右侧偏上且默认展开',
    cornerState.panel !== false &&
      cornerState.open?.collapsed === false &&
      cornerState.open?.rightHalf === true &&
      cornerState.open?.rightGap >= 0 &&
      /* 页边距也算进去：角栏贴着的是页面自己的内边距，不是视口边缘。 */
      cornerState.open?.rightGap < 120 &&
      cornerState.open?.chips > 0 &&
      cornerState.open?.topGap < 400,
    JSON.stringify(cornerState.open),
  )
  check(
    '角栏点击可收起并再展开（状态与 aria 同步）',
    cornerState.shut?.collapsed === true &&
      cornerState.again?.collapsed === false &&
      cornerState.open?.expanded === 'true' &&
      cornerState.shut?.expanded === 'false' &&
      cornerState.settledOpen?.expanded === 'true',
    JSON.stringify({ open: cornerState.open?.expanded, shut: cornerState.shut?.expanded, back: cornerState.again?.expanded }),
  )
  check(
    '收起时真的收成一枚胶囊（内容高度为 0、宽度变窄）',
    cornerState.settledShut?.bodyHeight === 0 &&
      (cornerState.settledOpen?.bodyHeight ?? 0) > 0 &&
      cornerState.settledShut?.width < (cornerState.settledOpen?.width ?? 0) &&
      cornerState.settledShut?.width >= 120,
    JSON.stringify({ openW: cornerState.settledOpen?.width, shutW: cornerState.settledShut?.width, openBody: cornerState.settledOpen?.bodyHeight, shutBody: cornerState.settledShut?.bodyHeight }),
  )
  check(
    '展开时分割线画出来（收起时收回），而且两者都是过渡而不是硬切',
    String(cornerState.settledOpen?.divider ?? '').startsWith('matrix(1') &&
      String(cornerState.settledShut?.divider ?? '').startsWith('matrix(0') &&
      /grid-template-rows[^,]*,/.test(String(cornerState.open?.bodyTransition ?? '')) &&
      /\d+(\.\d+)?s/.test(String(cornerState.open?.bodyTransition ?? '')),
    JSON.stringify({ open: cornerState.settledOpen?.divider, shut: cornerState.settledShut?.divider, transition: cornerState.open?.bodyTransition }),
  )
  check(
    '角栏没有从正文列里拿走宽度（收起与展开时正文一样宽，热榜列表列数不变）',
    (cornerState.open?.mainWidth ?? 0) > 0 &&
      cornerState.open?.mainWidth === cornerState.shut?.mainWidth &&
      cornerState.open?.rowColumns === cornerState.shut?.rowColumns,
    JSON.stringify({
      wide: cornerState.wide,
      openMain: cornerState.open?.mainWidth,
      shutMain: cornerState.shut?.mainWidth,
      columns: cornerState.open?.rowColumns,
    }),
  )

  // DevTools protocol ids must be int32: a fractional id is dropped silently and looks like a hang.
  await evaluate(ws, "location.hash = '#/settings/sources'; 'ok'", 13)
  await waitFor(ws, '.paste-block textarea')
  // The plugin list must mirror the registry exactly: that is the invariant, and it holds for zero
  // installed sources too (which is what a fresh profile has).
  const panelSync = await evaluate(
    ws,
    `(async () => {
       const list = await window.aurora.sources.list()
       return JSON.stringify({
         sources: list.length,
         panels: document.querySelectorAll('.source-panel').length,
         kindChips: [...document.querySelectorAll('.source-panel .kind-chip')].map((n) => n.textContent.trim()),
         permChips: document.querySelectorAll('.source-panel .perm-chip').length,
       })
     })()`,
    14,
  )
  const panelState = (() => {
    try {
      return JSON.parse(panelSync?.value ?? '{}')
    } catch {
      return {}
    }
  })()
  check('音源管理页的面板数量与注册表一致', panelState.panels === panelState.sources, JSON.stringify(panelState))
  check(
    '音源管理页每个面板都展示音源种类',
    panelState.kindChips.length === panelState.panels && panelState.kindChips.every((label) => label.length > 0),
    JSON.stringify(panelState.kindChips),
  )

  const autoHealth = await evaluate(
    ws,
    "[...document.querySelectorAll('.setting-row.flat')].some((row) => row.textContent.includes('后台自动健康检查'))",
    19,
  )
  check('音源管理页提供后台健康检查开关', autoHealth?.value === true, autoHealth?.value)

  // Permission chips are rendered per declared permission; with no source installed there is nothing
  // to declare. The post-install checks below assert them against a real installed source.
  const permissionChips = await evaluate(ws, "document.querySelectorAll('.source-panel .perm-chip').length", 28)
  check('音源管理页在无音源时不渲染权限声明', (permissionChips?.value ?? -1) === panelState.permChips, `${permissionChips?.value} / ${panelState.permChips}`)

  /*
   * 安全模式（平台访问）。
   *
   * 界面上一行字没什么好断言的，所以这里查的是它真的是一位*策略*：开关写进主进程设置并可读回，而且上面的
   * 「自动允许主机」当场变成不可用——两个开关能同时打开，正是安全模式要防的状态。
   */
  const safeModePanel = await evaluate(
    ws,
    `(async () => {
       const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
       /*
        * 取**最后一个**实例，而不是第一个。
        *
        * 这条断言在长流程里红过一次，而同一份产物单跑探针是绿的。差别在于：整套验收遍历过许多视图，
        * 路由切换的一瞬间 DOM 里可能同时挂着两份 SourcesSettingsView，querySelector 拿到的可能是
        * 那份已经不参与渲染（但仍留在树上）的旧节点——它的 disabled 永远停在旧值。所以这里按最后一个
        * 取，并且 disabled 与文案读**同一个**元素：两个读数来自同一个 ref，本来就不可能出现「文案说已开、
        * 按钮还说能用」这种组合，一旦出现，那一定是读错了元素。
        */
       const pick = () => {
         const all = document.querySelectorAll('[data-safe-mode]')
         return all[all.length - 1] ?? null
       }
       const pickGrant = () => {
         const all = document.querySelectorAll('[data-auto-grant]')
         return all[all.length - 1] ?? null
       }
       const toggle = pick()
       const before = (await window.aurora.settings.get()).safeMode
       toggle?.click()
       const after = (await window.aurora.settings.get()).safeMode
       let grant = pickGrant()
       /*
        * 等 DOM，而不是等一个猜出来的毫秒数。
        *
        * 这里本来写的是固定等 450ms，然后在整页按钮里按**文本**找那一个——两个毛病：文本「已开启
        * （点击关闭）」和上面的健康检查按钮完全一样，而固定等待在应用正忙时并不保证重绘结束。
        * 现在按语义找（data-auto-grant）并轮询到它真的变禁用，最多 5 秒。
        */
       for (let attempt = 0; attempt < 50 && !grant?.disabled; attempt += 1) {
         await delay(100)
         grant = pickGrant()
       }
       const label = pick()?.textContent?.trim() ?? ''
       const grantLabel = grant?.textContent?.trim() ?? ''
       /*
        * 就在**这里**把「安全模式开着时它是否禁用」记下来。
        *
        * 这条断言上一轮是红的，读数看着像功能坏了：文案已经是「安全模式下强制关闭」（同一个 ref 控制的
        * 后半句），按钮却还报 disabled:false。真相在下一行——那个布尔值是在下面把安全模式**关回去之后**
        * 才读的，所以它必然是 false，而这条检查本来就是错的。两个读数分开取，后半句还顺手证明了一件事：
        * 关掉安全模式后按钮要立刻恢复可用（不是被永久钉死）。
        */
       const grantDisabledWhileOn = Boolean(grant?.disabled)
       const instances = document.querySelectorAll('[data-safe-mode]').length
       // 关回去：后面的用例要装音源，不该活在安全模式的策略下。
       pick()?.click()
       for (let attempt = 0; attempt < 50; attempt += 1) {
         if (!pickGrant()?.disabled) break
         await delay(100)
       }
       const restored = (await window.aurora.settings.get()).safeMode
       return JSON.stringify({
         before,
         after,
         restored,
         label,
         grantLabel,
         grantDisabledWhileOn,
         grantDisabledAfterRestore: Boolean(pickGrant()?.disabled),
         instances,
       })
     })()`,
    655,
    20000,
  )
  const safeModeState = (() => {
    try {
      return JSON.parse(safeModePanel?.value ?? '{}')
    } catch {
      return {}
    }
  })()
  check(
    '安全模式：开关真的写进主进程设置、并且能关回去',
    safeModeState.before === false && safeModeState.after === true && safeModeState.restored === false,
    JSON.stringify(safeModeState),
  )
  check(
    '安全模式：开启时「自动允许主机」当场失效（两个开关不会互相矛盾）',
    safeModeState.grantDisabledWhileOn === true &&
      safeModeState.label.includes('已开启') &&
      safeModeState.grantLabel.includes('安全模式下强制关闭'),
    JSON.stringify({
      whileOn: safeModeState.grantDisabledWhileOn,
      label: safeModeState.label,
      grantLabel: safeModeState.grantLabel,
      instances: safeModeState.instances,
    }),
  )
  check(
    '安全模式：关回去后「自动允许主机」立刻恢复可用（不是被永久钉死）',
    safeModeState.grantDisabledAfterRestore === false,
    String(safeModeState.grantDisabledAfterRestore),
  )
  /*
   * 全量自检 button, in the state a fresh install is in: no sources at all.
   *
   * That is exactly the state where a batch feature most easily lies — it would be trivial to render an
   * empty panel and call it a pass. What is asserted instead: the run completes through the real IPC
   * channel, the panel appears, and it says *out loud* that there is nothing to check.
   */
  const emptyBatch = await evaluate(
    ws,
    `(async () => {
       const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
       const button = document.querySelector('[data-check-all-run]')
       button?.click()
       for (let attempt = 0; attempt < 60 && !document.querySelector('[data-check-all-panel]'); attempt += 1) await delay(200)
       const panel = document.querySelector('[data-check-all-panel]')
       return JSON.stringify({
         clicked: Boolean(button),
         panel: Boolean(panel),
         headline: panel?.querySelector('.check-all-head strong')?.textContent?.trim() ?? '',
         rows: panel ? panel.querySelectorAll('.check-all-row').length : -1,
         buttonBack: button ? !button.disabled : false,
       })
     })()`,
    657,
    30000,
  )
  const emptyBatchState = (() => {
    try {
      return JSON.parse(emptyBatch?.value ?? '{}')
    } catch {
      return {}
    }
  })()
  check(
    '全量自检：一个音源都没有时如实说“没有已启用的音源”，而不是给一个空盒子',
    emptyBatchState.clicked === true &&
      emptyBatchState.panel === true &&
      emptyBatchState.rows === 0 &&
      emptyBatchState.headline.includes('没有已启用') &&
      emptyBatchState.buttonBack === true,
    emptyBatchState,
  )

  /*
   * 安装区的第三条路径：不经过任何脚本协议，直接新建一个自己的音源。
   *
   * 只断言“按钮在”不够——要证明它开的确实是那个不跑代码的编辑器，而且能保存成一个真能解析的音源。
   */
  const customInstallEntry = await evaluate(
    ws,
    `(async () => {
       const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
       const button = document.querySelector('[data-new-custom-source]')
       const label = button?.textContent?.trim() ?? ''
       button?.click()
       await delay(500)
       const text = document.querySelector('.manifest-editor')?.value ?? ''
       document.querySelector('.manifest-close, .ghost-button')?.click()
       await delay(200)
       return JSON.stringify({ label, opened: text.includes('apiVersion'), hasStream: text.includes('\"streamUrl\"') })
     })()`,
    656,
    20000,
  )
  const customEntry = (() => {
    try {
      return JSON.parse(customInstallEntry?.value ?? '{}')
    } catch {
      return {}
    }
  })()
  check(
    '安装音源：新增「自定义」入口打开的是声明式编辑器（不经过脚本协议）',
    customEntry.opened === true && customEntry.label.includes('自定义'),
    JSON.stringify(customEntry),
  )

  /*
   * 自定义音源要“能正常解析”，而不是能保存。
   *
   * The whole chain, through the app's own IPC, against the local fixture: install a manifest, search it,
   * resolve a play URL, and read real bytes back from the relay. This is the check that would have caught
   * the validator/runtime disagreement fixed in this round — a manifest whose endpoint carries a
   * placeholder had been installable-in-theory and refused-in-practice.
   *
   * Declared as a function and invoked after the media fixture exists (see `await checkCustomSourceE2E()`):
   * the manifest is built from the fixture's real origin, so it cannot run before `source` does.
   */
  async function checkCustomSourceE2E() {
  const customSourceE2E = await evaluate(
    ws,
    `(async () => {
       const origin = ${JSON.stringify(source.origin)}
       const host = ${JSON.stringify(source.host)}
       const manifest = {
         apiVersion: '1',
         id: 'packaged-custom',
         name: '打包内自定义音源',
         version: '1.0.0',
         homepage: origin + '/',
         license: 'CC BY 4.0',
         capabilities: { search: true, stream: true },
         permissions: ['network'],
         allowedHosts: [host],
         search: {
           url: origin + '/search',
           query: { kw: '{query}' },
           resultsPath: 'data.list',
           fields: { id: 'songmid', title: 'songname', artist: 'singer', album: 'albumname', duration: 'interval' },
         },
         stream: { url: origin + '/audio.wav' },
       }
       let saved
       try {
         saved = await window.aurora.customSources.save(JSON.stringify(manifest))
       } catch (error) {
         return JSON.stringify({ stage: 'save', thrown: String(error?.message ?? error) })
       }
       if (!saved.ok) return JSON.stringify({ stage: 'save', errors: saved.errors })
       const outcome = await window.aurora.sources.searchOne('packaged-custom', '打包测试', { pageSize: 5 })
       const track = outcome.tracks?.[0]
       if (!track) {
         await window.aurora.customSources.remove('packaged-custom')
         return JSON.stringify({ stage: 'search', error: outcome.error ?? null })
       }
       const resolved = await window.aurora.sources.resolve('packaged-custom', track)         /*
          * 用 <audio> 读字节，而不是 fetch。
          *
          * 渲染层的 CSP 只为 img-src / media-src 放开 aurora-media:，用 fetch 请求一个自定义协议会被拒
          * ——于是这条检查会以「求值抛错」的形式失败，报告里只剩一个空对象，看上去像音源坏了。媒体元素
          * 走的正是应用播放时走的那条路，把它当探针反而更接近真实。
          */
       let mediaLoaded = false
       let mediaSeconds = 0
       if (resolved?.url) {
         const outcome = await new Promise((resolve) => {
           const audio = document.createElement('audio')
           const timer = setTimeout(() => resolve({ loaded: false, seconds: 0 }), 6000)
           audio.addEventListener('loadedmetadata', () => {
             clearTimeout(timer)
             resolve({ loaded: true, seconds: Number(audio.duration) || 0 })
           })
           audio.addEventListener('error', () => {
             clearTimeout(timer)
             resolve({ loaded: false, seconds: 0 })
           })
           audio.preload = 'metadata'
           audio.src = resolved.url
           document.body.appendChild(audio)
         })
         mediaLoaded = outcome.loaded
         // 夹具是恰好三秒的 WAV，所以时长本身就是一个真实读数：中继递出去的确实是那段音频，
         // 而不是一个能解析、却没有字节的地址。
         mediaSeconds = outcome.seconds
       }
       const list = await window.aurora.sources.list()
       const descriptor = list.find((item) => item.id === 'packaged-custom')
       /*
        * 一定删干净，即使中间出错也一样。
        *
        * 第一次跑时这一步在 fetch 抛错后没执行，于是这个音源落到了后面「单音源管理页」那组用例里，
        * 一口气带红了三条与它无关的断言——一条检查的残留把别的检查弄红了，比它自己失败更浪费时间。
        */
       await window.aurora.customSources.remove('packaged-custom')
       const after = await window.aurora.sources.list()
       return JSON.stringify({
         stage: 'done',
         title: track.title,
         artist: track.artist,
         kind: descriptor?.kind,
         status: descriptor?.status,
         stream: Boolean(descriptor?.capabilities.stream),
         relayed: String(resolved?.url ?? '').startsWith('aurora-media://'),
         mediaLoaded,
         mediaSeconds,
         removed: !after.some((item) => item.id === 'packaged-custom'),
       })
     })()`,
    657,
    40000,
  )
  const customE2E = (() => {
    try {
      return JSON.parse(customSourceE2E?.value ?? '{}')
    } catch {
      return {}
    }
  })()
  check(
    '自定义音源：安装 → 搜索（字段映射）→ 解析播放地址 → 中继送出可解码的音频 → 删除',
    customE2E.stage === 'done' &&
      customE2E.title === '打包内测试歌曲' &&
      customE2E.artist === 'E2E 歌手' &&
      customE2E.kind === 'declarative' &&
      customE2E.stream === true &&
      customE2E.relayed === true &&
      customE2E.mediaLoaded === true &&
      customE2E.mediaSeconds > 2.5 &&
      customE2E.removed === true,
    JSON.stringify(customE2E),
  )
  }

  const requestLog = await evaluate(
    ws,
    "window.aurora.sources.requests().then((list) => Array.isArray(list))",
    29,
  )
  check('请求日志通道可用（诊断面板数据源）', requestLog?.value === true, requestLog?.value)

  // The declarative-source IPC channels must exist in the packaged main process: an unregistered
  // handler would reject the invoke (and a missing validator would let bad manifests through).
  const customValidate = await evaluate(
    ws,
    "window.aurora.customSources.validate('{ not json').then((r) => r.ok === false && r.errors.length > 0)",
    20,
  )
  check('自定义音源校验通过 IPC 生效（非法 JSON 被拒绝）', customValidate?.value === true, JSON.stringify(customValidate?.value))

  const customReject = await evaluate(
    ws,
    "window.aurora.customSources.save(JSON.stringify({ apiVersion: '1' })).then((r) => r.ok === false && r.errors.length > 0)",
    21,
  )
  check('自定义音源保存走主进程校验（不完整清单不落盘）', customReject?.value === true, JSON.stringify(customReject?.value))

  const openEditor = await evaluate(
    ws,
    "[...document.querySelectorAll('button')].find((b) => b.textContent.includes('添加 API 音源'))?.click(); 'ok'",
    22,
  )
  await delay(400)
  const manifestEditor = await evaluate(ws, "!!document.querySelector('.manifest-editor') && !!document.querySelector('.manifest-errors, .manifest-status')", 23)
  check('自定义音源编辑器可打开（含清单文本域与状态区）', manifestEditor?.value === true, `${openEditor?.value} / ${manifestEditor?.value}`)

  const templates = await evaluate(
    ws,
    "window.aurora.customSources.templates().then((t) => t.map((x) => x.id + ':' + (x.json.includes('apiVersion') && x.json.length > 100 ? 'json' : 'broken')))",
    24,
  )
  check(
    '内置样板通过 IPC 下发（含可直接载入的清单）',
    Array.isArray(templates?.value) && templates.value.length >= 2 && templates.value.every((entry) => entry.endsWith(':json')),
    JSON.stringify(templates?.value),
  )

  const clickedTemplate = await evaluate(
    ws,
    "[...document.querySelectorAll('.template-row button')].find((b) => b.textContent.includes('Internet Archive'))?.click(); 'ok'",
    25,
  )
  await delay(400)
  const editorValue = await evaluate(ws, "(document.querySelector('.manifest-editor')?.value ?? '').includes('archive.org')", 26)
  check('点击样板后编辑器载入真实清单', editorValue?.value === true, `${clickedTemplate?.value} / ${editorValue?.value}`)

  await evaluate(ws, "location.hash = '#/lyrics'; 'ok'", 15)
  // Waits for the *page*, not for any element that happens to be on screen: `.view` exists on the
  // settings page this block arrives from, so waiting for that returned immediately and the layout was
  // measured against a page that had not mounted yet.
  await waitFor(ws, '.lyrics-page')
  await delay(900)
  const lyricsPage = await evaluate(ws, "!!document.querySelector('.lyrics-page') && !!document.querySelector('.ambient')", 16)
  check('沉浸式歌词页可渲染（含弥散背景层）', lyricsPage?.value === true, lyricsPage?.value)

  /*
   * Layout of the immersive page, measured rather than eyeballed.
   *
   * The columns used to be declared 5fr / 7fr, and this block used to assert that ratio held. It did —
   * which is exactly why the assertion was worthless: it pinned a split whose left half gave the cover a
   * 488px cell for a 340px picture, so the artwork's edge lined up with nothing, and it said nothing
   * about the two things that were actually wrong on the page. What the real numbers have to show now:
   * the artwork's column is the artwork's own measure, the left stack is centred rather than holding a
   * several-hundred-pixel hole, and the action row clears the player bar — which floats *above* this
   * page (`--z-player` > `--z-overlay`), so a row pinned to the bottom was not just overlapped, it was
   * unclickable.
   */
  const pageLayout = await evaluate(
    ws,
    `(() => {
       const grid = document.querySelector('.lp-grid')
       const tracks = grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').map(parseFloat) : []
       const field = document.querySelector('.ambient-field')
       const grain = document.querySelector('.ambient-grain')
       const back = document.querySelector('.lp-head .glass-icon-button')
       const right = document.querySelector('.lp-right')
       const art = document.querySelector('.artwork')
       const meta = document.querySelector('.lp-meta')
       const actions = document.querySelector('.lp-actions')
       const bar = document.querySelector('.player-bar')
       const metaRect = meta?.getBoundingClientRect()
       const actionsRect = actions?.getBoundingClientRect()
       const barRect = bar?.getBoundingClientRect()
       const artWidth = art?.getBoundingClientRect().width ?? 0
       /*
        * Hit-test the row's own centre instead of trusting its coordinates: "inside the viewport" and
        * "on top" are different claims, and only the second one makes a control usable.
        */
       const actionButton = actions?.querySelector('button')
       const buttonRect = actionButton?.getBoundingClientRect()
       const topMost = buttonRect
         ? document.elementFromPoint(buttonRect.left + buttonRect.width / 2, buttonRect.top + buttonRect.height / 2)
         : null
       return JSON.stringify({
         tracks,
         artWidth,
         rowGap: metaRect && actionsRect ? Math.round(actionsRect.top - metaRect.bottom) : -1,
         actionsBottom: actionsRect ? Math.round(actionsRect.bottom) : -1,
         barTop: barRect ? Math.round(barRect.top) : -1,
         actionsHit: topMost ? String(topMost.className) : 'none',
         fieldFilter: field ? getComputedStyle(field).filter : '',
         grainOpacity: grain ? getComputedStyle(grain).opacity : '',
         grainImage: grain ? getComputedStyle(grain).backgroundImage.slice(0, 24) : '',
         backShape: back ? { w: back.getBoundingClientRect().width, radius: getComputedStyle(back).borderRadius, blur: getComputedStyle(back).backdropFilter } : null,
         views: [...document.querySelectorAll('.lp-viewswitch button')].map((b) => b.textContent.trim()),
         headerImport: [...document.querySelectorAll('.lp-head button')].some((b) => b.textContent.includes('导入')),
         cardInRight: right ? Boolean(right.querySelector('.card')) : null,
         empty: {
           title: document.querySelector('.lp-empty-title')?.textContent?.trim() ?? '',
           hint: document.querySelector('.lp-empty-hint')?.textContent?.replace(/\\s+/g, ' ').trim() ?? '',
           actions: [...document.querySelectorAll('.lp-empty-actions button')].map((b) => b.textContent.trim()),
         },
       })
     })()`,
    16,
  )
  const layout = (() => {
    try {
      return JSON.parse(pageLayout?.value ?? '{}')
    } catch {
      return { raw: pageLayout?.value }
    }
  })()
  check(
    '两栏：封面列就是封面自己的宽度（否则图片比标题窄，左半边没有一条边可以对齐）',
    Array.isArray(layout.tracks) && layout.tracks.length === 2 && layout.artWidth > 0 && Math.abs(layout.artWidth - layout.tracks[0]) <= 1,
    JSON.stringify({ art: layout.artWidth, columns: layout.tracks }),
  )
  check(
    '歌曲信息与操作按钮同属一组：中间没有大段空洞，且操作栏整个落在播放栏之上（不是被它盖住）',
    Number(layout.rowGap) >= 0 &&
      Number(layout.rowGap) <= 40 &&
      Number(layout.actionsBottom) < Number(layout.barTop) &&
      !/player/.test(String(layout.actionsHit)),
    JSON.stringify({
      gapAfterMeta: layout.rowGap,
      actionsBottom: layout.actionsBottom,
      barTop: layout.barTop,
      hit: layout.actionsHit,
    }),
  )
  /*
   * The colour field has to be *softened*, not merely present: a big blur and a saturation *cut* are what
   * keep the cover tinting the room instead of repainting it. Asserted as intent (a large blur, some
   * desaturation, 3% grain) rather than as one exact number, so tuning the field does not read as a
   * regression while removing the softening still fails.
   */
  const fieldBlur = Number((String(layout.fieldFilter).match(/blur\((\d+(?:\.\d+)?)px\)/) ?? [])[1] ?? 0)
  check(
    '背景为高斯模糊双层 + 3% 颗粒（色场被柔化并降饱和）',
    fieldBlur >= 90 &&
      /saturate\(0\.\d+\)/.test(String(layout.fieldFilter)) &&
      layout.grainOpacity === '0.03' &&
      String(layout.grainImage).includes('svg'),
    JSON.stringify({ filter: layout.fieldFilter, opacity: layout.grainOpacity, grain: layout.grainImage }),
  )
  // A pill radius is what "circle" means for a 38px button, so the assertion is about the *shape*
  // (radius comfortably past half the box) rather than an equality that only holds for `50%`.
  check(
    '左上角返回按钮为圆形毛玻璃',
    Boolean(layout.backShape) &&
      Math.abs(layout.backShape.w - 38) < 1 &&
      parseFloat(layout.backShape.radius) >= 19 &&
      String(layout.backShape.blur).includes('blur'),
    JSON.stringify(layout.backShape),
  )
  check('页头不再有「导入」按钮', layout.headerImport === false, layout.headerImport)
  check(
    '右侧提供 歌词 / 频谱律动 / 拟真唱片 三视图',
    JSON.stringify(layout.views) === JSON.stringify(['歌词', '频谱律动', '拟真唱片']),
    JSON.stringify(layout.views),
  )
  check('右侧栏去卡片化（无 .card 容器）', layout.cardInRight === false, layout.cardInRight)
  // Reached before anything is playing, so this is the "no track" state. The "no lyrics" wording is
  // asserted further down, once the E2E source is actually playing a song.
  check(
    '未播放时显示无界空态与真实入口',
    layout.empty?.title === '还没有正在播放的歌曲' &&
      layout.empty?.actions?.some((text) => text.includes('去搜索')) &&
      layout.empty?.actions?.some((text) => text.includes('回到本地音乐')),
    JSON.stringify(layout.empty),
  )

  const blockedRemote = await evaluate(ws, "window.aurora.sources.resolve('radio-browser', 'not-a-real-station').then((r) => r === null)", 12)
  check('解析未知电台返回 null 而不是抛错', blockedRemote?.value === true, blockedRemote?.value)

  // The Source Detector and the script runtime must exist in the packaged app, not just in dev.
  // Running a real probe here proves the sandbox host preload was packaged correctly: a missing
  // preload would surface as a load error instead of a declaration.
  const scriptChannel = await evaluate(ws, "window.aurora.scriptSources.list().then((l) => Array.isArray(l))", 28)
  check('脚本音源通道可用（打包产物内含宿主）', scriptChannel?.value === true, scriptChannel?.value)

  const detect = await evaluate(
    ws,
    "window.aurora.sourceImport.fromText(\"globalThis.defineAuroraSource({ name: 'packaged-probe', version: '1', async search() { return [] } })\", 'packaged.js').then((r) => r.kind + ':' + (r.script ? r.script.actions.join('+') : 'none'))",
    29,
  )
  check(
    '打包产物内可以真实探测脚本音源（宿主 + preload 已打包）',
    typeof detect?.value === 'string' && detect.value.startsWith('script:') && detect.value.includes('search'),
    detect?.value,
  )

  const unknownFormat = await evaluate(
    ws,
    "window.aurora.sourceImport.fromText('definitely not a source', 'notes.txt').then((r) => r.kind + '|' + r.summary)",
    30,
  )
  check(
    '未识别的文件只报告「未知 Source 格式」',
    typeof unknownFormat?.value === 'string' && unknownFormat.value.startsWith('unknown|') && unknownFormat.value.includes('未知 Source 格式'),
    unknownFormat?.value,
  )

  const pending = await evaluate(ws, "window.aurora.sources.pendingHosts().then((l) => Array.isArray(l))", 31)
  check('运行时待授权主机通道可用', pending?.value === true, pending?.value)

  /*
   * The two pieces of chrome that float above the playback-detail page are painted with the page's own
   * *backdrop*, sampled from the compositor — the room is mostly a blurred cover plus three
   * artwork-derived fields, so no token can predict it, and the approximate version that came before
   * (the skin's dark palette tinted with the cover's accent) left a warm slab across a purple room.
   *
   * So the assertion is not "it is dark", it is "it is the colour actually behind it": a fresh sample
   * is taken through the same channel and compared. The tolerance exists because the ambient canvas is
   * alive while this runs, not because the shell is allowed to be a different colour.
   */
  const shellPaint = await evaluate(
    ws,
    `(async () => {
       const root = document.documentElement
       const width = innerWidth
       const height = innerHeight
       const bar = parseFloat(getComputedStyle(root).getPropertyValue('--player-h')) || 100
       const band = Math.round(Math.min(160, Math.max(48, width * 0.07)))
       const x = Math.max(0, Math.round((width - band) / 2))
       const fresh = await window.aurora.app.sampleBackdrop([
         { x, y: 2, width: band, height: 12 },
         { x, y: Math.max(0, Math.round(height - bar - 16)), width: band, height: 12 },
       ])
       return JSON.stringify({
         night: root.dataset.night,
         strip: root.style.getPropertyValue('--titlebar-bg').trim(),
         bar: root.style.getPropertyValue('--shell-bar').trim(),
         accent: root.style.getPropertyValue('--amb-accent').trim(),
         fresh,
       })
     })()`,
    34,
  )
  const paint = (() => {
    try {
      return JSON.parse(shellPaint?.value ?? '{}')
    } catch {
      return {}
    }
  })()
  /** Channel-wise blend, used to re-derive the shell colour from the samples this check just took. */
  const mixHex = (from, to, amount) => {
    const a = rgbOf(from)
    const b = rgbOf(to)
    if (!a || !b) return null
    const ratio = Math.min(1, Math.max(0, amount))
    return `#${a
      .map((value, index) =>
        Math.round(value + (b[index] - value) * ratio)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')}`
  }
  const sameColour = (left, right, tolerance = 8) => {
    const a = rgbOf(left)
    const b = rgbOf(right)
    if (!a || !b) return false
    return a.every((value, index) => Math.abs(value - b[index]) <= tolerance)
  }
  const rgbOf = (value) =>
    typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)
      ? [1, 3, 5].map((index) => Number.parseInt(value.slice(index, index + 2), 16))
      : null
  /**
   * How far `shell` sits between the measured backdrop and the cover's accent, averaged over the channels
   * the accent actually moves.
   *
   * A *fraction* rather than an equality, because the number is a design choice: what must hold is that the
   * shell is neither a bare sample of the backdrop (0) nor a bare token that ignores it (≈1, or negative).
   * Both wrong answers failed here during development, and both look plausible in a screenshot.
   */
  const accentShare = (shell, edge, accent) => {
    const s = rgbOf(shell)
    const e = rgbOf(edge)
    const a = rgbOf(accent)
    if (!s || !e || !a) return null
    const moves = a.map((value, index) => value - e[index]).filter((delta) => Math.abs(delta) > 16)
    if (moves.length === 0) return null
    const fractions = moves.map((delta, index) => (s[index] - e[index]) / delta)
    return fractions.reduce((sum, value) => sum + value, 0) / fractions.length
  }
  const stripShare = paint.fresh ? accentShare(paint.strip, paint.fresh[0], paint.accent) : null
  const barShare = paint.fresh ? accentShare(paint.bar, paint.fresh[1], paint.accent) : null
  check(
    '播放详情页：标题栏与播放栏画的是「实测到的背景亮度 + 当前封面的色相」（不是纯采样，也不是纯主题色）',
    paint.night === 'on' &&
      Array.isArray(paint.fresh) &&
      paint.fresh.length === 2 &&
      stripShare !== null &&
      barShare !== null &&
      stripShare > 0.12 &&
      stripShare < 0.5 &&
      barShare > 0.12 &&
      barShare < 0.5 &&
      sameColour(paint.strip, mixHex(paint.fresh[0], paint.accent, stripShare), 4),
    JSON.stringify({
      strip: paint.strip,
      bar: paint.bar,
      fresh: paint.fresh,
      accent: paint.accent,
      stripShare,
      barShare,
    }),
  )

  // Leaving the page must hand the strip back to the theme: a night strip that stuck would leave the
  // whole app dark after one visit to the lyrics page.
  await evaluate(ws, "location.hash = '#/'; 'ok'", 35)
  await waitFor(ws, '.player-bar')
  const afterNight = await evaluate(
    ws,
    `JSON.stringify({
       night: document.documentElement.dataset.night,
       strip: document.documentElement.style.getPropertyValue('--titlebar-bg').trim(),
     })`,
    36,
  )
  const shellAfter = (() => {
    try {
      return JSON.parse(afterNight?.value ?? '{}')
    } catch {
      return {}
    }
  })()
  check(
    '离开播放详情页后标题栏交还给主题（夜色不会残留）',
    shellAfter.night === '' && shellAfter.strip !== paint.strip && /^#[0-9a-f]{6}$/i.test(String(shellAfter.strip)),
    JSON.stringify(shellAfter),
  )

  await evaluate(ws, "location.hash = '#/settings/sources'; 'ok'", 32)
  await waitFor(ws, '.paste-block textarea')
  const installUi = await evaluate(
    ws,
    "[...document.querySelectorAll('.settings-section h3')].map((h) => h.textContent.trim()).join('|')",
    33,
  )
  check(
    '音源管理页出现「安装音源 / JS 音源 / API 音源」三个分区',
    typeof installUi?.value === 'string' && installUi.value.includes('安装音源') && installUi.value.includes('JS 音源') && installUi.value.includes('API 音源'),
    installUi?.value,
  )

  // ------------------------------------------------------------------ real playback, real script source
  //
  // The strongest assertion in this file: install a JavaScript source through the real UI channel,
  // search with it, click play, and watch the player's own clock advance. That covers
  // script → runtime → search → getPlayUrl → host check → media relay → <audio> decoding, with no
  // mocks anywhere.
  const source = await startSourceServer()
  // Now that the fixture has a real origin, the declarative half of the same story can be checked:
  // install a manifest, search it, resolve it, read bytes from the relay, remove it.
  await checkCustomSourceE2E()
  /*
   * The source declares the same four quality tokens the real platforms declare, and it **echoes the token it
   * was asked for** into the URL it returns.
   *
   * That echo is what turns "the preference is respected" into something this suite can prove from the
   * outside: the fixture's HTTP server sees `?q=flac24bit` or `?q=128k` on the media request, so the token
   * chosen in the renderer is observable in the bytes the source was actually asked for — not inferred from
   * a UI label.
   */
  const scriptText = `
    globalThis.defineAuroraSource({
      name: '打包 E2E 音源',
      version: '1.0.0',
      platforms: [{ id: 'packaged', name: '打包测试平台' }],
      async search(keyword, page, api) {
        const body = await api.request.json('${source.origin}/search?kw=' + encodeURIComponent(keyword))
        return body.data.list
      },
      async getPlayUrl(track, quality) {
        const token = quality || '320k'
        /*
         * A nonce per resolve, because a real stream URL carries a short-lived signature — and because it is
         * what keeps the media element from answering a second play of the same tier out of its own cache,
         * which would leave the server-side record empty for a resolve that did happen.
         */
        return { url: '${source.origin}/audio.wav?q=' + encodeURIComponent(token) + '&n=' + Date.now(), quality: token }
      },
      async getLyric() { return '[00:00.50]打包内歌词行' },
    })
  `

  // Installed through the **UI flow** (paste → 识别内容 → grant host → 确认安装), not by calling IPC
  // directly: that is what a user does, and it is what refreshes the renderer's source store.
  await evaluate(ws, "location.hash = '#/settings/sources'; 'ok'", 34)
  await waitFor(ws, '.paste-block textarea')
  await delay(900)
  const pasted = await evaluate(
    ws,
    `(() => {
       const box = document.querySelector('.paste-block textarea')
       if (!box) return 'no-textarea'
       box.value = ${JSON.stringify(scriptText)}
       box.dispatchEvent(new Event('input', { bubbles: true }))
       const detect = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('识别内容'))
       if (!detect) return 'no-detect-button'
       detect.click()
       return 'submitted'
     })()`,
    45,
  )
  check('安装 UI：粘贴脚本并点「识别内容」', pasted?.value === 'submitted', pasted?.value)
  await delay(2500)

  // Diagnostics on purpose: if the detection result never renders, the interesting facts are what
  // the textarea held, whether the button was disabled, and what the page told the user.
  const detectedUi = await evaluate(
    ws,
    `(() => JSON.stringify({
       kind: document.querySelector('.import-result')?.className ?? '',
       summary: document.querySelector('.import-result strong')?.textContent ?? '',
       chips: [...document.querySelectorAll('.host-grants .host-chip')].map((n) => n.textContent.trim()),
       textareaLength: (document.querySelector('.paste-block textarea')?.value ?? '').length,
       detectDisabled: [...document.querySelectorAll('button')].find((b) => b.textContent.includes('识别内容'))?.disabled ?? null,
       toasts: [...document.querySelectorAll('.toast')].map((n) => n.textContent.trim()),
     }))()`,
    46,
  )
  check(
    '安装 UI：展示识别结果（脚本 + 预勾选的建议主机）',
    (() => {
      try {
        const parsed = JSON.parse(detectedUi?.value ?? '{}')
        return parsed.kind.includes('script') && parsed.chips.some((chip) => chip.includes('127.0.0.1'))
      } catch {
        return false
      }
    })(),
    detectedUi?.value,
  )

  // Installing runs the script twice in a sandbox (probe + save) and has to build a renderer for
  // the hidden host, which is slow in a packaged app. Click, then poll from *here* — a single
  // Runtime.evaluate cannot outlive the harness timeout, so the loop must live outside the page.
  const clicked = await evaluate(
    ws,
    `(() => {
       const buttons = [...document.querySelectorAll('.import-result button')]
       const confirm = buttons.find((b) => b.textContent.includes('确认安装'))
       if (!confirm) return 'no-confirm-button|' + JSON.stringify(buttons.map((b) => b.textContent.trim()))
       if (confirm.disabled) return 'confirm-disabled|' + JSON.stringify(buttons.map((b) => b.textContent.trim() + ':' + b.disabled))
       confirm.click()
       return 'clicked'
     })()`,
    48,
  )

  let installedScript = null
  const installStartedAt = Date.now()
  // Installing runs the script twice in a sandbox and rebuilds the host, so poll rather than guess
  // — from here, not inside the page: one Runtime.evaluate cannot outlive the harness timeout.
  for (let attempt = 0; attempt < 40 && !installedScript; attempt += 1) {
    await delay(500)
    const list = await evaluate(
      ws,
      `window.aurora.sources.list().then((l) => JSON.stringify(l.filter((s) => s.kind === 'script').map((s) => ({ id: s.id, name: s.name, runtime: s.runtime, status: s.status }))))`,
      49,
    )
    try {
      installedScript = (JSON.parse(list?.value ?? '[]') ?? []).find((s) => s.name.includes('打包')) ?? null
    } catch {
      installedScript = null
    }
  }
  const installErrors = await evaluate(
    ws,
    "JSON.stringify({ errors: document.querySelector('.import-errors')?.textContent?.trim() ?? '', toasts: [...document.querySelectorAll('[class*=toast]')].map((n) => n.textContent.trim()).join(' / '), panel: document.querySelector('.import-result') ? 'open' : 'gone' })",
    50,
  )
  check(
    '打包产物内安装 JS 音源（经 UI 侦测 → 授权主机 → 确认安装）',
    Boolean(installedScript) && installedScript.runtime === 'aurora',
    `${clicked?.value} 用时${Date.now() - installStartedAt}ms / ${installedScript ? JSON.stringify(installedScript) : installErrors?.value}`,
  )

  const sourceId = installedScript?.id ?? ''

  // With one real script source installed, the manager page must show its panel, its kind and its
  // declared permissions — these are the assertions that cannot be made on an empty profile.
  await evaluate(ws, "location.hash = '#/settings/sources'; 'ok'", 59)
  await waitFor(ws, '.paste-block textarea')
  const installedPanel = await evaluate(
    ws,
    `(async () => {
       const list = await window.aurora.sources.list()
       return JSON.stringify({
         sources: list.length,
         panels: document.querySelectorAll('.source-panel').length,
         kindChips: [...document.querySelectorAll('.source-panel .kind-chip')].map((n) => n.textContent.trim()),
         permChips: document.querySelectorAll('.source-panel .perm-chip').length,
       })
     })()`,
    58,
  )
  const installedState = (() => {
    try {
      return JSON.parse(installedPanel?.value ?? '{}')
    } catch {
      return {}
    }
  })()
  check(
    '音源管理页展示已安装脚本音源的面板 / 种类 / 权限',
    installedState.sources >= 1 &&
      installedState.panels === installedState.sources &&
      installedState.kindChips.length === installedState.panels &&
      installedState.permChips >= 1,
    JSON.stringify(installedState),
  )

  /*
   * 每个音源一个管理页：从列表点「管理」进去，页面拿的必须是**这个音源**的数据，自检必须是真跑。
   * 打包产物上验两件事——入口真的可点，以及报告真的来自这个音源（不是列表页的残留状态）。
   */
  const openedDetail = await evaluate(
    ws,
    `(() => {
       const link = [...document.querySelectorAll('.source-panel')]
         .map((panel) => panel.querySelector('a.ghost-button'))
         .find((anchor) => anchor && String(anchor.getAttribute('href') ?? '').includes(${JSON.stringify(sourceId)}))
       if (!link) return 'no-link'
       link.click()
       return 'clicked'
     })()`,
    61,
  )
  /*
   * Wait for something only *this* page has. `.settings-section .primary-button` used to be the
   * marker and it exists on the list page too — so the wait returned instantly, the snapshot below
   * was taken before the lazy route chunk rendered, and the check failed while the app was fine.
   */
  await waitFor(ws, '.source-detail')
  const detailPage = await evaluate(
    ws,
    `JSON.stringify({
       hash: location.hash,
       id: [...document.querySelectorAll('.source-identity .kind-chip')].map((n) => n.textContent.trim()),
       sections: document.querySelectorAll('.settings-section').length,
       headings: [...document.querySelectorAll('.settings-section h3')].map((n) => n.textContent.trim()),
     })`,
    62,
  )
  const detailState = (() => {
    try {
      return JSON.parse(detailPage?.value ?? '{}')
    } catch {
      return {}
    }
  })()
  check(
    '单音源管理页：从列表点「管理」进入，页面就是这个音源（自检 / 授权 / 错误历史分区）',
    openedDetail?.value === 'clicked' &&
      String(detailState.hash).includes(`/settings/sources/${sourceId}`) &&
      (detailState.id ?? []).includes(sourceId) &&
      detailState.sections >= 3,
    `${openedDetail?.value} ${detailPage?.value}`,
  )

  const startedCheck = await evaluate(
    ws,
    `(() => {
       const button = [...document.querySelectorAll('.settings-section button')].find((node) => node.textContent.trim() === '运行自检')
       if (!button) return 'no-button'
       button.click()
       return 'clicked'
     })()`,
    63,
  )
  for (let waited = 0; waited < 20000; waited += 500) {
    const done = await evaluate(ws, "Boolean(document.querySelector('.check-result'))", 64)
    if (done?.value === true) break
    await delay(500)
  }
  const checkReport = await evaluate(
    ws,
    `JSON.stringify({
       summary: document.querySelector('.check-summary strong')?.textContent?.trim() ?? '',
       steps: [...document.querySelectorAll('.check-step')].map((node) => ({
         label: node.querySelector('.step-label')?.textContent?.trim() ?? '',
         message: node.querySelector('.step-message')?.textContent?.trim() ?? '',
         bad: node.classList.contains('bad'),
         skipped: node.classList.contains('skipped'),
       })),
       hostsSection: [...document.querySelectorAll('.settings-section h3')].some((n) => n.textContent.includes('授权')),
     })`,
    65,
  )
  const reportState = (() => {
    try {
      return JSON.parse(checkReport?.value ?? '{}')
    } catch {
      return { steps: [] }
    }
  })()
  const stepLabels = (reportState.steps ?? []).map((step) => step.label)
  check(
    '单音源管理页：自检真的执行并逐步报告（搜索与取地址都在报告里，每步都有结论）',
    startedCheck?.value === 'clicked' &&
      reportState.summary !== '' &&
      stepLabels.includes('搜索') &&
      stepLabels.includes('取播放地址') &&
      (reportState.steps ?? []).every((step) => step.message !== ''),
    `${startedCheck?.value} ${checkReport?.value}`,
  )
  check(
    '单音源管理页：自检报告与页面分区一致（有授权区，报告里的步骤不是占位符）',
    reportState.hostsSection === true && (reportState.steps ?? []).length >= 6,
    `hosts:${reportState.hostsSection} steps:${(reportState.steps ?? []).length}`,
  )

  /*
   * 「自检并自动修复」 must be the real repair path, not the same check behind a louder label.
   *
   * By now the source is already granted, so a repair run would have nothing to repair and both
   * buttons would look identical. So: take the grant away through the page's own 撤销 button (which
   * also proves the page re-reads its state instead of keeping the old card), then press
   * 自检并自动修复 and require the host to come back — with the reason spelled out in the report.
   */
  const registryBefore = await evaluate(
    ws,
    `window.aurora.sources.list().then((list) => JSON.stringify(list.map((item) => ({
       id: item.id,
       name: item.name,
       status: item.status,
       enabled: item.enabled,
       perms: item.permissions,
       hosts: item.allowedHosts,
     }))))`,
    67,
  )
  const hostRowsBefore = await evaluate(ws, "document.querySelectorAll('.source-detail .host-row').length", 74)
  const revokedHost = await evaluate(
    ws,
    `(() => {
       const row = document.querySelector('.source-detail .host-row')
       if (!row) return 'no-host-row'
       const host = row.querySelector('.host-chip')?.textContent?.trim() ?? ''
       const button = row.querySelector('button')
       if (!button) return 'no-revoke-button'
       button.click()
       return host
     })()`,
    68,
  )
  /*
   * The host list is per source and can be long (one real profile had 24 hosts), so "the row count
   * dropped by one and that chip is gone" is the honest claim — not "the list is empty".
   */
  const revokedHostName = String(revokedHost?.value ?? '')
  await delay(900)
  const afterRevoke = await evaluate(
    ws,
    `JSON.stringify({
       rows: document.querySelectorAll('.source-detail .host-row').length,
       chipGone: ![...document.querySelectorAll('.source-detail .host-chip')].map((node) => node.textContent.trim()).includes(${JSON.stringify(revokedHost?.value ?? '')}),
     })`,
    69,
  )
  const hostsAfterRevoke = await evaluate(
    ws,
    `window.aurora.sources.list().then((list) => JSON.stringify(list
       .find((item) => item.id === ${JSON.stringify(sourceId)})?.allowedHosts ?? []))`,
    75,
  )
  const summaryBeforeRepair = await evaluate(
    ws,
    "document.querySelector('.source-detail .check-summary')?.textContent?.trim() ?? ''",
    76,
  )
  const repairClicked = await evaluate(
    ws,
    `(() => {
       const button = [...document.querySelectorAll('.source-detail button')].find((node) => node.textContent.trim() === '自检并自动修复')
       if (!button) return 'no-button'
       button.click()
       return 'clicked'
     })()`,
    70,
  )
  /*
   * Wait for a **new** report: the page keeps showing the previous run's result until this one lands,
   * so "a report exists" is true immediately and would prove nothing.
   */
  let repairSummary = ''
  for (let waited = 0; waited < 30000; waited += 500) {
    const summary = await evaluate(
      ws,
      `(() => {
         const text = document.querySelector('.source-detail .check-summary')?.textContent?.trim() ?? ''
         return text !== '' && text !== ${JSON.stringify(summaryBeforeRepair?.value ?? '')} ? text : ''
       })()`,
      71,
    )
    if (typeof summary?.value === 'string' && summary.value !== '') {
      repairSummary = summary.value
      break
    }
    await delay(500)
  }
  const repairReport = await evaluate(
    ws,
    `JSON.stringify({
       steps: [...document.querySelectorAll('.source-detail .check-step')].map((node) => ({
         label: node.querySelector('.step-label')?.textContent?.trim() ?? '',
         message: node.querySelector('.step-message')?.textContent?.trim() ?? '',
       })),
     })`,
    77,
  )
  const hostsAfterRepair = await evaluate(
    ws,
    `window.aurora.sources.list().then((list) => JSON.stringify(list
       .find((item) => item.id === ${JSON.stringify(sourceId)})?.allowedHosts ?? []))`,
    72,
  )
  const registryAfter = await evaluate(
    ws,
    `window.aurora.sources.list().then((list) => JSON.stringify(list.map((item) => ({
       id: item.id,
       name: item.name,
       status: item.status,
       enabled: item.enabled,
       perms: item.permissions,
       hosts: item.allowedHosts,
     }))))`,
    73,
  )
  const retried = (() => {
    try {
      return (JSON.parse(repairReport?.value ?? '{}').steps ?? []).find((step) => String(step.message).includes('自动允许'))
    } catch {
      return undefined
    }
  })()
  check(
    '单音源管理页：撤销授权是真的撤销（列表少一行、芯片消失，库里也真的没有了）',
    revokedHostName !== '' &&
      revokedHostName !== 'no-host-row' &&
      revokedHostName !== 'no-revoke-button' &&
      afterRevoke?.value?.includes(`"rows":${Number(hostRowsBefore?.value) - 1}`) === true &&
      afterRevoke?.value?.includes('"chipGone":true') === true &&
      String(hostsAfterRevoke?.value ?? '').includes(revokedHostName) === false,
    `${revokedHostName} ${hostRowsBefore?.value}→${afterRevoke?.value} hosts:${hostsAfterRevoke?.value}`,
  )
  check(
    '单音源管理页：点「自检并自动修复」走的是修复路径（被拒主机重新允许，重试写进了那一步）',
    repairClicked?.value === 'clicked' &&
      repairSummary !== '' &&
      retried !== undefined &&
      String(retried.message).includes(revokedHostName) &&
      hostsAfterRepair?.value?.includes(revokedHostName) === true,
    `${repairClicked?.value} ${repairReport?.value}`,
  )
  /*
   * 独立性：整个登记表里只允许一处变化——我们操作的那个音源的授权列表。
   *
   * 这比“另一个音源的快照没变”更强：它同时拦住两件事——改一个音源顺手刷新了别人的状态，以及操作
   * 扩散到了同一个音源的其它字段（状态、开关、权限）。包装产物里只装了一个音源，所以“其它音源没变”
   * 那条本来会是一个空集上的假绿；这条不会。
   */
  const registryDiff = (() => {
    try {
      const before = JSON.parse(registryBefore?.value ?? '[]')
      const after = JSON.parse(registryAfter?.value ?? '[]')
      if (!Array.isArray(before) || before.length === 0 || before.length !== after.length) return null
      const changed = []
      for (let index = 0; index < before.length; index += 1) {
        const first = before[index]
        const second = after[index]
        if (!second || first.id !== second.id) return null
        if (first.hosts !== second.hosts) changed.push(`${first.id}:hosts`)
        if (
          first.name !== second.name ||
          first.status !== second.status ||
          first.enabled !== second.enabled ||
          // Arrays compared by value: `!==` on two parsed arrays is always true, which made this
          // check report `:other` for every source on every run.
          JSON.stringify(first.perms) !== JSON.stringify(second.perms)
        ) {
          changed.push(`${first.id}:other`)
        }
      }
      return changed
    } catch {
      return null
    }
  })()
  check(
    '单音源管理页：登记表里只有这一个音源的授权列表变了（其它音源、其它字段一位没动）',
    Array.isArray(registryDiff) &&
      registryDiff.length === 1 &&
      registryDiff[0] === `${sourceId}:hosts` &&
      hostsAfterRevoke?.value !== hostsAfterRepair?.value,
    `${registryBefore?.value} → ${registryAfter?.value} diff:${JSON.stringify(registryDiff)}`,
  )

  await evaluate(ws, "location.hash = '#/settings/sources'; 'ok'", 66)
  await waitFor(ws, '.paste-block textarea')

  /*
   * 全量自检 with a real source installed.
   *
   * Deliberately placed **after** the single-source block above: this one navigates to the list page, and
   * skipping back and forth used to leave that block reading a page it was no longer on (its 撤销 button
   * and host rows simply were not in the DOM, which looked like three unrelated failures). The row count is
   * compared against the app's own answer for the enabled set, not a number chosen here.
   */
  const batchWithSources = await evaluate(
    ws,
    `(async () => {
       const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
       document.querySelector('[data-check-all-run]')?.click()
       for (let attempt = 0; attempt < 150; attempt += 1) {
         const panel = document.querySelector('[data-check-all-panel]')
         if (panel && panel.querySelectorAll('.check-all-row').length > 0) break
         await delay(200)
       }
       const panel = document.querySelector('[data-check-all-panel]')
       const settings = await window.aurora.settings.get()
       const installed = await window.aurora.scriptSources.list()
       const enabled = installed.filter((item) => settings.enabledSources[item.id] !== false).length
       return JSON.stringify({
         panel: Boolean(panel),
         headline: panel?.querySelector('.check-all-head strong')?.textContent?.trim() ?? '',
         rows: [...(panel?.querySelectorAll('.check-all-row') ?? [])].map((node) => ({
           verdict: node.querySelector('.check-verdict')?.textContent?.trim() ?? '',
           name: node.querySelector('.check-why strong')?.textContent?.trim() ?? '',
           detail: node.querySelector('.check-why .small-text')?.textContent?.trim() ?? '',
         })),
         enabled,
       })
     })()`,
    659,
    60000,
  )
  const batchState = (() => {
    try {
      return JSON.parse(batchWithSources?.value ?? '{}')
    } catch {
      return { rows: [] }
    }
  })()
  const batchRows = batchState.rows ?? []
  check(
    '全量自检：每个已启用音源都有一行，且每行都带一个结论与一句原因',
    batchState.panel === true &&
      batchRows.length === batchState.enabled &&
      batchRows.length > 0 &&
      batchRows.every((row) => row.verdict !== '' && row.detail !== ''),
    { enabled: batchState.enabled, rows: batchRows, headline: batchState.headline },
  )
  check(
    '全量自检：汇总句里的数字与行一致（不是另写的一句话）',
    batchRows.length > 0 && batchState.headline.includes('个已启用音源'),
    { headline: batchState.headline, verdicts: batchRows.map((row) => row.verdict) },
  )

  // The IPC path first, so a failure here points at the source rather than the DOM.
  const directSearch = await evaluate(
    ws,
    `window.aurora.sources.searchOne(${JSON.stringify(sourceId)}, '打包测试', {}).then((r) => JSON.stringify({ ok: r.ok, tracks: r.tracks.length, error: r.error ?? null }))`,
    43,
  )
  check(
    '打包产物内 JS 音源的搜索真实执行（经 Runtime → 桥 → 本地 HTTP）',
    (() => {
      try {
        const parsed = JSON.parse(directSearch?.value ?? '{}')
        return parsed.ok === true && parsed.tracks === 1
      } catch {
        return false
      }
    })(),
    directSearch?.value,
  )

  await evaluate(ws, "location.hash = '#/search'; 'ok'", 35)
  await waitFor(ws, '.hero-search input')
  await delay(900)
  const typed = await evaluate(
    ws,
    `(() => {
       // The online page's own box is .hero-search; the global TopBar box is not rendered on this
       // route at all, and typing into the wrong element would silently search nothing.
       // (Backticks are avoided here on purpose: this whole block is a template literal.)
       const input = document.querySelector('.hero-search input')
       if (!input) return 'no-input'
       input.value = '打包测试'
       input.dispatchEvent(new Event('input', { bubbles: true }))
       // Enter forces the search immediately instead of waiting out the debounce.
       input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }))
       return 'typed:' + input.value
     })()`,
    36,
  )
  check('搜索页可以输入关键词（真实 input 事件）', typed?.value === 'typed:打包测试', typed?.value)

  /*
   * 等搜索真的结束，而不是睡固定 2.5s。
   *
   * 这次搜索会并发发到五个平台加本地音源，它花多久是网络说了算，不是一个常数。机器一忙，固定的 2.5s 就会在飞行中到期
   * （状态停在“正在搜索…”），于是下面的行数读到 0、而接下来每一条需要结果行的检查都跟着红 —— 一个慢请求看起来就像十几个
   * 功能同时坏了。有上限的轮询拿掉这个连锁，同时不掩盖真的卡死：20s 还没安静下来，这条依然红，而理由就是“还在搜”。
   */
  for (let waited = 0; waited < 20000; waited += 500) {
    const busy = await evaluate(
      ws,
      "document.querySelector('.search-status')?.textContent?.includes('正在搜索') ?? false",
      38,
    )
    if (busy?.value !== true) break
    await delay(500)
  }

  const found = await evaluate(
    ws,
    `(() => JSON.stringify({
       status: document.querySelector('.search-status')?.textContent?.replace(/\\s+/g, ' ').trim() ?? '',
       tabs: [...document.querySelectorAll('.source-tabs .chip')].map((chip) => chip.textContent.trim()),
       rows: [...document.querySelectorAll('.track-row')].filter((row) => row.textContent.includes('打包内测试歌曲')).length,
       anywhere: document.body.textContent.includes('打包内测试歌曲'),
       allRows: document.querySelectorAll('.track-row').length,
       toasts: [...document.querySelectorAll('[class*=toast]')].map((node) => node.textContent.trim()),
     }))()`,
    37,
  )
  check(
    '打包产物内用 JS 音源真实搜索到结果',
    (() => {
      try {
        return JSON.parse(found?.value ?? '{}').rows >= 1
      } catch {
        return false
      }
    })(),
    found?.value,
  )

  /*
   * 搜索框里只应有一个叉号。
   *
   * `type="search"` 会让 Chromium 自带一个清除按钮，而 Aurora 自己也有一个（带标题、走 store 的
   * 重置流程）——两个并于排出现在输入框右侧，看起来就像同一件事被做了两遍。这里读的是**输入框已有
   * 文字时**的实际 DOM，并且顺带确认样式表里确实带着隐藏原生按钮的那条规则（它一旦被压缩/覆盖掉，
   * DOM 数量断言仍然会过，用户却会重新看到两个叉）。
   */
  const clearAffordance = await evaluate(
    ws,
    `(() => {
       const buttons = [...document.querySelectorAll('.hero-search button')].map((button) => button.textContent.trim())
       const hasRule = [...document.styleSheets].some((sheet) => {
         try {
           return [...sheet.cssRules].some((rule) => rule.cssText.includes('search-cancel-button'))
         } catch {
           return false
         }
       })
       return JSON.stringify({ buttons, hasRule })
     })()`,
    93,
  )
  const clearState = (() => {
    try {
      return JSON.parse(clearAffordance?.value ?? '{}')
    } catch {
      return { buttons: [] }
    }
  })()
  check(
    '在线音乐搜索框只有一个清除按钮（原生 ✕ 已被样式表隐去）',
    JSON.stringify(clearState.buttons) === JSON.stringify(['✕']) && clearState.hasRule === true,
    JSON.stringify(clearState),
  )

  /*
   * Row badges, split the way the UI splits them:
   *
   *  - a *platform* badge is the single alias glyph plus that service's colour, and must never be a
   *    raw id (`kw` / `wy` / …) — that is what the row looked like before the aliases existed;
   *  - a *user source* badge keeps the source's own name, because Aurora has no business renaming a
   *    plugin the user installed. It is only asserted to not be a raw platform id.
   */
  const badges = await evaluate(
    ws,
    `(() => {
       const all = [...document.querySelectorAll('.track-row .badge-source')]
       const platform = [...document.querySelectorAll('.track-row .badge-source.badge-platform')]
       return JSON.stringify({
         platformText: platform.map((node) => node.textContent.trim()),
         sourceText: all.filter((node) => !node.classList.contains('badge-platform')).map((node) => node.textContent.trim()),
         tinted: platform.map((node) => getComputedStyle(node).getPropertyValue('--badge-accent').trim()),
       })
     })()`,
    39,
  )
  const badgeData = (() => {
    try {
      return JSON.parse(badges?.value ?? '{}')
    } catch {
      return { platformText: [], sourceText: [], tinted: [] }
    }
  })()
  const rawIds = ['kw', 'wy', 'tx', 'kg', 'mg']
  check(
    '歌曲行平台徽章为单字代号',
    (badgeData.platformText ?? []).length > 0 &&
      (badgeData.platformText ?? []).every((text) => text.length === 1),
    JSON.stringify(badgeData.platformText),
  )
  check(
    '歌曲行不再显示原始平台 id',
    ![...(badgeData.platformText ?? []), ...(badgeData.sourceText ?? [])].some((text) => rawIds.includes(text)),
    JSON.stringify([...(badgeData.platformText ?? []), ...(badgeData.sourceText ?? [])]),
  )
  check('自装音源仍显示自己的名字', (badgeData.sourceText ?? []).length > 0, JSON.stringify(badgeData.sourceText))
  check('平台徽章带代表色（--badge-accent 已注入）', (badgeData.tinted ?? []).length > 0, JSON.stringify(badgeData.tinted))


  /*
   * Click play on **this** row, not on the first one on the page.
   *
   * The search page aggregates every source, and the platform sources (酷我 / 网易云 / …) are listed
   * before user sources — a platform row has no playable URL without a user source that resolves it,
   * so "the first 播放 button" silently stops testing playback the moment platform search exists.
   * Targeting the row by its title is what the assertion actually means.
   */
  const playClicked = await evaluate(
    ws,
    `(() => {
       const rows = [...document.querySelectorAll('.track-row')]
       const row = rows.find((item) => item.textContent.includes('打包内测试歌曲'))
       const button = row ? row.querySelector('.icon-action[title="播放"]') : null
       button?.click()
       return JSON.stringify({ row: Boolean(row), button: Boolean(button), rows: rows.length })
     })()`,
    38,
  )
  /*
   * 播放前先把曲目拖回开头并确认时钟真的在走。
   *
   * 夹具只有三秒，而这套用例在此之前已经做了很多事——直接等 2.6 秒再量，量到的可能是“已经播完”
   * 而不是“正在播”：`ensurePlaying` 是为此写的（它用真实的 range 输入 seek，并验证进度真的变化）。
   * 随后只等 1.4 秒，让时钟落在 0:01–0:02 之间，仍在曲内。
   */
  const playbackPrimed = await ensurePlaying(ws, 94)
  await delay(1400)

  const playback = await evaluate(
    ws,
    `(() => {
       const clock = document.querySelector('.progress-line span')?.textContent?.trim() ?? ''
       const bar = document.querySelector('.player-bar')?.textContent ?? ''
       const rows = [...document.querySelectorAll('.track-row')]
       const activeRow = rows.find((row) => row.classList.contains('active'))
       return JSON.stringify({
         clock,
         showsTrack: bar.includes('打包内测试歌曲'),
         active: !!activeRow,
         playing: !!activeRow?.querySelector('.playing-bars'),
       })
     })()`,
    39,
  )
  let playbackState = {}
  try {
    playbackState = JSON.parse(playback?.value ?? '{}')
  } catch {
    playbackState = { raw: playback?.value }
  }
  check(
    'Actual Playback: 播放器时钟真的在走（音频经中继后被 <audio> 解码播放）',
    playbackState.active === true && playbackState.clock !== '0:00' && /^0:0[1-9]/.test(String(playbackState.clock)),
    JSON.stringify({ ...playbackState, click: playClicked?.value, primed: playbackPrimed }),
  )
  check('Actual Playback: 播放栏显示这首脚本音源的曲目', playbackState.showsTrack === true, playbackState.showsTrack)

  /*
   * 空闲分辨率：正在播放时必须回到满档。
   *
   * 降分辨率只在“没人看/没在放”时成立，而这条断言是它的另一半：一旦真的在出声，画布必须立刻用回档位原本
   * 的像素比，否则这个优化就是永久降质。暂停那一半由 `check:idle` 断言（它能把窗口状态摆成暂停）。
   */
  /*
   * 空闲分辨率与当前状态一致。
   *
   * 写的是**不变量**，而不是「此刻必须是 1」：这个位置能不能真的处在播放中，取决于夹具的三秒曲子有没有
   * 恰好还在放（这一节前面那条声音检查就报过 `playing:false` 而时钟仍在走——已知的环境依赖）。不一致的
   * 断言会时而红时而绿，而红的那次会让人去怀疑一个没坏的东西。
   *
   * “播放且前台 → 满档”那条策略本身由 `smoke:visual` 直接比对返回值，不依赖任何机器状态。
   */
  const playingScale = await evaluate(
    ws,
    `(() => {
       const root = document.documentElement
       return JSON.stringify({
         scale: Number(root.dataset.fxScale || 1),
         playing: root.dataset.playing === 'true',
         focus: root.dataset.fxFocus || '',
       })
     })()`,
    658,
  )
  const scaleState = (() => {
    try {
      return JSON.parse(playingScale?.value ?? '{}')
    } catch {
      return {}
    }
  })()
  const expectedScale = scaleState.playing && scaleState.focus === 'active' ? 1 : 0.7
  check(
    '空闲分辨率: 与当前播放/焦点状态一致（播放且前台满档，其余降到 0.7）',
    Math.abs(Number(scaleState.scale) - expectedScale) < 1e-6,
    JSON.stringify({ ...scaleState, expected: expectedScale }),
  )

  const lyricInApp = await evaluate(
    ws,
    `(async () => {
       const list = await window.aurora.sources.searchAll('打包测试', {})
       const row = list.find((item) => item.sourceId === ${JSON.stringify(sourceId)})
       if (!row || !row.tracks[0]) return 'no-track'
       const lyrics = await window.aurora.lyrics.get({ ...row.tracks[0], sourceId: ${JSON.stringify(sourceId)} })
       return lyrics && lyrics.lines.length > 0 ? 'lines:' + lyrics.lines.length + ':' + lyrics.lines[0].text : 'no-lyrics'
     })()`,
    40,
  )
  check(
    '打包产物内脚本音源的歌词真的能取到',
    typeof lyricInApp?.value === 'string' && lyricInApp.value.startsWith('lines:'),
    lyricInApp?.value,
  )

  /* ---------------------------------------------------------------- downloads
   *
   * The strongest available evidence: click the row's download button in the packaged UI, then
   * `stat()` the resulting file *from this process* against the throwaway profile the app was
   * launched with. Nothing about the transfer is inferred from the UI's own report.
   */
  const downloadClicked = await evaluate(
    ws,
    `(() => {
       const rows = [...document.querySelectorAll('.track-row')]
       const row = rows.find((r) => r.textContent.includes('打包内测试歌曲'))
       const button = row ? [...row.querySelectorAll('.icon-action')].find((b) => b.getAttribute('title') === '下载') : null
       button?.click()
       // The titles are part of the detail on purpose: "no-row" is useless without knowing whether the
       // list was empty, on another page, or simply missing this one entry.
       const titles = rows.slice(0, 5).map((item) => item.textContent.replace(/\\s+/g, ' ').trim().slice(0, 24))
       return JSON.stringify({
         result: button ? 'clicked' : row ? 'no-button' : 'no-row',
         rows: rows.length,
         hash: location.hash,
         titles,
       })
     })()`,
    41,
  )
  const downloadState = (() => {
    try {
      return JSON.parse(downloadClicked?.value ?? '{}')
    } catch {
      return { raw: downloadClicked?.value }
    }
  })()
  check('下载: 歌曲行上出现下载按钮（音源声明了 download 能力）', downloadState.result === 'clicked', JSON.stringify(downloadState))

  let downloadTasks = []
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const raw = await evaluate(
      ws,
      "window.aurora.downloads.list().then((tasks) => JSON.stringify(tasks.map((t) => ({ status: t.status, received: t.received, total: t.total, speed: t.speed, fileName: t.fileName, filePath: t.filePath, error: t.error ?? '' }))))",
      600 + attempt,
      8000,
    ).catch(() => null)
    try {
      downloadTasks = JSON.parse(raw?.value ?? '[]')
    } catch {
      downloadTasks = []
    }
    const first = downloadTasks[0]
    if (first && (first.status === 'completed' || first.status === 'failed')) break
    await delay(500)
  }
  const downloadTask = downloadTasks[0] ?? {}
  check(
    '下载: 任务真的完成（状态来自下载管理器）',
    downloadTask.status === 'completed',
    `${downloadTask.status} ${downloadTask.error}`.trim(),
  )
  check(
    '下载: 字节数与服务器返回的一致（下载量不是估算的）',
    Number(downloadTask.received) > 20000 && downloadTask.received === downloadTask.total,
    `${downloadTask.received}/${downloadTask.total}`,
  )
  const downloadedPath = downloadTask.fileName ? join(profileDir, 'downloads', downloadTask.fileName) : ''
  let downloadedBytes = -1
  try {
    downloadedBytes = (await stat(downloadedPath)).size
  } catch {
    downloadedBytes = -1
  }
  check(
    '下载: 磁盘上真的出现了这个文件（测试进程直接 stat 用户数据目录）',
    downloadedBytes === Number(downloadTask.received) && downloadedBytes > 0,
    `${downloadedPath} → ${downloadedBytes} 字节`,
  )
  check(
    '下载: 没有留下 .part 临时文件',
    await stat(`${downloadedPath}.part`).then(() => false).catch(() => true),
  )

  /* ------------------------------------------------- 本地音乐页看板 + 下载后自动同步
   *
   * The download above was imported into the local library by the main process, so the local page
   * now has content — which is exactly when its dashboard is supposed to appear. Navigating there
   * with no manual refresh also proves the `library:changed` push reached the renderer.
   */
  await evaluate(ws, "location.hash = '#/'; 'ok'", 53)
  await waitFor(ws, '.library-tabs')
  const localDashboard = await evaluate(
    ws,
    `(() => JSON.stringify({
       tabs: [...document.querySelectorAll('.library-tabs .chip')].map((chip) => chip.textContent.trim()),
       stats: document.querySelectorAll('.stat-grid .stat-card').length,
       smart: [...document.querySelectorAll('.smart-card header strong')].map((n) => n.textContent.trim()),
       heading: document.querySelector('.welcome-row h1')?.textContent?.trim() ?? '',
       rows: document.querySelectorAll('.track-row').length,
     }))()`,
    54,
  )
  const dashboard = (() => {
    try {
      return JSON.parse(localDashboard?.value ?? '{}')
    } catch {
      return {}
    }
  })()
  check('下载完成后本地音乐页自动同步到新文件（无需手动刷新）', Number(dashboard.rows) >= 1, dashboard.rows)
  check('本地音乐页提供单曲/歌手/专辑/文件夹四维 Tab', dashboard.tabs.length === 4, JSON.stringify(dashboard.tabs))
  check('本地音乐页统计为四宫格', dashboard.stats === 4, dashboard.stats)
  check(
    '本地音乐页渲染智能动态歌单（遗忘金曲 + Hi-Res 专区）',
    dashboard.smart.includes('遗忘金曲') && dashboard.smart.some((name) => name.includes('Hi-Res')),
    JSON.stringify(dashboard.smart),
  )

  /*
   * Library-page actions, and only those.
   *
   * The header of 全量曲库 keeps the three actions that are about the library itself (添加歌曲 /
   * 扫描文件夹 / 刷新); 「自动补齐信息」 and the ffmpeg check deliberately moved to 设置 → 曲库工具,
   * because they describe how Aurora *processes* files and were competing with the list for attention.
   * Asserting both halves (“present here” and “gone from here”) is what keeps the move from silently
   * regressing into a page that has neither.
   */
  const libraryActions = await evaluate(
    ws,
    "[...document.querySelectorAll('.section-actions button')].map((b) => b.textContent.trim())",
    55,
  )
  const actions = Array.isArray(libraryActions?.value) ? libraryActions.value : []
  check(
    '本地音乐页只保留曲库动作（添加歌曲 / 扫描文件夹 / 刷新）',
    ['添加歌曲', '扫描文件夹', '刷新'].every((label) => actions.some((text) => text.includes(label))) &&
      !actions.some((text) => text.includes('自动补齐') || text.includes('ffmpeg')),
    JSON.stringify(actions),
  )

  /*
   * 歌曲切换 → 主题转场，以及音量变化 → 轻微视觉反馈。
   *
   * **Placed at the very end of the suite on purpose.** Switching the current song is exactly the point of
   * the check, and starting a different track changes what every later playback assertion is looking at —
   * this block used to sit in the middle and made the immersive-page checks run against a file with no
   * cover and no lyrics (four real-looking failures that were only an ordering mistake of mine).
   *
   * Both cues are *moments*, not states, so both are driven through the real UI — a double-click on a
   * library row (how a user starts a song) and an `input` event on the volume slider — and then read back off
   * the document root. Nothing here writes the attributes it asserts on.
   */
  /*
   * The two "music drives the picture" moments are asserted at the **end** of the suite: see the note on
   * `switchProbe` in the final phase — starting a different song changes what later checks are looking at.
   */

  // …and the same two tools are reachable in 设置, wired to the real passes (exercised end to end by
  // `npm run smoke:sources` and by the main-process handlers).
  // Navigates the way the rest of this suite navigates a hash route (see the downloads page below),
  // then comes straight back — the checks after this one assert on `.track-row`.
  await evaluate(ws, "location.hash = '#/settings'; 'ok'", 53)
  await waitFor(ws, '.settings-section')
  await delay(500)
  const settingsTools = await evaluate(
    ws,
    `(() => {
       const texts = [...document.querySelectorAll('.settings-section')].map((s) => s.textContent)
       return JSON.stringify({
         scrape: texts.some((t) => t.includes('自动补齐信息')),
         ffmpeg: texts.some((t) => t.includes('ffmpeg')),
       })
     })()`,
    54,
  )
  const tools = (() => {
    try {
      return JSON.parse(settingsTools?.value ?? '{}')
    } catch {
      return {}
    }
  })()
  check('设置页提供「自动补齐信息」与 ffmpeg 检测', tools.scrape === true && tools.ffmpeg === true, settingsTools?.value)
  await evaluate(ws, "location.hash = '#/'; 'ok'", 55)
  await waitFor(ws, '.track-row')
  await delay(400)

  // Right-clicking a local row must open the per-file menu (打开文件位置 / 格式转换 / 修改 ID3 标签).
  const rowMenu = await evaluate(
    ws,
    `(() => {
       const row = document.querySelector('.track-row')
       if (!row) return 'no-row'
       row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 160 }))
       return 'sent'
     })()`,
    56,
  )
  await delay(300)
  const menuItems = await evaluate(
    ws,
    "[...document.querySelectorAll('.context-menu .context-menu-item')].map((b) => b.textContent.trim())",
    57,
  )
  const menu = Array.isArray(menuItems?.value) ? menuItems.value : []
  check(
    '本地音乐页右键菜单包含打开文件位置 / 格式转换 / 修改 ID3 标签',
    rowMenu?.value === 'sent' && ['打开文件位置', '格式转换', '修改 ID3 标签'].every((label) => menu.includes(label)),
    // Both "the row was not found" and "the menu did not render" used to print as `[]`, which made a
    // failure here undiagnosable. The dispatch result says which of the two happened.
    JSON.stringify({ dispatch: rowMenu?.value, menu }),
  )

  // The page itself: it renders whatever the manager last reported, and its buttons act on the task.
  await evaluate(ws, "location.hash = '#/downloads'; 'ok'", 42)
  await waitFor(ws, '.download-row, .view-header h1')
  await delay(700)
  const downloadPage = await evaluate(
    ws,
    `(() => JSON.stringify({
       rows: document.querySelectorAll('.download-row').length,
       title: document.querySelector('.download-row strong')?.textContent?.trim() ?? '',
       status: document.querySelector('.download-status')?.textContent?.trim() ?? '',
       ratio: document.querySelector('.download-progress span')?.style.width ?? '',
       path: document.querySelector('.download-path')?.textContent?.trim() ?? '',
     }))()`,
    43,
  )
  let downloadPageState = {}
  try {
    downloadPageState = JSON.parse(downloadPage?.value ?? '{}')
  } catch {
    downloadPageState = { raw: downloadPage?.value }
  }
  check(
    '下载: 下载页渲染出这个任务与它的完成状态',
    downloadPageState.rows === 1 && String(downloadPageState.status).includes('已完成') && downloadPageState.title.includes('打包内测试歌曲'),
    downloadPageState,
  )
  check('下载: 进度条真的走到 100%（宽度来自真实字节）', downloadPageState.ratio === '100%', downloadPageState.ratio)

  /* ==================================================================== 音质四档（端到端）
   *
   * This is the part of the quality feature that cannot be checked offline: the preference lives in main,
   * the *decision* happens in the renderer, the token goes out through the source runtime, and the answer
   * comes back as the stream that playing. So the assertions walk the whole chain and end at the only place
   * that cannot be faked — the bytes the fixture's HTTP server was asked for (`?q=<token>`), recorded server
   * side, plus the badge that the *resolved* stream produced.
   */
  /*
   * The picker lives on the player bar's quality badge now, so these assertions drive *that* — including the
   * two behaviours a popover can silently get wrong: it opens, and it closes.
   */
  const openQualityPicker = async (id) => {
    await evaluate(ws, `document.querySelector('.quality-trigger')?.click(); 'ok'`, id)
    await waitFor(ws, '.quality-tiers')
    await delay(250)
  }

  await evaluate(ws, "location.hash = '#/settings'; 'ok'", 57)
  await delay(600)
  const settingsQuality = await evaluate(
    ws,
    `(() => JSON.stringify({
       cards: document.querySelectorAll('.quality-card').length,
       hint: [...document.querySelectorAll('.settings-section .muted')].map((n) => n.textContent.replace(/\\s+/g, ' ').trim()).find((text) => text.includes('音质偏好')) ?? '',
     }))()`,
    57,
  )
  const settingsQualityState = (() => {
    try {
      return JSON.parse(settingsQuality?.value ?? '{}')
    } catch {
      return {}
    }
  })()
  check(
    '设置页不再重复一份四档音质（两个会不同步的真相）只留一句指路',
    settingsQualityState.cards === 0 && settingsQualityState.hint.includes('播放栏'),
    JSON.stringify(settingsQualityState),
  )

  await openQualityPicker(57)
  const qualityUi = await evaluate(
    ws,
    `(() => {
       const rows = [...document.querySelectorAll('.quality-tier')]
       return JSON.stringify({
         count: rows.length,
         trigger: document.querySelector('.quality-trigger')?.textContent?.trim() ?? '',
         triggerTier: document.querySelector('.quality-trigger')?.dataset.tier ?? '',
         tiers: rows.map((row) => row.dataset.tier ?? ''),
         names: rows.map((row) => row.querySelector('.tier-name')?.textContent?.trim() ?? ''),
         specs: rows.map((row) => row.querySelector('.tier-spec')?.textContent?.trim() ?? ''),
         availability: rows.map((row) => row.querySelector('.tier-availability')?.textContent?.trim() ?? ''),
         playing: rows.filter((row) => row.classList.contains('playing')).map((row) => row.dataset.tier ?? ''),
         preferred: rows.filter((row) => row.classList.contains('active')).map((row) => row.dataset.tier ?? ''),
         expanded: document.querySelector('.quality-trigger')?.getAttribute('aria-expanded') ?? '',
       })
     })()`,
    57,
  )
  const qUi = (() => {
    try {
      return JSON.parse(qualityUi?.value ?? '{}')
    } catch {
      return {}
    }
  })()
  check(
    '播放栏的音质徽章点开就是四档选择器（不是装饰，也不是只读徽章）',
    qUi.count === 4 && qUi.expanded === 'true' && qUi.tiers.join('>') === 'ultra>lossless>high>smooth',
    JSON.stringify({ count: qUi.count, expanded: qUi.expanded, tiers: qUi.tiers }),
  )
  check(
    '四档各自带自己的产品名与真实参数（24bit/96kHz、16bit/44.1kHz、320kbps、128kbps）',
    qUi.names[0].includes('臻享无损') &&
      qUi.names[1].includes('高清无损') &&
      qUi.names[2].includes('极致音质') &&
      qUi.names[3].includes('流畅播放') &&
      qUi.specs[0].includes('24bit') &&
      qUi.specs[0].includes('96.0kHz') &&
      qUi.specs[1].includes('16bit') &&
      qUi.specs[1].includes('44.1kHz') &&
      qUi.specs[2].includes('320kbps') &&
      qUi.specs[3].includes('128kbps'),
    JSON.stringify({ names: qUi.names, specs: qUi.specs }),
  )
  check(
    '每一档都标出这首歌到底有没有（“这首可选/这首没有”），而不是一句全局宣传语',
    qUi.availability.length === 4 && qUi.availability.every((text) => /这首可选|这首没有|个音源声明支持|暂无音源声明/.test(text)),
    JSON.stringify(qUi.availability),
  )
  check(
    '徽章与选择器指向同一档（徽章上的 data-tier 就是被标为“正在播放”的那一行）',
    qUi.playing.length === 1 && qUi.triggerTier === qUi.playing[0] && Boolean(qUi.trigger),
    JSON.stringify({ playing: qUi.playing, triggerTier: qUi.triggerTier, trigger: qUi.trigger, preferred: qUi.preferred }),
  )

  // Esc closes it, like any other popover — and a picker you cannot dismiss is a picker that blocks the bar.
  await evaluate(
    ws,
    `(() => {
       document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
       return 'ok'
     })()`,
    57,
  )
  await delay(250)
  const closed = await evaluate(
    ws,
    `JSON.stringify({ open: Boolean(document.querySelector('.quality-popover')), expanded: document.querySelector('.quality-trigger')?.getAttribute('aria-expanded') ?? '' })`,
    57,
  )
  const closedState = (() => {
    try {
      return JSON.parse(closed?.value ?? '{}')
    } catch {
      return {}
    }
  })()
  check('Esc 能关掉音质弹层（不会贴在播放栏上方不走）', closedState.open === false && closedState.expanded === 'false', JSON.stringify(closedState))

  /*
   * The picker must survive a press *inside* itself and obey a real click on a row.
   *
   * Both halves need a genuine mouse event. "Close on an outside press" is a capture-phase `pointerdown`
   * handler, so it fires before any click; when its "is this inside?" test forgot the popover — which is a
   * sibling of the badge, not a child — every press on a row dismissed the picker and the click was never
   * delivered. `element.click()` dispatches no `pointerdown`, so nothing above this could see it. This check
   * presses a row and a real click follows it, exactly like a hand on a mouse.
   */
  await openQualityPicker(58)
  const rowBox = await evaluate(
    ws,
    `(() => {
       const centred = (row) => {
         const box = row.getBoundingClientRect()
         const x = box.left + box.width / 2
         const y = box.top + box.height / 2
         /* Only rows whose centre is really on screen: a CDP click at an off-screen coordinate lands on
            something else, which would read as "the click was swallowed" for the wrong reason. */
         return x > 0 && y > 0 && x < window.innerWidth && y < window.innerHeight ? { tier: row.dataset.tier, x, y } : null
       }
       const rows = [...document.querySelectorAll('.quality-tier')]
       const target = rows.filter((row) => !row.classList.contains('active')).map(centred).filter(Boolean)[0] ?? null
       if (!target) return 'no-row'
       return JSON.stringify(target)
     })()`,
    58,
  )
  let clickTier = ''
  let survivedPress = null
  let clickReached = false
  if (rowBox?.value && rowBox.value !== 'no-row') {
    const box = JSON.parse(rowBox.value)
    clickTier = box.tier
    await mouseEvent(ws, 'mouseMoved', box.x, box.y, 58)
    await mouseEvent(ws, 'mousePressed', box.x, box.y, 58)
    /*
     * Read the picker *between* press and release. Reading only after the full click would pass even for a
     * handler that dismisses on press but still lets the click land — which is a different bug from this one.
     */
    survivedPress = await evaluate(ws, `Boolean(document.querySelector('.quality-popover'))`, 58)
    await mouseEvent(ws, 'mouseReleased', box.x, box.y, 59)
    const stored = await evaluate(
      ws,
      `(async () => {
         const deadline = Date.now() + 8000
         let value = ''
         while (Date.now() < deadline) {
           value = (await window.aurora.settings.get()).preferredQuality ?? ''
           if (value === ${JSON.stringify(box.tier)}) break
           await new Promise((resolve) => setTimeout(resolve, 200))
         }
         return value
       })()`,
      59,
    )
    clickReached = stored?.value === box.tier
  }
  check(
    '按下弹层内部的档位时弹层不会被关掉（关闭判定必须认弹层自己）',
    survivedPress?.value === true,
    JSON.stringify({ tier: clickTier, open: survivedPress?.value === true }),
  )
  check(
    '用真鼠标点音质档位真的会改偏好（不是只有程序化 .click() 才生效）',
    clickReached && Boolean(clickTier),
    JSON.stringify({ tier: clickTier, reached: clickReached }),
  )

  /**
   * Picks one tier in the player bar's picker and waits for main to confirm it.
   *
   * The click alone is not proof: the preference lives in the main process, so the acknowledgement has to
   * come back from the settings bridge. That is also what makes the later "and it persisted" assertion about
   * the main process rather than about a lit-up row.
   */
  const setPreferredTier = async (tier, id) => {
    await openQualityPicker(id)
    const result = await evaluate(
      ws,
      `(async () => {
         const tier = ${JSON.stringify(tier)}
         const row = document.querySelector('.quality-tier[data-tier="' + tier + '"]')
         row?.click()
         const deadline = Date.now() + 8000
         let stored = ''
         while (Date.now() < deadline) {
           stored = (await window.aurora.settings.get()).preferredQuality ?? ''
           if (stored === tier) break
           await new Promise((resolve) => setTimeout(resolve, 200))
         }
         /*
          * The close happens *after* the settings round trip, and selecting the tier that is already active
          * satisfies the loop on its first pass — so reading the state without this wait would report an open
          * popover for a click that did close it a moment later.
          */
         await new Promise((resolve) => setTimeout(resolve, 400))
         /*
          * The marked row is deliberately not read here: selecting closes the picker, and a closed picker has
          * no rows to read a mark from. Which row is marked is checked separately, with the picker open.
          */
         return JSON.stringify({
           clicked: Boolean(row),
           stored,
           open: Boolean(document.querySelector('.quality-popover')),
         })
       })()`,
      id,
    )
    try {
      return JSON.parse(result?.value ?? '{}')
    } catch {
      return { clicked: false, stored: '', open: false }
    }
  }

  /**
   * Plays the fixture row through the real UI and reports what the source was asked for.
   *
   * Two things here are deliberately not "the first `.track-row`":
   *
   *  1. the row is found **by its title**. The online page also renders a hot-chart list, so while a search is
   *     still landing the first row belongs to a real platform — one such run played 网易云's chart song,
   *     which made every assertion below describe a different track *and* left that track playing for the
   *     sections after this one;
   *  2. the recorded `?q=` list is cleared **after** the target row is on screen, so a still-in-flight range
   *     request from the previous song cannot be mistaken for this run's choice.
   */
  const playAtQuality = async (id) => {
    await evaluate(ws, "location.hash = '#/search'; 'ok'", id)
    await waitFor(ws, '.hero-search input')
    await evaluate(
      ws,
      `(() => {
         const input = document.querySelector('.hero-search input')
         if (!input) return 'no-input'
         input.value = '打包测试'
         input.dispatchEvent(new Event('input', { bubbles: true }))
         input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }))
         return 'ok'
       })()`,
      id,
    )
    const rowSelector = `[...document.querySelectorAll('.track-row')].find((node) => node.textContent.includes('打包内测试歌曲'))`
    let rowReady = false
    /*
     * 等 24s（80 × 300ms），不是 12s。
     *
     * 每调一次这一页就重新发一轮“五个平台 + 本地音源”的并发搜索，而它花多久是网络说了算。机器一忙，12s 的预算会在结果到达
     * 之前用尽，这条就以 rowReady:false 报错 —— 但报的其实是机器的状态，不是产品的能力。上限依然存在（真的取不到结果时它照样红）。
     */
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const ready = await evaluate(ws, `!!(${rowSelector})`, 3100, 6000).catch(() => null)
      if (ready?.value === true) {
        rowReady = true
        break
      }
      await delay(300)
    }
    // Let any in-flight range request from the previous song finish first, so a straggler cannot be read as
    // this run's choice — then start the record from empty.
    await delay(400)
    source.requestedQualities.length = 0
    const clicked = await evaluate(
      ws,
      `(() => {
         const target = ${rowSelector}
         target?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
         return Boolean(target)
       })()`,
      id,
    )
    /*
     * Wait for the *bytes*. The player bar shows the title as soon as the track is taken off the queue, which
     * is before the source has been asked anything — so reading the record then reports "nothing was asked"
     * for a resolve that is simply still in flight (a script source's resolve is a round trip through its
     * sandbox). Polling the record is the honest wait: it is the server-side proof this check is built on.
     */
    const askedTokens = []
    for (let attempt = 0; attempt < 60; attempt += 1) {
      for (const entry of source.requestedQualities) {
        if (!askedTokens.includes(entry.token)) askedTokens.push(entry.token)
      }
      if (askedTokens.length > 0) break
      await delay(250)
    }
    await delay(500)
    const row = await evaluate(
      ws,
      `(async () => {
         const target = ${rowSelector}
         const badge = target?.querySelector('.quality-badge')
         const bar = document.querySelector('.badge-quality')
         return JSON.stringify({
           rows: document.querySelectorAll('.track-row').length,
           rowBadge: badge ? { text: badge.textContent.trim(), tier: badge.dataset.tier ?? '', title: badge.getAttribute('title') ?? '' } : null,
           barBadge: bar ? { text: bar.textContent.trim(), tier: bar.dataset.tier ?? '', title: bar.getAttribute('title') ?? '' } : null,
           playingFixture: (document.querySelector('.player-bar')?.textContent ?? '').includes('打包内测试歌曲'),
         })
       })()`,
      id,
    )
    const parsed = (() => {
      try {
        return JSON.parse(row?.value ?? '{}')
      } catch {
        return {}
      }
    })()
    return { ...parsed, rowReady, clicked: clicked?.value === true, askedTokens }
  }

  /*
   * The tier walk starts from an explicit baseline.
   *
   * Every step below is proved by the bytes the fixture was asked for, and the *same* resolved URL is
   * legitimately re-served out of the media cache — so a step that happened to pick the tier already in play
   * would look like "the source was asked nothing". Pinning the baseline first makes each later step a
   * different URL, and therefore a request this server actually sees.
   */
  const baselinePick = await setPreferredTier('lossless', 58)
  check(
    '起点档位固定为“高清无损”（后面的每一跳都从这个确定的档位出发）',
    baselinePick.clicked === true && baselinePick.stored === 'lossless' && baselinePick.open === false,
    JSON.stringify(baselinePick),
  )
  const atLossless = await playAtQuality(59)
  check(
    '“高清无损”档位下音源收到的是 flac（不是它最好的 flac24bit：偏好真的限制了上限）',
    atLossless.askedTokens.includes('flac') && !atLossless.askedTokens.includes('flac24bit'),
    JSON.stringify({ asked: atLossless.askedTokens, bar: atLossless.barBadge, playing: atLossless.playingFixture }),
  )
  check(
    '播放栏徽章是“高清无损”（来自音源回传的 flac，不是偏好文案）',
    atLossless.barBadge?.tier === 'lossless',
    JSON.stringify(atLossless.barBadge),
  )

  const preferUltra = await setPreferredTier('ultra', 60)
  check(
    '选择“臻享无损”真的落到主进程设置里（不是只亮了一行）',
    preferUltra.clicked === true && preferUltra.stored === 'ultra' && preferUltra.open === false,
    JSON.stringify(preferUltra),
  )

  const atUltra = await playAtQuality(61)
  check(
    '偏好“臻享无损”时，音源真的收到了 flac24bit（在服务器侧可观测，不是看 UI 文案）',
    atUltra.askedTokens.includes('flac24bit'),
    JSON.stringify({
      asked: atUltra.askedTokens.slice(-3),
      bar: atUltra.barBadge,
      rowReady: atUltra.rowReady,
      playing: atUltra.playingFixture,
      rows: atUltra.rows,
      sawRequests: source.seenRequests.slice(-6).map((entry) => entry.path + (entry.range ? ` [${entry.range}]` : '')),
    }),
  )
  check(
    '播放栏徽章显示的是实际拿到的最高档（臻享无损 · 🎧 ✨ Hi-Res）',
    atUltra.barBadge?.tier === 'ultra' && atUltra.barBadge.text.includes('Hi-Res'),
    JSON.stringify(atUltra.barBadge),
  )
  check(
    '搜索结果行按这首歌的可用音质给徽章（含档位数据，颜色由它决定）',
    atUltra.rowBadge?.tier === 'ultra' && Boolean(atUltra.rowBadge?.title?.includes('flac24bit（臻享无损）')),
    JSON.stringify(atUltra.rowBadge),
  )

  const smoothPick = await setPreferredTier('smooth', 62)
  check(
    '降到“流畅播放”也真的落到主进程设置里',
    smoothPick.clicked === true && smoothPick.stored === 'smooth' && smoothPick.open === false,
    JSON.stringify(smoothPick),
  )

  /*
   * The marks have to follow the state rather than the first render — this re-opens the picker after two
   * changes and reads them again, which is the only way to catch marks that were computed once at mount.
   */
  await openQualityPicker(62)
  const marksAfter = await evaluate(
    ws,
    `(() => {
       const rows = [...document.querySelectorAll('.quality-tier')]
       return JSON.stringify({
         active: rows.filter((row) => row.classList.contains('active')).map((row) => row.dataset.tier),
         playing: rows.filter((row) => row.classList.contains('playing')).map((row) => row.dataset.tier),
         triggerTier: document.querySelector('.quality-trigger')?.dataset.tier ?? '',
         triggerTitle: document.querySelector('.quality-trigger')?.getAttribute('title') ?? '',
       })
     })()`,
    62,
  )
  const marksState = (() => {
    try {
      return JSON.parse(marksAfter?.value ?? '{}')
    } catch {
      return {}
    }
  })()
  check(
    '换档后重新打开选择器：偏好、"正在播放"与徽章三处都跟着走',
    marksState.active?.join() === 'smooth' &&
      marksState.playing?.join() === 'smooth' &&
      marksState.triggerTier === 'smooth' &&
      String(marksState.triggerTitle).includes('流畅播放'),
    JSON.stringify(marksState),
  )
  // Close it again: the steps after this one expect a clean bar.
  await evaluate(ws, `document.querySelector('.quality-trigger')?.click(); 'ok'`, 62)
  await delay(250)
  const atSmooth = await playAtQuality(63)
  check(
    '换成“流畅播放”后，音源收到的是 128k —— 音源有母带也不会偷偷给母带',
    atSmooth.askedTokens.includes('128k') && !atSmooth.askedTokens.includes('flac24bit'),
    JSON.stringify({ asked: atSmooth.askedTokens.slice(-3), bar: atSmooth.barBadge }),
  )
  check(
    '降档后播放栏徽章跟着变成“流畅播放”（显示的是这一档，不是歌能给的最高档）',
    atSmooth.barBadge?.tier === 'smooth' && atSmooth.barBadge.text.includes('Smooth'),
    JSON.stringify(atSmooth.barBadge),
  )

  const restoredQualityState = await setPreferredTier('lossless', 64)
  check(
    '偏好改回“高清无损”并持久化（后续断言的环境干净）',
    restoredQualityState.clicked === true && restoredQualityState.stored === 'lossless' && restoredQualityState.open === false,
    JSON.stringify(restoredQualityState),
  )

  /*
   * Put the fixture back on the bar at the default preference.
   *
   * Everything after this section (the immersive page, the desktop-lyrics strip, the restart assertions)
   * is about *the track that is playing*, and it was written for this fixture. Leaving some other song — or
   * a non-default tier — behind would make those sections report failures that have nothing to do with
   * what they cover.
   */
  const afterRestore = await playAtQuality(65)
  check(
    '测完四档后，夹具曲目重新回到播放栏（后续章节的环境被还原）',
    afterRestore.rowReady === true && afterRestore.playingFixture === true,
    JSON.stringify({ rowReady: afterRestore.rowReady, playing: afterRestore.playingFixture, rows: afterRestore.rows }),
  )

  /*
   * The immersive page with a **real track playing**: the left column has to describe the song the
   * player actually holds, the badges come from the track's own source/qualities, and the two extra
   * views must switch to real panels — a real canvas for the spectrum, a real disc for the record.
   */
  await evaluate(ws, "location.hash = '#/lyrics'; 'ok'", 47)
  await waitFor(ws, '.lyrics-page')
  await delay(900)

  const playingPage = await evaluate(
    ws,
    `(() => {
       const textOf = (selector) => document.querySelector(selector)?.textContent?.replace(/\\s+/g, ' ').trim() ?? ''
       const styleOf = (selector) => {
         const node = document.querySelector(selector)
         return node ? getComputedStyle(node) : null
       }
       const art = document.querySelector('.artwork')
       const artBox = art?.getBoundingClientRect()
       return JSON.stringify({
         title: textOf('.lp-title'),
         sub: textOf('.lp-sub'),
         badges: [...document.querySelectorAll('.lp-badges > *')].map((n) => n.textContent.trim()),
         actions: [...document.querySelectorAll('.lp-actions .glass-icon-button')].map((n) => n.title),
         artworkWidth: artBox ? Math.round(artBox.width * 10) / 10 : 0,
         artworkHeight: artBox ? Math.round(artBox.height * 10) / 10 : 0,
         artworkSquare: artBox ? Math.abs(artBox.width - artBox.height) < 2 : false,
         artworkRadius: styleOf('.artwork-frame')?.borderRadius ?? '',
         artworkClip: styleOf('.artwork-frame')?.overflow ?? '',
         artworkAspect: styleOf('.artwork')?.aspectRatio ?? '',
         artworkComputed: styleOf('.artwork') ? styleOf('.artwork').width + ' x ' + styleOf('.artwork').height : '',
         artworkClient: art ? [art.clientWidth, art.clientHeight, art.offsetHeight] : null,
         frameRect: (() => {
           const rect = document.querySelector('.artwork-frame')?.getBoundingClientRect()
           return rect ? [Math.round(rect.width * 10) / 10, Math.round(rect.height * 10) / 10] : null
         })(),
         imgRect: (() => {
           const rect = document.querySelector('.artwork-frame img')?.getBoundingClientRect()
           return rect ? [Math.round(rect.width * 10) / 10, Math.round(rect.height * 10) / 10] : null
         })(),
         parentBox: (() => {
           const parent = art?.parentElement
           if (!parent) return ''
           const style = getComputedStyle(parent)
           return style.display + '/' + style.flexDirection + '/' + style.alignItems
         })(),
         artworkSource: art?.dataset.artworkSource ?? '',
         artworkLoaded: art?.dataset.artworkLoaded ?? '',
         artworkPosition: art?.dataset.artworkPosition ?? '',
         imageNatural: (() => {
           const img = document.querySelector('.artwork-frame img')
           return img ? [img.naturalWidth, img.naturalHeight] : [0, 0]
         })(),
         extendBlur: styleOf('.artwork-extend')?.filter ?? '',
         glowBlur: styleOf('.artwork-glow')?.filter ?? '',
         lyricLines: document.querySelectorAll('.lyric-line').length,
         emptyTitle: textOf('.lp-empty-title'),
         emptyActions: [...document.querySelectorAll('.lp-empty-actions button')].map((n) => n.textContent.trim()),
         infoTooltip: textOf('.lp-tooltip'),
       })
     })()`,
    47,
  )
  const detail = (() => {
    try {
      return JSON.parse(playingPage?.value ?? '{}')
    } catch {
      return { raw: playingPage?.value }
    }
  })()
  check('详情页歌名取自真正在播放的曲目', String(detail.title).includes('打包内测试歌曲'), detail.title)
  check('详情页显示音源与音质徽章', (detail.badges ?? []).length >= 1, JSON.stringify(detail.badges))
  check(
    '快捷工具栏含收藏 / 搜索相似 / 下载 / 更多',
    ['收藏', '取消收藏'].some((label) => (detail.actions ?? []).includes(label)) &&
      (detail.actions ?? []).includes('搜索相似音乐') &&
      (detail.actions ?? []).includes('下载到本地音乐库') &&
      (detail.actions ?? []).includes('更多操作'),
    JSON.stringify(detail.actions),
  )
  check(
    '封面画布: 方形 + 圆角 + 裁切内容（Artwork Canvas 已取代旧封面卡片）',
    detail.artworkSquare === true &&
      // A range, not `≈340`: the canvas is sized from the viewport, and one pixel of rounding at a
      // different window height used to fail this by exactly 1px (338 vs 339.994) while the layout was
      // correct. The properties that matter are square, radius and clipping.
      Number(detail.artworkWidth) > 300 &&
      Math.abs(Number(detail.artworkWidth) - Number(detail.artworkHeight)) < 3 &&
      String(detail.artworkRadius).startsWith('16px') &&
      String(detail.artworkClip) === 'hidden',
    JSON.stringify({
      width: detail.artworkWidth,
      height: detail.artworkHeight,
      square: detail.artworkSquare,
      radius: detail.artworkRadius,
      clip: detail.artworkClip,
      aspect: detail.artworkAspect,
      computed: detail.artworkComputed,
      client: detail.artworkClient,
      frame: detail.frameRect,
      img: detail.imgRect,
      parent: detail.parentBox,
    }),
  )
  /*
   * The cover really being fetched and decoded is the assertion that matters. Online covers are
   * relayed through `aurora-media://`, and the renderer's CSP admits no other scheme for images — so a
   * regression there shows up as a frame that is quietly empty. `naturalWidth` can only be non-zero
   * once the bytes were fetched and decoded, and the component has to report that honestly.
   */
  check(
    '封面画布: 真实封面被拉取并解码（不是空框，也不是破图）',
    detail.artworkSource === 'catalog' &&
      detail.artworkLoaded === 'true' &&
      Number(detail.imageNatural?.[0]) === COVER_EDGE &&
      String(detail.extendBlur).includes('blur(56px)') &&
      String(detail.glowBlur).includes('blur(46px)'),
    JSON.stringify({
      source: detail.artworkSource,
      loaded: detail.artworkLoaded,
      natural: detail.imageNatural,
      extend: detail.extendBlur,
      glow: detail.glowBlur,
    }),
  )
  check(
    '封面画布: 主体安全取景已解算（object-position 由算法给出）',
    /^\d+(\.\d+)?% \d+(\.\d+)?%$/.test(String(detail.artworkPosition)),
    detail.artworkPosition,
  )
  check(
    '歌词或空态二选一（都是真实状态）',
    detail.lyricLines > 0 ||
      (['纯音乐 / 暂无歌词', '暂无歌词'].includes(detail.emptyTitle) &&
        (detail.emptyActions ?? []).some((text) => text.includes('手动导入 LRC 歌词')) &&
        (detail.emptyActions ?? []).some((text) => text.includes('联网自动匹配'))),
    JSON.stringify({ lines: detail.lyricLines, empty: detail.emptyTitle, actions: detail.emptyActions }),
  )

  const clickedSpectrum = await evaluate(
    ws,
    "[...document.querySelectorAll('.lp-viewswitch button')].find((b) => b.textContent.includes('频谱律动'))?.click(); 'ok'",
    47,
  )
  /*
   * Make sure something is actually *playing* before reading the canvas.
   *
   * The spectrum only draws what the analyser hears, and by this point the suite has done a lot of work
   * since it started the short fixture track — so the player can be at the very end of it (or idle),
   * which paints a blank canvas and reads as "the visualizer is broken". Seeking back to the start and
   * playing is what makes the check about the visualizer instead of about how long the suite took.
   */
  const spectrumPlaying = await ensurePlaying(ws, 94)
  // Re-read the elapsed-time readout after `ensurePlaying` has proved the clock moves, so the detail
  // line below reports the state the canvas was actually sampled in.
  const clockBefore = await sampleClock(ws, 45)
  await delay(600)
  const clockAfter = await sampleClock(ws, 46)
  const spectrum = await evaluate(
    ws,
    `(() => {
       const canvas = document.querySelector('.spectrum-canvas')
       // Reading the pixels back is the difference between "a canvas exists" and "a spectrum is drawn":
       // an empty canvas (or one never connected to the audio graph) would be fully transparent.
       let painted = 0
       if (canvas && canvas.width > 0) {
         const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
         for (let index = 3; index < data.length; index += 4) if (data[index] > 8) painted += 1
       }
       return JSON.stringify({
         canvas: Boolean(canvas),
         size: canvas?.getBoundingClientRect().width ?? 0,
         painted,
         blocked: document.querySelector('.spectrum-blocked')?.textContent?.trim() ?? '',
         // "blank canvas" has two very different causes — the analyser never attached (the view says
         // so, and the node above proves it) versus it attached but nothing got drawn — and the next
         // reader should not have to guess which one this was.
         blockedNode: Boolean(document.querySelector('.spectrum-blocked')),
         canvasCss: canvas ? canvas.clientWidth + 'x' + canvas.clientHeight + '@' + canvas.width + 'x' + canvas.height : '',
       })
     })()`,
    47,
  )
  const spectrumState = (() => {
    try {
      return JSON.parse(spectrum?.value ?? '{}')
    } catch {
      return { raw: spectrum?.value }
    }
  })()
  check(
    '频谱视图渲染真实画布（未能接入时给出原因与入口）',
    clickedSpectrum?.value === 'ok' &&
      spectrumState.canvas === true &&
      Number(spectrumState.size) > 100 &&
      (spectrumState.blocked === '' || spectrumState.blocked.includes('音频分析需要一次交互')),
    JSON.stringify(spectrumState),
  )
  // Any non-transparent pixel proves the canvas was drawn from the analyser's data rather than left
  // blank. The count is reported as-is: playing audio paints a few thousand, a paused player only the
  // floor of the bars, and both are correct — a *blank* canvas is the failure this guards against.
  check(
    '频谱画布真的按音频数据绘制（非空白画布）',
    Number(spectrumState.painted) > 0,
    // The clock is part of the detail on purpose: a blank canvas with a *stopped* clock is a fixture
    // that ran out of audio, and saying so beats leaving the next reader to guess.
    `painted pixels: ${spectrumState.painted} · clock ${clockBefore.text} → ${clockAfter.text} · primed ${JSON.stringify(spectrumPlaying)}`,
  )

  await evaluate(
    ws,
    "[...document.querySelectorAll('.lp-viewswitch button')].find((b) => b.textContent.includes('拟真唱片'))?.click(); 'ok'",
    47,
  )
  await delay(600)
  const vinyl = await evaluate(
    ws,
    `(() => {
       const platter = document.querySelector('.vinyl-platter')
       const grooves = document.querySelector('.vinyl-grooves')
       const label = document.querySelector('.vinyl-label')
       const disc = document.querySelector('.vinyl')
       return JSON.stringify({
         disc: Boolean(platter),
         playState: platter ? getComputedStyle(platter).animationPlayState : '',
         grooves: Boolean(grooves),
         labelArt: label ? getComputedStyle(label).backgroundImage.slice(0, 8) : '',
         // The grooves are *drawn* (one ring per ~1.15 px), so counting non-transparent pixels is what
         // separates "a canvas exists" from "a record was actually rendered on it".
         grooveInk: (() => {
           if (!grooves || grooves.width === 0) return -1
           try {
             const data = grooves.getContext('2d').getImageData(0, 0, grooves.width, grooves.height).data
             let ink = 0
             for (let index = 3; index < data.length; index += 4) if (data[index] > 2) ink += 1
             return ink
           } catch {
             return -2
           }
         })(),
         labelSize: label ? Math.round(label.getBoundingClientRect().width) : 0,
         spindle: Boolean(document.querySelector('.vinyl-spindle')),
         tonearm: Boolean(document.querySelector('.vinyl-tonearm')),
         live: disc?.dataset.vinylLive ?? '',
         /*
          * The disc is one object: platter + drawn grooves + artwork label. The extra "rim" slab that
          * briefly sat behind it is gone on purpose (it made the pressing read as a sticker on a plate),
          * so this records its *absence* — a re-added layer should be a decision, not a regression.
          */
          extraLayers: document.querySelectorAll('.vinyl-rim').length,
          haloOpacity: (() => {
            const halo = document.querySelector('.vinyl-halo')
            return halo ? Number(getComputedStyle(halo).opacity) : -1
          })(),
         /*
          * Does the platter *say* it is turning, and does the player agree?
          *
          * The class is only honest if it is read against the transport it claims to follow — a disc
          * that spins with the music stopped is as wrong as one that never moves.
          */
         spinning: platter?.classList.contains('spinning') ?? false,
         /*
          * The wrapper is .transport-buttons, not .transport-controls: the transport was restructured
          * into buttons-over-progress and the class was renamed. The stale selector made this probe
          * match nothing, so it reported "not playing" forever — which looked like a spin desync but
          * was really the test looking in the wrong place. transportFound is reported separately so a
          * future rename fails as "the probe found no button" instead of as a mysterious mismatch.
          */
         transportFound: Boolean(document.querySelector('.transport-buttons .play-button')),
         buttonPlaying: /❚❚/.test(document.querySelector('.transport-buttons .play-button')?.textContent ?? ''),
         /*
          * The arm angle is a function of the player's own progress, so the check recomputes what it
          * should be from the published progress and the platter's spin state and compares. Asserting
          * "an angle exists" would pass for a frozen arm.
          */
         arm: (() => {
           const angle = Number(document.querySelector('.vinyl-tonearm')?.dataset.vinylArm)
           const playing = document.querySelector('.vinyl-platter')?.classList.contains('spinning') ?? false
           const progress = Number(disc?.dataset.vinylProgress)
           /*
            * Mirrors the component's arc. The direction was inverted for a while — playing used to lift
            * the needle off the record — and the numbers are the measured ones: −3° parks it just outside
            * the outer groove, 0.5° sets it down at the start of a side, and 21.5° of travel walks it to
            * the run-out (1.03, 0.95 and 0.41 of the disc's radius).
            */
           return { angle, playing, progress, expected: playing ? 0.5 + progress * 21.5 : -3 }
         })(),
         labelImg: (() => {
           const img = label?.querySelector('img')
           return img ? [img.naturalWidth, img.complete] : [0, false]
         })(),
       })
     })()`,
    47,
  )
  const vinylState = (() => {
    try {
      return JSON.parse(vinyl?.value ?? '{}')
    } catch {
      return { raw: vinyl?.value }
    }
  })()
  check(
    '唱片视图: 沟槽真的画在画布上 + 中央标签 + 唱针角度来自播放进度',
    Number(vinylState.grooveInk) > 1000 &&
      Number(vinylState.labelSize) > 40 &&
      vinylState.spindle === true &&
      vinylState.tonearm === true &&
      ['true', 'false'].includes(String(vinylState.live)) &&
      // The label shows the album art — and it can only do that if the cover was relayed, since the
      // renderer's CSP refuses every image scheme except `aurora-media:`.
      String(vinylState.labelArt).startsWith('url("aur') &&
      Number(vinylState.labelImg?.[0]) === COVER_EDGE &&
      Number.isFinite(Number(vinylState.arm?.angle)) &&
      Math.abs(Number(vinylState.arm?.angle) - Number(vinylState.arm?.expected)) < 0.2,
    JSON.stringify({
      ink: vinylState.grooveInk,
      label: vinylState.labelSize,
      labelArt: vinylState.labelArt,
      labelImg: vinylState.labelImg,
      spindle: vinylState.spindle,
      tonearm: vinylState.tonearm,
      arm: vinylState.arm,
      live: vinylState.live,
    }),
  )
  check(
    '唱片视图渲染盘面、纹路与标签，转动状态跟随播放器',
    vinylState.disc === true &&
      vinylState.grooves === true &&
      vinylState.transportFound === true &&
      vinylState.spinning === vinylState.buttonPlaying,
    JSON.stringify({
      disc: vinylState.disc,
      grooves: vinylState.grooves,
      transportFound: vinylState.transportFound,
      spinning: vinylState.spinning,
      buttonPlaying: vinylState.buttonPlaying,
    }),
  )
  check(
    '黑胶只有一层盘面（没有额外的“厚度”图层），且主题色光晕保持在很低的透明度',
    Number(vinylState.extraLayers) === 0 && Number(vinylState.haloOpacity) >= 0 && Number(vinylState.haloOpacity) <= 0.25,
    JSON.stringify({ extraLayers: vinylState.extraLayers, haloOpacity: vinylState.haloOpacity }),
  )

  /*
   * 三种压制（黑胶 / 彩胶 / 透明胶）真的不是换色。
   *
   * The pitfalls this is built around, both of which were real bugs found on the live page:
   *
   *  1. the groove ink is *baked at paint time*, so a material can flip every CSS token and still draw the
   *     old texture — or, worse, draw in whatever `strokeStyle` the previous paint left behind (measured:
   *     black rings on a fresh black pressing, i.e. grooves that are invisible under `mix-blend-mode:
   *     screen`);
   *  2. `getImageData` returns *un-premultiplied* values, so averaging RGB alone calls white at 3% alpha and
   *     black at 90% alpha the same colour. Everything here is therefore alpha-weighted.
   *
   * It asserts three things a token-only check cannot: each pressing is selected and reflected by the picker,
   * the ink is never the default black, and the relief rises through the three (the scales are 1 : 1.15 : 1.5,
   * measured — the ink cannot separate 黑胶 from 透明胶, because both are neutral and bright).
   */
  const pressings = await evaluate(
    ws,
    `(async () => {
       const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
       const buttons = () => [...document.querySelectorAll('.vinyl-materials button')]
       const inkOf = () => {
         const canvas = document.querySelector('.vinyl-grooves')
         let r = 0, g = 0, b = 0, a = 0
         if (!canvas || canvas.width === 0) return { rgb: [0, 0, 0], weight: 0 }
         const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
         for (let i = 0; i < data.length; i += 4) {
           const alpha = data[i + 3]
           if (alpha === 0) continue
           r += data[i] * alpha
           g += data[i + 1] * alpha
           b += data[i + 2] * alpha
           a += alpha
         }
         if (a === 0) return { rgb: [0, 0, 0], weight: 0 }
         return {
           rgb: [r / a, g / a, b / a].map((v) => Math.round(v)),
           weight: Number((a / 255 / (canvas.width * canvas.height)).toFixed(4)),
         }
       }
       const steps = []
       for (const [label, id] of [['黑胶', 'black'], ['彩胶', 'colour'], ['透明胶', 'clear']]) {
         buttons().find((b) => b.textContent.trim() === label)?.click()
         await wait(340)
         const ink = inkOf()
         steps.push({
           label,
           id,
           attr: document.querySelector('.vinyl')?.getAttribute('data-vinyl') ?? '',
           html: document.documentElement.dataset.vinyl ?? '',
           active: buttons().find((b) => b.classList.contains('active'))?.textContent.trim() ?? '',
           ink: ink.rgb,
           weight: ink.weight,
         })
       }
       // Back to the standard pressing, so the suite leaves the app as it found it.
       buttons().find((b) => b.textContent.trim() === '黑胶')?.click()
       await wait(300)
       return JSON.stringify({ steps, restored: document.documentElement.dataset.vinyl ?? '' })
     })()`,
    47,
  )
  const pressingState = (() => {
    try {
      return JSON.parse(pressings?.value ?? '{}')
    } catch {
      return { raw: pressings?.value }
    }
  })()
  const pressingsOf = Array.isArray(pressingState.steps) ? pressingState.steps : []
  const [black, colour, clear] = pressingsOf
  const spread = (rgb) => Math.max(...rgb) - Math.min(...rgb)
  check(
    '唱片材质可自选：选中即换盘面（属性 + 胶囊高亮），并回到黑胶',
    pressingsOf.length === 3 &&
      pressingsOf.every((step) => step.id === step.attr && step.id === step.html && step.active === step.label) &&
      pressingState.restored === 'black',
    JSON.stringify(pressingState),
  )
  check(
    '沟槽的墨色跟着材质走（不是默认黑：修过“整盘用上一次残留的 strokeStyle”这个 bug）',
    pressingsOf.length === 3 &&
      /*
       * "Bright, not black" — the guard is against the *default* `strokeStyle`, which paints rgb(0,0,0) and
       * makes the whole texture a no-op under `mix-blend-mode: screen`. The floor is well below the darkest
       * real ink (彩胶's tint mixes towards white, so its blue channel sits around 180) and far above zero.
       */
      pressingsOf.every((step) => Math.min(...step.ink) > 120) &&
      // 彩胶's ink is the cover's tint, so its channels must be *uneven* — this is the assertion that fails
      // if the canvas keeps painting the previous material.
      Boolean(colour) && spread(colour.ink) >= 8 &&
      Boolean(black) && spread(black.ink) <= 4 &&
      Boolean(clear) && spread(clear.ink) <= 4,
    JSON.stringify({ black: black?.ink, colour: colour?.ink, clear: clear?.ink }),
  )
  check(
    '三种材质的沟槽起伏依次递增（黑胶 < 彩胶 < 透明胶）',
    Boolean(black && colour && clear) &&
      black.weight > 0 &&
      black.weight < colour.weight &&
      colour.weight < clear.weight &&
      // Measured ratio is 1 : 1.15 : 1.5; the margin is loose on purpose so it fails on a *flat* texture
      // rather than on a rounding difference.
      Math.abs(clear.weight / black.weight - 1.5) < 0.25,
    JSON.stringify({ black: black?.weight, colour: colour?.weight, clear: clear?.weight }),
  )

  /*
   * 唱盘的转动是真转动。
   *
   * A CSS `animation-play-state` can only start and stop, so the disc used to jump to full speed and
   * freeze on pause — and no attribute check would notice, because `running`/`paused` is a perfectly
   * good-looking value either way. The angle is now integrated by the component, so the honest test is the
   * angle itself: it has to advance while playing, keep advancing for a moment after pausing (a platter
   * coasts), and be stationary a couple of seconds later. All three are measured here in one pass.
   *
   * 先确认“真的在放”，再量。夹具音频只有几秒，跑到这一步时它常常已经播完；量到一条静止的唱片（角度停在
   * 0.00）和“组件不转”长得一模一样，所以用与桌面歌词那条相同的做法：拖回开头、按播放、确认时钟在走，再开始。
   */
  const spinPlayback = await ensurePlaying(ws, 59)
  const rotation = await evaluate(
    ws,
    `(async () => {
       const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
       /*
        * 先确保“拟真唱片”是当前视图。
        *
        * 这条检查测的是唱片本身，所以它必须自己把页面置到它需要的状态，而不是假定前面某一条检查把它留在了那里：
        * 一旦视图不在唱片上，.vinyl-platter 根本不存在，读到的是 NaN，而报告出来的是 null°，看上去像“唱盘
        * 转不动”，实际上是“页面上没有唱盘”。两种失败长得一模一样，所以先用真实证据分开它们。
        */
       if (!document.querySelector('.vinyl-platter')) {
         const tab = [...document.querySelectorAll('.lp-viewswitch button')].find((item) => item.textContent?.includes('唱片'))
         tab?.click()
         for (let attempt = 0; attempt < 20 && !document.querySelector('.vinyl-platter'); attempt += 1) await wait(150)
       }
       const read = () => Number(document.querySelector('.vinyl-platter')?.dataset.vinylAngle ?? NaN)
       const norm = (value) => (Number.isFinite(value) ? ((value % 360) + 360) % 360 : NaN)
       const delta = (from, to) => {
         const step = norm(to) - norm(from)
         return step < 0 ? step + 360 : step
       }
       const button = document.querySelector('.transport-buttons .play-button')
       // The record only turns while the song does, so the measurement starts from a known playing state.
       if (button?.textContent?.includes('▶')) {
         button.click()
         await wait(800)
       }
       const a = read()
       await wait(700)
       const b = read()
       button?.click()
       await wait(400)
       const c = read()
       await wait(2400)
       const d = read()
       await wait(700)
       const e = read()
       return JSON.stringify({
         found: Boolean(button),
         view: document.querySelector('.vinyl-platter') ? 'vinyl' : 'missing',
         a,
         b,
         c,
         d,
         e,
         playing: delta(a, b),
         coasting: delta(b, c),
         settled: delta(d, e),
       })
     })()`,
    58,
  )
  const spinState = (() => {
    try {
      return JSON.parse(rotation?.value ?? '{}')
    } catch {
      return { raw: rotation?.value }
    }
  })()
  check(
    '播放时唱盘真的在转（角度由组件按真实时间推进）',
    Number(spinState.playing) > 4,
    `0.7s 转过的角度: ${spinState.playing}° · 视图: ${spinState.view} · 播放前: ${JSON.stringify(spinPlayback)}`,
  )
  check(
    '暂停后不是硬停：先滑行再停下（半秒内仍在动，两秒后静止）',
    // `found` first: with no button to press there is no pause to measure, and "it never stopped"
    // would be the wrong conclusion to draw from that.
    spinState.view === 'vinyl' && spinState.found === true && Number(spinState.coasting) > 0.5 && Number(spinState.settled) < 0.8,
    `找到播放键: ${spinState.found} · 视图: ${spinState.view} · 滑行: ${spinState.coasting}° · 静止后: ${spinState.settled}°`,
  )

  await evaluate(ws, "location.hash = '#/search'; 'ok'", 48)
  await waitFor(ws, '.hero-search input')
  await delay(400)
  // The desktop strip shows the line that is *currently being sung*, which needs a running clock.
  const playbackForLyrics = await ensurePlaying(ws, 54)
  await delay(400)

  /* --------------------------------------------------- desktop lyrics (second window)
   *
   * The strip is a real OS window with its own renderer, so this drives it over a second CDP
   * connection: the clock comes from the app window through the main process, and the lyrics come
   * from the same resolver the immersive page uses. Nothing here is simulated.
   */
  const enabled = await evaluate(ws, "window.aurora.desktopLyrics.setEnabled(true).then((o) => o && o.enabled)", 55)
  check('桌面歌词：通过 IPC 打开独立窗口', enabled?.value === true, enabled?.value)

  const lyricsTarget = await findTarget((url) => url.includes('desktop-lyrics'), 30)
  check('桌面歌词：出现了独立的歌词窗口目标', Boolean(lyricsTarget), lyricsTarget?.url ?? 'no target')
  const lyricsWin = lyricsTarget ? await connect((url) => url.includes('desktop-lyrics'), 'typeof window.auroraLyrics') : null

  if (lyricsWin) {
    await delay(1200)
    // Without this the strip assertions can fail for the one reason that is not about the strip:
    // the three-second fixture track having already finished.
    check(
      '桌面歌词：读歌词条前已把曲目拖回开头并在播放（否则读到的是曲尾或已播完）',
      String(playbackForLyrics.title).includes('暂停') && playbackForLyrics.seeked === true,
      JSON.stringify(playbackForLyrics),
    )
    const strip = await evaluate(
      lyricsWin.ws,
      `(() => JSON.stringify({
         plate: !!document.querySelector('.dl-plate'),
         active: document.querySelector('.dl-line-active')?.textContent?.trim() ?? '',
         next: document.querySelector('.dl-line-next')?.textContent?.trim() ?? '',
         font: document.querySelector('.dl-plate') ? getComputedStyle(document.querySelector('.dl-plate')).fontSize : '',
       }))()`,
      56,
    )
    let stripState = {}
    try {
      stripState = JSON.parse(strip?.value ?? '{}')
    } catch {
      stripState = { raw: strip?.value }
    }
    check(
      '桌面歌词：窗口渲染出歌词条，并显示当前正在唱的那一行',
      stripState.plate === true && String(stripState.active).includes('打包内歌词行'),
      stripState,
    )

    // The clock must actually arrive: with autoplay running, the progress bar advances.
    const progressA = await evaluate(
      lyricsWin.ws,
      "document.querySelector('.dl-progress')?.style.transform ?? ''",
      57,
    )
    await delay(1600)
    const progressB = await evaluate(
      lyricsWin.ws,
      "document.querySelector('.dl-progress')?.style.transform ?? ''",
      58,
    )
    check(
      '桌面歌词：时钟真的在推进（进度条比例随时变化）',
      Boolean(progressA?.value) && progressA.value !== progressB?.value,
      `${progressA?.value} → ${progressB?.value}`,
    )

    // Appearance is applied live: font size lands on the plate, and it survives as a setting.
    await evaluate(lyricsWin.ws, "window.auroraLyrics.setOptions({ fontSize: 52 })", 59)
    await delay(400)
    const resized = await evaluate(
      lyricsWin.ws,
      "getComputedStyle(document.querySelector('.dl-plate')).fontSize",
      60,
    )
    const persisted = await evaluate(ws, "window.aurora.desktopLyrics.options().then((o) => o.fontSize)", 61)
    check('桌面歌词：字号改动即时生效并写入设置', resized?.value === '52px' && persisted?.value === 52, `${resized?.value}/${persisted?.value}`)

    // Hover reveals the controls; a locked strip hides them, because the window stops taking clicks.
    await evaluate(lyricsWin.ws, "document.querySelector('.dl-root').dispatchEvent(new MouseEvent('mouseenter')); 'ok'", 62)
    await delay(300)
    const hover = await evaluate(
      lyricsWin.ws,
      "document.querySelector('.dl-controls')?.classList.contains('visible')",
      63,
    )
    check('桌面歌词：悬停才出现控制条', hover?.value === true, hover?.value)

    const locked = await evaluate(lyricsWin.ws, "window.auroraLyrics.setOptions({ locked: true })", 64)
    await delay(500)
    const lockedUi = await evaluate(
      lyricsWin.ws,
      "JSON.stringify({ locked: document.querySelector('.dl-root')?.classList.contains('locked'), controls: document.querySelector('.dl-controls')?.classList.contains('visible') })",
      65,
    )
    check(
      '桌面歌词：锁定后控制条收起（窗口已设为鼠标穿透）',
      String((locked?.value ?? {}).locked ?? '') === 'true' && String(lockedUi?.value).includes('"controls":false'),
      lockedUi?.value,
    )
    await evaluate(lyricsWin.ws, "window.auroraLyrics.setOptions({ locked: false })", 66)

    // Control forwarding: the strip asks, the app window acts on its own <audio> element.
    //
    // The assertion is about a *transition*, so the starting state has to be put right first: the
    // fixture track is three seconds long and the strip checks above take longer than that, so without
    // this the button would already read 播放 and "toggle play" could only ever be a no-op.
    const primed = await ensurePlaying(ws, 71)
    check('桌面歌词：转发前把播放状态置为播放中（否则测的是已播完状态）', String(primed.title).includes('暂停'), JSON.stringify(primed))
    const before = await evaluate(ws, "document.querySelector('.play-button')?.getAttribute('title')", 67)
    /*
     * The music-coupling input, read *while the track is really playing*.
     *
     * `--music-energy` is the single number every reactive rule multiplies by, and it is written by the
     * energy loop from the analyser's own bass reading. So this both proves the coupling has a live source
     * (a theme cannot "react to the music" with an input that is always zero) and gives the paused read
     * below something to be compared against.
     */
    const energyWhilePlaying = await evaluate(
      ws,
      `(async () => {
         // Sampled over ~0.6s and reported as the peak: the write runs at 20 Hz, and a single frame can
         // land between two updates (or in a tremolo dip) — the peak is what "the visuals have a live
         // input" actually means.
         let peak = 0
         for (let attempt = 0; attempt < 30; attempt += 1) {
           const value = Number(getComputedStyle(document.documentElement).getPropertyValue('--music-energy')) || 0
           if (value > peak) peak = value
           await new Promise((resolve) => setTimeout(resolve, 20))
         }
         return JSON.stringify({ playing: document.documentElement.dataset.playing ?? '', energy: peak })
       })()`,
      72,
    )
    const live = (() => {
      try {
        return JSON.parse(energyWhilePlaying?.value ?? '{}')
      } catch {
        return {}
      }
    })()
    check(
      '播放中音乐联动真的有输入（--music-energy 来自分析器，不是常数 0）',
      live.playing === 'true' && Number(live.energy) > 0,
      JSON.stringify(live),
    )
    await evaluate(lyricsWin.ws, "window.auroraLyrics.control('toggle-play'); 'sent'", 68)
    await delay(900)
    const after = await evaluate(ws, "document.querySelector('.play-button')?.getAttribute('title')", 69)
    check(
      '桌面歌词：播放/暂停按钮真的控制到了播放器（主窗口按钮标题翻转）',
      before?.value === '暂停' && after?.value === '播放',
      `${before?.value} → ${after?.value}`,
    )
    /*
     * The same pause, seen from the visuals: `--fx-speed` is the multiplier every room animation and the
     * ambient glow are scaled by, and `data-playing` is what selects it. These are the two inputs the
     * stylesheet reads, so reading them *after a real pause* is what makes "暂停时动画减缓" a check rather
     * than a claim — and both come from the player's own events, not from anything this test wrote.
     */
    const slowed = await evaluate(
      ws,
      `(() => {
         const root = document.documentElement
         return JSON.stringify({
           playing: root.dataset.playing ?? '',
           speed: getComputedStyle(root).getPropertyValue('--fx-speed').trim(),
           energy: getComputedStyle(root).getPropertyValue('--music-energy').trim(),
           // Energy is reported, not asserted: in this environment the analyser attach is the flaky part
           // (see the spectrum checks), and a failing attach would make this read 0 without the pause
           // behaviour above being wrong in any way.
         })
       })()`,
      74,
    )
    const pausedVisual = (() => {
      try {
        return JSON.parse(slowed?.value ?? '{}')
      } catch {
        return {}
      }
    })()
    check(
      '暂停后动效真的减速（--fx-speed 变成 2.6，而不是继续按播放速度跑）',
      pausedVisual.playing === 'false' && Number(pausedVisual.speed) >= 2.5,
      JSON.stringify(pausedVisual),
    )
    // Put playback back so the rest of the suite (and the restart snapshot) sees a playing track.
    await evaluate(ws, "document.querySelector('.play-button')?.click(); 'ok'", 70)
    await delay(900)

    /*
     * 音乐陪伴记录到这里才检查。
     *
     * 这一段已经真的播过歌了（上面刚测完“暂停后动效减速”又恢复播放），所以记录的“播放次数 / 首次日期”一定
     * 应该有内容：这是一个可验证的事实，而不是希望。在那之前检查它只会得到 0——那是正确行为，却被当成失败。
     */
    const companion = await evaluate(
      ws,
      `(async () => {
         const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
         let stored = null
         try {
           stored = JSON.parse(localStorage.getItem('aurora:companion') ?? '{}')
         } catch {
           stored = null
         }
         location.hash = '#/settings'
         await delay(900)
         const summary = document.querySelector('[data-companion-summary]')?.textContent?.replace(/\\s+/g, ' ').trim() ?? ''
         return JSON.stringify({
           plays: Number(stored?.plays) || 0,
           first: String(stored?.firstPlayedAt ?? ''),
           summary,
           night: document.documentElement.getAttribute('data-easter-night') === 'true',
         })
       })()`,
      215,
      20000,
    )
    const companionState = (() => {
      try {
        return JSON.parse(companion?.value ?? '{}')
      } catch {
        return {}
      }
    })()
    check(
      '音乐陪伴记录真的在累计并落盘：播过的歌算进次数，首次日期写得下',
      companionState.plays >= 1 && /^\d{4}-\d{2}-\d{2}$/.test(companionState.first) && /播放 \d+ 首/.test(companionState.summary),
      JSON.stringify(companionState),
    )
    check(
      '连听不足五首时不会自己解锁极光（徽章要挣来，不是默认亮）',
      companionState.night === false,
      JSON.stringify({ night: companionState.night, plays: companionState.plays }),
    )
  }

  /*
   * 系统集成：托盘 / 任务栏按钮 / 全局媒体键。
   *
   * The assertion is on what the *main process* registered, not on the switch echoing itself back.
   * That distinction is the whole point of this phase: `trayActive` and `mediaKeys` come from the OS
   * handles (`Tray` / `globalShortcut`), so a tray icon that never appeared fails here rather than
   * passing as a checked checkbox.
   */
  {
    const status = async () => {
      const value = await evaluate(
        ws,
        "window.aurora.systemIntegration.status().then((s) => JSON.stringify(s))",
        80,
      )
      try {
        return JSON.parse(String(value?.value ?? '{}'))
      } catch {
        return {}
      }
    }

    const initial = await status()
    check('系统集成: 托盘真的注册到了操作系统', initial.trayActive === true, initial)
    check(
      '系统集成: 全局媒体键真的被占用（播放/暂停、上下一首）',
      Array.isArray(initial.mediaKeys) && initial.mediaKeys.includes('MediaPlayPause') && initial.mediaKeys.length >= 3,
      initial.mediaKeys,
    )

    // Playback is running at this point (the phase above left it playing), so the tray must be
    // showing that track — the tray is a view of `ReportedPlayerState`, not a copy.
    check(
      '系统集成: 托盘提示跟随正在播放的曲目（不是写死的名字）',
      typeof initial.trayTooltip === 'string' && initial.trayTooltip.includes('打包内测试歌曲'),
      initial.trayTooltip,
    )

    // Drive the real switches in the real settings page. The route matters: the section only exists
    // on `#/settings`, and querying from the search page found nothing (which is how this assertion
    // was written the first time).
    await evaluate(ws, "location.hash = '#/settings'; 'ok'", 79)
    await delay(900)
    const section = await evaluate(
      ws,
      `(() => {
         const node = document.querySelector('[data-testid="system-integration-section"]')
         return JSON.stringify({
           present: !!node,
           heading: node?.querySelector('h3')?.textContent?.trim() ?? '',
           buttons: [...(node?.querySelectorAll('button') ?? [])].map((b) => b.textContent.trim()),
           labels: [...(node?.querySelectorAll('.setting-label strong') ?? [])].map((n) => n.textContent.trim()),
         })
       })()`,
      81,
    )
    const rendered = (() => {
      try {
        return JSON.parse(String(section?.value ?? '{}'))
      } catch {
        return {}
      }
    })()
    check(
      '系统集成: 设置页渲染出托盘 / 任务栏 / 媒体键三块开关',
      rendered.present === true && (rendered.buttons ?? []).length >= 4 && (rendered.labels ?? []).length >= 4,
      rendered,
    )

    // Turning media keys off must release the OS bindings for real.
    const off = await evaluate(
      ws,
      `window.aurora.systemIntegration.set({ mediaKeys: false }).then((s) => JSON.stringify(s))`,
      82,
    )
    const afterOff = await status()
    check(
      '系统集成: 关掉媒体键后真的释放了系统占用',
      afterOff.mediaKeys.length === 0 && JSON.parse(String(off?.value ?? '{}')).mediaKeys === false,
      { mediaKeys: afterOff.mediaKeys, settings: off?.value },
    )

    // …and back on, so the phase proves both transitions rather than one direction.
    await evaluate(ws, `window.aurora.systemIntegration.set({ mediaKeys: true }).then((s) => JSON.stringify(s))`, 83)
    const afterOn = await status()
    check(
      '系统集成: 重新打开后媒体键再次被占用（设置即时生效，无需重启）',
      afterOn.mediaKeys.length >= 3,
      afterOn.mediaKeys,
    )

    // The tray icon itself is created/destroyed on demand; `trayActive` is read from the live
    // `Tray` handle, so this is a real teardown, not a stored flag.
    await evaluate(ws, `window.aurora.systemIntegration.set({ tray: false }).then((s) => JSON.stringify(s))`, 84)
    const trayOff = await status()
    await evaluate(ws, `window.aurora.systemIntegration.set({ tray: true }).then((s) => JSON.stringify(s))`, 85)
    const trayOn = await status()
    check(
      '系统集成: 托盘可以真的销毁并重建（不只是记住一个开关）',
      trayOff.trayActive === false && trayOn.trayActive === true,
      { off: trayOff.trayActive, on: trayOn.trayActive },
    )
  }

  /*
   * Favorite it through the real row button, so the restart phase has renderer-owned state to find.
   *
   * The route is set explicitly rather than inherited from whatever ran before: track rows only exist
   * on the search page, and a phase that happens to leave the app somewhere else would make this
   * silently do nothing (which is exactly what happened to it once).
   */
  await evaluate(ws, "location.hash = '#/search'; 'ok'", 42)
  await waitFor(ws, '.hero-search input')
  /*
   * The row is *waited for*, not slept past.
   *
   * Returning to the search page re-runs the last keyword, and the aggregate answers alongside four real
   * platforms — so a fixed 900 ms here measured the network rather than the feature and reported
   * `found: false` whenever the fixture row landed later than the sleep. Polling for the row and clicking
   * the moment it exists is the same thing a user does.
   */
  const favoriteProbe = `(() => {
     const row = [...document.querySelectorAll('.track-row')].find((r) => r.textContent.includes('打包内测试歌曲'))
     const button = row?.querySelector('.icon-action[title="收藏"]')
     button?.click()
     return JSON.stringify({
       found: Boolean(row),
       clicked: Boolean(button),
       rows: document.querySelectorAll('.track-row').length,
       status: document.querySelector('.search-status')?.textContent?.replace(/\\s+/g, ' ').trim().slice(0, 120) ?? '',
     })
   })()`
  let favorited = null
  for (let attempt = 0; attempt < 24; attempt += 1) {
    favorited = await evaluate(ws, favoriteProbe, 43 + attempt)
    if (String(favorited?.value).includes('"found":true')) break
    await delay(500)
  }
  check(
    '收藏：在歌曲行上真的点到了收藏按钮',
    (() => {
      try {
        const parsed = JSON.parse(String(favorited?.value ?? '{}'))
        return parsed.found === true && parsed.clicked === true
      } catch {
        return false
      }
    })(),
    favorited?.value,
  )
  await delay(700)

  /* ------------------------------------------------------------------ restart
   *
   * Quit the app and start it again against the same profile — the acceptance criterion is that a
   * source, the queue and the favourites are still there afterwards. The local HTTP source stays up,
   * because a restored queue may resolve its play URL again.
   */
  check('关闭主窗口后应用真的退出（脚本宿主窗口不会把它变成幽灵进程）', await closeApp(ws))
  ws.close()
  await delay(1200)
  launchApp()
  const second = await connect(isAppWindow)
  check('重启后重新连上渲染进程', Boolean(second))
  let ws2 = second?.ws ?? ws
  /*
   * After the restart, `ws` means "the connection to the app that is running now".
   *
   * The suite grew a second name (`ws2`) for the post-restart connection, and later sections kept being
   * written against the first one — which is closed by then. `WebSocket.send()` on a closed socket discards
   * silently, so those sections waited out a 30 s timeout every run and the tail of the suite never ran.
   * Re-pointing the original name here (and again on every reconnect) makes the two names mean the same
   * thing, so a section cannot be written against a dead line by accident.
   */
  ws = ws2

  /**
   * Reconnects when the app has replaced its renderer.
   *
   * A restart (or a crash) leaves the old socket closed, and every later evaluate would then wait out its
   * timeout — the run would lose its whole tail while reporting a healthy-looking score. Reconnecting is the
   * difference between "the instrument lost its line" and "the app is broken", and those must never look
   * alike.
   */
  async function liveSocket() {
    if (ws2 && ws2.readyState === 1) return ws2
    const again = await connect(isAppWindow)
    if (again?.ws) {
      ws2 = again.ws
      ws = ws2
      // The shell must be up before anything reads the page it is about to read.
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const mounted = await evaluate(ws2, "!!document.querySelector('.player-bar')", 900 + attempt, 8000).catch(() => null)
        if (mounted?.value === true) break
        await delay(500)
      }
    }
    return ws2
  }

  /** `evaluate`, over a connection that is guaranteed to be alive. */
  async function evaluateLive(expression, id, timeoutMs) {
    await liveSocket()
    return evaluate(ws2, expression, id, timeoutMs)
  }

  // The preload bridge exists before Vue mounts, and the queue is restored during mount — wait for
  // the shell, or the read would race the very thing being asserted.
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const mounted = await evaluate(ws2, "!!document.querySelector('.player-bar')", 500 + attempt, 8000).catch(
      () => null,
    )
    if (mounted?.value === true) break
    await delay(500)
  }
  await delay(800)

  const restored = await evaluate(
    ws2,
    `(async () => {
       const list = await window.aurora.sources.list()
       const mine = list.find((item) => item.id === ${JSON.stringify(sourceId)})
       const q = JSON.parse(localStorage.getItem('aurora:queue') ?? '{}')
       const favorites = JSON.parse(localStorage.getItem('aurora:favorites') ?? '[]')
       const snapshots = JSON.parse(localStorage.getItem('aurora:online-tracks') ?? '{}')
       const bar = document.querySelector('.player-bar')?.textContent ?? ''
       return JSON.stringify({
         source: mine ? mine.kind + ':' + mine.status + ':enabled=' + mine.enabled : 'missing',
         queued: Array.isArray(q.ids) ? q.ids.length : 0,
         favorited: Array.isArray(favorites) ? favorites.length : 0,
         snapshots: Object.keys(snapshots).length,
         inSnapshot: Array.isArray(q.ids) ? q.ids.every((id) => Object.keys(snapshots).includes(id)) : false,
         barShowsTrack: bar.includes('打包内测试歌曲'),
         bar: bar.replace(/\\s+/g, ' ').slice(0, 140),
       })
     })()`,
    44,
  )
  let restartState = {}
  try {
    restartState = JSON.parse(restored?.value ?? '{}')
  } catch {
    restartState = { raw: restored?.value }
  }
  check(
    '重启后脚本音源仍在（注册表 + 脚本文件从磁盘恢复，无需重装）',
    typeof restartState.source === 'string' && restartState.source.startsWith('script:'),
    restartState.source,
  )
  check('重启后收藏仍然存在', Number(restartState.favorited) >= 1, restartState.favorited)

  // The desktop-lyrics window is part of the restored session too: it was left enabled, so it must
  // come back on its own (window + persisted appearance), not just the setting.
  const lyricsAfterRestart = await findTarget((url) => url.includes('desktop-lyrics'), 20)
  const lyricsSetting = await evaluate(ws2, "window.aurora.desktopLyrics.options().then((o) => o.enabled + '/' + o.fontSize)", 71)
  check(
    '重启后桌面歌词自动回来（窗口 + 字号都恢复）',
    Boolean(lyricsAfterRestart) && lyricsSetting?.value === 'true/52',
    `${lyricsAfterRestart?.url ?? 'no window'} / ${lyricsSetting?.value}`,
  )
  await evaluate(ws2, "window.aurora.desktopLyrics.setEnabled(false)", 72)
  // Downloaded files and their task records are main-process state: both must survive a relaunch.
  const downloadsAfterRestart = await evaluate(
    ws2,
    "window.aurora.downloads.list().then((tasks) => JSON.stringify(tasks.map((t) => t.status + '|' + t.fileName)))",
    49,
  )
  check(
    '重启后下载任务记录仍然存在（索引在用户数据目录里）',
    String(downloadsAfterRestart?.value ?? '').includes('completed|'),
    downloadsAfterRestart?.value,
  )
  const fileAfterRestart = await stat(downloadedPath).then((info) => info.size).catch(() => -1)
  check('重启后已下载的文件仍在磁盘上', fileAfterRestart === downloadedBytes, fileAfterRestart)

  // Clearing finished tasks goes through the manager, and the downloaded file itself is left alone.
  await evaluate(ws2, "location.hash = '#/downloads'; 'ok'", 46)
  await waitFor(ws2, '.download-row, .view-header h1')
  await delay(700)
  await evaluate(ws2, "[...document.querySelectorAll('.view-actions button')].find((b) => b.textContent.includes('清除已结束'))?.click(); 'ok'", 47)
  await delay(600)
  const afterClear = await evaluate(ws2, "document.querySelectorAll('.download-row').length", 50)
  check('下载: 清除已结束会从列表移除任务（走真实按钮）', afterClear?.value === 0, afterClear?.value)
  check('下载: 清除任务不会删掉已经下载好的文件', await stat(downloadedPath).then((info) => info.size > 0).catch(() => false), downloadedBytes)
  await evaluate(ws2, "location.hash = '#/search'; 'ok'", 51)
  await waitFor(ws2, '.hero-search input')
  await delay(400)

  check('重启后队列快照仍然存在', Number(restartState.queued) >= 1, restartState.queued)
  check('重启后播放队列真的被恢复（播放栏显示上次那首）', restartState.barShowsTrack === true, restartState.barShowsTrack)

  /* ---------------------------------------------------------------------- 无歌词空态
   * The one branch the earlier passes cannot reach: a real song playing that really has no lyrics —
   * which the file downloaded above is (a plain audio file, nothing embedded, no .lrc beside it).
   * It is played by double-clicking the row, exactly as a user would.
   */
  await evaluate(ws2, "location.hash = '#/'; 'ok'", 53)
  await waitFor(ws2, '.track-row')
  await evaluate(
    ws2,
    "[...document.querySelectorAll('.track-row')][0]?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); 'ok'",
    53,
  )
  await delay(1600)
  await evaluate(ws2, "location.hash = '#/lyrics'; 'ok'", 53)
  await waitFor(ws2, '.lyrics-page')
  await delay(900)

  // Nothing to show on the lyric side must not leave a blank panel, so the page opens on 频谱律动.
  // Read before switching away, because that is the state the user lands on.
  const defaultView = await evaluate(
    ws2,
    "[...document.querySelectorAll('.lp-viewswitch button')].find((b) => b.classList.contains('active'))?.textContent?.trim() ?? ''",
    53,
  )
  check('无歌词时默认落到频谱视图', defaultView?.value === '频谱律动', defaultView?.value)

  // Reaching the empty state means switching to 歌词 first — the same click a user makes.
  await evaluate(
    ws2,
    "[...document.querySelectorAll('.lp-viewswitch button')].find((b) => b.textContent.includes('歌词'))?.click(); 'ok'",
    53,
  )
  await delay(400)

  const emptyPage = await evaluate(
    ws2,
    `(() => {
       const textOf = (selector) => document.querySelector(selector)?.textContent?.replace(/\\s+/g, ' ').trim() ?? ''
       return JSON.stringify({
         playing: textOf('.lp-title'),
         title: textOf('.lp-empty-title'),
         hint: textOf('.lp-empty-hint'),
         tooltip: textOf('.lp-tooltip'),
         actions: [...document.querySelectorAll('.lp-empty-actions button')].map((n) => n.textContent.trim()),
         activeView: [...document.querySelectorAll('.lp-viewswitch button')].find((b) => b.classList.contains('active'))?.textContent?.trim() ?? '',
         lines: document.querySelectorAll('.lyric-line').length,
       })
     })()`,
    53,
  )
  const emptyState = (() => {
    try {
      return JSON.parse(emptyPage?.value ?? '{}')
    } catch {
      return { raw: emptyPage?.value }
    }
  })()
  check('无歌词时有歌在播：显示主标题 / 说明 / ⓘ 与两个真实入口',
    ['纯音乐 / 暂无歌词', '暂无歌词'].includes(emptyState.title) &&
      String(emptyState.hint).includes('尚未匹配到 LRC 歌词文件') &&
      String(emptyState.tooltip).includes('联网查询公开歌词库') &&
      emptyState.actions?.some((text) => text.includes('手动导入 LRC 歌词')) &&
      emptyState.actions?.some((text) => text.includes('联网自动匹配')),
    JSON.stringify(emptyState),
  )
  check('切到歌词视图后确认无同步歌词', emptyState.lines === 0 && emptyState.activeView === '歌词', JSON.stringify({ lines: emptyState.lines, view: emptyState.activeView }))

  await evaluate(
    ws2,
    "[...document.querySelectorAll('.lp-empty-actions button')].find((b) => b.textContent.includes('联网自动匹配'))?.click(); 'ok'",
    53,
  )
  /*
   * 「联网自动匹配」 really goes to the public lyrics catalogues now, so its duration is the network's,
   * not a fixed number. Poll for the outcome instead of guessing a delay: either lyrics appeared, or
   * the page said — with the provider list — that nothing was found.
   */
  const readAutoState = () =>
    evaluate(
      ws2,
      `(() => JSON.stringify({
         lines: document.querySelectorAll('.lyric-line').length,
         note: document.querySelector('.lp-empty-note')?.textContent?.trim() ?? '',
         title: document.querySelector('.lp-empty-title')?.textContent?.trim() ?? '',
         toasts: [...document.querySelectorAll('[class*=toast]')].map((n) => n.textContent.trim()),
       }))()`,
      53,
    )
  const parseAuto = (raw) => {
    try {
      return JSON.parse(raw?.value ?? '{}')
    } catch {
      return { raw: raw?.value }
    }
  }
  let autoState = parseAuto(await readAutoState())
  for (let attempt = 0; attempt < 30 && (autoState.lines ?? 0) === 0; attempt += 1) {
    const settled =
      String(autoState.note).includes('这首歌都没有可用的歌词') &&
      autoState.toasts?.some((text) => text.includes('这首歌都没有可用的歌词'))
    if (settled) break
    await delay(700)
    autoState = parseAuto(await readAutoState())
  }
  check(
    '联网自动匹配真的发出请求，并如实报告结果',
    (autoState.lines ?? 0) > 0 ||
      (String(autoState.note).includes('这首歌都没有可用的歌词') &&
        autoState.toasts?.some((text) => text.includes('这首歌都没有可用的歌词'))),
    JSON.stringify(autoState),
  )

  /* ------------------------------------------------------------------- 歌词墨水与逐行状态
   *
   * 歌词的「画法」在这一节被当成功能来验，而不是看截图。一份带时间轴的 LRC 通过真实用户路径导入
   * （更多 → 导入歌词），然后按已知的播放位置读回真实 DOM：当前行必须**有且只有一行**，已唱行与
   * 未唱行必须分开，而当前行的颜色必须来自用户选中的那一档墨水 —— 换档必须真的改变被画出来的像素，
   * 换回来也必须真的换回去。
   */
  const importLrc = await evaluate(
    ws2,
    `(async () => {
       const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
       document.querySelector('.lp-more .glass-icon-button')?.click()
       await wait(250)
       const entry = [...document.querySelectorAll('.lp-menu button')].find((b) => b.textContent.includes('导入歌词'))
       entry?.click()
       await wait(300)
       const area = document.querySelector('.lyrics-textarea')
       if (!area) return 'no-modal'
       let lrc = ''
       for (let index = 0; index < 21; index += 1) {
         lrc += '[00:' + String(index).padStart(2, '0') + '.00]第 ' + (index + 1) + ' 行 測試歌詞' + '\\n'
       }
       area.value = lrc
       area.dispatchEvent(new Event('input', { bubbles: true }))
       await wait(150)
       document.querySelector('.modal-create .primary-button')?.click()
       await wait(1000)
       return area ? 'ok' : 'no-modal'
     })()`,
    53,
    45000,
  )

  /*
   * Page-side helpers, shared by every step below.
   *
   * Two of them exist because of failures this block found on its first run: the ink menu is a *toggle*, so
   * "click the button then click the option" double-toggles whenever the previous step left it open; and a
   * computed colour read right after a switch is a **transition sample**, not the recipe (the first run
   * compared an in-flight `rgb(252, 230, 202)` against the declared `rgb(255, 230, 198)`).
   */
  const INK_HELPERS = `
     const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
     /*
      * The lyric-colour choice lives in 设置 (the immersive page's header holds the three view options and
      * nothing else), so picking a mode means walking to the settings page and back. Both directions wait on
      * a real element rather than a fixed sleep.
      */
     const goSettings = async () => {
       location.hash = '#/settings'
       for (let attempt = 0; attempt < 40; attempt += 1) {
         if (document.querySelector('[data-ink-mode]')) return true
         await wait(150)
       }
       return false
     }
     const goLyrics = async () => {
       location.hash = '#/lyrics'
       for (let attempt = 0; attempt < 40; attempt += 1) {
         if (document.querySelector('.lyric-line')) return true
         await wait(150)
       }
       return false
     }
     const inkPick = async (mode) => {
       await goSettings()
       ;[...document.querySelectorAll('[data-ink-mode]')].find((node) => node.dataset.inkMode === mode)?.click()
       await wait(250)
       const picked = document.documentElement.dataset.lyricColor ?? ''
       await goLyrics()
       return picked
     }
     /**
      * 等到读者真的不再变化，再把值交出去。
      *
      * 连续三次相同，而不是两次：一条长缓出动画的最后一段每 120 ms 的变化小到两次采样读出来一模一样，
      * 于是过渡中的颜色被当成了最终颜色（实测读到 rgb(243, 231, 216) 而目标是 rgb(255, 230, 198)）。
      * 这类假红最贵的地方在于它看上去像“颜色设置没生效”。
      */
     const settled = async (reader) => {
       /* 先等一段比过渡的陡段更长的时间：这样最容易读到的“中间值”就被跳过了，不需要靠多次重试去撞。 */
       await wait(360)
       let previous = reader()
       let streak = 0
       for (let attempt = 0; attempt < 12; attempt += 1) {
         await wait(140)
         const current = reader()
         streak = current && current === previous ? streak + 1 : 0
         previous = current
         if (streak >= 1) return current
       }
       return previous
     }
     const inkTarget = () => {
       const node = document.querySelector('.lyric-line.active')
       return node ? getComputedStyle(node).color : ''
     }
     const settledColor = () => settled(inkTarget)
     /** 同一套规则用在透明度上：它和颜色一起过渡，分开取样就会得到一对反着的读数。 */
     const settledActiveOpacity = () =>
       settled(() => {
         const node = document.querySelector('.lyric-line.active')
         return node ? getComputedStyle(node).opacity : ''
       })
     const settledPastOpacity = () =>
       settled(() => {
         const node = [...document.querySelectorAll('.lyric-line')].find((candidate) => candidate.dataset.lyricState === 'past')
         return node ? getComputedStyle(node).opacity : ''
       })
   `

  /** Seeks to ~1.5 s and reports what the lyric panel actually painted there. */
  const lyricPaint = `(async () => {
     ${INK_HELPERS}
     /*
      * The transport is the one in PlayerBar: .transport > .progress-line, holding the elapsed span, the
      * range and the duration span. It used to be .transport-progress and the spans used to carry .time;
      * both went with the restructure, and because this probe only *uses* the range when it finds one, a
      * stale selector silently turned the seek off instead of failing. seeked is reported below so that
      * cannot happen again without the check noticing.
      */
     const range = document.querySelector('.transport .progress-line .progress-range')
     const stamps = [...document.querySelectorAll('.transport .progress-line span')].map((n) => n.textContent.trim())
     const parse = (text) => {
       const parts = String(text).split(':').map(Number)
       return parts.length === 2 && parts.every((value) => Number.isFinite(value)) ? parts[0] * 60 + parts[1] : 0
     }
     const duration = parse(stamps[1] ?? '')
     const target = Math.min(1.5, duration / 2)
     if (range && duration > 0) {
       range.value = String(Math.round((target / duration) * 1000))
       range.dispatchEvent(new Event('input', { bubbles: true }))
     }
     await wait(500)
     const lines = [...document.querySelectorAll('.lyric-line')]
     const active = document.querySelector('.lyric-line.active')
     return JSON.stringify({
       duration,
       target,
       seeked: Boolean(range) && duration > 0,
       lines: lines.length,
       active: lines.filter((node) => node.dataset.lyricState === 'active').length,
       past: lines.filter((node) => node.dataset.lyricState === 'past').length,
       future: lines.filter((node) => node.dataset.lyricState === 'future').length,
       activeText: active?.textContent?.trim() ?? '',
       firstText: lines[0]?.textContent?.trim() ?? '',
       activeColor: await settledColor(),
       pastOpacity: Number(await settledPastOpacity()) || -1,
       activeOpacity: Number(await settledActiveOpacity()) || -1,
     })
   })()`

  const readPaint = async (step) => {
    // 预算放宽：这个读取要等两次页面切换与一段过渡落地，而 30s 是“跑得快时够用”的那种默认值。
    const raw = await evaluate(ws2, lyricPaint, step, 45000)
    try {
      return JSON.parse(raw?.value ?? '{}')
    } catch {
      return { raw: raw?.value }
    }
  }

  const imported = await readPaint(54)
  check(
    '导入带时间轴的 LRC 后真的逐行渲染（走的是页面上的导入入口）',
    importLrc?.value === 'ok' && Number(imported.lines) >= 20 && imported.seeked === true,
    JSON.stringify({ entry: importLrc?.value, lines: imported.lines, duration: imported.duration, seeked: imported.seeked }),
  )
  /*
   * 繁体转简体放在解析入口（`parseLyricsText`），所以这条断言验的是「用户导入一份繁体歌词，页面上看到的是
   * 简体」——不是直接调那个函数，而是走真实的导入入口再读真实 DOM。
   */
  check(
    '导入的繁体 LRC 渲染成简体',
    imported.firstText === '第 1 行 测试歌词',
    JSON.stringify({ firstText: imported.firstText }),
  )
  check(
    '播放位置只让一行成为当前行，已唱/未唱分开（不是所有行同一个灰）',
    Number(imported.active) === 1 &&
      Number(imported.past) >= 1 &&
      Number(imported.future) >= 5 &&
      Number(imported.pastOpacity) > 0 &&
      Number(imported.pastOpacity) < Number(imported.activeOpacity),
    JSON.stringify({ active: imported.active, past: imported.past, future: imported.future, pastOpacity: imported.pastOpacity, activeOpacity: imported.activeOpacity, at: imported.target }),
  )

  /*
   * 墨水档位：菜单里列出的每一档都必须在选项表里，换档必须改变当前行的颜色，换回来必须换回去。
   *
   * `#ffe6c6`（暖白）与自定义输入的颜色是写在样式表里的常量，所以直接断言解析后的 rgb —— 这就把
   * 「选项表」「样式表配方」「真正被画出来的那一个像素」串成了一条链。
   */
  const inkMenu = await evaluate(
    ws2,     `(async () => {
       ${INK_HELPERS}
       await goSettings()
       const options = [...document.querySelectorAll('[data-ink-mode]')].map((node) => ({
         mode: node.dataset.inkMode,
         label: node.textContent?.replace(/\\s+/g, ' ').trim() ?? '',
         marked: node.classList.contains('active'),
         swatch: getComputedStyle(node.querySelector('.lp-ink-swatch')).color,
       }))
       const mode = document.documentElement.dataset.lyricColor ?? ''
       /*
        * The immersive page's own header, checked here because it is what this round changed: it must hold
        * the three view options and *no* fourth control. The first version of this feature had added an ink
        * button to that row; the colour choice now lives on this page instead.
        */
       await goLyrics()
       const switcher = document.querySelector('.lp-viewswitch')
       const header = document.querySelector('.lp-panel-head')
       return JSON.stringify({
         options,
         mode,
         viewOptions: switcher ? [...switcher.querySelectorAll('button')].map((node) => node.textContent.trim()) : [],
         headerButtons: header ? [...header.querySelectorAll('button')].length : -1,
         inkOnLyricPage: document.querySelectorAll('.lyrics-page .lp-ink').length,
       })
     })()`,
    54,
  )
  const inkState = (() => {
    try {
      return JSON.parse(inkMenu?.value ?? '{}')
    } catch {
      return { raw: inkMenu?.value }
    }
  })()
  check(
    '设置页的歌词颜色列出全部五档，当前档被标出（默认自动）',
    (inkState.options ?? []).length === 5 &&
      inkState.mode === 'auto' &&
      (inkState.options ?? []).filter((option) => option.marked).length === 1 &&
      (inkState.options ?? []).find((option) => option.marked)?.mode === 'auto' &&
      (inkState.options ?? []).every((option) => option.mode && option.label),
    JSON.stringify(inkState.options),
  )
  check(
    '每档的色块就是它会画出的颜色（不是同一个灰方块换名字）',
    new Set((inkState.options ?? []).map((option) => option.swatch)).size >= 4,
    JSON.stringify((inkState.options ?? []).map((option) => `${option.mode}:${option.swatch}`)),
  )
  check(
    '沉浸页右上角只有歌词/频谱律动/拟真唱片三个选项，没有多出来的按钮',
    JSON.stringify(inkState.viewOptions) === JSON.stringify(['歌词', '频谱律动', '拟真唱片']) &&
      Number(inkState.headerButtons) === 3 &&
      Number(inkState.inkOnLyricPage) === 0,
    JSON.stringify({ viewOptions: inkState.viewOptions, headerButtons: inkState.headerButtons, inkOnLyricPage: inkState.inkOnLyricPage }),
  )

  const warmPaint = await evaluate(
    ws2,     `(async () => {
       ${INK_HELPERS}
       return await inkPick('warm')
     })()`,
    54,
    45000,
  )
  const warm = await readPaint(54)
  check(
    '切到「暖白」后，正在唱的那一行真的换成了暖白色',
    warmPaint?.value === 'warm' && warm.activeColor === 'rgb(255, 230, 198)' && warm.activeColor !== imported.activeColor,
    JSON.stringify({ auto: imported.activeColor, warm: warm.activeColor, mode: warmPaint?.value }),
  )

  const customPaint = await evaluate(
    ws2,     `(async () => {
       ${INK_HELPERS}
       await inkPick('custom')
       await goSettings()
       const input = document.querySelector('input[type="color"]')
       if (!input) return 'no-input'
       input.value = '#7fd6a1'
       input.dispatchEvent(new Event('input', { bubbles: true }))
       await wait(400)
       const picked = document.documentElement.dataset.lyricColor ?? ''
       await goLyrics()
       return picked
     })()`,
    54,
    45000,
  )
  const custom = await readPaint(54)
  const inkStored = await evaluate(
    ws2,
    "JSON.stringify({ mode: document.documentElement.dataset.lyricColor ?? '', stored: localStorage.getItem('aurora:lyric-color') ?? '', custom: localStorage.getItem('aurora:lyric-custom') ?? '', root: getComputedStyle(document.documentElement).getPropertyValue('--lyric-custom').trim() })",
    54,
  )
  const inkSaved = (() => {
    try {
      return JSON.parse(inkStored?.value ?? '{}')
    } catch {
      return {}
    }
  })()
  check(
    '自定义颜色真的生效：选择器给的色号被采纳并画到当前行上',
    customPaint?.value === 'custom' && custom.activeColor === 'rgb(127, 214, 161)' && inkSaved.root === '#7fd6a1',
    JSON.stringify({ colour: custom.activeColor, root: inkSaved.root, mode: customPaint?.value }),
  )
  check(
    '墨水选择被记住（重启后读的是同一档，不是每次回到默认）',
    inkSaved.mode === 'custom' && inkSaved.stored === 'custom' && inkSaved.custom === '#7fd6a1',
    JSON.stringify(inkSaved),
  )

  const backToAuto = await evaluate(
    ws2,     `(async () => {
       ${INK_HELPERS}
       return await inkPick('auto')
     })()`,
    54,
    45000,
  )
  const autoAgain = await readPaint(54)
  check(
    '切回「自动」后回到主题染色（每一档都是可逆的，不是单向的门）',
    backToAuto?.value === 'auto' && autoAgain.activeColor === imported.activeColor,
    JSON.stringify({ first: imported.activeColor, again: autoAgain.activeColor, mode: backToAuto?.value }),
  )

  /*
   * 逐字歌词真的跟着音频推进（卡拉 OK 扫描），而且没有逐字时间轴时不会伪造。
   *
   * Three separate claims, because they fail for different reasons:
   *
   *  - the lyric sheet fades at both edges *and the fade is on the scroll container* — a mask on the list
   *    inside it would fade the first and last lines of the file instead of the two visible edges;
   *  - the per-word fill moves with the clock. The fixture's first word lasts 1.1 s and the two samples are
   *    ~300 ms apart from a known seek point, so both land inside the same word and the direction is
   *    unambiguous (crossing a word boundary would reset the fill to 0 and look like "not advancing");
   *  - a line with no word timings renders as plain text with **no** word spans at all: the sweep is only
   *    ever drawn from real timing data.
   */
  const karaoke = await evaluate(
    ws2,
    `(async () => {
       /*
        * Wrapped in a try/catch that *returns* the message: a probe that throws would otherwise reject the CDP
        * call and surface as an empty detail, which reads like "the feature is missing" when it is really
        * "the probe fell over".
        */
       try {
       const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
       const nl = String.fromCharCode(10)
       /*
        * Word timings only exist if someone imported them, so this goes through the user's own entry — and the
        * opening is *polled*, because the menu and the modal both animate in: a fixed sleep was measured
        * failing on a loaded machine (the modal simply had not been created yet) and reported as "no lyrics"
        * rather than as the timing problem it was.
        */
       const openImport = async () => {
         for (let attempt = 0; attempt < 3; attempt += 1) {
           document.querySelector('.lp-more .glass-icon-button')?.click()
           await wait(300)
           ;[...document.querySelectorAll('.lp-menu button')].find((b) => b.textContent.includes('导入歌词'))?.click()
           for (let tick = 0; tick < 10; tick += 1) {
             await wait(150)
             if (document.querySelector('.lyrics-textarea')) return true
           }
         }
         return false
       }
       const opened = await openImport()
       const area = document.querySelector('.lyrics-textarea')
       if (!opened || !area) {
         /*
          * Self-describing failure: the import entry only exists for a *current* track, so "no modal" almost
          * always means this step ran with nothing playing — and saying so beats a detail blob of undefineds.
          */
         return JSON.stringify({
           error: 'no-modal',
           hash: location.hash,
           emptyState: document.querySelector('.lp-empty-title')?.textContent?.trim() ?? '',
           hasTrack: Boolean(document.querySelector('.track-row')),
         })
       }
       const rows = [
         '[00:00.00]<00:00.00>打包<00:01.10>内<00:02.20>歌词',
         '[00:02.60]第三行没有逐字时间',
       ]
       area.value = rows.join(nl)
       area.dispatchEvent(new Event('input', { bubbles: true }))
       await wait(150)
       document.querySelector('.modal-create .primary-button')?.click()
       await wait(1300)

       const readFill = () => {
         for (const word of document.querySelectorAll('.lyric-word')) {
           const value = word.style.getPropertyValue('--word-fill').trim()
           if (value) return value
         }
         return ''
       }
       const percent = (value) => Number.parseFloat(value)
       /*
        * The sweep is measured by *seeking*, not by waiting for the audio to run.
        *
        * Two earlier versions of this check sampled the fill 300 ms apart while playing, and both were flaky for
        * reasons that had nothing to do with the feature: the fixture audio is three seconds long, so by the time
        * this step runs the track has usually played out (pressing play on an ended track does nothing), and a
        * sample that crosses a word boundary resets to 0 and reads as "not advancing".
        *
        * A seek is deterministic and works while paused: the word's own timings decide the fill, so the position
        * is the input and the fill is the output. The two seeks below land inside the first word (0 → 1.1 s).
        */
       const range = document.querySelector('.transport .progress-line .progress-range')
       const duration = Number(
         String(document.querySelectorAll('.transport .progress-line span')[1]?.textContent ?? '')
           .split(':')
           .reduce((a, b) => a * 60 + Number(b), 0),
       )
       const clock = () => Number(range?.value ?? -1)
       const seekTo = (seconds) => {
         if (!range || !duration) return false
         range.value = String(Math.round((seconds / duration) * 1000))
         range.dispatchEvent(new Event('input', { bubbles: true }))
         return true
       }
       const seeked = seekTo(0.05) && seekTo(0.05)
       await wait(260)
       const first = readFill()
       const clockBefore = clock()
       seekTo(0.9)
       await wait(280)
       const second = readFill()
       const clockAfter = clock()

       const scroll = document.querySelector('.lyrics-scroll')
       const mask = scroll ? getComputedStyle(scroll).maskImage || getComputedStyle(scroll).webkitMaskImage : ''

       /*
        * A user scroll is what summons 「回到当前歌词」, so the button is provoked the way a user does — and
        * the target matters: the wheel is listened for on the viewport, and a wheel dispatched on the
        * *parent* scroll container never reaches it (events bubble up, not down).
        */
       document.querySelector('.lyrics-viewport')?.dispatchEvent(new WheelEvent('wheel', { deltaY: 320, bubbles: true }))
       await wait(420)
       const pill = document.querySelector('.lyrics-resume')
       const pillInside = Boolean(pill && scroll?.contains(pill))
       const pillOpacity = pill ? Number(getComputedStyle(pill).opacity) : -1
       pill?.click()
       await wait(650)

       const plainLine = [...document.querySelectorAll('.lyric-line')].find((line) => line.querySelector('.lyric-text'))
       return JSON.stringify({
         lines: document.querySelectorAll('.lyric-line').length,
         words: document.querySelectorAll('.lyric-word').length,
         first,
         second,
         advanced: Math.round((percent(second) - percent(first)) * 10) / 10,
         seeked,
         duration,
         clockBefore,
         clockAfter,
         mask: mask && mask !== 'none' ? 'set' : 'none',
         pillAppeared: Boolean(pill),
         pillInsideMaskedScroll: pillInside,
         pillOpacity,
         pillDismissed: !document.querySelector('.lyrics-resume'),
         plainLineWords: plainLine ? plainLine.querySelectorAll('.lyric-word').length : -1,
       })
       } catch (error) {
         return JSON.stringify({ error: String((error && error.message) || error) })
       }
     })()`,
    /*
     * A CDP id of its own, and it is load-bearing: responses are matched by id, and an *orphaned* listener
     * (from a call that timed out earlier on the same id) swallows the next response carrying it. This probe
     * followed the ink steps, which share id 54, and every run it came back as an empty detail — which read as
     * "the feature is missing" when the reply was simply being eaten.
     *
     * 90 s rather than the default 30 s for the same class of reason: this step opens a menu and a modal,
     * imports, waits for the lyric to re-render and then drives the transport twice.
     */
    300,
    90000,
  )
  const karaokeState = (() => {
    try {
      return JSON.parse(karaoke?.value ?? '{}')
    } catch {
      return { raw: karaoke?.value }
    }
  })()
  check(
    '歌词舞台上下渐隐（遮罩在滚动区上），「回到当前歌词」在遮罩之外且能收回',
    karaokeState.mask === 'set' &&
      karaokeState.pillAppeared === true &&
      karaokeState.pillInsideMaskedScroll === false &&
      karaokeState.pillOpacity === 1 &&
      karaokeState.pillDismissed === true,
    JSON.stringify({
      mask: karaokeState.mask,
      pill: karaokeState.pillAppeared,
      inside: karaokeState.pillInsideMaskedScroll,
      opacity: karaokeState.pillOpacity,
      dismissed: karaokeState.pillDismissed,
      // The raw state, so a probe that never got as far as measuring says why instead of showing undefineds.
      raw: karaokeState.error ?? karaokeState.raw,
    }),
  )
  check(
    '逐字歌词的填充由播放位置决定（同一个词内，向后跳转后填充明显推进）',
    Number(karaokeState.words) >= 2 &&
      karaokeState.seeked === true &&
      karaokeState.first !== '' &&
      karaokeState.second !== '' &&
      // 0.05 s into a 1.1 s word is ~16%; 0.9 s is ~93%. The margins leave room for the seek not landing
      // exactly, while still failing for a fill that is stuck or computed from the wrong word.
      Number(karaokeState.advanced) > 30 &&
      Number.parseFloat(karaokeState.second) > 70,
    JSON.stringify({
      words: karaokeState.words,
      first: karaokeState.first,
      second: karaokeState.second,
      advanced: karaokeState.advanced,
      duration: karaokeState.duration,
    }),
  )
  check(
    '没有逐字时间轴的歌词不会被伪造逐字填充（整行高亮，无词元）',
    Number(karaokeState.plainLineWords) === 0 && Number(karaokeState.lines) >= 2,
    JSON.stringify({ lines: karaokeState.lines, plainLineWords: karaokeState.plainLineWords }),
  )

  /*
   * Does the sheet *move*?
   *
   * This is measured rather than eyeballed because "歌词不自动往上走" is invisible in the source: the active line
   * was highlighted, the edges faded, the container was `overflow-y: auto` — and the offset was pinned at 0 for
   * a whole song, because the centring maths measured against a box as tall as the song. The two checks below
   * are the contract that broke: the sung line lands on the container's optical centre (and the column reserves
   * no room for a scrollbar), and while the song plays the offset rises on its own with no backtracking.
   *
   * The lyric is re-imported here as 30 lines 100 ms apart: the fixture track is three seconds long, so a
   * realistic spacing would fit entirely on one screen and there would be nothing to scroll — the question would
   * be unanswerable rather than answered.
   */
  const follow = await evaluate(
    ws2,
    `(async () => {
       const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
       const metrics = () => {
         const container = document.querySelector('.lyrics-scroll')
         if (!container) return { error: 'no-sheet' }
         const line = document.querySelector('.lyric-line.active')
         const containerRect = container.getBoundingClientRect()
         const lineRect = line ? line.getBoundingClientRect() : null
         return {
           top: Math.round(container.scrollTop),
           content: container.scrollHeight,
           view: container.clientHeight,
           /* Non-zero means the column still reserves a gutter for a bar it is not supposed to draw. */
           gutter: container.offsetWidth - container.clientWidth,
           off: lineRect
             ? Math.round(lineRect.top + lineRect.height / 2 - (containerRect.top + containerRect.height / 2))
             : null,
           text: line ? line.textContent.trim().slice(0, 6) : '',
         }
       }
       try {
         document.querySelector('.lp-more .glass-icon-button')?.click()
         await wait(250)
         ;[...document.querySelectorAll('.lp-menu button')].find((b) => b.textContent.includes('导入歌词'))?.click()
         await wait(350)
         const area = document.querySelector('.lyrics-textarea')
         if (!area) return JSON.stringify({ error: 'no-modal' })
         /* The line separator is built from its code point: this block is a template literal, and a backslash
            escape here would be consumed by the *outer* template before the page ever parses it. */
         const newline = String.fromCharCode(10)
         let lrc = ''
         for (let index = 0; index < 30; index += 1) {
           const at = index / 10
           const seconds = at.toFixed(2)
           lrc += '[00:' + (seconds.length === 5 ? seconds : '0' + seconds) + ']第 ' + (index + 1) + ' 行 滚动测试' + newline
         }
         area.value = lrc
         area.dispatchEvent(new Event('input', { bubbles: true }))
         await wait(200)
         document.querySelector('.modal-create .primary-button')?.click()
         await wait(1200)
         if (!(document.querySelector('.lyric-line')?.textContent ?? '').includes('滚动测试')) {
           return JSON.stringify({ error: 'import-failed' })
         }

         const range = document.querySelector('.progress-range')
         if (!range) return JSON.stringify({ error: 'no-transport' })
         const seek = async (permille) => {
           range.value = String(permille)
           range.dispatchEvent(new Event('input', { bubbles: true }))
           await wait(1200)
         }
         const setPlaying = async (want) => {
           const button = document.querySelector('.player-bar .play-button')
           const playing = String(button?.title ?? '').includes('暂停')
           if (playing !== want) {
             button?.click()
             await wait(500)
           }
           return String(document.querySelector('.player-bar .play-button')?.title ?? '').includes('暂停')
         }

         /*
          * The transport is *proven moving* before anything is parked on it.
          *
          * The fixture track is three seconds long and the suite has played it several times by now, and a
          * finished element leaves the play button reading 暂停 while its clock sits still (the same hazard the
          * playback checks carry a helper for). Pressing play then restarts from zero — which shows up as the
          * lyric *going backwards*, i.e. as "the follow is broken" when it is the measurement that is wrong.
          */
         let moving = false
         for (let attempt = 0; attempt < 4 && !moving; attempt += 1) {
           await setPlaying(true)
           const started = Number(range.value)
           await wait(350)
           moving = Number(range.value) > started + 20
           if (!moving) {
             await setPlaying(false)
             range.value = '0'
             range.dispatchEvent(new Event('input', { bubbles: true }))
             await wait(300)
           }
         }

         /* Read while paused: a running clock drifts between the seek and the reading, which at 100 ms per line
            is several lines of target movement. */
         await setPlaying(false)
         await seek(300)
         const upper = metrics()
         await seek(700)
         const lower = metrics()

         /*
          * Park *paused*, and give the glide time to arrive before playing.
          *
          * Both halves matter. Parked while playing, the sheet is still travelling toward the previous line when
          * the clock is yanked backwards, so the first samples are the tail of an upward move and read as
          * "backwards steps" — a correct response to the seek, mistaken for a defect. Parked while paused, the
          * sheet lands exactly on the line and stays, and the sampling window then contains nothing but the
          * clock's own forward motion. 12 samples ≈ 1.6 s keeps a 3-second fixture from running out and looping
          * inside the window.
          */
         range.value = '120'
         range.dispatchEvent(new Event('input', { bubbles: true }))
         await wait(900)
         const before = metrics()
         const resumed = await setPlaying(true)
         let backwards = 0
         let maxBackStep = 0
         let previous = -1
         let settled = 0
         let stableTop = -1
         let after = before
         /*
          * Poll rather than sample once: on a loaded machine the audio clock advances slower than the wall
          * clock, so a single reading after a fixed wait measures how busy the box was. The loop stops as soon as
          * the sheet has arrived, and the assertion below accepts either a centred line or a line that genuinely
          * cannot be centred (the ends of a lyric have nothing above/below them).
          */
         for (let tick = 0; tick < 12; tick += 1) {
           const sample = metrics()
           if (previous >= 0 && sample.top < previous) {
             backwards += 1
             maxBackStep = Math.max(maxBackStep, previous - sample.top)
           }
           previous = sample.top
           after = sample
           /* Consecutive readings that agree on a *centred* offset: that is what "has arrived" means here. */
           if (sample.top === stableTop && Math.abs(Number(sample.off)) <= 6) settled += 1
           else settled = 0
           stableTop = sample.top
           if (settled >= 2 && sample.text !== before.text) break
           await wait(130)
         }
         return JSON.stringify({ upper, lower, before, after, resumed, moving, backwards, maxBackStep })
       } catch (error) {
         return JSON.stringify({ error: String((error && error.message) || error) })
       }
     })()`,
    320,
    90000,
  )
  const followState = (() => {
    try {
      return JSON.parse(follow?.value ?? '{}')
    } catch {
      return { raw: follow?.value }
    }
  })()
  check(
    '歌词跟着播放位置走：当前行落在滚动区正中，两端不占滚动条',
    followState.upper?.gutter === 0 &&
      followState.lower?.gutter === 0 &&
      Math.abs(Number(followState.upper?.off)) <= 6 &&
      Number(followState.upper?.top) > 60 &&
      // Whether the far end can be centred depends on the window height (there is nothing below the last
      // line), so the assertion is that it moved *down the sheet*, not that it is still centred.
      Number(followState.lower?.top) > Number(followState.upper?.top) + 150,
    JSON.stringify({
      upper: followState.upper,
      lower: followState.lower,
      raw: followState.error,
    }),
  )
  /*
   * "It follows" is asserted as the real invariant: after the clock advanced the lyrics on its own, the sheet
   * sits where that line belongs — centred, or at the end of its travel when there is nothing left to scroll
   * (a lyric's first lines and last lines genuinely cannot be centred). Asserting a pixel delta instead would
   * measure how fast the machine was, not whether the follow works.
   */
  /*
   * This lyric is a deliberate stress: a line every 100 ms, i.e. ten times faster than real material, so the
   * target moves ~460 px/s and the glide lags it by design (τ × speed ≈ 60 px). What is asserted is therefore
   * the direction and the bound — the sheet travels *down the song* on its own, keeps up within a couple of
   * lines, and never jumps back: any reversal bigger than a line would mean it snapped somewhere stale.
   *
   * A few pixels of reversal are legitimate rather than a defect: when the sung line changes, the line that
   * stops being active shrinks back (the active one is a larger font), which lifts the content above the new
   * line by half that difference — so the sheet re-settles upward by a few pixels on every change.
   */
  const afterTop = Number(followState.after?.top)
  check(
    '无人干预时歌词自己往上走（播放驱动，且不回跳，最终落在当前行附近）',
    followState.resumed === true &&
      followState.moving === true &&
      followState.after?.text !== followState.before?.text &&
      afterTop > Number(followState.before?.top) + 100 &&
      Math.abs(Number(followState.after?.off)) <= 120 &&
      Number(followState.maxBackStep) <= 24,
    JSON.stringify({
      resumed: followState.resumed,
      moving: followState.moving,
      before: followState.before?.text,
      after: followState.after?.text,
      top: [followState.before?.top, followState.after?.top],
      off: followState.after?.off,
      backwards: [followState.backwards, followState.maxBackStep],
    }),
  )

  /*
   * The URL guard, proved end to end.
   *
   * A source is free to return any string as a cover, so the fixture serves a row whose cover is
   * `javascript:alert(1)` for the keyword `hostile`. It must not appear in a `src`, a background
   * `url()` or an `href` — the row falls back to the gradient derived from its id.
   *
   * Placed last on purpose: it replaces the search results, and every playback assertion above acts
   * on the normal fixture row.
   */
  await evaluate(ws2, "location.hash = '#/search'; 'ok'", 52)
  await waitFor(ws2, '.hero-search input')
  await evaluate(
    ws2,
    `(() => {
       const input = document.querySelector('.hero-search input')
       if (!input) return 'no-input'
       input.value = 'hostile'
       input.dispatchEvent(new Event('input', { bubbles: true }))
       input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }))
       return 'ok'
     })()`,
    52,
  )
  /*
   * 等结果行出现，而不是固定等 2.6 秒。
   *
   * 搜索这一趟要经过 渲染层 → 桥 → 主进程 → 本地 HTTP stub；窗口被带到前台、视觉引擎按满帧跑之后
   * 它慢了一点，这条会读到“正在搜索…”的空列表并失败，而应用其实是好的。超时仍然会让“真的没结果”
   * 失败——没有行就没有通过。
   */
  for (let waited = 0; waited < 15000; waited += 500) {
    const ready = await evaluate(
      ws2,
      "Boolean([...document.querySelectorAll('.track-row')].find((row) => row.textContent.includes('恶意封面测试')))",
      78,
    )
    if (ready?.value === true) break
    await delay(500)
  }
  const hostile = await evaluate(
    ws2,
    `(() => {
       const row = [...document.querySelectorAll('.track-row')].find((r) => r.textContent.includes('恶意封面测试'))
       if (!row) return JSON.stringify({ row: false, page: document.querySelector('.search-status')?.textContent?.trim() ?? '' })
       const cover = row.querySelector('.row-cover')
       return JSON.stringify({
         row: true,
         background: cover ? getComputedStyle(cover).backgroundImage : '',
         inline: row.outerHTML.includes('javascript:') || row.outerHTML.includes('file://'),
         bodySrc: [...document.querySelectorAll('[src]')].map((n) => n.getAttribute('src')).filter((s) => s && (s.startsWith('javascript:') || s.startsWith('file:'))).length,
         bodyHref: [...document.querySelectorAll('a[href]')].map((n) => n.getAttribute('href')).filter((h) => h && (h.startsWith('javascript:') || h.startsWith('file:'))).length,
       })
     })()`,
    52,
  )
  const hostileState = (() => {
    try {
      return JSON.parse(hostile?.value ?? '{}')
    } catch {
      return { raw: hostile?.value }
    }
  })()
  check(
    '恶意封面（javascript:）不会进入 src / style / href',
    hostileState.row === true &&
      hostileState.inline === false &&
      hostileState.bodySrc === 0 &&
      hostileState.bodyHref === 0 &&
      !String(hostileState.background).includes('javascript:') &&
      !String(hostileState.background).includes('file:'),
    JSON.stringify(hostileState),
  )
  check(
    '被拒绝的封面回退为按曲目 id 生成的渐变',
    String(hostileState.background).includes('linear-gradient'),
    String(hostileState.background).slice(0, 80),
  )

  /*
   * 歌曲切换 → 主题转场，以及音量变化 → 轻微视觉反馈。
   *
   * **Asserted last on purpose.** Switching the current song *is* the thing under test, and doing it earlier
   * changes what every later playback check is looking at — the first version of this block sat in the
   * middle of the suite and made the immersive-page checks run against a file with no cover and no lyrics
   * (four convincing-looking failures that were only my own ordering mistake).
   *
   * Both cues are *moments*, not states, so both are driven through the real UI — a double-click on a
   * library row (how a user starts a song) and an `input` event on the volume slider — and read back off the
   * document root. Nothing here writes the attributes it asserts on.
   */
  /*
   * The switch has to be a switch: by this point the local file is the current track, so re-playing the one
   * library row would be the same id and (correctly) no transition. Searching for the fixture source's row
   * and playing *that* is a genuine identity change, and it is how a user does it too.
   */
  await evaluate(ws2, "location.hash = '#/search'; 'ok'", 55)
  await waitFor(ws2, '.hero-search input')
  await evaluate(
    ws2,
    `(() => {
       const input = document.querySelector('.hero-search input')
       if (!input) return 'no-input'
       input.value = '打包测试'
       input.dispatchEvent(new Event('input', { bubbles: true }))
       input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }))
       return 'ok'
     })()`,
    55,
  )
  await delay(2600)
  await waitFor(ws2, '.track-row')
  await delay(300)
  const switchProbe = await evaluate(
    ws2,
    `(async () => {
       const root = document.documentElement
       /*
        * Put the app in a level where this signal exists.
        *
        * 换歌转场 和 音量反馈 都在 节能 之下有意关闭（那是那一档的承诺），所以如果负载看护层在这台机器上真的
        * 降过档，这里会读到“没反应”——同一份代码在安静机器上是绿的。这条检查测的是转场本身，所以它自己先确保
        * 前置条件成立，并把当前档位写进结果里：将来真的降档了，报告里能看出原因，而不是一个空字符串。
        */
       if (document.documentElement.dataset.anim !== 'standard' && document.documentElement.dataset.anim !== 'immersive') {
         const back = location.hash
         location.hash = '#/settings'
         await new Promise((resolve) => setTimeout(resolve, 800))
         document.querySelector('.segmented button[data-level="standard"]')?.click()
         await new Promise((resolve) => setTimeout(resolve, 500))
         location.hash = back || '#/library'
         await new Promise((resolve) => setTimeout(resolve, 900))
       }
       const level = document.documentElement.dataset.anim ?? ''
       const before = root.dataset.scene ?? ''
       const titleBefore = document.querySelector('.now-playing .now-meta strong')?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
       const row = document.querySelector('.track-row')
       row?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
       let seen = ''
       let sweep = ''
       let duration = ''
       for (let attempt = 0; attempt < 25; attempt += 1) {
         await new Promise((resolve) => setTimeout(resolve, 40))
         if (root.dataset.scene === 'switch') {
           seen = 'switch'
           const node = document.querySelector('.scene-sweep')
           const style = node ? getComputedStyle(node) : null
           sweep = style ? style.animationName : ''
           duration = style ? style.animationDuration : ''
           break
         }
       }
       // Read back so the detail explains *why* the sweep fired (or did not): which song the double-click
       // actually started, next to the one that was current a moment earlier.
       const title = document.querySelector('.now-playing .now-meta strong')?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
       return JSON.stringify({
         level,
         before,
         seen,
         sweep,
         duration,
         titleBefore,
         title,
         changed: title !== titleBefore,
         rows: document.querySelectorAll('.track-row').length,
       })
     })()`,
    55,
  )
  const trackSwitch = (() => {
    try {
      return JSON.parse(switchProbe?.value ?? '{}')
    } catch {
      return {}
    }
  })()
  check(
    '播放另一首真的换了歌，并且空间做了一次转场（写的是 data-scene，不是一个动画类）',
    trackSwitch.changed === true && trackSwitch.seen === 'switch',
    JSON.stringify(trackSwitch),
  )
  check(
    '换歌转场真的在跑这一主题的光幕动画（有名字也有时长）',
    String(trackSwitch.sweep).startsWith('fx-scene-veil') && parseFloat(trackSwitch.duration) > 0.5,
    JSON.stringify({ sweep: trackSwitch.sweep, duration: trackSwitch.duration, level: trackSwitch.level }),
  )

  const volumeProbe = await evaluate(
    ws2,
    `(async () => {
       const slider = document.querySelector('.volume-slider')
       if (!slider) return JSON.stringify({ slider: false })
       const start = Number(slider.value)
       const target = start > 0.5 ? 0.2 : 0.9
       slider.value = String(target)
       slider.dispatchEvent(new Event('input', { bubbles: true }))
       await new Promise((resolve) => setTimeout(resolve, 120))
       const root = document.documentElement
       const style = getComputedStyle(root)
       const level = style.getPropertyValue('--volume-level').trim()
       const delta = style.getPropertyValue('--volume-delta').trim()
       const animation = getComputedStyle(slider).animationName
       const duration = getComputedStyle(slider).animationDuration
       const direction = root.dataset.volume ?? ''
       await new Promise((resolve) => setTimeout(resolve, 700))
       return JSON.stringify({
         slider: true,
         target,
         level,
         delta,
         animation,
         duration,
         direction,
         // The level these numbers were measured at: 节能 turns both signals off on purpose, so a failure
         // here is only about the signal if the level is one that promises it.
         anim: document.documentElement.dataset.anim ?? '',
         cleared: document.documentElement.dataset.volume ?? '',
         resetDelta: getComputedStyle(root).getPropertyValue('--volume-delta').trim(),
         shown: document.querySelector('.volume-value')?.textContent?.trim() ?? '',
       })
     })()`,
    56,
  )
  const volume = (() => {
    try {
      return JSON.parse(volumeProbe?.value ?? '{}')
    } catch {
      return {}
    }
  })()
  check(
    '拖动音量写出的绝对位置与真实滑块值一致（不是另存了一份数）',
    volume.slider === true &&
      Math.abs(Number(volume.level) - Number(volume.target)) < 0.02 &&
      volume.shown === `${Math.round(Number(volume.target) * 100)}%`,
    JSON.stringify({ level: volume.level, target: volume.target, shown: volume.shown }),
  )
  check(
    '音量变化产生方向性的轻微反应（调大与调小两条不同的动画）',
    (volume.direction === 'up' && String(volume.animation).startsWith('fx-volume-up')) ||
      (volume.direction === 'down' && String(volume.animation).startsWith('fx-volume-down')),
    JSON.stringify({ direction: volume.direction, animation: volume.animation, duration: volume.duration, level: volume.anim }),
  )
  check(
    '反馈幅度来自这次移动了多少（--volume-delta 非零），停下后自行收回',
    Number(volume.delta) > 0 && volume.cleared === '' && volume.resetDelta === '0',
    JSON.stringify({ delta: volume.delta, cleared: volume.cleared, resetDelta: volume.resetDelta }),
  )

  /*
   * ---------------------------------------------------------------- 声音：EQ / 响度 / 设备 / 衔接 / 睡眠
   *
   * These are the checks the sound block did not have. They assert the three things that can silently be
   * fake: a switch that stores but never reaches the audio graph, a device list that is always empty, and a
   * sleep timer whose countdown is decorative. Each one reads the *effect* (the engine mirror on `<html>`, the
   * stored settings, the ticking label) rather than the presence of a control.
   */
  await evaluateLive( "location.hash = '#/settings'; 'ok'", 88)
  await delay(900)
  const soundSection = await evaluate(
    ws,
    `(() => {
       const node = document.querySelector('[data-testid="sound-section"]')
       return JSON.stringify({
         present: !!node,
         heading: node?.querySelector('h3')?.textContent?.trim() ?? '',
         bands: node ? node.querySelectorAll('[data-band]').length : 0,
         presets: node ? [...node.querySelectorAll('[data-preset]')].map((b) => b.dataset.preset) : [],
         devices: node ? [...node.querySelectorAll('[data-device]')].map((b) => b.dataset.device) : [],
         toggles: ['eq-toggle', 'loudness-toggle', 'gapless-toggle', 'crossfade-slider'].filter((id) => !!node && !!node.querySelector('[data-testid="' + id + '"]')),
       })
     })()`,
    89,
  )
  const sound = (() => {
    try {
      return JSON.parse(String(soundSection?.value ?? '{}'))
    } catch {
      return {}
    }
  })()
  check('声音: 设置页有「声音」区块，含均衡器/响度/设备/衔接控件', sound.present === true && sound.heading === '声音', JSON.stringify(sound))
  check(
    '声音: 均衡器画出 10 段 + 前级 + 全部预设',
    // 11 = the ten bands plus the preamp slider; 9 = the shipped presets (「自定义」 is a state, not a button).
    sound.bands === 11 && Array.isArray(sound.presets) && sound.presets.length >= 8,
    JSON.stringify({ bands: sound.bands, presets: sound.presets }),
  )
  check('声音: 输出设备里至少有「系统默认输出」', Array.isArray(sound.devices) && sound.devices.includes('default'), JSON.stringify(sound.devices))
  check('声音: 四个关键控件都在', Array.isArray(sound.toggles) && sound.toggles.length === 4, JSON.stringify(sound.toggles))

  // Turning the EQ on in the real UI must reach the real graph: the engine's `<html>` mirror is the proof.
  await evaluateLive( `document.querySelector('[data-testid="eq-toggle"]').click(); 'ok'`, 90)
  await delay(1200)
  const eqOn = await evaluate(
    ws,
    `(async () => {
       const root = document.documentElement
       const stored = await window.aurora.settings.get()
       return JSON.stringify({
         eqAttr: root.dataset.audioEq,
         attached: root.dataset.audioAttached,
         context: root.dataset.audioContext,
         chain: Number(root.dataset.audioChainNodes || 0),
         decks: root.dataset.audioDecks,
         enabled: stored.sound.equalizer.enabled,
       })
     })()`,
    91,
  )
  const eqState = JSON.parse(String(eqOn?.value ?? '{}'))
  check(
    '声音: 打开均衡器真的接入了音频图（引擎状态与存储一致，不是只改了个开关）',
    // 13 nodes: bus + preamp + output + the ten bands. (The old `>= 14` here was simply miscounted, and it
    // never ran often enough to say so.)
    eqState.enabled === true && eqState.eqAttr === 'on' && eqState.attached === 'true' && eqState.chain >= 13 && eqState.decks === '2',
    JSON.stringify(eqState),
  )

  /*
   * 接上音频图之后，音乐必须**仍然有声音在走**。
   *
   * 这一条是为一个真实事故加的：图的连线曾经漏了「总线 → 前级」那一根，于是元素送进的是一个通向空气的节点 —— 时钟照
   * 常前进、UI 一切正常，扬声器里却是寂静，分析器也永远读到 0。局外的信号只有两个：能量恒为 0，以及输出端是否真的接到了
   * 目的地。所以这条同时要求两者，并且要求播放本身没有被接图这件事打断。
   */
  /*
   * 采样前先确保“真的在放”。
   *
   * 跑到这一步时，夹具那三秒的曲目往往已经播完；而一条静止的时钟和一个断掉的音频图长得一模一样——都是
   * “不动”。所以先做与桌面歌词那几条相同的事：拖回开头、确认真在推进，再在短窗口内读能量。
   */
  const flowPrimed = await ensurePlaying(ws, 611)
  const flow = await evaluate(
    ws,
    `(async () => {
       const store = document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$pinia?._s?.get('player')
       // play() 是幂等的（已经在播就不会重来），比按播放键切换状态可靠：这里要的是「在播」，不是「切一下」。
       await store.play()
       await new Promise((resolve) => setTimeout(resolve, 300))
       const start = store.currentTime
       let peak = 0
       for (let index = 0; index < 10; index += 1) {
         await new Promise((resolve) => setTimeout(resolve, 110))
         peak = Math.max(peak, Number(getComputedStyle(document.documentElement).getPropertyValue('--music-energy').trim()) || 0)
       }
       return JSON.stringify({
         playing: store.isPlaying,
         advanced: Number((store.currentTime - start).toFixed(2)),
         peak: Number(peak.toFixed(3)),
         destination: document.documentElement.dataset.audioDestination,
         context: document.documentElement.dataset.audioContext,
         title: store.current ? store.current.title : null,
       })
     })()`,
    91,
  )
  const flowState = (() => {
    try {
      return JSON.parse(String(flow?.value ?? '{}'))
    } catch {
      return {}
    }
  })()
  /*
   * 时钟的位移取绝对值：三秒夹具可能在这段窗口里接到下一曲，那仍然是“在走”。
   *
   * 两个时钟证据取“或”：`ensurePlaying` 已用全分辨率的 seek range 验过一次推进，而窗口内的读数会在
   * 窗口被遮住、rAF 被节流的时候停在原地。断线的图只会满足「时钟在动」而永远读不到能量，所以真正
   * 负载判断的是 peak —— 它不可能因为节流而凭空出现。
   */
  const clockMoved = Math.abs(Number(flowState.advanced)) > 0.3 || flowPrimed?.first !== flowPrimed?.second
  check(
    '声音: 接图后音乐真的还在走（分析器读到能量，且输出端确实连着目的地）',
    clockMoved &&
      Number(flowState.peak) > 0.02 &&
      flowState.destination === 'connected' &&
      flowState.context === 'running',
    JSON.stringify({ ...JSON.parse(flow?.value ?? '{}'), primed: { first: flowPrimed?.first, second: flowPrimed?.second } }),
  )

  // Preset → real filter gains → stored curve.
  await evaluateLive( `document.querySelector('[data-preset="bass"]').click(); 'ok'`, 92)
  await delay(600)
  const afterPreset = await evaluate(
    ws,
    `(async () => {
       const stored = await window.aurora.settings.get()
       return JSON.stringify({ preset: stored.sound.equalizer.preset, first: stored.sound.equalizer.gains[0], peak: document.documentElement.dataset.audioEqPeak })
     })()`,
    93,
  )
  const presetState = JSON.parse(String(afterPreset?.value ?? '{}'))
  check(
    '声音: 选「低音增强」后曲线落到引擎（首段 +7 dB，峰值也报出来）',
    presetState.preset === 'bass' && presetState.first === 7 && Number(presetState.peak) > 0,
    JSON.stringify(presetState),
  )

  // Dragging one band must rewrite the curve *and* be reported as a custom preset.
  await evaluate(
    ws,
    `(() => {
       const input = document.querySelector('[data-band="4"]')
       input.value = '-6'
       input.dispatchEvent(new Event('input', { bubbles: true }))
       return 'ok'
     })()`,
    94,
  )
  await delay(600)
  const afterBand = await evaluate(
    ws,
    `window.aurora.settings.get().then((s) => JSON.stringify({ preset: s.sound.equalizer.preset, band: s.sound.equalizer.gains[4] }))`,
    95,
  )
  const bandState = JSON.parse(String(afterBand?.value ?? '{}'))
  check('声音: 手调一段同时把预设改成「自定义」（曲线与名字不会分家）', bandState.preset === 'custom' && bandState.band === -6, JSON.stringify(bandState))

  // Loudness: switching it on must be audible in the engine's state, and must not invent a measurement.
  await evaluateLive( `document.querySelector('[data-testid="loudness-toggle"]').click(); 'ok'`, 96)
  await delay(800)
  const loudness = await evaluate(
    ws,
    `(async () => {
       const stored = await window.aurora.settings.get()
       const root = document.documentElement
       return JSON.stringify({ enabled: stored.sound.loudness.enabled, target: stored.sound.loudness.targetDb, gain: root.dataset.audioLoudnessA })
     })()`,
    97,
  )
  const loudnessState = JSON.parse(String(loudness?.value ?? '{}'))
  check(
    '声音: 音量均衡开启后落库，并且当前的增益是一个真实读数（不是 NaN）',
    loudnessState.enabled === true && typeof loudnessState.target === 'number' && Number.isFinite(Number(loudnessState.gain)),
    JSON.stringify(loudnessState),
  )

  // 衔接: gapless toggle + a crossfade value, both persisted.
  await evaluateLive( `document.querySelector('[data-testid="gapless-toggle"]').click(); 'ok'`, 98)
  await delay(400)
  await evaluate(
    ws,
    `(() => {
       const input = document.querySelector('[data-testid="crossfade-slider"]')
       input.value = '5'
       input.dispatchEvent(new Event('input', { bubbles: true }))
       return 'ok'
     })()`,
    99,
  )
  await delay(600)
  const transition = await evaluate(
    ws,
    `window.aurora.settings.get().then((s) => JSON.stringify({ gapless: s.sound.gapless, crossfade: s.sound.crossfadeSeconds }))`,
    100,
  )
  const transitionState = JSON.parse(String(transition?.value ?? '{}'))
  check('声音: 无缝播放与淡入淡出都能落库', transitionState.gapless === false && transitionState.crossfade === 5, JSON.stringify(transitionState))

  // Output device: choosing the system default must route through the engine and say how.
  const device = await evaluate(
    ws,
    `(async () => {
       const applied = await window.aurora.settings.get()
       document.querySelector('[data-device="default"]').click()
       await new Promise((r) => setTimeout(r, 600))
       const after = await window.aurora.settings.get()
       return JSON.stringify({
         route: document.documentElement.dataset.audioOutputRoute,
         attr: document.documentElement.dataset.audioOutput,
         deviceId: after.sound.outputDeviceId,
         label: document.querySelector('[data-device="default"] .device-name')?.textContent?.trim() ?? '',
         before: applied.sound.outputDeviceId,
       })
     })()`,
    101,
  )
  const deviceState = JSON.parse(String(device?.value ?? '{}'))
  check(
    '声音: 输出设备可切换且引擎回报了真实路由方式',
    deviceState.deviceId === '' && deviceState.attr === 'default' && (deviceState.route === 'context' || deviceState.route === 'element'),
    JSON.stringify(deviceState),
  )

  /*
   * 睡眠定时: armed from the player bar, the countdown must actually move, and cancelling must clear both
   * the store and the button. "A timer is set" is not the claim; "the number decreases" is.
   */
  await evaluateLive( `document.querySelector('[data-testid="sleep-button"]').click(); 'ok'`, 102)
  await delay(400)
  const sleepMenu = await evaluate(
    ws,
    `(() => {
       const pop = document.querySelector('[data-testid="sleep-popover"]')
       return JSON.stringify({ open: !!pop, options: [...(pop?.querySelectorAll('[data-minutes], [data-mode]') ?? [])].map((b) => b.textContent.trim()) })
     })()`,
    103,
  )
  const sleepMenuState = JSON.parse(String(sleepMenu?.value ?? '{}'))
  check(
    '睡眠定时: 播放栏的菜单给出 15/30/45/60/90 与「本曲结束后」',
    sleepMenuState.open === true && Array.isArray(sleepMenuState.options) && sleepMenuState.options.length === 6,
    JSON.stringify(sleepMenuState),
  )

  await evaluateLive( `document.querySelector('[data-minutes="15"]').click(); 'ok'`, 104)
  const firstTick = await evaluateLive( `document.querySelector('[data-testid="sleep-countdown"]')?.textContent?.trim() ?? ''`, 105)
  await delay(2200)
  const secondTick = await evaluate(
    ws,
    `(async () => {
       const label = document.querySelector('[data-testid="sleep-countdown"]')?.textContent?.trim() ?? ''
       const cls = document.querySelector('[data-testid="sleep-button"]')?.className ?? ''
       return JSON.stringify({ label, armed: cls.includes('active') })
     })()`,
    106,
  )
  const sleepTick = JSON.parse(String(secondTick?.value ?? '{}'))
  check(
    '睡眠定时: 倒计时真的在走（两秒后数字确实变小）',
    // 首读可能就是刚武装上的 15:00，所以只要求“格式是倒计时”且两读不同，不额外要求它已经走到 14:5x。
    /^\d{2}:\d{2}$/.test(String(firstTick?.value ?? '')) && sleepTick.label !== firstTick?.value && sleepTick.armed === true,
    JSON.stringify({ first: firstTick?.value, second: sleepTick.label }),
  )

  // 选定一个时长会把菜单收起，所以关掉之前要把它重新打开——否则点的是一个不存在的节点，
  // 而“什么都没点到”和“取消了但倒计时没消失”长得一样。
  await evaluateLive( `document.querySelector('[data-testid="sleep-button"]').click(); 'ok'`, 612)
  await delay(400)
  await evaluateLive( `document.querySelector('[data-mode="off"]').click(); 'ok'`, 107)
  await delay(400)
  const sleepOff = await evaluate(
    ws,
    `JSON.stringify({ countdown: !!document.querySelector('[data-testid="sleep-countdown"]'), label: document.querySelector('[data-testid="sleep-button"]')?.title ?? '' })`,
    108,
  )
  const sleepOffState = JSON.parse(String(sleepOff?.value ?? '{}'))
  check('睡眠定时: 关闭后倒计时从播放栏消失', sleepOffState.countdown === false, JSON.stringify(sleepOffState))

  // Put the shipped defaults back, so the rest of the run (and the next one) starts from a clean player.
  await evaluate(
    ws,
    `window.aurora.settings.set({ sound: { equalizer: { enabled: false, preset: 'flat', gains: [0,0,0,0,0,0,0,0,0,0], preampDb: 0 }, loudness: { enabled: false, targetDb: -14 }, outputDeviceId: '', gapless: true, crossfadeSeconds: 0 } }).then((s) => JSON.stringify(s.sound))`,
    109,
  )
  const soundRestored = await evaluate(
    ws,
    `window.aurora.settings.get().then((s) => JSON.stringify({ eq: s.sound.equalizer.enabled, gain: s.sound.equalizer.gains[4], crossfade: s.sound.crossfadeSeconds, gapless: s.sound.gapless }))`,
    110,
  )
  const restoredState = JSON.parse(String(soundRestored?.value ?? '{}'))
  check(
    '声音: 重置回默认后曲线、淡入淡出与无缝都回来了',
    restoredState.eq === false && restoredState.gain === 0 && restoredState.crossfade === 0 && restoredState.gapless === true,
    JSON.stringify(restoredState),
  )

  /* ------------------------------------------------------------------ 曲库多选与批量操作
   *
   * 真实点击、真实选择集、真实歌单。三件事刻意不在这里做：
   *
   *   - **不点「写入」**：那条路径会把 ID3 真正写进用户的音乐文件（临时 profile 只拷索引，文件还是磁盘上
   *     那些）。所以对话框只验内容，不执行写入。
   *   - **不点「确认移除」**：曲库索引在临时 profile 里，移除只改那份拷贝，但把用户的歌从列表里去掉
   *     看不出任何东西，所以只验两步确认的闸门。
   *   - 这两条的限制写在这里，是因为不说的话，下一个人会以为“已经在跑”等于“已经验过”。
   */

  await evaluateLive( "location.hash = '#/'; 'ok'", 620)
  await waitFor(ws, '.track-row')
  await delay(400)

  const selectEntry = await evaluate(
    ws,
    `(() => {
       const button = document.querySelector('[data-testid="select-mode"]')
       return JSON.stringify({ present: !!button, label: button?.textContent?.trim() ?? '' })
     })()`,
    621,
  )
  const selectEntryState = JSON.parse(String(selectEntry?.value ?? '{}'))
  check('多选: 全量曲库工具栏里有「多选」入口', selectEntryState.present === true && selectEntryState.label === '多选', JSON.stringify(selectEntryState))

  /* 真实的库容量：用来把 UI 的「已选 N 首」和真正的曲数对一遍，而不是自己和自己比。 */
  const librarySize = await evaluate(
    ws,
    `window.aurora.library.list().then((list) => {
       const tracks = list?.tracks ?? list ?? []
       return JSON.stringify({ local: tracks.filter((track) => track.origin === 'local').length, all: tracks.length })
     })`,
    622,
  )
  const sizeState = JSON.parse(String(librarySize?.value ?? '{}'))

  await evaluateLive( `document.querySelector('[data-testid="select-mode"]').click(); 'ok'`, 623)
  await delay(500)
  const entered = await evaluate(
    ws,
    `(() => {
       const boxes = [...document.querySelectorAll('.track-row input[data-track-id]')]
       /*
        * 勾选“当前列表里真实存在的行数”，而不是假定两首。
        *
        * 夹具曲库可能只有一首：断言写死 2 的话，一份正确的实现会被判成失败，而失败原因看着像产品问题。
        * 程序化点击复选框：组件用 @click.stop.prevent 接管，所以必须真的走一次真实鼠标事件。
        */
       const picked = Math.min(2, boxes.length)
       for (let index = 0; index < picked; index += 1) boxes[index]?.click()
       return JSON.stringify({
         boxes: boxes.length,
         picked,
         first: document.querySelector('.track-row .col-title strong')?.textContent?.trim() ?? '',
         bar: !!document.querySelector('[data-testid="batch-bar"]'),
       })
     })()`,
    624,
  )
  const enteredState = JSON.parse(String(entered?.value ?? '{}'))
  await delay(300)
  const afterTwo = await evaluate(ws, `document.querySelector('[data-testid="batch-count"]')?.textContent?.trim() ?? ''`, 625)
  check(
    '多选: 进入多选后每一行出现勾选框（而不是只换了个按钮文案）',
    enteredState.boxes > 0 && enteredState.bar === false,
    JSON.stringify(enteredState),
  )
  check(
    '多选: 勾选后出现批处理条，并说清已选几首',
    enteredState.picked > 0 && String(afterTwo?.value ?? '') === `已选 ${enteredState.picked} 首`,
    JSON.stringify({ count: afterTwo?.value, picked: enteredState.picked }),
  )

  const selectedRows = await evaluate(ws, "document.querySelectorAll('.track-row.selected').length", 626)
  check(
    '多选: 选中的行自己带上了选中底（不只是数字变了）',
    selectedRows?.value === enteredState.picked,
    JSON.stringify({ selected: selectedRows?.value, picked: enteredState.picked }),
  )

  /*
   * 先清空再全选。
   *
   * 上一步已经勾了几行，直接点表头只会把它们取消（半选 → 空）——那样测到的是“取消全选”，
   * 一条断言就同时盖住了两件事，而其中一件并没有真的验过。
   */
  await evaluateLive( `document.querySelector('[data-testid="batch-clear"]').click(); 'ok'`, 6265)
  await delay(300)
  await evaluateLive( `document.querySelector('[data-testid="select-all"]').click(); 'ok'`, 627)
  await delay(400)
  const allState = await evaluate(
    ws,
    `(() => {
       const head = document.querySelector('[data-testid="select-all"]')
       return JSON.stringify({
         count: document.querySelector('[data-testid="batch-count"]')?.textContent?.trim() ?? '',
         checked: head?.checked === true,
         indeterminate: head?.indeterminate === true,
       })
     })()`,
    628,
  )
  const allSelected = JSON.parse(String(allState?.value ?? '{}'))
  check(
    '多选: 全选选中的是列表里真实的曲数（与主进程的库容量一致）',
    Number(sizeState.local) > 0 && allSelected.count === `已选 ${sizeState.local} 首`,
    JSON.stringify({ ui: allSelected.count, local: sizeState.local, all: sizeState.all }),
  )
  check('多选: 全选后表头勾选框是勾上状态（不是半选）', allSelected.checked === true && allSelected.indeterminate === false, JSON.stringify(allSelected))

  await evaluateLive( `document.querySelector('[data-testid="select-all"]').click(); 'ok'`, 629)
  await delay(300)
  const clearedByAll = await evaluate(ws, "document.querySelector('[data-testid=\"batch-count\"]')?.textContent?.trim() ?? ''", 630)
  const emptiedByAll = await evaluate(ws, "!!document.querySelector('[data-testid=\"batch-bar\"]')", 631)
  check('多选: 再点一次表头就是取消全选（批处理条收起）', !String(clearedByAll?.value ?? '') && emptiedByAll?.value === false, JSON.stringify({ count: clearedByAll?.value }))

  /* ---------------------------------------- 两步确认：破坏性动作必须真的多一步 */

  await evaluate(
    ws,
    `(() => {
       document.querySelectorAll('.track-row input[data-track-id]')[0]?.click()
       return 'ok'
     })()`,
    632,
  )
  await delay(300)
  await evaluateLive( `document.querySelector('[data-testid="batch-remove"]').click(); 'ok'`, 633)
  await delay(300)
  const confirming = await evaluate(
    ws,
    `JSON.stringify({
       confirm: !!document.querySelector('[data-testid="batch-remove-confirm"]'),
       ask: !!document.querySelector('[data-testid="batch-remove"]'),
       warning: document.querySelector('.batch-warning')?.textContent?.trim() ?? '',
     })`,
    634,
  )
  const confirmState = JSON.parse(String(confirming?.value ?? '{}'))
  check(
    '多选: 点「从音乐库移除」先问一次（确认按钮出现、并写明文件不会被删）',
    confirmState.confirm === true && confirmState.ask === false && String(confirmState.warning).includes('文件不会被删除'),
    JSON.stringify(confirmState),
  )

  await evaluateLive( `document.querySelector('[data-testid="batch-remove-cancel"]').click(); 'ok'`, 635)
  await delay(300)
  const cancelled = await evaluate(
    ws,
    `window.aurora.library.list().then((list) => {
       const tracks = list?.tracks ?? list ?? []
       return JSON.stringify({
         ask: !!document.querySelector('[data-testid="batch-remove"]'),
         confirm: !!document.querySelector('[data-testid="batch-remove-confirm"]'),
         local: tracks.filter((track) => track.origin === 'local').length,
       })
     })`,
    636,
  )
  const cancelState = JSON.parse(String(cancelled?.value ?? '{}'))
  check(
    '多选: 取消后回到单按钮，且曲库一首都没少',
    cancelState.ask === true && cancelState.confirm === false && cancelState.local === Number(sizeState.local),
    JSON.stringify(cancelState),
  )

  /* ---------------------------------------- 批量加入歌单：真的落进歌单里 */

  await evaluateLive( `document.querySelector('[data-testid="batch-clear"]').click(); 'ok'`, 6365)
  await delay(300)
  const pickedForPlaylist = await evaluate(
    ws,
    `(() => {
       const boxes = [...document.querySelectorAll('.track-row input[data-track-id]')]
       const picked = Math.min(2, boxes.length)
       for (let index = 0; index < picked; index += 1) boxes[index]?.click()
       return JSON.stringify({ picked, first: document.querySelector('.track-row .col-title strong')?.textContent?.trim() ?? '' })
     })()`,
    637,
  )
  const playlistPick = JSON.parse(String(pickedForPlaylist?.value ?? '{}'))
  await delay(300)
  await evaluateLive( `document.querySelector('[data-testid="batch-playlist"]').click(); 'ok'`, 638)
  await delay(500)
  const picker = await evaluate(
    ws,
    `(() => {
       const card = [...document.querySelectorAll('.modal-card')].find((node) => node.textContent.includes('加入歌单'))
       return JSON.stringify({ open: !!card, subject: card?.querySelector('.muted')?.textContent?.trim() ?? '' })
     })()`,
    639,
  )
  const pickerState = JSON.parse(String(picker?.value ?? '{}'))
  /* 一首歌报歌名，一批报数量 —— 选择器对两种数量都有自己的说法，这里两种都认。 */
  const expectedSubject = Number(playlistPick.picked) === 1 ? String(playlistPick.first) : `已选 ${playlistPick.picked} 首`
  check(
    '多选: 「加入歌单」用同一个选择器开出来，并写明这一批是什么',
    pickerState.open === true && pickerState.subject === expectedSubject && Number(playlistPick.picked) > 0,
    JSON.stringify({ ...pickerState, expectedSubject }),
  )

  const playlistResult = await evaluate(
    ws,
    `(async () => {
       const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
       const input = document.querySelector('.modal-create input')
       input.value = '批量测试歌单'
       input.dispatchEvent(new Event('input', { bubbles: true }))
       await wait(200)
       ;[...document.querySelectorAll('.modal-create button')].find((node) => node.textContent.includes('创建并加入'))?.click()
       await wait(500)
       const stored = JSON.parse(localStorage.getItem('aurora:playlists') ?? '[]')
       const created = stored.find((item) => item.name === '批量测试歌单')
       return JSON.stringify({ created: !!created, tracks: created ? created.trackIds.length : 0, dialogOpen: !!document.querySelector('.modal-create') })
     })()`,
    640,
  )
  // Accept both shapes the helper can hand back (a raw JSON string, or an already-decoded value): a
  // harness that crashes here reports "少了一大段" instead of a result, which is how a test bug turns
  // into a false alarm about the product.
  const playlistState =
    typeof playlistResult?.value === 'string' ? JSON.parse(playlistResult.value) : (playlistResult?.value ?? {})
  check(
    '多选: 新建歌单真的把选中的那些装进去了（不是只关了个弹窗）',
    playlistState.created === true && playlistState.tracks === Number(playlistPick.picked) && playlistState.dialogOpen === false,
    JSON.stringify({ ...playlistState, picked: playlistPick.picked }),
  )

  /* ---------------------------------------- 批量改信息：只验内容，不真写文件 */

  await evaluateLive( `document.querySelector('[data-testid="batch-tags"]').click(); 'ok'`, 641)
  await delay(500)
  const tagsDialog = await evaluate(
    ws,
    `(() => {
       const card = document.querySelector('[data-testid="batch-tag-dialog"]')
       return JSON.stringify({
         open: !!card,
         head: card?.querySelector('p')?.textContent?.replace(/\\s+/g, ' ').trim() ?? '',
         artist: !!card?.querySelector('[data-testid="batch-artist"]'),
         album: !!card?.querySelector('[data-testid="batch-album"]'),
         apply: card?.querySelector('[data-testid="batch-apply"]')?.disabled ?? null,
       })
     })()`,
    642,
  )
  const tagsState = JSON.parse(String(tagsDialog?.value ?? '{}'))
  check(
    '多选: 「修改信息」说明这一批里有多少首能写（按真实格式算，不是全部）',
    tagsState.open === true &&
      String(tagsState.head).includes(`已选 ${playlistPick.picked} 首`) &&
      /其中 [0-9]+ 首是 MP3/.test(String(tagsState.head)) &&
      tagsState.artist === true &&
      tagsState.album === true,
    JSON.stringify(tagsState),
  )
  check('多选: 两个字段都空时「写入」是禁用的（不会写一次空修改）', tagsState.apply === true, JSON.stringify({ disabled: tagsState.apply }))

  await evaluateLive( `document.querySelector('[data-testid="batch-tag-dialog"] .icon-button').click(); 'ok'`, 643)
  await delay(300)

  await evaluateLive( `document.querySelector('[data-testid="batch-clear"]').click(); 'ok'`, 644)
  await delay(300)
  await evaluateLive( `document.querySelector('[data-testid="select-mode"]').click(); 'ok'`, 645)
  await delay(300)
  const exited = await evaluate(
    ws,
    `JSON.stringify({
       boxes: document.querySelectorAll('.track-row input[data-track-id]').length,
       bar: !!document.querySelector('[data-testid="batch-bar"]'),
       label: document.querySelector('[data-testid="select-mode"]')?.textContent?.trim() ?? '',
     })`,
    646,
  )
  const exitState = JSON.parse(String(exited?.value ?? '{}'))
  check(
    '多选: 退出后勾选框与批处理条一起消失，列表回到原来的样子',
    exitState.boxes === 0 && exitState.bar === false && exitState.label === '多选',
    JSON.stringify(exitState),
  )

  /* ------------------------------------------------------------------ 拖拽导入
   *
   * 分两层，因为“拖放”本身在自动化里只能做到一半：
   *
   *   - 手势层：真实的 DragEvent（DataTransfer 里放真的 File）→ 覆盖层出现/收起，以及“拿不到路径时
   *     要说实话”这条分支。合成的 File 没有真实磁盘位置，\`webUtils.getPathForFile\` 会返回空，这正好是
   *     那条分支的真实入口。
   *   - 导入层：把真实的音频文件拷进临时 profile，再走同一个 IPC（目录展开、去重、非音频计数）。
   *     这一层才是“文件真的进了曲库”。两层缺一层都会留下一个没人验过的空洞。
   */

  const dropSource = await evaluate(
    ws,
    `window.aurora.library.list().then((list) => {
       const tracks = list?.tracks ?? list ?? []
       const local = tracks.find((track) => track.origin === 'local' && track.filePath)
       return JSON.stringify({ path: local ? local.filePath : '', local: tracks.filter((track) => track.origin === 'local').length })
     })`,
    650,
  )
  const dropBase = JSON.parse(String(dropSource?.value ?? '{}'))
  const dropDir = join(profileDir, 'drop-import')
  const copiedTrack = join(dropDir, 'copied song.mp3')
  const notesFile = join(dropDir, 'notes.txt')
  let dropPrepared = false
  if (dropBase.path) {
    try {
      mkdirSync(dropDir, { recursive: true })
      copyFileSync(dropBase.path, copiedTrack)
      writeFileSync(notesFile, '这不是音乐\n', 'utf8')
      dropPrepared = true
    } catch {
      dropPrepared = false
    }
  }

  const dropBridge = await evaluate(
    ws,
    `JSON.stringify({
       addPaths: typeof window.aurora.library.addPaths,
       pathsForFiles: typeof window.aurora.library.pathsForFiles,
     })`,
    651,
  )
  const bridgeState = JSON.parse(String(dropBridge?.value ?? '{}'))
  check(
    '拖拽导入: 桥接层真的暴露了这两个入口（不是只有 UI）',
    bridgeState.addPaths === 'function' && bridgeState.pathsForFiles === 'function',
    JSON.stringify(bridgeState),
  )

  const veil = await evaluate(
    ws,
    `(async () => {
       const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
       const transfer = new DataTransfer()
       transfer.items.add(new File(['x'], 'a.txt', { type: 'text/plain' }))
       window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: transfer, bubbles: true }))
       await wait(200)
       const shown = !!document.querySelector('[data-testid="drop-veil"]')
       const text = document.querySelector('.drop-card')?.textContent?.replace(/\\s+/g, ' ').trim() ?? ''
       window.dispatchEvent(new DragEvent('dragleave', { dataTransfer: transfer, bubbles: true }))
       await wait(250)
       return JSON.stringify({ shown, text, hidden: !document.querySelector('[data-testid="drop-veil"]') })
     })()`,
    652,
  )
  const veilState = JSON.parse(String(veil?.value ?? '{}'))
  check(
    '拖拽导入: 拖文件到窗口上会出现提示层，离开就收起',
    veilState.shown === true && veilState.hidden === true && String(veilState.text).includes('松开即可导入'),
    JSON.stringify(veilState),
  )

  /*
   * 合成的 File 没有真实路径。这条验的是“拿不到位置时要说实话”——直接不动、或者报“导入成功 0 首”，
   * 都是在把一个做不到的事说成做到了。
   */
  const dropUnknown = await evaluate(
    ws,
    `(async () => {
       const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
       const transfer = new DataTransfer()
       transfer.items.add(new File(['x'], 'a.mp3', { type: 'audio/mpeg' }))
       window.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true }))
       await wait(700)
       const toasts = [...document.querySelectorAll('.toast')].map((node) => node.textContent ?? '')
       return JSON.stringify({ toasts, veil: !!document.querySelector('[data-testid="drop-veil"]') })
     })()`,
    653,
  )
  const unknownState = JSON.parse(String(dropUnknown?.value ?? '{}'))
  check(
    '拖拽导入: 拿不到文件位置时如实说明（不会静默什么都不做）',
    unknownState.veil === false && (unknownState.toasts ?? []).some((text) => String(text).includes('无法读取拖入文件的位置')),
    JSON.stringify(unknownState),
  )

  const dropResults = await evaluate(
    ws,
    `(async () => {
       const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
       const api = window.aurora.library
       const before = await api.list().then((list) => (list?.tracks ?? list ?? []).length)
       const single = await api.addPaths([${JSON.stringify(copiedTrack)}])
       await wait(400)
       const afterSingle = await api.list().then((list) => (list?.tracks ?? list ?? []).length)
       const inLibrary = await api.list().then((list) =>
         (list?.tracks ?? list ?? []).some((track) => String(track.filePath ?? '') === ${JSON.stringify(copiedTrack)}),
       )
       // 目录走一遍：同一个文件从文件夹进来，应当被识别为已存在，而不是又加一份
       const folder = await api.addPaths([${JSON.stringify(dropDir)}])
       const textOnly = await api.addPaths([${JSON.stringify(notesFile)}])
       const ghost = await api.addPaths([${JSON.stringify(join(dropDir, 'nope.mp3'))}])
       await wait(400)
       const added = await api.list().then((list) => (list?.tracks ?? list ?? []).find((track) => String(track.filePath ?? '') === ${JSON.stringify(copiedTrack)}))
       if (added) await api.remove(added.id)
       await wait(400)
       const after = await api.list().then((list) => (list?.tracks ?? list ?? []).length)
       return JSON.stringify({
         before,
         afterSingle,
         inLibrary,
         singleAdded: single.added.length,
         folderAdded: folder.added.length,
         folderDuplicated: folder.duplicated,
         textUnsupported: textOnly.unsupported ?? 0,
         textAdded: textOnly.added.length,
         ghostAdded: ghost.added.length,
         ghostFailed: ghost.failed,
         after,
       })
     })()`,
    654,
  )
  const dropState = JSON.parse(String(dropResults?.value ?? '{}'))
  check(
    '拖拽导入: 把真实音频文件交给 addPaths，文件真的进了曲库',
    dropPrepared && dropState.singleAdded === 1 && dropState.afterSingle === Number(dropState.before) + 1 && dropState.inLibrary === true,
    JSON.stringify({ prepared: dropPrepared, ...dropState }),
  )
  check(
    '拖拽导入: 拖入文件夹会递归找出里面的音频（同一个文件被认成已存在，不重复入库）',
    dropState.folderAdded === 0 && dropState.folderDuplicated === 1,
    JSON.stringify(dropState),
  )
  check(
    '拖拽导入: 非音频文件单独计数为「不是音频」，不算导入失败',
    dropState.textUnsupported === 1 && dropState.textAdded === 0,
    JSON.stringify({ unsupported: dropState.textUnsupported, added: dropState.textAdded }),
  )
  check(
    '拖拽导入: 不存在的路径被跳过后如实上报，不是抛错',
    dropState.ghostAdded === 0 && dropState.after === Number(dropState.before),
    JSON.stringify({ ghostAdded: dropState.ghostAdded, ghostFailed: dropState.ghostFailed, before: dropState.before, after: dropState.after }),
  )

  /*
   * 这里**曾经**试过一条「播放时选 30 档真的把画布压到 30 帧」。试了两次、两次都真的红了，所以它不
   * 留在这里——不是因为难，而是因为这个位置不具备它需要的条件，而一条永远和环境打架的断言比没有断言
   * 更糟（它会训练人去忽略红色）。
   *
   * 原因已实测：夹具只有三秒，而这个位置在重启之后——`ensurePlaying` 的时钟读数两次都是 `0:00 → 0:00`，
   * 也就是说那一刻队列里确实没有能出声的东西；在这个位置上量出来的只能是暂停地板（两档都是 33.33ms）。
   *
   * 「播放时不受暂停地板限制」这件事由两层真实覆盖：
   *   1. `smoke:visual` 的单位断言：`gateMs(预算, { playing: true }) === 预算`，逐字比较；
   *   2. `npm run check:idle --state playing`：在打包产物上验证（没队列可播时明确报 SKIP，不报绿）。
   * 而这条断言原本混合的两件事，其中「选择真的接到调速器上」已经由上面那条（预算 6.06 ↔ 33.33）覆盖。
   */

  source.server.close()
  await evaluateLive( `window.aurora.scriptSources.remove(${JSON.stringify(sourceId)}).then((r) => r.ok)`, 45)
  const afterRemove = await evaluate(
    ws2,
    `window.aurora.sources.list().then((l) => l.some((item) => item.id === ${JSON.stringify(sourceId)}))`,
    46,
  )
  check('打包产物内删除音源后注册表真的不再包含它', afterRemove?.value === false, afterRemove?.value)

  if (second) ws2.close()
} catch (error) {
  // The stack matters here: without it a surfaced page error reads as an unexplained message.
  const stack = String(error?.stack ?? error)
  aborted = true
  abortWhere = stack.split('\n').slice(0, 2).join(' | ')
  check('执行过程无异常', false, stack)
} finally {
  child?.kill()
  await delay(500)
  await rm(profileDir, { recursive: true, force: true }).catch(() => undefined)
}

for (const line of pageLog) console.log(`  [page] ${line}`)
for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}  ${item.detail ?? ''}`)
const failed = checks.filter((item) => !item.ok).length
if (aborted) {
  console.log('\n!! 运行在异常处中断：其后的检查根本没有执行 —— 这不是「差几条」，而是「少了一大段」。')
  console.log(`!! 中断位置：${abortWhere}`)
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`)
process.exit(failed === 0 ? 0 : 1)
