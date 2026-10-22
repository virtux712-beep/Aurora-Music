/**
 * The lyrics engine's disk layer.
 *
 * Three kinds of file live here, and keeping them apart is what makes "local first" true rather
 * than aspirational:
 *
 *  1. **User lyrics** — `<sha1(trackId)>.lrc` in the lyrics directory. Written only when the user
 *     imports or corrects lyrics by hand, and always the highest-priority answer.
 *  2. **Sidecar `.lrc`** — sitting next to the audio file, named after it (`歌名.lrc`). Read first
 *     for local tracks, and where a fetched lyric is written so the next session (and any other
 *     player on the machine) finds it without going online.
 *  3. **Fetched cache** — everything obtained from a network provider for a track that has no file
 *     of its own (online tracks, mostly): `歌手 - 歌名.lrc` in the lyrics directory, indexed by a
 *     content key so a lookup is a filtered read rather than a full directory scan.
 *
 * Nothing here decides policy: writes are best-effort, and a read-only music folder (or a full
 * disk) degrades to "this session only" instead of failing the lyrics lookup.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { extname } from 'node:path'

export const MAX_LYRICS_BYTES = 512 * 1024
const CACHE_INDEX_FILE = 'index.json'
const CACHE_INDEX_VERSION = 1
/** Characters Windows forbids in a file name, plus the ones that make a path ambiguous. */
const UNSAFE_FILE_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g
/** Reserved device names on Windows: a file called `CON.lrc` cannot be created. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

export interface CachedLyricsMeta {
  file: string
  key: string
  provider: string
  title: string
  artist: string
  duration: number
  savedAt: number
}

interface CacheIndex {
  version: number
  entries: Record<string, CachedLyricsMeta>
}

let lyricsDirectory = ''
let cacheIndex: CacheIndex = { version: CACHE_INDEX_VERSION, entries: {} }
let ready = false
/** Serialises index writes so two concurrent fetches cannot interleave into a corrupt file. */
let indexChain: Promise<void> = Promise.resolve()

export async function initLyricsStore(directory: string): Promise<void> {
  lyricsDirectory = directory
  try {
    await mkdir(lyricsDirectory, { recursive: true })
    ready = true
  } catch {
    ready = false
    return
  }
  try {
    const raw = await readFile(join(lyricsDirectory, CACHE_INDEX_FILE), 'utf8')
    const parsed = JSON.parse(raw) as CacheIndex
    if (parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object') {
      cacheIndex = { version: CACHE_INDEX_VERSION, entries: pruneIndex(parsed.entries) }
    }
  } catch {
    // No index yet (or it was damaged): an empty one is correct, and the deterministic file names
    // still resolve for anything that was fetched before the index existed.
    cacheIndex = { version: CACHE_INDEX_VERSION, entries: {} }
  }
}

export function isLyricsStoreReady(): boolean {
  return ready
}

export function lyricsDir(): string {
  return lyricsDirectory
}

function trackKey(trackId: string): string {
  return createHash('sha1').update(trackId).digest('hex').slice(0, 32)
}

/** Where hand-imported lyrics for a track live. Stable across sessions by design. */
export function userLyricsPath(trackId: string): string {
  return join(lyricsDirectory, `${trackKey(trackId)}.lrc`)
}

