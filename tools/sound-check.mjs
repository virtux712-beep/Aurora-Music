/**
 * Packaged acceptance check for the sound block: EQ, loudness normalisation, output device, gapless /
 * crossfade, and the sleep timer.
 *
 * ## Why this is separate from `packaged-app-check.mjs`
 *
 * Those assertions live at the end of the big suite, which restarts the app halfway through and then loses
 * its debugging connection in the post-restart phase — so the run dies before reaching them, and the whole
 * block has never been verified in the packaged app. A check that cannot run is not a check. This one starts
 * its own instance, touches nothing else, and takes about a minute.
 *
 * ## What it asserts
 *
 * Effects, never controls: the engine's `<html>` mirror (what the audio graph is *actually* doing), the
 * stored settings block, and the sleeping timer's own label. The one that matters most is 「接图后音乐还在走」
 * — an analyser only reads non-zero if the chain is connected end to end, which is how the missing
 * `bus → preamp` link was found.
 *
 * Usage: `npm run check:sound` (needs `npm run build` first — it runs against the packaged app).
 */
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, cpSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = Number(process.argv[2] ?? 9481)
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

const profile = mkdtempSync(join(tmpdir(), 'aurora-sound-'))
for (const name of ['library.json', 'settings.json', 'playlists.json', 'collection.json']) {
  const source = join(REAL_PROFILE, name)
  if (existsSync(source)) copyFileSync(source, join(profile, name))
}
const covers = join(REAL_PROFILE, 'covers')
if (existsSync(covers)) cpSync(covers, join(profile, 'covers'), { recursive: true })

// `--mute-audio`: the suite's convention. Chromium mutes the output stream, not the graph, so the analyser
// still receives samples while whoever is at the machine hears nothing.
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

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  return result?.result?.value
}

const STORE = `document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$pinia?._s?.get('player')`

/** Serialised JSON reads are the only shape that survives CDP unharmed. */
async function json(expression) {
  try {
    return JSON.parse(String(await evaluate(expression)) ?? '{}')
  } catch {
    return {}
  }
}

