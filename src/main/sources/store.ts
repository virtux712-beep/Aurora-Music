import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { validateCustomSourceManifest } from '../../shared/customSource'
import { persistableEntries, replacePersistedEntries, type SourceEntry } from './registry'

/**
 * One file for every user source: `<userData>/sources/sources.json`.
 *
 * Platforms are never persisted here — they are a read-only registry from code. This file only ever
 * holds `kind: 'declarative' | 'script'` entries. Legacy `kind: 'builtin'` and `type: 'builtin'`
 * entries are silently ignored on load and dropped on next write.
 *
 * Migration: an earlier release kept declarative manifests in `<userData>/custom-sources.json`.
 * On first run that file is read, converted into `kind: 'declarative'` entries, written to the
 * new location, and left untouched on disk.
 */
const FILE_VERSION = 1
const MAX_ENTRIES = 64

let storeFile = ''
let legacyFile = ''
let migratedFrom: string | null = null

interface SourceFile {
  version?: number
  entries?: unknown
}

function asEntry(value: unknown): SourceEntry | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<SourceEntry> & { entry?: Record<string, unknown> | null }
  if (typeof raw.id !== 'string' || !raw.id.trim()) return null
  // Legacy builtin entries (from before Platform/Source split) are silently dropped.
  if ((raw as Record<string, unknown>).kind === 'builtin') return null
  if (raw.kind !== 'declarative' && raw.kind !== 'script') return null
  const entry = raw.entry
  if (!entry || typeof entry !== 'object') return null
  if ((entry as Record<string, unknown>).type === 'builtin') return null

  if (raw.kind === 'declarative') {
    const candidate = entry as { type?: string; manifest?: unknown }
    if (candidate.type !== 'declarative') return null
    const result = validateCustomSourceManifest(candidate.manifest)
    if (!result.ok || !result.manifest) return null
    return {
      id: raw.id,
      kind: 'declarative',
      name: result.manifest.name,
      version: result.manifest.version,
      apiVersion: result.manifest.apiVersion,
      entry: { type: 'declarative', manifest: result.manifest },
      permissions: ['network'],
      allowedHosts: result.manifest.allowedHosts,
      platforms: result.manifest.platforms ?? [],
      qualities: result.manifest.qualities ?? [],
      origin: raw.origin === 'imported' ? 'imported' : 'user',
      installedAt: typeof raw.installedAt === 'number' ? raw.installedAt : Date.now(),
    }
  }

  // Script entries are recorded here, but their file is only loaded by the sandboxed script host,
  // which re-checks permissions and hashes before running anything.
  const script = entry as { type?: string; file?: string; hash?: string; runtime?: string; actions?: unknown }
  if ((raw as Record<string, unknown>).kind === 'builtin') return null
  if (script.type !== 'script' || typeof script.file !== 'string' || !script.file.trim()) return null
  return {
    id: raw.id,
    kind: 'script',
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.slice(0, 80) : raw.id,
    version: typeof raw.version === 'string' ? raw.version.slice(0, 40) : '0.0.0',
    apiVersion: typeof raw.apiVersion === 'string' ? raw.apiVersion.slice(0, 20) : '1',
    entry: {
      type: 'script',
      file: script.file.slice(0, 200),
      hash: typeof script.hash === 'string' ? script.hash.slice(0, 128) : '',
      runtime: script.runtime === 'lx' ? 'lx' : 'aurora',
      // Declared actions are re-derived by the probe on load; this is only what was persisted.
      actions: Array.isArray(script.actions)
        ? script.actions.filter((action): action is string => typeof action === 'string').slice(0, 40)
        : [],
    },
    permissions: Array.isArray(raw.permissions)
      ? raw.permissions.filter((item): item is SourceEntry['permissions'][number] =>
          item === 'network' || item === 'crypto' || item === 'storage',
        )
      : ['network'],
    allowedHosts: Array.isArray(raw.allowedHosts)
      ? raw.allowedHosts.filter((host): host is string => typeof host === 'string').map((host) => host.toLowerCase())
      : [],
    platforms: Array.isArray(raw.platforms) ? raw.platforms : [],
    qualities: Array.isArray(raw.qualities) ? raw.qualities : [],
    origin: raw.origin === 'imported' ? 'imported' : 'user',
    installedAt: typeof raw.installedAt === 'number' ? raw.installedAt : Date.now(),
  }
}

function parseEntries(payload: unknown): SourceEntry[] {
  const parsed = payload as SourceFile
  return (Array.isArray(parsed?.entries) ? parsed.entries : [])
    .map(asEntry)
    .filter((entry): entry is SourceEntry => entry !== null)
    .slice(0, MAX_ENTRIES)
}

/** Converts a legacy `custom-sources.json` document into registry entries. */
function fromLegacy(payload: unknown): SourceEntry[] {
  const parsed = payload as { sources?: unknown }
  const list = Array.isArray(parsed?.sources) ? parsed.sources : []
  return list
    .map((manifest) =>
      asEntry({
        id: (manifest as { id?: unknown })?.id,
        kind: 'declarative',
        entry: { type: 'declarative', manifest },
        origin: 'user',
      }),
    )
    .filter((entry): entry is SourceEntry => entry !== null)
}

export async function initSourceStore(userDataDirectory: string): Promise<void> {
  const directory = join(userDataDirectory, 'sources')
  storeFile = join(directory, 'sources.json')
  legacyFile = join(userDataDirectory, 'custom-sources.json')
  // Created up front: otherwise the very first save fails with ENOENT and the entry silently only
  // lives in memory until the app restarts.
  try {
    await mkdir(directory, { recursive: true })
  } catch {
    // A read-only data directory still works for this session; saving is what would fail.
  }

  try {
    const raw = await readFile(storeFile, 'utf8')
    replacePersistedEntries(parseEntries(JSON.parse(raw)))
    return
  } catch {
    // No canonical file yet: fall through to the legacy migration.
  }

  let migrated: SourceEntry[] = []
  try {
    const raw = await readFile(legacyFile, 'utf8')
    migrated = fromLegacy(JSON.parse(raw))
  } catch {
    migrated = []
  }
  replacePersistedEntries(migrated)
  if (migrated.length > 0) migratedFrom = legacyFile
  await persistEntries()
}

/** Writes the current registry state. Callers mutate the registry first, then persist once. */
export async function persistEntries(): Promise<void> {
  try {
    await writeFile(
      storeFile,
      JSON.stringify({ version: FILE_VERSION, entries: persistableEntries() }, null, 2),
      'utf8',
    )
  } catch (error) {
    // Keeping the in-memory registry means the session still works, but a silent failure here is
    // how "my source vanished after restart" bugs are born, so it is reported.
    console.warn('[aurora] 无法写入音源注册表：', error instanceof Error ? error.message : error)
  }
}

/** Which legacy file the current registry was migrated from, for diagnostics (null after start). */
export function migrationInfo(): { legacyFile: string | null } {
  return { legacyFile: migratedFrom }
}
