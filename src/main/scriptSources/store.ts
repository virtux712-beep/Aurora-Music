import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MAX_SCRIPT_BYTES,
  MAX_SCRIPT_HOSTS,
  isValidScriptId,
  normalizeAllowedHost,
  validateScriptSourceManifest,
  type LxLibraryImportResult,
  type LxLibraryPreview,
  type LxLibrarySourceSummary,
  type ScriptDeclaration,
  type ScriptProbeOptions,
  type ScriptProbeResult,
  type ScriptRuntimeKind,
  type ScriptSourceManifest,
  type ScriptSourceRecord,
  type ScriptSourceSaveResult,
} from '../../shared/scriptSource'
import { parseLxLibrary, type LxLibraryEntry } from './lxLibrary'
import { getSource, invalidateSourceRuntime, registerSource, unregisterSource } from '../sources'
import { getEntry, listEntries, removeEntry, upsertEntry, type SourceEntry } from '../sources/registry'
import { initSourceStore, persistEntries } from '../sources/store'
import { logSourceError } from '../sources/log'
import { SourceError } from '../sources/errors'
import { clearPendingHosts, readPendingHosts } from '../sources/permissions'
import { enforceInstallPolicy } from '../settings'
import { createScriptSource } from '../scriptHost/adapter'
import { disposeScriptHost, initScriptHost, probeScriptSource, registerScriptBridge } from '../scriptHost/host'

/**
 * The **script provider**: registry entries of `kind: 'script'` become runnable `MusicSource`s.
 *
 * Import is deliberately two-phase. First the script is executed in a host with **no network
 * permission**, purely to read what it declares (`defineAuroraSource({...})` or the LX `inited`
 * event). The user then sees that declaration — platforms, actions, qualities, and every host the
 * script asked to reach — and only a confirmation writes anything to disk.
 *
 * The stored manifest carries the confirmed allowlist and a SHA-256 of the exact text that was
 * reviewed. If the file later changes on disk, the hash no longer matches and the source is loaded
 * in a *blocked* state that explains why, instead of silently running unreviewed code.
 */
const MAX_SCRIPT_SOURCES = 24
const FILE_VERSION = 1

let sourcesDirectory = ''
let initialized = false

function scriptFilePath(id: string): string {
  return join(sourcesDirectory, id, 'source.js')
}

function entryFilePath(entry: SourceEntry): string | null {
  if (entry.entry.type !== 'script') return null
  const relative = entry.entry.file
  // Only `<id>/source.js`-shaped relative paths are honoured: an entry must never point at an
  // arbitrary file on the machine.
  if (!relative || relative.startsWith('/') || relative.includes('..') || /^[a-zA-Z]:/.test(relative)) return null
  return join(sourcesDirectory, relative)
}

function hashOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function actionsFor(entry: SourceEntry): string[] {
  return entry.entry.type === 'script' ? entry.entry.actions : []
}

function manifestFor(entry: SourceEntry): ScriptSourceManifest {
  return {
    id: entry.id,
    name: entry.name,
    version: entry.version,
    apiVersion: entry.apiVersion,
    runtime: entry.entry.type === 'script' ? entry.entry.runtime : 'aurora',
    description: '',
    author: '',
    homepage: '',
    license: '',
    permissions: entry.permissions,
    // The granted set. It may legitimately be empty: grants are requested at runtime.
    allowedHosts: entry.allowedHosts,
    platforms: entry.platforms ?? [],
    qualities: entry.qualities ?? [],
  }
}

function register(entry: SourceEntry, sourceText: string, blockedReason?: string): void {
  registerSource(
    createScriptSource({
      id: entry.id,
      name: entry.name,
      version: entry.version,
      apiVersion: entry.apiVersion,
      runtime: entry.entry.type === 'script' ? entry.entry.runtime : 'aurora',
      description: '',
      author: '',
      homepage: '',
      license: '',
      permissions: entry.permissions,
      allowedHosts: entry.allowedHosts,
      qualities: entry.qualities ?? [],
      platforms: (entry.platforms ?? []).map((platform) => platform.id),
      actions: actionsFor(entry),
      sourceText,
      ...(blockedReason ? { blockedReason } : {}),
    }),
  )
}

