/**
 * Script sources: the contract for a *JavaScript* music source.
 *
 * This is deliberately not a JSON format. A script source is code that Aurora executes inside an
 * isolated sandbox host (see `main/scriptHost/`), so nothing in this file describes how the code
 * runs — it only describes the **declaration** the user is asked to confirm before the code is
 * allowed to reach the network:
 *
 *   1. import runs the script once in a host with *network denied*;
 *   2. whatever it declares (`defineAuroraSource({...})` or the LX `inited` event) is shown to the
 *      user as the permission request;
 *   3. only then is an entry persisted, carrying the confirmed host allowlist and a hash of the
 *      exact code that was reviewed.
 *
 * The runtime enforces the *stored* allowlist on every request, so a script cannot widen its own
 * permissions after import.
 */
import { RESERVED_SOURCE_IDS, SUPPORTED_API_VERSIONS, checkEndpointUrl, hostOf } from './customSource'
import type { PlaybackQuality, SourcePermission, SourcePlatform } from './types'

export const SCRIPT_RUNTIMES = ['aurora', 'lx'] as const
export type ScriptRuntimeKind = (typeof SCRIPT_RUNTIMES)[number]

/**
 * Permissions the runtime actually implements. `storage` is deliberately absent: advertising it
 * would promise scripts a capability the host does not provide.
 */
export const SCRIPT_PERMISSIONS: SourcePermission[] = ['network', 'crypto']

/** Methods a script may implement under Aurora's own contract. */
export const AURORA_SCRIPT_METHODS = [
  'search',
  'getSongDetail',
  'getPlayUrl',
  'getLyric',
  'getCover',
  'getAlbum',
  'getArtist',
  'getPlaylist',
  'getLeaderboard',
  'healthCheck',
] as const
export type AuroraScriptMethod = (typeof AURORA_SCRIPT_METHODS)[number]

/** Actions of the LX Music protocol, mapped onto Aurora by the compatibility shim. */
export const LX_ACTIONS = ['musicUrl', 'lyric', 'pic'] as const

/**
 * Largest source file Aurora will load.
 *
 * This is a resource bound, not an admission rule: execution is already isolated, so the number only
 * answers "how much text are we willing to hand to the sandbox". It was 512KB, which turned out to
 * be a real limit on real published sources — one source in a survey of twenty was 1.78MB of
 * bundled/obfuscated JavaScript and simply could not be installed. 2MB covers everything seen in the
 * wild while still refusing something pathological.
 */
export const MAX_SCRIPT_BYTES = 2 * 1024 * 1024
export const MAX_SCRIPT_HOSTS = 24
export const MAX_SCRIPT_PLATFORMS = 16
export const MAX_SCRIPT_QUALITIES = 12

export interface ScriptSourceManifest {
  id: string
  name: string
  version: string
  apiVersion: string
  runtime: ScriptRuntimeKind
  description: string
  author: string
  homepage: string
  license: string
  /** Permissions the runtime enforces for this script. Absent permission = refused at call time. */
  permissions: SourcePermission[]
  /**
   * Exact `host[:port]` entries the script may reach — the *granted* set, not a precondition.
   *
   * An empty list is a valid install: the source loads, registers and runs, and the first request to
   * any host is refused by the permission layer with a grant prompt. Installing a source and letting
   * it reach a host are two separate decisions on purpose.
   */
  allowedHosts: string[]
  platforms: SourcePlatform[]
  qualities: PlaybackQuality[]
}

/** What the import UI passes to the probe. */
export interface ScriptProbeOptions {
  sourceText: string
  fileName?: string
  /** Overrides detection when the user knows better (some sources look like both). */
  runtime?: ScriptRuntimeKind
  id?: string
}

