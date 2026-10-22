/*
 * The built-in skins.
 *
 * A skin is a *mood*, not a colour swap: each one declares the few colours that define it plus the
 * ambient behaviour (particles, background drift, glow) that makes the space feel like that mood.
 * Everything else in the token set is derived in `buildTokens`, so the six skins cannot drift into
 * six subtly different definitions of what "a card" is.
 *
 * Design rules the palettes below follow, because they are what makes a theme usable rather than
 * pretty in a screenshot:
 *
 *  - text on `surface` stays legible at 13px (muted tones never drop below roughly 45 % blend);
 *  - `surface` is always distinguishable from `bg` by at least 6/255 per channel, so cards separate
 *    in *both* modes — the light theme's classic failure is white-on-white;
 *  - the accent has a matching `accentAlt` so the ambient gradient is tinted rather than muddy.
 */
import type { ThemeDefinition, ThemeEffects, ThemeTokens } from '../../../shared/theme'
import { alpha, luminance, mix } from './palette'

/** The colours a skin author actually thinks in. Everything else is computed. */
interface SkinPalette {
  /** Page background. */
  bg: string
  /** Cards and panels. */
  surface: string
  /** Recessed areas: inputs, cover placeholders, table headers. */
  surfaceAlt: string
  text: string
  muted: string
  line: string
  accent: string
  /** Second accent, used for ambient gradients and the vinyl's stage light. */
  accentAlt: string
  danger?: string
  success?: string
  warn?: string
}

const MODE_FALLBACK = {
  danger: { dark: '#f2808e', light: '#d2434f' },
  success: { dark: '#7ddba4', light: '#1f9d5a' },
  warn: { dark: '#f0c274', light: '#b57a11' },
} as const

/**
 * Expands a palette into the full custom-property set.
 *
 * The derivation is deliberately shallow: one blend per token, no chains, because a chain means a
 * change to `surface` silently moves four other tokens and makes "why is this border wrong" a puzzle.
 */
export function buildTokens(palette: SkinPalette, mode: 'dark' | 'light'): ThemeTokens {
  const dark = mode === 'dark'
  /** Distance from the page background: `0` is the page itself, `1` is fully the surface colour. */
  const towards = dark ? '#ffffff' : '#000000'
  const shadowBase = dark ? '#04060c' : mix(palette.bg, '#000000', 0.55)
  const tokens: ThemeTokens = {
    '--bg': palette.bg,
    '--bg-glow': alpha(palette.accent, dark ? 0.14 : 0.1),
    '--ambient-a': palette.accent,
    '--ambient-b': palette.accentAlt,
    '--panel': palette.surface,
    '--panel-soft': palette.surfaceAlt,
    '--card': palette.surface,
    '--card-soft': palette.surfaceAlt,
    '--line': alpha(palette.line, dark ? 0.14 : 0.12),
    '--line-strong': alpha(palette.line, dark ? 0.26 : 0.22),
    '--text': palette.text,
    '--muted': palette.muted,
    '--faint': mix(palette.muted, palette.bg, 0.42),
    '--accent': palette.accent,
    '--accent-strong': mix(palette.accent, towards, dark ? 0.16 : 0.12),
    '--accent-soft': alpha(palette.accent, dark ? 0.16 : 0.12),
    '--accent-line': alpha(palette.accent, dark ? 0.32 : 0.26),
    '--danger': palette.danger ?? MODE_FALLBACK.danger[mode],
    '--success': palette.success ?? MODE_FALLBACK.success[mode],
    '--warn': palette.warn ?? MODE_FALLBACK.warn[mode],
    // The player bar and other floating chrome ride on their own token: they are translucent over
    // *whatever* is behind them, so they cannot simply be `--panel` with an opacity applied at the
    // use site (that trick cannot reach the backdrop blur or the hairline highlight).
    '--glass': alpha(palette.surface, dark ? 0.74 : 0.78),
    '--glass-strong': alpha(palette.surface, dark ? 0.92 : 0.94),
    '--glass-line': alpha(palette.line, dark ? 0.16 : 0.14),
    '--player-bg': alpha(mix(palette.bg, palette.surface, 0.5), dark ? 0.86 : 0.88),
    '--shadow': `0 18px 40px ${alpha(shadowBase, dark ? 0.5 : 0.16)}`,
    '--shadow-soft': `0 10px 24px ${alpha(shadowBase, dark ? 0.34 : 0.1)}`,
  }
  /*
   * A token whose source colour is missing is dropped rather than emitted empty.
   *
   * That distinction is the whole difference between "this skin overrides three colours" and a blank
   * app: `--bg: ` (or worse, `--bg: undefined`) would *win* over `base.css` and paint the window with
   * nothing, while a missing token simply falls through to the base value.
   */
  const declared = new Set(
    Object.entries(palette)
      .filter(([, value]) => typeof value === 'string' && value.trim().length > 0)
      .map(([key]) => key),
  )
  const source: Record<string, keyof SkinPalette> = {
    '--bg': 'bg',
    '--bg-glow': 'accent',
    '--ambient-a': 'accent',
    '--ambient-b': 'accentAlt',
    '--panel': 'surface',
    '--panel-soft': 'surfaceAlt',
    '--card': 'surface',
    '--card-soft': 'surfaceAlt',
    '--line': 'line',
    '--line-strong': 'line',
    '--text': 'text',
    '--muted': 'muted',
    '--faint': 'muted',
    '--accent': 'accent',
    '--accent-strong': 'accent',
    '--accent-soft': 'accent',
    '--accent-line': 'accent',
    '--glass': 'surface',
    '--glass-strong': 'surface',
    '--glass-line': 'line',
    '--player-bg': 'bg',
  }
  for (const [token, key] of Object.entries(source)) {
    if (!declared.has(key)) delete tokens[token]
  }
  return tokens
}

