/**
 * How far a listener may shift lyric timing, and how finely.
 *
 * Per-track sources disagree with each other by a few hundred milliseconds (a rip's offset tag, a
 * provider that times the first syllable instead of the first word), and the listener hears it as "the
 * words are late". Stored as one global preference rather than a per-file patch: the error usually belongs
 * to the *source*, so the same correction is what the next song from that source needs too.
 *
 * Snapped to 100 ms because a finer step is not audible and would leave the value unreadable. The bound is
 * ±1 s for the same reason: beyond that it is not a timing correction, it is the wrong lyrics.
 */
export const LYRICS_OFFSET_LIMIT_MS = 1000
export const LYRICS_OFFSET_STEP_MS = 100

/** Clamps a requested offset to the allowed range and snaps it to the allowed step. */
export function clampLyricsOffset(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return 0
  const snapped = Math.round(parsed / LYRICS_OFFSET_STEP_MS) * LYRICS_OFFSET_STEP_MS
  return Math.min(Math.max(snapped, -LYRICS_OFFSET_LIMIT_MS), LYRICS_OFFSET_LIMIT_MS)
}

/** `+200ms` / `-100ms` / `0ms` — one spelling of the value, so every surface shows the same thing. */
export function formatLyricsOffset(ms: number): string {
  if (!ms) return '0 ms'
  return `${ms > 0 ? '+' : '−'}${Math.abs(ms)} ms`
}

/** The playback position the lyrics are read at: the real clock plus the listener's correction. */
export function lyricSyncTime(currentTime: number, offsetMs: number): number {
  const time = Number.isFinite(currentTime) ? currentTime : 0
  return Math.max(0, time + (Number.isFinite(offsetMs) ? offsetMs : 0) / 1000)
}

/**
 * Aurora's lyrics engine (shared by the main process and the renderer).
 *
 * Supports plain text, standard LRC (`[mm:ss.xx]`) and enhanced LRC with per-word timings
 * (`[mm:ss.xx]<mm:ss.xx>word`), plus `[offset:±ms]` correction and duplicate-timestamp lines
 * (used by many LRC files for translations).
 *
 * The renderer never re-implements timing: it binary-searches the active line from the player's
 * real `currentTime`, which keeps the lyrics page in sync with seeking and track changes.
 *
 * Text is normalised to simplified Chinese on the way in (see `./chinese`): lyric providers hand out
 * traditional text for Taiwan/HK releases, and a listener should not have to read 繁體 because of the
 * source they picked.
 */
import { toSimplified } from './chinese'

export interface LyricWord {
  start: number
  end: number
  text: string
}

export interface LyricLine {
  start: number
  end?: number
  text: string
  words?: LyricWord[]
  /** Second line sharing the same timestamp (typically a translation). */
  translation?: string
  /** Romanised reading of `text`, from a provider that publishes a separate romaji track. */
  roman?: string
}

/**
 * Where a set of lyrics came from.
 *
 * The first four are on the user's own disk; the rest came off the network and are cached locally
 * afterwards, so the next session reads them from disk and never asks again.
 */
export type LyricsOrigin =
  /** The user imported them by hand — always wins. */
  | 'user'
  /** A `.lrc` next to the audio file. */
  | 'sidecar'
  /** A previously fetched copy kept in Aurora's lyrics cache (local-first hit). */
  | 'cache'
  /** Read from the audio file's own tags (ID3 USLT/SYLT, Vorbis LYRICS). */
  | 'embedded'
  /** Returned by an installed source plugin. */
  | 'source'
  /** The public LRCLIB database. */
  | 'lrclib'
  /** A domestic (Chinese) lyrics interface. */
  | 'china'

export interface Lyrics {
  origin: LyricsOrigin
  synced: boolean
  /** Applied `[offset:]` correction in milliseconds (already baked into `lines`). */
  offsetMs: number
  lines: LyricLine[]
  /** Untimed lyrics, when the file had no timestamps at all. */
  plain?: string
  title?: string
  artist?: string
}

/**
 * Identifies which lyrics provider answered.
 *
 * `local` is the composite local chain (hand import → sidecar `.lrc` → fetch cache), because from the
 * UI's point of view those are one answer: "already on your machine, no request was made".
 */
export type LyricsProviderId = 'local' | 'embedded' | 'source' | 'lrclib' | 'china'

/**
 * One provider's outcome during a single lookup.
 *
 * "暂无歌词" on its own is not something a user can act on; this is what lets the UI say *which*
 * catalogue was tried, which errored and which simply had nothing for this track.
 */
export interface LyricsAttempt {
  provider: LyricsProviderId
  label: string
  result: 'hit' | 'miss' | 'error' | 'skipped' | 'instrumental'
  detail?: string
}

