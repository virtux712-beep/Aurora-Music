import { app, shell } from 'electron'
import { getSettings, updateSettings } from './settings'
import { recordDiagnostics } from './diagnostics'
import type { UpdateCheckResult } from '../shared/maintenance'

/**
 * Update checking.
 *
 * There is no bundler-side auto-updater here on purpose: Aurora has no signed release feed wired up, and
 * an updater that cannot verify a signature is worse than no updater. What this module does instead is
 * the honest half of the feature — it asks a **real** URL what the newest version is and reports what
 * came back, including "no feed configured" and the literal reason a check failed.
 *
 * Two response shapes are understood, because they cover how this kind of project is actually
 * published:
 *  - a GitHub releases payload (`tag_name` / `html_url` / `body`), and
 *  - a hand-written manifest (`{ "version": "0.2.0", "url": "...", "notes": "..." }`).
 */

const TIMEOUT_MS = 8000
const MAX_BODY = 256 * 1024

let last: UpdateCheckResult | null = null
let inFlight: Promise<UpdateCheckResult> | null = null

/** `1.2.3` → [1,2,3]; anything unparsable sorts below everything, so a weird tag never wins. */
function parseVersion(value: string): number[] {
  const cleaned = value.trim().replace(/^v/i, '')
  const parts = cleaned.split(/[.\-+]/).map((part) => Number.parseInt(part, 10))
  return parts.some((part) => Number.isFinite(part)) ? parts.map((part) => (Number.isFinite(part) ? part : 0)) : []
}

export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const l = left[index] ?? 0
    const r = right[index] ?? 0
    if (l !== r) return l > r ? 1 : -1
  }
  return 0
}

interface Manifest {
  version: string
  url: string
  notes: string
}

function readManifest(payload: unknown): Manifest | null {
  if (!payload || typeof payload !== 'object') return null
  const candidate = payload as Record<string, unknown>
  // GitHub releases API.
  if (typeof candidate.tag_name === 'string') {
    return {
      version: candidate.tag_name,
      url: typeof candidate.html_url === 'string' ? candidate.html_url : '',
      notes: typeof candidate.body === 'string' ? candidate.body.slice(0, 400) : '',
    }
  }
  // Plain manifest.
  if (typeof candidate.version === 'string') {
    return {
      version: candidate.version,
      url: typeof candidate.url === 'string' ? candidate.url : '',
      notes: typeof candidate.notes === 'string' ? candidate.notes.slice(0, 400) : '',
    }
  }
  return null
}

export async function checkForUpdates(force = false): Promise<UpdateCheckResult> {
  const settings = getSettings().updateCheck
  const currentVersion = app.getVersion()
  if (!settings.feedUrl.trim()) {
    return {
      status: 'unconfigured',
      currentVersion,
      latestVersion: '',
      downloadUrl: '',
      notes: '',
      checkedAt: Date.now(),
      detail: '尚未配置更新源。填一个返回版本清单的地址（GitHub releases API 或 {"version","url"} JSON）后即可检查。',
    }
  }
  if (last && !force && Date.now() - last.checkedAt < 60_000) return last
  if (inFlight) return inFlight

  inFlight = (async (): Promise<UpdateCheckResult> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      const response = await fetch(settings.feedUrl.trim(), {
        signal: controller.signal,
        headers: { accept: 'application/json', 'user-agent': `Aurora/${currentVersion}` },
      })
      if (!response.ok) {
        return {
          status: 'error',
          currentVersion,
          latestVersion: '',
          downloadUrl: '',
          notes: '',
          checkedAt: Date.now(),
          detail: `更新源返回 HTTP ${response.status} ${response.statusText}`.trim(),
        }
      }
      const text = (await response.text()).slice(0, MAX_BODY)
      const manifest = readManifest(JSON.parse(text) as unknown)
      if (!manifest) {
        return {
          status: 'error',
          currentVersion,
          latestVersion: '',
          downloadUrl: '',
          notes: '',
          checkedAt: Date.now(),
          detail: '更新源返回的 JSON 里没有 tag_name 或 version 字段。',
        }
      }
      const available = compareVersions(manifest.version, currentVersion) > 0
      return {
        status: available ? 'available' : 'up-to-date',
        currentVersion,
        latestVersion: manifest.version,
        downloadUrl: manifest.url,
        notes: manifest.notes,
        checkedAt: Date.now(),
        detail: available
          ? `发现新版本 ${manifest.version}（当前 ${currentVersion}）`
          : `已是最新版本（当前 ${currentVersion}）`,
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      recordDiagnostics('main', 'update-check', reason)
      return {
        status: 'error',
        currentVersion,
        latestVersion: '',
        downloadUrl: '',
        notes: '',
        checkedAt: Date.now(),
        detail: reason.includes('abort') ? `更新源在 ${TIMEOUT_MS / 1000} 秒内没有响应` : reason,
      }
    } finally {
      clearTimeout(timer)
      inFlight = null
    }
  })()

  last = await inFlight
  return last
}

export function openUpdatePage(url: string): boolean {
  if (!/^https:\/\//.test(url)) return false
  void shell.openExternal(url)
  return true
}

/** Startup auto-check, if the user asked for one and a feed exists. Never blocks the window. */
export async function autoCheckUpdates(): Promise<void> {
  const settings = getSettings().updateCheck
  if (!settings.autoCheck || !settings.feedUrl.trim()) return
  await checkForUpdates(true)
}

export async function setUpdateCheck(patch: { feedUrl?: string; autoCheck?: boolean }): Promise<void> {
  await updateSettings({ updateCheck: patch })
  last = null
}
