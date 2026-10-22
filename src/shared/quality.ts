/**
 * Aurora's quality model — four tiers, one vocabulary.
 *
 * The problem this solves is that "quality" arrives in three unrelated spellings and none of them is a
 * product decision:
 *
 *  - a source reports *availability tokens* (`flac24bit`, `320k`, `128k` …) — its own vocabulary, per song;
 *  - a local file reports *container facts* (`format`, `bitsPerSample`, `sampleRate`, `bitrate`);
 *  - the user thinks in *outcomes* ("this is worth my good headphones" vs "just play it").
 *
 * Mapping tokens to tiers is what lets the UI say one thing (`✨ Hi-Res`) that is true for both an online
 * master and a local 24/96 FLAC, and what lets a preference ("prefer 高清无损") be turned back into a token
 * the source understands. Nothing here invents a number: a track that advertises nothing gets no tier, and
 * the UI shows no badge rather than a plausible guess.
 */

/** Ordered best → worst. `rank` is the only thing comparisons use. */
export type QualityTierId = 'ultra' | 'lossless' | 'high' | 'smooth'

export interface QualityTier {
  id: QualityTierId
  /** Product name, e.g. 臻享无损. */
  name: string
  english: string
  /** Higher is better. The only field ordering logic reads. */
  rank: number
  /** The badge: one icon plus the short label the row can fit. */
  badge: { icon: string; label: string; tone: QualityTierId }
  /** What this tier means technically, as shown in the picker. */
  spec: {
    formats: string[]
    bitDepth?: number
    sampleRate?: number
    /** kbps; absent for lossless tiers, where the bitrate is whatever the music needs. */
    bitrate?: number
  }
  description: string
  /** Who it is for, in the user's words. */
  audience: string
}

export const QUALITY_TIERS: QualityTier[] = [
  {
    id: 'ultra',
    name: '臻享无损',
    english: 'Ultra Lossless',
    rank: 40,
    badge: { icon: '🎧', label: '✨ Hi-Res', tone: 'ultra' },
    spec: { formats: ['FLAC', 'WAV'], bitDepth: 24, sampleRate: 96000 },
    description: '保留音乐原始细节，适合高品质耳机与音响设备',
    audience: '发烧友 · 高端耳机 · 安静环境聆听',
  },
  {
    id: 'lossless',
    name: '高清无损',
    english: 'Lossless',
    rank: 30,
    badge: { icon: '💎', label: 'Lossless', tone: 'lossless' },
    spec: { formats: ['FLAC'], bitDepth: 16, sampleRate: 44100 },
    description: '还原真实声音，兼顾音质与存储空间',
    audience: '日常高品质听歌 · 大多数耳机设备',
  },
  {
    id: 'high',
    name: '极致音质',
    english: 'High Quality',
    rank: 20,
    badge: { icon: '🎵', label: 'Recommended', tone: 'high' },
    spec: { formats: ['MP3 320kbps', 'AAC 256kbps'], bitrate: 320 },
    description: '清晰均衡，流畅与音质的最佳平衡',
    audience: '日常播放 · 手机 / 电脑使用',
  },
  {
    id: 'smooth',
    name: '流畅播放',
    english: 'Smooth',
    rank: 10,
    badge: { icon: '⚡', label: 'Smooth', tone: 'smooth' },
    spec: { formats: ['AAC 128kbps', 'MP3 128kbps'], bitrate: 128 },
    description: '快速加载，减少等待，节省流量',
    audience: '网络不稳定 · 移动网络',
  },
]

export const QUALITY_TIER_IDS: QualityTierId[] = QUALITY_TIERS.map((tier) => tier.id)

const BY_ID = new Map<string, QualityTier>(QUALITY_TIERS.map((tier) => [tier.id, tier]))

/** The default preference: the best tier that is not a niche one, so nothing is lost by defaulting. */
export const DEFAULT_QUALITY: QualityTierId = 'lossless'

export function isQualityTierId(value: unknown): value is QualityTierId {
  return typeof value === 'string' && BY_ID.has(value)
}

export function qualityTier(id: QualityTierId): QualityTier {
  return BY_ID.get(id) ?? BY_ID.get(DEFAULT_QUALITY)!
}

/**
 * Availability tokens, in the vocabularies the platform layer and LX sources actually emit.
 *
 * `192k` is deliberately *not* in `ultra`: in every one of those vocabularies the `k` tokens are lossy
 * bitrates, so reading it as "192 kHz" would be the exact class of mistake this file exists to prevent.
 */
