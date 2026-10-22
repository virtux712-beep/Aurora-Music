import { grantCustomHosts, revokeCustomHosts } from '../customSources/store'
import { grantScriptHosts, revokeScriptHosts } from '../scriptSources/store'
import { logSourceError } from './log'
import { readPendingHosts } from './permissions'
import { hostAutoGrantAllowed } from './policy'
import { getEntry } from './registry'

/**
 * The automatic half of the permission layer: turn the hosts a source was *refused* into ones it may
 * use, without making the user go and find a button.
 *
 * Why this exists at all: a host a source asks for at play time is frequently built at runtime
 * (`'88.' + 'example' + '.cn'`), so nothing at install time can know it. The old behaviour was
 * correct and useless — refuse, record, and tell the user to go grant it — and on a fresh machine
 * that read as "I installed a source and it cannot connect". This closes that loop: the request is
 * retried immediately, and the grant is written to the same durable, revocable place a manual grant
 * goes, so the source manager still shows exactly which hosts it may reach.
 *
 * It runs only for sources the user installed themselves (script and declarative entries). Built-in
 * platforms keep the allowlist compiled into them: there is no user-facing entry to edit, and
 * nothing is gained by granting their own declared hosts back to them.
 *
 * It is deliberately *not* reachable from the sandbox. A script cannot call this, cannot name the
 * host it wants granted, and cannot reach a host that was never refused first — the pending record
 * is written by the refusal itself.
 */
export interface AutoRepairResult {
  /** Hosts that are now granted (empty when there was nothing to repair). */
  granted: string[]
  /** The name shown in the log/UI, so the message can say whose request it was. */
  sourceName: string
  /**
   * Set when 安全模式 refused the automatic grant, with the sentence to show.
   *
   * "There was nothing to repair" and "I am not allowed to repair it" produce the same empty `granted`
   * list, and the two need different sentences: the first is fine, the second has to name the switch and
   * the hosts, because the user's next move is to grant them by hand.
   */
  blocked?: string
}

/**
 * Takes hosts back off a source's allowlist.
 *
 * Grants are only honest if they can be undone: an automatic grant the user cannot revoke is a
 * permission the source keeps forever, and the audit line the repair writes says exactly where to
 * undo it. Revoking is deliberately *not* the same as uninstalling — the next play simply gets
 * refused (and, with auto-grant on, granted again), which keeps the setting reversible.
 */
export async function revokeSourceHosts(sourceId: string, hosts: string[]): Promise<AutoRepairResult> {
  const entry = getEntry(sourceId)
  if (!entry) return { granted: [], sourceName: sourceId }
  const result =
    entry.kind === 'script' ? await revokeScriptHosts(sourceId, hosts) : await revokeCustomHosts(sourceId, hosts)
  if (!result.ok) {
    logSourceError(sourceId, 'PERMISSION', `撤销授权失败：${result.errors.join('；')}`, 'revoke')
    return { granted: [], sourceName: entry.name }
  }
  logSourceError(sourceId, 'PERMISSION', `已撤销 ${hosts.join('、')} 的访问授权`, 'revoke')
  return { granted: hosts, sourceName: entry.name }
}

export async function repairRefusedHosts(sourceId: string): Promise<AutoRepairResult> {
  // Built-in platforms are not registry entries, so "no entry" is exactly the case that must stay
  // untouched: their allowlist is compiled into them and there is nothing user-facing to grant.
  const entry = getEntry(sourceId)
  if (!entry) return { granted: [], sourceName: sourceId }

  const hosts = readPendingHosts(sourceId).map((pending) => pending.host)
  if (hosts.length === 0) return { granted: [], sourceName: entry.name }

  /*
   * 安全模式 wins here too, and this call site is the one that made that necessary.
   *
   * The playback paths consult `hostAutoGrantAllowed()` before repairing; the sound-check page's
   * 「自检并自动修复」 button calls this function directly, so with safe mode on it used to write an
   * automatic grant anyway — the exact thing the switch promises not to do ("未授权主机不再自动放行"),
   * and it did it while the settings row said the opposite. A permission the user cannot see being
   * taken is worse than one that is refused, so the refusal is reported rather than swallowed.
   */
  if (!hostAutoGrantAllowed()) {
    return {
      granted: [],
      sourceName: entry.name,
      blocked: `安全模式已开启：不会自动允许 ${hosts.join('、')}。请在下方手动点「允许」后再重试。`,
    }
  }

  const result =
    entry.kind === 'script' ? await grantScriptHosts(sourceId, hosts) : await grantCustomHosts(sourceId, hosts)
  if (!result.ok) {
    // A failed repair must not look like a successful one: the caller falls through to the refusal
    // it already has, and the reason is readable in the source's error history.
    logSourceError(sourceId, 'PERMISSION', `自动授权失败：${result.errors.join('；')}`, 'grant')
    return { granted: [], sourceName: entry.name }
  }
  // Recorded so "why can this source reach that host?" has an answer other than "it always could".
  logSourceError(sourceId, 'PERMISSION', `已自动允许访问 ${hosts.join('、')}（可在音源管理页撤销）`, 'grant')
  return { granted: hosts, sourceName: entry.name }
}
