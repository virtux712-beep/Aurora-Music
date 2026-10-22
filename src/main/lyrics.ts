/**
 * Aurora's lyrics service — now a thin facade over the **LyricsManager**.
 *
 * Everything that used to live here (which file to read, in which order, how to cache an import)
 * moved into `main/lyricsEngine/`, because the old shape had a hard ceiling: it could read a sidecar
 * `.lrc` and an embedded tag, and that was it. Most local libraries have neither, so most local music
 * showed 暂无歌词.
 *
 * This file stays as the stable seam the rest of the main process already imports (`ipc.ts`,
 * `desktopLyrics.ts`, `libraryScrape.ts`), so the upgrade did not need to ripple through them.
 *
 * Resolution order is the manager's business, not this file's; see `lyricsEngine/manager.ts`.
 */

import { app } from 'electron'
import { join } from 'node:path'
import type { Lyrics } from '../shared/lyrics'
import type { AudioTrack, AuroraSettings } from '../shared/types'
import { getTrackPath } from './library'
import {
  clearStoredLyrics,
  forgetLyrics,
  initLyricsManager,
  readUserLyrics,
  resolveLyrics,
  saveUserLyrics as saveUserLyricsViaManager,
  type LyricsResolution,
  type LyricsScope,
} from './lyricsEngine/manager'
import { allSecrets } from './secretStore'

let ready = false

export async function initLyricsService(): Promise<void> {
  // Same directory as before, so lyrics the user imported in an earlier version are still found.
  await initLyricsManager(join(app.getPath('userData'), 'lyrics'))
  ready = true
}

export function isLyricsServiceReady(): boolean {
  return ready
}

/** The absolute path of a local track's audio file, when it is one. */
function filePathFor(track: AudioTrack): string | undefined {
  if (track.origin !== 'local') return undefined
  return track.filePath ?? getTrackPath(track.id)
}

/**
 * Resolves lyrics for a track, from the **fast** half of the chain only: the user's import, a
 * sidecar `.lrc`, the fetch cache, embedded tags, and the track's own source.
 *
 * Returns `null` when nothing is available. It deliberately does not search public catalogues — see
 * `searchLyricsOnline` — because callers on this path are on the UI's critical path (opening the
 * lyrics page, the desktop lyric window, a track change) and must not wait on the network.
 */
export async function getLyrics(track: AudioTrack, settings: AuroraSettings, force = false): Promise<Lyrics | null> {
  const resolution = await resolveLyrics(track, settings, allSecrets(), {
    force,
    scope: 'fast',
    filePath: filePathFor(track),
  })
  return resolution.lyrics
}

/**
 * The slow half: the public catalogues (LRCLIB, the domestic interface). A hit is written to the
 * lyrics cache, so the next `getLyrics` for this track finds it locally.
 */
export async function searchLyricsOnline(track: AudioTrack, settings: AuroraSettings, quiet = false): Promise<LyricsResolution> {
  return resolveLyrics(track, settings, allSecrets(), { force: true, quiet, scope: 'search', filePath: filePathFor(track) })
}

/**
 * The full resolution, for callers that need to explain the outcome — the 「联网自动匹配」 button, the
 * automatic metadata pass, and the smoke tests. Runs the whole chain, local first.
 */
export async function matchLyrics(
  track: AudioTrack,
  settings: AuroraSettings,
  options: { force?: boolean; quiet?: boolean; scope?: LyricsScope } = {},
): Promise<LyricsResolution> {
  return resolveLyrics(track, settings, allSecrets(), {
    force: options.force ?? true,
    quiet: options.quiet,
    scope: options.scope ?? 'all',
    filePath: filePathFor(track),
  })
}

/** Stores user-provided lyrics (LRC or plain text) for a track, replacing any previous version. */
export async function saveUserLyrics(track: AudioTrack, raw: string): Promise<Lyrics | null> {
  return saveUserLyricsViaManager(track, raw)
}

/** Reads back the user's imported lyrics for a track, if any. */
export async function loadUserLyrics(trackId: string): Promise<Lyrics | null> {
  return readUserLyrics(trackId)
}

/**
 * Clears what Aurora stored for a track: the user's import and the fetched cache entry.
 *
 * Takes the whole track rather than just its id because the cache is keyed by the song (title +
 * artist + duration), so an id alone cannot find the cached file that has to go with it.
 */
export async function clearUserLyrics(track: AudioTrack): Promise<boolean> {
  return clearStoredLyrics(track)
}

/** Drops the in-memory copy so the next load reads the disk again. */
export function invalidateLyrics(trackId: string): void {
  forgetLyrics(trackId)
}
