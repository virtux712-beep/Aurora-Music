/**
 * Artwork Canvas support: one place that answers three questions about a cover image.
 *
 *  1. **Where is the subject?** `analyzeArtwork` builds an interest map from the image — local
 *     contrast (edge energy), colour saturation, and a mild centre prior — and returns both the
 *     weighted focus point and the box that contains most of the interest.
 *  2. **How do we crop it without cutting that subject?** `focusObjectPosition` solves the crop
 *     the way the browser does it (`object-fit: cover` + `object-position`), so the chosen framing
 *     is a real percentage pair rather than a transform hack: the point of interest ends up inside
 *     the frame, and when the subject genuinely cannot fit (a wide subject in a square frame) the
 *     result says `clipped: true` instead of pretending otherwise.
 *  3. **What if the user brings their own image?** Per-track overrides live in `localStorage`,
 *     downscaled and re-encoded first, because a raw 8 MB photo would blow the quota instantly.
 *
 * The detection is deliberately a heuristic, not a face detector, and the code says so: it is an
 * interest map, and the fallback (centre focus, `confident: false`) is reported to the DOM so the UI
 * never claims a smart crop it did not perform.
 */

export interface Point {
  x: number
  y: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface ArtworkAnalysis {
  /** Where to keep the frame centred, in 0..1 image coordinates. */
  focus: Point
  /** The box holding most of the interest, in 0..1 image coordinates. */
  box: Rect
  /** `false` when the image could not be sampled (no canvas, or a tainted remote cover). */
  confident: boolean
  /** Natural size of the image, so the crop can be solved without loading it a second time. */
  width: number
  height: number
}

export interface CropResult {
  /** Value for the CSS `object-position` property. */
  position: string
  /** How far the image is scaled up by `cover` fitting. */
  scale: number
  /** Scaled image size, in frame pixels. */
  displayWidth: number
  displayHeight: number
  /** The chosen crop window inside the scaled image, in frame pixels. */
  crop: { left: number; top: number }
  /** `true` when the subject box does not fully fit (nothing can be done about it, so we say so). */
  clipped: boolean
}

/** Analysis resolution. 96 catches edge detail without making the loop noticeable. */
const SAMPLE = 96
/** Interest floor: below this the image is flat and a "smart" crop would be a guess. */
const MIN_INTEREST = 0.06
/** Interest mass the returned box must contain (the middle 84% along each axis). */
const BOX_QUANTILE = 0.08

export function centreAnalysis(): ArtworkAnalysis {
  return {
    focus: { x: 0.5, y: 0.5 },
    box: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
    confident: false,
    width: 0,
    height: 0,
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

export function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.decoding = 'async'
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('图片无法加载'))
    image.src = source
  })
}

/**
 * Samples `source` and reports where the interesting part is.
 *
 * Never throws: an image that cannot be read back (a remote cover without CORS headers taints the
 * canvas, which is normal — Aurora does not proxy artwork) yields `centreAnalysis()`.
 */
