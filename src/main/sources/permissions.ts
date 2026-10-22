import type { SourcePermission } from '../../shared/types'
import { SourceError } from './errors'
import { insecureRequestReason } from './policy'

/**
 * The **runtime permission layer**.
 *
 * This is the boundary the source runtime is not allowed to cross on its own. It exists for exactly
 * one job: deciding, *at request time*, whether a running source may reach a given host. It is
 * deliberately **not** an admission test — nothing here decides whether a source may be installed,
 * registered or run:
 *
 *  - a source is loaded, registered and enabled regardless of which hosts it mentions;
 *  - the first time it asks for an ungranted host, the request is refused and the host is recorded
 *    as *pending*, so the source manager can offer the user a one-click grant;
 *  - granting adds the host to the source's entry and hot-reloads it — no restart, no reinstall.
 *
 * The distinction matters: "this source cannot reach example.com yet" is a runtime fact that the
 * user can change, while "this source is not on an approved list" would be a product-level veto.
 * Aurora only implements the former.
 *
 * The buffers are bounded and in-memory: pending hosts are a diagnostic prompt, not a durable
 * policy store. Granted hosts *are* durable — they live in the source's registry entry.
 */

export interface PendingHostRequest {
  sourceId: string
  /** `host[:port]`, lower-cased — the exact string a grant would add. */
  host: string
  /** The URL that was refused, truncated: useful to see *why* a source wants this host. */
  url: string
  at: number
  /** How many times this host has been refused since the last grant, so repeats are visible. */
  attempts: number
  /** The permission that was missing, when the refusal was not host-scoped. */
  missingPermission?: SourcePermission
}

const MAX_PENDING_PER_SOURCE = 12
const pending = new Map<string, Map<string, PendingHostRequest>>()

/** Normalises a URL to the `host[:port]` form used by grants. Returns `null` if unparseable. */
export function hostOfUrl(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase()
  } catch {
    return null
  }
}

function sameHost(candidate: string, url: string): boolean {
  const host = hostOfUrl(url)
  return host !== null && host === candidate.toLowerCase()
}

/** Records a refused host so the UI can offer to grant it. */
export function recordPendingHost(sourceId: string, host: string, url: string): void {
  const byHost = pending.get(sourceId) ?? new Map<string, PendingHostRequest>()
  const key = host.toLowerCase()
  const existing = byHost.get(key)
  byHost.set(key, {
    sourceId,
    host: key,
    url: url.slice(0, 300),
    at: Date.now(),
    attempts: (existing?.attempts ?? 0) + 1,
  })
  // Bounded: a source that iterates over hosts must not grow this without limit.
  while (byHost.size > MAX_PENDING_PER_SOURCE) {
    const oldest = [...byHost.values()].sort((a, b) => a.at - b.at)[0]
    if (!oldest) break
    byHost.delete(oldest.host)
  }
  pending.set(sourceId, byHost)
}

export function readPendingHosts(sourceId?: string): PendingHostRequest[] {
  if (sourceId) return [...(pending.get(sourceId)?.values() ?? [])]
  return [...pending.values()].flatMap((byHost) => [...byHost.values()]).sort((a, b) => b.at - a.at)
}

export function clearPendingHosts(sourceId: string, host?: string): void {
  if (!host) {
    pending.delete(sourceId)
    return
  }
  const byHost = pending.get(sourceId)
  if (!byHost) return
  byHost.delete(host.toLowerCase())
  if (byHost.size === 0) pending.delete(sourceId)
}

/**
 * Import-mode counterpart of `authorizeRequest`: let the request through and remember the host.
 *
 * This exists so that "can this source describe itself?" never depends on "has the user approved a
 * host yet?" — a source that fetches a config before announcing its platforms must still be able to
 * import, otherwise the only fixable failure (grant the host) presents itself as an unfixable one.
 * The recorded host is not a grant: it is what the confirmation dialog shows, and the runtime still
 * refuses the same host afterwards until it is granted.
 */
export function allowAndRecordHost(sourceId: string, url: string): URL {
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new SourceError('UNSUPPORTED', `只允许 http(s) 请求（收到 ${parsed.protocol}）`)
  }
  // Safe mode applies here too, and this is the path that matters most for it: this is the *install /
  // probe* mode, where a source that has no grants at all is still allowed to describe itself. Letting
  // cleartext through here would mean safe mode could be bypassed simply by asking for the host during
  // import instead of during playback.
  const insecure = insecureRequestReason(url)
  if (insecure) throw new SourceError('UNSUPPORTED', `安装探测：${insecure}`)
  recordPendingHost(sourceId, parsed.host.toLowerCase(), url)
  return parsed
}

export function isHostGranted(grantedHosts: readonly string[], url: string): boolean {
  const host = hostOfUrl(url)
  if (!host) return false
  return grantedHosts.some((allowed) => sameHost(allowed, url) && allowed.toLowerCase() === host)
}

/**
 * The single place a network request is authorised.
 *
 * Throws a `PERMISSION` error (never an admission error) and records the host as pending, so the
 * failure is actionable instead of terminal.
 */
export function authorizeRequest(options: {
  sourceId: string
  sourceName: string
  url: string
  permissions: readonly SourcePermission[]
  grantedHosts: readonly string[]
}): URL {
  const { sourceId, sourceName, url, permissions, grantedHosts } = options
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new SourceError('INVALID_RESPONSE', `${sourceName}：请求地址不合法`)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new SourceError('UNSUPPORTED', `${sourceName}：只允许 http(s) 请求（收到 ${parsed.protocol}）`)
  }
  /*
   * 安全模式, enforced at the single point every script request passes through.
   *
   * `UNSUPPORTED`, not `PERMISSION`: a refusal here is not something a host grant fixes — the fix is the
   * toggle — so it must not be reported as a pending grant, and the auto-repair path (which reacts to
   * `PERMISSION` only) must not retry it and re-grant a host the user deliberately restricted.
   */
  const insecure = insecureRequestReason(url)
  if (insecure) throw new SourceError('UNSUPPORTED', `${sourceName}：${insecure}`)
  if (!permissions.includes('network')) {
    throw new SourceError('PERMISSION', `${sourceName}：该音源没有 network 权限，请在音源管理页授权`)
  }
  const host = parsed.host.toLowerCase()
  if (!isHostGranted(grantedHosts, url)) {
    recordPendingHost(sourceId, host, url)
    throw new SourceError(
      'PERMISSION',
      `${sourceName}：尚未授权访问 ${host}，请在音源管理页允许该主机后重试`,
    )
  }
  return parsed
}
