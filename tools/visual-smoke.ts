/**
 * Smoke test for Aurora's visual engine — the *decisions*, offline.
 *
 * The frame governor has two halves. `visual/frame.ts` is the runtime (a rAF loop, a canvas gate) and can
 * only be judged in a running window, which `npm run smoke:app` does. `visual/budget.ts` is the arithmetic,
 * and every rule that actually matters is decided there — how fast to draw, whether the machine is coping,
 * and when to change the animation level. So this suite replays synthetic frame series through those pure
 * functions and asserts the outcomes, including the two regressions the old watchdog had:
 *
 *  - it called a frame slow above a fixed 22 ms, so a machine rendering at 40 fps on a 120 Hz panel was
 *    declared healthy (its p95 was *under* the threshold) — see the 144 Hz case below;
 *  - it could never recover, so one heavy minute cost the user their effects for the rest of the session.
 *
 * A fully deterministic simulation at the end covers the whole policy: a machine that goes bad for three
 * seconds and then recovers must end up exactly where the user put the dial, and must never fall to 关闭.
 *
 * Run with: npm run smoke:visual
 */
import {
  clampFrameRate,
  detectRefreshHz,
  frameBudgetMs,
  frameRateLabel,
  gradeLoad,
  guardStep,
  GUARD,
  INITIAL_GUARD,
  IDLE_RENDER_SCALE,
  isFrameRateChoice,
  parseFrameRateChoice,
  parseFrameRateInput,
  renderScale,
  rampProgress,
  RAMP_MS,
  shouldDraw,
  gateMs,
  BACKGROUND_GATE_MS,
  PAUSED_GATE_MS,
  summarise,
  type FrameStats,
  type GuardAction,
  type GuardState,
  type LoadGrade,
} from '../src/renderer/src/visual/budget'
import { downgrade, upgrade } from '../src/renderer/src/theme/effects/levels'
import {
  easterAura,
  EMPTY_COMPANION,
  formatCompanionTime,
  isNightHour,
  NIGHT_STREAK,
  nextStreak,
  parseCompanion,
  recordListening,
  recordPlay,
  SIGNAL_LOST_CHANCE,
} from '../src/renderer/src/theme/easter'
import { MIN_SCORE, recommendSkin, type RecommendSkin } from '../src/renderer/src/theme/recommend'
import { BUILT_IN_SKINS } from '../src/renderer/src/theme/skins'
import { planEffects } from '../src/renderer/src/theme/effects'
import { LEVEL_ORDER } from '../src/renderer/src/theme/effects'
import type { AnimationLevel } from '../src/shared/theme'
import { readFileSync } from 'node:fs'

const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
const check = (name: string, ok: boolean, detail?: unknown): void => {
  checks.push({ name, ok, detail: detail === undefined ? undefined : String(detail) })
}

/** A synthetic series of frame intervals with deterministic jitter (no randomness in the assertions). */
function series(interval: number, count: number, jitter = 0.08): number[] {
  return Array.from({ length: count }, (_, index) => interval * (1 + jitter * Math.sin(index * 1.7)))
}

/** Replays a series through summarise → gradeLoad, the way the runtime does every 300 ms. */
function gradeOf(intervals: number[], budgetMs: number): { stats: FrameStats; grade: LoadGrade } {
  const stats = summarise(intervals, budgetMs)
  return { stats, grade: gradeLoad(stats, budgetMs) }
}

/*
 * Drives the guard over simulated time, feeding `stats` for each 300 ms decision, and returns the level
 * trajectory. This is the part that used to be untestable because the policy lived inside a rAF callback.
 */
function simulate(options: {
  budgetMs: number
  intervals: number[]
  start: 'saver' | 'standard' | 'immersive'
  ceiling: 'saver' | 'standard' | 'immersive'
  phase: (seconds: number) => number[]
  seconds: number
}): { level: string; actions: Array<{ at: number; action: GuardAction; level: string }> } {
  let level = options.start
  let state: GuardState = { ...INITIAL_GUARD }
  const actions: Array<{ at: number; action: GuardAction; level: string }> = []
  // The clock starts at the guard's warm-up boundary: this harness drives the *policy*, and the warm-up itself
  // is asserted separately below with its own clock.
  let clock = GUARD.warmupMs
  while (clock <= options.seconds * 1000) {
    // The phase is expressed in seconds *since launch*, so the warm-up offset is removed before asking it.
    const stats = summarise(options.phase((clock - GUARD.warmupMs) / 1000), options.budgetMs)
    const grade = gradeLoad(stats, options.budgetMs)
    const step = guardStep(state, grade, clock)
    state = step.state
    if (step.action !== 'hold') {
      const next = step.action === 'down' ? downgrade(level as never) : upgrade(level as never, options.ceiling)
      /*
       * Only a *change* is recorded, which is what the runtime does too (the store returns early when a
       * step lands on the level it is already at). Without this the harness reports "it recovered" for a
       * machine that was already at its ceiling.
       */
      if (next !== level) {
        level = next
        actions.push({ at: clock, action: step.action, level })
      }
    }
    clock += 300
  }
  return { level, actions }
}

