import { app } from 'electron'
import { createHash } from 'node:crypto'
import { basename, extname, join } from 'node:path'
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { parseFile } from 'music-metadata'
import { readMeta, readTracks, trackFingerprints, writeMeta, writeTracks } from './database'
import { recordDiagnostics } from './diagnostics'
import type { AudioTrack, ImportProgress, LibraryImportResult } from '../shared/types'
import { AUDIO_EXTENSION_SET, MAX_IMPORT_FILES, MAX_SCAN_DEPTH } from '../shared/constants'
import { audioUrl, authorizeAudio, coverUrl, releaseAudio } from './media'

const LIBRARY_VERSION = 1
const METADATA_CONCURRENCY = 4
const MAX_COVER_BYTES = 6 * 1024 * 1024
const COVER_FORMATS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

interface StoredTrack {
  id: string
  filePath: string
  title: string
  artist: string
  album: string
  duration: number
  format: string
  coverFile?: string
  addedAt: number
  /** Technical facts read at import time; drive the lossless / hi-res views without re-parsing. */
  bitrate?: number
  sampleRate?: number
  bitsPerSample?: number
}

/** Fields a metadata pass or a tag edit may change on an existing entry. */
export interface StoredTrackPatch {
  title?: string
  artist?: string
  album?: string
  coverFile?: string
  duration?: number
}

interface LibraryFile {
  version: number
  tracks: StoredTrack[]
}

let library: StoredTrack[] = []
const knownIds = new Set<string>()
/**
 * The rows already on disk, keyed by the same hash the ids use, plus each file's last known mtime and
 * size. Together they are what makes a rescan incremental: a file whose size and mtime have not moved
 * does not need its tags read again — the row already has them.
 */
const storedById = new Map<string, StoredTrack>()
let fingerprints = new Map<string, { mtime: number; size: number }>()
let coversDirectory = ''
let libraryFile = ''
let missingIds: string[] = []
let notifier: ((channel: string, payload: unknown) => void) | null = null
let saveTimer: NodeJS.Timeout | null = null

export function setLibraryNotifier(next: (channel: string, payload: unknown) => void): void {
  notifier = next
}

function emit(channel: string, payload: unknown): void {
  notifier?.(channel, payload)
}

function hash(value: string): string {
  return createHash('sha1').update(value).digest('hex')
}

function toPublicTrack(track: StoredTrack): AudioTrack {
  return {
    id: track.id,
    origin: 'local',
    title: track.title,
    artist: track.artist,
    album: track.album,
    duration: track.duration,
    format: track.format,
    filePath: track.filePath,
    fileUrl: audioUrl(track.id),
    cover: track.coverFile ? coverUrl(track.coverFile) : undefined,
    addedAt: track.addedAt,
    ...(track.bitrate ? { bitrate: track.bitrate } : {}),
    ...(track.sampleRate ? { sampleRate: track.sampleRate } : {}),
    ...(track.bitsPerSample ? { bitsPerSample: track.bitsPerSample } : {}),
  }
}

async function ensureDirectories(): Promise<void> {
  const userData = app.getPath('userData')
  coversDirectory = join(userData, 'covers')
  libraryFile = join(userData, 'library.json')
  await mkdir(coversDirectory, { recursive: true })
}

function scheduleSave(): void {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    void persist()
  }, 400)
}

/**
 * Writes the track table.
 *
 * The database is the store; the JSON file is only written when the database is unavailable (the
 * driver refused to load, a locked file). `writeTracks` returning false is therefore the signal that the
 * fallback is in play, not an error to swallow.
 */
/** The mirror's identity: modification time plus size is enough to notice any rewrite. */
async function mirrorStamp(): Promise<string> {
  try {
    const info = await stat(libraryFile)
    return `${Math.round(info.mtimeMs)}:${info.size}`
  } catch {
    return ''
  }
}

