/*
 * Colour maths for the theme system.
 *
 * A skin declares about ten meaningful colours per mode (background, surface, text, accent…) and the
 * rest of the token set is *derived* from them. That is not laziness: a hand-written 21-token table
 * per skin per mode is 200+ values that no one can keep coherent, and the failure mode is the one
 * users notice instantly — a card that is slightly the wrong shade of the background, or a border
 * that only looks right in one mode.
 *
 * Every function here works on hex or `rgb()` input and returns hex, so the output is always safe to
 * put in a custom property (see `shared/theme.ts` for why that matters).
 */

interface Rgb {
  r: number
  g: number
  b: number
}

function parse(color: string): Rgb {
  // A non-string here would be a caller bug, and the honest failure is a readable colour rather than a
  // thrown TypeError: this runs while the app is applying a theme, where an exception means a blank
  // window (the token would be emitted as `undefined`).
  const value = typeof color === 'string' ? color.trim() : ''
  if (value.startsWith('#')) {
    const hex = value.slice(1)
    const expand = hex.length === 3 ? hex.split('').map((char) => char + char).join('') : hex
    const int = Number.parseInt(expand.slice(0, 6), 16)
    return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 }
  }
  const match = value.match(/(\d+(?:\.\d+)?)/g)
  if (match && match.length >= 3) {
    return { r: Number(match[0]), g: Number(match[1]), b: Number(match[2]) }
  }
  return { r: 0, g: 0, b: 0 }
}

function hex({ r, g, b }: Rgb): string {
  const channel = (value: number): string =>
    Math.round(Math.min(255, Math.max(0, value)))
      .toString(16)
      .padStart(2, '0')
  return `#${channel(r)}${channel(g)}${channel(b)}`
}

/** `amount` 0 → `from`, 1 → `to`. */
export function mix(from: string, to: string, amount: number): string {
  const a = parse(from)
  const b = parse(to)
  const ratio = Math.min(1, Math.max(0, amount))
  return hex({
    r: a.r + (b.r - a.r) * ratio,
    g: a.g + (b.g - a.g) * ratio,
    b: a.b + (b.b - a.b) * ratio,
  })
}

/** Same colour, given opacity. Emitted as `rgba()` so it composites over whatever is behind it. */
export function alpha(color: string, opacity: number): string {
  const { r, g, b } = parse(color)
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${Math.round(opacity * 100) / 100})`
}

/** Relative luminance, for deciding whether text on a surface must be dark or light. */
export function luminance(color: string): number {
  const { r, g, b } = parse(color)
  const channel = (value: number): number => {
    const scaled = value / 255
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}
