/**
 * Generates Aurora's application icon from code, so the asset is reproducible instead of a binary
 * blob nobody can regenerate.
 *
 * The mark is **a record standing in the aurora**. Four layers, back to front:
 *
 *  1. an OLED-black glass plate, with two colour fields bleeding into it (violet upper-left, teal
 *     upper-right) and a handful of stars to give the glass something to be glass *over*;
 *  2. a vinyl disc — grooves, pressing rings, a metallic rim that catches the light, and a tiny
 *     spectrum ring ticking around its edge;
 *  3. one sweeping aurora ribbon, drawn as a curtain (vertical folds, hot core, wide faint halo)
 *     that runs from low-left in violet up to high-right in cyan, plus a hairline light trail
 *     arcing above it;
 *  4. a horizon with a reflective floor: the bright line is what turns the plate into a *space*
 *     instead of a swatch, and the curved trails below it are the ribbon's own light coming back
 *     off the ground. The disc's bottom sits behind that line, which is what makes it look like it
 *     is standing in the light rather than pasted on the plate.
 *
 * The composition is deliberately top-heavy-dark and centre-concentrated: the previous revision
 * measured 0.361 mean luminance with only 3% near-black, i.e. a grey wash where the aurora should
 * have been reading *against* the black. Everything luminous here is scoped — halo opacity, ribbon
 * width, floor depth and the vignette all pull the eye to the middle third.
 *
 * All of it is analytic (signed distances, smoothstep falloffs, no noise) and rendered from the
 * master *down*, so the small frames are box-filtered from the 1024 master rather than re-drawn at
 * a size where fine detail collapses into noise.
 *
 * Outputs:
 *   build/icon.png       1024x1024 master (packaging reads this, and it is the reference art)
 *   build/icon.ico       BMP-in-ICO at 16/24/32/48/64/128/256
 *   build/icon-256.png   the sizes that matter for legibility, written out so they can be eyeballed
 *   build/icon-128.png
 *   build/icon-64.png
 *
 * The .ico entries are uncompressed DIBs rather than PNGs on purpose: PNG-compressed entries are only
 * reliably honoured by Windows at 256px, and a blank taskbar icon is exactly the kind of thing nobody
 * notices until release.
 *
 *   node tools/make-icon.mjs
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const OUT_DIR = join(process.cwd(), 'build')
/**
 * Supersampling factor at the master size.
 *
 * The master is 1024 rather than 512 precisely so this can be low: the extra resolution already
 * resolves the curves, and the ICO frames are box-filtered from it, which is where the clean small
 * sizes come from. Cranking supersampling at 1024 would multiply the render time for edges that are
 * then averaged away anyway.
 */
const SUPER = 3
const BASE = 1024

/* ------------------------------------------------------------------ drawing maths */

const clamp01 = (value) => (value < 0 ? 0 : value > 1 ? 1 : value)
const mix = (from, to, t) => from + (to - from) * t

function smoothstep(edge0, edge1, value) {
  const t = clamp01((value - edge0) / (edge1 - edge0 || 1e-6))
  return t * t * (3 - 2 * t)
}

const mixColor = (a, b, t) => ({
  r: mix(a.r, b.r, t),
  g: mix(a.g, b.g, t),
  b: mix(a.b, b.b, t),
})

/** Signed distance to a rounded box: negative inside, zero on the edge. */
function roundedBoxDistance(x, y, box) {
  const cx = Math.min(Math.max(x, box.x0 + box.r), box.x1 - box.r)
  const cy = Math.min(Math.max(y, box.y0 + box.r), box.y1 - box.r)
  return Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy)) - box.r
}

/* ------------------------------------------------------------------ palette */

/** OLED ink, lit from the top-left. Kept genuinely near-black: everything luminous above has to
 * read *against* it, and a mid-grey plate loses the whole point of the material. */