/** The serialization last written, so a save with unchanged content does not touch the disk. */
let lastMirrorPayload = ''
/** A failed mirror write is recorded once per session, not on every library change. */
let mirrorWriteFailureLogged = false

async function persist(): Promise<void> {
  const payload: LibraryFile = { version: LIBRARY_VERSION, tracks: library }
  /*
   * Both stores are written, in this order.
   *
   * The database is the one that is read back, but the JSON file stays a live mirror rather than a legacy
   * artefact: it is what makes the data recoverable if the database is ever lost (deleted, corrupted,
   * a driver that stops loading). Writing only the database would make a single file the only copy of a
   * user's library, which is not a trade this project makes for a storage upgrade.
   */
  writeTracks(library)
  const body = JSON.stringify(payload)
  // A large library serialises to megabytes; rewriting an identical mirror is pure disk churn, and the
  // timestamp below is what lets the *next launch* skip reading it back at all.
  if (body === lastMirrorPayload) {
    writeMeta('library-mirror-stamp', await mirrorStamp())
    return
  }
  try {
    await writeFile(libraryFile, body, 'utf8')
    lastMirrorPayload = body
    writeMeta('library-mirror-stamp', await mirrorStamp())
  } catch (error) {
    // A failed write must never break playback; the in-memory library stays valid. It is
    // recorded once, though: a mirror that silently stops updating makes a later launch
    // recover a stale library, which looks like deleted tracks coming back.
    if (!mirrorWriteFailureLogged) {
      mirrorWriteFailureLogged = true
      recordDiagnostics('main', 'library-mirror-write', error instanceof Error ? error.message : String(error))
    }
  }
}

export async function initLibrary(): Promise<void> {
  await ensureDirectories()
  // The database was opened by `initDatabase` before this; both it and the JSON fallback have to be
  // asked, because which one holds the rows is exactly what the settings page reports.
  const stored = readTracks()
  const stamp = await mirrorStamp()
  /*
   * The fast path, and the reason the mirror does not cost anything at startup.
   *
   * When the database already holds rows and the mirror's stamp is the one we wrote last time, the file
   * cannot contain anything the database does not — so a multi-megabyte parse is skipped entirely. Any
   * other combination (no rows, edited file, a file left by an older build) falls through to the full read
   * below, which is what keeps the "whichever store has more rows wins" rule honest.
   */
  if (stored && stored.length > 0 && stamp !== '' && readMeta('library-mirror-stamp') === stamp) {
    library = stored.filter(isStoredTrack)
  } else {
    let fromJson: StoredTrack[] = []
    try {
      const raw = await readFile(libraryFile, 'utf8')
      const parsed = JSON.parse(raw) as Partial<LibraryFile>
      fromJson = Array.isArray(parsed.tracks) ? parsed.tracks.filter(isStoredTrack) : []
    } catch {
      fromJson = []
    }
    library = stored && stored.length >= fromJson.length ? stored.filter(isStoredTrack) : fromJson
  }
  if (library.length > 0) {
    void writeTracks(library)
    writeMeta('library-mirror-stamp', stamp)
  }
  knownIds.clear()
  storedById.clear()
  for (const track of library) {
    knownIds.add(track.id)
    storedById.set(track.id, track)
    authorizeAudio(track.id, track.filePath)
  }
  fingerprints = trackFingerprints()
  void verifyMissingTracks()
}

function isStoredTrack(value: unknown): value is StoredTrack {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<StoredTrack>
  return typeof candidate.id === 'string' && typeof candidate.filePath === 'string'
}

/** Marks tracks whose file disappeared so the UI can badge them instead of failing silently. */
async function verifyMissingTracks(): Promise<void> {
  const missing: string[] = []
  let cursor = 0
  const workers = Array.from({ length: 8 }, async () => {
    while (cursor < library.length) {
      const track = library[cursor++]
      try {
        await stat(track.filePath)
      } catch {
        missing.push(track.id)
      }
    }
  })
  await Promise.all(workers)
  missingIds = missing
  emit('library:missing', missing)
}

