/*
 * The frame budget: how fast the decorative layers are allowed to draw, and when the app decides it is
 * asking too much of the machine.
 *
 * Pure functions with no DOM, no timers and no store, for the same reason `levels.ts` is pure: the
 * interesting part is arithmetic (a budget per display, a grade from measurements, a decision with
 * hysteresis) and arithmetic can be tested offline. `frame.ts` is the runtime that feeds these numbers.
 *
 * Two things here are deliberate corrections of the previous behaviour:
 *
 *  1. **The budget follows the display, not a constant.** The old watchdog called a frame slow above a
 *     fixed 22 ms. On a 60 Hz screen that is roughly one frame late — reasonable. On a 120 Hz screen the
 *     budget is 8.3 ms, so an app rendering at a third of the display's rate (25 ms per frame, 40 fps)
 *     never tripped it: the visuals were visibly chunky and the watchdog said the machine was fine.
 *     Everything is therefore expressed as a multiple of the *actual* refresh interval.
 *  2. **It can recover.** The old watchdog only ever stepped down, on the theory that a machine which
 *     recovered from a stall has not proven it can keep up. That is true of the 3-second window it used
 *     and false of a machine whose heavy moment has passed — and the cost of being wrong is a user who
 *     closed a virtual machine thirty minutes ago and still has no particles. Recovery is slow (30 s
 *     clean) and capped by the user's own choice, which is what makes it safe.
 */

/**
 * What the user picked for the frame cap.
 *
 * `follow` means "whatever the display does"; a number is an explicit ceiling in frames per second.
 * A number is **not** restricted to the presets the settings page offers — `FRAME_RATE_OPTIONS` is a
 * convenience list and `isFrameRateChoice` is the contract, so 85 or 165 are as valid as 60. A cap
 * above the panel's rate is not an error either: `frameBudgetMs` takes the lower of the two, so
 * asking for 144 on a 60 Hz laptop means "as fast as this screen goes", not 144 wasted frames.
 */
export type FrameRateChoice = 'follow' | number

/** The presets, `follow` included. Any whole number in `FRAME_RATE_MIN..FRAME_RATE_MAX` is also legal. */
export const FRAME_RATE_OPTIONS: readonly FrameRateChoice[] = ['follow', 30, 60, 90, 120, 144]

/**
 * The accepted range for a hand-typed cap.
 *
 * The floor is the same 24 Hz `detectRefreshHz` treats as the slowest real panel — below it the app
 * would be a slideshow, and "1 FPS" is a way to make the player look broken rather than efficient.
 * The ceiling is above every consumer display so the field never has to refuse a plausible number.
 */
export const FRAME_RATE_MIN = 24
export const FRAME_RATE_MAX = 240

/** Rounds and clamps a typed value into the legal range (used by the settings field). */
export function clampFrameRate(value: number): number {
  return Math.min(FRAME_RATE_MAX, Math.max(FRAME_RATE_MIN, Math.round(value)))
}

/** Refresh rates below this are treated as a measurement failure rather than a slow panel. */
const MIN_REFRESH_HZ = 24
/** …and above this as a bogus reading (a hidden window reports absurdly small deltas). */
const MAX_REFRESH_HZ = 360

/**
 * The rates a desktop panel actually reports.
 *
 * Measurement is snapped to this list because a raw ratio is never exact: a 60 Hz panel reads as
 * 16.6 ms ± jitter, which divides to 59 or 66 depending on the frame, and an uncorrected budget would
 * then sit slightly *above* the real interval — meaning every second frame gets skipped and the field
 * silently runs at 30 fps on a screen that could do 60.
 */
const PANEL_HZ = [30, 48, 50, 60, 75, 90, 100, 120, 144, 165, 180, 240]

function snapRefresh(hz: number): number {
  let best = PANEL_HZ[0]!
  let bestDistance = Infinity
  for (const candidate of PANEL_HZ) {
    const distance = Math.abs(Math.log(hz / candidate))
    if (distance < bestDistance) {
      bestDistance = distance
      best = candidate
    }
  }
  return best
}

export function isFrameRateChoice(value: unknown): value is FrameRateChoice {
  if (value === 'follow') return true
  return typeof value === 'number' && Number.isInteger(value) && value >= FRAME_RATE_MIN && value <= FRAME_RATE_MAX
}

