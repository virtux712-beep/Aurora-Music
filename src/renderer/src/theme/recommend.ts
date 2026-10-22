/*
 * Which space does this song belong in?
 *
 * The honest version of "theme auto-recommendation". A player cannot know a song's mood: it knows a title,
 * an artist, sometimes a genre tag, and the dominant colour of a cover. So this does not claim to know the
 * mood — it matches the *few signals it actually has* against each skin's own character, and every answer
 * carries the reason it was chosen. The caller shows that reason; a recommendation without a "why" is a
 * random theme change with an excuse.
 *
 * Two rules keep it from being annoying:
 *
 *  - **it never switches anything by itself.** It answers a question ("which skin fits this track?"), and the
 *    settings page asks it when the user clicks. Auto-switching themes under a listener is the kind of
 *    cleverness that makes an app feel out of control.
 *  - **it abstains.** No signals worth using means `null`, not a coin flip.
 *
 * Pure, so the matching can be tested against fixtures instead of by playing songs and squinting.
 */
import type { ThemeDefinition } from '../../../shared/theme'

export interface RecommendInput {
  title?: string
  artist?: string
  /** Genre or tag text, when the file has one. Frequently empty — that is fine. */
  genre?: string
  /** Duration in seconds, when known. A very short track is usually an interlude or a jingle. */
  duration?: number
  /** The cover's dominant colour, any CSS colour the palette can parse. */
  accent?: string
}

export interface Recommendation {
  skinId: string
  name: string
  reason: string
  /** 0…1. Used to sort candidates; nothing is recommended below `MIN_SCORE`. */
  score: number
}

/**
 * Below this, the answer is "nothing fits well enough to say" rather than the best of a bad set.
 *
 * The floor matters more than the weights: without it every track gets an equally confident answer, which
 * makes the feature noise. A plain pop song on a blue cover genuinely does not suggest a world.
 */
export const MIN_SCORE = 0.34

/** Keyword groups, each tied to the skin whose character they describe. Matched case-insensitively. */
const KEYWORDS: Array<{ skinId: string; reason: string; words: string[] }> = [
  {
    skinId: 'jiangnan-rain',
    reason: '古风 / 民乐的字眼，配水墨留白',
    words: ['古风', '戏腔', '琵琶', '笛', '筝', '国风', '山水', '诗词', '江南', '烟雨', '汉服', '墨'],
  },
  {
    skinId: 'aurora',
    reason: '电子 / 舞曲的字眼，配极光流动',
    words: ['电子', 'electro', 'edm', 'dj', 'remix', 'house', 'techno', 'synth', 'club', '舞曲'],
  },
  {
    skinId: 'star-dream',
    reason: '夜与宇宙的字眼，配星空梦境',
    words: ['星', '夜', '宇宙', '银河', 'sleep', 'lullaby', 'ambient', 'dream', 'moon', '晚安'],
  },
  {
    skinId: 'autumn-leaf',
    reason: '民谣 / 木吉他的字眼，配秋日书房',
    words: ['民谣', 'folk', '木吉他', 'acoustic', '情歌', '老歌', '回忆', '秋'],
  },
  {
    skinId: 'ocean-morning',
    reason: '轻音乐 / 钢琴的字眼，配清晨海边',
    words: ['轻音乐', '钢琴', 'piano', '纯音乐', 'instrumental', '治愈', '海', '晨', '雨声'],
  },
  {
    skinId: 'sunset-song',
    reason: '摇滚 / 现场的字眼，配落日长歌',
    words: ['摇滚', 'rock', 'metal', 'live', '现场', '燃', '旅行', '公路', '吉他手'],
  },
]

export interface RecommendSkin {
  id: string
  name: string
  /** Where the skin's dominant colour comes from, so a colour match can be named in the reason. */
  swatch?: string
}

function text(input: RecommendInput): string {
  return `${input.title ?? ''} ${input.artist ?? ''} ${input.genre ?? ''}`.toLowerCase()
}