/** What a script declared about itself when it was probed. Never trusted for enforcement. */
export interface ScriptDeclaration {
  runtime: ScriptRuntimeKind
  name: string
  version: string
  description: string
  author: string
  homepage: string
  platforms: SourcePlatform[]
  /** Methods (aurora contract) or actions (lx protocol) the script actually implements. */
  actions: string[]
  qualities: PlaybackQuality[]
  /** True when the script can answer a keyword search on its own. */
  canSearch: boolean
  logs: string[]
  /**
   * Problems that make the source unusable: it did not load, did not declare itself, or declared no
   * music platform. These are the only things that refuse an install.
   */
  errors: string[]
  /**
   * Things worth telling the user that do **not** block anything: a thrown background task, a
   * `console.error`, an event name this runtime does not implement yet. Published sources rely on
   * newer LX events, so treating these as failures would reject working sources.
   */
  warnings: string[]
  /**
   * The script touched the 洛雪 API but has not announced itself yet — i.e. it is still bootstrapping
   * (published sources routinely fetch their own platform config before `lx.send(inited)`). It is not
   * a failure: it is the signal the host uses to keep waiting instead of reporting "declared nothing",
   * which used to reject working sources after two seconds.
   */
  lxPending?: boolean
  /** The script already issued a request of its own, so it is demonstrably still working. */
  bridgeUsed?: boolean
  /**
   * The script threw while loading. The **only** observation that means "this cannot work":
   *
   * everything else that lands in `errors` (notably "declared nothing") is a statement about timing
   * or about a contract this host may not speak, so the import flow treats it as installable-with-a-
   * warning and lets the source manager re-probe later.
   */
  loadFailed?: boolean
}

export interface ScriptProbeResult {
  ok: boolean
  errors: string[]
  /**
   * Non-blocking observations shown next to a successful probe: a source that installed but has not
   * declared its capabilities yet, a load-time `console.error`, a background task that threw.
   */
  warnings: string[]
  declaration?: ScriptDeclaration
  /** The manifest that would be persisted, i.e. the declaration plus the id derived from the file. */
  manifest?: ScriptSourceManifest
}

export interface ScriptSourceRecord {
  manifest: ScriptSourceManifest
  /** SHA-256 of the exact source text that was reviewed and confirmed. */
  hash: string
  bytes: number
  installedAt: number
  origin: 'user' | 'imported'
}

export interface ScriptSourceSaveResult {
  ok: boolean
  errors: string[]
  sources: ScriptSourceRecord[]
  /**
   * Whether 安全模式 actually put this source into `enabledSources: false` *because it was just installed*.
   *
   * Reported by the main process rather than inferred by the renderer from its own copy of the safe-mode
   * flag, because the two disagree in the cases that matter: re-saving a source the user already enabled
   * leaves it enabled (safe mode only holds back *new* installs), and the renderer's copy can be a change
   * behind. The settings page used to say "默认禁用" in both of those cases, which is a policy explained
   * wrongly — worse than not explained.
   */
  disabledByPolicy?: boolean
}

/**
 * One source found inside a 洛雪 (LX Music) library file (`user_api.json`).
 *
 * `ok: false` means the script was decoded but did not load or declare anything — it is still shown,
 * with its errors, because "this one of your twenty sources needs attention" is more useful than
 * quietly importing nineteen and saying nothing.
 */
export interface LxLibrarySourceSummary {
  id: string
  name: string
  version: string
  author: string
  description: string
  runtime: ScriptRuntimeKind
  platforms: SourcePlatform[]
  qualities: string[]
  actions: string[]
  /** Hosts its text mentions, offered as the grant list. */
  hosts: string[]
  bytes: number
  ok: boolean
  errors: string[]
  /** Already installed under this id — importing again would update it in place. */
  installed: boolean
}

/** Result of inspecting a library file before anything is written. */
export interface LxLibraryPreview {
  ok: boolean
  errors: string[]
  fileName: string
  items: LxLibrarySourceSummary[]
}

/** Result of importing the selected sources. */
export interface LxLibraryImportResult {
  ok: boolean
  errors: string[]
  added: number
  failed: { name: string; errors: string[] }[]
  sources: ScriptSourceRecord[]
}

/**
 * Which contract does this text speak? Detection only — never a permission decision.
 *
 * The LX protocol is announced by reaching for `globalThis.lx` (directly or destructured) or by
 * naming its event table, which is what every published LX-style source does at the top of the file.
 */
export function detectRuntimeKindForText(text: string): ScriptRuntimeKind {
  return /globalThis\.lx|EVENT_NAMES|\blx\.(on|send|request)\b/.test(text) ? 'lx' : 'aurora'
}

