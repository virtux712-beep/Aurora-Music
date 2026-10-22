/*
 * Aurora's Frame Governor — the runtime half of the performance manager.
 *
 * One `requestAnimationFrame` loop, always running, measuring. Everything decorative asks *it* whether it
 * may draw this frame (`allowDraw`), so a single place owns three decisions that used to be scattered:
 *
 *  1. **How fast to draw.** The budget is the display's real refresh rate, or the user's own cap when
 *     that is lower — see `budget.ts` for why it is not a constant like the old 22 ms.
 *  2. **Whether the machine is coping.** Percentiles, not a mean, so one garbage collection does not
 *     read as a weak laptop and a field of ninety particles at a third of the display's rate does not
 *     read as fine.
 *  3. **What to do about it.** A step down when the load is *overloaded* and stays there, a slow step
 *     back up after thirty clean seconds, and never above what the user picked.
 *
 * Deliberately not reactive and not in the store: this runs every frame, and putting any of it in Vue's
 * reactive graph would make the whole shell re-render at the display's rate to report a number. The Lab
 * overlay polls `frameSnapshot()` a few times a second instead.
 *
 * Nothing here can break playback. The loop never throws (every measurement path is total), the level
 * hooks are optional, and a failure to measure reports `unknown`, which holds the current level rather
 * than guessing at it.
 */
import type { AnimationLevel } from '../../../shared/theme'
import {
  detectRefreshHz,
  frameBudgetMs,
  gateMs as resolveGateMs,
  gradeLoad,
  guardStep,
  GUARD,
  INITIAL_GUARD,
  rampProgress,
  renderScale as resolveRenderScale,
  shouldDraw,
  summarise,
  type FrameRateChoice,
  type FrameStats,
  type GuardAction,
  type GuardState,
  type LoadGrade,
} from './budget'

export interface FrameSnapshot {
  /** Measured display cadence, in frames per second. */
  fps: number
  /** Frames in which at least one decorative layer painted, per second. */
  drawFps: number
  /** Gate pressure: how many times the layers asked, and how many of those were allowed. */
  drawCalls: number
  allowedCalls: number
  /** The interval the user asked for, in ms. */
  budgetMs: number
  /** The capacity implied by the budget (60, 30, …). */
  budgetHz: number
  /**
   * The interval actually enforced right now: the budget raised to the paused/background floor.
   *
   * Separate from `budgetMs` because they answer different questions — "what did the user pick" versus "what
   * is this idle window doing".
   */
  gateMs: number
  gateHz: number
  /**
   * How much of its level's pixel-ratio cap the decorative canvases are drawing at, 0…1.
   *
   * 1 while music plays in the foreground, less when the room is still (see `IDLE_RENDER_SCALE`). Reported
   * because "the canvas got smaller" is otherwise unobservable, and because the Lab's 像素比上限 row would
   * otherwise describe an intention rather than the thing on screen.
   */
  renderScale: number
  /** Detected panel refresh, or null before there is enough evidence to say. */
  displayHz: number | null
  choice: FrameRateChoice
  stats: FrameStats
  grade: LoadGrade
  /** Whether the window is currently visible — no measurement happens while it is not. */
  visible: boolean
  /** 0…1: how far the last level change has been applied, for smooth density ramps. */
  ramp: number
  /** How many times the load guard has changed the level this session. */
  changes: number
  /** Why it last changed, for the Lab and the notification. */
  reason: string
  /** Particles the ambient layer drew on its last pass — the real count, not the configured density. */
  particles: number
}

export type LoadAction = 'down' | 'up'
export type LoadHandler = (action: LoadAction, stats: FrameStats, grade: LoadGrade) => void

