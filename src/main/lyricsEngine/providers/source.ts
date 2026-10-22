/**
 * SourceProvider — lyrics from an installed source plugin.
 *
 * Kept as a provider (rather than a hardcoded branch) because it has exactly the same shape as the
 * other catalogues: it may answer, it may not, and it may only be allowed to answer for tracks the
 * source itself produced.
 *
 * It is the first *remote* provider for online tracks: the service that served the audio usually
 * also has the right lyric and its clock (a source that returns per-word timings beats a generic
 * catalogue's line times). It never runs for local files, where no source claims ownership.
 */

import { lyricsAreEmpty } from '../../../shared/lyrics'
import { sourceLyrics } from '../../sources'
import type { LyricsContext, LyricsHit, LyricsProvider, LyricsQuery } from '../types'

export const sourceProvider: LyricsProvider = {
  id: 'source',
  label: '音源提供的歌词',
  kind: 'remote',
  priority: 30,
  origin: 'source',
  async find(query: LyricsQuery, context: LyricsContext): Promise<LyricsHit | null> {
    if (query.track.origin !== 'online') return null
    try {
      const lyrics = await sourceLyrics(query.track, context.settings, context.secrets)
      if (!lyrics || lyricsAreEmpty(lyrics)) return null
      return {
        lyrics,
        provider: 'source',
        label: '音源提供的歌词',
        detail: query.track.sourceId ? `source:${query.track.sourceId}` : 'source',
      }
    } catch {
      // A source that is down, unconfigured or simply has no lyrics is a miss, not a failure of the
      // whole chain — the next provider gets its turn.
      return null
    }
  },
}