/** A script's own id must be a slug: it becomes a directory name under `<userData>/sources/`. */
export function isValidScriptId(id: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{1,47}$/.test(id) && !id.includes('..')
}

/**
 * Accepts either a bare `host[:port]` or a full URL and returns the normalised allowlist entry.
 * Returns `null` for anything else, including URLs with a path (the allowlist is host-scoped).
 *
 * Non-ASCII hosts are converted to their ASCII form first, and that is not cosmetic: the runtime
 * compares a grant against `new URL(url).host`, which is always the punycode form. A Chinese domain
 * written the way its owner writes it (`88.example.中国`) would therefore be stored as a grant that
 * can never match the request it was made for — the user clicks "allow", the host is listed, and the
 * source is still refused. Normalising to ASCII makes both sides comparable.
 */
export function normalizeAllowedHost(value: string): string | null {
  const raw = value.trim()
  if (!raw) return null
  if (/[^\x00-\x7f]/.test(raw)) {
    const ascii = asciiHost(raw)
    return ascii === null ? null : normalizeAllowedHost(ascii)
  }
  if (raw.includes('://')) {
    if (checkEndpointUrl(raw) !== null) return null
    const host = hostOf(raw)
    if (!host) return null
    return raw.endsWith('/') && new URL(raw).pathname !== '/' ? null : host
  }
  if (/[/\\?#@\s]/.test(raw)) return null
  const host = raw.toLowerCase()
  const bare = host.replace(/^\[|\]$/g, '').split(':')[0]
  const port = host.includes(':') ? host.split(':').pop() ?? '' : ''
  if (!bare || !/^[a-z0-9.-]+$/.test(bare) || bare.startsWith('.') || bare.endsWith('.')) return null
  // A port is optional but must be numeric and in range; otherwise the browser would resolve a
  // different host than the one the user approved.
  if (host.includes(':')) {
    const portNumber = Number(port)
    if (!Number.isInteger(portNumber) || portNumber <= 0 || portNumber > 65535) return null
  }
  return host
}

/**
 * The ASCII (punycode) form of a host containing non-ASCII characters, or `null` when the text is not
 * a bare `host[:port]` — a path, query, space or userinfo means it is a URL or prose, not a host.
 */
function asciiHost(raw: string): string | null {
  if (/[/\\?#@\s]/.test(raw)) return null
  try {
    // `new URL` is the punycode implementation: it rejects anything that is not a hostname and
    // returns the exact string the runtime will later compare against.
    const parsed = new URL(`http://${raw}`)
    return parsed.host || null
  } catch {
    return null
  }
}

function normalizePlatforms(value: unknown, errors: string[]): SourcePlatform[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    errors.push('platforms 必须是数组')
    return []
  }
  const platforms: SourcePlatform[] = []
  for (const item of value.slice(0, MAX_SCRIPT_PLATFORMS * 2)) {
    if (!item || typeof item !== 'object') {
      errors.push('platforms 中的每一项都必须是对象')
      continue
    }
    const raw = item as Record<string, unknown>
    const id = typeof raw.id === 'string' ? raw.id.trim().slice(0, 40) : ''
    const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 60) : ''
    if (!id) {
      errors.push('platforms 中的每一项都需要 id')
      continue
    }
    platforms.push({
      id,
      name: name || id,
      ...(typeof raw.icon === 'string' && raw.icon.trim() ? { icon: raw.icon.trim().slice(0, 4) } : {}),
    })
  }
  if (platforms.length > MAX_SCRIPT_PLATFORMS) {
    errors.push(`platforms 最多 ${MAX_SCRIPT_PLATFORMS} 个`)
  }
  return platforms.slice(0, MAX_SCRIPT_PLATFORMS)
}

function normalizeQualities(value: unknown, errors: string[]): PlaybackQuality[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    errors.push('qualities 必须是字符串数组')
    return []
  }
  const qualities = value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim().slice(0, 16))
  if (qualities.length > MAX_SCRIPT_QUALITIES) {
    errors.push(`qualities 最多 ${MAX_SCRIPT_QUALITIES} 个`)
  }
  return [...new Set(qualities)].slice(0, MAX_SCRIPT_QUALITIES)
}

