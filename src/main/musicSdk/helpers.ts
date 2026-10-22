/**
 * Formatting helpers the platform search back-ends rely on.
 *
 * These are ports of the small pure functions `lx-music-desktop` keeps in
 * `src/common/utils/common.ts` and `src/renderer/utils/musicSdk/utils.js`. They are re-implemented
 * here (not copied as a module) so the output stays byte-identical to what published LX sources
 * expect while the surrounding code is Aurora's own.
 */
import { createHash } from 'node:crypto'

/** Two-digit zero padding, exactly as LX's `numFix`. */
export function numFix(value: number): string {
  return value < 10 ? `0${value}` : value.toString()
}

/**
 * Seconds → `mm:ss`, or `--/--` for zero.
 *
 * The odd part is deliberate: LX renders an unknown duration as `--/--` and published sources pass
 * that string straight through to their own display logic, so returning `00:00` here would be a
 * visible difference from LX.
 */
export function formatPlayTime(time: number): string {
  const minutes = Math.trunc(time / 60)
  const seconds = Math.trunc(time % 60)
  return minutes === 0 && seconds === 0 ? '--/--' : `${numFix(minutes)}:${numFix(seconds)}`
}

export function formatPlayTime2(time: number): string {
  return `${numFix(Math.trunc(time / 60))}:${numFix(Math.trunc(time % 60))}`
}

/** Bytes → `1.23 MiB`, using the same base-1024 units LX displays. */
export function sizeFormate(size: number): string {
  if (!size) return '0 B'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  const index = Math.floor(Math.log(size) / Math.log(1024))
  return `${(size / Math.pow(1024, Math.floor(index))).toFixed(2)} ${units[index]}`
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  hellip: '…',
  middot: '·',
  mdash: '—',
  ndash: '–',
  times: '×',
  laquo: '«',
  raquo: '»',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
}

/**
 * Decodes HTML entities in a title or artist name.
 *
 * LX does this with `DOMParser`, which is the browser's full entity table. The platform APIs in
 * practice only emit a handful (`&amp;`, `&apos;`, numeric escapes) — those are handled exactly,
 * plus the small named table above; anything unknown is left untouched rather than dropped.
 */
export function decodeName(input: string | null | undefined): string {
  if (!input) return ''
  return String(input)
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z][a-z0-9]*);/gi, (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match)
}

/**
 * Joins a platform's singer array into one string.
 *
 * Accepts both shapes the platforms emit: an array of objects (with a configurable name key) and a
 * bare string.
 */
export function formatSingerName(singers: unknown, nameKey = 'name', join = '、'): string {
  if (Array.isArray(singers)) {
    const names: string[] = []
    for (const item of singers) {
      const name = item && typeof item === 'object' ? (item as Record<string, unknown>)[nameKey] : undefined
      if (typeof name === 'string' && name) names.push(name)
    }
    return decodeName(names.join(join))
  }
  return decodeName(typeof singers === 'string' ? singers : String(singers ?? ''))
}

export function toMD5(text: string): string {
  return createHash('md5').update(text).digest('hex')
}
