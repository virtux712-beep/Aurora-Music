import { safeMediaUrl } from './url'

/**
 * Cover rendering helper.
 *
 * Tracks and playlists without artwork get a deterministic gradient derived from their id, so the
 * UI never shows an empty grey box — and never pretends to have artwork it does not have (no
 * placeholder images are fetched from the network).
 */
export function hashGradient(seed: string): string {
  let hash = 0
  for (let index = 0; index < seed.length; index += 1) hash = (hash * 31 + seed.charCodeAt(index)) % 360
  return `linear-gradient(140deg, hsl(${hash} 42% 30%), hsl(${(hash + 48) % 360} 46% 52%))`
}

/*
 * Inline style for an element that paints a cover (background-image based components).
 *
 * The URL is validated here rather than at each call site because every background cover in the app
 * funnels through this one function — which makes it the single place where the "this string came
 * from a source, not from us" rule has to hold. A rejected cover falls back to the id gradient.
 */
export function coverStyle(cover: string | undefined, seed: string): Record<string, string> {
  const safe = safeMediaUrl(cover)
  if (safe) return { backgroundImage: `url("${safe}")` }
  return { background: hashGradient(seed) }
}