const INK_TOP = { r: 10, g: 11, b: 22 }
const INK_BOTTOM = { r: 3, g: 4, b: 9 }
/** Aurora colours: the sky end and the sound end of the same idea. */
const VIOLET = { r: 150, g: 92, b: 255 }
const INDIGO = { r: 74, g: 108, b: 255 }
const CYAN = { r: 88, g: 216, b: 255 }
const TEAL = { r: 88, g: 244, b: 216 }
const WHITE = { r: 240, g: 249, b: 255 }
/** The label is a three-stop gradient, so it reads as pressed foil rather than a flat disc. */
const LABEL_A = { r: 126, g: 230, b: 255 }
const LABEL_B = { r: 148, g: 128, b: 255 }
const LABEL_C = { r: 232, g: 118, b: 230 }

const PLATE = { x0: 0.03, y0: 0.03, x1: 0.97, y1: 0.97, r: 0.225 }
/** The record sits high: the horizon underneath it needs room, or the plate reads as a flat badge. */
const DISC = { cx: 0.5, cy: 0.435, r: 0.286 }
const LABEL_R = 0.104
const SPINDLE_R = 0.019
/** Where the light line that turns the plate into a space lives. Below the label, on purpose. */
const HORIZON_Y = 0.686

/** Sparse, fixed sparkles: the plate needs something to be glass *over*. Kept faint — a bright
 * starfield is what made the first revision read as noise rather than as depth. */
const STARS = [
  [0.148, 0.17, 0.62],
  [0.268, 0.108, 0.4],
  [0.742, 0.128, 0.46],
  [0.878, 0.262, 0.34],
  [0.108, 0.402, 0.28],
]

/** The aurora flow: low on the left, rising across the plate to exit high on the right. */
function auroraY(x) {
  return 0.622 - 0.30 * smoothstep(0.02, 0.62, x) - 0.086 * smoothstep(0.62, 0.98, x)
}

/** The hairline trail: a near-straight arc above the ribbon, like a long-exposure light path. */
function trailY(x) {
  return 0.497 - 0.152 * smoothstep(0.06, 0.9, x) + 0.016 * Math.sin(x * Math.PI * 1.6)
}

/**
 * One ribbon, sampled as a soft band around its own centreline.
 *
 * `half` is the core thickness and `glow` the much wider halo it throws on the plate — the halo is
 * what makes the ribbon look emissive instead of painted. The halo is deliberately faint: at 0.2+
 * two ribbons wash the whole plate to mid-grey and the record stops reading as a dark object at all.
 * `fold` adds the vertical curtain striation; it is *intensity* modulation rather than a positional
 * wobble so the edges stay crisp.
 */
function ribbon(x, y, centreAt, x0, x1, halfAt, glow, fold) {
  const along = clamp01((x - x0) / (x1 - x0))
  const ends = smoothstep(0, 0.16, along) * smoothstep(1, 0.84, along)
  if (ends <= 0) return null
  const d = Math.abs(y - centreAt(x))
  const half = halfAt(along)
  const core = 1 - smoothstep(half * 0.22, half, d)
  const halo = (1 - smoothstep(half, glow, d)) * 0.085
  const intensity = Math.min(1, core + halo) * ends * (fold ? fold(x) : 1)
  return intensity > 0.002 ? { intensity: Math.min(1, intensity), core: core * ends } : null
}

/** The curtain folds: two incommensurate frequencies so the striation never looks like a ruler. */
const curtainFold = (x) => 0.7 + 0.17 * Math.sin(x * 148 + 1.1) + 0.13 * Math.sin(x * 61 + 2.4)

/* ------------------------------------------------------------------ the mark */

/**
 * The mark at unit coordinates, drawn back to front.
 *
 * Returns `null` where nothing is drawn (so the caller keeps the pixel transparent), otherwise
 * `{ r, g, b, a }` with `a` defaulting to full opacity. The only layer allowed to be translucent is
 * the outer halo, which lives outside the plate.
 */