/**
 * The full result of a lyrics lookup, as reported across IPC.
 *
 * Carries the answer *and* the reasoning, so 「联网自动匹配」 can be honest when it comes back empty.
 */
export interface LyricsResolution {
  trackId: string
  lyrics: Lyrics | null
  provider: LyricsProviderId | null
  label: string
  /** 0–100 confidence for a match picked out of search results. */
  confidence?: number
  /** The catalogue positively reported an instrumental track (no lyrics expected at all). */
  instrumental: boolean
  /** `true` when the answer came from disk, so this call made no request. */
  fromDisk: boolean
  /** Where fetched lyrics were written, when this call went to the network. */
  cachedTo?: { path: string | null; sidecar: string | null }
  attempts: LyricsAttempt[]
  durationMs: number
}

/** Highlight a line slightly before its exact timestamp: it reads better and hides jitter. */
/**
 * How early a line (and a word) becomes current.
 *
 * Exported because the animation layer has to agree with the matcher: the karaoke fill is computed from the
 * same clock and the same lead, and two constants that drift apart would show as a word filling *behind* the
 * highlight that selected it.
 */
export const LYRIC_LEAD_SECONDS = 0.12

function makeLineTag(): RegExp {
  return /\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g
}

function makeWordTag(): RegExp {
  return /<(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)>/g
}

const META_TAG = /^\s*\[(ar|ti|al|by|offset|length|re|ve|au|kana)\s*:\s*(.*?)\]\s*$/i

/** Turns `mm` + `ss(.sss)` or `ss:fff` into milliseconds. */
function toMilliseconds(minutes: string, secondsPart: string): number {
  const separator = secondsPart.includes(':') ? ':' : '.'
  const [secondsRaw, fractionRaw = ''] = secondsPart.split(separator)
  const seconds = Number.parseInt(secondsRaw, 10)
  if (!Number.isFinite(seconds)) return Number.NaN
  let ms = 0
  if (fractionRaw) {
    const fraction = fractionRaw.slice(0, 3)
    ms = fraction.length === 1 ? Number(fraction) * 100 : fraction.length === 2 ? Number(fraction) * 10 : Number(fraction)
  }
  return Number.parseInt(minutes, 10) * 60_000 + seconds * 1000 + ms
}

interface TimedEntry {
  start: number
  text: string
  words?: LyricWord[]
}

function finalizeWords(words: LyricWord[], lineStart: number, lineEnd: number | undefined): LyricWord[] {
  return words.map((word, index) => {
    const next = words[index + 1]
    const end = next ? next.start : (lineEnd ?? Math.max(word.start + 0.4, lineStart + 0.4))
    return { ...word, end: Math.max(end, word.start) }
  })
}

/** Fills in `end` timestamps (and word end times) from the following line. */
export function finalizeLineEnds(lines: LyricLine[]): LyricLine[] {
  return lines.map((line, index) => {
    const next = lines[index + 1]
    const end = next ? Math.max(next.start, line.start) : undefined
    return {
      ...line,
      end,
      words: line.words ? finalizeWords(line.words, line.start, end) : undefined,
    }
  })
}

/**
 * Parses LRC (or plain) lyrics text into Aurora's model. Always returns a `Lyrics` object so
 * callers never have to handle "empty string means no lyrics" themselves.
 */
