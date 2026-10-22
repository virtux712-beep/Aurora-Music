/**
 * The lyric sheet's scroll engine.
 *
 * Why this is its own module rather than ten lines inside the viewport: it is the only part of the lyric page
 * with real arithmetic in it, and it was wrong in a way that is invisible in the code but obvious on screen.
 *
 * The bug, measured on the live page before this file existed:
 *
 *   容器 `.lyrics-scroll` → clientHeight 648（可见）／scrollHeight 2010（全部歌词）
 *   `.lyrics-viewport`    → clientHeight 2010（等于内容高度，因为它是 min-height: 100%）
 *
 * The old code measured `target.offsetTop - viewport.clientHeight / 2 + …` against `.lyrics-viewport`, i.e.
 * against a box as tall as the whole song. The target therefore came out *negative* for every line, was clamped
 * by `Math.max(0, …)`, and the sheet stayed at `scrollTop: 0` for the entire track — a lyric page that never
 * moves. Both halves of that are avoided below: the container is *found* rather than named, and the target is
 * measured from live rectangles rather than `offsetTop` (which is relative to the nearest *positioned*
 * ancestor, so it silently produces a plausible wrong number the moment a wrapper gains `position: relative`).
 *
 * The glide is a frame loop instead of `scrollTo({ behavior: 'smooth' })`, for three reasons that all show up
 * in normal use:
 *   - a native smooth scroll has a fixed ~300 ms duration, so two line changes in quick succession fight each
 *     other and the sheet visibly stutters; an exponential approach retargets mid-flight with no seam;
 *   - the sung line *grows* (`.lyric-line.active` is a larger font), so the position it should sit at moves as
 *     it activates — recomputing the target every frame absorbs that reflow instead of chasing it;
 *   - the frame loop can be released the moment it settles, so a paused player costs nothing.
 */

/** How long a manual scroll pauses the follow before it takes over again. */
export const FOLLOW_RESUME_MS = 2600

/** Exponential approach constant: smaller is snappier, larger is smoother. ~135 ms reads as "gliding". */
const GLIDE_TAU_MS = 135

/** A jump longer than this many viewport heights is a seek, not a line change — it lands instead of sliding. */
const GLIDE_SNAP_RATIO = 1.6

/** Sub-pixel distance at which the glide is considered arrived. */
const GLIDE_SETTLE_PX = 0.5

/**
 * How long a glide may stay unfinished before it is landed without animation.
 *
 * This exists because `requestAnimationFrame` is *throttled* — not merely slowed — when the window is occluded or
 * minimised, and a lyric sheet that only moves while you are looking at it is not a feature. Measured: with the
 * window hidden, the frame loop stopped mid-glide and the sheet sat 46 px short of the line and then never moved
 * again, while a second rAF-driven effect (the per-word karaoke fill) froze in exactly the same run. A normal
 * glide is over in ~400 ms, so anything still moving at 700 ms only got there because frames stopped arriving;
 * landing it is the correct outcome — nobody is watching the animation, and the sheet should be right when they
 * look back.
 */
const GLIDE_FALLBACK_MS = 700

/**
 * Longest frame delta we integrate, so a stalled tab does not translate into a leap.
 *
 * It has to be generous, because it is *also* the frame rate floor: the approach is exponential in the elapsed
 * time, so clamping a 200 ms frame to 48 ms multiplies τ by four and the glide takes ~3 s instead of ~0.7 s on a
 * machine that is merely busy. The clamp is there to stop a hidden-tab stall from teleporting the sheet, and
 * 250 ms already does that — at that delta the sheet covers 84% of the gap, which is motion, not a jump.
 */
const MAX_FRAME_MS = 250

/**
 * The element that actually scrolls the sheet.
 *
 * Walked up from the list rather than assumed: the page has changed shape twice (the scroll container used to
 * be the viewport itself), and hard-coding `.lyrics-scroll` is how a future restructure silently disables the
 * follow again. `overflow-y: auto|scroll` is the browser's own answer to "who scrolls here".
 */
export function findScroller(from: Element | null): HTMLElement | null {
  let node: Element | null = from?.parentElement ?? null
  while (node && node !== document.body) {
    const overflow = getComputedStyle(node).overflowY
    if (overflow === 'auto' || overflow === 'scroll') return node as HTMLElement
    node = node.parentElement
  }
  return null
}