/** Measured intervals kept for the refresh estimate — long enough to survive a busy second. */
const WINDOW = 180
/** Intervals summarised per decision. ~1.5 s at 120 Hz, which is the shortest honest load sample. */
const STATS_WINDOW = 90
/** How often a decision is taken. Cheap enough to be frequent, long enough to be meaningful. */
const DECIDE_INTERVAL_MS = 300
/**
 * Re-detecting the panel is only meaningful while frames are cheap.
 *
 * Under load every observed interval stretches — including the fastest ones — so a machine rendering at
 * 30 fps would "detect" a 30 Hz panel, widen its own budget to 33 ms, and then declare itself healthy.
 * The guard would disarm exactly when it was needed, so detection is skipped unless the load reads fine.
 */
const REDETECT_MS = 6000
/** A delta this large means the window slept, the compositor stalled, or a breakpoint paused us. */
const MAX_DELTA_MS = 500

let intervals: number[] = []
let choice: FrameRateChoice = 'follow'
let displayHz: number | null = null
let budgetMs = frameBudgetMs('follow', null)
/**
 * The interval the gate actually enforces — `budgetMs`, raised to whichever floor the current situation sets.
 *
 * Kept apart from `budgetMs` on purpose: the budget is what the user asked for (and what load grading is
 * judged against), while the gate is what this moment deserves. Collapsing them would make a paused window
 * look like a machine that cannot keep up, and the guard would start downgrading effects for it.
 */
let gateMs = budgetMs
/** Whether music is playing. Until the shell says otherwise, assume the cheap state. */
let focused = true
let playing = false
let lastFrameAt = 0
let startedAt = 0
let lastDecideAt = 0
let lastDetectAt = 0

let stats: FrameStats = { samples: 0, meanMs: 0, p50Ms: 0, p95Ms: 0, droppedRatio: 0 }
let grade: LoadGrade = 'unknown'
let guard: GuardState = { ...INITIAL_GUARD }
let rampStartAt = 0
let changes = 0
let reason = ''

/*
 * Gate bookkeeping.
 *
 * `lastDraw` is per *consumer*, and that is not a detail — it was a bug. A single shared timestamp looks
 * like the natural reading of "one budget for the app", but with several layers drawing every frame it
 * serialises them instead of rate-limiting them: whichever layer runs first each frame consumes the
 * budget, and the others are blocked *forever* (their next callback is in the next frame, by which time the
 * first layer has taken it again). The record disc had exactly this failure — its angle was never written,
 * because the ambient field mounted earlier and always won the frame.
 *
 * Per-consumer state is also what "cap the decorative frame rate at 30" actually means: every decorative
 * layer paints at most 30 times a second. `drawFrames` still counts *frames* in which anything painted, so
 * the reported rate stays a rate a user can interpret rather than a sum over layers.
 */
const lastDraw = new Map<string, number>()
let drawFrames = 0
let drawCalls = 0
let allowedCalls = 0
let frameCount = 0
let rateWindowAt = 0
let fps = 0
let drawFps = 0

let particleCount = 0

let onLoad: LoadHandler | null = null
let ceiling: () => AnimationLevel = () => 'standard'
let frame = 0
let installed = false

/** The inner width/height of the display, as a cheap proxy for "the user changed screens". */
let lastScreen = ''

function resetStreaks(): void {
  guard = { ...guard, badSince: 0, goodSince: 0 }
}

/** Recomputes the gate. The policy itself lives in `budget.ts` (`gateMs`), where it is unit-tested. */
function refreshGate(): void {
  gateMs = resolveGateMs(budgetMs, { focused, playing })
}

/**
 * Music started or stopped.
 *
 * Called by the shell rather than read from the player store: this module runs every frame and is
 * deliberately outside Vue's reactive graph (see the header), so the one value it needs is pushed to it.
 */
export function setFrameActivity(next: boolean): void {
  if (playing === next) return
  playing = next
  refreshGate()
}

/**
 * The resolution multiplier the decorative layers should draw at right now — see `renderScale` in
 * `budget.ts` for why a paused window may draw smaller.
 *
 * Read by the layers themselves rather than pushed to them: they already consult this module every frame
 * (`allowDraw`), the state lives here, and threading a second value through props would mean two things to
 * keep in step instead of one.
 */
export function renderScaleFactor(): number {
  return resolveRenderScale({ focused, playing })
}

