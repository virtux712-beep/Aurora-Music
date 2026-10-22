import { app, dialog, type BrowserWindow } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { syncMirrorTables } from './database'
import { getSettings, defaultSettings, updateSettings } from './settings'
import {
  BACKUP_FORMAT_VERSION,
  BACKUP_KIND,
  type BackupApplyResult,
  type BackupCounts,
  type BackupExportResult,
  type BackupPickResult,
  type BackupUserData,
} from '../shared/maintenance'
import type { AuroraSettings } from '../shared/types'

/**
 * Backup and restore.
 *
 * The file is a single JSON document with a `kind` and a `formatVersion`, and the whole point of the
 * design is what happens when something is wrong with it:
 *
 *  - **Nothing is applied before the file has been fully validated.** Reading, parsing and shape
 *    checking happen in `pick`, and only a validated bundle is kept in `pending`.
 *  - **Settings are written by main, from main's own copy.** The renderer never sends settings in, so a
 *    corrupted backup cannot smuggle a hostile settings object through the renderer.
 *  - **A failed restore rolls back.** The previous settings are held in `settingsSnapshot` until the
 *    renderer confirms it applied its own half; `revert` is what puts them back, and it is called for
 *    any failure on either side.
 */

let pending: { path: string; bundle: { settings: Partial<AuroraSettings>; data: BackupUserData } } | null = null
let settingsSnapshot: AuroraSettings | null = null

function countsOf(data: BackupUserData, settings: AuroraSettings, tracks: number): BackupCounts {
  return {
    favorites: data.favorites.length,
    history: data.history.length,
    playlists: data.playlists.length,
    tracks,
    settings: Object.keys(settings).length,
  }
}

function emptyData(): BackupUserData {
  return { favorites: [], history: [], playlists: [], lyricColor: 'auto', lyricColorCustom: '' }
}

/** Coerces anything that came out of a file into the shape the renderer can actually apply. */
function sanitizeUserData(raw: unknown): { data: BackupUserData; warnings: string[] } {
  const warnings: string[] = []
  const data = emptyData()
  if (!raw || typeof raw !== 'object') {
    warnings.push('备份里没有用户数据段，已按空数据恢复')
    return { data, warnings }
  }
  const candidate = raw as Record<string, unknown>
  if (Array.isArray(candidate.favorites)) {
    data.favorites = candidate.favorites.filter((value): value is string => typeof value === 'string')
  }
  if (Array.isArray(candidate.history)) {
    data.history = candidate.history.flatMap((value) => {
      if (!value || typeof value !== 'object') return []
      const entry = value as Record<string, unknown>
      if (typeof entry.id !== 'string' || typeof entry.playedAt !== 'number') {
        warnings.push('播放历史里有条目缺少 id 或时间，已跳过')
        return []
      }
      return [{ id: entry.id, playedAt: entry.playedAt, playCount: Number(entry.playCount) || 1 }]
    })
  }
  if (Array.isArray(candidate.playlists)) {
    data.playlists = candidate.playlists.flatMap((value) => {
      if (!value || typeof value !== 'object') return []
      const playlist = value as Record<string, unknown>
      if (typeof playlist.id !== 'string' || typeof playlist.name !== 'string') return []
      const trackIds = Array.isArray(playlist.trackIds)
        ? playlist.trackIds.filter((id): id is string => typeof id === 'string')
        : []
      return [
        {
          id: playlist.id,
          name: playlist.name,
          trackIds,
          createdAt: Number(playlist.createdAt) || Date.now(),
          updatedAt: Number(playlist.updatedAt) || Date.now(),
        },
      ]
    })
  }
  if (typeof candidate.lyricColor === 'string') data.lyricColor = candidate.lyricColor
  if (typeof candidate.lyricColorCustom === 'string') data.lyricColorCustom = candidate.lyricColorCustom
  return { data, warnings }
}

