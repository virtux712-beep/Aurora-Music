/**
 * How the sung lyric line is inked.
 *
 * Kept out of the stores because it is *data*, and because the two things that decide whether a stored
 * value may be painted — the mode whitelist and the colour whitelist — have to be testable without a
 * window, a store or a renderer. The store applies the mode as `data-lyric-color`; `app.css` owns what
 * each mode looks like, so a picker swatch and a painted lyric can never disagree.
 */
export type LyricColorMode = 'auto' | 'white' | 'warm' | 'tint' | 'custom'

export const LYRIC_COLOR_MODES: LyricColorMode[] = ['auto', 'white', 'warm', 'tint', 'custom']

/** Short enough for a menu row; the hint is what tells the user when to pick it. */
export const LYRIC_COLOR_OPTIONS: { mode: LyricColorMode; label: string; hint: string }[] = [
  { mode: 'auto', label: '自动', hint: '跟随当前主题的强调色' },
  { mode: 'white', label: '白色', hint: '纯白，对比度最高' },
  { mode: 'warm', label: '暖白', hint: '偏暖，长时间阅读更柔和' },
  { mode: 'tint', label: '主题色', hint: '直接用主题强调色' },
  { mode: 'custom', label: '自定义', hint: '自己挑一个颜色' },
]

export function isLyricColorMode(value: unknown): value is LyricColorMode {
  return LYRIC_COLOR_MODES.includes(value as LyricColorMode)
}

/**
 * A colour the stylesheet can actually consume.
 *
 * The value reaches an inline custom property, so it is whitelisted to a hex literal rather than
 * trusted: a stored string like `red; background: url(…)` would otherwise be a stylesheet injection
 * through what looks like a colour picker. Three- and six-digit hex only — nothing else is a colour
 * this code ever produces, so accepting more would only widen the door.
 */
export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)
}