/**
 * The window gained or lost focus, or was hidden.
 *
 * Bound here rather than in the shell so it cannot be forgotten by a caller, and so the listeners live
 * exactly as long as the loop does.
 */
function onFocus(): void {
  focused = true
  refreshGate()
  publishFocus()
}

function onBlur(): void {
  focused = false
  refreshGate()
  publishFocus()
}

function onVisibility(): void {
  publishFocus()
}

function measure(now: number): void {
  const delta = now - lastFrameAt
  lastFrameAt = now
  frameCount += 1
  if (delta <= 0 || delta > MAX_DELTA_MS) return
  intervals.push(delta)
  if (intervals.length > WINDOW) intervals.splice(0, intervals.length - WINDOW)
}

function decide(now: number): void {
  const recent = intervals.slice(-STATS_WINDOW)
  stats = summarise(recent, budgetMs)
  grade = gradeLoad(stats, budgetMs)
  // The guard works in *time since the loop started* — the warm-up and the cooldown are both policy, and both
  // belong with the policy rather than here (see `GUARD.warmupMs`).
  const step = guardStep(guard, grade, now - startedAt, GUARD)
  guard = step.state
  if (step.action === 'hold') return
  apply(step.action, now)
}

function apply(action: GuardAction, now: number): void {
  if (action === 'hold') return
  changes += 1
  /*
   * Only a step *up* is ramped.
   *
   * Growing the field should read as "it filled back in", so the density climbs over ~0.7 s from the
   * sparse count that is already on screen. Shrinking must not: scaling a *reduced* count by a rising
   * ramp would dip the field to nearly empty and then grow it back to the smaller number, which looks
   * like a flicker — and it would also mean keeping the heavy frame alive a little longer than needed,
   * which is the opposite of what a machine under load asked for by being slow.
   */
  rampStartAt = action === 'up' ? now : 0
  reason =
    action === 'down'
      ? `帧耗时偏高（p95 ${stats.p95Ms.toFixed(1)}ms / 预算 ${budgetMs.toFixed(1)}ms），已自动降一级动效`
      : `帧率已稳定（p95 ${stats.p95Ms.toFixed(1)}ms），已恢复一级动效`
  // The loop resets the streaks itself so an action can never fire twice for one streak, and the
  // cooldown in `guardStep` starts from that same moment.
  onLoad?.(action, stats, grade)
}

function detectPanel(now: number, force: boolean): void {
  if (displayHz !== null && !force && now - lastDetectAt < REDETECT_MS) return
  if (!force && grade !== 'fine' && grade !== 'unknown') return
  /*
   * Only trust a *tight* window, and this is the fix for a bug that corrupted the budget for the rest of a
   * session.
   *
   * A renderer that is keeping up with vsync produces tightly clustered intervals (p95 barely above p50,
   * because they are all the panel's period). A renderer that is busy, or being blocked by a debugger, spans
   * a wide range — and the *median* of a wide range is whatever the machine was doing most of the time, which
   * during a heavy moment is "30 fps". That was measured on a 165 Hz display: a re-detection concluded "30 Hz
   * panel", which *widened* the budget to 33 ms, which then made the load grade read `fine` and kept the
   * wrong answer permanently. Self-reinforcing, and invisible except as "the effects stopped updating".
   */
  const recent = intervals.slice(-STATS_WINDOW)
  const spread = summarise(recent, budgetMs)
  const tight = spread.samples >= 60 && spread.p50Ms > 0 && spread.p95Ms <= spread.p50Ms * 1.25
  if (!tight) return
  const detected = detectRefreshHz(intervals)
  lastDetectAt = now
  if (detected === null || detected === displayHz) return
  displayHz = detected
  budgetMs = frameBudgetMs(choice, displayHz)
  refreshGate()
  reason = `显示刷新率重新识别为 ${detected} Hz`
}

