/**
 * Automatic metadata completion for the local library ("自动补齐信息").
 *
 * What this does, precisely: for a local file that is *missing* something, it searches the
 * platform layer (the same search the online page uses), accepts a result only when the match is
 * defensible, and then fills only the fields that were actually empty — plus, optionally, cover art
 * and lyrics.
 *
 * What it deliberately does not do:
 *  - it never overwrites a tag the file already declares (a curated library must not be "corrected"
 *    by a fuzzy search);
 *  - it never invents data: no match means the track is reported as unmatched, untouched;
 *  - it writes lyrics through the normal user-lyrics path, so the user can still replace them.
 *
 * Matching is intentionally strict (title normalisation + artist agreement + duration window). A
 * wrong match is worse than no match: it would rename a file's entry to a different song.
 */

import { basename, extname } from 'node:path'
import type {
  AudioTrack,
  AuroraSettings,
  ScrapeProgress,
  ScrapeReport,
  ScrapeRequest,
  ScrapeTrackOutcome,
} from '../shared/types'
import { lyricsToLrcText } from '../shared/lyrics'
import { applyTrackPatch, listStoredTracks, notifyLibraryChanged, saveCoverBytes } from './library'
import { matchLyrics, saveUserLyrics } from './lyrics'
import { searchAllPlatforms } from './platforms'
import { allSecrets } from './secretStore'
import { sourceLyrics } from './sources'

const MAX_COVER_BYTES = 6 * 1024 * 1024
const MATCH_CANDIDATES = 6
const SCRAPE_CONCURRENCY = 2
const DURATION_TOLERANCE_SECONDS = 6
/** Duration is only comparable when both sides know it; a file with no duration is still matchable. */
const UNKNOWN_ARTIST = '未知艺术家'
const UNKNOWN_ALBUM = '未知专辑'
const COVER_MIME_EXTENSION: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

let notifier: ((channel: string, payload: unknown) => void) | null = null
let running = false

export function setScrapeNotifier(next: (channel: string, payload: unknown) => void): void {
  notifier = next
}

function emitProgress(progress: ScrapeProgress): void {
  notifier?.('library:scrape-progress', progress)
}

/**
 * Title normalisation for comparison only (never for display): lowercase, drop bracketed suffixes
 * such as `(Live)` / `【伴奏】`, and strip everything that is not a letter or digit. This is what
 * makes 「晴天」, 「晴天 (Live)」 and 「晴天【HQ】」 compare as the same title.
 */
function normalizeTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/[（(\[【][^）)\]】]*[）)\]】]/g, '')
    .replace(/[\s\-_·・.,，。!！?？'"“”‘’~～|/\\+&*#:：;；]/g, '')
    .trim()
}

/** Artist comparison: the first credited artist only, since platforms vary in how they join names. */
function normalizeArtist(value: string): string {
  const first = value.split(/[、,,;&/|]/)[0] ?? value
  return normalizeTitle(first)
}

function isUnknownArtist(artist: string): boolean {
  return !artist.trim() || artist.trim() === UNKNOWN_ARTIST
}

/**
 * How well a platform result matches a local file: `null` when it must not be accepted.
 *
 * The rules are ordered by strength so the first pass (exact title + agreeing artist) wins over a
 * looser one, and a duration mismatch rejects outright — that is what keeps a live version or a
 * differently-cut remix from silently replacing the entry.
 */
function matchScore(local: { title: string; artist: string; duration: number }, candidate: AudioTrack): number | null {
  const localTitle = normalizeTitle(local.title)
  const candidateTitle = normalizeTitle(candidate.title)
  if (!localTitle || !candidateTitle) return null

  let titleScore: number
  if (localTitle === candidateTitle) titleScore = 1
  else if (localTitle.length >= 4 && candidateTitle.length >= 4 && (localTitle.includes(candidateTitle) || candidateTitle.includes(localTitle))) titleScore = 0.72
  else return null

  const artistKnown = !isUnknownArtist(local.artist)
  const candidateArtist = normalizeArtist(candidate.artist)
  const localArtist = normalizeArtist(local.artist)
  let artistScore = 0
  if (artistKnown && candidateArtist) {
    if (localArtist === candidateArtist) artistScore = 1
    else if (localArtist.includes(candidateArtist) || candidateArtist.includes(localArtist)) artistScore = 0.6
    else artistScore = -0.5
  }

  if (local.duration > 0 && candidate.duration > 0) {
    const delta = Math.abs(local.duration - candidate.duration)
    if (delta > DURATION_TOLERANCE_SECONDS) return null
  }

  // A conflicting, *known* artist means this is a different recording (a cover, most often).
  if (artistScore < 0) return null
  return titleScore + artistScore
}

async function downloadCover(url: string): Promise<{ data: Uint8Array; mime: string } | null> {
  if (!/^https?:/i.test(url)) return null
  let response: Response
  try {
    response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(12_000) })
  } catch {
    return null
  }
  if (!response.ok) return null
  const mime = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (!COVER_MIME_EXTENSION[mime]) return null
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (declared > MAX_COVER_BYTES) return null
  try {
    const buffer = new Uint8Array(await response.arrayBuffer())
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_COVER_BYTES) return null
    return { data: buffer, mime }
  } catch {
    return null
  }
}

/**
 * Tracks that still have something to gain from a pass: no cover, a placeholder title, or an
 * unknown artist. A file with `未知艺术家` is included because that is the tag the importer writes
 * when the file carried no tags at all.
 */