/* --------------------------------------------------------------- 1. the budget */

check('跟随屏幕时按屏幕刷新率给预算（60Hz）', Math.abs(frameBudgetMs('follow', 60) - 16.67) < 0.01, `${frameBudgetMs('follow', 60).toFixed(2)}ms`)
check('跟随屏幕时按屏幕刷新率给预算（144Hz）', Math.abs(frameBudgetMs('follow', 144) - 6.94) < 0.01, `${frameBudgetMs('follow', 144).toFixed(2)}ms`)
check(
  '选高于屏幕的档位不会让屏幕变快（上限而非目标）',
  frameBudgetMs(144, 60) === frameBudgetMs('follow', 60) && frameBudgetMs(120, 60) === frameBudgetMs('follow', 60),
  `${frameBudgetMs(144, 60).toFixed(2)}ms`,
)
check('选低于屏幕的档位真的降低绘制（144Hz 屏上选 30）', Math.abs(frameBudgetMs(30, 144) - 33.33) < 0.01, `${frameBudgetMs(30, 144).toFixed(2)}ms`)
check('屏幕未知时退回 60Hz 而不是不限速', Math.abs(frameBudgetMs('follow', null) - 16.67) < 0.01, `${frameBudgetMs('follow', null).toFixed(2)}ms`)
check(
  '存储里的脏值不会被当成帧率',
  !isFrameRateChoice('60') && !isFrameRateChoice(0) && !isFrameRateChoice(-1) && !isFrameRateChoice('fast') && isFrameRateChoice(60) && isFrameRateChoice('follow'),
  'rejects junk, accepts the documented set',
)
check('帧率档位的可读文案带上实测屏幕刷新率', frameRateLabel('follow', 144).includes('144'), frameRateLabel('follow', 144))

/*
 * The custom cap, and the bug that came with it.
 *
 * `FRAME_RATE_OPTIONS` is a preset list; the contract is a *range*. The regression guarded here is not
 * hypothetical: the store persisted `String(choice)` and read it back with `isFrameRateChoice`, which
 * refuses strings on purpose — so a numeric cap was silently dropped on every restart while the settings
 * page went on showing it as selected. Two facts, two functions, and the loader is the one that bridges
 * them.
 */
check(
  '自定义帧率: 区间内的整数都合法（不只是预设）',
  isFrameRateChoice(85) && isFrameRateChoice(24) && isFrameRateChoice(240),
  '85 / 24 / 240',
)
check(
  '自定义帧率: 越界与非整数被拒',
  !isFrameRateChoice(23) && !isFrameRateChoice(241) && !isFrameRateChoice(60.5),
  '23 / 241 / 60.5',
)
check(
  '自定义帧率: 输入解析并夹取到合法区间',
  parseFrameRateInput('85') === 85 &&
    parseFrameRateInput(' 120 ') === 120 &&
    parseFrameRateInput('') === null &&
    parseFrameRateInput('abc') === null &&
    parseFrameRateInput('999') === null &&
    clampFrameRate(999) === 240 &&
    clampFrameRate(1) === 24,
  `${parseFrameRateInput('85')} · ${clampFrameRate(999)}`,
)
check(
  '自定义帧率: 重启后能读回数值档位（存的是字符串）',
  parseFrameRateChoice('85') === 85 &&
    parseFrameRateChoice('follow') === 'follow' &&
    parseFrameRateChoice('60') === 60 &&
    parseFrameRateChoice('junk') === null &&
    parseFrameRateChoice('999') === null,
  String(parseFrameRateChoice('85')),
)
check('自定义帧率: 契约仍然挡住"看起来像数字"的字符串', !isFrameRateChoice('85'), 'rejected by the contract, decoded by the loader')
check(
  '自定义帧率: 85 在 165Hz 屏上真的降到 11.76ms',
  Math.abs(frameBudgetMs(85, 165) - 11.76) < 0.02,
  `${frameBudgetMs(85, 165).toFixed(2)}ms`,
)
check(
  '自定义帧率: 85 在 60Hz 屏上按屏幕上限走',
  Math.abs(frameBudgetMs(85, 60) - 16.67) < 0.01,
  `${frameBudgetMs(85, 60).toFixed(2)}ms`,
)
check('自定义帧率: 高于屏幕时文案说明按屏幕走', frameRateLabel(144, 60).includes('60'), frameRateLabel(144, 60))