function sample(x, y) {
  const plateDistance = roundedBoxDistance(x, y, PLATE)

  // ---- outer halo: a breath of the aurora escaping the plate, brightest along the light's own
  // direction (up and to the right) so the plate looks lit rather than socked in glow.
  if (plateDistance > 0) {
    if (plateDistance > 0.032) return null
    const falloff = 1 - smoothstep(0, 0.032, plateDistance)
    const side = 0.5 + 0.5 * Math.cos(Math.atan2(y - 0.52, x - 0.5) + 0.35)
    return { r: 76, g: 146, b: 255, a: falloff * falloff * (0.16 + 0.24 * side) }
  }

  // ---- glass plate: OLED ink with colour fields bleeding into it.
  let colour = mixColor(INK_TOP, INK_BOTTOM, smoothstep(0, 1, clamp01((y - PLATE.y0) / 0.94)))
  const violetField = Math.sqrt((x - 0.16) * (x - 0.16) + (y - 0.13) * (y - 0.13))
  const tealField = Math.sqrt((x - 0.86) * (x - 0.86) + (y - 0.2) * (y - 0.2))
  colour = mixColor(colour, { r: 46, g: 24, b: 96 }, (1 - smoothstep(0, 0.58, violetField)) * 0.34)
  colour = mixColor(colour, { r: 6, g: 44, b: 70 }, (1 - smoothstep(0, 0.52, tealField)) * 0.3)

  for (const [starX, starY, strength] of STARS) {
    const distance = Math.sqrt((x - starX) * (x - starX) + (y - starY) * (y - starY))
    if (distance > 0.024) continue
    const sparkle = (1 - smoothstep(0, 0.022, distance)) ** 2 * strength
    colour = mixColor(colour, WHITE, sparkle * 0.6)
  }

  // ---- the record.
  const dx = x - DISC.cx
  const dy = y - DISC.cy
  const radius = Math.sqrt(dx * dx + dy * dy)
  const angle = Math.atan2(dy, dx)
  // Light sits up and to the left, so the sheen runs from ~-135°.
  const light = 0.5 + 0.5 * Math.cos(angle + 2.4)

  if (radius <= DISC.r) {
    // Vinyl body, with an angular sheen so it never reads as a flat black circle. The base is a
    // touch above the plate ink on purpose: at 64 px a disc the same value as its background simply
    // disappears, and "一跟识别是唱片" is the whole point of having a record in the mark.
    let disc = mixColor({ r: 8, g: 9, b: 18 }, { r: 30, g: 38, b: 64 }, 0.25 + light * 0.5)
    // Grooves. Deliberately coarse: a 1 px groove would alias, a ~17 px one becomes the soft radial
    // texture that reads as vinyl at 256 px and averages into a smooth disc at 64.
    const band = smoothstep(DISC.r * 0.28, DISC.r * 0.44, radius) * (1 - smoothstep(DISC.r * 0.95, DISC.r, radius))
    disc = mixColor(disc, { r: 66, g: 88, b: 134 }, (0.5 + 0.5 * Math.sin(radius * 232)) * band * 0.13)
    // Track separations: three slightly brighter rings, like a real pressing.
    for (const ringRadius of [0.134, 0.196, 0.256]) {
      const ring = 1 - Math.min(1, Math.abs(radius - ringRadius) / 0.0045)
      if (ring > 0) disc = mixColor(disc, { r: 120, g: 148, b: 198 }, ring * ring * 0.28)
    }
    // Metal edge: brightest where the light is, but never falling below a readable ring — a rim that
    // only exists on one side turns the disc back into an invisible blob at small sizes.
    const rim = smoothstep(DISC.r - 0.019, DISC.r - 0.002, radius)
    disc = mixColor(disc, { r: 176, g: 206, b: 250 }, rim * (0.28 + 0.58 * light))
    colour = disc
  } else if (radius < DISC.r + 0.045) {
    // A whisper of the disc's own light on the plate, so it sits *in* the glass.
    colour = mixColor(colour, INDIGO, (1 - smoothstep(DISC.r, DISC.r + 0.045, radius)) * 0.08)
  }

  // ---- spectrum ring: short radial ticks just outside the rim. Faint on purpose — it is the
  // "there is sound here" clue, not a graphic equaliser.
  if (radius > DISC.r - 0.004 && radius < DISC.r + 0.026) {
    const tick = 0.5 + 0.5 * Math.sin(angle * 46)
    const reach = 0.5 + 0.5 * Math.sin(angle * 9 + 0.7)
    const within = smoothstep(DISC.r + 0.026, DISC.r + 0.008, radius)
    colour = mixColor(colour, CYAN, tick ** 2 * reach * within * 0.28)
  }

  // ---- the aurora ribbon, drawn over the record.
  const flow = ribbon(x, y, auroraY, 0.03, 1.0, (along) => 0.046 + 0.026 * along, 0.086, curtainFold)
  if (flow) {
    const tone = mixColor(VIOLET, INDIGO, smoothstep(0, 0.5, x))
    const bright = mixColor(tone, CYAN, smoothstep(0.4, 0.94, x))
    const lit = mixColor(bright, TEAL, smoothstep(0.88, 1, x))
    colour = mixColor(colour, lit, flow.intensity * 0.88)
    // A hot core inside the band: this is what makes it look like light, not like a stripe.
    colour = mixColor(colour, WHITE, flow.core * 0.5 * clamp01((x - 0.16) / 0.84))
  }

  // ---- the hairline light trail above it.
  const trail = ribbon(x, y, trailY, 0.05, 0.99, () => 0.0042, 0.03, null)
  if (trail) {
    colour = mixColor(colour, mixColor(CYAN, WHITE, 0.45), trail.intensity * 0.5)
  }

  // ---- the horizon: the single brightest, thinnest thing in the icon, and the reason the plate
  // reads as a space with a floor.
  const horizonDistance = Math.abs(y - HORIZON_Y)
  if (horizonDistance < 0.11) {
    // Tapered toward the plate edges so the line sits *inside* the glass instead of crossing it.
    const span = smoothstep(PLATE.x0, PLATE.x0 + 0.09, x) * smoothstep(PLATE.x1, PLATE.x1 - 0.09, x)
    // A flare just right of centre, where the ribbon's light meets the ground.
    const flare = 1 - smoothstep(0, 0.2, Math.abs(x - 0.61))
    const glow = (1 - smoothstep(0, 0.052, horizonDistance)) * (0.4 + 0.6 * flare)
    const core = 1 - smoothstep(0.001, 0.0065, horizonDistance)
    colour = mixColor(colour, { r: 96, g: 200, b: 255 }, glow * 0.5 * span)
    colour = mixColor(colour, { r: 214, g: 245, b: 255 }, core * 0.85 * span * (0.5 + 0.5 * flare))
  }

  // ---- the reflective floor: the ribbon's light coming back off the ground.
  if (y > HORIZON_Y) {
    const depth = y - HORIZON_Y
    const near = 1 - smoothstep(0, 0.30, depth)
    colour = mixColor(colour, { r: 16, g: 58, b: 116 }, near * near * 0.5)
    // Broad horizontal shimmer, only in the top of the floor.
    const streak =
      (0.5 + 0.5 * Math.sin(depth * 54 + x * 4.6)) *
      smoothstep(0, 0.012, depth) *
      (1 - smoothstep(0.09, 0.26, depth))
    colour = mixColor(colour, { r: 118, g: 218, b: 255 }, streak * 0.17)
    // Curved trails sweeping toward the viewer, the way reflections stretch on a wet floor.
    for (const [spread, offset, alpha] of [
      [1.5, 0.05, 0.34],
      [1.9, 0.115, 0.24],
      [2.5, 0.185, 0.15],
    ]) {
      const trailDistance = Math.abs(y - (HORIZON_Y + offset + spread * Math.abs(x - 0.66) ** 1.7))
      const line = 1 - smoothstep(0, 0.0065, trailDistance)
      if (line > 0) {
        colour = mixColor(
          colour,
          mixColor({ r: 130, g: 206, b: 255 }, { r: 150, g: 132, b: 255 }, smoothstep(0.55, 0.12, x)),
          line * alpha * (1 - smoothstep(0.2, 0.4, depth)),
        )
      }
    }
  }

  // ---- the label: the one saturated element, and where the identity lives.
  if (radius <= LABEL_R + 0.011) {
    if (radius <= LABEL_R) {
      const across = clamp01((x - (DISC.cx - LABEL_R)) / (LABEL_R * 2))
      const down = clamp01((y - (DISC.cy - LABEL_R)) / (LABEL_R * 2))
      let label = mixColor(LABEL_A, LABEL_B, across)
      label = mixColor(label, LABEL_C, down * 0.5)
      // Shade the label's own lower-right so it looks domed under the same light as everything else.
      label = mixColor(label, { r: 38, g: 24, b: 78 }, (1 - light) * 0.32)
      colour = label
    } else {
      const ring = 1 - smoothstep(LABEL_R + 0.002, LABEL_R + 0.011, radius)
      colour = mixColor(colour, WHITE, ring * 0.42)
    }
  }

  // ---- spindle: a real hole, with a rim that catches the light.
  if (radius <= SPINDLE_R) {
    const spindleLight = smoothstep(SPINDLE_R * 0.35, SPINDLE_R, radius)
    colour = mixColor({ r: 8, g: 10, b: 18 }, { r: 210, g: 230, b: 255 }, spindleLight * 0.72)
  }

  // ---- 金属边缘 + glass sheen on top of everything, so the plate reads as a pane.
  //
  // `plateDistance` is negative inside, so the rim ramp has to run off the *negated* distance:
  // writing `1 - smoothstep(-0.018, -0.003, plateDistance)` looks equivalent but is not — that form
  // evaluates to 1 across the entire interior and paints the whole plate 70% metal, which is what
  // turned every earlier revision into a grey wash (mean luminance 0.36, 3% near-black).
  const plateRim = 1 - smoothstep(0.0035, 0.019, -plateDistance)
  if (plateRim > 0) {
    const edgeLight = clamp01(1 - ((x - 0.12) * 0.7 + (y - 0.06) * 1.05))
    colour = mixColor(
      colour,
      { r: mix(72, 232, edgeLight), g: mix(108, 244, edgeLight), b: mix(208, 255, edgeLight) },
      plateRim * (0.2 + 0.6 * edgeLight),
    )
  }
  const sheen = 1 - smoothstep(0, 0.42, Math.abs(x * 0.78 + y * 0.62 - 0.36))
  colour = mixColor(colour, { r: 198, g: 220, b: 255 }, sheen * 0.022)

  // ---- vignette: darkens the corners and keeps the eye on the record.
  const corner = Math.sqrt((x - 0.5) * (x - 0.5) + (y - 0.5) * (y - 0.5))
  const vignette = mix(0.72, 1, 1 - smoothstep(0.4, 0.76, corner))
  return { r: colour.r * vignette, g: colour.g * vignette, b: colour.b * vignette, a: 1 }
}

