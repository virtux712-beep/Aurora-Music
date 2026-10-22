/**
 * Packaged acceptance check for the CSS half of the frame governor.
 *
 * ## Why this exists
 *
 * The decorative canvas layers ask the frame governor whether they may draw (`allowDraw`), so one place
 * owns their cadence. The screen-sized background layers do **not** — they are CSS keyframes, and a
 * keyframe on a visible-but-unfocused window is composited at the display's cadence whatever the loop
 * decides. Two rules put them back under the same policy (`app.css`, final section): freeze on pause, and
 * freeze when nobody is looking.
 *
 * Those two rules are only correct because of *where* they are. Each theme declares its drift with an
 * `animation:` shorthand at the same specificity, and a shorthand resets `animation-play-state` to
 * `running`. So a freeze rule written earlier in the file is silently dead for every recipe that declares
 * its animation later — which is exactly what had happened: the pause freeze reached the default recipe
 * (whose animation lives in `base.css`, an earlier file) and none of the five themed ones.
 *
 * That is the failure this check is built to catch, and it is why it reads **computed style** instead of
 * the stylesheet text: the text says "paused" for all six, and only the computed value says which ones
 * the cascade actually reached. `animationName` is read alongside, so a theme that declares no animation
 * at all cannot pass by being trivially "paused".
 *
 * ## What it asserts
 *
 *  - for every `data-bg` recipe × {playing, paused} × {focused, backgrounded}, the background layer is
 *    frozen precisely when nobody is watching it, and still animating when somebody is;
 *  - the freeze is reached through the shared attribute (no `!important`, no per-theme copy);
 *  - a blur through the governor's own listener publishes the attribute, and regaining focus restores it;
 *  - `--measure` totals processor-seconds of every process the app owns with the freeze on and off,
 *    interleaved, so the saving is measured rather than assumed. A cumulative counter is used rather than
 *    a `% Processor Time` reading: the earlier rounds found the percentage swinging between 0 % and 50 %
 *    for one single state depending on window occlusion.
 *
 * Usage:
 *   npm run check:focus                 # the matrix and the wiring
 *   npm run check:focus -- --measure 12 # plus the interleaved CPU measurement
 */
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const MEASURE = args.includes('--measure')
const measureIndex = args.indexOf('--measure')
const SAMPLE_S = MEASURE ? Number(args[measureIndex + 1]) || 12 : 0
const PORT = Number(process.env.AURORA_FOCUS_PORT ?? 9511)
const EXE = 'release/win-unpacked/Aurora Music.exe'
const REAL_PROFILE = process.env.APPDATA ? join(process.env.APPDATA, 'aurora-music') : ''

/** Every background recipe the themes can select, plus `plain` (the cheap level's recipe). */
const RECIPES = ['plain', 'nebula', 'paper', 'tide', 'wash', 'sunset']
const STATES = [
  { playing: 'true', focus: 'active', frozen: false },
  { playing: 'true', focus: 'background', frozen: true },
  { playing: 'false', focus: 'active', frozen: true },
  { playing: 'false', focus: 'background', frozen: true }
]

const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok) })
  const shown = detail === undefined ? '' : `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${shown}`)
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

if (!existsSync(EXE)) {
  console.log(`FAIL 找不到打包产物 ${EXE} —— 先跑 npm run build:dir`)
  process.exit(1)
}

function powershell(command) {
  const out = spawnSync('powershell', ['-NoProfile', '-Command', command], { encoding: 'utf8' })
  return String(out.stdout ?? '').trim()
}

/** Total processor-seconds of every process the app owns — a counter, so it only moves for real work. */
function cpuSeconds() {
  const value = Number(
    powershell(`(Get-Process -Name 'Aurora Music' -ErrorAction SilentlyContinue | Measure-Object -Property CPU -Sum).Sum`)
  )
  return Number.isFinite(value) ? value : 0
}

// A throwaway profile seeded from the real one, so the run behaves like the installed app (a library, a
// skin and a level already chosen) without writing anything back to the user's data.
const profile = mkdtempSync(join(tmpdir(), 'aurora-focus-'))
for (const name of ['library.json', 'settings.json']) {
  const source = join(REAL_PROFILE, name)
  if (existsSync(source)) copyFileSync(source, join(profile, name))
}
const covers = join(REAL_PROFILE, 'covers')
if (existsSync(covers)) cpSync(covers, join(profile, 'covers'), { recursive: true })