/*
 * The idle resolution scale.
 *
 * Three properties, and the third is the one that matters: the point of the change is the *area*, which
 * goes as the square of the linear factor. Scaling a soft particle field by 0.7 is invisible; scaling it by
 * 0.9 would be, too, and would also save nothing worth measuring.
 */
check(
  '空闲分辨率: 播放且前台时用满档位像素比',
  renderScale({ focused: true, playing: true }) === 1,
  String(renderScale({ focused: true, playing: true })),
)
check(
  '空闲分辨率: 暂停或失焦时降到 0.7（软背景，看不出差别）',
  renderScale({ focused: true, playing: false }) === IDLE_RENDER_SCALE &&
    renderScale({ focused: false, playing: true }) === IDLE_RENDER_SCALE,
  String(IDLE_RENDER_SCALE),
)
check(
  '空闲分辨率: 降的是面积，真的省掉约一半像素',
  IDLE_RENDER_SCALE < 0.8 && 1 - IDLE_RENDER_SCALE ** 2 > 0.5,
  `${Math.round((1 - IDLE_RENDER_SCALE ** 2) * 100)}% 像素省下`,
)

/* ------------------------------------------------- 1b. the idle floors */

/*
 * Three rules that only exist to stop an idle window from drawing at the panel's rate, checked exactly rather
 * than approximately: an *unfocused* window always drops to 12 fps, a focused but paused one to 30, and a
 * budget that is already slower than the floor is never sped back up (the user's own cap wins).
 *
 * The numbers are the point. On a 165 Hz panel the budget is 6.06 ms, so "paused" and "playing" differ by a
 * factor of 5.5 — which is why these are asserted here, where a display is not needed, instead of only on a
 * running window. The paused floor moved from 60 to 30 after the idle attribution in
 * `tools/idle-cost-check.mjs` showed the particle canvas to be two thirds of a paused app's whole CPU budget.
 */
check(
  '暂停时把 165Hz 的预算抬到 30fps 地板（不再为一张静止画面按面板节奏重绘）',
  Math.abs(gateMs(1000 / 165, { focused: true, playing: false }) - PAUSED_GATE_MS) < 0.01,
  `${gateMs(1000 / 165, { focused: true, playing: false }).toFixed(2)}ms`,
)
check(
  '播放时门闸就是所选预算（暂停地板被解除）',
  gateMs(1000 / 165, { focused: true, playing: true }) === 1000 / 165,
  `${gateMs(1000 / 165, { focused: true, playing: true }).toFixed(2)}ms`,
)
check(
  '窗口不在前台时一律降到 12fps（无论是否在播放）',
  Math.abs(gateMs(1000 / 165, { focused: false, playing: true }) - BACKGROUND_GATE_MS) < 0.01 &&
    Math.abs(gateMs(1000 / 60, { focused: false, playing: false }) - BACKGROUND_GATE_MS) < 0.01,
  `${gateMs(1000 / 165, { focused: false, playing: true }).toFixed(2)}ms`,
)
check(
  '用户本来就选得比地板慢时不会被顶回去（选 30 就还是 30）',
  Math.abs(gateMs(1000 / 30, { focused: true, playing: false }) - 1000 / 30) < 0.01,
  `${gateMs(1000 / 30, { focused: true, playing: false }).toFixed(2)}ms`,
)

/* ------------------------------------------- 1c. per-theme idle cost baseline */

/*
 * Every theme declares how much ambience it wants — which particle kind, how dense, how fast — and those three
 * numbers are the whole variable cost of a theme. So "this theme got expensive" is checkable *before* it ships,
 * offline, against fixed numbers:
 *
 *  - the declared density is capped, so no theme can quietly ask for three times the field,
 *  - the heaviest theme at the heaviest level on a 4K window still stays under the hard particle cap that
 *    `AmbientLayer.vue` enforces (that cap is duplicated here on purpose: a test that reads the constant it is
 *    testing would pass even if someone raised it to 1000),
 *  - the ladder genuinely unloads a theme: 节能 is strictly lighter than 标准, and 关闭 leaves no particles at
 *    all — so "pause/idle" really is cheaper per theme rather than only cheaper in the frame loop,
 *  - and the paused glass downgrade cannot silently miss a surface: every `backdrop-filter` in the app's
 *    stylesheets must be multiplied by `--glass-blur-scale`.
 */
