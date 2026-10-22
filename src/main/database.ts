import { app } from 'electron'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { DatabaseStats } from '../shared/maintenance'

/**
 * The library's database.
 *
 * `library.json` grew into a whole-file rewrite on every scan, which is exactly the shape that loses
 * everything when the process dies mid-write. The rows now live in SQLite (`node-sqlite3-wasm`, the
 * only build that needs no native toolchain and therefore also works in the packaged app), with three
 * commitments:
 *
 *  1. **Nothing is deleted during migration.** The old file is renamed to `library.json.migrated`
 *     *after* the rows are committed, so a crash leaves the original in place and the next launch
 *     simply migrates again.
 *  2. **The engine is reported, never assumed.** If the driver will not load, Aurora keeps working on
 *     a JSON store and says so (`engine: 'json'` with the reason) instead of pretending it is a
 *     database.
 *  3. **The library stays available.** `loadTracks`/`saveTracks` are the only two entry points the
 *     library uses, so the storage decision is confined to this file.
 */

type SqlValue = string | number | null

/**
 * Bindings are always passed as a single **array**.
 *
 * This is not style: `node-sqlite3-wasm`'s positional form (`run(a, b)`) binds only the first value and
 * leaves the rest NULL, which against a `not null` column throws — and against a nullable one would have
 * silently written a half-empty row. An array binds every parameter, so that trap cannot come back.
 */
type Bindings = SqlValue[]

interface Statement {
  all(params?: Bindings): Record<string, SqlValue>[]
  get(params?: Bindings): Record<string, SqlValue> | undefined
  run(params?: Bindings): unknown
}

interface SqliteDatabase {
  exec(sql: string): void
  prepare(sql: string): Statement
  close(): void
}

let database: SqliteDatabase | null = null
let engine: 'sqlite' | 'json' = 'json'
let databasePath = ''
let engineDetail = ''
let migratedFrom = ''
let migrationAt = 0
/** Fallback store, used only while `engine === 'json'`. */
const jsonDocuments = new Map<string, unknown>()

const DOCUMENT_KEYS = new Set(['aurora:favorites', 'aurora:history', 'aurora:playlists', 'aurora:queue', 'aurora:settings'])
const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024

function openSqlite(path: string): SqliteDatabase | null {
  try {
    // Resolved at runtime through a variable so a bundler never tries to inline the package's WASM
    // binary path — the module reads its own file relative to `__dirname`.
    const moduleName = 'node-sqlite3-wasm'
    const require = createRequire(import.meta.url)
    const loaded = require(moduleName) as { Database: new (path: string) => SqliteDatabase }
    const instance = new loaded.Database(path)
    instance.exec('pragma journal_mode = wal')
    return instance
  } catch (error) {
    engineDetail = error instanceof Error ? error.message.slice(0, 200) : 'unknown error'
    return null
  }
}

const SCHEMA = `
create table if not exists meta (key text primary key, value text not null);
create table if not exists tracks (
  id text primary key,
  file_path text,
  mtime integer not null default 0,
  size integer not null default 0,
  payload text not null,
  updated_at integer not null
);
create table if not exists documents (
  key text primary key,
  payload text not null,
  updated_at integer not null,
  bytes integer not null
);
create table if not exists favorites (track_id text primary key, added_at integer not null);
create table if not exists history (track_id text primary key, played_at integer not null, play_count integer not null);
create table if not exists playlists (id text primary key, name text not null, created_at integer not null, updated_at integer not null);
create table if not exists playlist_tracks (playlist_id text not null, track_id text not null, position integer not null);
`

/**
 * Opens the database and imports whatever the previous storage left behind.
 *
 * A failed import is not fatal: the JSON file is untouched, `migratedFrom` stays empty, and the stats
 * endpoint says so — the point of the migration is that it can be attempted again.
 */
export async function initDatabase(userData: string): Promise<void> {
  databasePath = join(userData, 'aurora.db')
  const legacyLibrary = join(userData, 'library.json')

  const instance = openSqlite(databasePath)
  if (!instance) {
    engine = 'json'
    await loadJsonFallback(userData)
    return
  }

  try {
    instance.exec(SCHEMA)
  } catch (error) {
    engineDetail = error instanceof Error ? error.message.slice(0, 200) : 'schema failed'
    try {
      instance.close()
    } catch {
      // Already closed.
    }
    engine = 'json'
    await loadJsonFallback(userData)
    return
  }

  engine = 'sqlite'
  database = instance
  // From here on a failure must not escape: an unhandled rejection during startup is exactly how a
  // database problem turns into "the app does not open", which is worse than any amount of missing tags.
  try {
    await migrateLibrary(instance, legacyLibrary)
  } catch (error) {
    engineDetail = error instanceof Error ? error.message.slice(0, 200) : 'migration failed'
  }
}