/**
 * Reads a choice back from storage, where everything is a string.
 *
 * The stored form is `String(choice)` — `'follow'`, or `'85'` for a numeric cap — and
 * `isFrameRateChoice` deliberately rejects strings, because a text field must not be able to hand a
 * number-shaped string straight to the governor. The two together used to mean a numeric cap *never*
 * came back: the settings page showed 60, the badge said 60, and the next launch drew at the display's
 * own rate with nothing on screen to explain it. The parse lives here, next to the contract, so the
 * only place that knows the stored encoding is the one that defines it.
 */
export function parseFrameRateChoice(stored: unknown): FrameRateChoice | null {
  if (typeof stored !== 'string') return isFrameRateChoice(stored) ? stored : null
  if (stored === 'follow') return 'follow'
  const value = Number(stored.trim())
  return stored.trim() !== '' && Number.isFinite(value) && isFrameRateChoice(value) ? value : null
}

/** Parses a value the user typed into the custom field; `null` when it is not a usable cap. */
export function parseFrameRateInput(text: string): number | null {
  const trimmed = text.trim()
  if (!/^\d{1,3}$/.test(trimmed)) return null
  const value = Number(trimmed)
  return value >= FRAME_RATE_MIN && value <= FRAME_RATE_MAX ? value : null
}

/**
 * The display's own refresh rate, from the frame intervals observed.
 *
 * The **median**, not the fastest sample. rAF is vsync-aligned, so over a window the intervals cluster on
 * the panel's period: a slow frame is followed by a slightly short one that catches up, and a hiccup
 * widens the tail in both directions. The minimum or a low percentile is therefore itself a tail value —
 * taking it literally is how a 144 Hz panel gets measured as 165 Hz (and then a third of the frames are
 * thrown away because the budget came out too small). The median lands on the panel's period instead, and
 * the only way it is wrong is if *most* frames are late, which `frame.ts` excludes by refusing to detect
 * while the load reads heavy.
 *
 * Requires a real sample count so a two-frame measurement cannot decide anything.
 */
