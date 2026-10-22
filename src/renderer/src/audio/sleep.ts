/**
 * The sleep timer, as arithmetic.
 *
 * Two modes, and they are genuinely different promises:
 *
 *  - **`minutes`** — "stop at 23:40", regardless of what is playing. The deadline is an absolute
 *    timestamp, so pausing, seeking and skipping all leave it alone. That is what people mean when they
 *    set a timer on their way to sleep.
 *  - **`track`** — "let this song finish, then stop". It has no deadline at all; the player pauses when
 *    the current track ends instead of advancing. Anything that makes the countdown arbitrary (a live
 *    stream, a track whose length is unknown) still works, because there is no countdown.
 *
 * Kept pure so the interesting cases — a deadline that already passed, a paused player whose timer must
 * *not* keep running down toward silence, a countdown crossing the hour — are testable without a player.
 */

export type SleepMode = 'off' | 'minutes' | 'track'

export interface SleepState {
  mode: SleepMode
  /** Absolute deadline in `Date.now()` terms; only meaningful for `minutes`. */
  deadline: number
  /** The minutes the user picked, for redisplaying the menu's active row. */
  minutes: number
}

export const SLEEP_OFF: SleepState = { mode: 'off', deadline: 0, minutes: 0 }

/** The presets offered in the player bar. 45 exists because "one more episode" is usually 40-odd minutes. */
export const SLEEP_PRESETS_MINUTES: readonly number[] = [15, 30, 45, 60, 90]

export function startSleepMinutes(minutes: number, now: number = Date.now()): SleepState {
  const safe = Math.max(1, Math.min(600, Math.round(minutes)))
  return { mode: 'minutes', deadline: now + safe * 60_000, minutes: safe }
}

/** `null` when nothing is running, otherwise milliseconds left (never negative). */
export function remainingMs(state: SleepState, now: number = Date.now()): number | null {
  if (state.mode !== 'minutes') return null
  return Math.max(0, state.deadline - now)
}

export function isExpired(state: SleepState, now: number = Date.now()): boolean {
  return state.mode === 'minutes' && state.deadline > 0 && now >= state.deadline
}

/**
 * `14:32`, or `1:05:00` past the hour. A countdown that switches units is what makes it readable at a
 * glance — nobody wants to do the arithmetic on `3900`.
 */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/** What the player-bar button says: a countdown, 「本曲结束后」, or nothing at all. */
export function sleepLabel(state: SleepState, now: number = Date.now()): string {
  if (state.mode === 'track') return '本曲结束后'
  if (state.mode === 'minutes') {
    const left = remainingMs(state, now)
    return left === null ? '' : formatCountdown(left)
  }
  return ''
}

/** The toast/notification line, so the same sentence is used wherever it is announced. */
export function describeSleep(state: SleepState): string {
  if (state.mode === 'track') return '睡眠定时：当前歌曲播完后停止'
  if (state.mode === 'minutes') return `睡眠定时：${state.minutes} 分钟后停止`
  return '睡眠定时已关闭'
}

/**
 * Should the player pause *instead of* advancing, now that the current track ended?
 *
 * Only in `track` mode. In `minutes` mode the answer is always "keep going" — the deadline is what
 * stops playback, and a track that ends before it should roll into the next one like normal.
 */
export function shouldStopAtTrackEnd(state: SleepState): boolean {
  return state.mode === 'track'
}
