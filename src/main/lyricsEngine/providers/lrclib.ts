/**
 * LRCLIBProvider — the public, no-account lyrics database at lrclib.net.
 *
 * This is the provider that fixes the original complaint ("most local music shows 暂无歌词"): it is
 * a genuine open catalogue with the two endpoints we need, and it hands back *synchronised* lyrics
 * for most tracks, so what it returns actually scrolls.
 *
 * Two-step lookup, in the order the API rewards:
 *  1. `/api/get` — exact track/artist/album/duration. Precise and cheap, but 404s often enough that
 *     it cannot be the only path (it also refuses when the duration is a few seconds off).
 *  2. `/api/search` — a normal search, scored locally with the shared matcher (`title + artist +
 *     duration`, ±5s, fuzzy fallback). This is what makes files with slightly-off tags work.
 *
 * The provider never throws: an unreachable catalogue, a rate limit or a malformed row all mean
 * "this provider has nothing", and the chain moves on.
 */

import { parseLyricsText } from '../../../shared/lyrics'
import { fetchJson } from '../../sources/http'
import { MIN_MATCH_SCORE, pickBestCandidate, type MatchCandidate } from '../match'
import type { LyricsContext, LyricsHit, LyricsProvider, LyricsQuery } from '../types'

const BASE_URL = 'https://lrclib.net/api'
const DEFAULT_TIMEOUT_MS = 8_000
const QUIET_TIMEOUT_MS = 4_000
const MAX_CANDIDATES = 12

interface LrclibRecord {
  id?: number
  trackName?: string | null
  artistName?: string | null
  albumName?: string | null
  duration?: number | null
  instrumental?: boolean
  plainLyrics?: string | null
  syncedLyrics?: string | null
}

export interface LrclibCandidate extends MatchCandidate {
  record: LrclibRecord
}

function isRecord(value: unknown): value is LrclibRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** Rows that carry no usable text are dropped early: matching them would only waste a slot. */
function usable(record: LrclibRecord): boolean {
  return Boolean(record.syncedLyrics?.trim() || record.plainLyrics?.trim() || record.instrumental)
}

function toCandidate(record: LrclibRecord): LrclibCandidate {
  return {
    title: (record.trackName ?? '').trim(),
    artist: (record.artistName ?? '').trim(),
    album: (record.albumName ?? '').trim(),
    duration: Number(record.duration ?? 0) || 0,
    record,
  }
}

function buildLyrics(record: LrclibRecord): LyricsHit['lyrics'] | null {
  const synced = record.syncedLyrics?.trim()
  if (synced) {
    const parsed = parseLyricsText(synced, 'lrclib')
    if (parsed.lines.length > 0) return parsed
  }
  const plain = record.plainLyrics?.trim()
  if (plain) return parseLyricsText(plain, 'lrclib')
  return null
}

async function requestJson(path: string, params: Record<string, string>, context: LyricsContext): Promise<unknown> {
  const url = `${BASE_URL}${path}?${new URLSearchParams(params).toString()}`
  return fetchJson<unknown>(url, {
    label: 'LRCLIB',
    sourceId: 'lyrics:lrclib',
    timeoutMs: context.quiet ? QUIET_TIMEOUT_MS : DEFAULT_TIMEOUT_MS,
    // A public read-only database: one retry on a transient failure, none in the background pass.
    retries: context.quiet ? 0 : 1,
  })
}

async function exactLookup(query: LyricsQuery, context: LyricsContext): Promise<LrclibRecord | null> {
  if (query.duration <= 0) return null
  // LRCLIB treats `duration` as a tolerance window of ±2s; try the declared length and its
  // neighbours so a file whose length was rounded by the tagger still hits.
  for (const duration of [Math.round(query.duration), Math.round(query.duration) - 2, Math.round(query.duration) + 2]) {
    if (duration <= 0) continue
    const payload = await requestJson(
      '/get',
      {
        track_name: query.title,
        artist_name: query.artist,
        ...(query.album ? { album_name: query.album } : {}),
        duration: String(duration),
      },
      context,
    )
    if (isRecord(payload) && usable(payload)) return payload
  }
  return null
}

