/**
 * Packaged check for 设置 → 功能状态: the per-group totals, that every group can be collapsed, that the
 * 「全部展开 / 全部收起」 button really drives every group, and that the groups start in the documented
 * default (finished groups collapsed, the one with a gap open).
 *
 * Usage: `npm run check:features` (run `npm run build` first).
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = Number(process.argv[2] ?? 9493)
const EXE = 'release/win-unpacked/Aurora Music.exe'

const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok) })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`)
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

if (!existsSync(EXE)) {
  console.log(`FAIL 找不到打包产物 ${EXE} —— 先跑 npm run build`)
  process.exit(1)
}

const profile = mkdtempSync(join(tmpdir(), 'aurora-features-'))
const child = spawn(EXE, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--mute-audio'], { stdio: ['ignore', 'pipe', 'pipe'] })
child.stderr.on('data', () => undefined)

let ws = null
let messageId = 0

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
  let target = null
  for (let attempt = 0; attempt < 40 && !target; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await response.json()
      target = list.find((item) => item.type === 'page' && !item.url.includes('desktop-lyrics'))
    } catch {
      // not up yet
    }
    if (!target) await delay(500)
  }
  if (!target) throw new Error('连不上应用')

  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve)
    ws.addEventListener('error', () => reject(new Error('调试连接失败')))
  })
  await delay(2500)

  await send('Runtime.evaluate', { expression: "location.hash = '#/settings'", returnByValue: true })
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const ready = await json("JSON.stringify({ ok: !!document.querySelector('[data-testid=\"feature-status-section\"]') })")
    if (ready.ok) break
    await delay(400)
  }
  await delay(500)

  const layout = await json(`(() => {
    const groups = [...document.querySelectorAll('.feature-group')]
    const heads = groups.map((group) => group.querySelector('.feature-group-head'))
    const openAtStart = groups.map((group) => group.querySelector('.feature-list')?.checkVisibility?.() ?? true)
    return JSON.stringify({
      groups: groups.length,
      allHeadsAreButtons: heads.every((head) => head?.tagName === 'BUTTON'),
      aria: heads.map((head) => head?.getAttribute('aria-expanded')),
      openAtStart,
      labels: heads.map((head) => head?.querySelector('.feature-group-title')?.textContent?.trim() ?? ''),
      counts: heads.map((head) => head?.querySelector('.feature-group-count')?.textContent?.trim() ?? ''),
      total: document.querySelector('[data-testid="feature-total"]')?.textContent?.trim() ?? '',
      toggleAll: document.querySelector('[data-testid="feature-toggle-all"]')?.textContent?.trim() ?? '',
      visibleLists: groups.filter((group) => (group.querySelector('.feature-list')?.checkVisibility?.() ?? true)).length,
    })
  })()`)

  check('功能状态卡按模块分组，标题都是可点的按钮', layout.groups >= 6 && layout.allHeadsAreButtons === true, { groups: layout.groups, labels: layout.labels })
  check('每组标题带 已实现 / 总数', layout.counts.every((count) => /^\d+ \/ \d+$/.test(count)), layout.counts)
  check('顶部显示总体 已实现 / 总数', /^\d+ \/ \d+$/.test(layout.total), layout.total)
  check('已完成的分组默认收起（还差东西的那组默认展开）', layout.visibleLists < layout.groups && layout.visibleLists >= 1, {
    visible: layout.visibleLists,
    groups: layout.groups,
    aria: layout.aria,
  })

  // Vue applies a `v-show` change on the next tick, so every read after a click has to wait a frame —
  // reading synchronously is how this check reported a working card as broken.
  const singleToggle = await json(`(async () => {
    const wait = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 60)))
    const head = [...document.querySelectorAll('.feature-group-head')].find((node) => node.getAttribute('aria-expanded') === 'false')
    const list = head.closest('.feature-group').querySelector('.feature-list')
    head.click()
    await wait()
    const opened = list.checkVisibility?.() ?? true
    head.click()
    await wait()
    const closedAgain = !(list.checkVisibility?.() ?? false)
    return JSON.stringify({ opened, closedAgain, label: head.querySelector('.feature-group-title').textContent.trim() })
  })()`)
  check('点标题就能展开，再点一次收起（可收起，不是单向的）', singleToggle.opened === true && singleToggle.closedAgain === true, singleToggle)

  const allCollapse = await json(`(async () => {
    const wait = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 60)))
    const count = () => [...document.querySelectorAll('.feature-list')].filter((list) => list.checkVisibility?.() ?? true).length
    const button = document.querySelector('[data-testid="feature-toggle-all"]')
    const labelBefore = button.textContent.trim()
    button.click()
    await wait()
    const afterCollapse = count()
    const labelAfterCollapse = button.textContent.trim()
    button.click()
    await wait()
    const afterExpand = count()
    return JSON.stringify({ afterCollapse, afterExpand, labelBefore, labelAfterCollapse, labelAfterExpand: button.textContent.trim() })
  })()`)
  check('「全部收起」把每一组都收起来', allCollapse.afterCollapse === 0, allCollapse)
  check('再点一次变回「全部展开」，每一组都展开', allCollapse.afterExpand === layout.groups, allCollapse)
  check(
    '按钮文案跟随当前状态（收起 ⟷ 展开）',
    allCollapse.labelBefore === '全部收起' && allCollapse.labelAfterCollapse === '全部展开' && allCollapse.labelAfterExpand === '全部收起',
    allCollapse,
  )

  const pending = await json(`(() => {
    const rows = [...document.querySelectorAll('.feature-list li')].map((row) => ({
      name: row.querySelector('.feature-name')?.textContent?.trim() ?? '',
      state: row.querySelector('.feature-state')?.textContent?.trim() ?? '',
      done: row.querySelector('.feature-dot')?.classList.contains('done') ?? false,
    }))
    return JSON.stringify({ pending: rows.filter((row) => !row.done).map((row) => row.name), total: rows.length })
  })()`)
  check('缺口只剩「迷你播放器」这一条（状态卡与实现同步）', pending.pending.length === 1 && pending.pending[0].includes('迷你播放器'), pending)
  /*
   * 卡片的另一半职责：刚做出来的东西真的被登记了。
   *
   * 这四条曾经全部漏登记（安全模式、不经过脚本协议的自定义入口、帧率自定、安装结果里的策略说明）：
   * 功能在应用里、卡上说没有——而这张卡存在的唯一理由就是让人一眼看出“有什么、还差什么”。
   * 按名字钉住，未来加功能时忘了登记就会当场红。
   */
  const registered = await json(`(() => {
    const text = [...document.querySelectorAll('.feature-list li .feature-name')].map((node) => node.textContent).join(' | ')
    return JSON.stringify({
      hasSafeMode: text.includes('平台访问安全模式'),
      hasDeclarativeEntry: text.includes('不经过脚本协议'),
      hasCustomFrameRate: text.includes('帧率上限可自定'),
      hasBatchCheck: text.includes('全量自检'),
    })
  })()`)
  check(
    '状态卡登记了安全模式、免脚本的自定义入口、帧率自定、全量自检（卡与实现不会各说各话）',
    registered.hasSafeMode === true &&
      registered.hasDeclarativeEntry === true &&
      registered.hasCustomFrameRate === true &&
      registered.hasBatchCheck === true,
    registered,
  )

  const failed = checks.filter((entry) => !entry.ok)
  console.log(`\n${checks.length - failed.length}/${checks.length} PASS`)
  if (failed.length > 0) console.log(`失败：${failed.map((entry) => entry.name).join(' | ')}`)
  // Tree kill by pid (`child.kill()` leaves renderer children behind on Windows).
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