export function listTracks(): AudioTrack[] {
  return library.map(toPublicTrack)
}

export function listMissingIds(): string[] {
  return missingIds
}

export function getTrackPath(id: string): string | undefined {
  return library.find((track) => track.id === id)?.filePath
}

export function removeTrack(id: string): boolean {
  const index = library.findIndex((track) => track.id === id)
  if (index < 0) return false
  library.splice(index, 1)
  knownIds.delete(id)
  releaseAudio(id)
  missingIds = missingIds.filter((missing) => missing !== id)
  scheduleSave()
  return true
}

async function saveCover(picture: { data: Uint8Array; format: string }): Promise<string | undefined> {
  if (picture.data.length === 0 || picture.data.length > MAX_COVER_BYTES) return undefined
  const extension = COVER_FORMATS[picture.format.toLowerCase()]
  if (!extension) return undefined
  const fileName = `${hash(Buffer.from(picture.data).toString('base64'))}.${extension}`
  try {
    await writeFile(join(coversDirectory, fileName), Buffer.from(picture.data), { flag: 'wx' })
  } catch {
    // Cover already cached from a previous import.
  }
  return fileName
}

async function readTrackMetadata(filePath: string): Promise<StoredTrack | null> {
  let resolvedPath: string
  let size = 0
  let modified = 0
  try {
    resolvedPath = await realpath(filePath)
    const info = await stat(resolvedPath)
    if (!info.isFile()) return null
    size = info.size
    modified = info.mtimeMs
  } catch {
    return null
  }

  const extension = extname(resolvedPath).toLowerCase()
  if (!AUDIO_EXTENSION_SET.has(extension)) return null

  /*
   * Incremental scan: an unchanged file already has a row, and re-reading its tags only to write the same
   * values back is the difference between a rescan of a 20,000-file folder taking seconds and taking
   * minutes. A file that moved on (retagged elsewhere, replaced) falls through to a full read.
   */
  const id = hash(resolvedPath)
  const fingerprint = fingerprints.get(id)
  if (fingerprint && fingerprint.size === size && Math.abs(fingerprint.mtime - modified) < 2) {
    const known = storedById.get(id)
    if (known) return known
  }

  const fallbackTitle = basename(resolvedPath, extension)
  const track: StoredTrack = {
    id: hash(resolvedPath),
    filePath: resolvedPath,
    title: fallbackTitle,
    artist: '未知艺术家',
    album: '未知专辑',
    duration: 0,
    format: extension.slice(1).toUpperCase(),
    addedAt: Date.now(),
  }

  try {
    const metadata = await parseFile(resolvedPath, { skipCovers: false })
    const common = metadata.common
    if (common.title?.trim()) track.title = common.title.trim()
    if (common.artist?.trim()) track.artist = common.artist.trim()
    if (common.album?.trim()) track.album = common.album.trim()
    track.duration = metadata.format.duration ?? 0
    track.bitrate = metadata.format.bitrate
    track.sampleRate = metadata.format.sampleRate
    track.bitsPerSample = metadata.format.bitsPerSample
    const picture = common.picture?.[0]
    if (picture) track.coverFile = await saveCover(picture)
  } catch {
    // Unreadable tags are expected on some files; the file is still playable by path.
  }

  // Keep the in-session fingerprint fresh so a second scan in the same run stays incremental.
  storedById.set(track.id, track)
  fingerprints.set(track.id, { mtime: modified, size })
  return track
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await worker(items[index])
    }
  })
  await Promise.all(runners)
  return results
}