export function parseLyricsText(raw: string, origin: LyricsOrigin = 'user'): Lyrics {
  // Traditional → simplified happens once, here, before any parsing. Every provider funnels through
  // this function (embedded tags, sidecar `.lrc`, the on-disk cache, LRCLIB, the domestic APIs and
  // script sources), so converting at the top means no source can smuggle traditional text into the
  // renderer. It is a no-op for text that is already simplified, and tags (`[ti:…]`, `[offset:…]`)
  // and word timings `<mm:ss.fff>` are ASCII, so they pass through untouched.
  const text = toSimplified(raw).replace(/\r\n?/g, '\n').trim()
  if (!text) return { origin, synced: false, offsetMs: 0, lines: [] }

  const lineTag = makeLineTag()
  if (!lineTag.test(text)) {
    return { origin, synced: false, offsetMs: 0, lines: [], plain: text }
  }

  let offsetMs = 0
  let title: string | undefined
  let artist: string | undefined
  const entries: TimedEntry[] = []
  const untimed: string[] = []

  for (const rawLine of text.split('\n')) {
    const meta = META_TAG.exec(rawLine)
    if (meta) {
      const key = meta[1].toLowerCase()
      const value = meta[2].trim()
      if (key === 'offset') {
        const parsed = Number.parseInt(value, 10)
        if (Number.isFinite(parsed)) offsetMs = parsed
      } else if (key === 'ti') {
        title = value
      } else if (key === 'ar') {
        artist = value
      }
      continue
    }

    const tags = makeLineTag()
    const starts: number[] = []
    let match: RegExpExecArray | null
    while ((match = tags.exec(rawLine)) !== null) {
      const ms = toMilliseconds(match[1], match[2])
      if (Number.isFinite(ms)) starts.push(ms)
    }

    if (starts.length === 0) {
      const cleaned = rawLine.trim()
      if (cleaned) untimed.push(cleaned)
      continue
    }

    const body = rawLine.replace(makeLineTag(), '')
    const words: LyricWord[] = []
    const wordTags = makeWordTag()
    let cursor = 0
    let pendingTime: number | null = null
    let wordMatch: RegExpExecArray | null
    // Enhanced LRC reads `<time>text`: the text *follows* the tag, so each piece belongs to the
    // tag that precedes it (assigning it to the next tag would shift the whole line by one word).
    while ((wordMatch = wordTags.exec(body)) !== null) {
      const gap = body.slice(cursor, wordMatch.index)
      const at = toMilliseconds(wordMatch[1], wordMatch[2])
      if (Number.isFinite(at)) {
        const time = at / 1000
        if (pendingTime !== null) {
          if (gap) words.push({ start: pendingTime, end: time, text: gap })
        } else if (gap.trim()) {
          // Text before the first tag has no timing of its own: anchor it to the first tag.
          words.push({ start: time, end: time, text: gap })
        }
        pendingTime = time
      }
      cursor = wordMatch.index + wordMatch[0].length
    }
    const tail = body.slice(cursor)
    if (tail && pendingTime !== null) words.push({ start: pendingTime, end: pendingTime, text: tail })
    else if (tail.trim() && Number.isFinite(starts[0])) words.push({ start: starts[0] / 1000, end: starts[0] / 1000, text: tail })

    const lineText = body.replace(makeWordTag(), '').replace(/\s+/g, ' ').trim()
    for (const start of starts) {
      entries.push({ start, text: lineText, words: words.length > 1 ? words : undefined })
    }
  }

  if (entries.length === 0) {
    return { origin, synced: false, offsetMs, lines: [], plain: untimed.join('\n') || text, title, artist }
  }

  entries.sort((a, b) => a.start - b.start)

  const lines: LyricLine[] = []
  for (const entry of entries) {
    const seconds = Math.max(0, (entry.start + offsetMs) / 1000)
    const previous = lines[lines.length - 1]
    // Same timestamp twice -> the second copy is a translation of the first.
    if (previous && Math.abs(previous.start - seconds) < 0.02) {
      if (!previous.translation && entry.text) previous.translation = entry.text
      continue
    }
    lines.push({ start: seconds, text: entry.text, words: entry.words })
  }

  return { origin, synced: true, offsetMs, lines: finalizeLineEnds(lines), title, artist }
}

/** Plain-text lyrics (no timestamps): rendered as a readable block, never auto-scrolled. */
export function parsePlainLyrics(raw: string, origin: LyricsOrigin = 'user'): Lyrics {
  const text = toSimplified(raw).replace(/\r\n?/g, '\n').trim()
  return { origin, synced: false, offsetMs: 0, lines: [], plain: text }
}

/**
 * Index of the line that should be highlighted at `seconds`, or `-1` before the first line.
 * Binary search keeps this O(log n) even for very long lyrics.
 */