/** `#rrggbb` → hue in degrees, or null. Only hex: that is what the palette and the covers produce. */
export function hueOf(colour: string | undefined): number | null {
  if (!colour) return null
  const match = /^#?([0-9a-f]{6})$/i.exec(colour.trim())
  if (!match) return null
  const value = Number.parseInt(match[1]!, 16)
  const r = ((value >> 16) & 255) / 255
  const g = ((value >> 8) & 255) / 255
  const b = (value & 255) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  if (delta === 0) return null
  const hue = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4
  return (hue * 60 + 360) % 360
}

/**
 * The cover's colour, as a *suggestion* rather than a decision.
 *
 * Each band is a hue range with the skin whose own palette lives there. Deliberately coarse: trying to be
 * precise about a cover's mood from its average colour would be pretending to more knowledge than exists,
 * so this is worth less than a keyword. It *can* decide alone (0.4 against a 0.34 floor) because a strong
 * cover colour genuinely does suggest a space, and a cover with no usable hue abstains rather than guessing.
 */
const HUE_BANDS: Array<{ skinId: string; reason: string; from: number; to: number }> = [
  { skinId: 'sunset-song', reason: '暖红 / 橙的封面色，配落日', from: 340, to: 40 },
  { skinId: 'autumn-leaf', reason: '黄 / 棕的封面色，配秋日', from: 40, to: 75 },
  { skinId: 'jiangnan-rain', reason: '青绿的封面色，配水墨', from: 75, to: 165 },
  { skinId: 'ocean-morning', reason: '蓝 / 青的封面色，配海边', from: 165, to: 250 },
  { skinId: 'star-dream', reason: '紫的封面色，配星夜', from: 250, to: 300 },
  { skinId: 'aurora', reason: '紫红的封面色，配极光', from: 300, to: 340 },
]

function bandFor(hue: number): { skinId: string; reason: string } | null {
  for (const band of HUE_BANDS) {
    const inside = band.from <= band.to ? hue >= band.from && hue < band.to : hue >= band.from || hue < band.to
    if (inside) return band
  }
  return null
}

/**
 * The best-fitting skin for a track, or `null` when nothing fits well enough.
 *
 * Weights: keywords 0.62, cover colour 0.4, and a small structural term (0.12) for the things that are true
 * of the *shape* of a track — a very short one suits the calmest space, a very long one suits a room you sit
 * in. The numbers are not derived from data; they are a statement of priority, which is why they are here and
 * not scattered through the matching code. Structure is deliberately below the floor: a 90-second interlude
 * does not say "morning ocean", so it may only tip a match that is already there.
 */
export function recommendSkin(input: RecommendInput, skins: RecommendSkin[]): Recommendation | null {
  if (skins.length === 0) return null
  const haystack = text(input)
  const hue = hueOf(input.accent)
  const band = hue === null ? null : bandFor(hue)
  const scores = new Map<string, { score: number; reasons: string[] }>()

  const add = (skinId: string, amount: number, reason: string): void => {
    const entry = scores.get(skinId) ?? { score: 0, reasons: [] }
    entry.score += amount
    if (reason && !entry.reasons.includes(reason)) entry.reasons.push(reason)
    scores.set(skinId, entry)
  }

  for (const group of KEYWORDS) {
    const hit = group.words.find((word) => haystack.includes(word))
    if (hit) add(group.skinId, 0.62, `${group.reason}（“${hit}”）`)
  }

  if (band) add(band.skinId, 0.4, band.reason)

  const duration = input.duration ?? 0
  if (duration > 0 && duration < 150) add('ocean-morning', 0.12, '短曲，配清爽的一段路')
  if (duration > 420) add('sunset-song', 0.12, '长曲，配坐下来听的一整个黄昏')

  let best: Recommendation | null = null
  for (const [skinId, entry] of scores) {
    if (entry.score < MIN_SCORE) continue
    const skin = skins.find((item) => item.id === skinId)
    if (!skin) continue
    const candidate: Recommendation = {
      skinId,
      name: skin.name,
      reason: entry.reasons.slice(0, 2).join('；'),
      score: entry.score,
    }
    if (!best || candidate.score > best.score) best = candidate
  }
  return best
}

/** Convenience for the caller: the built-in and installed skins, reduced to what the matcher needs. */
export function recommendable(themes: ThemeDefinition[]): RecommendSkin[] {
  return themes.map((theme) => ({ id: theme.id, name: theme.name }))
}
