/**
 * The contract every lyrics provider implements.
 *
 * A provider is a plugin in the real sense: the manager knows nothing about where lyrics come from,
 * and adding a new catalogue means adding one file that exports `LyricsProvider` — no change to the
 * manager, the IPC surface or the UI.
 *
 * Two shapes of provider exist and the difference is what makes the chain fast:
 *  - `local` providers read a file (the user's import, a sidecar `.lrc`, the fetch cache, the audio
 *    file's own tags) and must never touch the network;
 *  - `remote` providers search a catalogue over HTTP, must tolerate being offline, and are only
 *    reached once every local provider has said "not me".
 */

import type { Lyrics, LyricsAttempt, LyricsOrigin, LyricsProviderId, LyricsResolution } from '../../shared/lyrics'
import type { AudioTrack, AuroraSettings } from '../../shared/types'

/**
 * The provider contract's vocabulary is shared with the renderer (it crosses IPC), so the ids and
 * the resolution report are re-exported here rather than declared twice.
 */
export type { LyricsAttempt, LyricsProviderId, LyricsResolution }

export interface LyricsQuery {
  track: AudioTrack
  title: string
  artist: string
  album: string
  /** Seconds; `0` when the file/track does not declare one. */
  duration: number
  /** Absolute path of the audio file, for local tracks only. */
  filePath?: string
}

export interface LyricsHit {
  lyrics: Lyrics
  provider: LyricsProviderId
  /** Human label shown in the UI ("LRCLIB 公开歌词库"). */
  label: string
  /** 0–100 match confidence, when the provider had to pick from search results. */
  confidence?: number
  /** One line describing what was matched, for the diagnostics log. */
  detail?: string
  /** `true` when the catalogue positively reports an instrumental track. */
  instrumental?: boolean
}

export interface LyricsContext {
  settings: AuroraSettings
  secrets: Record<string, Record<string, string>>
  /** `true` for background passes (自动补齐信息) — short timeouts, no retries. */
  quiet?: boolean
}

export interface LyricsProvider {
  id: LyricsProviderId
  label: string
  kind: 'local' | 'remote'
  /** Resolution order inside the chain; lower runs first. */
  priority: number
  /** The lyric origin this provider's results are tagged with. */
  origin: LyricsOrigin
  find(query: LyricsQuery, context: LyricsContext): Promise<LyricsHit | null>
}

/** Ordering helper so the chain reads the same everywhere it is built. */
export function byPriority(providers: LyricsProvider[]): LyricsProvider[] {
  return [...providers].sort((a, b) => a.priority - b.priority)
}