export function findActiveLine(lines: LyricLine[], seconds: number): number {
  if (lines.length === 0) return -1
  const target = seconds + LYRIC_LEAD_SECONDS
  let low = 0
  let high = lines.length - 1
  let found = -1
  while (low <= high) {
    const mid = (low + high) >> 1
    if (lines[mid].start <= target) {
      found = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return found
}

/**
 * How far through a word the karaoke sweep is, as a fraction in `[0, 1]`.
 *
 * The animation layer's arithmetic, kept here next to the matcher that decides *which* word is current so the
 * two cannot disagree about the clock or the lead. The sweep is anchored to the word's own start and end, and
 * it is clamped: after a word's end it stays full rather than running on into the next one.
 *
 * Returns `null` when the line carries no word timings — the caller then draws the whole-line highlight
 * instead, which is the honest rendering of a lyric that has no per-word data.
 */
export function wordFillProgress(
  words: LyricWord[] | null | undefined,
  index: number,
  seconds: number,
): number | null {
  if (!words || words.length === 0) return null
  const word = words[Math.min(Math.max(index, 0), words.length - 1)]
  if (!word) return null
  const span = Math.max(0.05, word.end - word.start)
  const through = (seconds + LYRIC_LEAD_SECONDS - word.start) / span
  return Math.min(1, Math.max(0, through))
}

/** Index of the highlighted word inside `line` (per-word karaoke), or `-1`. */
export function findActiveWord(line: LyricLine | null | undefined, seconds: number): number {
  const words = line?.words
  if (!words || words.length === 0) return -1
  const target = seconds + LYRIC_LEAD_SECONDS
  let found = -1
  for (let index = 0; index < words.length; index += 1) {
    if (words[index].start <= target) found = index
    else break
  }
  return found
}

/** `true` when the lyrics carry per-word timings and can be highlighted word by word. */
/**
 * Serialises parsed lyrics back to LRC text.
 *
 * Needed by the automatic metadata pass: lyrics arrive from a source already parsed, but caching
 * them for the next session means writing a real `.lrc` file — and that file has to parse back into
 * the same timings. Two decimals is what LRC consumers expect (`[mm:ss.xx]`), and the translation
 * line is emitted as a second tag on the same timestamp, which is the shape `parseLyricsText`
 * folds back into `translation`.
 */
export function lyricsToLrcText(lyrics: Lyrics): string {
  const stamp = (seconds: number): string => {
    const total = Math.max(0, seconds)
    const minutes = Math.floor(total / 60)
    const rest = total - minutes * 60
    const whole = Math.floor(rest)
    const centis = Math.round((rest - whole) * 100)
    // Rounding can push the fraction to 100; carry it into the seconds instead of printing `.100`.
    const carry = centis === 100
    const secondsPart = carry ? whole + 1 : whole
    return `[${String(minutes).padStart(2, '0')}:${String(secondsPart).padStart(2, '0')}.${String(carry ? 0 : centis).padStart(2, '0')}]`
  }

  const head: string[] = []
  if (lyrics.title) head.push(`[ti:${lyrics.title}]`)
  if (lyrics.artist) head.push(`[ar:${lyrics.artist}]`)

  if (!lyrics.synced || lyrics.lines.length === 0) {
    const plain = (lyrics.plain ?? lyrics.lines.map((line) => line.text).join('\n')).trim()
    return [...head, plain].filter(Boolean).join('\n')
  }

  const body: string[] = []
  for (const line of lyrics.lines) {
    const tag = stamp(line.start)
    body.push(`${tag}${line.text}`)
    if (line.translation?.trim()) body.push(`${tag}${line.translation}`)
  }
  return [...head, ...body].join('\n')
}

/**
 * Folds a second, timestamp-aligned LRC into lyrics that are already parsed.
 *
 * Lyrics providers publish translations and romanisations as *separate* tracks that share the
 * original's timestamps (NetEase's `tlyric` / `romalrc`, for example). This merges them line by
 * line instead of creating a second lyric set the player would have to keep in sync.
 *
 * A small tolerance is deliberate: providers round their timestamps differently (±0.3s is common),
 * and an exact-equality match silently drops most translations. Nearest-within-tolerance is the
 * behaviour that actually works, and it never invents a pairing when the gap is real.
 *
 * Mutates and returns `lines`; the returned count is how many lines received text.
 */
export function mergeTimedText(lines: LyricLine[], raw: string, field: 'translation' | 'roman' = 'translation'): number {
  const text = raw?.replace(/\r\n?/g, '\n').trim()
  if (!text || lines.length === 0) return 0
  const parsed = parseLyricsText(text, 'source')
  if (!parsed.synced || parsed.lines.length === 0) return 0

  const stamps = parsed.lines.map((line) => ({ at: line.start, text: line.text.trim() })).filter((entry) => entry.text)
  if (stamps.length === 0) return 0
  stamps.sort((a, b) => a.at - b.at)

  let filled = 0
  for (const line of lines) {
    // Binary search for the nearest stamp, then keep it only when it is close enough to be a pairing.
    let low = 0
    let high = stamps.length - 1
    let nearest = 0
    while (low <= high) {
      const mid = (low + high) >> 1
      if (stamps[mid].at <= line.start) {
        nearest = mid
        low = mid + 1
      } else {
        high = mid - 1
      }
    }
    const before = stamps[nearest]
    const after = stamps[nearest + 1]
    const best =
      !after || Math.abs(before.at - line.start) <= Math.abs(after.at - line.start) ? before : after
    if (Math.abs(best.at - line.start) > 0.35) continue
    if (best.text === line.text.trim()) continue
    if (field === 'translation') {
      if (line.translation) continue
      line.translation = best.text
    } else {
      if (line.roman) continue
      line.roman = best.text
    }
    filled += 1
  }
  return filled
}

export function hasWordTimings(lyrics: Lyrics | null): boolean {
  return Boolean(lyrics?.lines.some((line) => line.words && line.words.length > 1))
}

export function lyricsAreEmpty(lyrics: Lyrics | null | undefined): boolean {
  if (!lyrics) return true
  return lyrics.lines.length === 0 && !lyrics.plain?.trim()
}

/** `true` when at least one line carries a romanised reading. */
export function hasRomanisation(lyrics: Lyrics | null): boolean {
  return Boolean(lyrics?.lines.some((line) => Boolean(line.roman?.trim())))
}