/**
 * The offset that puts `line` on the container's optical centre.
 *
 * Clamped to the scrollable range, so the first and last lines are not requested beyond the end of the sheet
 * (an out-of-range `scrollTop` is silently truncated by the browser, which would leave the glide integrating
 * toward a position it can never reach and never settle).
 */
export function centreOffset(container: HTMLElement, line: HTMLElement): number {
  const containerRect = container.getBoundingClientRect()
  const lineRect = line.getBoundingClientRect()
  const raw =
    container.scrollTop + (lineRect.top - containerRect.top) - (container.clientHeight - lineRect.height) / 2
  const max = Math.max(0, container.scrollHeight - container.clientHeight)
  return Math.min(Math.max(0, raw), max)
}

/**
 * Drives the sheet toward the sung line.
 *
 * One instance per viewport. It owns the fractional offset (because `scrollTop` is stored as a whole number,
 * and rounding every frame is what turns a glide into a staircase), and nothing else: *when* to glide is the
 * component's business, *how* is this one's.
 */
export class LyricScroller {
  private container: HTMLElement | null = null
  private frame = 0
  private fallback: ReturnType<typeof setTimeout> | null = null
  private lastAt = 0
  private offset = 0

  constructor(private readonly line: () => HTMLElement | null) {}

  /** Resolves the scrolling box, re-resolving it if the page has been re-rendered around it. */
  attach(from: Element | null): HTMLElement | null {
    if (!this.container || !this.container.isConnected) this.container = findScroller(from)
    return this.container
  }

  /** Lands on the sung line without animating — a different song's lyrics, or the first paint. */
  jump(from: Element | null): void {
    this.stop()
    this.land(from)
  }

  /** Writes the centred offset in one go, with no animation and no frame loop. */
  private land(from: Element | null): void {
    const container = this.attach(from)
    const line = this.line()
    if (!container || !line) return
    this.offset = centreOffset(container, line)
    container.scrollTop = this.offset
  }

  /** Glides toward the sung line; safe to call on every line change. */
  follow(from: Element | null): void {
    const container = this.attach(from)
    if (!container || !this.line()) return
    // Reduced motion, or a sheet with nothing to scroll: the correct glide is no glide.
    if (prefersReducedMotion() || container.scrollHeight <= container.clientHeight) {
      this.jump(from)
      return
    }
    // Not looping means every offset change since the last frame came from outside (a hand scroll, a jump),
    // so adopt where the sheet actually is before easing away from there.
    if (!this.frame) this.offset = container.scrollTop
    if (this.frame) return
    this.lastAt = performance.now()
    this.frame = requestAnimationFrame(this.step)
    // The safety net: if frames stop arriving, this is what puts the sheet where it belongs anyway.
    this.armFallback(from)
  }

  private armFallback(from: Element | null): void {
    if (this.fallback) clearTimeout(this.fallback)
    this.fallback = setTimeout(() => {
      this.fallback = null
      if (this.frame) cancelAnimationFrame(this.frame)
      this.frame = 0
      this.land(from)
    }, GLIDE_FALLBACK_MS)
  }

  /** Releases the frame loop. The offset stays valid, so a later `follow` eases from where this stopped. */
  stop(): void {
    if (this.frame) cancelAnimationFrame(this.frame)
    if (this.fallback) clearTimeout(this.fallback)
    this.frame = 0
    this.fallback = null
  }

  private step = (now: number): void => {
    this.frame = 0
    const container = this.container
    const line = this.line()
    if (!container || !container.isConnected || !line) return
    const target = centreOffset(container, line)
    if (Math.abs(target - this.offset) > GLIDE_SNAP_RATIO * container.clientHeight) {
      this.offset = target
      container.scrollTop = target
      this.clearFallback()
      return
    }
    const elapsed = Math.min(MAX_FRAME_MS, Math.max(1, now - this.lastAt))
    this.lastAt = now
    this.offset += (target - this.offset) * (1 - Math.exp(-elapsed / GLIDE_TAU_MS))
    if (Math.abs(target - this.offset) <= GLIDE_SETTLE_PX) {
      this.offset = target
      container.scrollTop = target
      this.clearFallback()
      return
    }
    container.scrollTop = this.offset
    this.frame = requestAnimationFrame(this.step)
  }

  private clearFallback(): void {
    if (this.fallback) clearTimeout(this.fallback)
    this.fallback = null
  }
}

function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}
