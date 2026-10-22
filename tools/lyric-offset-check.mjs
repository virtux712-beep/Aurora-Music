/**
 * Packaged acceptance check for the listener's lyric offset (±1000 ms, 100 ms a step).
 *
 * ## What it asserts
 *
 * The offset is only worth having if it changes **which line is being sung**, so this check refuses to settle
 * for the number moving:
 *
 *   1. The settings row exists and its reading comes from the main process (not a local ref the file never
 *      hears about — a correction that vanishes on restart is not a correction).
 *   2. Pressing 「延后」 once stores 100 ms, and the reading agrees with what was stored.
 *   3. The bounds hold: pressing it past the end stops at 1000 ms, and 「归零」 comes back to 0.
 *   4. **The effect**: with real lyrics imported and the clock parked at the same spot, +1000 ms highlights
 *      *the next* line and −1000 ms *the previous* one. Read while paused, so the clock cannot drift between
 *      readings and a line change can only come from the offset.
 *   5. The imported lyrics themselves are untouched — same line count, same text. A correction is an opinion
 *      about playback, not an edit of the song's timing data.
 *
 * ## Why it runs on its own instance
 *
 * It needs a real, playable track and real lyrics, and the shortest honest way to get both is the app's own
 * state: the small JSON/state files (plus the downloads the library points at) are copied out of
 * `%APPDATA%/aurora-music` into a throwaway profile, and the build runs against *that*. The lyrics it imports
 * land in the throwaway profile, so the LRC files you actually use are never touched. Nothing is written back.
 *
 * Usage: `npm run check:lyric-offset` (needs a build first — `npx electron-vite build`, or `npm run build`).
 */
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = Number(process.argv[2] ?? 9467)
const require = createRequire(import.meta.url)

const ROAMING = join(homedir(), 'AppData', 'Roaming', 'aurora-music')
/** Only the app's own state: the Chromium caches are hundreds of megabytes this check never reads. */
const STATE = [
  'library.json',
  'settings.json',
  'download-tasks.json',
  'lyrics',
  'covers',
  'downloads',
  'themes',
  'custom-sources',
  'script-sources',
  'Local Storage',
  'Session Storage',
]

const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok) })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
}

const profile = mkdtempSync(join(tmpdir(), 'aurora-lyric-offset-'))
const copied = []
for (const name of STATE) {
  const from = join(ROAMING, name)
  if (!existsSync(from)) continue
  cpSync(from, join(profile, name), { recursive: true })
  copied.push(name)
}

// `--mute-audio`: the suite's convention. Chromium mutes the output stream, not the graph, so the app behaves
// exactly as it does for a listener while whoever is at the machine hears nothing.
const child = spawn(require('electron'), ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--mute-audio'], {
  stdio: ['ignore', 'ignore', 'pipe'],
})
child.stderr.on('data', (chunk) => {
  const text = String(chunk).trim()
  if (text && !text.includes('DevTools listening') && !text.includes('ERROR:')) console.log(`  [app] ${text}`)
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function connect() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = targets.find((target) => target.type === 'page' && String(target.url).startsWith('file:'))
      if (page) return page.webSocketDebuggerUrl
    } catch {
      /* the debug port is not up yet */
    }
    await sleep(500)
  }
  return null
}

let ws
let nextId = 0
function send(method, params = {}, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const id = ++nextId
    const timer = setTimeout(() => {
      ws.removeEventListener('message', onMessage)
      resolve({ error: 'timeout' })
    }, timeoutMs)
    function onMessage(event) {
      const payload = JSON.parse(String(event.data))
      if (payload.id !== id) return
      clearTimeout(timer)
      ws.removeEventListener('message', onMessage)
      if (payload.error) return resolve({ error: JSON.stringify(payload.error) })
      resolve(payload.result ?? {})
    }
    ws.addEventListener('message', onMessage)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(expression, timeoutMs = 180000) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs)
  if (result.exceptionDetails) {
    return { error: result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'exception' }
  }
  return { value: result.result?.value }
}

/**
 * One script, run inside the page.
 *
 * Backticks are avoided inside it on purpose: this block is itself a template literal, and a stray backtick is
 * how a probe ends up reporting a syntax error as a product failure.
 */