export async function analyzeArtwork(source: string): Promise<ArtworkAnalysis> {
  try {
    const image = await loadImage(source)
    const natural = { width: image.naturalWidth || image.width, height: image.naturalHeight || image.height }
    const canvas = document.createElement('canvas')
    canvas.width = SAMPLE
    canvas.height = SAMPLE
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) return { ...centreAnalysis(), ...natural }
    context.drawImage(image, 0, 0, SAMPLE, SAMPLE)
    // Throws for a tainted canvas, which is the honest answer for a cross-origin cover.
    const { data } = context.getImageData(0, 0, SAMPLE, SAMPLE)

    const interest = new Float32Array(SAMPLE * SAMPLE)
    let total = 0
    const luma = (index: number): number => 0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2]
    for (let y = 0; y < SAMPLE; y += 1) {
      for (let x = 0; x < SAMPLE; x += 1) {
        const i = (y * SAMPLE + x) * 4
        const right = x + 1 < SAMPLE ? i + 4 : i
        const below = y + 1 < SAMPLE ? i + SAMPLE * 4 : i
        const edge = (Math.abs(luma(i) - luma(right)) + Math.abs(luma(i) - luma(below))) / 255
        const r = data[i] / 255
        const g = data[i + 1] / 255
        const b = data[i + 2] / 255
        const max = Math.max(r, g, b)
        const min = Math.min(r, g, b)
        const saturation = max <= 0 ? 0 : (max - min) / max
        // A vignette-shaped prior: album art subjects sit near the centre far more often than not,
        // but a strong off-centre subject still wins because the prior only scales it by 0.35..1.
        const dx = (x / (SAMPLE - 1) - 0.5) * 2
        const dy = (y / (SAMPLE - 1) - 0.5) * 2
        const distance = Math.min(1, Math.hypot(dx, dy) / Math.SQRT2)
        const prior = 1 - 0.65 * distance
        // Very dark and very blown-out pixels carry no structure worth protecting.
        const midpoint = 1 - Math.abs(luma(i) / 255 - 0.5) * 2
        const value = (edge * 0.58 + saturation * 0.42) * prior * (0.35 + 0.65 * midpoint)
        interest[y * SAMPLE + x] = value
        total += value
      }
    }

    if (total / (SAMPLE * SAMPLE) < MIN_INTEREST) return { ...centreAnalysis(), ...natural }

    let sumX = 0
    let sumY = 0
    let momentum = 0
    for (let y = 0; y < SAMPLE; y += 1) {
      for (let x = 0; x < SAMPLE; x += 1) {
        const value = interest[y * SAMPLE + x]
        if (value <= 0) continue
        momentum += value
        sumX += value * (x + 0.5)
        sumY += value * (y + 0.5)
      }
    }
    const centroid: Point = { x: sumX / momentum / SAMPLE, y: sumY / momentum / SAMPLE }

    // The box is found by trimming the lowest-interest margins on each side until only
    // `1 - 2 * quantile` of the mass is left: implementation-agnostic and stable.
    const columnMass = new Float32Array(SAMPLE)
    const rowMass = new Float32Array(SAMPLE)
    for (let y = 0; y < SAMPLE; y += 1) {
      for (let x = 0; x < SAMPLE; x += 1) {
        const value = interest[y * SAMPLE + x]
        columnMass[x] += value
        rowMass[y] += value
      }
    }
    const trim = (mass: Float32Array): { from: number; to: number } => {
      const target = momentum * BOX_QUANTILE
      let from = 0
      let acc = 0
      while (from < mass.length - 1 && acc + mass[from] < target) {
        acc += mass[from]
        from += 1
      }
      let to = mass.length - 1
      acc = 0
      while (to > from && acc + mass[to] < target) {
        acc += mass[to]
        to -= 1
      }
      return { from: from / SAMPLE, to: (to + 1) / SAMPLE }
    }
    const columns = trim(columnMass)
    const rows = trim(rowMass)
    const box: Rect = {
      x: columns.from,
      y: rows.from,
      width: Math.max(0.05, columns.to - columns.from),
      height: Math.max(0.05, rows.to - rows.from),
    }
    // The box centre is the framing target: it is far more stable than a momentum centroid, which
    // drifts towards whichever corner happens to hold the busiest texture.
    const focus: Point = {
      x: clamp(box.x + box.width / 2, 0, 1),
      y: clamp(box.y + box.height / 2, 0, 1),
    }
    return { focus, box, confident: true, ...natural }
  } catch {
    return centreAnalysis()
  }
}

/**
 * The `object-position` that keeps `focus` — and as much of `box` as possible — inside a
 * `frameWidth × frameHeight` window under `object-fit: cover`.
 *
 * Pure arithmetic on purpose: this is the part that has to be right, and it can be reasoned about
 * (and asserted) without a browser.
 */
export function focusObjectPosition(
  imageWidth: number,
  imageHeight: number,
  frameWidth: number,
  frameHeight: number,
  focus: Point = { x: 0.5, y: 0.5 },
  box?: Rect,
): CropResult {
  const safeWidth = imageWidth > 0 ? imageWidth : 1
  const safeHeight = imageHeight > 0 ? imageHeight : 1
  const scale = Math.max(frameWidth / safeWidth, frameHeight / safeHeight)
  const displayWidth = safeWidth * scale
  const displayHeight = safeHeight * scale
  const slackX = Math.max(0, displayWidth - frameWidth)
  const slackY = Math.max(0, displayHeight - frameHeight)

  // `object-position: p%` maps to offset = p% × slack, so the offset that centres the focus point is
  // simply clamped to the available slack.
  const targetX = focus.x * displayWidth - frameWidth / 2
  const targetY = focus.y * displayHeight - frameHeight / 2
  const left = clamp(targetX, 0, slackX)
  const top = clamp(targetY, 0, slackY)

  const percent = (offset: number, slack: number): number =>
    slack <= 0.5 ? 50 : Math.round((offset / slack) * 1000) / 10

  const region = box ?? { x: focus.x, y: focus.y, width: 0, height: 0 }
  const boxLeft = region.x * displayWidth
  const boxTop = region.y * displayHeight
  const clipped =
    boxLeft < left - 0.5 ||
    boxTop < top - 0.5 ||
    boxLeft + region.width * displayWidth > left + frameWidth + 0.5 ||
    boxTop + region.height * displayHeight > top + frameHeight + 0.5

  return {
    position: `${percent(left, slackX)}% ${percent(top, slackY)}%`,
    scale,
    displayWidth,
    displayHeight,
    crop: { left, top },
    clipped,
  }
}

