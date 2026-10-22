/*
 * The contract between a theme definition and the code that renders it.
 *
 * A theme is *data*, never code: a name, a small palette, and a handful of effect parameters. Both
 * the five built-in skins and any theme a user drops into their themes folder go through the same
 * `parseThemeDefinition`, so a user theme cannot do anything a built-in one cannot — and, just as
 * importantly, cannot do anything a built-in one *can* beyond declaring colours.
 *
 * Colours end up inside a `<style>` element, which is why validation is strict rather than
 * permissive: a token value that can close a declaration or open a `url()` is a CSS injection, and
 * "the theme just looks wrong" must never be the *good* outcome of a bad file.
 */

/** Particles a skin asks the ambient layer to draw. `none` renders nothing at all. */
export type ParticleKind = 'stars' | 'leaves' | 'mist' | 'rain' | 'dust' | 'none'
/** The shell background's recipe: which painted atmosphere sits behind every page. */
export type BackgroundKind = 'nebula' | 'paper' | 'tide' | 'wash' | 'sunset' | 'plain'
/** The immersive page's backdrop stack — the \"room\" the theme builds around a cover. */
export type ImmersiveKind = 'nebula' | 'window' | 'water' | 'ink' | 'film' | 'plain'
/** How the active lyric line arrives: the theme's own reading gesture. */
export type LyricKind = 'focus' | 'page' | 'ripple' | 'ink' | 'subtitle' | 'plain'
/** The play button's aura. */
export type PulseKind = 'halo' | 'copper' | 'droplet' | 'ink' | 'sun' | 'plain'

export interface ThemeEffects {
  particles: ParticleKind
  /** Particles per 100 000 px² of viewport — a density, so a big window is not starved. */
  density: number
  /** Base drift speed, in px/s at 100 % scale. */
  speed: number
  /** Period of the background gradient's drift. Longer reads as calmer. */
  driftSeconds: number
  /** Opacity of the skin's ambient glow behind page content (0…1). */
  glow: number
  /**
   * How strongly the theme reacts to the music (0…1).
   *
   * 0 means \"this space ignores playback entirely\" — a legitimate choice for a calm theme, and the one
   * honest way to offer \"music-linked visuals\" without making every theme behave identically.
   */
  reactive: number
  background: BackgroundKind
  immersive: ImmersiveKind
  lyrics: LyricKind
  pulse: PulseKind
}

/** One of the four animation levels the user can pick; see `renderer/theme/effects/levels.ts`. */
export type AnimationLevel = 'off' | 'saver' | 'standard' | 'immersive'

/** CSS custom property name (`--bg`) to value (`#0d1016`). */
export type ThemeTokens = Record<string, string>

export interface ThemeDefinition {
  /** Stable id, also the `data-skin` value. Must not collide with a built-in skin. */
  id: string
  name: string
  /** One line of positioning, shown under the name. */
  tagline: string
  /** Two or three sentences for the theme centre's detail area. */
  description: string
  keywords: string[]
  /** Three colours for the preview card, in display order. */
  swatch: string[]
  /** The mode the skin was designed around; picking the skin switches to it. */
  preferredMode: 'dark' | 'light'
  dark: ThemeTokens
  light: ThemeTokens
  effects: ThemeEffects
}

/** One file found in the user's themes folder. `ok: false` means it was found but rejected. */
export interface UserThemeRecord {
  id: string
  name: string
  file: string
  ok: boolean
  error?: string
  theme?: ThemeDefinition
}

/** The longest a single token value may be — long enough for `rgba(…)`, short enough to reason about. */
const MAX_TOKEN_LENGTH = 96
/** A theme that declares more than this is not a theme, it is a stylesheet. */
const MAX_TOKENS = 48

const TOKEN_NAME = /^--[a-z0-9-]+$/i
/*
 * Deliberately an allowlist of "characters a CSS colour can be made of": hex, functional notation,
 * percentages, spaces. Anything that could terminate a declaration (`;`), open a block (`{`) or pull
 * in a URL is rejected by omission rather than by a list of things to strip.
 */
