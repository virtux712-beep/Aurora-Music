/**
 * EmbeddedProvider — lyrics stored inside the audio file itself.
 *
 * Covers ID3v2 `USLT` (unsynchronised text) and `SYLT` (synchronised, per-line timestamps, which
 * `music-metadata` exposes as `syncText`), plus Vorbis `LYRICS`/`UNSYNCEDLYRICS` — all of which
 * arrive as `common.lyrics`. Timed frames are preferred over plain ones because they can actually
 * scroll.
 *
 * Read-only and offline. It runs after the sidecar check: a `.lrc` file is easier for the user to
 * edit, so when both exist the file wins.
 */

import { parseFile } from 'music-metadata'
import { finalizeLineEnds, parseLyricsText } from '../../../shared/lyrics'
import type { LyricsContext, LyricsHit, LyricsProvider, LyricsQuery } from '../types'

export const embeddedProvider: LyricsProvider = {
  id: 'embedded',
  label: '音频内嵌歌词',
  kind: 'local',
  priority: 20,
  origin: 'embedded',
  async find(query: LyricsQuery, _context: LyricsContext): Promise<LyricsHit | null> {
    void _context
    if (!query.filePath) return null
    try {
      const metadata = await parseFile(query.filePath, { skipCovers: true, duration: false })
      const tags = metadata.common.lyrics ?? []
      const synchronised = tags.find((tag) => (tag.syncText?.length ?? 0) > 0)
      if (synchronised?.syncText?.length) {
        const lines = synchronised.syncText
          .map((entry) => ({ start: Math.max(0, (entry.timestamp ?? 0) / 1000), text: (entry.text ?? '').trim() }))
          .sort((a, b) => a.start - b.start)
        if (lines.length > 0) {
          return {
            lyrics: { origin: 'embedded', synced: true, offsetMs: 0, lines: finalizeLineEnds(lines) },
            provider: 'embedded',
            label: '音频内嵌歌词',
            detail: 'SYLT',
          }
        }
      }
      const plain = tags.map((tag) => tag.text).find((text) => Boolean(text?.trim()))
      if (!plain) return null
      return {
        lyrics: parseLyricsText(plain, 'embedded'),
        provider: 'embedded',
        label: '音频内嵌歌词',
        detail: 'USLT/LYRICS',
      }
    } catch {
      // An unreadable or unsupported container is simply "no embedded lyrics".
      return null
    }
  },
}