/** Loads one entry from disk, verifying the hash before anything is registered. */
async function loadEntry(entry: SourceEntry): Promise<void> {
  const file = entryFilePath(entry)
  if (!file) {
    register(entry, '', '音源记录中的文件路径不合法，请重新导入')
    return
  }
  let sourceText: string
  try {
    sourceText = await readFile(file, 'utf8')
  } catch {
    register(entry, '', `找不到脚本文件：${entry.entry.type === 'script' ? entry.entry.file : ''}`)
    return
  }
  const expected = entry.entry.type === 'script' ? entry.entry.hash : ''
  const actual = hashOf(sourceText)
  if (expected && actual !== expected) {
    register(entry, sourceText, '脚本文件在导入后已被修改，请在音源管理页重新加载并确认权限')
    return
  }
  register(entry, sourceText)
}

export async function initScriptSources(
  userDataDirectory: string,
  options: { preloadPath?: string; callTimeoutMs?: number; installTimeoutMs?: number } = {},
): Promise<void> {
  sourcesDirectory = join(userDataDirectory, 'sources')
  await initSourceStore(userDataDirectory)
  if (!initialized) {
    // The sandbox preload ships next to the other preload bundle, and the bridge handlers must exist
    // before the first host window is created. The path is passed in by the app (its bundle has its
    // own `__dirname`); the fallback keeps the module usable from a test bundle.
    initScriptHost({
      preloadPath: options.preloadPath ?? fileURLToPath(new URL('../preload/script-host.cjs', import.meta.url)),
      ...(options.callTimeoutMs ? { callTimeoutMs: options.callTimeoutMs } : {}),
      ...(options.installTimeoutMs ? { installTimeoutMs: options.installTimeoutMs } : {}),
    })
    registerScriptBridge()
    initialized = true
  }
  for (const entry of listEntries()) {
    if (entry.kind !== 'script') continue
    await loadEntry(entry)
  }
}

/** Re-registers a script source after its definition changed (hot reload, no restart). */
async function apply(entry: SourceEntry): Promise<void> {
  unregisterSource(entry.id)
  invalidateSourceRuntime(entry.id)
  disposeScriptHost(entry.id)
  await loadEntry(entry)
}

function records(): ScriptSourceRecord[] {
  return listEntries()
    .filter((entry) => entry.kind === 'script' && entry.entry.type === 'script')
    .map((entry) => {
      const version = entry.entry.type === 'script' ? entry.entry : null
      return {
        manifest: manifestFor(entry),
        hash: version?.hash ?? '',
        bytes: 0,
        installedAt: entry.installedAt,
        origin: entry.origin === 'imported' ? 'imported' : 'user',
      }
    })
}

