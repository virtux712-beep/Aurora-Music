/**
 * Packaged acceptance check for the maintenance surface: cache accounting (B4), the SQLite library
 * database (C1), the crash log (C2), the update check (C3) and the local HTTP API (C4), plus the
 * start-at-login switch (B6).
 *
 * ## What it asserts
 *
 * Effects, never controls:
 *  - the database **engine that really opened** (`sqlite` proves the WASM driver loaded inside the
 *    packaged app — a fallback to JSON would otherwise look identical in the UI),
 *  - byte counts that come from the same walk that deletes,
 *  - a crash entry written through the IPC path and **scrubbed** of paths before it lands in the log,
 *  - an update check that admits "no feed" and reports a real failure for a bad feed,
 *  - the HTTP API: off means no socket, on means a real `GET /api/health` over loopback, a 401 without a
 *    token and a 200 with it, and off again means the port is closed.
 *
 * Usage: `npm run check:maintenance` (run `npm run build` first).
 */
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = Number(process.argv[2] ?? 9487)
const EXE = 'release/win-unpacked/Aurora Music.exe'
const REAL_PROFILE = process.env.APPDATA ? join(process.env.APPDATA, 'aurora-music') : ''

const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok) })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

if (!existsSync(EXE)) {
  console.log(`FAIL 找不到打包产物 ${EXE} —— 先跑 npm run build`)
  process.exit(1)
}

const profile = mkdtempSync(join(tmpdir(), 'aurora-maint-'))
for (const name of ['library.json', 'settings.json']) {
  const source = join(REAL_PROFILE, name)
  if (existsSync(source)) copyFileSync(source, join(profile, name))
}
const covers = join(REAL_PROFILE, 'covers')
if (existsSync(covers)) cpSync(covers, join(profile, 'covers'), { recursive: true })