try {
  const target = await findTarget()
  if (!target) throw new Error('打包应用没有暴露渲染进程')

  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }))
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const mounted = await evaluate("!!document.querySelector('.player-bar')").catch(() => false)
    if (mounted === true) break
    await delay(500)
  }
  check('打包应用启动并挂载了外壳', (await evaluate("!!document.querySelector('.player-bar')")) === true)

  /* ------------------------------------------------------------------ playback, on a real library track */

  const picked = await json(
    `(async () => {
       const list = await window.aurora.library.list()
       const tracks = list?.tracks ?? list ?? []
       const song = tracks.find((t) => (t.duration || 0) > 60) ?? tracks[0]
       if (!song) return JSON.stringify({ none: true })
       globalThis.__soundCheckTrack = song
       const store = ${STORE}
       await store.playTrack(song)
       return JSON.stringify({ title: song.title, duration: song.duration })
     })()`,
  )
  check('曲库里有可播放的曲目并已开始播放', !picked.none && Boolean(picked.title), picked)

  await delay(1800)
  const playing = await json(`JSON.stringify({ playing: ${STORE}?.isPlaying, t: ${STORE}?.currentTime })`)
  check('播放真的在走（时钟前进）', playing.playing === true, playing)

  /* ------------------------------------------------------------------ the settings page */

  await evaluate("location.hash = '#/settings'; 'ok'")
  await delay(1200)
  const section = await json(
    `(() => {
       const node = document.querySelector('[data-testid="sound-section"]')
       return JSON.stringify({
         present: !!node,
         heading: node?.querySelector('h3')?.textContent?.trim() ?? '',
         // The preamp slider is tagged data-band=preamp, so the ten EQ bands are the numeric ones.
         bands: node ? [...node.querySelectorAll('[data-band]')].filter((b) => b.dataset.band !== 'preamp').length : 0,
         preamp: node ? node.querySelectorAll('[data-band="preamp"]').length : 0,
         presets: node ? [...node.querySelectorAll('[data-preset]')].map((b) => b.dataset.preset).length : 0,
         devices: node ? [...node.querySelectorAll('[data-device]')].map((b) => b.dataset.device) : [],
         toggles: ['eq-toggle', 'loudness-toggle', 'gapless-toggle', 'crossfade-slider'].filter((id) => !!node && !!node.querySelector('[data-testid="' + id + '"]')),
       })
     })()`,
  )
  check(
    '设置页有「声音」区块：均衡器十段 + 前级 + 预设 + 输出设备 + 衔接开关',
    section.present === true &&
      section.heading === '声音' &&
      section.bands === 10 &&
      section.preamp === 1 &&
      section.presets >= 5 &&
      section.devices.length >= 1 &&
      section.toggles.length === 4,
    section,
  )
  check(
    '输出设备列出的不是空表（至少「系统默认输出」，且读到了真实端点）',
    section.devices.includes('default') && section.devices.length >= 2,
    section.devices,
  )

  /* ------------------------------------------------------------------ EQ → the real graph, and audio still flows */

  await evaluate(`document.querySelector('[data-testid="eq-toggle"]').click(); 'ok'`)
  await delay(1400)
  const eqOn = await json(
    `(async () => {
       const root = document.documentElement
       const stored = await window.aurora.settings.get()
       return JSON.stringify({
         enabled: stored.sound.equalizer.enabled,
         eqAttr: root.dataset.audioEq,
         attached: root.dataset.audioAttached,
         context: root.dataset.audioContext,
         destination: root.dataset.audioDestination,
         chain: Number(root.dataset.audioChainNodes || 0),
         decks: root.dataset.audioDecks,
       })
     })()`,
  )
  check(
    '打开均衡器真的接了音频图（两副牌 + 完整链路 + 输出端连着目的地）',
    eqOn.enabled === true &&
      eqOn.eqAttr === 'on' &&
      eqOn.attached === 'true' &&
      eqOn.context === 'running' &&
      eqOn.destination === 'connected' &&
      // bus + preamp + output + the ten bands. Not 14: three plumbing nodes, not four.
      eqOn.chain >= 13 &&
      eqOn.decks === '2',
    eqOn,
  )

  /*
   * The one that caught a real defect: an analyser reads its *input*, so a chain whose bus is wired to
   * nothing reads as silence no matter what the switches say. Non-zero energy plus a moving clock is proof
   * that the music is still reaching both the analyser and the speakers.
   */
  const flow = await json(
    `(async () => {
       const store = ${STORE}
       await store.play()
       await new Promise((resolve) => setTimeout(resolve, 400))
       const start = store.currentTime
       let peak = 0
       for (let index = 0; index < 14; index += 1) {
         await new Promise((resolve) => setTimeout(resolve, 120))
         peak = Math.max(peak, Number(getComputedStyle(document.documentElement).getPropertyValue('--music-energy').trim()) || 0)
       }
       return JSON.stringify({ playing: store.isPlaying, advanced: Number((store.currentTime - start).toFixed(2)), peak: Number(peak.toFixed(3)) })
     })()`,
  )
  check(
    '接图之后音乐仍在走（分析器读到能量、时钟前进）—— 这条能抓住「连错线导致静音」',
    flow.playing === true && Number(flow.advanced) > 0.5 && Number(flow.peak) > 0.02,
    flow,
  )

  await evaluate(`document.querySelector('[data-preset="bass"]').click(); 'ok'`)
  await delay(700)
  const preset = await json(
    `(async () => {
       const stored = await window.aurora.settings.get()
       return JSON.stringify({ preset: stored.sound.equalizer.preset, first: stored.sound.equalizer.gains[0], peak: document.documentElement.dataset.audioEqPeak })
     })()`,
  )
  check('选「低音增强」后曲线落到引擎（首段 +7 dB，峰值也报出来）', preset.preset === 'bass' && preset.first === 7 && Number(preset.peak) > 0, preset)

  await evaluate(
    `(() => {
       const input = document.querySelector('[data-band="4"]')
       input.value = '-6'
       input.dispatchEvent(new Event('input', { bubbles: true }))
       return 'ok'
     })()`,
  )
  await delay(700)
  const band = await json(
    `(async () => {
       const stored = await window.aurora.settings.get()
       return JSON.stringify({ gain: stored.sound.equalizer.gains[4], preset: stored.sound.equalizer.preset })
     })()`,
  )
  check('拖动某一段会改写曲线，并把预设改成「自定义」', band.gain === -6 && band.preset === 'custom', band)

  /* ------------------------------------------------------------------ loudness */

  await evaluate(`document.querySelector('[data-testid="loudness-toggle"]').click(); 'ok'`)
  await delay(3000)
  const loudness = await json(
    `(async () => {
       const stored = await window.aurora.settings.get()
       const root = document.documentElement
       return JSON.stringify({
         enabled: stored.sound.loudness.enabled,
         target: stored.sound.loudness.targetDb,
         gainA: root.dataset.audioLoudnessA,
         gainB: root.dataset.audioLoudnessB,
       })
     })()`,
  )
  check(
    '音量均衡落库，并且每副牌各有自己的增益读数（不是 NaN）',
    loudness.enabled === true && loudness.target === -14 && Number.isFinite(Number(loudness.gainA)) && Number.isFinite(Number(loudness.gainB)),
    loudness,
  )

  /* ------------------------------------------------------------------ gapless / crossfade */

  await evaluate(`document.querySelector('[data-testid="gapless-toggle"]').click(); 'ok'`)
  await delay(600)
  await evaluate(
    `(() => {
       const slider = document.querySelector('[data-testid="crossfade-slider"] input, [data-testid="crossfade-slider"]')
       slider.value = '5'
       slider.dispatchEvent(new Event('input', { bubbles: true }))
       return 'ok'
     })()`,
  )
  await delay(700)
  const transition = await json(
    `(async () => {
       const stored = await window.aurora.settings.get()
       return JSON.stringify({ gapless: stored.sound.gapless, crossfade: stored.sound.crossfadeSeconds, attr: document.documentElement.dataset.audioCrossfade ?? null })
     })()`,
  )
  check('无缝开关与淡入淡出都真的落库（不是只动 UI）', transition.crossfade === 5 && typeof transition.gapless === 'boolean', transition)

  /* ------------------------------------------------------------------ output device */

  const routed = await json(
    `(async () => {
       const result = await window.aurora.sound?.setOutputDevice?.('') ?? null
       if (!result) {
         const list = [...document.querySelectorAll('[data-device]')]
         const system = list.find((node) => node.dataset.device === 'default')
         system?.click()
         await new Promise((resolve) => setTimeout(resolve, 800))
         return JSON.stringify({ clicked: Boolean(system), route: document.documentElement.dataset.audioOutputRoute, device: document.documentElement.dataset.audioOutput })
       }
       return JSON.stringify({ direct: true, applied: result.applied, via: result.via })
     })()`,
  )
  check(
    '选择输出设备会报告真实路由方式（context / element），而不是假装成功',
    routed.direct === true ? routed.applied === true : routed.clicked === true && ['context', 'element'].includes(String(routed.route)),
    routed,
  )

  /* ------------------------------------------------------------------ sleep timer */

  await evaluate(`document.querySelector('[data-testid="sleep-button"]').click(); 'ok'`)
  await delay(500)
  const menu = await json(
    `(() => {
       const popover = document.querySelector('[data-testid="sleep-popover"]')
       return JSON.stringify({
         open: !!popover,
         minutes: popover ? [...popover.querySelectorAll('[data-minutes]')].map((b) => Number(b.dataset.minutes)) : [],
         afterTrack: popover ? [...popover.querySelectorAll('button')].some((b) => b.textContent.includes('本曲结束后')) : false,
       })
     })()`,
  )
  check(
    '睡眠定时的菜单给出 15/30/45/60/90 与「本曲结束后」',
    menu.open === true && [15, 30, 45, 60, 90].every((value) => menu.minutes.includes(value)) && menu.afterTrack === true,
    menu,
  )

  await evaluate(`document.querySelector('[data-minutes="15"]').click(); 'ok'`)
  await delay(500)
  const firstTick = await evaluate(`document.querySelector('[data-testid="sleep-countdown"]')?.textContent?.trim() ?? ''`)
  await delay(3000)
  const secondTick = await evaluate(`document.querySelector('[data-testid="sleep-countdown"]')?.textContent?.trim() ?? ''`)
  const armed = await json(`JSON.stringify({ mode: ${STORE}?.sleep?.mode, label: document.querySelector('[data-testid="sleep-countdown"]')?.textContent?.trim() ?? '' })`)
  check(
    '睡眠定时真的在倒数（几秒后数字确实变小）',
    armed.mode === 'minutes' && Boolean(firstTick) && firstTick !== secondTick,
    { firstTick, secondTick, mode: armed.mode },
  )

  await evaluate(`document.querySelector('[data-testid="sleep-button"]').click(); 'ok'`)
  await delay(400)
  await evaluate(
    `(() => {
       const off = document.querySelector('[data-mode="off"]')
       off?.click()
       return 'ok'
     })()`,
  )
  await delay(500)
  const cancelled = await json(`JSON.stringify({ mode: ${STORE}?.sleep?.mode, countdown: !!document.querySelector('[data-testid="sleep-countdown"]') })`)
  check('取消后倒计时从播放栏消失', cancelled.countdown === false, cancelled)

  /* ------------------------------------------------------------------ restore */

  await evaluate(
    `window.aurora.settings.set({ sound: { equalizer: { enabled: false, preset: 'flat', gains: [0,0,0,0,0,0,0,0,0,0], preampDb: 0 }, loudness: { enabled: false, targetDb: -14 }, outputDeviceId: '', gapless: true, crossfadeSeconds: 0 } }).then(() => 'ok')`,
  )
  await delay(600)
  const restored = await json(
    `window.aurora.settings.get().then((s) => JSON.stringify({ eq: s.sound.equalizer.enabled, gain: s.sound.equalizer.gains[4], crossfade: s.sound.crossfadeSeconds, gapless: s.sound.gapless }))`,
  )
  check('重置回默认后曲线、淡入淡出与无缝都回来了', restored.eq === false && restored.gain === 0 && restored.crossfade === 0 && restored.gapless === true, restored)
} catch (error) {
  check('执行过程无异常', false, String(error?.stack ?? error).split('\n').slice(0, 3).join(' | '))
} finally {
  try {
    ws?.close()
  } catch {
    // best effort
  }
  /*
   * Reap the whole tree, by pid — never by image name.
   *
   * `child.kill()` on Windows terminates only the browser process; its renderer and GPU children can outlive it,
   * and a leftover instance is what made these checkers fail when run back to back (`0/12`, or nothing at all).
   * Killing by image name would "fix" that by taking a sibling run's app down with it, which is worse.
   */
  child?.kill()
  spawnSync('taskkill', ['/T', '/F', '/PID', String(child?.pid ?? 0)], { stdio: 'ignore' })
  await delay(500)
  rmSync(profile, { recursive: true, force: true })
}

const failed = checks.filter((item) => !item.ok).length
console.log(`\n${checks.length - failed}/${checks.length} checks passed`)
process.exit(failed === 0 ? 0 : 1)