function saveResult(errors: string[] = [], disabledByPolicy = false): ScriptSourceSaveResult {
  return { ok: errors.length === 0, errors, sources: records(), disabledByPolicy }
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

function idFromText(sourceText: string, fallback: string): string {
  const declared = sourceText.match(/(?:id|name)\s*[:=]\s*['"]([a-zA-Z0-9._-]{2,48})['"]/)
  const candidate = (declared?.[1] ?? fallback).toLowerCase()
  return isValidScriptId(candidate) ? candidate : `script-${Date.now().toString(36)}`
}

/**
 * Hosts the script's own text mentions. These are *suggestions* for the grant list in the import
 * dialog — nothing is enforced from them, and a script that reaches a host it never mentioned is
 * handled by the runtime grant prompt like any other.
 */
export function suggestedHostsFromText(sourceText: string): string[] {
  const hosts: string[] = []
  for (const match of sourceText.matchAll(/https?:\/\/([a-z0-9.-]+(?::\d{1,5})?)/gi)) {
    const host = normalizeAllowedHost(match[1])
    if (host && !hosts.includes(host)) hosts.push(host)
    if (hosts.length >= MAX_SCRIPT_HOSTS) break
  }
  return hosts
}

/**
 * Reads the LX header comment — the only metadata an LX source carries in its text:
 *
 *   /*
 *    * @name 墨澜聚合音源
 *    * @version 2.3.0
 *    * @author …
 *    *\/
 *
 * It is a fallback: `inited` is authoritative when it provides the same field.
 */
export function headerInfoFromText(sourceText: string): {
  name?: string
  version?: string
  author?: string
  homepage?: string
  description?: string
} {
  const header = /^\/\*[\S\s]+?\*\//.exec(sourceText)
  if (!header) return {}
  const info: Record<string, string> = {}
  for (const line of header[0].split(/\r?\n/)) {
    const match = /^\s?\*\s?@(\w+)\s+(.+)$/.exec(line)
    if (match) info[match[1]] = match[2].trim()
  }
  const pick = (key: string, max: number): string | undefined => {
    const value = info[key]
    return value ? value.slice(0, max) : undefined
  }
  return {
    ...(pick('name', 80) ? { name: pick('name', 80) as string } : {}),
    ...(pick('version', 40) ? { version: pick('version', 40) as string } : {}),
    ...(pick('author', 80) ? { author: pick('author', 80) as string } : {}),
    ...(pick('homepage', 200) ? { homepage: pick('homepage', 200) as string } : {}),
    ...(pick('description', 200) ? { description: pick('description', 200) as string } : {}),
  }
}

/**
 * Phase 1 of import: run the script with no permissions and report what it wants.
 * Nothing is written; the caller decides whether to keep it.
 */
export async function probeScriptImport(options: ScriptProbeOptions): Promise<ScriptProbeResult> {
  const text = options.sourceText ?? ''
  if (!text.trim()) return { ok: false, errors: ['脚本内容为空'], warnings: [] }
  if (Buffer.byteLength(text, 'utf8') > MAX_SCRIPT_BYTES) {
    return { ok: false, errors: [`脚本过大（上限 ${Math.round(MAX_SCRIPT_BYTES / 1024)}KB）`], warnings: [] }
  }

  // Detection, not permission: which *contract* does this file speak?
  //
  // The regex is only a *hint* for which contract to try first. Published 洛雪 sources are usually
  // minified (and their filenames mangled), so the literal markers it looks for are often gone while
  // the source is perfectly valid — the probe below is what decides, because running the script is
  // the only way to observe which contract it actually announced.
  const hintedRuntime: ScriptRuntimeKind =
    options.runtime ?? (/globalThis\.lx|EVENT_NAMES|\blx\.(on|send|request)\b/.test(text) ? 'lx' : 'aurora')
  const fallbackId = (options.fileName ?? 'script').replace(/\.js$/i, '')
  const id = options.id && isValidScriptId(options.id) ? options.id : idFromText(text, fallbackId)

  const header = headerInfoFromText(text)
  let declaration: ScriptDeclaration
  try {
    declaration = await probeScriptSource({
      sourceId: id,
      sourceText: text,
      runtime: hintedRuntime,
      info: {
        name: header.name ?? (options.fileName ?? id),
        version: header.version ?? '',
        author: header.author ?? '',
        homepage: header.homepage ?? '',
      },
    })
  } catch (error) {
    const message = error instanceof SourceError ? error.message : error instanceof Error ? error.message : '脚本加载失败'
    return { ok: false, errors: [message], warnings: [] }
  }

  // What the runtime observed wins over the text hint: a script that announced itself through
  // `lx.EVENT_NAMES.inited` *is* a 洛雪 source, whatever its minified text looks like.
  const runtime: ScriptRuntimeKind = declaration.runtime === 'lx' || declaration.runtime === 'aurora' ? declaration.runtime : hintedRuntime

  /*
   * Blocking vs advisory — the whole point of widening what can be imported.
   *
   * Exactly one observation blocks an install: the script **threw while loading**, i.e. the runtime
   * could not execute it at all. Everything else is advisory, because it describes *this probe* rather
   * than the source: a published source that fetches its platform config before announcing itself, or
   * a minified bundle whose `inited` never reaches the shim, has not been shown to be unusable — only
   * to be slow or to speak a dialect this host does not read.
   *
   * That matches the model Aurora already states: installing is "the runtime can load it", reaching a
   * host is decided per request, and the source manager can re-probe (`reload`) at any time. Refusing
   * the install would only leave the user with no source to re-probe and no error they can act on.
   */
  const observed = [...(declaration.errors ?? [])]
  if (observed.length === 0 && declaration.actions.length === 0) {
    observed.push(
      runtime === 'lx'
        ? '这个洛雪音源没有声明任何平台/能力（没有收到 EVENT_NAMES.inited）'
        : '脚本没有任何已实现的方法（至少需要 search / getPlayUrl 之一）',
    )
  }
  const blocked = declaration.loadFailed === true
  const errors = blocked ? observed : []
  const warnings = blocked ? [] : observed

  // The hosts the probe actually reached, plus the ones its text mentions. The reached ones are
  // first because they are the ones the runtime will really need on the next load.
  const touched = readPendingHosts(id).map((request) => request.host)
  const hosts: string[] = []
  for (const host of [...touched, ...suggestedHostsFromText(text)]) {
    const normalised = normalizeAllowedHost(host)
    if (normalised && !hosts.includes(normalised)) hosts.push(normalised)
    if (hosts.length >= MAX_SCRIPT_HOSTS) break
  }

  const manifest: ScriptSourceManifest = {
    id,
    name: (declaration.name || header.name || options.fileName || id).slice(0, 80),
    version: (declaration.version || header.version || '1.0.0').slice(0, 40),
    apiVersion: '1',
    runtime,
    description: declaration.description.slice(0, 200) || (header.description ?? ''),
    author: declaration.author.slice(0, 80) || (header.author ?? ''),
    homepage: declaration.homepage.slice(0, 200) || (header.homepage ?? ''),
    license: '',
    // The import dialog starts from what the script actually needs and lets the user adjust it; the
    // suggestion is never a precondition for installing.
    permissions: ['network', 'crypto'],
    allowedHosts: hosts,
    platforms: declaration.platforms,
    qualities: declaration.qualities,
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    declaration,
    manifest,
  }
}

/** Phase 2 of import: write the reviewed text, persist the confirmed permissions and register it. */
export async function saveScriptSource(options: {
  sourceText: string
  /** Manifest the user confirmed (id/name/version/runtime/permissions/allowedHosts). */
  manifest: unknown
}): Promise<ScriptSourceSaveResult> {
  const validation = validateScriptSourceManifest(options.manifest)
  if (!validation.ok || !validation.manifest) return saveResult(validation.errors)
  const manifest = validation.manifest

  if (Buffer.byteLength(options.sourceText, 'utf8') > MAX_SCRIPT_BYTES) {
    return saveResult([`脚本过大（上限 ${Math.round(MAX_SCRIPT_BYTES / 1024)}KB）`])
  }

  const existing = listEntries().filter((entry) => entry.kind === 'script')
  if (!existing.some((entry) => entry.id === manifest.id) && existing.length >= MAX_SCRIPT_SOURCES) {
    return saveResult([`最多只能安装 ${MAX_SCRIPT_SOURCES} 个脚本音源`])
  }

  const file = scriptFilePath(manifest.id)
  try {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, options.sourceText, 'utf8')
  } catch (error) {
    return saveResult([`无法写入脚本文件：${error instanceof Error ? error.message : '未知错误'}`])
  }

  const previous = getEntry(manifest.id)
  const entry: SourceEntry = {
    id: manifest.id,
    kind: 'script',
    name: manifest.name,
    version: manifest.version,
    apiVersion: manifest.apiVersion,
    entry: {
      type: 'script',
      file: `${manifest.id}/source.js`,
      hash: hashOf(options.sourceText),
      runtime: manifest.runtime,
      actions: [],
    },
    permissions: manifest.permissions,
    allowedHosts: manifest.allowedHosts,
    platforms: manifest.platforms,
    qualities: manifest.qualities,
    origin: previous?.origin ?? 'imported',
    installedAt: previous?.installedAt ?? Date.now(),
  }

  // Store the declaration too, so the source manager can show what it does before it is first run.
  const probe = await probeScriptImport({
    sourceText: options.sourceText,
    id: manifest.id,
    runtime: manifest.runtime,
  })
  if (probe.declaration && entry.entry.type === 'script') {
    entry.entry = {
      type: 'script',
      file: entry.entry.file,
      hash: entry.entry.hash,
      runtime: entry.entry.runtime,
      actions: probe.declaration.actions,
    }
    entry.name = (probe.declaration.name || entry.name).slice(0, 80)
    entry.version = (probe.declaration.version || entry.version).slice(0, 40)
  }

  upsertEntry(entry)
  // The inspection above re-records every host it touched as *pending*. Installing resolves that:
  // the confirmed hosts are the granted set now, so the manager must not keep asking for them.
  clearPendingHosts(manifest.id)
  await apply(entry)
  await persistEntries()
  /*
   * 安全模式: a source that was just installed starts **disabled**.
   *
   * This is the one install hook for scripts — the file picker, the paste box and the 洛雪 library import
   * all land here — so the rule is applied once and cannot be forgotten by a future install path. Only a
   * *new* install: `previous` means the user re-saved a source they already enabled, and silently turning
   * it off would look like the save failed.
   *
   * The answer travels back with the result (`disabledByPolicy`) instead of being re-derived by the caller:
   * "just installed" and "the policy disabled it" are the same thing here, but only this line knows it,
   * and the renderer's own copy of the safe-mode flag cannot tell a re-save from a new install.
   */
  const disabledByPolicy = previous ? false : await enforceInstallPolicy(manifest.id)
  return saveResult([], disabledByPolicy)
}

/**
 * Reads a 洛雪 library file and reports what is inside it, **without writing anything**.
 *
 * Each script is really executed (in a host with no grants, like any import), because the useful
 * question is not "is this syntactically JavaScript" but "does this source come up and declare the
 * platforms it claims". A library of twenty sources is expected to contain a few dead ones, and the
 * point of the preview is to say which, before the user commits.
 *
 * Probing is sequential on purpose: every probe spawns a hidden sandbox window, and twenty at once
 * would cost a lot of memory for no wall-clock gain that matters. The library's own `name` wins over
 * the script's header, because it is the name the user recognizes from their music player.
 */
export async function previewLxLibrary(text: string, fileName: string): Promise<LxLibraryPreview> {
  const parsed = parseLxLibrary(text)
  const unique = withUniqueIds(parsed.entries)
  const items: LxLibrarySourceSummary[] = []
  const installed = new Set(listEntries().map((entry) => entry.id))

  for (const { id, entry } of unique) {
    const probe = await probeScriptImport({ sourceText: entry.sourceText, fileName: `${id}.js`, id })
    const declaration: ScriptDeclaration | undefined = probe.declaration
    items.push({
      id,
      name: entry.name || declaration?.name || id,
      version: entry.version || declaration?.version || '1.0.0',
      author: entry.author || declaration?.author || '',
      description: entry.description || declaration?.description || '',
      runtime: declaration?.runtime ?? (probe.manifest?.runtime ?? 'lx'),
      platforms: declaration?.platforms ?? [],
      qualities: declaration?.qualities ?? [],
      actions: declaration?.actions ?? [],
      hosts: probe.manifest?.allowedHosts ?? [],
      bytes: Buffer.byteLength(entry.sourceText, 'utf8'),
      ok: probe.ok,
      errors: probe.errors,
      installed: installed.has(id),
    })
  }

  // Entries that could not even be decoded are listed too, unselectable in effect (no text to
  // write) but visible — otherwise the preview would be shorter than the library for no stated
  // reason.
  const taken = new Set(unique.map(({ id }) => id))
  const uniqueUndecodable = parsed.undecodable.map((entry) => {
    let id = entry.id
    for (let suffix = 2; taken.has(id) && suffix < 50; suffix += 1) id = `${entry.id}-${suffix}`
    taken.add(id)
    return { ...entry, id }
  })
  items.push(
    ...uniqueUndecodable.map((entry) => ({
      id: entry.id,
      name: entry.name,
      version: '',
      author: '',
      description: '',
      runtime: 'lx' as const,
      platforms: [],
      qualities: [],
      actions: [],
      hosts: [],
      bytes: 0,
      ok: false,
      errors: [entry.reason],
      installed: false,
    })),
  )

  return {
    ok: items.length > 0,
    errors: parsed.errors,
    fileName,
    items,
  }
}

/**
 * Library ids must be unique within the file, or the second same-id source would overwrite the
 * first on import. Preview and import share this, so the id the user ticked is the id written.
 */
function withUniqueIds(entries: LxLibraryEntry[]): { id: string; entry: LxLibraryEntry }[] {
  const seen = new Set<string>()
  return entries.map((entry) => {
    let id = entry.libraryId
    for (let suffix = 2; seen.has(id) && suffix < 50; suffix += 1) id = `${entry.libraryId}-${suffix}`
    seen.add(id)
    return { id, entry }
  })
}

/**
 * Writes the sources the user picked.
 *
 * Each one goes through the ordinary `saveScriptSource` path — same validation, same hash, same
 * two-phase import — so a library import cannot bypass a rule that a single-file import obeys. A
 * source that fails is skipped and reported; it never aborts the rest of the batch.
 */
export async function importLxLibrary(
  text: string,
  ids: string[],
  fileName: string,
): Promise<LxLibraryImportResult> {
  const parsed = parseLxLibrary(text)
  const preview = await previewLxLibrary(text, fileName)
  const wanted = new Set(ids.slice(0, MAX_SCRIPT_SOURCES))
  const decoded = new Map(withUniqueIds(parsed.entries).map(({ id, entry }) => [id, entry.sourceText]))
  const failed: { name: string; errors: string[] }[] = []
  let added = 0

  for (const item of preview.items) {
    const sourceText = decoded.get(item.id) ?? ''
    if (!wanted.has(item.id) || !sourceText) continue
    const saved = await saveScriptSource({
      sourceText,
      manifest: {
        id: item.id,
        name: item.name,
        version: item.version,
        apiVersion: '1',
        runtime: item.runtime,
        description: item.description,
        author: item.author,
        homepage: '',
        license: '',
        permissions: ['network', 'crypto'],
        allowedHosts: item.hosts,
        platforms: item.platforms,
        qualities: item.qualities,
      },
    })
    if (saved.ok) added += 1
    else failed.push({ name: item.name, errors: saved.errors })
  }

  return { ok: failed.length === 0, errors: preview.errors, added, failed, sources: records() }
}

export async function removeScriptSource(id: string): Promise<ScriptSourceSaveResult> {
  const entry = getEntry(id)
  if (!entry || entry.kind !== 'script') return saveResult(['没有找到这个脚本音源'])
  unregisterSource(id)
  invalidateSourceRuntime(id)
  disposeScriptHost(id)
  removeEntry(id)
  // The script file is removed with the entry: leaving executable code behind after "delete" would
  // be surprising.
  try {
    await rm(join(sourcesDirectory, id), { recursive: true, force: true })
  } catch {
    // A locked file must not block the removal of the registration.
  }
  await persistEntries()
  return saveResult()
}

/** Re-reads the file from disk and re-registers (used by "重新加载" after the user edits it). */
export async function reloadScriptSource(id: string): Promise<ScriptSourceSaveResult> {
  const entry = getEntry(id)
  if (!entry || entry.kind !== 'script') return saveResult(['没有找到这个脚本音源'])
  const file = entryFilePath(entry)
  if (!file) return saveResult(['音源记录中的文件路径不合法'])
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return saveResult(['找不到脚本文件'])
  }
  // The code changed, so the confirmed permissions are re-derived from the *new* code.
  const probe = await probeScriptImport({ sourceText: text, id, runtime: entry.entry.type === 'script' ? entry.entry.runtime : 'aurora' })
  if (!probe.ok || !probe.declaration) return saveResult(probe.errors)
  const nextEntry: SourceEntry = {
    ...entry,
    entry: { type: 'script', file: `${id}/source.js`, hash: hashOf(text), runtime: probe.declaration.runtime, actions: probe.declaration.actions },
    name: (probe.declaration.name || entry.name).slice(0, 80),
    version: (probe.declaration.version || entry.version).slice(0, 40),
    platforms: probe.declaration.platforms,
    qualities: probe.declaration.qualities,
  }
  upsertEntry(nextEntry)
  await apply(nextEntry)
  await persistEntries()
  return saveResult()
}

export async function exportScriptSource(id: string): Promise<string | null> {
  const entry = getEntry(id)
  if (!entry || entry.kind !== 'script') return null
  const file = entryFilePath(entry)
  if (!file) return null
  try {
    return await readFile(file, 'utf8')
  } catch {
    return null
  }
}

export function listScriptSources(): ScriptSourceRecord[] {
  return records()
}

/** True when `id` is a script source; used by the IPC layer to pick the right grant path. */
export function isScriptSource(id: string): boolean {
  const entry = getEntry(id)
  return Boolean(entry && entry.kind === 'script')
}

/** Diagnostics for the source manager: whether the file on disk still matches what was reviewed. */
export async function inspectScriptSource(id: string): Promise<{ ok: boolean; message: string }> {
  const entry = getEntry(id)
  if (!entry || entry.kind !== 'script') return { ok: false, message: '没有找到这个脚本音源' }
  const file = entryFilePath(entry)
  if (!file) return { ok: false, message: '文件路径不合法' }
  try {
    const text = await readFile(file, 'utf8')
    const expected = entry.entry.type === 'script' ? entry.entry.hash : ''
    if (expected && hashOf(text) !== expected) {
      return { ok: false, message: '脚本文件已被修改，需要重新加载并确认权限' }
    }
    if (!getSource(id)) return { ok: false, message: '脚本未注册（可能加载失败），请查看错误日志' }
    return { ok: true, message: '脚本已加载' }
  } catch {
    return { ok: false, message: '找不到脚本文件' }
  }
}

/** Restores the "blocked" explanation on startup so a tampered file never runs silently. */
export async function reportBlockedScript(entryId: string, reason: string): Promise<void> {
  logSourceError(entryId, 'UNSUPPORTED', reason, 'load')
}

/**
 * Grants hosts that the runtime refused for this source.
 *
 * This is the other half of "installation and network access are separate": a source installs with
 * no grants at all, the first request is refused with the host recorded as pending, and this is what
 * turns a pending host into a working request — durably (the registry entry is rewritten) and hot
 * (the source is unregistered and re-registered, so the sandbox host is rebuilt with the new
 * allowlist, no restart involved).
 */
export async function grantScriptHosts(
  id: string,
  hosts: string[],
): Promise<{ ok: boolean; errors: string[]; allowedHosts: string[] }> {
  const entry = getEntry(id)
  if (!entry || entry.kind !== 'script') return { ok: false, errors: ['没有找到这个脚本音源'], allowedHosts: [] }

  const errors: string[] = []
  const merged = [...entry.allowedHosts]
  for (const raw of hosts) {
    const host = normalizeAllowedHost(String(raw))
    if (!host) {
      errors.push(`不允许的主机「${String(raw)}」（请写成 host 或 host:port）`)
      continue
    }
    if (!merged.includes(host)) merged.push(host)
  }
  if (merged.length > MAX_SCRIPT_HOSTS) {
    return { ok: false, errors: [`allowedHosts 最多 ${MAX_SCRIPT_HOSTS} 个`], allowedHosts: entry.allowedHosts }
  }
  if (errors.length > 0) return { ok: false, errors, allowedHosts: entry.allowedHosts }

  const next: SourceEntry = { ...entry, allowedHosts: merged }
  upsertEntry(next)
  clearPendingHosts(id)
  await apply(next)
  await persistEntries()
  return { ok: true, errors: [], allowedHosts: merged }
}

/**
 * The inverse of `grantScriptHosts`.
 *
 * A grant that cannot be taken back is not a grant, it is a permanent widening of what the script may
 * reach — and the automatic grant makes that difference matter, because it happens without a click.
 * Unknown hosts are reported rather than ignored: "撤销了" and "本来就没有" must not look alike.
 */
export async function revokeScriptHosts(
  id: string,
  hosts: string[],
): Promise<{ ok: boolean; errors: string[]; allowedHosts: string[] }> {
  const entry = getEntry(id)
  if (!entry || entry.kind !== 'script') return { ok: false, errors: ['没有找到这个脚本音源'], allowedHosts: [] }

  const wanted = new Set<string>()
  const errors: string[] = []
  for (const raw of hosts) {
    const host = normalizeAllowedHost(String(raw))
    if (!host) {
      errors.push(`主机名不合法：「${String(raw)}」`)
      continue
    }
    if (!entry.allowedHosts.includes(host)) {
      errors.push(`该主机本来就没有被授权：${host}`)
      continue
    }
    wanted.add(host)
  }
  if (errors.length > 0) return { ok: false, errors, allowedHosts: entry.allowedHosts }

  const remaining = entry.allowedHosts.filter((host) => !wanted.has(host))
  const next: SourceEntry = { ...entry, allowedHosts: remaining }
  upsertEntry(next)
  await apply(next)
  await persistEntries()
  return { ok: true, errors: [], allowedHosts: remaining }
}

export { FILE_VERSION }