/* ------------------------------------------------------------------ rasteriser */

/** Renders the mark into an RGBA buffer of `size` x `size`. */
function render(size) {
  const pixels = Buffer.alloc(size * size * 4)
  const step = 1 / (size * SUPER)
  const half = step / 2
  const total = SUPER * SUPER

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0
      let g = 0
      let b = 0
      let alpha = 0
      for (let sy = 0; sy < SUPER; sy += 1) {
        for (let sx = 0; sx < SUPER; sx += 1) {
          const colour = sample((px * SUPER + sx) * step + half, (py * SUPER + sy) * step + half)
          if (!colour) continue
          // Premultiplied accumulation: the halo is translucent, so colour has to be weighted by it
          // or the edge picks up a grey fringe.
          const a = colour.a ?? 1
          r += colour.r * a
          g += colour.g * a
          b += colour.b * a
          alpha += a
        }
      }
      const offset = (py * size + px) * 4
      if (alpha === 0) continue
      pixels[offset] = Math.round(Math.min(255, r / alpha))
      pixels[offset + 1] = Math.round(Math.min(255, g / alpha))
      pixels[offset + 2] = Math.round(Math.min(255, b / alpha))
      pixels[offset + 3] = Math.round((alpha / total) * 255)
    }
  }
  return pixels
}