async function migrateLibrary(instance: SqliteDatabase, legacyLibrary: string): Promise<void> {

  const imported = instance.prepare('select value from meta where key = ?').get(['library-imported'])
  if (imported) {
    migratedFrom = String(
      instance.prepare('select value from meta where key = ?').get(['library-imported-from'])?.value ?? '',
    )
    migrationAt = Number(imported.value) || 0
    return
  }  const rows = await readLegacyLibrary(legacyLibrary)
  if (!rows) return
  writeTracks(rows)
  /*
   * The old file is left exactly where it is.
   *
   * An earlier version of this migration renamed it to `library.json.migrated`. That is a destructive act
   * on a file the user owns, and it broke every tool that stages a profile by copying `library.json` in —
   * which is also how it was found. The library keeps writing the same file as a mirror (see `persist`), so
   * there is nothing to move and nothing to hide: both stores hold the same rows.
   */

  instance.prepare('insert or replace into meta (key, value) values (?, ?)').run(['library-imported', String(Date.now())])
  instance
    .prepare('insert or replace into meta (key, value) values (?, ?)')
    .run(['library-imported-from', legacyLibrary])
  migratedFrom = legacyLibrary
  migrationAt = Date.now()
}

async function loadJsonFallback(userData: string): Promise<void> {
  try {
    const raw = await readFile(join(userData, 'documents.json'), 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    for (const [key, value] of Object.entries(parsed)) {
      if (DOCUMENT_KEYS.has(key)) jsonDocuments.set(key, value)
    }
  } catch {
    // No fallback store yet.
  }
}

async function readLegacyLibrary(path: string): Promise<unknown[] | null> {
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as { tracks?: unknown }
    return Array.isArray(parsed.tracks) ? parsed.tracks : null
  } catch {
    return null
  }
}

function trackColumns(track: unknown): { id: string; filePath: string; mtime: number; size: number; payload: string } | null {
  if (!track || typeof track !== 'object') return null
  const candidate = track as Record<string, unknown>
  if (typeof candidate.id !== 'string' || !candidate.id) return null
  const filePath = typeof candidate.filePath === 'string' ? candidate.filePath : ''
  const mtime = Number(candidate.addedAt) || 0
  const size = Number(candidate.size) || 0
  return { id: candidate.id, filePath, mtime, size, payload: JSON.stringify(track) }
}

/** Small key/value corner of the database: launch-time bookkeeping, not user data. */
export function readMeta(key: string): string {
  if (!database) return ''
  try {
    return String(database.prepare('select value from meta where key = ?').get([key])?.value ?? '')
  } catch {
    return ''
  }
}

export function writeMeta(key: string, value: string): void {
  if (!database) return
  try {
    database.prepare('insert or replace into meta (key, value) values (?, ?)').run([key, value])
  } catch {
    // Bookkeeping only: a failure here costs one unnecessary read on the next launch, nothing more.
  }
}

/** Replaces the whole track table in one transaction. Returns false when the database is unavailable. */
export function writeTracks(tracks: unknown[]): boolean {
  if (!database) {
    jsonDocuments.set('library:tracks', tracks)
    void writeJsonFallback()
    return false
  }
  database.exec('begin')
  try {
    database.exec('delete from tracks')
    const insert = database.prepare(
      'insert or replace into tracks (id, file_path, mtime, size, payload, updated_at) values (?, ?, ?, ?, ?, ?)',
    )
    const now = Date.now()
    for (const track of tracks) {
      const row = trackColumns(track)
      if (!row) continue
      insert.run([row.id, row.filePath, row.mtime, row.size, row.payload, now])
    }
    database.exec('commit')
    return true
  } catch {
    database.exec('rollback')
    return false
  }
}

export function readTracks(): unknown[] | null {
  if (!database) {
    const stored = jsonDocuments.get('library:tracks')
    if (Array.isArray(stored)) return stored
    return null
  }
  const rows = database.prepare('select payload from tracks order by rowid').all()
  return rows.map((row) => {
    try {
      return JSON.parse(String(row.payload)) as unknown
    } catch {
      return null
    }
  }).filter((value) => value !== null)
}