async function searchLookup(query: LyricsQuery, context: LyricsContext): Promise<LrclibCandidate[]> {
  const attempts: Array<Record<string, string>> = []
  if (query.title.trim()) {
    attempts.push({ track_name: query.title, ...(query.artist.trim() ? { artist_name: query.artist } : {}) })
  }
  const freeText = [query.title, query.artist].map((part) => part.trim()).filter(Boolean).join(' ')
  if (freeText) attempts.push({ q: freeText })

  const seen = new Set<string>()
  const candidates: LrclibCandidate[] = []
  for (const params of attempts) {
    let payload: unknown
    try {
      payload = await requestJson('/search', params, context)
    } catch {
      continue
    }
    const rows = Array.isArray(payload) ? payload : []
    for (const row of rows) {
      if (!isRecord(row) || !usable(row)) continue
      const candidate = toCandidate(row)
      if (!candidate.title) continue
      const fingerprint = `${candidate.title}\u0001${candidate.artist}\u0001${candidate.duration}`
      if (seen.has(fingerprint)) continue
      seen.add(fingerprint)
      candidates.push(candidate)
      if (candidates.length >= MAX_CANDIDATES) break
    }
    if (candidates.length >= MAX_CANDIDATES) break
  }
  return candidates
}

export const lrclibProvider: LyricsProvider = {
  id: 'lrclib',
  label: 'LRCLIB 公开歌词库',
  kind: 'remote',
  priority: 40,
  origin: 'lrclib',
  async find(query: LyricsQuery, context: LyricsContext): Promise<LyricsHit | null> {
    if (!query.title.trim()) return null

    let exact: LrclibRecord | null = null
    try {
      exact = await exactLookup(query, context)
    } catch {
      exact = null
    }
    if (exact) {
      const lyrics = buildLyrics(exact)
      if (lyrics && lyrics.lines.length > 0) {
        // `/get` only answers when track, artist, album and duration all line up, so a hit here is
        // as certain as this catalogue gets — full confidence, no local scoring needed.
        return {
          lyrics,
          provider: 'lrclib',
          label: 'LRCLIB 公开歌词库',
          confidence: 100,
          detail: `exact match · ${exact.trackName ?? query.title} — ${exact.artistName ?? query.artist}`,
        }
      }
      if (exact.instrumental) {
        return {
          lyrics: { origin: 'lrclib', synced: false, offsetMs: 0, lines: [] },
          provider: 'lrclib',
          label: 'LRCLIB 公开歌词库',
          confidence: 100,
          instrumental: true,
          detail: 'catalogue marks this track as instrumental',
        }
      }
    }

    const candidates = await searchLookup(query, context)
    const best = pickBestCandidate(
      { title: query.title, artist: query.artist, album: query.album, duration: query.duration },
      candidates,
      MIN_MATCH_SCORE,
    )
    if (!best) return null

    const lyrics = buildLyrics(best.candidate.record)
    if (!lyrics || lyrics.lines.length === 0) {
      if (best.candidate.record.instrumental) {
        return {
          lyrics: { origin: 'lrclib', synced: false, offsetMs: 0, lines: [] },
          provider: 'lrclib',
          label: 'LRCLIB 公开歌词库',
          confidence: Math.round(best.match.score),
          instrumental: true,
          detail: `search match · ${best.candidate.title}`,
        }
      }
      return null
    }
    return {
      lyrics,
      provider: 'lrclib',
      label: 'LRCLIB 公开歌词库',
      confidence: Math.round(best.match.score),
      detail: `search match · ${best.candidate.title} — ${best.candidate.artist} (score ${Math.round(best.match.score)})`,
    }
  },
}

/** Exported for tests: `true` when the catalogue positively reports no lyrics for this record. */
export function isInstrumentalRecord(record: unknown): boolean {
  return isRecord(record) && record.instrumental === true
}
