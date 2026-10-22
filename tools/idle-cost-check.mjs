/**
 * Where does a **paused** Aurora spend its CPU?
 *
 * ## Why this exists
 *
 * The decorative layers are supposed to cost nothing while nothing is happening. Two facts made that
 * claim worth checking rather than assuming:
 *
 *  - `utils/spectrum.ts` runs one shared `requestAnimationFrame` loop for as long as it has subscribers,
 *    and the energy bridge subscribes app-wide at startup — so the loop is alive from launch, playing or not;
 *  - `SpectrumVisualizer.vue` runs its *own* per-vsync loop while its tab is open, and its body is a single
 *    `if ((dirty || player.isPlaying) && allowDraw(...))`. Paused and clean, that is one callback per
 *    vsync forever, deciding nothing.
 *
 * A loop that decides nothing still wakes the renderer every vsync, so the question is not whether it is
 * "cheap" but whether it is measurable — and that is what this check answers, before any code changes.
 *
 * ## How it measures
 *
 *  - **Per view.** The three lyric-panel views (`歌词` / `频谱律动` / `拟真唱片`) mount different components
 *    behind the same player state, so switching between them while paused isolates each component's idle
 *    cost. The shared loops cancel out because they are identical in all three.
 *  - **Interleaved and in rounds.** One sample per state is not a measurement — an earlier round watched the
 *    same state read 121 % and 72 % minutes apart. Every state is visited once per round, in a rotating
 *    order, and the median is reported.
 *  - **Cumulative processor-seconds**, summed over every process the app owns, rather than a `% Processor
 *    Time` snapshot: a counter only moves for real work.
 *  - **Split by process type**, because the first run of this check proved the split is the whole point: the
 *    per-view readings came out identical (0.39 core each) and the CDP profile was *empty* — a sampling
 *    profile of the renderer's own thread found 6 ms of JavaScript in 6 s. Everything was being spent in a
 *    process the renderer's profiler cannot see, so a single total would have sent the next fix to the wrong
 *    place. The command line of each child names its type (`--type=renderer`, `--type=gpu-process`, …).
 *  - **Paused before measuring.** A restored queue starts playing, so the first version of this measured a
 *    *playing* app and called it idle. The probe now presses the app's own pause control and refuses to
 *    report a reading taken while playback was running.
 *
 *      That fix immediately exposed a second one in the probe itself: `document.querySelector('audio')` was
 *      `null`, because the player's decks are `new Audio()` objects that were never appended to the document.
 *      The very first "it is playing" reading was that `null` being compared with `!== true` — a check that
 *      could only ever say "playing". The store's own transport button (`播放` / `暂停`) is the signal that
 *      actually describes playback, and it is read as a pair: `paused === true` **and** the button reads `播放`.
 *  - **`--attribute`** answers the next question instead of guessing at it: the first split showed the GPU
 *    process spending roughly four seconds of processor time for every one the renderer spent, which means the
 *    cost is compositing rather than script. The candidates are then hidden one at a time — the painted
 *    particle canvas, the CSS background layers, every `backdrop-filter` on the page — and the GPU time is
 *    re-measured after each, so the expensive layer is named by its own reading rather than by inspection.
 *  - **`--profile`** additionally takes a real CDP CPU profile on the spectrum tab and prints the top
 *    self-time functions, so the hotspot is named rather than guessed.
 *
 * Usage:
 *   node tools/idle-cost-check.mjs                          # per-view idle CPU, 3 rounds × 8 s
 *   node tools/idle-cost-check.mjs --rounds 2 --seconds 6
 *   node tools/idle-cost-check.mjs --profile                # plus a sample of the renderer's own stack
 */
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? Number(args[index + 1]) : fallback
}
const ROUNDS = flag('rounds', 3)
const SECONDS = flag('seconds', 8)
const PROFILE = args.includes('--profile')
const ATTRIBUTE = args.includes('--attribute')
const PORT = Number(process.env.AURORA_IDLE_PORT ?? 9517)
const EXE = 'release/win-unpacked/Aurora Music.exe'
const REAL_PROFILE = process.env.APPDATA ? join(process.env.APPDATA, 'aurora-music') : ''

/** The three panel views, in the order they are measured. `label` is the button's own text. */
const VIEWS = [
  { id: 'spectrum', label: '频谱律动' },
  { id: 'vinyl', label: '拟真唱片' },
  { id: 'lyrics', label: '歌词' }
]

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