const MAX_PARTICLES = 90
const DENSITY_CEILING = 0.25
const TOKENS = { '--accent': '#a58aff', '--accent-strong': '#8869f5', '--ambient-b': '#3fd0ff' }
const particlesAt = (density: number, pixels: number): number => Math.min(MAX_PARTICLES, Math.round((density * pixels) / 100_000))

const plans = BUILT_IN_SKINS.flatMap((skin) =>
  LEVEL_ORDER.map((level) => ({ id: skin.id, level, plan: planEffects(skin, level as AnimationLevel, TOKENS) })),
)
const densityOf = (id: string, level: AnimationLevel): number => plans.find((row) => row.id === id && row.level === level)?.plan.ambient.density ?? 0

check(
  '每个主题声明的氛围密度都在上限内（没有主题偷偷要三倍粒子）',
  BUILT_IN_SKINS.every((skin) => (skin.effects.density ?? 0) <= DENSITY_CEILING),
  `上限 ${DENSITY_CEILING}，实际最大 ${Math.max(...BUILT_IN_SKINS.map((skin) => skin.effects.density ?? 0))}`,
)
check(
  '最重的主题 × 最重的档位 × 4K 窗口也不会撞上硬上限',
  plans.every((row) => particlesAt(row.plan.ambient.density, 3840 * 2160) <= MAX_PARTICLES),
  `4K 上最多 ${Math.max(...plans.map((row) => particlesAt(row.plan.ambient.density, 3840 * 2160)))} 个`,
)
check(
  '标准档每个主题都有真实粒子（不是所有主题都静默地空）',
  BUILT_IN_SKINS.every((skin) => particlesAt(densityOf(skin.id, 'standard'), 2560 * 1600) > 0),
  '2560×1600 下均 > 0',
)
check(
  '节能档确实比标准档轻（主题层的降级，不只是帧循环降速）',
  BUILT_IN_SKINS.every((skin) => densityOf(skin.id, 'eco') < densityOf(skin.id, 'standard')),
  `节能最大 ${Math.max(...BUILT_IN_SKINS.map((skin) => densityOf(skin.id, 'eco'))).toFixed(3)} < 标准最小 ${Math.min(...BUILT_IN_SKINS.map((skin) => densityOf(skin.id, 'standard'))).toFixed(3)}`,
)
check(
  '关闭档真的没有粒子（0 成本，而不是“密度很小”）',
  BUILT_IN_SKINS.every((skin) => densityOf(skin.id, 'off') === 0 && plans.filter((row) => row.id === skin.id && row.level === 'off').every((row) => row.plan.ambient.particles === 'none')),
  'density 0 且 kind = none',
)

const blurFiles = ['src/renderer/src/styles/app.css', 'src/renderer/src/styles/base.css']
const blurUsages = blurFiles.flatMap((file) =>
  readFileSync(file, 'utf8')
    .split('\n')
    .map((line, index) => ({ file, line, index: index + 1 }))
    .filter((row) => /backdrop-filter:\s*blur\(/.test(row.line)),
)
check(
  '每个 backdrop-filter 都乘了 --glass-blur-scale（否则暂停降级会漏掉那个面板）',
  blurUsages.length > 10 && blurUsages.every((row) => row.line.includes('--glass-blur-scale')),
  `${blurUsages.length} 处，未缩放的：${blurUsages.filter((row) => !row.line.includes('--glass-blur-scale')).map((row) => `${row.file}:${row.index}`).join(', ') || '无'}`,
)
check(
  '暂停时玻璃模糊真的降下来（data-playing=false 里改的是同一个变量）',
  /:root\[data-playing='false'\][^}]*--glass-blur-scale:\s*\.[0-9]+/s.test(readFileSync('src/renderer/src/styles/app.css', 'utf8')),
  'app.css 的暂停规则',
)

/* ---------------------------------------------------- 2. which frames get drawn */