function tick(): void {
  frame = window.requestAnimationFrame(tick)
  const now = performance.now()
  const visible = !document.hidden

  if (lastFrameAt === 0) {
    lastFrameAt = now
    rateWindowAt = now
    return
  }

  if (!visible) {
    /*
     * A hidden window gets no meaningful frames: Chromium throttles rAF to a crawl, so the deltas are
     * enormous and every one of them would read as "overloaded". The streaks are cleared rather than
     * merely skipped, so time spent in the background can neither trigger nor contribute to a downgrade.
     */
    lastFrameAt = now
    resetStreaks()
    intervals = []
    return
  }

  // A display change (an external monitor, a scaled panel) shows up as a different work area.
  const screen = `${window.screen?.width ?? 0}x${window.screen?.height ?? 0}`
  if (screen !== lastScreen) {
    lastScreen = screen
    detectPanel(now, true)
  }

  measure(now)
  if (now - lastDecideAt >= DECIDE_INTERVAL_MS) {
    lastDecideAt = now
    detectPanel(now, false)
    decide(now)
    const elapsed = Math.max(1, now - rateWindowAt)
    fps = (frameCount * 1000) / elapsed
    drawFps = (drawFrames * 1000) / elapsed
    frameCount = 0
    drawFrames = 0
    rateWindowAt = now
    publish()
  }/*
 * A level change is ramped rather than switched: the caller multiplies the new density by this value,
 * so the field thins out over ~0.7 s instead of visibly jumping from 90 particles to 31 in one frame.
 */
}

/**
 * Mirrors the current reading onto `<html>` as data attributes.
 *
 * Because the numbers are only useful if they are *live*, and the two ways of reading them are not equally
 * reliable: a Vue-rendered panel (Aurora Lab) stops re-rendering whenever the window is occluded — Chromium
 * throttles its timers — and then shows its last snapshot as though it were current. That is exactly how a
 * packaged run reported "30 fps cap" and "141 draws a second" in the same snapshot: the panel had frozen on
 * the frame before the cap was applied. The attributes are written by the frame loop itself (which keeps
 * running while the window is merely behind another one), so anything that needs a trustworthy number — the
 * diagnostics suite, a bug report — reads these.
 */
/**
 * Mirrors "is anybody actually looking at this window" onto `<html>` as `data-fx-focus`.
 *
 * Why this needs to exist at all: the gate above is only able to rate-limit the layers that ask *it*, i.e. the
 * canvas ones. The full-window background drift and the aurora breathing are CSS keyframes, and a keyframe on a
 * visible-but-unfocused window is composited at the display's cadence no matter what this loop decides — so
 * before this attribute the two halves of the same policy disagreed: the canvas dropped to the background floor
 * while the most expensive layer (a screen-sized, `will-change: transform` gradient) kept repainting the whole
 * window. Freezing it here costs nothing visually — an unfocused window is a window nobody is looking at, and
 * the state is re-read on focus so coming back resumes instantly.
 *
 * Written on the focus/visibility events rather than from `publish()`, because `publish()` runs inside the
 * visible branch of the tick: a hidden window would never update it, and "hidden" is precisely the case this
 * exists to cover.
 */
function publishFocus(): void {
  document.documentElement.dataset.fxFocus = focused && !document.hidden ? 'active' : 'background'
}

function publish(): void {
  const root = document.documentElement
  root.dataset.fxFps = fps.toFixed(1)
  root.dataset.fxDraw = drawFps.toFixed(1)
  root.dataset.fxBudget = budgetMs.toFixed(2)
  // The enforced interval, which is the budget raised to the pause/background floor — the number to look at
  // when asking "is this idle player cheap yet?".
  root.dataset.fxGate = gateMs.toFixed(2)
  root.dataset.fxHz = String(displayHz ?? 0)
  root.dataset.fxGrade = grade
  root.dataset.fxChanges = String(changes)
  root.dataset.fxParticles = String(particleCount)
  /*
   * The resolution the decorative layers are drawing at.
   *
   * Published for the same reason `fxGate` is: the difference between "the policy says a paused window may
   * draw smaller" and "the canvas actually re-allocated its backing store" is invisible from outside, and a
   * saving nobody can observe is a saving nobody can check. Aurora Lab shows it next to the frame budget,
   * and `check:idle` reads it to confirm the canvas really is at the idle scale while it measures.
   */
  root.dataset.fxScale = String(renderScaleFactor())
}