if (!existsSync(EXE)) {
  console.log(`FAIL 找不到打包产物 ${EXE} —— 先跑 npm run build:dir`)
  process.exit(1)
}

function powershell(command) {
  const out = spawnSync('powershell', ['-NoProfile', '-Command', command], { encoding: 'utf8' })
  if (out.status !== 0 || String(out.stderr ?? '').trim()) {
    // A probe that swallows its own failures reports zeros, and zeros read as "the app is free".
    lastStderr = String(out.stderr ?? '').trim()
  }
  return String(out.stdout ?? '').trim()
}

let lastStderr = ''

/**
 * Processor-seconds per process type: `renderer`, `gpu`, `main`, everything else as `other`.
 *
 * A single summed number cannot say whether the cost is JavaScript, rasterisation or compositing, and those
 * three want opposite fixes. The type comes from each child's own command line, so nothing is inferred from
 * process order or memory size.
 */
let warnedEmptySample = false

function cpuByType() {
  /*
   * No double quotes anywhere in this script, and that is not style.
   *
   * Node passes an argument list to `CreateProcess` and does not escape quotes embedded *inside* an argument,
   * so `-Filter "Name = 'Aurora Music.exe'"` arrives at PowerShell mangled and the whole snippet fails — while
   * the identical text typed into a shell by hand works perfectly. That mismatch is what made this reading
   * come back as four zeros while the app was plainly using CPU. Comparing `Name` inside `Where-Object` needs
   * no quoting at all, so the failure mode cannot come back.
   */
  const script =
    "$rows = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'Aurora Music.exe' } | " +
    "ForEach-Object { $t = 'main'; if ($_.CommandLine -match '--type=([a-zA-Z0-9-]+)') { $t = $matches[1] }; " +
    "$c = (Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue).CPU; if ($null -eq $c) { $c = 0 }; " +
    "[pscustomobject]@{ type = $t; cpu = [double]$c } }; " +
    "$rows | Group-Object type | ForEach-Object { " +
    "[pscustomobject]@{ type = $_.Name; cpu = ($_.Group | Measure-Object -Property cpu -Sum).Sum } } | " +
    'ConvertTo-Json -Compress'
  const raw = powershell(script)
  const totals = { renderer: 0, gpu: 0, main: 0, other: 0 }
  if (!raw) {
    // An empty reading is a broken probe, not a cheap app, so it says so instead of reporting zeros.
    if (!warnedEmptySample) {
      warnedEmptySample = true
      console.log('  [probe] 分类采样没拿到任何数据 —— 这轮数字不能当成本读数')
      if (lastStderr) console.log(`  [probe] powershell 说：${lastStderr.slice(0, 300)}`)
    }
    return totals
  }
  let rows = []
  try {
    rows = JSON.parse(raw)
  } catch {
    return totals
  }
  for (const row of Array.isArray(rows) ? rows : [rows]) {
    const kind = String(row.type ?? '')
    const key = kind === 'renderer' ? 'renderer' : kind === 'gpu-process' ? 'gpu' : kind === 'main' || kind === '' ? 'main' : 'other'
    totals[key] += Number(row.cpu) || 0
  }
  return totals
}

function totalOf(totals) {
  return totals.renderer + totals.gpu + totals.main + totals.other
}

const profile = mkdtempSync(join(tmpdir(), 'aurora-idle-'))
for (const name of ['library.json', 'settings.json']) {
  const source = join(REAL_PROFILE, name)
  if (existsSync(source)) copyFileSync(source, join(profile, name))
}
const covers = join(REAL_PROFILE, 'covers')
if (existsSync(covers)) cpSync(covers, join(profile, 'covers'), { recursive: true })
/*
 * The play queue lives in the renderer's `localStorage`, which is Chromium's leveldb store — a copy of the
 * two JSON files alone gives a session with a library but nothing to play. Only that one small directory is
 * copied, never the whole 466 MB profile.
 */
const storage = join(REAL_PROFILE, 'Local Storage')
if (existsSync(storage)) cpSync(storage, join(profile, 'Local Storage'), { recursive: true })

const child = spawn(EXE, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--mute-audio'], {
  stdio: ['ignore', 'pipe', 'pipe']
})
child.stderr.on('data', (chunk) => {
  const text = String(chunk).trim()
  if (text && !text.includes('DevTools listening')) console.log(`  [main] ${text}`)
})