export async function importAudioFiles(filePaths: string[]): Promise<LibraryImportResult> {
  const unique = Array.from(new Set(filePaths))
  const total = unique.length
  let processed = 0
  emit('library:import-progress', { scanning: true, processed: 0, total } satisfies ImportProgress)

  const added: AudioTrack[] = []
  let duplicated = 0
  let failed = 0

  const tracks = await mapWithConcurrency(unique, METADATA_CONCURRENCY, async (filePath) => {
    const track = await readTrackMetadata(filePath)
    processed += 1
    if (processed % 5 === 0 || processed === total) {
      emit('library:import-progress', { scanning: true, processed, total } satisfies ImportProgress)
    }
    return track
  })

  for (const track of tracks) {
    if (!track) {
      failed += 1
      continue
    }
    if (knownIds.has(track.id)) {
      duplicated += 1
      continue
    }
    knownIds.add(track.id)
    authorizeAudio(track.id, track.filePath)
    library.push(track)
    added.push(toPublicTrack(track))
  }

  if (added.length > 0) scheduleSave()
  emit('library:import-progress', { scanning: false, processed: total, total } satisfies ImportProgress)

  return { added, duplicated, failed }
}

async function collectAudioFiles(root: string): Promise<string[]> {
  const found: string[] = []
  const queue: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }]

  while (queue.length > 0 && found.length < MAX_IMPORT_FILES) {
    const current = queue.shift()
    if (!current) break
    let entries
    try {
      entries = await readdir(current.directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (found.length >= MAX_IMPORT_FILES) break
      const fullPath = join(current.directory, entry.name)
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || current.depth >= MAX_SCAN_DEPTH) continue
        queue.push({ directory: fullPath, depth: current.depth + 1 })
        continue
      }
      if (!entry.isFile()) continue
      if (entry.name.startsWith('._')) continue
      if (AUDIO_EXTENSION_SET.has(extname(entry.name).toLowerCase())) found.push(fullPath)
    }
  }

  return found
}

export async function importFolder(folderPath: string): Promise<LibraryImportResult> {
  emit('library:import-progress', { scanning: true, processed: 0, total: 0 } satisfies ImportProgress)
  const files = await collectAudioFiles(folderPath)
  if (files.length === 0) {
    emit('library:import-progress', { scanning: false, processed: 0, total: 0 } satisfies ImportProgress)
    return { added: [], duplicated: 0, failed: 0 }
  }
  return importAudioFiles(files)
}

/**
 * Imports a mixed list of paths — what a drag-and-drop actually hands over.
 *
 * Folders are walked with the same scanner the 「扫描文件夹」 button uses (same hidden-file rules, same
 * depth and file caps), then everything goes through the one import pass. Duplicates are folded away
 * before the metadata pass, so dropping a folder *and* one of the files inside it does not read that file
 * twice.
 *
 * Files that are not audio are counted separately as `unsupported` rather than as `failed`: a dropped
 * `.txt` is not a broken song, and reporting it as one would send the user looking for a file problem
 * that does not exist.
 */
export async function importPaths(paths: string[]): Promise<LibraryImportResult> {
  emit('library:import-progress', { scanning: true, processed: 0, total: 0 } satisfies ImportProgress)

  const files: string[] = []
  const seen = new Set<string>()
  let unsupported = 0

  for (const candidate of Array.from(new Set(paths))) {
    let info
    try {
      info = await stat(candidate)
    } catch {
      // A path that is gone by the time we look is skipped: the user's drop is a request, not a promise.
      continue
    }
    if (info.isDirectory()) {
      for (const found of await collectAudioFiles(candidate)) {
        if (seen.has(found)) continue
        seen.add(found)
        files.push(found)
      }
      continue
    }
    if (!info.isFile()) continue
    if (!AUDIO_EXTENSION_SET.has(extname(candidate).toLowerCase())) {
      unsupported += 1
      continue
    }
    if (seen.has(candidate)) continue
    seen.add(candidate)
    files.push(candidate)
  }

  if (files.length === 0) {
    emit('library:import-progress', { scanning: false, processed: 0, total: 0 } satisfies ImportProgress)
    return { added: [], duplicated: 0, failed: 0, unsupported }
  }

  const result = await importAudioFiles(files)
  return { ...result, unsupported }
}

