/**
 * Loudness normalisation (the ReplayGain idea), as maths.
 *
 * There is a real tension here and it decides the whole design: **measured** gain needs the audio to
 * have played for a few seconds, while a *tag* needs the file to carry one. Aurora does both, in that
 * order of preference:
 *
 *  1. a `REPLAYGAIN_TRACK_GAIN` tag on a local file — exact, available before a single sample is heard;
 *  2. otherwise, a measurement of the first few seconds of real playback, cached per track so the
 *     second listen starts at the right level instead of ramping into it.
 *
 * Nothing here fakes a number: an unmeasurable track (silence, a live stream, a track skipped early)
 * simply keeps its measured value at `null`, and the engine leaves the gain at 0 dB.
 */
import { LOUDNESS_GAIN_LIMIT_DB } from '../../../shared/sound'

/** Below this the "measurement" is just silence plus noise floor; the gain is left alone. */
export const SILENCE_FLOOR_DB = -70

/** A quiet-but-real signal still needs a sane ceiling on the *reported* level. */
const REPORT_FLOOR_DB = -60

/**
 * RMS of a time-domain frame, in dBFS.
 *
 * `samples` is a `Float32Array` from `AnalyserNode.getFloatTimeDomainData` — values in -1..1.
 *
 * RMS rather than peak on purpose: peak-driven normalisation is what makes a quiet passage sound
 * identical to a loud one, which is the opposite of the point. RMS is the crude but honest proxy for
 * perceived level, and it is what this uses until a real EBU R128 loudness meter is worth its weight.
 */
export function rmsDb(samples: Float32Array): number {
  if (samples.length === 0) return SILENCE_FLOOR_DB
  let sum = 0
  for (let index = 0; index < samples.length; index += 1) {
    const value = samples[index] ?? 0
    sum += value * value
  }
  const rms = Math.sqrt(sum / samples.length)
  if (!Number.isFinite(rms) || rms <= 0) return SILENCE_FLOOR_DB
  return Math.max(SILENCE_FLOOR_DB, 20 * Math.log10(rms))
}

/**
 * Average of several RMS readings, in dB, without pretending decibels are linear.
 *
 * Averaging dB numbers directly over-weights the quiet frames (a -60 dB frame pulls the mean down as
 * hard as a -6 dB one pulls it up), so the mean is taken in the power domain and converted back.
 */
export function meanDb(readings: readonly number[]): number {
  const real = readings.filter((value) => Number.isFinite(value) && value > SILENCE_FLOOR_DB)
  if (real.length === 0) return SILENCE_FLOOR_DB
  const meanPower = real.reduce((sum, db) => sum + 10 ** (db / 10), 0) / real.length
  return 10 * Math.log10(meanPower)
}

/**
 * The gain to apply, in dB: how far the measured level sits from the target, clamped.
 *
 * `null` means "no opinion" — silence, or too little audio to measure — and the caller must treat that
 * as *no change* rather than as 0 dB of "normalisation applied".
 */
export function gainDbFor(measuredDb: number | null, targetDb: number): number | null {
  if (measuredDb === null || !Number.isFinite(measuredDb)) return null
  if (measuredDb <= SILENCE_FLOOR_DB) return null
  const wanted = targetDb - measuredDb
  if (!Number.isFinite(wanted)) return null
  return Math.min(Math.max(wanted, -LOUDNESS_GAIN_LIMIT_DB), LOUDNESS_GAIN_LIMIT_DB)
}

/** dB → linear amplitude, for a `GainNode`. */
export function dbToGain(db: number): number {
  return 10 ** (db / 20)
}

/** Guard for the UI: is this a measurement we would actually act on? */
export function isUsableMeasurement(measuredDb: number | null): measuredDb is number {
  return measuredDb !== null && Number.isFinite(measuredDb) && measuredDb > SILENCE_FLOOR_DB
}

/**
 * A one-pole ramp toward the target, used when the measured gain arrives mid-track: jumping the gain
 * is audible as a click (and reads as "the volume knob moved by itself"), so the correction is spread
 * over a couple of seconds. `factor` is the per-tick share of the remaining distance.
 */
export function smoothToward(current: number, target: number, factor: number): number {
  const clamped = Math.min(Math.max(factor, 0), 1)
  const next = current + (target - current) * clamped
  return Math.abs(next - target) < 0.01 ? target : next
}

/** What `--music-*`/UI needs to explain the current state; `null` gain means "not measured yet". */
export interface LoudnessState {
  enabled: boolean
  targetDb: number
  /** Gain actually applied to the current deck, in dB. */
  appliedDb: number
  /** Measurement behind that gain, or `null` when nothing usable has been heard yet. */
  measuredDb: number | null
  /** Where the number came from — a tag beats a measurement for the UI's explanation. */
  source: 'tag' | 'measured' | 'none'
}

export function describeLoudness(state: LoudnessState): string {
  if (!state.enabled) return '关闭中：按文件原样播放'
  if (state.source === 'none') return `目标 ${state.targetDb} dB · 还没测到可用的响度`
  const sign = state.appliedDb > 0 ? '+' : ''
  const origin = state.source === 'tag' ? '文件标签' : '实测'
  return `目标 ${state.targetDb} dB · ${origin} ${state.measuredDb?.toFixed(1)} dB → ${sign}${state.appliedDb.toFixed(1)} dB`
}

/**
 * The per-track measurement cache.
 *
 * Kept in `localStorage` rather than in the library index because it is a *listening* fact, not a file
 * fact: the same file measured on this machine's output chain is the number this machine wants, and a
 * shared library file is not the place for it. Keyed by track id, and the whole map is small enough
 * (one float per track) that trimming it is unnecessary; it is still bounded to keep a huge library
 * from growing it without limit.
 */
const MEASURE_KEY = 'aurora:loudness'
const MEASURE_LIMIT = 4000

type MeasurementMap = Record<string, number>

let cache: MeasurementMap | null = null
let writes = 0

function load(): MeasurementMap {
  if (cache) return cache
  try {
    const raw = localStorage.getItem(MEASURE_KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : null
    if (parsed && typeof parsed === 'object') {
      const next: MeasurementMap = {}
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === 'number' && Number.isFinite(value)) next[key] = value
      }
      cache = next
      return next
    }
  } catch {
    // A corrupt cache is not worth an error: it is re-measured on the next play.
  }
  cache = {}
  return cache
}

export function cachedMeasurement(trackId: string): number | null {
  const value = load()[trackId]
  return typeof value === 'number' ? value : null
}

export function rememberMeasurement(trackId: string, measuredDb: number): void {
  if (!trackId || !Number.isFinite(measuredDb) || measuredDb <= SILENCE_FLOOR_DB) return
  const map = load()
  map[trackId] = Math.round(measuredDb * 10) / 10
  const keys = Object.keys(map)
  if (keys.length > MEASURE_LIMIT) {
    for (const key of keys.slice(0, keys.length - MEASURE_LIMIT)) delete map[key]
  }
  // Written in batches: a measurement per track, at most a few per minute, but a crash-loop while
  // measuring should not be able to hammer storage.
  writes += 1
  if (writes % 5 !== 0) return
  try {
    localStorage.setItem(MEASURE_KEY, JSON.stringify(map))
  } catch {
    // Ignore storage failures (private mode, quota); the in-memory map still helps this session.
  }
}

/** Used by tests and by 「重置」 on the settings page. */
export function clearMeasurements(): void {
  cache = {}
  writes = 0
  try {
    localStorage.removeItem(MEASURE_KEY)
  } catch {
    // Ignore.
  }
}

export { REPORT_FLOOR_DB }
