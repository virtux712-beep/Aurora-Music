import type { CustomSourceManifest } from '../../shared/customSource'
import type { PlaybackQuality, SourceKind, SourcePermission, SourcePlatform } from '../../shared/types'

/**
 * The canonical list of sources, independent of *how* each one is hosted.
 *
 * Before this existed, "which sources exist" was spread over: the built-in registration call, the
 * `custom-sources.json` file, and the SourceManager map — so adding a third kind of source meant
 * touching all three plus IPC, preload, the service layer and the settings page.
 *
 * Now there is exactly one registry. Each kind has a *provider* that knows how to turn an entry into
 * a runnable `MusicSource` (built-ins: a module reference, declarative: a manifest, script: a file in
 * the sandbox). Everything above the registry — settings, search, UI — only reads entries.
 *
 * Enabled/disabled and ordering deliberately stay in `settings.json`: those are user preferences
 * shared by every kind, and duplicating them here would create two sources of truth.
 */
export type SourceEntryPayload =
  | { type: 'declarative'; manifest: CustomSourceManifest }
  | { type: 'script'; file: string; hash: string; runtime: 'aurora' | 'lx'; actions: string[] }

export interface SourceEntry {
  id: string
  kind: SourceKind
  name: string
  version: string
  apiVersion: string
  /** How to instantiate this source; the shape is chosen by `kind`. */
  entry: SourceEntryPayload
  permissions: SourcePermission[]
  /** Hosts a network permission is granted for. Empty means "no outbound requests at all". */
  allowedHosts: string[]
  /** Platforms declared by the source (never invented by Aurora). */
  platforms?: SourcePlatform[]
  qualities?: PlaybackQuality[]
  /** Where the entry came from: `user` (local) or `imported`. Legacy `builtin` entries are ignored on load. */
  origin: 'user' | 'imported'
  installedAt: number
}

const entries = new Map<string, SourceEntry>()

export function upsertEntry(entry: SourceEntry): void {
  entries.set(entry.id, entry)
}

export function removeEntry(id: string): void {
  entries.delete(id)
}

export function getEntry(id: string): SourceEntry | undefined {
  return entries.get(id)
}

export function listEntries(): SourceEntry[] {
  return [...entries.values()]
}

/** All persisted entries are user sources; platforms are not persisted here. */
export function persistableEntries(): SourceEntry[] {
  return listEntries()
}

/** Replaces the persisted entries (used by the store when loading from disk). */
export function replacePersistedEntries(list: SourceEntry[]): void {
  for (const entry of listEntries()) entries.delete(entry.id)
  for (const entry of list) entries.set(entry.id, entry)
}
