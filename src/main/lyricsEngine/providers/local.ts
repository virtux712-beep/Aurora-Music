/**
 * LocalProvider — everything already on the user's disk.
 *
 * Three sub-sources in strict priority order, because they mean different things:
 *
 *  1. **hand-imported lyrics** (`userLyricsPath`) — the user typed or imported them, so they win
 *     over anything automatic, forever;
 *  2. **a sidecar `.lrc` next to the audio file** — a real file the user (or another tool) placed
 *     there; the same thing every desktop player reads;
 *  3. **the fetch cache** — what an earlier session pulled off the network for this track. This is
 *     the "第一次联网获取 → 以后本地优先" step: on the second play there is no request at all.
 *
 * This provider never hits the network. If it returns `null`, the manager decides whether a remote
 * provider is allowed to run.
 */

import { parseLyricsText } from '../../../shared/lyrics'
import { readIfExists, readCachedLyrics, sidecarCandidates, userLyricsPath } from '../store'
import type { LyricsContext, LyricsHit, LyricsProvider, LyricsQuery } from '../types'

async function fromUser(query: LyricsQuery): Promise<LyricsHit | null> {
  const raw = await readIfExists(userLyricsPath(query.track.id))
  if (!raw?.trim()) return null
  return {
    lyrics: parseLyricsText(raw, 'user'),
    provider: 'local',
    label: '你导入的歌词',
    // Deliberately not the phrase `user import` here: electron-vite's `vite:esm-shim` locates the end
    // of the last static import with a regex rather than a parser, and a string containing the word
    // 「import」 followed by a quote made it splice its shim into the middle of a later string
    // literal, breaking the whole main-process build. Hyphenated wording cannot match that pattern.
    detail: 'hand-entered',
  }
}

async function fromSidecar(query: LyricsQuery): Promise<LyricsHit | null> {
  if (!query.filePath) return null
  for (const candidate of sidecarCandidates(query.filePath)) {
    const raw = await readIfExists(candidate)
    if (raw?.trim()) {
      return {
        lyrics: parseLyricsText(raw, 'sidecar'),
        provider: 'local',
        label: '.lrc 歌词文件',
        detail: candidate,
      }
    }
  }
  return null
}

async function fromCache(query: LyricsQuery): Promise<LyricsHit | null> {
  const cached = await readCachedLyrics(query.title, query.artist, query.duration)
  if (!cached) return null
  return {
    lyrics: parseLyricsText(cached.text, 'cache'),
    provider: 'local',
    label: '本机歌词缓存',
    detail: `${cached.provider} · ${cached.file}`,
  }
}

export const localProvider: LyricsProvider = {
  id: 'local',
  label: '本地歌词',
  kind: 'local',
  priority: 10,
  origin: 'sidecar',
  async find(query: LyricsQuery, _context: LyricsContext): Promise<LyricsHit | null> {
    void _context
    return (await fromUser(query)) ?? (await fromSidecar(query)) ?? (await fromCache(query))
  },
}