export async function exportBackup(
  window: BrowserWindow | null,
  userData: BackupUserData,
  tracks: number,
): Promise<BackupExportResult> {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const suggested = join(app.getPath('documents'), `aurora-backup-${stamp}.json`)
  const settings = getSettings()
  const bundle = {
    kind: BACKUP_KIND,
    formatVersion: BACKUP_FORMAT_VERSION,
    app: app.getName(),
    appVersion: app.getVersion(),
    createdAt: new Date().toISOString(),
    settings,
    data: { ...emptyData(), ...userData },
  }
  const body = JSON.stringify(bundle, null, 2)

  const choice = window
    ? await dialog.showSaveDialog(window, {
        title: '导出 Aurora 备份',
        defaultPath: suggested,
        filters: [{ name: 'Aurora 备份', extensions: ['json'] }],
      })
    : { canceled: true, filePath: undefined }
  if (choice.canceled || !choice.filePath) {
    return { saved: false, canceled: true, path: '', bytes: 0, counts: countsOf(emptyData(), settings, tracks) }
  }

  await writeFile(choice.filePath, body, 'utf8')
  return {
    saved: true,
    canceled: false,
    path: choice.filePath,
    bytes: Buffer.byteLength(body),
    counts: countsOf(bundle.data, settings, tracks),
  }
}

/** Reads and validates a backup. Keeps the result for `applyBackup`; nothing is written yet. */
export async function pickBackup(window: BrowserWindow | null): Promise<BackupPickResult> {
  const choice = window
    ? await dialog.showOpenDialog(window, {
        title: '选择 Aurora 备份文件',
        properties: ['openFile'],
        filters: [{ name: 'Aurora 备份', extensions: ['json'] }],
      })
    : { canceled: true, filePaths: [] as string[] }
  const path = choice.filePaths?.[0] ?? ''
  if (choice.canceled || !path) {
    return { canceled: true, path: '', error: '', createdAt: '', appVersion: '', formatVersion: 0, counts: countsOf(emptyData(), getSettings(), 0), warnings: [] }
  }

  let parsed: Record<string, unknown>
  try {
    const raw = await readFile(path, 'utf8')
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return { canceled: false, path, error: '这个文件不是有效的 JSON，无法作为备份读取。', createdAt: '', appVersion: '', formatVersion: 0, counts: countsOf(emptyData(), getSettings(), 0), warnings: [] }
  }

  if (parsed.kind !== BACKUP_KIND) {
    return { canceled: false, path, error: '这不是 Aurora 的备份文件（缺少 kind 标记），已拒绝导入。', createdAt: '', appVersion: '', formatVersion: 0, counts: countsOf(emptyData(), getSettings(), 0), warnings: [] }
  }
  const formatVersion = Number(parsed.formatVersion) || 0
  if (formatVersion > BACKUP_FORMAT_VERSION) {
    return { canceled: false, path, error: `备份格式版本 ${formatVersion} 高于当前程序支持的 ${BACKUP_FORMAT_VERSION}，请升级 Aurora 后再导入。`, createdAt: '', appVersion: '', formatVersion, counts: countsOf(emptyData(), getSettings(), 0), warnings: [] }
  }

  const { data, warnings } = sanitizeUserData(parsed.data)
  const settingsPart = (parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : {}) as Partial<AuroraSettings>
  const tracks = Array.isArray((parsed.library as { tracks?: unknown[] } | undefined)?.tracks)
    ? ((parsed.library as { tracks: unknown[] }).tracks.length as number)
    : 0
  pending = { path, bundle: { settings: settingsPart, data } }

  return {
    canceled: false,
    path,
    error: '',
    createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : '',
    appVersion: typeof parsed.appVersion === 'string' ? parsed.appVersion : '',
    formatVersion,
    counts: countsOf(data, parsed.settings as AuroraSettings, tracks),
    warnings,
  }
}

/**
 * Applies the settings half and hands the renderer its own half.
 *
 * The previous settings are snapshotted *before* the write, because the renderer may still fail to
 * apply its part — at which point `revertBackup` puts the user's old settings back and the restore
 * leaves no trace.
 */
export async function applyBackup(): Promise<BackupApplyResult> {
  if (!pending) {
    return { applied: false, counts: countsOf(emptyData(), getSettings(), 0), warnings: ['没有已读取的备份文件，请先选择文件。'], data: null }
  }
  settingsSnapshot = getSettings()
  const merged = { ...defaultSettings(), ...pending.bundle.settings }
  const next = await updateSettings(merged)
  const { data, warnings } = { data: pending.bundle.data, warnings: [] as string[] }
  syncMirrorTables({ favorites: data.favorites, history: data.history, playlists: data.playlists })
  return { applied: true, counts: countsOf(data, next, 0), warnings, data }
}

/** Undoes a restore whose renderer half failed. */
export async function revertBackup(): Promise<boolean> {
  if (!settingsSnapshot) return false
  await updateSettings(settingsSnapshot)
  settingsSnapshot = null
  return true
}

/** Called once the renderer confirms it applied its half, so the snapshot is released. */
export function commitBackup(): void {
  settingsSnapshot = null
  pending = null
}