const TOKEN_VALUE = /^[#a-z0-9(),.%\s/+-]+$/i
/*
 * The allowlist above is structural (it keeps a value from ending a declaration), but it cannot tell a
 * colour from a *fetch*: `url(x)` and `image-set(x)` are made of the same characters as `rgb(1,2,3)`,
 * and a custom property holding a `url()` will be resolved the moment something reads it into a
 * background. So the value-level escapes are named and refused explicitly.
 */
const TOKEN_FORBIDDEN = /url\s*\(|image-set\s*\(|@import|expression\s*\(|\\/i

/*
 * The recipe names an effect may use. Exported as `ThemeEffects`' own vocabulary: the engine switches on
 * these, so an unknown value is not a theme with a typo — it is a value the renderer would have to
 * guess at, and guessing is what turns "my theme looks wrong" into "my theme crashed the page".
 */
const PARTICLE_KINDS: readonly ParticleKind[] = ['stars', 'leaves', 'mist', 'rain', 'dust', 'none']
const BACKGROUND_KINDS: readonly BackgroundKind[] = ['nebula', 'paper', 'tide', 'wash', 'sunset', 'plain']
const IMMERSIVE_KINDS: readonly ImmersiveKind[] = ['nebula', 'window', 'water', 'ink', 'film', 'plain']
const LYRIC_KINDS: readonly LyricKind[] = ['focus', 'page', 'ripple', 'ink', 'subtitle', 'plain']
const PULSE_KINDS: readonly PulseKind[] = ['halo', 'copper', 'droplet', 'ink', 'sun', 'plain']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseTokens(input: unknown, what: string): { tokens: ThemeTokens } | { error: string } {
  if (!isRecord(input)) return { error: `${what}：缺少颜色表` }
  const entries = Object.entries(input)
  if (entries.length === 0) return { error: `${what}：颜色表为空` }
  if (entries.length > MAX_TOKENS) return { error: `${what}：颜色项过多（最多 ${MAX_TOKENS} 项）` }
  const tokens: ThemeTokens = {}
  for (const [name, value] of entries) {
    if (!TOKEN_NAME.test(name)) return { error: `${what}：非法的变量名 ${name}` }
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TOKEN_LENGTH) {
      return { error: `${what}：${name} 的值长度不合法` }
    }
    if (!TOKEN_VALUE.test(value) || TOKEN_FORBIDDEN.test(value)) {
      return { error: `${what}：${name} 的值不是可安全写入的颜色` }
    }
    tokens[name] = value
  }
  return { tokens }
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallbackValue: T): T {
  return allowed.includes(value as T) ? (value as T) : fallbackValue
}

function parseEffects(input: unknown): ThemeEffects {
  const fallback: ThemeEffects = {
    particles: 'none',
    density: 0,
    speed: 0,
    driftSeconds: 60,
    glow: 0.12,
    reactive: 0,
    background: 'plain',
    immersive: 'plain',
    lyrics: 'plain',
    pulse: 'plain',
  }
  if (!isRecord(input)) return fallback
  /** Clamped rather than rejected: an over-eager number is a taste problem, not a broken theme. */
  const clamp = (value: unknown, min: number, max: number, fallbackValue: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallbackValue
  return {
    particles: pick(input.particles, PARTICLE_KINDS, 'none'),
    density: clamp(input.density, 0, 0.6, 0),
    speed: clamp(input.speed, 0, 60, 10),
    driftSeconds: clamp(input.driftSeconds, 8, 600, 60),
    glow: clamp(input.glow, 0, 0.5, 0.12),
    reactive: clamp(input.reactive, 0, 1, 0),
    background: pick(input.background, BACKGROUND_KINDS, 'plain'),
    immersive: pick(input.immersive, IMMERSIVE_KINDS, 'plain'),
    lyrics: pick(input.lyrics, LYRIC_KINDS, 'plain'),
    pulse: pick(input.pulse, PULSE_KINDS, 'plain'),
  }
}

/**
 * Turns unknown input (a parsed JSON file, or a built-in object) into a theme, or explains why not.
 *
 * The messages name the offending field on purpose: the theme centre shows them verbatim, and "无效的
 * 主题文件" would leave the person who wrote the file with nothing to act on.
 */
export function parseThemeDefinition(input: unknown): { theme: ThemeDefinition } | { error: string } {
  if (!isRecord(input)) return { error: '不是有效的主题对象' }
  const id = typeof input.id === 'string' ? input.id.trim() : ''
  if (!/^[a-z0-9_-]{2,40}$/i.test(id)) return { error: 'id 只能包含字母、数字、-、_（2–40 个字符）' }
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (name.length === 0 || name.length > 32) return { error: '名称必填（最多 32 个字符）' }
  const dark = parseTokens(input.dark, '深色')
  if ('error' in dark) return { error: dark.error }
  const light = parseTokens(input.light, '浅色')
  if ('error' in light) return { error: light.error }
  const swatch = Array.isArray(input.swatch)
    ? input.swatch.filter((item): item is string => typeof item === 'string' && TOKEN_VALUE.test(item)).slice(0, 3)
    : []
  return {
    theme: {
      id,
      name,
      tagline: typeof input.tagline === 'string' ? input.tagline.slice(0, 48) : '',
      description: typeof input.description === 'string' ? input.description.slice(0, 240) : '',
      keywords: Array.isArray(input.keywords)
        ? input.keywords.filter((item): item is string => typeof item === 'string').slice(0, 8)
        : [],
      swatch: swatch.length > 0 ? swatch : [Object.values(dark.tokens)[0] ?? '#000000'],
      preferredMode: input.preferredMode === 'light' ? 'light' : 'dark',
      dark: dark.tokens,
      light: light.tokens,
      effects: parseEffects(input.effects),
    },
  }
}
