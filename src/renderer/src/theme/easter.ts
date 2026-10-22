/*
 * The hidden layer: Aurora's easter eggs and the listening record.
 *
 * Kept as pure functions for the reason the rest of `theme/` is: the interesting part is a *rule* ("five
 * tracks in a row", "after ten at night", "rarely, and never twice in a minute") and a rule can be tested
 * offline against a made-up clock instead of by hoping the test machine's time is late enough. The store
 * decides *when* to ask; this module decides *what* is true.
 *
 * Everything here is deliberately small and quiet. An easter egg that announces itself with confetti is not
 * an easter egg, it is a popup: the night aurora is a slightly different glow, the rainy window is a
 * slightly warmer light, and Signal Lost is half a second of static that most people will never see.
 */

/** How many tracks in a row unlock the night aurora. */
export const NIGHT_STREAK = 5
/** After this hour (and before `NIGHT_END_HOUR`) the rainy window opens. */
export const NIGHT_START_HOUR = 22
export const NIGHT_END_HOUR = 4
/**
 * Chance of Signal Lost per track change.
 *
 * 0.4 %: about one in 250 songs. Rare enough to be a story, common enough that a daily listener meets it
 * within a year — which is the difference between an easter egg and dead code.
 */
export const SIGNAL_LOST_CHANCE = 0.004
/** How long the static lasts. Short on purpose: it must read as a glitch, not as a crash. */
export const SIGNAL_LOST_MS = 520
/** At least this long between two activations, so three fast skips cannot stack the effect. */
export const SIGNAL_LOST_COOLDOWN_MS = 90_000

export interface CompanionRecord {
  /** Tracks actually started, not tracks in the library. */
  plays: number
  /** Wall-clock seconds spent with music playing. */
  seconds: number
  /** ISO date (`YYYY-MM-DD`) of the first play, kept forever. */
  firstPlayedAt: string
  /** When the night aurora was first unlocked, or `''`. */
  nightUnlockedAt: string
}

export const EMPTY_COMPANION: CompanionRecord = { plays: 0, seconds: 0, firstPlayedAt: '', nightUnlockedAt: '' }

/** The local calendar date, as the record stores it. Local, because "the first day I used this" is local. */
export function dateKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/**
 * Reads a stored record, tolerating anything.
 *
 * A record that came from an older build, a hand-edited storage, or a half-written JSON is not a reason to
 * lose the user's history: every field falls back individually, so a broken `seconds` does not also throw
 * away `firstPlayedAt`.
 */
export function parseCompanion(raw: unknown): CompanionRecord {
  let value: unknown = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw)
    } catch {
      return { ...EMPTY_COMPANION }
    }
  }
  if (!value || typeof value !== 'object') return { ...EMPTY_COMPANION }
  const record = value as Partial<CompanionRecord>
  const count = (input: unknown): number => (typeof input === 'number' && Number.isFinite(input) && input > 0 ? Math.floor(input) : 0)
  const text = (input: unknown): string => (typeof input === 'string' && /^\d{4}-\d{2}-\d{2}/.test(input) ? input : '')
  return {
    plays: count(record.plays),
    seconds: count(record.seconds),
    firstPlayedAt: text(record.firstPlayedAt),
    nightUnlockedAt: text(record.nightUnlockedAt),
  }
}

/** One more track. The first play is remembered once and never moved. */
export function recordPlay(record: CompanionRecord, date: Date): CompanionRecord {
  return { ...record, plays: record.plays + 1, firstPlayedAt: record.firstPlayedAt || dateKey(date) }
}

/** Listening seconds. Whole seconds only, and never negative. */
export function recordListening(record: CompanionRecord, seconds: number): CompanionRecord {
  if (!Number.isFinite(seconds) || seconds <= 0) return record
  return { ...record, seconds: record.seconds + Math.floor(seconds) }
}

/** Whether the clock is in the night window. `22:00`–`03:59`, because 4 a.m. is still the same night. */
export function isNightHour(date: Date): boolean {
  const hour = date.getHours()
  return hour >= NIGHT_START_HOUR || hour < NIGHT_END_HOUR
}

/**
 * The streak of tracks in a row.
 *
 * Counts *changes*: the first track starts it at one, and every subsequent change adds one. Nothing resets
 * it — the streak's only purpose is the five-track unlock, and resetting it on a pause or a skip would make
 * "listen to five songs" into a chore about how you listened to them.
 */
export function nextStreak(streak: number, changed: boolean): number {
  if (!changed) return Math.max(1, streak)
  return Math.max(1, Math.floor(streak) + 1)
}

export interface EasterAura {
  /** The night aurora, once unlocked in this session and remembered across launches. */
  night: boolean
  /** The rainy-window light. Session-only: it is a moment, not a badge. */
  window: boolean
  /** Whether this change should glitch. */
  signalLost: boolean
}

/**
 * What is true right now, given the streak, the clock, and a source of randomness.
 *
 * `random` is a parameter rather than `Math.random()` inside so the decision is testable: the suite asserts
 * that 0.4 %-per-change means "rare", and that the same change never glitches twice.
 */
export function easterAura(options: {
  streak: number
  now: Date
  random: () => number
  /** Suppresses the glitch when it fired recently, and in the first seconds after launch. */
  lastSignalLostAt?: number
  nowMs?: number
}): EasterAura {
  const { streak, now, random, lastSignalLostAt = 0, nowMs = 0 } = options
  const cooled = nowMs === 0 || nowMs - lastSignalLostAt >= SIGNAL_LOST_COOLDOWN_MS
  return {
    night: streak >= NIGHT_STREAK,
    window: isNightHour(now),
    signalLost: cooled && random() < SIGNAL_LOST_CHANCE,
  }
}

/** `1830` → `30 小时 30 分`. Used by the settings card, so the number reads as a memory, not a metric. */
export function formatCompanionTime(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.floor(seconds))} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分`
}