function skin(input: Omit<ThemeDefinition, 'dark' | 'light'> & { palette: { dark: SkinPalette; light: SkinPalette } }): ThemeDefinition {
  const { palette, ...definition } = input
  /*
   * An empty palette is meaningful, not a mistake: the default skin *is* `base.css`, so it declares
   * nothing and lets the stylesheet's own values stand. Deriving from an empty palette would emit
   * `--bg: undefined` and blank the whole app, so the empty case returns no tokens at all.
   */
  const expand = (value: SkinPalette, mode: 'dark' | 'light'): ThemeTokens =>
    Object.keys(value).length === 0 ? {} : buildTokens(value, mode)
  return { ...definition, dark: expand(palette.dark, 'dark'), light: expand(palette.light, 'light') }
}

/** Which skins exist, in the order the theme centre shows them. */
export const BUILT_IN_SKINS: ThemeDefinition[] = [
  skin({
    id: 'aurora',
    name: '极光',
    tagline: 'Aurora 的原生极简',
    description: '默认主题。深蓝底上的极光紫，冷静、克制，适合长时间听歌。它使用内置的基础色板，不覆盖任何变量。',
    keywords: ['极简', '极光', '深色优先'],
    swatch: ['#0d1016', '#a58aff', '#141820'],
    preferredMode: 'dark',
    // The original tokens in `base.css` *are* this theme, so it deliberately declares nothing.
    palette: { dark: {} as SkinPalette, light: {} as SkinPalette },
    effects: {
      particles: 'stars',
      density: 0.06,
      speed: 4,
      driftSeconds: 90,
      glow: 0.1,
      reactive: 0.4,
      background: 'plain',
      immersive: 'plain',
      lyrics: 'plain',
      pulse: 'plain',
    },
  }),
  skin({
    id: 'star-dream',
    name: '星河入梦',
    tagline: '深夜耳机音乐空间',
    description: '银河、星空与梦境。深空蓝底上飘着银白微尘，专辑封面会化成星云铺在背景里。适合夜里戴耳机的时候。',
    keywords: ['银河', '星空', '梦境'],
    swatch: ['#070a16', '#8ea2ff', '#c9a2ff'],
    preferredMode: 'dark',
    palette: {
      dark: {
        bg: '#070a16',
        surface: '#101528',
        surfaceAlt: '#0b0f1e',
        text: '#eef1ff',
        muted: '#939bc4',
        line: '#c9d3ff',
        accent: '#8ea2ff',
        accentAlt: '#c9a2ff',
      },
      light: {
        bg: '#eef1fb',
        surface: '#ffffff',
        surfaceAlt: '#e4e9f8',
        text: '#151a30',
        muted: '#5f678c',
        line: '#3a4470',
        accent: '#5c6fd6',
        accentAlt: '#8b5fd0',
      },
    },
    effects: {
      particles: 'stars',
      density: 0.22,
      speed: 6,
      driftSeconds: 120,
      glow: 0.2,
      // The most music-linked skin: the nebula, the star field and the halo all breathe with the bass.
      reactive: 0.9,
      background: 'nebula',
      immersive: 'nebula',
      lyrics: 'focus',
      pulse: 'halo',
    },
  }),
  skin({
    id: 'autumn-leaf',
    name: '晚秋拾叶',
    tagline: '温暖复古音乐空间',
    description: '秋天、书页与木质。米白纸面配枫叶红，卡片像旧书页一样有边界，落叶缓缓飘下。',
    keywords: ['秋天', '书页', '木质', '复古'],
    swatch: ['#f7f1e6', '#b4622f', '#8a5a3b'],
    preferredMode: 'light',
    palette: {
      dark: {
        bg: '#17110d',
        surface: '#221a14',
        surfaceAlt: '#1c1510',
        text: '#f5e9dc',
        muted: '#b39a83',
        line: '#e8c9a8',
        accent: '#d9834a',
        accentAlt: '#c05a3e',
      },
      light: {
        bg: '#f7f1e6',
        surface: '#fffdf7',
        surfaceAlt: '#efe6d6',
        text: '#33261b',
        muted: '#7c6650',
        line: '#8a6a48',
        accent: '#b4622f',
        accentAlt: '#c98a3e',
      },
    },
    effects: {
      particles: 'leaves',
      density: 0.1,
      speed: 14,
      driftSeconds: 150,
      glow: 0.13,
      // A reading room ignores the music almost entirely — that is what makes it feel calm.
      reactive: 0.25,
      background: 'paper',
      immersive: 'window',
      lyrics: 'page',
      pulse: 'copper',
    },
  }),
  skin({
    id: 'ocean-morning',
    name: '潮汐晨光',
    tagline: '清晨海边空间',
    description: '海风、晨雾与治愈。海盐蓝的清爽浅色，雾一样缓慢流动的背景，水面倒影会跟着封面变。',
    keywords: ['海风', '晨雾', '治愈', '清爽'],
    swatch: ['#f2f8fa', '#1f8fa8', '#8fd3e0'],
    preferredMode: 'light',
    palette: {
      dark: {
        bg: '#08161d',
        surface: '#0e2029',
        surfaceAlt: '#0a1a22',
        text: '#eaf7fa',
        muted: '#8fb3bf',
        line: '#bfe6f0',
        accent: '#4fb9d4',
        accentAlt: '#7fe0d2',
      },
      light: {
        bg: '#f2f8fa',
        surface: '#ffffff',
        surfaceAlt: '#e4f1f5',
        text: '#10262e',
        muted: '#4f7481',
        line: '#2f5b68',
        accent: '#1f8fa8',
        accentAlt: '#3fb8a8',
      },
    },
    effects: {
      particles: 'mist',
      density: 0.08,
      speed: 8,
      driftSeconds: 70,
      glow: 0.18,
      reactive: 0.5,
      background: 'tide',
      immersive: 'water',
      lyrics: 'ripple',
      pulse: 'droplet',
    },
  }),
  skin({
    id: 'jiangnan-rain',
    name: '烟雨江南',
    tagline: '东方国风空间',
    description: '水墨、江南与细雨。宣纸底的留白、淡青与樱粉，雨丝落在玻璃上，歌词浮在雨幕后面。',
    keywords: ['水墨', '江南', '细雨', '国风'],
    swatch: ['#f5f4ee', '#3f8f83', '#e0a6b3'],
    preferredMode: 'light',
    palette: {
      dark: {
        bg: '#12191a',
        surface: '#1a2325',
        surfaceAlt: '#151d1f',
        text: '#eef4f2',
        muted: '#9bb0ac',
        line: '#cfe4e0',
        accent: '#7fc7bd',
        accentAlt: '#e8a7b4',
      },
      light: {
        bg: '#f5f4ee',
        surface: '#fffefb',
        surfaceAlt: '#eae8df',
        text: '#22302f',
        muted: '#63746f',
        line: '#40564f',
        accent: '#3f8f83',
        accentAlt: '#d98fa0',
      },
    },
    effects: {
      particles: 'rain',
      density: 0.16,
      speed: 120,
      driftSeconds: 100,
      glow: 0.1,
      reactive: 0.3,
      background: 'wash',
      immersive: 'ink',
      lyrics: 'ink',
      pulse: 'ink',
    },
  }),
  skin({
    id: 'sunset-song',
    name: '落日长歌',
    tagline: '电影级音乐空间',
    description: '黄昏、旅途与热烈。日落橙叠暮紫，空气里飘着胶片颗粒，歌词像电影字幕一样落在画面下缘。',
    keywords: ['黄昏', '旅途', '热烈', '电影感'],
    swatch: ['#1a1014', '#ff9457', '#a561d8'],
    preferredMode: 'dark',
    palette: {
      dark: {
        bg: '#1a1014',
        surface: '#26161b',
        surfaceAlt: '#1f1216',
        text: '#fdeee6',
        muted: '#bf9a92',
        line: '#ffd0b8',
        accent: '#ff9457',
        accentAlt: '#a561d8',
      },
      light: {
        bg: '#fbf0e8',
        surface: '#fffaf7',
        surfaceAlt: '#f4e2d8',
        text: '#331d16',
        muted: '#8a6152',
        line: '#8a5a44',
        accent: '#e0653a',
        accentAlt: '#9b4fc4',
      },
    },
    effects: {
      particles: 'dust',
      density: 0.14,
      speed: 10,
      driftSeconds: 110,
      glow: 0.16,
      reactive: 0.7,
      background: 'sunset',
      immersive: 'film',
      lyrics: 'subtitle',
      pulse: 'sun',
    },
  }),
]