export async function readIfExists(path: string): Promise<string | null> {
  try {
    const raw = await readFile(path, 'utf8')
    if (raw.length > MAX_LYRICS_BYTES) return null
    return raw.replace(/^\uFEFF/, '')
  } catch {
    return null
  }
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export async function writeTextFile(path: string, text: string): Promise<boolean> {
  try {
    // Write-then-rename: a crash mid-write leaves the old file intact instead of a half-written one.
    const temporary = `${path}.tmp-${process.pid}`
    await writeFile(temporary, text, 'utf8')
    await rename(temporary, path)
    return true
  } catch {
    return false
  }
}

/** `.lrc` files a local track may be sitting next to, covering the common naming conventions. */
export function sidecarCandidates(filePath: string): string[] {
  const extension = extname(filePath)
  const base = filePath.slice(0, filePath.length - extension.length)
  return [`${base}.lrc`, `${base}.LRC`, `${base}.Lrc`, `${filePath}.lrc`]
}

/** `歌手 - 歌名.lrc`, cleaned of anything a file system cannot hold. */
export function cacheFileName(artist: string, title: string): string {
  const raw = [artist.trim(), title.trim()].filter(Boolean).join(' - ') || 'lyrics'
  let safe = raw.replace(UNSAFE_FILE_CHARS, '_').replace(/\s+/g, ' ').trim()
  safe = safe.replace(/\.+$/, '')
  if (safe.length > 120) safe = safe.slice(0, 120).trim()
  if (!safe || WINDOWS_RESERVED.test(safe)) safe = `lyrics-${createHash('sha1').update(raw).digest('hex').slice(0, 8)}`
  return `${safe}.lrc`
}

/**
 * The content key of a track for cache purposes: normalised title + artist, plus the rounded
 * duration when it is known.
 *
 * Duration belongs in the key — a live version and the studio take share a name but not a length —
 * yet it must not be *required*: tracks tagged without a duration still get cached, they just share
 * the duration-less key.
 */
export function cacheKey(title: string, artist: string, duration: number): string {
  const source = [title.trim().toLowerCase(), artist.trim().toLowerCase(), duration > 0 ? Math.round(duration) : ''].join('\u0001')
  return createHash('sha1').update(source).digest('hex').slice(0, 20)
}

function pruneIndex(entries: Record<string, CachedLyricsMeta>): Record<string, CachedLyricsMeta> {
  const pruned: Record<string, CachedLyricsMeta> = {}
  for (const [key, value] of Object.entries(entries)) {
    if (!value || typeof value.file !== 'string' || !value.file) continue
    pruned[key] = {
      file: value.file,
      key: typeof value.key === 'string' ? value.key : key,
      provider: typeof value.provider === 'string' ? value.provider : 'unknown',
      title: typeof value.title === 'string' ? value.title : '',
      artist: typeof value.artist === 'string' ? value.artist : '',
      duration: Number.isFinite(value.duration) ? Number(value.duration) : 0,
      savedAt: Number.isFinite(value.savedAt) ? Number(value.savedAt) : 0,
    }
  }
  return pruned
}

function persistIndex(): void {
  if (!ready) return
  const snapshot = JSON.stringify({ version: CACHE_INDEX_VERSION, entries: cacheIndex.entries }, null, 2)
  indexChain = indexChain
    .then(async () => {
      await writeTextFile(join(lyricsDirectory, CACHE_INDEX_FILE), snapshot)
    })
    .catch(() => undefined)
}

export interface CachedLyrics extends CachedLyricsMeta {
  path: string
  text: string
}

/** Reads a previously fetched lyric for this track, if one is on disk. */
export async function readCachedLyrics(title: string, artist: string, duration: number): Promise<CachedLyrics | null> {
  if (!ready) return null
  const key = cacheKey(title, artist, duration)
  const entry = cacheIndex.entries[key]
  if (entry) {
    const path = join(lyricsDirectory, entry.file)
    const text = await readIfExists(path)
    if (text?.trim()) return { ...entry, path, text }
    // The index pointed at a file that is gone: drop the stale entry and fall through to the probe.
    delete cacheIndex.entries[key]
    persistIndex()
  }
  // No index hit: the file may still exist under its deterministic name (index written before an
  // interrupted start-up, or removed by hand). Probe it before declaring a miss.
  const direct = cacheFileName(artist, title)
  const directPath = join(lyricsDirectory, direct)
  const text = await readIfExists(directPath)
  if (!text?.trim()) return null
  const meta: CachedLyricsMeta = {
    file: direct,
    key,
    provider: 'cache',
    title,
    artist,
    duration,
    savedAt: Date.now(),
  }
  cacheIndex.entries[key] = meta
  persistIndex()
  return { ...meta, path: directPath, text }
}

/**
 * Stores fetched lyrics. Returns the path written (or `null` when the disk refused).
 *
 * Two writes happen for local tracks and one for online ones:
 *  - always into the lyrics directory, which is what the next session reads;
 *  - for a local track, also as a sidecar `.lrc` next to the audio file — but only when no sidecar
 *    exists yet, because overwriting one would silently destroy a correction the user made.
 */
export async function writeCachedLyrics(
  track: { title: string; artist: string; duration: number; filePath?: string },
  text: string,
  provider: string,
): Promise<{ path: string | null; sidecar: string | null }> {
  if (!ready) return { path: null, sidecar: null }
  const body = text.replace(/\r\n?/g, '\n').trim()
  if (!body) return { path: null, sidecar: null }

  const key = cacheKey(track.title, track.artist, track.duration)
  let file = cacheFileName(track.artist, track.title)
  const existing = cacheIndex.entries[key]
  if (existing) {
    file = existing.file
  } else {
    // Two different songs can share a display name; give the second one a suffix instead of
    // letting it overwrite the first.
    const taken = Object.values(cacheIndex.entries).find((entry) => entry.file === file && entry.key !== key)
    if (taken) file = file.replace(/\.lrc$/, `-${key.slice(0, 6)}.lrc`)
  }

  const path = join(lyricsDirectory, file)
  const written = await writeTextFile(path, body)
  cacheIndex.entries[key] = {
    file,
    key,
    provider,
    title: track.title,
    artist: track.artist,
    duration: track.duration,
    savedAt: Date.now(),
  }
  persistIndex()

  let sidecar: string | null = null
  if (track.filePath) {
    const target = sidecarCandidates(track.filePath)[0]
    if (!(await fileExists(target))) {
      sidecar = (await writeTextFile(target, body)) ? target : null
    }
  }
  return { path: written ? path : null, sidecar }
}

/** Removes the cached copies of a track's lyrics (both the cache entry and any sidecar we wrote). */
export async function removeCachedLyrics(title: string, artist: string, duration: number): Promise<boolean> {
  if (!ready) return false
  const key = cacheKey(title, artist, duration)
  const entry = cacheIndex.entries[key]
  if (!entry) return false
  delete cacheIndex.entries[key]
  persistIndex()
  try {
    await rm(join(lyricsDirectory, entry.file))
    return true
  } catch {
    return false
  }
}

/** Number of cached lyric files currently indexed. Used by the diagnostics surface and tests. */
export function cachedLyricsCount(): number {
  return Object.keys(cacheIndex.entries).length
}

/** Exposed for tests/diagnostics: the on-disk file list, without touching the index. */
export async function listLyricsFiles(): Promise<string[]> {
  if (!ready) return []
  try {
    const names = await readdir(lyricsDirectory)
    return names.filter((name) => name.toLowerCase().endsWith('.lrc'))
  } catch {
    return []
  }
}

export async function removeUserLyricsFile(trackId: string): Promise<boolean> {
  try {
    await rm(userLyricsPath(trackId))
    return true
  } catch {
    return false
  }
}