let ws = null
let messageId = 0

async function findTarget(attempts = 60) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await response.json()
      const target = list.find((item) => item.type === 'page' && !item.url.includes('desktop-lyrics'))
      if (target?.webSocketDebuggerUrl) return target
    } catch {
      // not up yet
    }
    await delay(500)
  }
  return null
}

function send(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++messageId
    const timer = setTimeout(() => {
      ws.removeEventListener('message', onMessage)
      reject(new Error(`CDP ${method} 超时`))
    }, 120000)
    const onMessage = (event) => {
      const payload = JSON.parse(String(event.data))
      if (payload.id !== id) return
      clearTimeout(timer)
      ws.removeEventListener('message', onMessage)
      if (payload.error) reject(new Error(JSON.stringify(payload.error)))
      else resolve(payload.result)
    }
    ws.addEventListener('message', onMessage)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

/** Evaluates an expression and returns its JSON-parsed value. Every failure names its own expression. */
async function json(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails)
    throw new Error(`页面里抛了：${expression.slice(0, 70)} -> ${detail}`)
  }
  return result.result?.value
}

function cleanup() {
  if (child.pid) spawnSync('taskkill', ['/F', '/PID', String(child.pid), '/T'], { stdio: 'ignore' })
  try {
    if (ws) ws.close()
  } catch {
    // already gone
  }
}

process.on('exit', cleanup)
process.on('SIGINT', () => {
  cleanup()
  process.exit(130)
})

/** Median of a numeric list, so one noisy round cannot move the answer. */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/** Clicks a lyric-panel view button by its own label, and confirms the view really changed. */
async function selectView(label) {
  const clicked = await json(`(() => {
    const buttons = [...document.querySelectorAll('.lp-viewswitch button')]
    const button = buttons.find((item) => item.textContent.trim() === ${JSON.stringify(label)})
    if (!button) return 'missing'
    button.click()
    return 'ok'
  })()`)
  if (clicked !== 'ok') throw new Error(`找不到视图按钮「${label}」`)
  await delay(400)
}

/**
 * Self time per function, from the CDP profile.
 *
 * `timeDeltas[i]` is the interval that ended at `samples[i]`, which is the correct attribution for a
 * sampling profile — counting samples alone weights every frame equally regardless of how long it took.
 */
function topSelfTime(profile, limit = 18) {
  const byNode = new Map()
  for (let index = 0; index < profile.samples.length; index += 1) {
    const id = profile.samples[index]
    const micros = profile.timeDeltas[index] ?? 0
    byNode.set(id, (byNode.get(id) ?? 0) + micros)
  }
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]))
  const rows = []
  for (const [id, micros] of byNode) {
    const frame = nodes.get(id)?.callFrame
    const name = frame?.functionName || '(anonymous)'
    const where = `${(frame?.url ?? '').split('/').slice(-1)[0]}:${(frame?.lineNumber ?? -1) + 1}`
    rows.push({ key: `${name}  ${where}`, micros })
  }
  // The sampler's own bookkeeping and the empty stack are not application work.
  return rows
    .filter((row) => !row.key.startsWith('(idle)') && !row.key.startsWith('(program)') && !row.key.startsWith('(root)'))
    .sort((left, right) => right.micros - left.micros)
    .slice(0, limit)
}