check('第一帧永远允许绘制（否则画布永远是空的）', shouldDraw(0, 1000, 16.67) === true, 'first pass')
check(
  '60Hz 预算下 60Hz 的帧全部通过，只有明显偏早的帧被跳过（不会因抖动掉到 30fps）',
  shouldDraw(1000, 1016.6, 16.67) === true && shouldDraw(1000, 1015.2, 16.67) === true && shouldDraw(1000, 1008, 16.67) === false,
  '16.6ms 与 15.2ms 通过，8ms（半帧）跳过',
)
{
  // The contract a user actually picks: "30" must mean about 30 draws a second on a 144 Hz panel.
  let lastDraw = 0
  let allowed = 0
  const budget = frameBudgetMs(30, 144)
  for (let frame = 0; frame < 144; frame += 1) {
    const now = (frame / 144) * 1000
    if (shouldDraw(lastDraw, now, budget)) {
      lastDraw = now
      allowed += 1
    }
  }
  check('144Hz 屏上选 30 档，一秒内实际绘制约 30 帧', allowed >= 28 && allowed <= 32, `${allowed} 次绘制`)
}

/* ----------------------------------------------------- 3. reading the display */

check('刷新率从帧间隔的低分位还原（60Hz）', detectRefreshHz(series(16.6, 60)) === 60, String(detectRefreshHz(series(16.6, 60))))
check('刷新率从帧间隔的低分位还原（144Hz）', detectRefreshHz(series(6.94, 60)) === 144, String(detectRefreshHz(series(6.94, 60))))
check('刷新率会被吸附到屏幕真实档位，而不是给出 59/66 这种数', detectRefreshHz(series(16.6, 60, 0.2)) === 60, String(detectRefreshHz(series(16.6, 60, 0.2))))
check('样本太少时不给结论', detectRefreshHz(series(16.6, 8)) === null, 'needs >= 20')
check('垃圾数据不会变成刷新率', detectRefreshHz([0, -5, NaN, 5000, ...series(16.6, 30)]) === 60, 'filtered')

/* ---------------------------------------------------------- 4. the load grade */

{
  const smooth60 = gradeOf(series(16.67, 90), frameBudgetMs('follow', 60))
  check('60Hz 屏上满帧渲染判为「正常」', smooth60.grade === 'fine', smooth60.grade)

  /*
   * A fast panel must not be a stick to beat the application with.
   *
   * 16.6 ms frames are sixty frames a second: smooth by any measure. Grading purely against the panel
   * would call this one a third of a 144 Hz display's rate and "overloaded" — which is exactly what the
   * first packaged run did, dropping the level mid-session and taking four unrelated visual checks down
   * with it. The load line is floored at 60 fps, so the same frames are fine here too.
   */
  for (const hz of [120, 144, 165, 240]) {
    const smoothOnFast = gradeOf(series(16.67, 90), frameBudgetMs('follow', hz))
    check(
      `${hz}Hz 屏上 60fps 不被判为过载（负载线有 60fps 地板）`,
      smoothOnFast.grade === 'fine',
      `${smoothOnFast.grade} · p95 ${smoothOnFast.stats.p95Ms.toFixed(1)}ms`,
    )
  }

  // …but a genuinely slow machine is slow on any panel.
  const slowOnFast = gradeOf(series(40, 90), frameBudgetMs('follow', 165))
  check('165Hz 屏上真的卡（25fps）一样判为过载', slowOnFast.grade === 'overloaded', slowOnFast.stats.p95Ms.toFixed(1))

  // The multiple still governs a *slow* panel: 30 Hz means 33.3 ms is a perfectly good frame there.
  const slowPanel = gradeOf(series(33.3, 90), frameBudgetMs('follow', 30))
  check('30Hz 屏上跟得上刷新率的帧不算过载（倍数跟着屏幕放宽）', slowPanel.grade === 'fine', `${slowPanel.grade} · p95 ${slowPanel.stats.p95Ms.toFixed(1)}ms`)

  const chunky = gradeOf(series(40, 90), frameBudgetMs('follow', 60))
  check('明显卡顿（25fps）判为过载', chunky.grade === 'overloaded', chunky.stats.p95Ms.toFixed(1))

  const slightlyLate = gradeOf(series(20.5, 90), frameBudgetMs('follow', 60))
  check('轻微掉帧（48fps）仍算正常，不折腾用户的档位', slightlyLate.grade === 'fine', `${slightlyLate.grade} · p95 ${slightlyLate.stats.p95Ms.toFixed(1)}ms`)

  const busy = gradeOf(series(28, 90), frameBudgetMs('follow', 60))
  check('介于两者之间（约 36fps）判为「吃紧」而不是过载', busy.grade === 'busy', `${busy.grade} · p95 ${busy.stats.p95Ms.toFixed(1)}ms`)

  check('样本不足时不给判定（启动阶段不判案）', gradeLoad({ samples: 5, meanMs: 40, p50Ms: 40, p95Ms: 40, droppedRatio: 1 }, 16.67) === 'unknown', 'unknown')

  /*
   * The claim that made the drop-ratio rule redundant, as an assertion: 30% of frames a full period late
   * cannot hide behind a low p95. 70% at one period, 30% at two.
   */
  const bimodal = gradeOf([...series(16.67, 63), ...series(33.3, 27)], frameBudgetMs('follow', 60))
  check(
    '三成帧晚一整个周期时，p95 已经自己越过判定线（所以不再需要第二套规则）',
    bimodal.grade === 'overloaded' && bimodal.stats.droppedRatio > 0.2,
    `${bimodal.grade} · p95 ${bimodal.stats.p95Ms.toFixed(1)}ms · 掉帧 ${(bimodal.stats.droppedRatio * 100).toFixed(0)}%`,
  )
}