function needsWork(track: { title: string; artist: string; hasCover: boolean; filePath: string }): boolean {
  const fallbackTitle = basename(track.filePath, extname(track.filePath))
  if (!track.hasCover) return true
  if (isUnknownArtist(track.artist)) return true
  return normalizeTitle(track.title) === normalizeTitle(fallbackTitle)
}

export async function scrapeLocalTracks(request: ScrapeRequest, settings: AuroraSettings): Promise<ScrapeReport> {
  if (running) {
    return { scanned: 0, matched: 0, covers: 0, lyrics: 0, outcomes: [] }
  }
  running = true
  try {
    const wantCover = request.cover !== false
    const wantLyrics = request.lyrics !== false
    const all = listStoredTracks()
    const ids = request.ids && request.ids.length > 0 ? new Set(request.ids) : null
    const targets = ids ? all.filter((track) => ids.has(track.id)) : all.filter((track) => needsWork(track))

    const outcomes: ScrapeTrackOutcome[] = []
    let processed = 0
    let matchedCount = 0
    let coverCount = 0
    let lyricsCount = 0

    emitProgress({ processed: 0, total: targets.length, matched: 0 })

    const queue = [...targets]
    const worker = async (): Promise<void> => {
      for (;;) {
        const track = queue.shift()
        if (!track) return

        const outcome: ScrapeTrackOutcome = {
          id: track.id,
          title: track.title,
          artist: track.artist,
          matched: false,
          filledTitle: false,
          filledArtist: false,
          filledAlbum: false,
          filledCover: false,
          filledLyrics: false,
        }

        try {
          const query = isUnknownArtist(track.artist) ? track.title : `${track.title} ${track.artist}`
          const boards = await searchAllPlatforms(query, { pageSize: MATCH_CANDIDATES, page: 1 })
          let best: { score: number; track: AudioTrack; platformName: string } | null = null
          for (const board of boards) {
            for (const candidate of board.tracks) {
              const score = matchScore(track, candidate)
              if (score === null) continue
              if (!best || score > best.score) best = { score, track: candidate, platformName: board.platformName }
            }
          }

          if (!best) {
            outcomes.push(outcome)
          } else {
            outcome.matched = true
            matchedCount += 1
            const winner: AudioTrack = best.track
            outcome.match = {
              platformId: String(winner.platform ?? ''),
              platformName: best.platformName,
              title: winner.title,
              artist: winner.artist,
              album: winner.album,
            }

            const patch: { title?: string; artist?: string; album?: string; coverFile?: string; duration?: number } = {}
            const fallbackTitle = basename(track.filePath, extname(track.filePath))
            if (normalizeTitle(track.title) === normalizeTitle(fallbackTitle) && winner.title.trim()) {
              patch.title = winner.title.trim()
              outcome.filledTitle = true
            }
            if (isUnknownArtist(track.artist) && winner.artist.trim()) {
              patch.artist = winner.artist.trim()
              outcome.filledArtist = true
            }
            if (track.album.trim() === UNKNOWN_ALBUM && winner.album.trim() && winner.album.trim() !== UNKNOWN_ALBUM) {
              patch.album = winner.album.trim()
              outcome.filledAlbum = true
            }
            if (track.duration <= 0 && winner.duration > 0) patch.duration = winner.duration

            if (wantCover && !track.hasCover && winner.cover) {
              const bytes = await downloadCover(winner.cover)
              if (bytes) {
                const coverFile = await saveCoverBytes(bytes.data, bytes.mime)
                if (coverFile) {
                  patch.coverFile = coverFile
                  outcome.filledCover = true
                  coverCount += 1
                }
              }
            }

            if (Object.keys(patch).length > 0) applyTrackPatch(track.id, patch)

            if (wantLyrics) {
              const localTrack = localTrackFor(track.id, patch)
              // The whole chain, catalogues included: this pass runs because the user asked for the
              // missing information to be filled in, so it is the one place where waiting on a
              // search is the point rather than a delay.
              const existing = localTrack ? (await matchLyrics(localTrack, settings, { quiet: true })).lyrics : null
              if (!existing) {
                const fromSource = await sourceLyrics(winner, settings, allSecrets())
                if (fromSource && fromSource.lines.length > 0 && localTrack) {
                  await saveUserLyrics(localTrack, lyricsToLrcText(fromSource))
                  outcome.filledLyrics = true
                  lyricsCount += 1
                }
              }
            }
            outcomes.push(outcome)
          }
        } catch (error) {
          outcome.error = error instanceof Error ? error.message : '自动补齐失败'
          outcomes.push(outcome)
        }

        processed += 1
        emitProgress({ processed, total: targets.length, matched: matchedCount })
      }
    }

    await Promise.all(Array.from({ length: Math.min(SCRAPE_CONCURRENCY, Math.max(1, targets.length)) }, worker))

    notifyLibraryChanged()
    return { scanned: targets.length, matched: matchedCount, covers: coverCount, lyrics: lyricsCount, outcomes }
  } finally {
    running = false
  }
}

/**
 * The track object `saveUserLyrics` needs. It is rebuilt from the patched values because the
 * in-memory entry was already updated while the object we read was a snapshot.
 */
function localTrackFor(
  id: string,
  patch: { title?: string; artist?: string; album?: string; coverFile?: string; duration?: number },
): AudioTrack | null {
  const entry = listStoredTracks().find((track) => track.id === id)
  if (!entry) return null
  return {
    id,
    origin: 'local',
    title: patch.title ?? entry.title,
    artist: patch.artist ?? entry.artist,
    album: patch.album ?? entry.album,
    duration: patch.duration ?? entry.duration,
    format: entry.format,
    fileUrl: '',
    filePath: entry.filePath,
    addedAt: Date.now(),
  }
}