async function main() {
  const target = await findTarget()
  if (!target) {
    console.log('FAIL 连不上应用调试端口')
    cleanup()
    process.exit(1)
  }
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve)
    ws.addEventListener('error', () => reject(new Error('调试连接建立失败')))
  })

  // Route to the playback page. The shell is a hash router, so this is a real navigation.
  await json(`(() => { location.hash = '#/lyrics'; return 'ok' })()`)
  let ready = false
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const count = await json(`document.querySelectorAll('.lp-viewswitch button').length`)
    if (Number(count) >= 3) {
      ready = true
      break
    }
    await delay(500)
  }
  if (!ready) {
    console.log('FAIL 播放页没有渲染出视图切换胶囊')
    cleanup()
    process.exit(1)
  }

  /*
   * Pause through the app's own control.
   *
   * Pausing the element directly would leave the store believing it is playing, and the store is what the
   * canvases read — a "paused" reading taken that way would still be paying for every playing-state loop.
   * The button's own title is the state, so it is also the assertion: it says 暂停 only while playing.
   */
  const WANT = (() => {
    const index = args.indexOf('--state')
    const value = index >= 0 ? args[index + 1] : 'paused'
    return value === 'playing' ? 'playing' : 'paused'
  })()

  /**
   * Drives the app to the state being measured, through the app's own transport button.
   *
   * `audio.paused` is deliberately not consulted: the decks are `new Audio()` objects outside the document,
   * so a DOM query returns `null` — and a `null` compared with `!== true` reads as "playing" forever, which
   * is exactly how the first version of this probe measured a paused app while believing it was playing.
   * The button's title is the store's own playback state, and it is the one the visuals read.
   */
  async function ensureState() {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const title = await json(`(() => {
        const button = [...document.querySelectorAll('button')].find((item) => item.title === '播放' || item.title === '暂停')
        return button ? button.title : ''
      })()`)
      lastTransport = String(title ?? '')
      const isPlaying = lastTransport === '暂停'
      if (WANT === 'playing' ? isPlaying : !isPlaying && lastTransport === '播放') return true
      await json(`(() => {
        const button = [...document.querySelectorAll('button')].find((item) => item.title === '播放' || item.title === '暂停')
        if (button) button.click()
        return 'ok'
      })()`)
      await delay(900)
    }
    return false
  }

  let lastTransport = ''

  const reached = await ensureState()
  console.log(`=== 状态 ===\n目标：${WANT === 'playing' ? '播放' : '暂停'} · 已达成：${reached}（传输键现在显示「${lastTransport}」）\n`)
  if (!reached) {
    /*
     * The paused state is what a launcher always starts in, so failing to reach it is a real fault. Playing is
     * different: it needs a queue that survived the copy **and** a track that can still be opened (an online
     * stream needs the network). When it cannot be driven, that is an environment fact, and it is reported as
     * one — the playing half of the gate policy is pinned without an audio device in `smoke:visual`.
     */
    if (WANT !== 'playing') {
      console.log('FAIL 无法把应用驱动到暂停态；在另一个状态量出来的数字不能当作这个状态的成本')
      cleanup()
      process.exit(1)
    }
    console.log('SKIP 播放态不可达（临时 profile 里没有可打开的队列曲目）—— 暂停态仍是强制项')
    cleanup()
    process.exit(0)
  }

  console.log(`=== 逐视图空转 CPU（${ROUNDS} 轮 × ${SECONDS} s，交错采样，取中位数） ===`)
  const samples = new Map(VIEWS.map((view) => [view.id, []]))
  const byType = new Map(VIEWS.map((view) => [view.id, []]))
  for (let round = 0; round < ROUNDS; round += 1) {
    const order = round % 2 === 0 ? VIEWS : [...VIEWS].reverse()
    for (const view of order) {
      await selectView(view.label)
      // A track that ends advances and starts playing, so the state is re-asserted per sample rather than
      // assumed to hold for the whole run.
      if (!(await ensureState())) throw new Error(`采样前无法回到${WANT === 'playing' ? '播放' : '暂停'}态`)
      await delay(1500)
      const before = cpuByType()
      await delay(SECONDS * 1000)
      const after = cpuByType()
      const delta = {
        renderer: after.renderer - before.renderer,
        gpu: after.gpu - before.gpu,
        main: after.main - before.main,
        other: after.other - before.other
      }
      const used = totalOf(delta)
      samples.get(view.id).push(used)
      byType.get(view.id).push(delta)
      console.log(
        `  第${round + 1}轮  ${view.label.padEnd(6)}合计 ${used.toFixed(3)} 核·秒  ` +
          `(renderer ${delta.renderer.toFixed(3)} · gpu ${delta.gpu.toFixed(3)} · main ${delta.main.toFixed(3)} · other ${delta.other.toFixed(3)})`
      )
    }
  }
  const medians = {}
  console.log('')
  for (const view of VIEWS) {
    const values = samples.get(view.id)
    medians[view.id] = median(values)
    const parts = byType.get(view.id)
    const share = (key) => median(parts.map((part) => part[key]))
    console.log(
      `${view.label.padEnd(6)}中位数 ${medians[view.id].toFixed(3)} 核·秒 / ${SECONDS} s = ${(medians[view.id] / SECONDS).toFixed(3)} 核  ` +
        `[renderer ${share('renderer').toFixed(3)} · gpu ${share('gpu').toFixed(3)} · main ${share('main').toFixed(3)} · other ${share('other').toFixed(3)}]`
    )
  }
  const cheap = Math.min(...Object.values(medians))
  console.log('')
  for (const view of VIEWS) {
    const extra = medians[view.id] - cheap
    console.log(`${view.label.padEnd(6)}相对最低视图：${extra >= 0 ? '+' : ''}${extra.toFixed(3)} 核·秒 = ${(extra / SECONDS).toFixed(3)} 核`)
  }

  /*
   * The assertions.
   *
   * The reading above is a measurement, and a measurement only becomes a check when it can fail. What is
   * pinned is the *policy that the measurement justified*: a paused player runs its decoration on the 30 fps
   * floor (`data-fx-gate`, written by the frame loop itself) and therefore really draws at that rate — while
   * still drawing at all, because an ambience frozen solid is the other failure this could have.
   */
  const assertions = []
  const pin = (name, ok, detail) => {
    assertions.push({ name, ok: Boolean(ok) })
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
  }

  await selectView('歌词')
  await delay(2500)
  const live = await json(`(() => {
    const root = document.documentElement
    return JSON.stringify({
      gate: Number(root.dataset.fxGate || 0),
      draw: Number(root.dataset.fxDraw || 0),
      budget: Number(root.dataset.fxBudget || 0),
      hz: Number(root.dataset.fxHz || 0),
      scale: Number(root.dataset.fxScale || 1),
      playing: root.dataset.playing === 'true',
      focus: root.dataset.fxFocus || ''
    })
  })()`)
  const idleReading = typeof live === 'string' ? JSON.parse(live) : live
  console.log(`\n=== 断言（${WANT === 'playing' ? '播放' : '暂停'}态） ===`)
  if (WANT === 'paused') {
    pin('被测窗口确实处于暂停、且在前台', idleReading.playing === false && idleReading.focus === 'active', idleReading)
    pin('暂停时的门闸就是 30fps 地板（不是跟随面板）', idleReading.gate >= 33 && idleReading.gate <= 34, { gate: idleReading.gate, hz: idleReading.hz })
    pin('实绘帧率真的落在这个地板上，而不是只改了预算数字', idleReading.draw > 0 && idleReading.draw <= 33, { draw: idleReading.draw })
    pin('暂停时装饰并未被冻死（仍在动，只是慢了）', idleReading.draw >= 5, { draw: idleReading.draw })
    /*
     * 画布真的缩小了。
     *
     * 这条断言管的是“省下来的钱在哪儿”：门闸把频率减半，像素比乘子再把剩下的填充面积减半。两个都发生在
     * 画布上，而画布是暂停态最大的一项，所以把数说清楚（而不是说“优化了”）比什么都重要。
     */
    pin('空闲画布真的降了背板分辨率（面积约减半）', idleReading.scale > 0.6 && idleReading.scale < 0.8, { scale: idleReading.scale })
  } else {
    /*
     * The other half of the change, and the one that would be a regression rather than a saving: the idle floor
     * must not leak into playback. A playing window keeps the user's own budget — on a 165 Hz panel that is
     * 6.06 ms, and the field really draws near that. Without this pair, halving the paused cadence could be
     * implemented as "halve everything" and only the paused check would notice.
     */
    pin('播放时仍然按所选预算跑（暂停地板没有渗到播放）', idleReading.playing === true && idleReading.gate <= 6.2, { gate: idleReading.gate, budget: idleReading.budget })
    pin('播放时的实绘帧率是高刷面板的节奏，不是 30', idleReading.draw >= 40, { draw: idleReading.draw, hz: idleReading.hz })
  }

  const failed = assertions.filter((item) => !item.ok)
  console.log(`\n${assertions.length - failed.length}/${assertions.length} 通过`)
  if (failed.length) {
    cleanup()
    process.exit(1)
  }

  if (ATTRIBUTE) {
    /*
     * One candidate at a time, and every sample is taken the same way as the readings above (interleaved
     * rounds, median). The baseline is re-measured between every candidate rather than once at the start:
     * an earlier round watched the same state read from 121 % down to 72 % over several minutes, so a
     * baseline taken once would silently attribute its own drift to whichever layer happened to be hidden.
     */
    const CANDIDATES = [
      {
        id: '画布粒子层',
        apply: `document.querySelectorAll('canvas.ambient-layer').forEach((el) => { el.style.display = 'none' })`,
        reset: `document.querySelectorAll('canvas.ambient-layer').forEach((el) => { el.style.display = '' })`
      },
      {
        id: 'CSS 背景层',
        apply: `document.querySelectorAll('.ambient-glow, .ambient-field, .ambient-photo, .ambient-skin, .ambient-backdrop').forEach((el) => { el.style.display = 'none' })`,
        reset: `document.querySelectorAll('.ambient-glow, .ambient-field, .ambient-photo, .ambient-skin, .ambient-backdrop').forEach((el) => { el.style.display = '' })`
      },
      {
        id: '全部 backdrop-filter',
        apply: `(() => {
          const style = document.createElement('style')
          style.id = 'idle-probe-no-blur'
          style.textContent = '* { backdrop-filter: none !important; -webkit-backdrop-filter: none !important }'
          document.head.appendChild(style)
          return 'ok'
        })()`,
        reset: `(() => {
          document.getElementById('idle-probe-no-blur')?.remove()
          return 'ok'
        })()`
      }
    ]

    const blurCount = await json(`(() => {
      let count = 0
      const sample = []
      for (const element of document.querySelectorAll('*')) {
        const value = getComputedStyle(element).backdropFilter
        if (value && value !== 'none') {
          count += 1
          if (sample.length < 6) sample.push(element.className || element.tagName)
        }
      }
      return JSON.stringify({ count, sample })
    })()`)
    const blurInfo = typeof blurCount === 'string' ? JSON.parse(blurCount) : blurCount
    console.log(`\n=== 归因：暂停时谁在消耗 GPU ===`)
    console.log(`页面上带 backdrop-filter 的元素：${blurInfo.count} 个（例：${(blurInfo.sample ?? []).join(' / ')}）`)

    await selectView('歌词')
    const rows = []
    for (const candidate of CANDIDATES) {
      const off = []
      const on = []
      for (let round = 0; round < ROUNDS; round += 1) {
        await json(candidate.reset)
        await delay(1000)
        let before = cpuByType()
        await delay(SECONDS * 1000)
        let after = cpuByType()
        on.push(after.gpu - before.gpu)
        const totalOn = totalOf(after) - totalOf(before)
        await json(candidate.apply)
        await delay(1000)
        before = cpuByType()
        await delay(SECONDS * 1000)
        after = cpuByType()
        off.push(after.gpu - before.gpu)
        const totalOff = totalOf(after) - totalOf(before)
        console.log(
          `  第${round + 1}轮 ${candidate.id}：保留 gpu ${on[round].toFixed(3)} → 屏蔽 gpu ${off[round].toFixed(3)}  ` +
            `(合计 ${totalOn.toFixed(3)} → ${totalOff.toFixed(3)} 核·秒 / ${SECONDS} s)`
        )
      }
      await json(candidate.reset)
      const saved = median(on) - median(off)
      rows.push({ id: candidate.id, gpuOn: median(on), gpuOff: median(off), saved })
    }
    console.log('')
    for (const row of rows) {
      console.log(
        `${row.id.padEnd(16)}GPU ${row.gpuOn.toFixed(3)} → ${row.gpuOff.toFixed(3)} 核·秒  省 ${row.saved.toFixed(3)} = ${(row.saved / SECONDS).toFixed(3)} 核`
      )
    }
  }

  if (PROFILE) {
    console.log(`\n=== 频谱视图暂停时的 CPU profile（${SECONDS} s，按 self time 排序） ===`)
    await selectView('频谱律动')
    await delay(1200)
    await send('Profiler.enable')
    await send('Profiler.setSamplingInterval', { interval: 200 })
    await send('Profiler.start')
    await delay(SECONDS * 1000)
    const { profile: captured } = await send('Profiler.stop')
    const total = captured.timeDeltas.reduce((sum, value) => sum + value, 0)
    console.log(`样本 ${captured.samples.length} 个 · 覆盖 ${(total / 1e6).toFixed(2)} s`)
    console.log('self time        占采样     函数')
    for (const row of topSelfTime(captured)) {
      console.log(`${(row.micros / 1e6).toFixed(3)} s        ${((row.micros / total) * 100).toFixed(1).padStart(5)}%   ${row.key}`)
    }
  }

  cleanup()
  console.log('\n完成。')
  process.exit(0)
}

main().catch((error) => {
  console.log(`FAIL ${error.message}`)
  cleanup()
  process.exit(1)
})