check('分位数按定义计算，均值不掩盖尾部', (() => {
  const stats = summarise([10, 10, 10, 10, 10, 10, 10, 10, 10, 200], 16.67)
  return Math.abs(stats.p50Ms - 10) < 0.001 && stats.p95Ms > 150 && stats.meanMs > 19 && stats.droppedRatio > 0
})(), 'mean hides it, p95 does not')

/* --------------------------------------------------------- 5. the guard policy */

{
  /*
   * 启动宽限走的是同一个纯策略，所以用假时钟直接验行为。旧版这条断言写在主题套件里，验的是“源码里有没有那个常量”
   * ——字符串过了，但启动阶段到底判不判案根本没人验证。
   */
  let state = { ...INITIAL_GUARD }
  const early = guardStep(state, 'overloaded', GUARD.warmupMs - 1000)
  check(
    '启动宽限期内即使满帧卡顿也不改档位（一次启动慢不是设备差）',
    early.action === 'hold' && early.state.badSince === 0 && early.state.changedAt === 0,
    `warmup ${GUARD.warmupMs}ms · @${GUARD.warmupMs - 1000}ms → ${early.action}`,
  )
  check(
    '宽限期结束后才开始计“持续多久”（滞回真的开始走）',
    guardStep({ ...INITIAL_GUARD }, 'overloaded', GUARD.warmupMs + 100).state.badSince === GUARD.warmupMs + 100,
    'streak starts after warmup',
  )

  let action: GuardAction = 'hold'
  state = { ...INITIAL_GUARD }
  for (let at = GUARD.warmupMs; at <= GUARD.warmupMs + GUARD.badMs - 500; at += 300) {
    const step = guardStep(state, 'overloaded', at)
    state = step.state
    action = step.action === 'hold' ? action : step.action
  }
  check(
    '过载不足 2.5s 不动档位（一次 GC 不能算机器差）',
    action === 'hold',
    `${action} @${GUARD.warmupMs + GUARD.badMs - 500}ms`,
  )

  let firstDown = -1
  state = { ...INITIAL_GUARD }
  for (let at = GUARD.warmupMs; at <= GUARD.warmupMs + 8000 && firstDown < 0; at += 300) {
    const step = guardStep(state, 'overloaded', at)
    state = step.state
    if (step.action === 'down') firstDown = at
  }
  check(
    '持续过载后才降档，且只降一次',
    firstDown - GUARD.warmupMs >= GUARD.badMs && firstDown - GUARD.warmupMs <= GUARD.badMs + 800,
    `启动后 ${firstDown}ms`,
  )

  // After the step down, the cooldown must hold even if the load is still bad.
  const afterDown = guardStep({ badSince: 0, goodSince: 0, changedAt: firstDown }, 'overloaded', firstDown + 1000)
  check('降档后冷却期内不会连降（避免一次卡顿掉两档）', afterDown.action === 'hold', 'cooldown 20s')
}

{
  // A machine that is bad for 3 s and then clean: the level must come back, exactly once, and never
  // climb past the user's own dial.
  const result = simulate({
    budgetMs: frameBudgetMs('follow', 60),
    intervals: [],
    start: 'immersive',
    ceiling: 'immersive',
    // Bad for five seconds — long enough that the 2.5 s streak plus the decision cadence really completes.
    phase: (seconds) => (seconds < 5 ? series(60, 90) : series(16.67, 90)),
    seconds: 80,
  })
  check(
    '先抖 5 秒再恢复：先降一档，之后自动恢复原档（旧版只会一直降）',
    result.actions.map((item) => item.action).join(',') === 'down,up' && result.level === 'immersive',
    result.actions.map((item) => `${item.action}@${Math.round(item.at / 1000)}s`).join(' ') || 'no action',
  )
  check('恢复发生在稳定 30s 之后，而不是立刻', result.actions[1] !== undefined && result.actions[1]!.at - result.actions[0]!.at >= GUARD.goodMs, `间隔 ${result.actions[1] ? Math.round((result.actions[1].at - result.actions[0]!.at) / 1000) : '?'}s`)
}