/** Starts the loop. Safe to call twice — the second call is a no-op. */
export function startFrames(): void {
  if (installed) return
  installed = true
  startedAt = performance.now()
  lastDecideAt = startedAt
  lastDetectAt = startedAt
  lastFrameAt = 0
  focused = document.hasFocus()
  refreshGate()
  publishFocus()
  window.addEventListener('focus', onFocus)
  window.addEventListener('blur', onBlur)
  document.addEventListener('visibilitychange', onVisibility)
  frame = window.requestAnimationFrame(tick)
}

export function stopFrames(): void {
  if (!installed) return
  installed = false
  window.removeEventListener('focus', onFocus)
  window.removeEventListener('blur', onBlur)
  document.removeEventListener('visibilitychange', onVisibility)
  window.cancelAnimationFrame(frame)
}

/**
 * Whether a decorative pass may draw this frame.
 *
 * `key` identifies the caller for its own cadence — a layer that is blocked must not block anyone else. The
 * cost is a map lookup against a string constant, and a subtraction: no allocation, and no clock read
 * beyond the one the caller already has.
 */
export function allowDraw(key: string, now = performance.now()): boolean {
  drawCalls += 1
  const previous = lastDraw.get(key) ?? 0
  if (!shouldDraw(previous, now, gateMs)) return false
  lastDraw.set(key, now)
  allowedCalls += 1
  // One frame, counted once, however many layers painted in it.
  if (now !== lastDrawFrameAt) {
    lastDrawFrameAt = now
    drawFrames += 1
  }
  return true
}

let lastDrawFrameAt = 0

/** The user's cap, or `follow` for the display's own rate. Recomputes the budget immediately. */
export function setFrameRate(next: FrameRateChoice): void {
  choice = next
  budgetMs = frameBudgetMs(choice, displayHz)
  refreshGate()
}

export function frameRateChoice(): FrameRateChoice {
  return choice
}

export function frameBudget(): number {
  return budgetMs
}

/**
 * How far the last level change has been applied (0…1).
 *
 * Exported so the layers that draw *density* can scale into a change instead of snapping to it. Returns
 * 1 when nothing has ever changed, which is the same as "no ramp", so callers need no special case.
 */
export function rampFactor(now = performance.now()): number {
  if (rampStartAt === 0) return 1
  return rampProgress(now - rampStartAt)
}

/**
 * Gives the guard somewhere to send its decisions.
 *
 * The frame layer knows about *load*; the store knows about *levels*. `ceiling` is the level the user
 * chose, which the guard may never exceed however well the machine is doing, and the handler is called
 * once per decision — not per frame.
 */
export function installGovernor(handler: LoadHandler, userCeiling: () => AnimationLevel): void {
  onLoad = handler
  ceiling = userCeiling
}

export function guardCeiling(): AnimationLevel {
  return ceiling()
}

/**
 * How many particles the ambient layer just put on screen.
 *
 * Reported rather than derived: the configured density turns into a count through a per-100 000 px²
 * formula and a hard cap, so "density 0.03" says nothing a reader can check against what they see. The
 * number the Lab shows is the one that was actually looped over.
 */
export function reportParticles(count: number): void {
  particleCount = count
}

export function frameSnapshot(): FrameSnapshot {
  return {
    fps: Math.round(fps * 10) / 10,
    drawFps: Math.round(drawFps * 10) / 10,
    budgetMs: Math.round(budgetMs * 100) / 100,
    budgetHz: Math.round(1000 / budgetMs),
    gateMs: Math.round(gateMs * 100) / 100,
    gateHz: Math.round(1000 / gateMs),
    renderScale: renderScaleFactor(),
    displayHz,
    choice,
    stats,
    grade,
    visible: !document.hidden,
    ramp: rampFactor(),
    changes,
    reason,
    particles: particleCount,
    drawCalls,
    allowedCalls,
  }
}
