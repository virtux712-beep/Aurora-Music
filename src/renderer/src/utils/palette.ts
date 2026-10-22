/**
 * Dominant-colour extraction for the ambient backdrop.
 *
 * The immersive page wants the *song's* colours, not a fixed theme, so it reads them off the cover:
 * the artwork is drawn small, quantised, and scored, and the three best colours come back as hex.
 *
 * Two honest failure modes matter here and both are handled by falling back rather than pretending:
 *
 *  - there is no cover (a local file without artwork, or a track still loading); and
 *  - the cover cannot be read back — a remote cover without CORS headers taints the canvas and
 *    `getImageData` throws. Aurora does not proxy artwork, so tainting is normal, not exceptional.
 *
 * In either case a deterministic palette derived from the track id is used, which is the same idea as
 * `hashGradient` in `utils/cover.ts`: never a grey box, never invented artwork.
 */

/** How many words of cache to keep. Covers repeat constantly (queue cycling, view re-entry). */
const CACHE_LIMIT = 32
const cache = new Map<string, string[]>()

/** Sample resolution. 40×40 is plenty to find a dominant colour and keeps this off the main thread budget. */
const SAMPLE = 40
/** Colours this close to black or white say nothing about the song, so they are skipped. */
const MIN_LUMA = 24
const MAX_LUMA = 232
/** Below this saturation a pixel is grey noise; averaging it in just muddies the result. */
const MIN_SATURATION = 0.12
/** Channel quantisation: 4 bits per channel, i.e. 16 steps. */
const BUCKET = 16

function hslToHex(hue: number, saturation: number, lightness: number): string {
  const a = saturation * Math.min(lightness, 1 - lightness)
  const channel = (n: number): number => {
    const k = (n + hue / 30) % 12
    const value = lightness - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)))
    return Math.round(255 * value)
  }
  return `#${[channel(0), channel(8), channel(4)].map((value) => value.toString(16).padStart(2, '0')).join('')}`
}

/**
 * Deterministic fallback palette. Three hues 47° apart read as a related set rather than three
 * unrelated colours, which is what makes it look intentional instead of random.
 */
export function paletteFromSeed(seed: string): string[] {
  let hash = 0
  for (let index = 0; index < seed.length; index += 1) hash = (hash * 31 + seed.charCodeAt(index)) % 360
  return [hslToHex(hash, 0.42, 0.36), hslToHex((hash + 47) % 360, 0.5, 0.28), hslToHex((hash + 94) % 360, 0.34, 0.46)]
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    // No `crossOrigin`: a remote cover that does not send CORS headers would then fail to *load*,
    // and a cover that displays but cannot be sampled is strictly better than one that does not show.
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('cover could not be loaded'))
    image.src = source
  })
}

function score(pixels: Uint8ClampedArray): string[] {
  const buckets = new Map<number, { count: number; r: number; g: number; b: number }>()
  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index + 3] < 128) continue // transparent padding
    const r = pixels[index]
    const g = pixels[index + 1]
    const b = pixels[index + 2]
    const max = Math.max(r, g, b) / 255
    const min = Math.min(r, g, b) / 255
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b
    if (luma < MIN_LUMA || luma > MAX_LUMA) continue
    const lightness = (max + min) / 2
    const saturation = max === min ? 0 : (max - min) / (lightness > 0.5 ? 2 - max - min : max + min)
    if (saturation < MIN_SATURATION) continue

    const key = ((r / BUCKET) << 8) | ((g / BUCKET) << 4) | (b / BUCKET)
    const bucket = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 }
    bucket.count += 1
    bucket.r += r
    bucket.g += g
    bucket.b += b
    buckets.set(key, bucket)
  }

  return [...buckets.values()]
    // Popular *and* colourful wins: a huge dull field should not outrank a small vivid accent.
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)
    .map(
      (bucket) =>
        `#${[bucket.r / bucket.count, bucket.g / bucket.count, bucket.b / bucket.count]
          .map((value) => Math.round(value).toString(16).padStart(2, '0'))
          .join('')}`,
    )
}

/**
 * The three colours to paint the backdrop with. Never rejects: a cover that cannot be sampled simply
 * yields the deterministic palette.
 */
export async function extractPalette(cover: string | undefined, seed: string): Promise<string[]> {
  const fallback = paletteFromSeed(seed)
  if (!cover) return fallback

  const cached = cache.get(cover)
  if (cached) return cached

  try {
    const image = await loadImage(cover)
    const canvas = document.createElement('canvas')
    canvas.width = SAMPLE
    canvas.height = SAMPLE
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) return fallback
    context.drawImage(image, 0, 0, SAMPLE, SAMPLE)
    const found = score(context.getImageData(0, 0, SAMPLE, SAMPLE).data)
    if (found.length === 0) return fallback

    // Pad a short result with the seed colours so callers can always rely on three entries.
    const palette = [...found, ...fallback].slice(0, 3)
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string)
    cache.set(cover, palette)
    return palette
  } catch {
    // Tainted canvas or a broken image URL. The fallback is deliberately *not* cached: the same
    // cover may become readable later (e.g. once the media protocol has served it) .
    return fallback
  }
}