{
  // The ceiling: a user who picked 标准 must not be talked up to 沉浸 by a fast machine.
  const result = simulate({
    budgetMs: frameBudgetMs('follow', 60),
    intervals: [],
    start: 'standard',
    ceiling: 'standard',
    phase: () => series(16.67, 90),
    seconds: 120,
  })
  check('满帧机器也不会超过用户自己选的档位', result.level === 'standard', `${result.level}（${result.actions.length} 次变化）`)
}

{
  // The floor: automatic reduction stops at 节能 — a slow afternoon must not erase every effect.
  const result = simulate({
    budgetMs: frameBudgetMs('follow', 60),
    intervals: [],
    start: 'immersive',
    ceiling: 'immersive',
    phase: () => series(120, 90),
    seconds: 200,
  })
  check('一直卡也不会自动掉到「关闭」', result.level === 'saver' && result.actions.length >= 2, `${result.level} · ${result.actions.map((item) => item.action).join(',')}`)
}

check('阶梯上下都正确：降档有地板，升档有天花板', upgrade('saver', 'immersive') === 'standard' && upgrade('standard', 'standard') === 'standard' && upgrade('immersive', 'immersive') === 'immersive' && downgrade('saver') === 'saver', 'bounded both ways')

/* --------------------------------------------------------------- 6. the ramp */

check(
  '档位变化的缓动是从 0 到 1 的平滑曲线，不是跳变',
  rampProgress(0) === 0 && rampProgress(RAMP_MS) === 1 && rampProgress(RAMP_MS / 2) > 0.4 && rampProgress(RAMP_MS / 2) < 0.6 && rampProgress(-5) === 0,
  `half=${rampProgress(RAMP_MS / 2).toFixed(2)}`,
)

/* ------------------------------------------- 7. 音乐陪伴记录与彩蛋（纯规则） */

{
  const day = new Date(2026, 8, 15, 21, 30)
  const first = recordPlay(EMPTY_COMPANION, day)
  const later = recordPlay(recordPlay(first, new Date(2026, 8, 16, 9, 0)), new Date(2026, 8, 17, 9, 0))
  check(
    '陪伴记录：第一次播放的日期只写一次，次数一直累加',
    first.firstPlayedAt === '2026-09-15' && first.plays === 1 && later.plays === 3 && later.firstPlayedAt === '2026-09-15',
    `${later.plays} 首 · 自 ${later.firstPlayedAt}`,
  )
  check(
    '陪伴记录：时长只累加正数，脏输入不写进去',
    recordListening(EMPTY_COMPANION, 90).seconds === 90 &&
      recordListening(EMPTY_COMPANION, -5).seconds === 0 &&
      recordListening(EMPTY_COMPANION, NaN).seconds === 0,
    'positive only',
  )
  check(
    '陪伴记录：坏掉的字段单独回退，不会把整段历史丢掉',
    (() => {
      const parsed = parseCompanion('{"plays":12,"seconds":"nope","firstPlayedAt":"2025-01-02"}')
      return parsed.plays === 12 && parsed.seconds === 0 && parsed.firstPlayedAt === '2025-01-02'
    })() && parseCompanion('not json').plays === 0,
    'per field',
  )
  check('陪伴时长说成人话，而不是秒数', formatCompanionTime(45) === '45 秒' && formatCompanionTime(600) === '10 分钟' && formatCompanionTime(5490) === '1 小时 31 分', `${formatCompanionTime(5490)}`)

  check(
    '连听计数只增不减，首曲也算一首',
    nextStreak(0, true) === 1 && nextStreak(1, true) === 2 && nextStreak(NIGHT_STREAK, true) === NIGHT_STREAK + 1 && nextStreak(3, false) === 3,
    'monotonic',
  )

  check(
    '夜里 22:00–03:59 算夜晚，其余不算',
    isNightHour(new Date(2026, 0, 1, 22, 0)) &&
      isNightHour(new Date(2026, 0, 1, 2, 30)) &&
      !isNightHour(new Date(2026, 0, 1, 4, 0)) &&
      !isNightHour(new Date(2026, 0, 1, 21, 59)),
    'boundaries',
  )

  const aura = easterAura({ streak: NIGHT_STREAK, now: new Date(2026, 0, 1, 23, 0), random: () => 1 })
  check('连听五首且已是深夜：极光与雨窗都亮，但不会随机静电', aura.night && aura.window && !aura.signalLost, `night=${aura.night} window=${aura.window}`)
  check(
    '静电按概率触发：极小概率不会每次都给',
    easterAura({ streak: 0, now: new Date(2026, 0, 1, 12, 0), random: () => SIGNAL_LOST_CHANCE + 0.001 }).signalLost === false &&
      easterAura({ streak: 0, now: new Date(2026, 0, 1, 12, 0), random: () => SIGNAL_LOST_CHANCE / 2 }).signalLost === true,
    `chance ${SIGNAL_LOST_CHANCE}`,
  )
  check(
    '静电有冷却：刚出现过就不会马上再来',
    easterAura({ streak: 0, now: new Date(), random: () => 0, lastSignalLostAt: 1000, nowMs: 2000 }).signalLost === false &&
      easterAura({ streak: 0, now: new Date(), random: () => 0, lastSignalLostAt: 1000, nowMs: 200_000 }).signalLost === true,
    'cooldown',
  )
}