/* --------------------------------------------------------- administration surface */

/** Raw entry a metadata pass / tag editor needs (file path and whether art is already cached). */
export interface StoredTrackView {
  id: string
  filePath: string
  title: string
  artist: string
  album: string
  duration: number
  format: string
  hasCover: boolean
}

/**
 * Entries as the administration code sees them. Deliberately not `listTracks()`: that shape is the
 * renderer's view (media URLs etc.) and loses the facts a rewrite needs.
 */
export function listStoredTracks(): StoredTrackView[] {
  return library.map((track) => ({
    id: track.id,
    filePath: track.filePath,
    title: track.title,
    artist: track.artist,
    album: track.album,
    duration: track.duration,
    format: track.format,
    hasCover: Boolean(track.coverFile),
  }))
}

/** Caches bytes downloaded from a platform as this library's cover for a track. */
export async function saveCoverBytes(data: Uint8Array, mime: string): Promise<string | undefined> {
  return saveCover({ data, format: mime })
}

const EXTENSION_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
}

/**
 * The cached cover for a local track, as bytes.
 *
 * A tag rewrite has to re-emit the whole ID3 tag, so it needs the artwork the library already
 * holds; re-reading it out of the audio file would work too but is far slower on large files.
 */
export async function readCoverBytes(id: string): Promise<{ mime: string; data: Buffer } | null> {
  const track = library.find((entry) => entry.id === id)
  if (!track?.coverFile) return null
  const extension = extname(track.coverFile).slice(1).toLowerCase()
  const mime = EXTENSION_MIME[extension]
  if (!mime) return null
  try {
    const data = await readFile(join(coversDirectory, track.coverFile))
    return data.byteLength > 0 ? { mime, data } : null
  } catch {
    return null
  }
}

/**
 * Applies a metadata patch to an existing entry and persists it. Only the fields present are
 * touched, so a caller that filled the cover never clobbers the title it did not match.
 */
export function applyTrackPatch(id: string, patch: StoredTrackPatch): AudioTrack | null {
  const track = library.find((entry) => entry.id === id)
  if (!track) return null
  if (patch.title !== undefined) track.title = patch.title
  if (patch.artist !== undefined) track.artist = patch.artist
  if (patch.album !== undefined) track.album = patch.album
  if (patch.coverFile !== undefined) track.coverFile = patch.coverFile
  if (patch.duration !== undefined) track.duration = patch.duration
  scheduleSave()
  return toPublicTrack(track)
}

/** True when the id belongs to a local entry (used to reject online ids in admin calls). */
export function hasStoredTrack(id: string): boolean {
  return library.some((entry) => entry.id === id)
}

/**
 * Re-reads one file's tags from disk and folds them into the library entry.
 *
 * Used after an ID3 rewrite: the tag is the source of truth once written, so the entry is refreshed
 * from the file rather than from the values we just sent (which may have been normalised on write).
 */
export async function refreshFromFile(id: string): Promise<AudioTrack | null> {
  const track = library.find((entry) => entry.id === id)
  if (!track) return null
  try {
    const metadata = await parseFile(track.filePath, { skipCovers: true, duration: false })
    const common = metadata.common
    if (common.title?.trim()) track.title = common.title.trim()
    if (common.artist?.trim()) track.artist = common.artist.trim()
    if (common.album?.trim()) track.album = common.album.trim()
  } catch {
    // An unreadable tag must not lose the entry; the patched values stay in memory.
  }
  scheduleSave()
  return toPublicTrack(track)
}

/** Alerts the renderer that the local library changed outside an import (download sync, scrape). */
export function notifyLibraryChanged(): void {
  emit('library:changed', listTracks())
}