const TOKEN_TIERS: Record<string, QualityTierId> = {
  // Hi-res lossless.
  flac24bit: 'ultra',
  'flac-24bit': 'ultra',
  flac32bit: 'ultra',
  hires: 'ultra',
  'hi-res': 'ultra',
  hiras: 'ultra',
  master: 'ultra',
  dsd: 'ultra',
  ds64: 'ultra',
  ds128: 'ultra',
  dsf: 'ultra',
  dff: 'ultra',
  wav24: 'ultra',
  // CD-resolution lossless.
  flac: 'lossless',
  sq: 'lossless',
  ape: 'lossless',
  alac: 'lossless',
  wav: 'lossless',
  wave: 'lossless',
  aiff: 'lossless',
  aif: 'lossless',
  pcm: 'lossless',
  // Lossy, "recommended" bitrates.
  '320k': 'high',
  '256k': 'high',
  '192k': 'high',
  hq: 'high',
  aac256: 'high',
  m4a256: 'high',
  // Lossy, low bitrates.
  '128k': 'smooth',
  '96k': 'smooth',
  '64k': 'smooth',
  '48k': 'smooth',
  '32k': 'smooth',
  '24k': 'smooth',
  aac128: 'smooth',
  std: 'smooth',
  standard: 'smooth',
}

/** Normalises a token before lookup: case, spaces, and the separators sources like to add. */
function normalizeToken(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, '').replace(/_/g, '-')
}

/**
 * The tier an availability token belongs to, or `null` for a token Aurora does not know.
 *
 * Unknown is reported as unknown on purpose: a source is free to invent `vip-only`, and showing a badge for
 * it would be a guess dressed as a measurement.
 */
export function tierOfToken(raw: string | undefined): QualityTierId | null {
  if (!raw) return null
  const token = normalizeToken(raw)
  if (!token) return null
  const direct = TOKEN_TIERS[token]
  if (direct) return direct
  /*
   * Then the *shape* rules, for tokens nobody listed but which are unambiguous: `flac24bit` appears as
   * `flac-24`, `flac24`, `flac 24bit` … across sources, and any `flac` variant carrying a 24/32 is hi-res.
   */
  if (/flac/.test(token) && /(24|32)(bit)?/.test(token)) return 'ultra'
  if (/flac|wav|ape|alac|dsd/.test(token)) return 'lossless'
  const bitrate = /(\d{3,4})\s*k?bps|^(\d{3,4})k$/.exec(token)
  const kbps = bitrate ? Number(bitrate[1] ?? bitrate[2]) : 0
  if (kbps >= 256) return 'high'
  if (kbps >= 96) return 'smooth'
  if (/(aac|mp3|m4a|ogg|opus|wma)/.test(token)) return 'smooth'
  return null
}

/** What a *local file* says about itself, in the units the library stored (`null` when untagged). */
export interface AudioFacts {
  format?: string
  bitsPerSample?: number | null
  sampleRate?: number | null
  bitrate?: number | null
}

const LOSSLESS_CONTAINERS = new Set(['FLAC', 'WAV', 'ALAC', 'APE', 'AIFF', 'AIF', 'DSF', 'DFF', 'WAVE'])

/**
 * The tier a local file belongs to, or `null` when its tags do not say enough.
 *
 * A lossy file with no bitrate is the interesting case: 128kbps and 320kbps are different products, and the
 * file does not claim either — so it gets no tier instead of the average of the two.
 */
export function tierOfFacts(facts: AudioFacts): QualityTierId | null {
  const format = (facts.format ?? '').trim().toUpperCase()
  if (!format) return null
  const bits = facts.bitsPerSample ?? 0
  const rate = facts.sampleRate ?? 0
  if (LOSSLESS_CONTAINERS.has(format)) {
    // CD is 44.1/16; anything above either line is hi-res, and a lossless file with *no* numbers is still
    // lossless (the container itself is the proof) — it just cannot claim the hi-res tier.
    if (bits >= 24 || rate >= 96000) return 'ultra'
    if (bits > 16 && rate > 44100) return 'ultra'
    return 'lossless'
  }
  const kbps = facts.bitrate ? facts.bitrate / 1000 : 0
  if (!kbps) return null
  if (kbps >= 256) return 'high'
  return 'smooth'
}

/** The best tier among a set of availability tokens. `null` when none of them is recognised. */
export function bestTierOf(qualities: readonly string[] | undefined): QualityTierId | null {
  if (!qualities || qualities.length === 0) return null
  let best: QualityTier | null = null
  for (const raw of qualities) {
    const id = tierOfToken(raw)
    if (!id) continue
    const tier = qualityTier(id)
    if (!best || tier.rank > best.rank) best = tier
  }
  return best?.id ?? null
}

export interface QualityBadgeView {
  /** Icon and label as one string — what a dense row actually renders. */
  text: string
  icon: string
  label: string
  tone: QualityTierId
  tier: QualityTierId
  /** Product name, e.g. 高清无损 — for the tooltip and the player bar. */
  name: string
  title: string
}

function badgeFor(tier: QualityTier, title: string): QualityBadgeView {
  return {
    text: `${tier.badge.icon} ${tier.badge.label}`,
    icon: tier.badge.icon,
    label: tier.badge.label,
    tone: tier.badge.tone,
    tier: tier.id,
    name: tier.name,
    title,
  }
}