/**
 * Cheap incremental-scan input: id → the file's last known mtime and size.
 *
 * A rescan compares these against the filesystem and only re-reads tags for files that moved on, which
 * is what makes a large library's rescan feel instant.
 */
export function trackFingerprints(): Map<string, { mtime: number; size: number }> {
  const map = new Map<string, { mtime: number; size: number }>()
  if (!database) return map
  for (const row of database.prepare('select id, mtime, size from tracks').all()) {
    map.set(String(row.id), { mtime: Number(row.mtime) || 0, size: Number(row.size) || 0 })
  }
  return map
}

export function readDocument(key: string): unknown {
  if (!DOCUMENT_KEYS.has(key)) return null
  if (!database) return jsonDocuments.get(key) ?? null
  const row = database.prepare('select payload from documents where key = ?').get([key])
  if (!row) return null
  try {
    return JSON.parse(String(row.payload)) as unknown
  } catch {
    return null
  }
}

export function writeDocument(key: string, value: unknown): boolean {
  if (!DOCUMENT_KEYS.has(key)) return false
  const payload = JSON.stringify(value ?? null)
  if (payload.length > MAX_DOCUMENT_BYTES) return false
  if (!database) {
    jsonDocuments.set(key, value)
    void writeJsonFallback()
    return true
  }
  database
    .prepare('insert or replace into documents (key, payload, updated_at, bytes) values (?, ?, ?, ?)')
    .run([key, payload, Date.now(), payload.length])
  return true
}

async function writeJsonFallback(): Promise<void> {
  try {
    await writeFile(
      join(app.getPath('userData'), 'documents.json'),
      JSON.stringify(Object.fromEntries(jsonDocuments), null, 2),
      'utf8',
    )
  } catch {
    // Best effort: the in-memory copy still serves this session.
  }
}

export async function databaseStats(): Promise<DatabaseStats> {
  let bytes = 0
  try {
    bytes = (await stat(databasePath)).size
  } catch {
    bytes = 0
  }
  const count = (sql: string): number => {
    if (!database) return 0
    try {
      return Number(database.prepare(sql).get()?.c) || 0
    } catch {
      return 0
    }
  }
  return {
    engine,
    path: engineDetail ? `${databasePath}（${engineDetail}）` : databasePath,
    bytes,
    tracks: count('select count(*) c from tracks'),
    favorites: count('select count(*) c from favorites'),
    history: count('select count(*) c from history'),
    playlists: count('select count(*) c from playlists'),
    documents: count('select count(*) c from documents'),
    migratedFrom,
    migrationAt,
  }
}

/** Releases the database file. Called on quit so no lock directory is left behind. */
export function closeDatabase(): void {
  try {
    database?.close()
  } catch {
    // Already closed, or the driver never fully opened it.
  }
  database = null
}

/** Used by the backup importer so a restore also lands in the relational tables it mirrors. */
export function syncMirrorTables(input: {
  favorites: string[]
  history: Array<{ id: string; playedAt: number; playCount: number }>
  playlists: Array<{ id: string; name: string; createdAt: number; updatedAt: number; trackIds: string[] }>
}): void {
  if (!database) return
  database.exec('begin')
  try {
    database.exec('delete from favorites')
    database.exec('delete from history')
    database.exec('delete from playlists')
    database.exec('delete from playlist_tracks')
    const favorite = database.prepare('insert or replace into favorites (track_id, added_at) values (?, ?)')
    const now = Date.now()
    for (const id of input.favorites) favorite.run([id, now])
    const history = database.prepare('insert or replace into history (track_id, played_at, play_count) values (?, ?, ?)')
    for (const entry of input.history) history.run([entry.id, entry.playedAt, entry.playCount])
    const playlist = database.prepare('insert or replace into playlists (id, name, created_at, updated_at) values (?, ?, ?, ?)')
    const member = database.prepare('insert into playlist_tracks (playlist_id, track_id, position) values (?, ?, ?)')
    for (const record of input.playlists) {
      playlist.run([record.id, record.name, record.createdAt, record.updatedAt])
      record.trackIds.forEach((trackId, position) => member.run([record.id, trackId, position]))
    }
    database.exec('commit')
  } catch {
    database.exec('rollback')
  }
}