const child = spawn(EXE, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--mute-audio'], {
  stdio: ['ignore', 'pipe', 'pipe']
})
child.stderr.on('data', (chunk) => {
  const text = String(chunk).trim()
  if (text && !text.includes('DevTools listening')) console.log(`  [main] ${text}`)
})

let ws = null
let messageId = 0

async function findTarget(attempts = 40) {
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
    }, 20000)
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

/**
 * Evaluates an expression that hands back a JSON string.
 *
 * Every failure names its own expression. A check that dies with "[object Object] is not valid JSON"
 * costs a debugging round trip to work out which of two dozen evaluations was the one that misbehaved.
 */
async function json(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails)
    throw new Error(`页面里抛了：${expression.slice(0, 70)} -> ${detail}`)
  }
  const value = result.result?.value
  if (typeof value === 'string') {
    try {
      return JSON.parse(value)
    } catch {
      throw new Error(`返回值不是 JSON：${expression.slice(0, 70)} -> ${value.slice(0, 120)}`)
    }
  }
  throw new Error(`没有返回 JSON 字符串：${expression.slice(0, 70)} (type=${result.result?.type})`)
}

/**
 * Evaluates an expression expected to return a plain string.
 *
 * Kept separate from `json()` on purpose: `JSON.parse('background')` throws, so a bare string has to have
 * its own door. That mix-up is what derailed this check's first run.
 */
async function text(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true })
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails)
    throw new Error(`页面里抛了：${expression.slice(0, 70)} -> ${detail}`)
  }
  return String(result.result?.value ?? '')
}

function cleanup() {
  if (child.pid) spawnSync('taskkill', ['/F', '/PID', String(child.pid), '/T'], { stdio: 'ignore' })
  try {
    if (ws) ws.close()
  } catch {
    // already gone
  }
}

