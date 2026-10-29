import { useUiStore } from '../stores/ui'
import { reportRendererError } from './crashReporting'

/**
 * The failure path for localStorage-backed stores (playlists, collection).
 *
 * A failed write used to be swallowed whole: the data stayed in memory, the user kept
 * working under the impression everything was saved, and the loss only surfaced on the
 * next launch — by which time exporting a backup was no longer possible. Now the failure
 * is recorded in diagnostics (via the rate-limited crash reporter) and the user is told
 * once per store per session, while there is still something left to back up.
 */
const warned = new Set<string>()

export function reportPersistFailure(kind: string, error: unknown): void {
  reportRendererError(kind, error)
  if (warned.has(kind)) return
  warned.add(kind)
  try {
    useUiStore().notify('本地保存失败：存储空间可能已满或损坏，本次更改退出后可能丢失，建议尽快导出备份。', 'error')
  } catch {
    // The toast is a courtesy; the diagnostics entry above is the record that matters.
  }
}
