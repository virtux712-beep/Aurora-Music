/**
 * Display-only names for the platform search back-ends.
 *
 * The internal platform keys (`kw` / `wy` / `tx` / `kg` / `mg`) are the contract: they go into IPC,
 * into the platform registry, into a Source's `platforms` declaration and into the play-URL resolver.
 * They are deliberately *not* translated in the main process — error messages and logs name the
 * service they came from, which is the honest thing for a diagnostic to say.
 *
 * So the translation lives here, on the last centimetre before pixels: the renderer maps an id to a
 * name that reads nicer and carries each service's character, plus the single glyph used for the row
 * badges and the accent colour that goes with it. Nothing in this file is a key — renaming anything
 * here changes text only.
 */

export interface PlatformAlias {
  /** What the UI calls the platform. */
  name: string
  /** One character, for the compact badge in dense lists. */
  glyph: string
  /** The service's colour, used for the badge tint only. */
  accent: string
}

/** 全部 is a view of everything, not a platform, so it gets its own glyph and no accent. */
export const ALL_GLYPH = '全'

export const PLATFORM_ALIASES: Record<string, PlatformAlias> = {
  // 网易云 — red brand, 云村, the comment section people read like a diary.
  wy: { name: '红云心语', glyph: '云', accent: '#e5484d' },
  // QQ — green brand, a曲库 deep enough to feel like an oasis.
  tx: { name: '绿洲曲海', glyph: '绿', accent: '#31c27c' },
  // 酷狗 — blue brand, whose selling point is the sound processing.
  kg: { name: '蔚蓝声浪', glyph: '蓝', accent: '#35a3ee' },
  // 酷我 — cyan brand, positioned on lossless "pure" audio.
  kw: { name: '青空纯音', glyph: '青', accent: '#2fc4c0' },
  // 咪咕 — warm orange brand, rooted in the carrier's ringtone catalogue.
  mg: { name: '暖橙彩韵', glyph: '彩', accent: '#f2994a' },
}

/** The alias for a platform id, or `null` for anything that is not one of the five. */
export function platformAlias(id?: string | null): PlatformAlias | null {
  if (!id) return null
  return PLATFORM_ALIASES[id] ?? null
}

/** Alias name when the id is a known platform, otherwise the caller's own fallback. */
export function platformDisplayName(id?: string | null, fallback?: string): string {
  return platformAlias(id)?.name ?? fallback ?? id ?? ''
}

/** One-character badge for a platform, or `null` when the id is not a known platform. */
export function platformGlyph(id?: string | null): string | null {
  return platformAlias(id)?.glyph ?? null
}

/** Badge accent colour for a platform, or `null` when unknown. */
export function platformAccent(id?: string | null): string | null {
  return platformAlias(id)?.accent ?? null
}

/**
 * Inline style for a badge, as a CSS custom property so the tint stays in the stylesheet.
 * `undefined` for a non-platform id, which leaves the badge on its default accent.
 */
export function platformBadgeStyle(id?: string | null): Record<string, string> | undefined {
  const accent = platformAccent(id)
  return accent ? { '--badge-accent': accent } : undefined
}