/* ------------------------------------------------------------------ user artwork overrides */

const STORAGE_KEY = 'aurora.artwork.overrides'
/** Longest edge kept. Big enough for a 340 px frame on a 3× display, small enough to store. */
const MAX_EDGE = 900
const QUALITY = 0.85
/** Newest-first budget: ~200 KB × 12 keeps the whole store inside a typical 5 MB quota. */
const MAX_ENTRIES = 12

interface OverrideEntry {
  dataUrl: string
  updatedAt: number
}

function readStore(): Record<string, OverrideEntry> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, OverrideEntry>
    if (!parsed || typeof parsed !== 'object') return {}
    const clean: Record<string, OverrideEntry> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (value && typeof value.dataUrl === 'string' && value.dataUrl.startsWith('data:image/')) {
        clean[key] = { dataUrl: value.dataUrl, updatedAt: Number(value.updatedAt) || 0 }
      }
    }
    return clean
  } catch {
    // A damaged store must not break the page: start empty and let the next write replace it.
    return {}
  }
}

function writeStore(store: Record<string, OverrideEntry>, dropOldest = true): boolean {
  const entries = Object.entries(store).sort((a, b) => b[1].updatedAt - a[1].updatedAt)
  const kept = dropOldest ? entries.slice(0, MAX_ENTRIES) : entries
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(kept)))
    return true
  } catch {
    return false
  }
}

/** The user's own artwork for a track, if they set one. */
export function getCustomArtwork(trackId: string | undefined): string | undefined {
  if (!trackId) return undefined
  return readStore()[trackId]?.dataUrl
}

export function hasCustomArtwork(trackId: string | undefined): boolean {
  return Boolean(getCustomArtwork(trackId))
}

/**
 * Stores an override. Returns the stored data URL, or `null` when the browser refused to keep it
 * (quota). Callers are expected to surface that rather than silently losing the image.
 */
export function setCustomArtwork(trackId: string, dataUrl: string): string | null {
  const store = readStore()
  store[trackId] = { dataUrl, updatedAt: Date.now() }
  if (writeStore(store)) return dataUrl
  // One honest retry: drop the oldest entries (the current one is newest, so it survives).
  if (writeStore({ [trackId]: store[trackId] }, false)) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ [trackId]: store[trackId] }))
      return dataUrl
    } catch {
      return null
    }
  }
  return null
}

export function clearCustomArtwork(trackId: string): void {
  const store = readStore()
  if (!(trackId in store)) return
  delete store[trackId]
  writeStore(store)
}

/**
 * Downscales and re-encodes a picked file so it can actually be stored.
 *
 * Refuses anything that is not a decodable image, and keeps transparency only for PNG sources —
 * everything else becomes JPEG, which is what makes a phone photo fit in the quota.
 */
export async function prepareArtwork(file: File): Promise<{ dataUrl: string; width: number; height: number }> {
  if (!file.type.startsWith('image/')) throw new Error('请选择图片文件（JPEG / PNG / WebP）')
  const objectUrl = URL.createObjectURL(file)
  try {
    const image = await loadImage(objectUrl)
    const longest = Math.max(image.naturalWidth, image.naturalHeight)
    if (longest <= 0) throw new Error('图片尺寸不可用')
    const scale = Math.min(1, MAX_EDGE / longest)
    const width = Math.max(1, Math.round(image.naturalWidth * scale))
    const height = Math.max(1, Math.round(image.naturalHeight * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('无法处理这张图片')
    context.drawImage(image, 0, 0, width, height)
    const keepsAlpha = file.type === 'image/png' || file.type === 'image/webp'
    const dataUrl = canvas.toDataURL(keepsAlpha ? 'image/webp' : 'image/jpeg', QUALITY)
    if (!dataUrl.startsWith('data:image/')) throw new Error('图片编码失败')
    return { dataUrl, width, height }
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}