/* ------------------------------------------- 8. 主题推荐（纯规则） */

{
  const skins: RecommendSkin[] = [
    { id: 'aurora', name: 'Aurora' },
    { id: 'star-dream', name: '星河入梦' },
    { id: 'autumn-leaf', name: '晚秋拾叶' },
    { id: 'ocean-morning', name: '潮汐晨光' },
    { id: 'jiangnan-rain', name: '烟雨江南' },
    { id: 'sunset-song', name: '落日长歌' },
  ]
  const pick = (input: Parameters<typeof recommendSkin>[0]) => recommendSkin(input, skins)

  check('推荐：古风标题给水墨，并给出理由', pick({ title: '青花瓷（古风琵琶版）' })?.skinId === 'jiangnan-rain', pick({ title: '青花瓷（古风琵琶版）' })?.reason)
  check('推荐：电子 / DJ 给极光', pick({ artist: 'Some DJ', genre: 'EDM remix' })?.skinId === 'aurora', pick({ artist: 'Some DJ', genre: 'EDM remix' })?.skinId)
  check('推荐：纯钢琴与轻音乐给清晨海边', pick({ title: 'Rain Piano 纯音乐' })?.skinId === 'ocean-morning', pick({ title: 'Rain Piano 纯音乐' })?.skinId)

  check(
    '推荐：封面颜色单独就能起作用（蓝色封面 → 海边）',
    pick({ title: '普通的一首歌', accent: '#2f6fd0' })?.skinId === 'ocean-morning',
    pick({ title: '普通的一首歌', accent: '#2f6fd0' })?.reason,
  )
  check(
    '推荐：会拒绍——信息不足时宁可不说',
    pick({ title: 'Untitled', accent: '#808080' }) === null && recommendSkin({ title: 'x' }, []) === null,
    `floor ${MIN_SCORE}`,
  )
  check(
    '推荐：关键词比封面色重（两者矛盾时听关键词）',
    pick({ title: '古风山水', accent: '#d02f2f' })?.skinId === 'jiangnan-rain',
    pick({ title: '古风山水', accent: '#d02f2f' })?.skinId,
  )
  /*
   * 结构项（时长）单独不足以做推荐。
   *
   * 一首 90 秒的间奏并不说明“清晨海边”，所以它低于门槛；但“暖色封面 + 长曲”加起来就够了（0.4+0.12）。
   * 这两条一起把“时长只能加成、不能独立决定”固定下来。
   */
  check(
    '推荐：时长单独不足以推荐（低于门槛），加成后才能起作用',
    pick({ title: 'Interlude', duration: 90 }) === null && pick({ title: 'Set', accent: '#c04a1e', duration: 900 })?.skinId === 'sunset-song',
    `${pick({ title: 'Interlude', duration: 90 }) === null} / ${pick({ title: 'Set', accent: '#c04a1e', duration: 900 })?.skinId}`,
  )
  check(
    '推荐：只会给出真的装了的皮肤（不匹配就拒绍，不会退回一个不相干的）',
    recommendSkin({ title: '古风山水' }, [{ id: 'aurora', name: 'Aurora' }]) === null &&
      recommendSkin({ title: 'EDM dance' }, [{ id: 'aurora', name: 'Aurora' }])?.skinId === 'aurora',
    'installed only',
  )
}

const failed = checks.filter((item) => !item.ok)
for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.detail ? `  ${item.detail}` : ''}`)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
