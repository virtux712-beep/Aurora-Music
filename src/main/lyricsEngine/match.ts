/**
 * Lyrics matching.
 *
 * Every provider that has to *find* lyrics for a track (rather than read them off the disk) answers
 * a search endpoint with a list of candidates, and the only thing standing between a user and
 * someone else's lyrics is this file. A wrong match is worse than no match: it silently puts a
 * different song's words under the player.
 *
 * The algorithm is deliberately layered, in the order the request asked for it:
 *
 *  1. `title + artist + duration` compared directly;
 *  2. then, for each of those, the usual noisy-catalogue degradations — bracketed suffixes
 *     (`(Live)`, `【Remix】`) are dropped, `feat.` credits are cut, an artist string is split on the
 *     separators platforms actually use (`、`, `,`, `&`, `/`, `;`), and the comparison falls back to
 *     a fuzzy character-level similarity;
 *  3. duration is a window, not an equality: ±5s is treated as the same recording, and anything
 *     past 12s apart is rejected outright.
 *
 * Ordering (which candidate wins) and acceptance (whether *any* candidate may be used) are separate
 * decisions — `scoreCandidate` returns `null` for the second, a number for the first.
 */

/** Duration difference treated as "the same recording". */
export const DURATION_TOLERANCE_SECONDS = 5
/** Past this, the two recordings are different (live vs. studio, edit vs. album) — never paired. */
const DURATION_REJECT_SECONDS = 12
/** Below this similarity a title is a different song, whatever else agrees. */
const MIN_TITLE_SIMILARITY = 0.6
/** Artist agreement expected when the title is not an exact match. */
const MIN_ARTIST_SIMILARITY = 0.45
/** A near-identical title may skip the artist test only when the duration also lines up. */
const STRONG_TITLE_SIMILARITY = 0.92
/** Final gate: the weighted score has to clear this to be usable. */
export const MIN_MATCH_SCORE = 62

const BRACKETS = /[（(\[【{][^）)\]】}]*[）)\]】}]/g
const FEAT = /\b(?:feat|ft|featuring|with)\b\.?\s*[^,，;；)）]*/gi
const ARTIST_SEPARATORS = /[、,,;&/|·・]|\s+&\s+|\s+and\s+/i
const PUNCTUATION = /[\s\-_·・.,，。!！?？'"“”‘’~～|/\\+&*#:：;；@=<>{}[\]()（）]/g

const KNOWN_ARTIST_PLACEHOLDERS = ['未知艺术家', 'unknown artist', 'unknown', 'various artists', 'va', '群星']

export function splitArtists(value: string): string[] {
  return value
    .split(ARTIST_SEPARATORS)
    .map((part) => part.trim())
    .filter(Boolean)
}

/** `true` for the placeholder strings Aurora (and most taggers) use for "no artist". */
export function isPlaceholderArtist(value: string): boolean {
  const trimmed = value.trim().toLowerCase()
  if (!trimmed) return true
  return KNOWN_ARTIST_PLACEHOLDERS.includes(trimmed)
}

/** Lowercases and removes everything that differs between a tag and a catalogue entry. */
export function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(BRACKETS, ' ')
    .replace(FEAT, ' ')
    .replace(PUNCTUATION, '')
    .trim()
}

/** Same as `normalize`, but keeps bracketed text (used when we deliberately want the raw title). */
function normalizeKeepBrackets(value: string): string {
  return value.toLowerCase().replace(FEAT, ' ').replace(PUNCTUATION, '').trim()
}

/**
 * All the spellings of a title worth comparing: the full string, the version with bracketed parts
 * removed, and the version with a trailing `- x` / `『x』` suffix cut. A catalogue that files a
 * track as `晴天 (Live)` has to match a file tagged `晴天`.
 */
export function titleVariants(title: string): string[] {
  const variants = new Set<string>()
  const push = (value: string): void => {
    const normalized = normalize(value)
    if (normalized) variants.add(normalized)
    const keep = normalizeKeepBrackets(value)
    if (keep) variants.add(keep)
  }
  push(title)
  push(title.split(/\s[-–—]\s/)[0] ?? title)
  push(title.replace(BRACKETS, ''))
  const withoutSuffix = title.replace(/\s*[-–—]\s*(remaster(ed)?|live|mv|official|hq|hd|demo|acoustic)\b.*$/i, '')
  push(withoutSuffix)
  return [...variants]
}

/** Artist spellings: the full credit, every split-off name, and the first one on its own. */
export function artistVariants(artist: string): string[] {
  const variants = new Set<string>()
  for (const value of [artist, ...splitArtists(artist)]) {
    const normalized = normalize(value)
    if (normalized) variants.add(normalized)
  }
  return [...variants]
}

function bigrams(value: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (let index = 0; index < value.length - 1; index += 1) {
    const gram = value.slice(index, index + 2)
    counts.set(gram, (counts.get(gram) ?? 0) + 1)
  }
  return counts
}

/** Sørensen–Dice over character bigrams: robust to reordering and small insertions. */
function diceCoefficient(a: string, b: string): number {
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0
  const left = bigrams(a)
  const right = bigrams(b)
  let overlap = 0
  let leftTotal = 0
  let rightTotal = 0
  for (const count of left.values()) leftTotal += count
  for (const count of right.values()) rightTotal += count
  for (const [gram, count] of left) overlap += Math.min(count, right.get(gram) ?? 0)
  return (2 * overlap) / (leftTotal + rightTotal)
}