export function detectRefreshHz(intervals: readonly number[]): number | null {
  if (intervals.length < 20) return null
  const sorted = [...intervals].filter((value) => Number.isFinite(value) && value > 1 && value < 200).sort((a, b) => a - b)
  if (sorted.length < 20) return null
  const middle = sorted.length % 2 === 0 ? (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2 : sorted[(sorted.length - 1) / 2]!
  const hz = 1000 / middle
  if (!Number.isFinite(hz)) return null
  return snapRefresh(Math.min(MAX_REFRESH_HZ, Math.max(MIN_REFRESH_HZ, hz)))
}

/**
 * The interval the decorative layers must not beat, in milliseconds.
 *
 * `follow` on an unknown display falls back to 60: the sandbox is that the app must never draw *faster*
 * than something sensible while waiting for a measurement, and 60 is the rate every desktop can do.
 * A user-chosen rate is a ceiling, not a floor — picking 144 on a 60 Hz panel does not make the panel
 * faster, so the effective rate is the lower of the two.
 */
export function frameBudgetMs(choice: FrameRateChoice, displayHz: number | null): number {
  const display = displayHz && displayHz > 0 ? displayHz : 60
  const asked = choice === 'follow' ? display : Math.min(choice, display)
  return 1000 / Math.max(MIN_REFRESH_HZ, asked)
}

/**
 * Redraw floor while nothing is playing: 30 fps, not the panel's rate.
 *
 * The decoration here is slow by design — drifting gradients, a particle field, a breathing glow — and none of
 * it is perceptibly different at 60 fps than at 165 fps. Measured on the development machine before this
 * floor existed: a **paused** player on the lyrics page drew 158 frames a second. The panel's rate is worth
 * paying for while a song is playing (that is when motion is dense and being watched); it is not worth paying
 * for a still room.
 *
 * ## Why 30 and not 60
 *
 * 60 was still the single largest idle cost in the app, and that was measured rather than assumed
 * (`tools/idle-cost-check.mjs --attribute` attributes processor time per process type, then hides one layer
 * at a time). Paused, on the lyrics page:
 *
 *   the whole app          ≈ 0.40 core, of which the GPU process is ≈ 0.26 and the renderer ≈ 0.12
 *   hiding the particle canvas       saves 0.247 core   (≈ 65 % of the total)
 *   hiding the CSS background layers saves 0.000 core   (the pause freeze already reaches them)
 *   removing every `backdrop-filter`  saves 0.120 core   (the glass look, not a bug)
 *
 * So a paused player was spending two thirds of its idle budget on a screen-sized canvas that was repainted —
 * and re-uploaded as a texture — sixty times a second to animate dust drifting a few pixels per second. The
 * canvas is the layer a paused window can most afford to update less often: it is soft, it is behind
 * everything, and nothing on it is being read. Halving its cadence is invisible at those speeds and takes
 * roughly half of that 0.247 core back; the panel's full rate returns the instant playback starts.
 *
 * 30 is also exactly the pause cadence a *lyric* page wants to avoid: the lyric scroll runs on its own loop
 * (`lyrics/scroll.ts`) and does not consult this gate, so text motion is unaffected by the value here.
 */
export const PAUSED_GATE_MS = 1000 / 30

/**
 * How much of its level's own pixel-ratio cap the decorative canvas may use while nobody is watching it.
 *
 * ## Why this exists
 *
 * The particle field is the single largest idle cost in the app, and that was measured rather than assumed
 * (`tools/idle-cost-check.mjs --attribute`, paused on the lyrics page, packaged build):
 *
 *   the whole app                ≈ 0.39 core
 *   hiding the particle canvas       saves 0.247 core   (≈ 65 % of the total)
 *   hiding the CSS background layers saves 0.000 core   (the pause freeze already reaches them)
 *
 * The pause cadence came down to 30 fps first (`PAUSED_GATE_MS`), which halved that to ≈0.13 core. What is
 * left is **fill**: a 2880×1620 backing store repainted thirty times a second and re-uploaded as a texture,
 * to move dust a few pixels per second. Nothing on that layer is read, nothing on it has an edge — it is
 * soft blobs behind every panel — so drawing it smaller and letting the compositor scale it back up is
 * invisible at those speeds, and it removes about half the pixels.
 *
 * Expressed as a *fraction of the level's cap* rather than a fixed dpr, so the animation level keeps its
 * say: a 节能 level that already caps at 1.0 is not given a second, invisible downgrade on top of the value
 * the settings page shows. Focus wins over playback, exactly as it does for the gate — a background window
 * is not being watched either way.
 */
export const IDLE_RENDER_SCALE = 0.7

/**
 * The pixel-ratio multiplier for the decorative layers: 1 while music plays in the foreground, less when
 * the room is still. Pure, so the arithmetic can be checked offline and the runtime just forwards state.
 */
export function renderScale(state: { focused: boolean; playing: boolean }): number {
  return state.playing && state.focused ? 1 : IDLE_RENDER_SCALE
}

/**
 * Redraw floor while the window is not focused: 12 fps.
 *
 * An unfocused window is a window nobody is looking at, whatever is playing. Chromium throttles a window it
 * knows is occluded or minimised, but merely being behind another window deliberately keeps full frame rate —
 * so a player parked behind a browser used to keep drawing its ambience at the panel's rate all evening.
 * Twelve is enough that alt-tabbing back never shows a frozen picture, and small enough to be unmeasurable.
 */
export const BACKGROUND_GATE_MS = 1000 / 12

/**
 * The interval the gate enforces: the budget the user asked for, raised to whichever floor the situation sets.
 *
 * Kept separate from the budget because they answer different questions — "what did the user pick", which is
 * what load grading must be judged against, versus "what does an idle window deserve". Collapsing them would
 * make a paused window look like a machine that cannot keep up, and the guard would start downgrading
 * effects for it. Focus wins over playback: a background window is not being watched either way.
 */
export function gateMs(budgetMs: number, state: { focused: boolean; playing: boolean }): number {
  const floor = !state.focused ? BACKGROUND_GATE_MS : state.playing ? 0 : PAUSED_GATE_MS
  return Math.max(budgetMs, floor)
}

/**
 * Whether a drawing pass is allowed now.
 *
 * The tolerance exists because a 16.67 ms budget and a 16.6 ms frame are the same thing to a scheduler
 * that is one microsecond early: without it, every second draw at exactly 60 Hz would be skipped and the
 * field would run at 30.
 */
export function shouldDraw(lastDrawAt: number, now: number, budgetMs: number): boolean {
  if (lastDrawAt <= 0) return true
  return now - lastDrawAt >= budgetMs - 1.5
}

export interface FrameStats {
  /** Frames actually measured in the window. */
  samples: number
  /** Mean interval between *measured* frames, in ms — the number the old watchdog used. */
  meanMs: number
  /** Median, which ignores the outliers a mean cannot. */
  p50Ms: number
  /** 95th percentile: the stutter the user can feel, rather than the average that hides it. */
  p95Ms: number
  /**
   * Share of frames that took longer than 1.5 budgets — one missed vsync at 60 Hz.
   *
   * Reported, not decided on: `gradeLoad` reads p95 alone. The two rules were redundant — a series where
   * a big share of frames are late *cannot* have a low p95 — and the ratio version actively misfired on a
   * machine that was uniformly slow, calling it "erratic" when a single number already said "uniformly
   * behind". It is still worth showing in the Lab and in the settings sample, because it is the most
   * legible way to describe what the user is feeling.
   */
  droppedRatio: number
}

export function summarise(intervals: readonly number[], budgetMs: number): FrameStats {
  const clean = intervals.filter((value) => value > 0 && value < 1000)
  if (clean.length === 0) return { samples: 0, meanMs: 0, p50Ms: 0, p95Ms: 0, droppedRatio: 0 }
  const sorted = [...clean].sort((a, b) => a - b)
  const at = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!
  const mean = clean.reduce((total, value) => total + value, 0) / clean.length
  const dropped = clean.filter((value) => value > budgetMs * 1.5).length
  return {
    samples: clean.length,
    meanMs: mean,
    p50Ms: at(0.5),
    p95Ms: at(0.95),
    droppedRatio: dropped / clean.length,
  }
}

export type LoadGrade = 'unknown' | 'fine' | 'busy' | 'overloaded'

/**
 * How the machine is coping, relative to *its own* display budget.
 *
 * Read as "how much slower is the slow frame": `busy` starts at 1.6× the line and `overloaded` at 2×, where
 * the line is the display's period floored at 60 fps (see `loadLine`). On a 60 Hz panel that is 26.7 ms and
 * 33.3 ms, so the level comes down when the tail of the frame distribution takes a third of a second per
 * three frames — the machine is at or below 30 fps and a user can see it. On a fast panel the floor does
 * the work, because 60 fps is smooth enough for a particle field however quickly the panel refreshes.
 *
 * The old watchdog used a flat 22 ms, which fired at 45 fps on every display — stricter than this on a
 * 60 Hz screen and simultaneously blind on a 144 Hz one.
 */
export function gradeLoad(stats: FrameStats, budgetMs: number): LoadGrade {
  if (stats.samples < 30) return 'unknown'
  if (stats.p95Ms > loadLine(budgetMs, 2)) return 'overloaded'
  if (stats.p95Ms > loadLine(budgetMs, 1.6)) return 'busy'
  return 'fine'
}

/**
 * The floor under the load lines: 60 fps worth of frame cost.
 *
 * Without it the rule is "grade against the panel", which sounds right and is not: on a 165 Hz display the
 * 2× line is 12 ms, and a DOM application that renders at 60 fps — completely smooth, nothing wrong with
 * it, the compositor is just not filling 165 slots — reads as *overloaded* and loses a level. The first
 * packaged run caught exactly that: the level dropped mid-session and four unrelated visual checks went
 * red with it.
 *
 * So the lines are the panel's multiple, but never stricter than 60 fps (and, scaled by the same multiple,
 * never looser than a panel could follow): "smooth enough" is a fixed amount of time on screen, and a
 * fast panel does not make the application worse. The *drawing* cap still follows the panel — that is what
 * a 144 Hz display is for.
 */
const LOAD_FLOOR_MS = 1000 / 60

function loadLine(budgetMs: number, multiple: number): number {
  return Math.max(budgetMs * multiple, LOAD_FLOOR_MS * multiple)
}

export interface GuardConfig {
  /** How long the load may stay `overloaded` before a step down. */
  badMs: number
  /** How long it must stay `fine` before a step up. */
  goodMs: number
  /** Minimum spacing between any two level changes, so a machine on the boundary cannot oscillate. */
  cooldownMs: number
  /**
   * Nothing is judged before this much time has passed since the loop started.
   *
   * Launch is the one moment that is never a measurement of the machine: the renderer is parsing the
   * bundle, the theme is painting for the first time and the window is still settling. Judging from that is
   * how a laptop that was merely busy at start-up loses its effects for the whole session — and it is a
   * *policy*, so it lives here with the rest of the policy and is verified with a made-up clock rather than
   * by reading a constant out of a source file.
   */
  warmupMs: number
}

export const GUARD: GuardConfig = { badMs: 2500, goodMs: 30000, cooldownMs: 20000, warmupMs: 8000 }

export interface GuardState {
  /** When the current bad streak started, or 0. */
  badSince: number
  /** When the current clean streak started, or 0. */
  goodSince: number
  /** When the level last changed, or 0. */
  changedAt: number
}

export const INITIAL_GUARD: GuardState = { badSince: 0, goodSince: 0, changedAt: 0 }

export type GuardAction = 'hold' | 'down' | 'up'

/**
 * The decision, as a pure fold: state + this window's grade + the clock → state + action.
 *
 * `down` and `up` are *events* — the caller applies them once and hands the returned state back — so a
 * level change can never fire twice for one streak.
 */
export function guardStep(
  state: GuardState,
  grade: LoadGrade,
  now: number,
  config: GuardConfig = GUARD,
): { state: GuardState; action: GuardAction } {
  // `now` is milliseconds since the loop started, so the warm-up is a plain comparison. Streaks are cleared
  // rather than merely skipped: a slow launch must not contribute to the first decision either.
  if (now < config.warmupMs) return { state: { ...INITIAL_GUARD }, action: 'hold' }
  const cooling = state.changedAt > 0 && now - state.changedAt < config.cooldownMs
  const bad = grade === 'overloaded'
  const good = grade === 'fine'

  const badSince = bad ? state.badSince || now : 0
  const goodSince = good ? state.goodSince || now : 0
  const next: GuardState = { badSince, goodSince, changedAt: state.changedAt }

  if (cooling || grade === 'unknown' || grade === 'busy') return { state: next, action: 'hold' }
  if (bad && badSince > 0 && now - badSince >= config.badMs) {
    return { state: { badSince: 0, goodSince: 0, changedAt: now }, action: 'down' }
  }
  if (good && goodSince > 0 && now - goodSince >= config.goodMs) {
    return { state: { badSince: 0, goodSince: 0, changedAt: now }, action: 'up' }
  }
  return { state: next, action: 'hold' }
}

/**
 * How much of a level change has been applied, 0…1.
 *
 * A step down used to change the particle count and the pixel ratio in a single frame, which reads as a
 * glitch — "the whole field jumped" — rather than as an adaptation. The caller scales the *new* level's
 * density by this value and reaches full strength after `RAMP_MS`, so the field thins out over about two
 * thirds of a second and the eye follows it.
 */
export const RAMP_MS = 700

export function rampProgress(elapsedMs: number): number {
  if (elapsedMs <= 0) return 0
  if (elapsedMs >= RAMP_MS) return 1
  const t = elapsedMs / RAMP_MS
  // Smoothstep: no visible start, no visible stop.
  return t * t * (3 - 2 * t)
}

/** Human label for the current cap, used by the settings page and the lab. */
export function frameRateLabel(choice: FrameRateChoice, displayHz: number | null): string {
  if (choice === 'follow') return displayHz ? `跟随屏幕（${displayHz} Hz）` : '跟随屏幕'
  // Said out loud rather than silently ignored: a cap above the panel is a no-op, and a user who typed
  // 144 on a 60 Hz screen should learn that from the label instead of from a frame-rate readout.
  if (displayHz && choice > displayHz) return `${choice} FPS（屏幕 ${displayHz} Hz，按其上限）`
  return `${choice} FPS`
}