/** Box-filters an RGBA buffer down to `size` (used to make the ICO frames from the master). */
function downscale(source, sourceSize, size) {
  const out = Buffer.alloc(size * size * 4)
  const ratio = sourceSize / size
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let count = 0
      for (let sy = Math.floor(y * ratio); sy < Math.floor((y + 1) * ratio); sy += 1) {
        for (let sx = Math.floor(x * ratio); sx < Math.floor((x + 1) * ratio); sx += 1) {
          const offset = (sy * sourceSize + sx) * 4
          const alpha = source[offset + 3] / 255
          r += source[offset] * alpha
          g += source[offset + 1] * alpha
          b += source[offset + 2] * alpha
          a += alpha
          count += 1
        }
      }
      const offset = (y * size + x) * 4
      if (a === 0 || count === 0) continue
      out[offset] = Math.round(r / a)
      out[offset + 1] = Math.round(g / a)
      out[offset + 2] = Math.round(b / a)
      out[offset + 3] = Math.round((a / count) * 255)
    }
  }
  return out
}

/* ------------------------------------------------------------------ encoders */

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

/** Minimal PNG writer: 8-bit RGBA, no interlacing. */
function encodePng(pixels, size) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // colour type: RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0 // filter: none
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** One ICO entry: a 32-bit DIB with the mandatory (empty) AND mask. */
function encodeDib(pixels, size) {
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(size, 4)
  header.writeInt32LE(size * 2, 8) // height is doubled: colour + mask
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)
  const colour = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const from = ((size - 1 - y) * size + x) * 4 // DIB rows run bottom-up
      const to = (y * size + x) * 4
      colour[to] = pixels[from + 2] // BGRA
      colour[to + 1] = pixels[from + 1]
      colour[to + 2] = pixels[from]
      colour[to + 3] = pixels[from + 3]
    }
  }
  const mask = Buffer.alloc((size * size) / 8) // every bit 0 = "use the alpha channel"
  return Buffer.concat([header, colour, mask])
}