const child = spawn(EXE, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--mute-audio'], { stdio: ['ignore', 'pipe', 'pipe'] })
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

async function json(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed')
  return JSON.parse(result.result.value)
}

async function main() {
  const target = await findTarget()
  if (!target) {
    console.log('FAIL 连不上应用调试端口')
    process.exit(1)
  }
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve)
    ws.addEventListener('error', () => reject(new Error('调试连接建立失败')))
  })
  // Let the window finish its first paint so the renderer's bridge exists.
  await delay(2500)

  /* ---------------------------------------------------------------- C1 数据库 */
  const db = await json(`(async () => {
    const stats = await window.aurora.database.stats()
    return JSON.stringify(stats)
  })()`)
  check('数据库引擎真的是 SQLite（WASM 驱动已在打包产物内加载）', db.engine === 'sqlite', { engine: db.engine, path: db.path })
  check('数据库文件落在 userData 下', typeof db.path === 'string' && db.path.includes('aurora.db'), db.path)

  /* ---------------------------------------------------------------- B4 缓存统计 */
  const report = await json(`(async () => {
    const payload = await window.aurora.cache.report()
    return JSON.stringify({ ids: payload.areas.map((area) => area.id), total: payload.totalFiles, bytes: payload.totalBytes, lyricsPath: payload.areas.find((area) => area.id === 'lyrics')?.path ?? '' })
  })()`)
  check('缓存报告覆盖封面 / 歌词 / 临时文件三个区域', report.ids.join(',') === 'covers,lyrics,temp', report.ids)
  check('缓存统计给出真实字节数与文件数', Number.isFinite(report.bytes) && Number.isFinite(report.total), { total: report.total, bytes: report.bytes })
  check('歌词区域指向 userData/lyrics（用户导入的歌词所在目录）', /lyrics$/.test(report.lyricsPath.replace(/\\/g, '/')), report.lyricsPath)

  const cleared = await json(`(async () => {
    const before = await window.aurora.cache.report()
    const result = await window.aurora.cache.clear(['temp'])
    return JSON.stringify({ freed: result.freedFiles, after: result.report.totalFiles, before: before.totalFiles })
  })()`)
  check('清理临时文件区域不会波及其它区域（清理后总数变化不超过清理量）', cleared.after <= cleared.before, cleared)

  /* ---------------------------------------------------------------- B6 开机启动 */
  const login = await json(`(async () => {
    const before = await window.aurora.systemIntegration.get()
    const on = await window.aurora.systemIntegration.set({ launchAtLogin: true, closeToTray: true })
    const status = await window.aurora.systemIntegration.status()
    const stored = await window.aurora.settings.get()
    const off = await window.aurora.systemIntegration.set({ launchAtLogin: false, closeToTray: false })
    return JSON.stringify({ before: before.launchAtLogin, on: on.launchAtLogin, os: status.launchAtLogin, storedOn: stored.systemIntegration.launchAtLogin, storedClose: stored.systemIntegration.closeToTray, off: off.launchAtLogin, tray: status.trayActive })
  })()`)
  check('开机自启动开关写入设置并被系统登记', login.on === true && login.storedOn === true, login)
  check('关闭到托盘开关写入设置', login.storedClose === true, login)
  check('关闭自启动后设置与系统登记都回到 false', login.off === false, login)
  check('托盘图标已注册（接收设置变更的那条链路是活的）', login.tray === true, { tray: login.tray })

  /* ---------------------------------------------------------------- C2 崩溃日志 */
  const diag = await json(`(async () => {
    const before = await window.aurora.diagnostics.report()
    await window.aurora.diagnostics.record('renderer-error', '测试错误 C:\\\\Users\\\\someone\\\\secret\\\\track.flac token=abcdef0123456789abcdef0123456789')
    await new Promise((resolve) => setTimeout(resolve, 400))
    const after = await window.aurora.diagnostics.report()
    const first = after.entries[0]
    return JSON.stringify({ before: before.total, after: after.total, kind: first?.kind, message: first?.message, path: after.logPath })
  })()`)
  check('渲染层错误真的进了崩溃日志', diag.after === diag.before + 1, { before: diag.before, after: diag.after })
  check('日志条目带错误类型', diag.kind === 'renderer-error', diag.kind)
  check('路径与 token 在写入前已被抹掉', !/C:\\Users/.test(diag.message) && !/abcdef0123456789/.test(diag.message), diag.message)
  check('日志文件路径在 userData 下', /logs[\\/]crash\.jsonl$/.test(diag.path.replace(/\\/g, '/')), diag.path)

  // The checks above prove the *log* works when something asks it to record. These prove the part that
  // mattered in practice: nobody has to ask. A thrown error and an unhandled rejection must write
  // themselves, because those are what a user's broken page actually produces.
  const auto = await json(`(async () => {
    const marker = Date.now().toString(36)
    const before = await window.aurora.diagnostics.report()
    setTimeout(() => { throw new Error('auto-throw-' + marker) }, 0)
    void Promise.reject(new Error('auto-reject-' + marker))
    await new Promise((resolve) => setTimeout(resolve, 900))
    const after = await window.aurora.diagnostics.report()
    const kinds = after.entries.map((entry) => entry.kind)
    const messages = after.entries.map((entry) => entry.message)
    return JSON.stringify({
      marker,
      grew: after.total - before.total,
      threw: kinds.includes('renderer-error') && messages.some((text) => text.includes('auto-throw-' + marker)),
      rejected: kinds.includes('renderer-rejection') && messages.some((text) => text.includes('auto-reject-' + marker)),
      kinds: kinds.slice(0, 4),
    })
  })()`)
  check('未捕获的抛出被自动记录（无需界面上报）', auto.threw === true, auto)
  check('未处理的 promise 拒绝被自动记录', auto.rejected === true, auto)
  check('两次自动上报都进了日志', auto.grew >= 2, { grew: auto.grew })

  /* ------------------------------------------------------- 只做“静止画面”时不该按高刷重绘 */

  /*
   * The app is paused and in front by the time this runs, which is exactly the state that used to cost a
   * quarter of a core on a 165 Hz panel. `fxDraw` is written by the frame loop itself, so it is a reading and
   * not a claim — and it is the number that would have caught the original behaviour.
   *
   * The bounds pin the **current** floor rather than merely "below the panel's rate", because that is the
   * assertion that can fail: the paused canvas being the largest single idle cost is a measured fact
   * (`tools/idle-cost-check.mjs --attribute`), so a rate creeping back towards 60 is a regression worth a red
   * check, and one that a `<= 62` bound would have silently accepted. The tolerance in `shouldDraw` is 1.5 ms,
   * so 33.33 ms of gate can still admit ~31.4 draws a second; 33 is the bound that reflects that.
   */
  const idle = await json(`(() => {
    const root = document.documentElement
    return JSON.stringify({
      draw: Number(root.dataset.fxDraw || 0),
      gate: Number(root.dataset.fxGate || 0),
      budget: Number(root.dataset.fxBudget || 0),
      hz: Number(root.dataset.fxHz || 0),
      playing: root.dataset.playing === 'true',
    })
  })()`)
  check('暂停时不会为静止画面跟随面板节奏（门闸抬到 30fps 地板）', idle.playing === false && idle.gate >= 33 && idle.gate <= 34, idle)
  check(
    '暂停时的实绘帧率真的降到 30 一档（不是只改了预算数字）',
    idle.draw > 0 && idle.draw <= 33,
    { draw: idle.draw, hz: idle.hz }
  )
  check('地板只会抬起预算，不会让用户选的慢档变快', idle.gate >= idle.budget - 0.01, { gate: idle.gate, budget: idle.budget })

  /*
   * The ambience's keyframe animations must actually be frozen while paused — that is the change that measured
   * GPU 44~50 % → 19~21 %, and it is one style rule away from silently not applying (a renamed class, a new
   * layer that drifts on its own). The canvas keeps moving, so the page is not dead: only the full-screen
   * repaints stop.
   */
  const ambience = await json(`(() => {
    const read = () => [...document.querySelectorAll('.ambient-glow, .ambient-field, .ambient-photo')].map((el) => getComputedStyle(el).animationPlayState)
    return JSON.stringify({ states: read(), playing: document.documentElement.dataset.playing })
  })()`)
  check(
    '暂停时背景光晕/漂移的关键帧动画真的冻住了（不是只在 CSS 里写了一条规则）',
    ambience.states.length > 0 && ambience.states.every((state) => state === 'paused'),
    ambience,
  )

  /*
   * …and the settle is a *ramp*, not a step.
   *
   * `data-bg='wash'` is the case worth testing: its own keyframes animate `opacity`, and a running animation
   * outranks a normal declaration — so the old `opacity: …*.72` never applied there at all, and switching it to
   * an important declaration applied it but snapped. The dim now rides on `filter`, which no theme animates, so
   * it takes the ordinary style-change path and transitions. Four or more intermediate values is the assertion:
   * a jump gives one, a 700 ms ease gives about eleven.
   */
  const settle = await json(`(async () => {
    const root = document.documentElement
    const brightness = () => {
      const raw = getComputedStyle(document.querySelector('.ambient-glow')).filter || 'none'
      const match = /brightness\\(([0-9.]+)\\)/.exec(raw)
      return match ? Number(match[1]) : 1
    }
    const previousBg = root.dataset.bg
    root.dataset.bg = 'wash'
    root.dataset.playing = 'true'
    await new Promise((resolve) => setTimeout(resolve, 600))
    const running = brightness()
    root.dataset.playing = 'false'
    const samples = []
    for (let index = 0; index < 16; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 60))
      samples.push(Number(brightness().toFixed(4)))
    }
    root.dataset.playing = 'false'
    if (previousBg === undefined) delete root.dataset.bg
    else root.dataset.bg = previousBg
    return JSON.stringify({ running, settled: samples[samples.length - 1], steps: [...new Set(samples)].length })
  })()`)
  check(
    '暂停收拢是渐变的，不是跳变（取 opacity 型主题 data-bg=wash 实测）',
    settle.steps >= 4,
    { steps: settle.steps, running: settle.running, settled: settle.settled },
  )
  check(
    '收拢真的落到 0.72 倍（而不是只在某些主题上生效）',
    Math.abs(settle.settled - 0.72) < 0.01 && settle.running > settle.settled,
    { running: settle.running, settled: settle.settled },
  )

  /* ---------------------------------------------------------------- C3 更新检查 */
  const update = await json(`(async () => {
    const settings = await window.aurora.settings.get()
    const previous = settings.updateCheck.feedUrl
    await window.aurora.settings.set({ updateCheck: { feedUrl: '' } })
    const unconfigured = await window.aurora.updates.check(true)
    await window.aurora.settings.set({ updateCheck: { feedUrl: 'https://127.0.0.1:1/definitely-not-a-feed' } })
    const failed = await window.aurora.updates.check(true)
    await window.aurora.settings.set({ updateCheck: { feedUrl: previous } })
    return JSON.stringify({ unconfigured: unconfigured.status, detail: unconfigured.detail, failed: failed.status, failedDetail: failed.detail, current: unconfigured.currentVersion })
  })()`)
  check('未配置更新源时如实返回「未配置」', update.unconfigured === 'unconfigured', update.detail)
  check('当前版本号被报告出来', typeof update.current === 'string' && update.current.length > 0, update.current)
  check('无效更新源返回真实失败原因（不是假装成功）', update.failed === 'error' && update.failedDetail.length > 0, update.failedDetail)

  /* ---------------------------------------------------------------- C4 本地 HTTP API */
  const api = await json(`(async () => {
    const off = await window.aurora.httpApi.status()
    await window.aurora.settings.set({ httpApi: { enabled: false } })
    const closed = await window.aurora.httpApi.set({ enabled: false })
    const settings = await window.aurora.settings.get()
    return JSON.stringify({ defaultRunning: off.running, defaultPort: off.port, stillClosed: closed.running, storedEnabled: settings.httpApi.enabled, token: settings.httpApi.token, endpoints: off.endpoints })
  })()`)
  check('本地 API 默认关闭（未开启时不监听端口）', api.defaultRunning === false && api.stillClosed === false, api)
  check('本地 API 只提供只读端点', api.endpoints.join(',') === '/api/health,/api/state,/api/library', api.endpoints)
  check('未开启时不会凭空生成 token', api.token === '', { token: api.token })

  const started = await json(`(async () => {
    const status = await window.aurora.httpApi.set({ enabled: true })
    const settings = await window.aurora.settings.get()
    return JSON.stringify({ ...status, token: settings.httpApi.token })
  })()`)
  check('开启后服务真的在监听回环地址', started.running === true && started.url.startsWith('http://127.0.0.1:'), started)
  check('开启时生成可复制的 token', /^[a-f0-9]{32}$/.test(started.token), { token: started.token })

  const token = started.token
  let health = null
  let unauthorized = null
  let authorized = null
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await fetch(`${started.url}/api/health`)
      health = { status: response.status, body: await response.json() }
      break
    } catch {
      await delay(300)
    }
  }
  try {
    const response = await fetch(`${started.url}/api/state`)
    unauthorized = response.status
    await response.json()
  } catch (error) {
    unauthorized = `request-failed: ${error.message}`
  }
  try {
    const response = await fetch(`${started.url}/api/state?token=${token}`)
    authorized = { status: response.status, body: await response.json() }
  } catch (error) {
    authorized = { status: 0, error: error.message }
  }
  check('GET /api/health 无需 token 即可访问', health?.status === 200 && health?.body?.ok === true, health)
  check('无 token 访问 /api/state 被拒绝（401）', unauthorized === 401, unauthorized)
  check('带 token 访问 /api/state 返回播放状态结构', authorized?.status === 200 && typeof authorized?.body?.isPlaying === 'boolean', authorized)

  const stopped = await json(`(async () => {
    const status = await window.aurora.httpApi.set({ enabled: false })
    return JSON.stringify(status)
  })()`)
  let closedPort = false
  try {
    await fetch(`${started.url}/api/health`)
  } catch {
    closedPort = true
  }
  check('关闭后端口不再应答', stopped.running === false && closedPort, { running: stopped.running, closedPort })

  /* ---------------------------------------------------------------- 汇总 */
  const failed = checks.filter((entry) => !entry.ok)
  console.log(`\n${checks.length - failed.length}/${checks.length} PASS`)
  if (failed.length > 0) console.log(`失败：${failed.map((entry) => entry.name).join(' | ')}`)
  // Tree kill by pid: `child.kill()` terminates only the browser process, and its renderer children survive it
  // on Windows — leftovers are what made these checkers fail when run back to back.
  child.kill()
  spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' })
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((error) => {
  console.log(`FAIL 检查过程出错：${error.message}`)
  child.kill()
  spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' })
  process.exit(1)
})