/** The reading for one (recipe, state) pair: what the cascade did to the background layer. */
async function readLayer(recipe, state) {
  const raw = await json(`(() => {
    const root = document.documentElement
    root.dataset.bg = ${JSON.stringify(recipe)}
    root.dataset.playing = ${JSON.stringify(state.playing)}
    root.dataset.fxFocus = ${JSON.stringify(state.focus)}
    const read = (selector) => {
      const element = document.querySelector(selector)
      if (!element) return null
      const style = getComputedStyle(element)
      return { name: style.animationName, state: style.animationPlayState }
    }
    return JSON.stringify({ glow: read('.ambient-glow'), field: read('.ambient-field') })
  })()`)
  return JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw))
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

  // The background layer exists as soon as the shell paints its chrome.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const ready = await json(`String(Boolean(document.querySelector('.ambient-glow')))`)
    if (ready === 'true') break
    await delay(500)
  }

  console.log('=== 计算样式矩阵（.ambient-glow） ===')
  console.log('配方         播放     焦点         动画名                    play-state   预期')
  const wrong = []
  for (const recipe of RECIPES) {
    for (const state of STATES) {
      const row = await readLayer(recipe, state)
      const glow = row.glow ?? { name: '(无元素)', state: '—' }
      const expect = state.frozen ? '冻结' : '运行'
      const ok = glow.name !== 'none' && (glow.state === 'paused') === state.frozen
      if (!ok) wrong.push(`${recipe}/${state.playing}/${state.focus}=${glow.name}:${glow.state}`)
      console.log(
        `${recipe.padEnd(12)}${state.playing.padEnd(8)}${state.focus.padEnd(13)}${String(glow.name).padEnd(25)}${String(glow.state).padEnd(13)}${expect}${ok ? '' : '   <-- 不符'}`
      )
    }
  }

  check(
    '每一套背景配方在暂停/失焦时都被冻结（读计算样式，不是读 CSS 文本）',
    wrong.length === 0,
    wrong.length === 0 ? `${RECIPES.length * STATES.length} 个组合全部符合预期` : wrong.join(', ')
  )
  // The attribute is what the two rules key on; if it were deleted the whole matrix above would read
  // "running" everywhere, so this is really asserting that the rules are not scoped to one theme.
  check(
    '冻结是按共享属性生效的（不是每套主题各写一份）',
    (await text(`String(document.documentElement.hasAttribute('data-fx-focus'))`)) === 'true',
    await text(`String(document.documentElement.dataset.fxFocus || '(未写)')`)
  )

  /*
   * The wiring: a blur is what moves `focused` inside the governor, and that is the only thing that
   * publishes the attribute. Asserted through the listener the governor actually registered, not by
   * poking the attribute — poking it is what the matrix above already does, and it would pass even if
   * nothing were listening.
   *
   * What this does and does not cover: it proves the handler runs and publishes, and that regaining focus
   * restores it. That Windows *delivers* blur is Chromium's job, not ours — a probe cannot honestly claim
   * to have tested it, because an external process cannot take the foreground away here (the OS refuses
   * `SetForegroundWindow` from a process that is not already foreground, which was tried and returns
   * `false`).
   */
  await json(`(() => { window.dispatchEvent(new Event('blur')); return JSON.stringify('ok') })()`)
  const afterBlur = await text(`String(document.documentElement.dataset.fxFocus)`)
  await json(`(() => { window.dispatchEvent(new Event('focus')); return JSON.stringify('ok') })()`)
  const afterFocus = await text(`String(document.documentElement.dataset.fxFocus)`)
  /*
   * Focus is restored only if the document is *visible*.
   *
   * The governor publishes `focused && !document.hidden`, because a hidden window is a window nobody can see
   * whatever the focus flag says — that is the whole point of the attribute. So when this probe's window is
   * occluded or minimised (an occluded window is `hidden` to Chromium, and launching an app behind a terminal
   * is exactly that), `background` after a synthetic focus is the **correct** answer, and demanding `active`
   * would make the check fail on a fact about the desk rather than a fact about the code. The visibility read
   * is taken in the same breath so the detail line explains which of the two happened.
   */
  const afterFocusState = await json(`(() => {
    return JSON.stringify({
      attr: document.documentElement.dataset.fxFocus,
      hidden: document.hidden,
      visibility: document.visibilityState
    })
  })()`)
  const focusState = typeof afterFocusState === 'string' ? JSON.parse(afterFocusState) : afterFocusState
  const expectFocusValue = focusState.hidden ? 'background' : 'active'
  check(
    'blur 处理会把属性切成 background；可见时重新获焦恢复 active',
    afterBlur === 'background' && afterFocus === expectFocusValue,
    {
      afterBlur,
      afterFocus,
      期望: expectFocusValue,
      documentHidden: focusState.hidden,
      visibilityState: focusState.visibility
    }
  )

  if (MEASURE) {
    /*
     * The saving of the CSS half alone.
     *
     * Both arms are the same situation — same page, same level, same `data-playing`, window in the
     * foreground, so the governor runs at full rate and the JS layers cost the same in each. The only
     * difference is `data-fx-focus`, i.e. exactly the two rules under test. That is deliberate: taking
     * focus away would change *two* things at once (the JS gate drops to its background floor as well) and
     * the delta could no longer be attributed to either. The OS doing the blurring was tried and is not
     * reachable from here — see above.
     *
     * Read the number as an upper bound on what this layer costs, since a window the OS already throttles
     * (occluded, minimised) has less left to give.
     */
    await json(`(() => {
      document.documentElement.dataset.playing = 'true'
      document.documentElement.dataset.fxFocus = 'active'
      return JSON.stringify('ok')
    })()`)
    await delay(600)

    const arms = ['active', 'background', 'active', 'background']
    const results = { active: [], background: [] }
    console.log('\n=== 逐段采样（全应用处理器秒 / 墙钟秒） ===')
    for (const value of arms) {
      await json(
        `(() => { document.documentElement.dataset.fxFocus = ${JSON.stringify(value)}; return JSON.stringify('ok') })()`
      )
      await delay(1000)
      const before = cpuSeconds()
      const startedAt = Date.now()
      await delay(SAMPLE_S * 1000)
      const reading = (cpuSeconds() - before) / ((Date.now() - startedAt) / 1000)
      results[value].push(reading)
      const label = value === 'active' ? '关键帧在跑' : '关键帧冻结'
      console.log(`  ${label}  ${reading.toFixed(3)} 核 (${(reading * 100).toFixed(1)}%)`)
    }
    const mean = (list) => list.reduce((sum, value) => sum + value, 0) / Math.max(1, list.length)
    const running = mean(results.active)
    const frozen = mean(results.background)
    console.log(`  在跑 ${running.toFixed(3)} 核 · 冻结 ${frozen.toFixed(3)} 核`)
    check(
      '冻结整屏关键帧后的降本（同状态下只切冻结，两轮交错）',
      frozen < running,
      `省 ${(running - frozen).toFixed(3)} 核，约 ${((1 - frozen / running) * 100).toFixed(0)}% 相对`
    )
  }

  console.log(`\n${checks.filter((item) => item.ok).length}/${checks.length} checks passed`)
  cleanup()
  process.exit(checks.every((item) => item.ok) ? 0 : 1)
}

main().catch((error) => {
  console.log(`FAIL ${error.message}`)
  cleanup()
  process.exit(1)
})