function encodeIco(frames) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(frames.length, 4)
  const directory = Buffer.alloc(16 * frames.length)
  let offset = header.length + directory.length
  frames.forEach((frame, index) => {
    const at = index * 16
    directory[at] = frame.size >= 256 ? 0 : frame.size
    directory[at + 1] = frame.size >= 256 ? 0 : frame.size
    directory[at + 2] = 0 // palette
    directory[at + 3] = 0
    directory.writeUInt16LE(1, at + 4)
    directory.writeUInt16LE(32, at + 6)
    directory.writeUInt32LE(frame.data.length, at + 8)
    directory.writeUInt32LE(offset, at + 12)
    offset += frame.data.length
  })
  return Buffer.concat([header, directory, ...frames.map((frame) => frame.data)])
}

/* ------------------------------------------------------------------ main */

const started = Date.now()
const master = render(BASE)
mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(join(OUT_DIR, 'icon.png'), encodePng(master, BASE))

const sizes = [16, 24, 32, 48, 64, 128, 256]
const frames = sizes.map((size) => ({ size, data: encodeDib(downscale(master, BASE, size), size) }))
writeFileSync(join(OUT_DIR, 'icon.ico'), encodeIco(frames))

// The sizes a reviewer actually judges legibility at, written out as PNGs so they can be looked at
// instead of taken on faith. They are generated from the master, never re-rendered.
for (const size of [256, 128, 64]) {
  writeFileSync(join(OUT_DIR, `icon-${size}.png`), encodePng(downscale(master, BASE, size), size))
}

console.log(`build/icon.png     ${BASE}x${BASE}  (${Date.now() - started}ms)`)
console.log(`build/icon.ico     ${sizes.join(' / ')}  (${frames.reduce((sum, frame) => sum + frame.data.length, 0)} bytes of DIB data)`)
console.log('build/icon-256.png · build/icon-128.png · build/icon-64.png')