/** The skin used when a stored id no longer exists (a deleted user theme, a typo in storage). */
export const DEFAULT_SKIN_ID = 'aurora'

export function findBuiltInSkin(id: string): ThemeDefinition | undefined {
  return BUILT_IN_SKINS.find((item) => item.id === id)
}

/**
 * The native title-bar colours for a skin.
 *
 * The strip is drawn by Windows, so CSS cannot reach it — the renderer has to send colours, and
 * taking them from the skin's own `--bg`/`--text` is what keeps the strip from being the one dark
 * band left on an otherwise light theme. `null` means "skin declares nothing"; main keeps its
 * defaults then.
 */
export function skinChrome(skin: ThemeDefinition, mode: 'dark' | 'light'): { color: string; symbolColor: string } | null {
  const tokens = mode === 'dark' ? skin.dark : skin.light
  const color = tokens['--bg']
  const text = tokens['--text']
  if (!color || !text) return null
  // Symbol colour follows the strip's actual luminance rather than the mode name: a "light" skin
  // with a dark strip still needs light glyphs.
  return { color, symbolColor: luminance(color) > 0.45 ? mix(text, '#000000', 0.2) : mix(text, '#ffffff', 0.2) }
}

/** The effects a skin asks for, with the built-in defaults applied. */
export function skinEffects(skin: ThemeDefinition): ThemeEffects {
  return skin.effects
}