const PAGE = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const q = (selector) => document.querySelector(selector)
  const text = (selector) => (q(selector)?.textContent ?? '').trim()
  const value = () => text('[data-testid="lyric-offset-value"]')
  const stored = async () => (await window.aurora.settings.get()).lyricsOffsetMs
  const report = {}

  /* ---------------------------------------------------------------- 1. 设置页的控件与读数 */

  location.hash = '#/settings'
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (q('[data-testid="lyric-offset-row"]')) break
    await wait(250)
  }
  const row = q('[data-testid="lyric-offset-row"]')
  report.ui = {
    row: Boolean(row),
    earlier: Boolean(q('[data-testid="lyric-offset-earlier"]')),
    later: Boolean(q('[data-testid="lyric-offset-later"]')),
    reset: Boolean(q('[data-testid="lyric-offset-reset"]')),
    value: value(),
    hint: (row?.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 80),
  }
  report.storedBefore = await stored()

  /* ---------------------------------------------------------------- 2. 一步 100 ms，并且真的落库 */

  q('[data-testid="lyric-offset-later"]').click()
  await wait(250)
  report.afterOne = { stored: await stored(), value: value() }

  /* ---------------------------------------------------------------- 3. 上下界：夹在 ±1000 ms */

  for (let index = 0; index < 14; index += 1) {
    q('[data-testid="lyric-offset-later"]').click()
    await wait(80)
  }
  report.atMax = { stored: await stored(), value: value(), laterDisabled: q('[data-testid="lyric-offset-later"]').disabled }

  for (let index = 0; index < 26; index += 1) {
    q('[data-testid="lyric-offset-earlier"]').click()
    await wait(80)
  }
  report.atMin = { stored: await stored(), value: value(), earlierDisabled: q('[data-testid="lyric-offset-earlier"]').disabled }

  q('[data-testid="lyric-offset-reset"]').click()
  await wait(250)
  report.afterReset = { stored: await stored(), value: value() }

  /* ---------------------------------------------------------------- 4. 真实歌词：偏移必须换行 */

  /*
   * 挑一首足够长的真实曲目。
   *
   * 长度不是挑剔：一行一秒的歌词，要能在曲子里找到「中间那一句」再往前后各走一句，曲子本身就得有
   * 几十秒。短的测试曲目会让定位落在末尾，那时「下一句」根本不存在，断言就成了假的。
   */
  const chosen = await (async () => {
    const list = await window.aurora.library.list()
    const tracks = list?.tracks ?? list ?? []
    const song = tracks.find((item) => (item.duration || 0) >= 60)
    if (!song) return null
    const store = q('#app')?.__vue_app__?.config?.globalProperties?.$pinia?._s?.get('player')
    await store.playTrack(song)
    return { title: song.title, duration: song.duration }
  })()
  report.track = chosen ? chosen.title + ' / ' + Math.round(chosen.duration) + 's' : 'none'
  if (!chosen) return JSON.stringify({ ...report, error: 'no-track' })
  await wait(1800)

  location.hash = '#/lyrics'
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (q('.lp-more')) break
    await wait(250)
  }
  await wait(600)
  // 歌词视图：有歌词时默认就是它，但这一次性检查不猜，直接点一次。
  ;[...document.querySelectorAll('.lp-viewswitch button')].find((b) => b.textContent.includes('歌词'))?.click()
  await wait(400)

  const range = q('.progress-range')
  const times = [...document.querySelectorAll('.progress-line span')].map((node) => node.textContent.trim())
  const toSeconds = (stamp) => {
    const parts = stamp.split(':').map(Number)
    return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1]
  }
  const duration = times.length ? toSeconds(times[times.length - 1]) : 0
  if (!range || !Number.isFinite(duration) || duration < 12) {
    return JSON.stringify({ ...report, error: 'no-track', times })
  }

  /*
   * 每 1 秒一句，覆盖整首。
   *
   * 间距必须是 1 秒而不是「够用就行」：偏移 ±1000 ms 恰好是一行，所以「+1000 → 下一句」在数学上必然
   * 成立，与播放位置落在哪里无关。再密的歌词反而会让这条断言变得含糊。
   */
  const firstAt = 0.5
  const step = 1
  const count = Math.max(4, Math.floor((duration - firstAt) / step))
  q('.lp-more .glass-icon-button')?.click()
  await wait(250)
  ;[...document.querySelectorAll('.lp-menu button')].find((b) => b.textContent.includes('导入歌词'))?.click()
  await wait(400)
  const area = q('.lyrics-textarea')
  if (!area) return JSON.stringify({ ...report, error: 'no-modal' })
  let lrc = ''
  for (let index = 0; index < count; index += 1) {
    const at = firstAt + index * step
    const mm = String(Math.floor(at / 60)).padStart(2, '0')
    const ss = (at % 60).toFixed(2).padStart(5, '0')
    lrc += '[' + mm + ':' + ss + ']偏移第 ' + (index + 1) + ' 句\\n'
  }
  area.value = lrc
  area.dispatchEvent(new Event('input', { bubbles: true }))
  await wait(250)
  q('.modal-create .primary-button')?.click()
  await wait(1800)

  const activeNumber = () => {
    const match = /偏移第 ([0-9]+) 句/.exec(document.querySelector('.lyric-line.active')?.textContent ?? '')
    return match ? Number(match[1]) : -1
  }
  const lineTexts = () => [...document.querySelectorAll('.lyric-line')].map((node) => node.textContent.trim())
  /*
   * 行数要问 store，不能数 DOM。
   *
   * 歌词条只渲染当前句附近的一窗（这是它不卡的原因），所以 .lyric-line 的数量随播放位置变化，
   * 它证明不了「歌词有没有被改写」——初始 86 与 161 都是同一份 315 行歌词的窗口。
   */
  const sheetLines = () => {
    const store = q('#app')?.__vue_app__?.config?.globalProperties?.$pinia?._s?.get('lyrics')
    return [...(store?.lyrics?.lines ?? [])].map((line) => line.text)
  }
  const importedLines = sheetLines()
  report.imported = { lines: importedLines.length, expected: count, first: importedLines[0] ?? '', domWindow: lineTexts().length }

  /** 通过播放器真正暴露的 permille 进度条定位，和用户拖动是同一条路。 */
  const seek = async (at) => {
    range.value = String(Math.round(Math.max(0, Math.min(1, at / duration)) * 1000))
    range.dispatchEvent(new Event('input', { bubbles: true }))
    await wait(1300)
  }
  const setPlaying = async (want) => {
    const button = q('.player-bar .play-button')
    if (String(button?.title ?? '').includes('暂停') !== want) {
      button?.click()
      await wait(600)
    }
  }
  /**
   * 去设置页点按钮、再回歌词页读高亮行。
   *
   * 两页是同一次会话里的两个路由视图，所以必须真的走一遍：控件只在设置页挂载，而高亮行只在歌词页
   * 渲染。在同一位置用三种偏移各走一遍，它比较的就只有偏移这一个变量。
   */
  const backToLyrics = async () => {
    location.hash = '#/lyrics'
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (q('.lyric-line')) break
      await wait(200)
    }
    ;[...document.querySelectorAll('.lp-viewswitch button')].find((b) => b.textContent.includes('歌词'))?.click()
    await wait(500)
  }
  const applyOffset = async (steps) => {
    location.hash = '#/settings'
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (q('[data-testid="lyric-offset-reset"]')) break
      await wait(200)
    }
    q('[data-testid="lyric-offset-reset"]')?.click()
    await wait(200)
    for (let index = 0; index < Math.abs(steps); index += 1) {
      q(steps > 0 ? '[data-testid="lyric-offset-later"]' : '[data-testid="lyric-offset-earlier"]')?.click()
      await wait(80)
    }
    const at = await stored()
    await backToLyrics()
    return at
  }

  // 中间偏前一点，保证「再往后一句」一定还在曲子里。
  const middle = Math.max(3, Math.min(Math.floor(count / 2), Math.floor(duration) - 6))
  const at = firstAt + (middle - 1) * step + 0.5
  await setPlaying(false)
  await seek(at)
  report.seeked = { at, middle, duration }

  report.zero = { stored: await applyOffset(0), line: activeNumber() }
  report.later = { stored: await applyOffset(10), line: activeNumber() }
  report.earlier = { stored: await applyOffset(-10), line: activeNumber() }
  report.back = { stored: await applyOffset(0), line: activeNumber() }
  const afterLines = sheetLines()
  report.linesAfter = afterLines.length
  report.textsAfter = afterLines[middle - 1] ?? ''

  // 把这台机器上的设置放回原样（探针用的是临时 profile，但读数仍然是主进程写的）。
  await applyOffset(0)
  return JSON.stringify({ ...report, duration, middle, at })
})()`

try {
  const url = await connect()
  if (!url) throw new Error('应用窗口没有在调试端口上出现')
  ws = new WebSocket(url)
  await new Promise((resolve) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', resolve, { once: true })
    setTimeout(resolve, 8000)
  })

  const result = await evaluate(PAGE)
  if (result.error) throw new Error(result.error)
  const report = JSON.parse(String(result.value ?? '{}'))

  check(
    '歌词偏移: 设置页有控件（提前 / 延后 / 归零 + 当前读数）',
    report.ui?.row === true && report.ui?.earlier === true && report.ui?.later === true && report.ui?.reset === true,
    report.ui,
  )
  check('歌词偏移: 初始读数是主进程里的值（不是本地猜的）', report.ui?.value === '0 ms' && report.storedBefore === 0, {
    value: report.ui?.value,
    stored: report.storedBefore,
  })
  check(
    '歌词偏移: 点一次「延后」写入 100 ms，界面读数与之一致',
    report.afterOne?.stored === 100 && report.afterOne?.value === '+100 ms',
    report.afterOne,
  )
  check(
    '歌词偏移: 上界夹在 +1000 ms（再点也只到 1000，按钮自己禁用）',
    report.atMax?.stored === 1000 && report.atMax?.value === '+1000 ms' && report.atMax?.laterDisabled === true,
    report.atMax,
  )
  check(
    '歌词偏移: 下界夹在 −1000 ms（同上，方向相反）',
    report.atMin?.stored === -1000 && report.atMin?.value === '−1000 ms' && report.atMin?.earlierDisabled === true,
    report.atMin,
  )
  check('歌词偏移: 「归零」回到 0 并落库', report.afterReset?.stored === 0 && report.afterReset?.value === '0 ms', report.afterReset)
  check(
    '歌词偏移: 真的导入了多行歌词（否则下面的换行断言无从谈起）',
    report.imported?.lines === report.imported?.expected && String(report.imported?.first ?? '').includes('偏移第 1 句'),
    report.imported,
  )
  check(
    '歌词偏移: 偏移 0 时高亮的是一句真实歌词',
    report.zero?.stored === 0 && report.zero?.line > 0,
    report.zero,
  )
  check(
    '歌词偏移: +1000 ms 让高亮行真的前进一句（同一播放位置）',
    report.later?.stored === 1000 && report.later?.line === report.zero.line + 1,
    { zero: report.zero?.line, later: report.later?.line },
  )
  check(
    '歌词偏移: −1000 ms 让高亮行真的后退一句（同一播放位置）',
    report.earlier?.stored === -1000 && report.earlier?.line === report.zero.line - 1,
    { zero: report.zero?.line, earlier: report.earlier?.line },
  )
  check('歌词偏移: 归零后高亮回到原来那一句', report.back?.stored === 0 && report.back?.line === report.zero.line, {
    zero: report.zero?.line,
    back: report.back?.line,
  })
  check(
    '歌词偏移: 没有改写歌词本身（行数与那一句的文字都不变）',
    report.linesAfter === report.imported?.expected &&
      String(report.textsAfter ?? '').includes('偏移第 ' + report.middle + ' 句') &&
      Number(report.middle) > 0,
    { lines: report.linesAfter, expected: report.imported?.expected, text: report.textsAfter, line: report.middle },
  )
} catch (error) {
  check('执行过程无异常', false, String(error?.stack ?? error).split('\n').slice(0, 3).join(' | '))
} finally {
  try {
    ws?.close()
  } catch {
    /* best effort */
  }
  // Tree kill by pid: `child.kill()` leaves the renderer children behind on Windows, and leftovers are what
  // made these checkers fail when run back to back. Killing by image name would take a sibling run down too.
  child?.kill()
  spawnSync('taskkill', ['/T', '/F', '/PID', String(child?.pid ?? 0)], { stdio: 'ignore' })
  await sleep(600)
  rmSync(profile, { recursive: true, force: true })
}

console.log(`\n拷贝的应用状态: ${copied.join(', ') || '(空)'}`)
const failed = checks.filter((item) => !item.ok).length
console.log(`${checks.length - failed}/${checks.length} checks passed`)
process.exit(failed === 0 ? 0 : 1)