/** Levenshtein distance, rolled into a 0..1 similarity. */
function levenshteinSimilarity(a: string, b: string): number {
  if (a === b) return 1
  if (!a || !b) return 0
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost)
    }
    previous = current
  }
  return 1 - previous[b.length] / Math.max(a.length, b.length)
}

/** Fuzzy similarity of two already-normalised strings: the better of the two measures. */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0
  if (a === b) return 1
  if (a.includes(b) || b.includes(a)) {
    const shorter = Math.min(a.length, b.length)
    const longer = Math.max(a.length, b.length)
    // A substring hit is strong but not free: `晴天` inside `晴天娃娃` is a different song.
    return Math.max(0.78, shorter / longer)
  }
  return Math.max(diceCoefficient(a, b) * 0.95, levenshteinSimilarity(a, b))
}

function bestSimilarity(left: string[], right: string[]): number {
  let best = 0
  for (const a of left) {
    for (const b of right) {
      const value = similarity(a, b)
      if (value > best) best = value
      if (best === 1) return best
    }
  }
  return best
}

export interface MatchQuery {
  title: string
  artist: string
  album?: string
  /** Seconds; `0` when unknown, in which case duration is skipped entirely. */
  duration?: number
}

export interface MatchCandidate {
  title: string
  artist: string
  album?: string
  duration?: number
}

export interface MatchResult {
  score: number
  titleSimilarity: number
  artistSimilarity: number
  /** Absolute duration difference in seconds, or `null` when either side is unknown. */
  durationDelta: number | null
}

/**
 * Scores one candidate against the track we want lyrics for.
 *
 * Returns `null` when the candidate must not be used at all — the difference between "rank these
 * results" and "may I show this result". Duration is only consulted when both sides know it: a
 * candidate with `duration: 0` is not penalised, because refusing to match a whole database that
 * omits durations would be worse than the occasional live-version mix-up the title/artist gate
 * already catches.
 */
export function scoreCandidate(query: MatchQuery, candidate: MatchCandidate): MatchResult | null {
  const titleSimilarity = bestSimilarity(titleVariants(query.title), titleVariants(candidate.title))
  if (titleSimilarity < MIN_TITLE_SIMILARITY) return null

  const artistKnown = !isPlaceholderArtist(query.artist)
  const candidateArtistKnown = !isPlaceholderArtist(candidate.artist)
  const artistSimilarity =
    artistKnown && candidateArtistKnown ? bestSimilarity(artistVariants(query.artist), artistVariants(candidate.artist)) : 0

  const queryDuration = Number(query.duration ?? 0)
  const candidateDuration = Number(candidate.duration ?? 0)
  const bothDurations = queryDuration > 0 && candidateDuration > 0
  const durationDelta = bothDurations ? Math.abs(queryDuration - candidateDuration) : null

  if (durationDelta !== null && durationDelta > DURATION_REJECT_SECONDS) return null

  if (artistKnown && candidateArtistKnown && artistSimilarity < MIN_ARTIST_SIMILARITY) {
    //
    // A different credited artist is the hardest call here, because the two situations look
    // identical from `title + artist + duration` alone:
    //
    //  - a **cover** of the song (its own lyrics may differ, and showing them under the original is
    //    the single most annoying failure mode), versus
    //  - the **same recording re-labelled** by the catalogue.
    //
    // The discriminator used is where the credit appears. Catalogues that carry a cover normally
    // say so inside the title itself — `晴天 (原唱 周杰伦)` — and that mention is direct evidence
    // that this entry describes the *original work*, so its lyrics belong to it. A cover that only
    // changes the artist field (`晴天` / `某翻唱歌手`) carries no such evidence and is rejected.
    //
    // Bracket *content* is deliberately kept while looking for the mention — `normalize` would strip
    // it, deleting exactly the part that carries it (`(原唱 周杰伦)`).
    const mentionsQueryArtist = (candidate: MatchCandidate): boolean => {
      const haystack = `${candidate.title} ${candidate.album ?? ''}`.toLowerCase().replace(PUNCTUATION, '')
      return artistVariants(query.artist).some((name) => name.length >= 2 && haystack.includes(name))
    }
    const sameLength = durationDelta === null || durationDelta <= DURATION_TOLERANCE_SECONDS
    const rescued = titleSimilarity >= STRONG_TITLE_SIMILARITY && sameLength && mentionsQueryArtist(candidate)
    if (!rescued) return null
  }

  const durationBonus = durationDelta === null ? 4 : durationDelta <= DURATION_TOLERANCE_SECONDS ? 10 - durationDelta : 0
  const score = titleSimilarity * 60 + artistSimilarity * 30 + durationBonus

  return { score, titleSimilarity, artistSimilarity, durationDelta }
}

/** Picks the best acceptable candidate, or `null` when nothing clears the gate. */
export function pickBestCandidate<T extends MatchCandidate>(
  query: MatchQuery,
  candidates: T[],
  minimumScore = MIN_MATCH_SCORE,
): { candidate: T; match: MatchResult } | null {
  let best: { candidate: T; match: MatchResult } | null = null
  for (const candidate of candidates) {
    const match = scoreCandidate(query, candidate)
    if (!match || match.score < minimumScore) continue
    if (!best || match.score > best.match.score) best = { candidate, match }
  }
  return best
}
