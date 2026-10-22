/**
 * The equalizer's *model* — bands, presets, and the little arithmetic the UI needs — with no Web Audio
 * in sight. The engine turns this into filters; the settings page turns it into sliders; both read the
 * same table, so a preset can never mean one thing in the graph and another on screen.
 *
 * Gains are in dB and index-aligned with `EQ_BAND_FREQUENCIES` (31 Hz → 16 kHz).
 */
import { EQ_BAND_FREQUENCIES, FLAT_EQ_GAINS, clampGainDb } from '../../../shared/sound'

export interface EqPreset {
  id: string
  label: string
  /** One line of why anyone would pick it. Shown under the preset row, not in a tooltip. */
  hint: string
  gains: number[]
}

/**
 * Curves, not magic numbers: each one is the shape its name promises, expressed against the 10 bands.
 * 31 Hz … 16 kHz, left to right.
 */
export const EQ_PRESETS: EqPreset[] = [
  { id: 'flat', label: '平直', hint: '不动任何频段，用来对照', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { id: 'pop', label: '流行', hint: '中频前移，人声更靠前', gains: [-1, 1, 3, 4, 2, 0, -1, -1, 0, 1] },
  { id: 'rock', label: '摇滚', hint: '两端抬起，鼓和镲更清楚', gains: [4, 3, 1, -1, -2, 0, 2, 3, 4, 4] },
  { id: 'jazz', label: '爵士', hint: '低频温、高频细，中间不抢', gains: [3, 2, 1, 1, -1, -1, 0, 1, 2, 3] },
  { id: 'classical', label: '古典', hint: '尽量平直，只补一点现场感', gains: [2, 1, 0, 0, 0, 0, -1, -1, 1, 2] },
  { id: 'vocal', label: '人声', hint: '压低伴奏，突出 1–3 kHz', gains: [-3, -2, 0, 2, 4, 4, 3, 1, 0, -1] },
  { id: 'bass', label: '低音增强', hint: '给低频加量，中高频保持干净', gains: [7, 6, 4, 2, 0, -1, -2, -1, 0, 0] },
  { id: 'electronic', label: '电子', hint: '低频结实、高频亮，适合合成器', gains: [5, 4, 2, 0, -1, 0, 1, 3, 4, 5] },
  { id: 'night', label: '夜间', hint: '低音量下也能听清，避开刺耳段', gains: [2, 3, 3, 2, 1, 0, -2, -3, -3, -2] },
]

/** How close a curve has to be to a preset to be called that preset. */
const PRESET_TOLERANCE_DB = 0.15

export function presetById(id: string): EqPreset {
  return EQ_PRESETS.find((preset) => preset.id === id) ?? EQ_PRESETS[0]
}

/**
 * Which preset a set of gains *is*, or `custom`.
 *
 * The UI needs this when the user moves a slider: the curve stops being "流行" the moment a band is
 * off the preset by more than a rounding error, and pretending otherwise would show a preset name for
 * a curve the user is no longer hearing. Tolerance is intentionally tiny — 0.15 dB is below what a
 * slider can even address, so this is "did the user touch it", not "is it close enough".
 */
export function presetIdForGains(gains: readonly number[]): string {
  for (const preset of EQ_PRESETS) {
    if (preset.gains.every((gain, index) => Math.abs(gain - (gains[index] ?? 0)) <= PRESET_TOLERANCE_DB)) return preset.id
  }
  return 'custom'
}

/** Preset gains as a fresh, legal array — never a reference to the table. */
export function gainsForPreset(id: string): number[] {
  return presetById(id).gains.map((gain) => clampGainDb(gain))
}

export const CUSTOM_PRESET_LABEL = '自定义'

export function presetLabel(id: string): string {
  return id === 'custom' ? CUSTOM_PRESET_LABEL : presetById(id).label
}

/** Band label for a slider: `31 Hz`, `1 kHz`, `16 kHz`. */
export function bandLabel(index: number): string {
  const frequency = EQ_BAND_FREQUENCIES[index] ?? 0
  return frequency >= 1000 ? `${Math.round(frequency / 1000)} kHz` : `${frequency} Hz`
}

/**
 * The EQ's own summary line, for the settings page.
 *
 * It describes the *state* rather than the preset name, because those two questions are different:
 * "低音增强 +6 dB" is what the listener hears, "低音增强" is only where it started.
 */
export function describeEqualizer(equalizer: {
  enabled: boolean
  preset: string
  gains: readonly number[]
  preampDb: number
}): string {
  if (!equalizer.enabled) return '关闭中：音频不经过任何滤波'
  const gains = equalizer.gains.length > 0 ? equalizer.gains : FLAT_EQ_GAINS
  const flat = gains.every((gain) => gain === 0)
  const parts = [flat ? `${presetLabel(equalizer.preset)}（各段 0 dB）` : presetLabel(equalizer.preset)]
  const peak = gains.reduce((best, gain) => (Math.abs(gain) > Math.abs(best) ? gain : best), 0)
  if (!flat) parts.push(`最大调整 ${peak > 0 ? '+' : ''}${peak} dB`)
  if (equalizer.preampDb !== 0) parts.push(`前级 ${equalizer.preampDb > 0 ? '+' : ''}${equalizer.preampDb} dB`)
  return parts.join(' · ')
}

/**
 * Suggested preamp to keep a boosted curve from clipping: the *inverse* of the largest boost.
 *
 * Only a suggestion — the user sees it as a button, never as an automatic change. Automatically
 * attenuating someone's output because they moved a slider is the kind of "helpful" that makes people
 * distrust a settings page.
 */
export function suggestedPreampDb(gains: readonly number[]): number {
  const peak = (gains.length > 0 ? gains : FLAT_EQ_GAINS).reduce((best, gain) => (gain > best ? gain : best), 0)
  return peak > 0 ? -peak : 0
}
