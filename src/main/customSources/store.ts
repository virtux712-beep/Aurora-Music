import {
  validateCustomSourceManifest,
  type CustomSourceManifest,
  type CustomSourceSaveResult,
  type ManifestValidationResult,
} from '../../shared/customSource'
import { MAX_SCRIPT_HOSTS, normalizeAllowedHost } from '../../shared/scriptSource'
import { getSource, invalidateSourceRuntime, registerSource, unregisterSource } from '../sources'
import { getEntry, listEntries, removeEntry, upsertEntry, type SourceEntry } from '../sources/registry'
import { clearPendingHosts } from '../sources/permissions'
import { enforceInstallPolicy } from '../settings'
import { initSourceStore, persistEntries } from '../sources/store'
import { listBuiltinTemplates } from './templates'
import { createCustomSource } from './adapter'

/**
 * The **declarative provider**: it turns registry entries of `kind: 'declarative'` into runnable
 * `MusicSource` instances, and is the only place that writes declarative entries back to disk.
 *
 * Persistence itself lives in `sources/store.ts` (one file for every non-built-in kind), and the
 * canonical entry list lives in `sources/registry.ts`. This module keeps exactly two
 * responsibilities:
 *
 *  1. validate → instantiate → register (and the reverse on removal);
 *  2. expose the manifest-shaped API the settings UI already speaks (`listCustomSources`, `saveCustomSource`, …),
 *     so the UI needs no change while the storage under it was replaced.
 *
 * A manifest is validated on the way in *and* on the way out of the file: a hand-edited
 * `sources.json` must not be able to register a source that bypasses the rules.
 */
const MAX_CUSTOM_SOURCES = 24

function entryFor(manifest: CustomSourceManifest, previous?: SourceEntry): SourceEntry {
  return {
    id: manifest.id,
    kind: 'declarative',
    name: manifest.name,
    version: manifest.version,
    apiVersion: manifest.apiVersion,
    entry: { type: 'declarative', manifest },
    permissions: ['network'],
    allowedHosts: manifest.allowedHosts,
    platforms: manifest.platforms,
    qualities: manifest.qualities,
    origin: previous?.origin ?? 'user',
    installedAt: previous?.installedAt ?? Date.now(),
  }
}

function register(entry: SourceEntry): void {
  if (entry.entry.type !== 'declarative') return
  registerSource(createCustomSource(entry.entry.manifest))
}

function apply(entry: SourceEntry): void {
  unregisterSource(entry.id)
  invalidateSourceRuntime(entry.id)
  register(entry)
}

export async function initCustomSources(userDataDirectory: string): Promise<void> {
  // Loads the canonical file (migrating `custom-sources.json` on first run) and then instantiates
  // every declarative entry. Built-in entries are registered separately from code.
  await initSourceStore(userDataDirectory)
  for (const entry of listEntries()) {
    if (entry.kind !== 'declarative') continue
    register(entry)
  }
}

export function listCustomSources(): CustomSourceManifest[] {
  return listEntries()
    .filter((entry): entry is SourceEntry & { entry: { type: 'declarative'; manifest: CustomSourceManifest } } =>
      entry.kind === 'declarative' && entry.entry.type === 'declarative',
    )
    .map((entry) => structuredClone(entry.entry.manifest))
}

/** Built-in starting points for the editor (never auto-installed). */
export function listTemplates() {
  return listBuiltinTemplates()
}

/** Parse + validate without saving, so the settings form can show every problem at once. */
export function validateCustomSourceRaw(raw: string): ManifestValidationResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { ok: false, errors: [`JSON 解析失败：${error instanceof Error ? error.message : '无法解析'}`] }
  }
  return validateCustomSourceManifest(parsed)
}

export function exportCustomSource(id: string): string | null {
  const entry = getEntry(id)
  if (!entry || entry.entry.type !== 'declarative') return null
  return JSON.stringify(entry.entry.manifest, null, 2)
}

