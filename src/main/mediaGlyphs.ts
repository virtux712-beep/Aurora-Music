import { nativeImage, type NativeImage } from 'electron'
import { deflateSync } from 'node:zlib'

/**
 * The icons the operating system asks for: tray icon, taskbar thumbnail buttons.
 *
 * These are **drawn here** rather than shipped as files, for two reasons. Practically, it keeps the
 * packaged app from depending on a set of PNGs that has to be regenerated at every size and DPI
 * scale. And deliberately, it means Aurora carries no third-party image assets — the reference
 * player's icon set is copyrighted artwork, and "the app has a pause button on its taskbar" is not a
 * reason to copy it.
 *
 * The output is a real PNG (RGBA, 8-bit) encoded with zlib, so `nativeImage.createFromBuffer` reads
 * it on every platform instead of relying on `createFromBitmap`'s platform-dependent byte order. It
 * is also then *checkable*: a test can read the header back and assert the dimensions.
 *
 * Glyphs are drawn 4× and box-filtered down, which is what keeps the diagonals from looking like
 * stairs at 16px.
 */

const SUPERSAMPLE = 4

/* ------------------------------------------------------------------ PNG encoding */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value
  }
  return table
})()

function crc32(buffer: Buffer): number {
  let crc = -1
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed), 0)
  return Buffer.concat([length, typed, crc])
}

/** RGBA bytes (row-major, top-down) → a PNG buffer. */
function encodePng(rgba: Buffer, width: number, height: number): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // colour type: truecolour + alpha
  header[10] = 0 // deflate
  header[11] = 0 // adaptive filtering
  header[12] = 0 // no interlace

  // Each scanline is prefixed with its filter type; 0 (None) is correct for flat-colour glyphs and
  // keeps this encoder honest — no predictor maths to get wrong.
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/* ------------------------------------------------------------------ tiny raster surface */

interface Surface {
  pixels: Float64Array
  size: number
}

function createSurface(size: number): Surface {
  return { pixels: new Float64Array(size * size), size }
}

function paint(surface: Surface, x: number, y: number, coverage: number): void {
  if (x < 0 || y < 0 || x >= surface.size || y >= surface.size || coverage <= 0) return
  const index = y * surface.size + x
  surface.pixels[index] = Math.min(1, surface.pixels[index] + coverage)
}

/** Axis-aligned rectangle in supersampled coordinates. */
function rect(surface: Surface, x0: number, y0: number, x1: number, y1: number): void {
  const left = Math.max(0, Math.floor(x0))
  const top = Math.max(0, Math.floor(y0))
  const right = Math.min(surface.size, Math.ceil(x1))
  const bottom = Math.min(surface.size, Math.ceil(y1))
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) paint(surface, x, y, 1)
  }
}

/** Filled circle, used for the note head. */
function circle(surface: Surface, cx: number, cy: number, radius: number): void {
  const top = Math.max(0, Math.floor(cy - radius - 1))
  const bottom = Math.min(surface.size, Math.ceil(cy + radius + 1))
  for (let y = top; y < bottom; y += 1) {
    for (let x = top; x < bottom; x += 1) {
      const dx = x + 0.5 - cx
      const dy = y + 0.5 - cy
      if (dx * dx + dy * dy <= radius * radius) paint(surface, x, y, 1)
    }
  }
}

/**
 * A right-pointing triangle, by scanline.
 *
 * `flip` mirrors it horizontally (for previous/next, which are the same shape facing the other way).
 */
function triangle(
  surface: Surface,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  flip: boolean,
): void {
  const height = y1 - y0
  for (let y = Math.floor(y0); y < Math.ceil(y1); y += 1) {
    const t = (y + 0.5 - y0) / height
    // Widest at the vertical centre, tapering to a point at both ends.
    const half = 1 - Math.abs(t * 2 - 1)
    const width = (x1 - x0) * half
    if (flip) rect(surface, x1 - width, y, x1, y + 1)
    else rect(surface, x0, y, x0 + width, y + 1)
  }
}

/** Supersampled coverage → RGBA at the glyph's real size, tinted to one solid colour. */
function resolve(surface: Surface, size: number, rgb: [number, number, number]): Buffer {
  const out = Buffer.alloc(size * size * 4)
  const scale = surface.size / size
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let sum = 0
      for (let sy = 0; sy < scale; sy += 1) {
        for (let sx = 0; sx < scale; sx += 1) {
          sum += surface.pixels[(y * scale + sy) * surface.size + (x * scale + sx)]
        }
      }
      const alpha = Math.round((sum / (scale * scale)) * 255)
      const index = (y * size + x) * 4
      out[index] = rgb[0]
      out[index + 1] = rgb[1]
      out[index + 2] = rgb[2]
      out[index + 3] = alpha
    }
  }
  return out
}

/* ------------------------------------------------------------------ glyphs */

export type GlyphName = 'play' | 'pause' | 'next' | 'previous' | 'note'

/**
 * Draws one glyph at `size` px. `color` defaults to white, which is what both the Windows taskbar
 * (dark) and the tray expect; a light-theme tray can ask for a dark tint.
 */
export function glyphPng(name: GlyphName, size = 16, color: [number, number, number] = [255, 255, 255]): Buffer {
  const canvas = size * SUPERSAMPLE
  const surface = createSurface(canvas)
  // Inset so the strokes do not touch the edge; a glyph drawn edge-to-edge reads as a blob.
  const pad = canvas * 0.12
  const left = pad
  const right = canvas - pad
  const top = pad
  const bottom = canvas - pad
  const middle = (top + bottom) / 2
  const stroke = Math.max(1, canvas * 0.11)

  switch (name) {
    case 'play':
      triangle(surface, left, right, top, bottom, false)
      break
    case 'pause':
      rect(surface, left, top, left + (right - left) * 0.34, bottom)
      rect(surface, right - (right - left) * 0.34, top, right, bottom)
      break
    case 'next':
      triangle(surface, left, right - stroke * 1.6, top, bottom, false)
      rect(surface, right - stroke, top, right, bottom)
      break
    case 'previous':
      // `next` reflected: bar on the left, apex pointing left.
      rect(surface, left, top, left + stroke, bottom)
      triangle(surface, left + stroke * 1.6, right, top, bottom, true)
      break
    case 'note':
      // An eighth note: head at lower-left, stem up the right side, small flag at the top.
      circle(surface, left + (right - left) * 0.3, bottom - (bottom - top) * 0.2, (bottom - top) * 0.26)
      rect(surface, left + (right - left) * 0.47, top, left + (right - left) * 0.62, bottom - (bottom - top) * 0.2)
      rect(
        surface,
        left + (right - left) * 0.62,
        top,
        left + (right - left) * 0.95,
        middle - (bottom - top) * 0.06,
      )
      break
    default: {
      // Exhaustive: a new glyph must be added here rather than silently rendering nothing.
      const never: never = name
      throw new Error(`unknown glyph: ${String(never)}`)
    }
  }

  return encodePng(resolve(surface, size, color), size, size)
}

export function glyphImage(name: GlyphName, size = 16, color?: [number, number, number]): NativeImage {
  return nativeImage.createFromBuffer(glyphPng(name, size, color))
}

/**
 * The application mark used by the tray, at the size Windows asks for.
 *
 * Kept separate from the player transport glyphs because it is the same note shape at multiple sizes
 * in future, and because the renderer/UI asset (if it ever exists) is a different concern.
 */
export function trayImage(size = 32): NativeImage {
  return glyphImage('note', size)
}

export { encodePng as encodePngForTest }
