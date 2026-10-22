/**
 * The sound-shaping vocabulary, shared by both processes.
 *
 * These values live here rather than in the renderer because **the main process validates them**:
 * settings arrive from the renderer as an untrusted patch, so main has to know how many EQ bands
 * there are and how far a gain may go, or it would have to accept an arbitrary array. One definition,
 * two consumers — the same reason `shared/quality.ts` exists.
 *
 * Everything is expressed in the units the audio graph actually uses: decibels for gain, seconds for
 * crossfade. No display strings here; those belong to the UI.
 */

/** Graphic-EQ bands. Ten is the classic octave-ish layout (31 Hz … 16 kHz). */
export const EQ_BAND_COUNT = 10

/** Centre frequency of each band, in Hz. Index-aligned with `equalizer.gains`. */
export const EQ_BAND_FREQUENCIES: readonly number[] = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]

/** How far a single band may be pushed, either way. Beyond ±12 dB a graphic EQ stops being a tone
 * control and starts being a distortion source on a laptop speaker. */
export const EQ_GAIN_LIMIT_DB = 12

/** Headroom trim applied before the filters, so boosting several bands at once does not clip. */
export const EQ_PREAMP_LIMIT_DB = 12

/** Longer than this and "crossfade" is really "play two songs at once". */
export const CROSSFADE_MAX_SECONDS = 12

/**
 * Loudness-normalisation targets, in dBFS of average level.
 *
 * The default (`-14`) is the streaming-industry reference. The others exist because the right target
 * is a taste: `-18` keeps dynamic classical intact, `-9` is for noisy rooms.
 */
export const LOUDNESS_TARGETS_DB: readonly number[] = [-9, -12, -14, -18]
export const DEFAULT_LOUDNESS_TARGET_DB = -14

/** How far loudness normalisation may lift or cut a track. A wider window starts changing the mix. */
export const LOUDNESS_GAIN_LIMIT_DB = 12

export interface EqualizerSettings {
  /** Off means the bands are bypassed entirely (not set to 0) — see the engine's bypass note. */
  enabled: boolean
  /** Preset id, or `custom` once a band has been moved by hand. */
  preset: string
  /** One gain in dB per band; always `EQ_BAND_COUNT` long. */
  gains: number[]
  /** Output trim in dB, applied after the filters. */
  preampDb: number
}

export interface LoudnessSettings {
  enabled: boolean
  /** Target average level in dBFS; one of `LOUDNESS_TARGETS_DB`. */
  targetDb: number
}

export interface SoundSettings {
  equalizer: EqualizerSettings
  loudness: LoudnessSettings
  /** `deviceId` from `enumerateDevices()`; empty string means the system default output. */
  outputDeviceId: string
  /**
   * Gapless: the next track is prepared in the idle deck and started the moment this one ends, so a
   * live album or a continuous mix does not get a hole between tracks.
   */
  gapless: boolean
  /** Overlap in seconds between the outgoing and incoming track. 0 is off (plain gapless). */
  crossfadeSeconds: number
}

/** A flat 10-band response: the state a fresh install and 「重置」 both land in. */
export const FLAT_EQ_GAINS: number[] = Array.from({ length: EQ_BAND_COUNT }, () => 0)

export const DEFAULT_SOUND: SoundSettings = {
  equalizer: { enabled: false, preset: 'flat', gains: [...FLAT_EQ_GAINS], preampDb: 0 },
  loudness: { enabled: false, targetDb: DEFAULT_LOUDNESS_TARGET_DB },
  outputDeviceId: '',
  gapless: true,
  crossfadeSeconds: 0,
}

/** Clamps one gain to the legal window, mapping anything non-finite to `0` (flat). */
export function clampGainDb(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return 0
  return Math.round(Math.min(Math.max(parsed, -EQ_GAIN_LIMIT_DB), EQ_GAIN_LIMIT_DB) * 10) / 10
}

/**
 * Normalises a whole gain array: right length, legal values.
 *
 * A short or long array from a hand-edited settings file is padded/truncated rather than rejected —
 * the alternative is a band that silently does not exist and a UI whose slider count disagrees with
 * the engine's filter count.
 */
export function normalizeEqGains(value: unknown, fallback: readonly number[] = FLAT_EQ_GAINS): number[] {
  const source = Array.isArray(value) ? value : fallback
  return Array.from({ length: EQ_BAND_COUNT }, (_, index) => clampGainDb(source[index] ?? 0))
}

export function clampPreampDb(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return 0
  return Math.round(Math.min(Math.max(parsed, -EQ_PREAMP_LIMIT_DB), EQ_PREAMP_LIMIT_DB) * 10) / 10
}

export function clampCrossfadeSeconds(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return 0
  return Math.round(Math.min(Math.max(parsed, 0), CROSSFADE_MAX_SECONDS) * 10) / 10
}

export function isLoudnessTarget(value: unknown): value is number {
  return typeof value === 'number' && LOUDNESS_TARGETS_DB.includes(value)
}

/** True when the EQ is doing nothing: disabled, flat, and no trim. Used by the UI to say so. */
export function isEqEffectivelyOff(equalizer: EqualizerSettings): boolean {
  return !equalizer.enabled || (equalizer.preampDb === 0 && equalizer.gains.every((gain) => gain === 0))
}

/** A preset id: what the renderer may store, and what main will accept. */
export const PRESET_ID_PATTERN = /^[a-z][a-z0-9_-]{0,23}$/

/**
 * Name for a loudness target. Named by what it *sounds* like rather than by its number: `-14 dBFS` is
 * accurate and tells a listener nothing, and this label is the only thing most people will read.
 */
export function loudnessTargetLabel(targetDb: number): string {
  switch (targetDb) {
    case -9:
      return '响亮（嘈杂环境）'
    case -12:
      return '偏响'
    case -18:
      return '保留动态'
    default:
      return '标准'
  }
}

/** `关闭` / `6 秒` — the crossfade slider's own readout. */
export function formatCrossfade(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '关闭'
  const rounded = Math.round(seconds * 10) / 10
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} 秒`
}