/**
 * The badge for a track, from whichever of the two vocabularies it carries.
 *
 * Online first (a source's per-song list is the most specific statement available), then the file's own
 * facts. Local files describe themselves in `describeFacts`, so the tooltip can carry the real numbers.
 */
export function qualityBadge(input: {
  origin?: string
  qualities?: readonly string[]
  format?: string
  bitsPerSample?: number | null
  sampleRate?: number | null
  bitrate?: number | null
}): QualityBadgeView | null {
  const tokens = input.qualities ?? []
  const fromTokens = bestTierOf(tokens)
  if (fromTokens) {
    const tier = qualityTier(fromTokens)
    const available = tokens
      .map((raw) => ({ raw, id: tierOfToken(raw) }))
      .filter((item): item is { raw: string; id: QualityTierId } => item.id !== null)
      .sort((a, b) => qualityTier(b.id).rank - qualityTier(a.id).rank)
      .map((item) => `${item.raw}（${qualityTier(item.id).name}）`)
    return badgeFor(tier, `可用音质：${available.join(' · ')}`)
  }
  const fromFacts = tierOfFacts(input)
  if (!fromFacts) return null
  const tier = qualityTier(fromFacts)
  const parts = [String(input.format ?? '').toUpperCase()]
  if (input.bitsPerSample && input.sampleRate) parts.push(`${input.bitsPerSample}bit / ${(input.sampleRate / 1000).toFixed(1)}kHz`)
  else if (input.sampleRate) parts.push(`${(input.sampleRate / 1000).toFixed(1)}kHz`)
  if (input.bitrate) parts.push(`${Math.round(input.bitrate / 1000)}kbps`)
  return badgeFor(tier, `${tier.name} · ${parts.filter(Boolean).join(' · ')}`)
}

/* ------------------------------------------------------------------ choosing one */

export interface QualityChoice {
  /** The token to hand the source, e.g. `flac`. Absent when nothing should be sent. */
  quality?: string
  /** The tier that token belongs to, when it is known. */
  tier: QualityTierId | null
  /** True when the source had nothing at or below the preference, so a better tier was taken instead. */
  exceeded: boolean
  /** Why this token, in one line — surfaced in diagnostics and used by the tests. */
  reason: string
}

/**
 * Picks the token to request for a preferred tier.
 *
 * The rule that matters is **never silently above the preference**: a user who picked 流畅播放 because the
 * connection is bad must not be handed a 60 MB FLAC because the source happens to offer one. When the
 * source offers nothing at or below it, the *nearest above* is taken and `exceeded` is set, so the caller can
 * say so rather than pretend the preference was honoured.
 */
export function chooseQuality(available: readonly string[] | undefined, preferred: QualityTierId): QualityChoice {
  const wanted = qualityTier(preferred)
  const known = (available ?? [])
    .map((raw) => ({ raw, id: tierOfToken(raw) }))
    .filter((item): item is { raw: string; id: QualityTierId } => item.id !== null)
  if (known.length === 0) {
    // No usable list: send nothing and let the source decide. Sending a token it never announced is how a
    // resolve fails with "unsupported quality" on a source that would otherwise have worked.
    return { tier: null, exceeded: false, reason: '音源未声明可用音质，交给音源自行选择' }
  }
  const atOrBelow = known.filter((item) => qualityTier(item.id).rank <= wanted.rank)
  if (atOrBelow.length > 0) {
    const best = atOrBelow.reduce((winner, item) =>
      qualityTier(item.id).rank > qualityTier(winner.id).rank ? item : winner,
    )
    return {
      quality: best.raw,
      tier: best.id,
      exceeded: false,
      reason: `在“${wanted.name}”及以下取最好的一档：${best.raw}`,
    }
  }
  const nearestAbove = known.reduce((winner, item) =>
    qualityTier(item.id).rank < qualityTier(winner.id).rank ? item : winner,
  )
  return {
    quality: nearestAbove.raw,
    tier: nearestAbove.id,
    exceeded: true,
    reason: `音源没有“${wanted.name}”及以下的音质，退而取其最低档：${nearestAbove.raw}`,
  }
}

/** One row of the picker UI: the tier plus what this particular source/song can actually give. */
export interface QualityOption {
  tier: QualityTier
  /** Tokens from the track's own list that land in this tier, best first. */
  tokens: string[]
  available: boolean
  selected: boolean
}

export function qualityOptions(available: readonly string[] | undefined, preferred: QualityTierId): QualityOption[] {
  const tokens = available ?? []
  return QUALITY_TIERS.map((tier) => {
    const mine = tokens.filter((raw) => tierOfToken(raw) === tier.id)
    return { tier, tokens: mine, available: mine.length > 0, selected: tier.id === preferred }
  })
}
