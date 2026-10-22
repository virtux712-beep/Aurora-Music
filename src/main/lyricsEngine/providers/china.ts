/**
 * ChinaLyricsProvider — a domestic catalogue, for the tracks LRCLIB does not carry.
 *
 * Coverage is complementary rather than duplicated: LRCLIB is Western/indie heavy and often misses
 * Chinese-language releases (especially the ones whose tags are not in Latin script), while the
 * domestic catalogues carry them. Running both is what makes the hit rate on a real Chinese library
 * acceptable.
 *
 * Two real calls, both through Aurora's own HTTP and platform layers — no fake or placeholder data:
 *  1. **search** — the same ported per-platform search the online page uses (`musicSdk`), so a track
 *     is matched against a catalogue that is actually reachable, using the shared scorer
 *     (`title + artist + duration`, ±5s, fuzzy fallback).
 *  2. **lyric fetch** — the catalogue's lyric endpoint for the matched song id, whose response has
 *     three parallel tracks: `lrc` (original), `tlyric` (translation) and `romalrc` (romanisation).
 *     All three are merged into one line list, which is why a Chinese track can show its translation
 *     and its pinyin reading without the player knowing anything about either.
 *
 * Word-level (`yrc`/`klyric`) payloads are intentionally not parsed: the LRC track already carries
 * per-line timing, and inventing per-word timings from a different clock would desynchronise
 * karaoke highlighting rather than improve it.
 */

import { mergeTimedText, parseLyricsText, type Lyrics } from '../../../shared/lyrics'
import { intervalToSeconds, searchPlatform, type LxMusicInfo } from '../../musicSdk'
import { fetchJson } from '../../sources/http'
import { MIN_MATCH_SCORE, pickBestCandidate, type MatchCandidate } from '../match'
import type { LyricsContext, LyricsHit, LyricsProvider, LyricsQuery } from '../types'

const LYRIC_ENDPOINT = 'https://music.163.com/api/song/lyric'
const SEARCH_PLATFORM = 'wy'
const SEARCH_LIMIT = 10
const DEFAULT_TIMEOUT_MS = 8_000
const QUIET_TIMEOUT_MS = 4_000
/** NetEase's public API answers plain browser-ish requests; a referer keeps it from 403-ing. */
const LYRIC_HEADERS = { Referer: 'https://music.163.com/', Cookie: 'appver=2.0.2' }

interface NeteaseLyricPayload {
  lrc?: { lyric?: string | null }
  tlyric?: { lyric?: string | null }
  romalrc?: { lyric?: string | null }
  nolyric?: boolean
  uncollected?: boolean
}

interface NeteaseCandidate extends MatchCandidate {
  song: LxMusicInfo
}

function isPayload(value: unknown): value is NeteaseLyricPayload {
  return Boolean(value) && typeof value === 'object'
}

async function searchCandidates(query: LyricsQuery, context: LyricsContext): Promise<NeteaseCandidate[]> {
  const keyword = [query.title, query.artist].map((part) => part.trim()).filter(Boolean).join(' ')
  if (!keyword) return []
  // `searchPlatform` builds its own request and does not take a timeout, so the budget is bounded by
  // racing it: the chain must not stall on one slow catalogue.
  const limit = context.quiet ? QUIET_TIMEOUT_MS + 2_000 : DEFAULT_TIMEOUT_MS + 4_000
  const results = await Promise.race([
    searchPlatform(SEARCH_PLATFORM, keyword, 1, SEARCH_LIMIT),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('国内接口搜索超时')), limit)),
  ])
  return results
    .filter((song) => song.name && song.meta?.songId !== undefined && song.meta.songId !== null)
    .map((song) => ({
      title: song.name,
      artist: song.singer ?? '',
      album: String(song.meta?.albumName ?? ''),
      duration: intervalToSeconds(song.interval),
      song,
    }))
}

async function fetchLyrics(song: LxMusicInfo, context: LyricsContext): Promise<Lyrics | null> {
  const id = String(song.meta?.songId ?? '')
  if (!id) return null
  const url = `${LYRIC_ENDPOINT}?id=${encodeURIComponent(id)}&lv=-1&kv=-1&tv=-1&rv=-1`
  const payload = await fetchJson<unknown>(url, {
    label: '国内歌词接口',
    sourceId: 'lyrics:china',
    timeoutMs: context.quiet ? QUIET_TIMEOUT_MS : DEFAULT_TIMEOUT_MS,
    retries: context.quiet ? 0 : 1,
    headers: LYRIC_HEADERS,
  })
  if (!isPayload(payload)) return null

  const original = payload.lrc?.lyric?.trim()
  if (original) {
    const lyrics = parseLyricsText(original, 'china')
    if (lyrics.lines.length > 0) {
      if (payload.tlyric?.lyric?.trim()) mergeTimedText(lyrics.lines, payload.tlyric.lyric, 'translation')
      if (payload.romalrc?.lyric?.trim()) mergeTimedText(lyrics.lines, payload.romalrc.lyric, 'roman')
      return lyrics
    }
    // Timestamps missing entirely: still usable as an untimed block.
    if (lyrics.plain?.trim()) return lyrics
  }
  // Plain-text-only payloads are uncommon here but do happen for older catalogue entries.
  return null
}

export const chinaProvider: LyricsProvider = {
  id: 'china',
  label: '国内歌词接口',
  kind: 'remote',
  priority: 50,
  origin: 'china',
  async find(query: LyricsQuery, context: LyricsContext): Promise<LyricsHit | null> {
    if (!query.title.trim()) return null
    let candidates: NeteaseCandidate[] = []
    try {
      candidates = await searchCandidates(query, context)
    } catch {
      return null
    }
    const best = pickBestCandidate(
      { title: query.title, artist: query.artist, album: query.album, duration: query.duration },
      candidates,
      MIN_MATCH_SCORE,
    )
    if (!best) return null

    let lyrics: Lyrics | null = null
    try {
      lyrics = await fetchLyrics(best.candidate.song, context)
    } catch {
      return null
    }
    if (!lyrics || (lyrics.lines.length === 0 && !lyrics.plain?.trim())) return null

    return {
      lyrics,
      provider: 'china',
      label: '国内歌词接口',
      confidence: Math.round(best.match.score),
      detail: `search match · ${best.candidate.title} — ${best.candidate.artist} (score ${Math.round(best.match.score)})`,
    }
  },
}