/** Validates and saves (create or overwrite) a manifest from raw JSON text. */
export async function saveCustomSource(raw: string): Promise<CustomSourceSaveResult> {
  const result = validateCustomSourceRaw(raw)
  if (!result.ok || !result.manifest) return { ok: false, errors: result.errors, manifests: listCustomSources() }

  const manifest = result.manifest
  const existing = listCustomSources().findIndex((item) => item.id === manifest.id)
  if (existing < 0 && listCustomSources().length >= MAX_CUSTOM_SOURCES) {
    return { ok: false, errors: [`最多只能添加 ${MAX_CUSTOM_SOURCES} 个自定义音源`], manifests: listCustomSources() }
  }

  const entry = entryFor(manifest, getEntry(manifest.id))
  upsertEntry(entry)
  apply(entry)
  await persistEntries()
  /*
   * 安全模式: a freshly installed manifest starts disabled — it is not loaded, so no request of its can be
   * made before the user enables it. Editing an existing one leaves its state alone (see the hook in
   * `scriptSources/store.ts` for the same reasoning).
   *
   * The answer is **returned**, not just applied: it is the difference between "this source is waiting for
   * you to enable it" and "this source is live", and only the code that just touched the settings knows
   * which of the two happened.
   */
  const disabledByPolicy = existing < 0 ? await enforceInstallPolicy(manifest.id) : false
  return { ok: true, errors: [], manifests: listCustomSources(), disabledByPolicy }
}

const MAX_CUSTOM_HOSTS = MAX_SCRIPT_HOSTS

/**
 * Grants hosts the permission layer refused for this declarative source.
 *
 * A manifest never *has* to list its hosts up front: they are grants, and the first refused request
 * records a pending host that this function turns into a working one — durably (the manifest is
 * rewritten) and immediately (the source is re-registered, so the next request uses the new list).
 */
export async function grantCustomHosts(
  id: string,
  hosts: string[],
): Promise<{ ok: boolean; errors: string[]; allowedHosts: string[] }> {
  const entry = getEntry(id)
  if (!entry || entry.entry.type !== 'declarative') {
    return { ok: false, errors: ['没有找到这个声明式音源'], allowedHosts: [] }
  }
  const manifest = entry.entry.manifest
  const errors: string[] = []
  const merged = [...manifest.allowedHosts]
  for (const raw of hosts) {
    const host = normalizeAllowedHost(String(raw))
    if (!host) {
      errors.push(`不允许的主机「${String(raw)}」（请写成 host 或 host:port）`)
      continue
    }
    if (!merged.includes(host)) merged.push(host)
  }
  if (merged.length > MAX_CUSTOM_HOSTS) {
    return { ok: false, errors: [`allowedHosts 最多 ${MAX_CUSTOM_HOSTS} 个`], allowedHosts: manifest.allowedHosts }
  }
  if (errors.length > 0) return { ok: false, errors, allowedHosts: manifest.allowedHosts }

  const nextManifest: CustomSourceManifest = { ...manifest, allowedHosts: merged }
  const nextEntry: SourceEntry = { ...entry, allowedHosts: merged, entry: { type: 'declarative', manifest: nextManifest } }
  upsertEntry(nextEntry)
  clearPendingHosts(id)
  apply(nextEntry)
  await persistEntries()
  return { ok: true, errors: [], allowedHosts: merged }
}

/** The inverse of `grantCustomHosts`: takes hosts back off the manifest's allowlist. */
export async function revokeCustomHosts(
  id: string,
  hosts: string[],
): Promise<{ ok: boolean; errors: string[]; allowedHosts: string[] }> {
  const entry = getEntry(id)
  if (!entry || entry.entry.type !== 'declarative') {
    return { ok: false, errors: ['没有找到这个声明式音源'], allowedHosts: [] }
  }
  const manifest = entry.entry.manifest
  const wanted = new Set<string>()
  const errors: string[] = []
  for (const raw of hosts) {
    const host = normalizeAllowedHost(String(raw))
    if (!host) {
      errors.push(`主机名不合法：「${String(raw)}」`)
      continue
    }
    if (!manifest.allowedHosts.includes(host)) {
      errors.push(`该主机本来就没有被授权：${host}`)
      continue
    }
    wanted.add(host)
  }
  if (errors.length > 0) return { ok: false, errors, allowedHosts: manifest.allowedHosts }

  const remaining = manifest.allowedHosts.filter((host) => !wanted.has(host))
  const nextManifest: CustomSourceManifest = { ...manifest, allowedHosts: remaining }
  const nextEntry: SourceEntry = {
    ...entry,
    allowedHosts: remaining,
    entry: { type: 'declarative', manifest: nextManifest },
  }
  upsertEntry(nextEntry)
  apply(nextEntry)
  await persistEntries()
  return { ok: true, errors: [], allowedHosts: remaining }
}

export async function removeCustomSource(id: string): Promise<CustomSourceSaveResult> {
  if (!getEntry(id)) return { ok: false, errors: ['没有找到这个自定义音源'], manifests: listCustomSources() }
  if (getSource(id)) unregisterSource(id)
  invalidateSourceRuntime(id)
  removeEntry(id)
  await persistEntries()
  return { ok: true, errors: [], manifests: listCustomSources() }
}