/**
 * Validates a full script manifest (what the store writes to disk). Every problem is returned at
 * once, because an import the user has to fix blind is worse than a long list.
 */
export function validateScriptSourceManifest(value: unknown): {
  ok: boolean
  errors: string[]
  manifest?: ScriptSourceManifest
} {
  const errors: string[] = []
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: ['manifest 必须是一个对象'] }
  }
  const raw = value as Record<string, unknown>

  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (!isValidScriptId(id)) {
    errors.push('id 只能是小写字母、数字、点、下划线和短横线（2–48 字符）')
  } else if ((RESERVED_SOURCE_IDS as readonly string[]).includes(id)) {
    errors.push(`id "${id}" 是 Aurora 内置音源保留的标识`)
  }

  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 80) : ''
  if (!name) errors.push('缺少 name')

  const version = typeof raw.version === 'string' ? raw.version.trim().slice(0, 40) : ''
  if (!version) errors.push('缺少 version')

  const apiVersion = typeof raw.apiVersion === 'string' ? raw.apiVersion.trim() : ''
  if (!(SUPPORTED_API_VERSIONS as readonly string[]).includes(apiVersion)) {
    errors.push(`apiVersion 必须是 ${SUPPORTED_API_VERSIONS.join(' / ')}（当前为 "${apiVersion || '空'}"）`)
  }

  const runtime = typeof raw.runtime === 'string' ? raw.runtime.trim() : ''
  if (!(SCRIPT_RUNTIMES as readonly string[]).includes(runtime)) {
    errors.push(`runtime 必须是 ${SCRIPT_RUNTIMES.join(' / ')}`)
  }

  const permissions = Array.isArray(raw.permissions)
    ? raw.permissions.filter((item): item is SourcePermission =>
        (SCRIPT_PERMISSIONS as string[]).includes(item as string),
      )
    : []
  if (Array.isArray(raw.permissions) && raw.permissions.length !== permissions.length) {
    errors.push(`permissions 只允许 ${SCRIPT_PERMISSIONS.join(' / ')}`)
  }

  const hosts: string[] = []
  if (raw.allowedHosts !== undefined && !Array.isArray(raw.allowedHosts)) {
    errors.push('allowedHosts 必须是字符串数组')
  } else if (Array.isArray(raw.allowedHosts)) {
    for (const item of raw.allowedHosts) {
      if (typeof item !== 'string') {
        errors.push(`allowedHosts 里的 "${String(item)}" 不是字符串`)
        continue
      }
      const host = normalizeAllowedHost(item)
      if (!host) {
        errors.push(`不允许的主机 "${item}"（请写成 host 或 host:port，不要带路径）`)
        continue
      }
      if (!hosts.includes(host)) hosts.push(host)
    }
  }
  if (hosts.length > MAX_SCRIPT_HOSTS) errors.push(`allowedHosts 最多 ${MAX_SCRIPT_HOSTS} 个`)

  const platforms = normalizePlatforms(raw.platforms, errors)
  const qualities = normalizeQualities(raw.qualities, errors)

  if (errors.length > 0) return { ok: false, errors }

  return {
    ok: true,
    errors: [],
    manifest: {
      id,
      name,
      version,
      apiVersion,
      runtime: runtime as ScriptRuntimeKind,
      description: typeof raw.description === 'string' ? raw.description.trim().slice(0, 200) : '',
      author: typeof raw.author === 'string' ? raw.author.trim().slice(0, 80) : '',
      homepage: typeof raw.homepage === 'string' ? raw.homepage.trim().slice(0, 200) : '',
      license: typeof raw.license === 'string' ? raw.license.trim().slice(0, 80) : '',
      permissions,
      allowedHosts: hosts.slice(0, MAX_SCRIPT_HOSTS),
      platforms,
      qualities,
    },
  }
}

/** Maps a script's declared actions onto the manifest, so the UI can show what it will be able to do. */
export function declarationToActions(
  declaration: ScriptDeclaration,
  runtime: ScriptRuntimeKind,
): Set<string> {
  const actions = new Set(declaration.actions)
  if (runtime === 'lx' && declaration.canSearch) actions.add('search')
  return actions
}
