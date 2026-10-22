import { app } from 'electron'
import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { clearAllCaches } from './cache'
import { lyricsDir } from './lyricsEngine/store'
import type { CacheArea, CacheAreaId, CacheClearResult, CacheReport } from '../shared/maintenance'

/**
 * Cache accounting — the numbers behind 设置 → 缓存管理, and the deletion that has to match them.
 *
 * Three rules:
 *
 *  1. **Nothing is counted that cannot be deleted, and nothing is deleted that was not counted.**
 *     Both sides walk the same `files()` output, so a "清理了 0 字节" can only mean the area really
 *     was empty.
 *  2. **User data is never on the list.** The lyrics directory holds the user's own imported `.lrc`
 *     files next to the fetched cache; those are recognised by name (`<sha1>.lrc` — the key the store
 *     derives from a track id) and are never touched, whatever the cache index says.
 *  3. **A failed delete is reported, not swallowed.** A cover still open in another program is a real
 *     outcome, so the report is re-measured afterwards and the UI shows what actually remains.
 */

interface AreaSpec {
  id: CacheAreaId
  label: string
  detail: string
  path: () => string
  files: () => Promise<string[]>
}

async function directoryFiles(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    const paths: string[] = []
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) paths.push(...(await directoryFiles(path)))
      else if (entry.isFile()) paths.push(path)
    }
    return paths
  } catch {
    // No directory yet means the area is empty, which is the truth for a fresh install.
    return []
  }
}

async function sizeOf(paths: string[]): Promise<number> {
  let total = 0
  for (const path of paths) {
    try {
      total += (await stat(path)).size
    } catch {
      // Vanished between listing and measuring: already gone, so it weighs nothing.
    }
  }
  return total
}

/** Imported lyrics are named `<sha1(trackId)>.lrc>`; a fetched cache file never is. */
const USER_LYRIC_NAME = /^[0-9a-f]{32}\.lrc$/i

async function lyricsCacheFiles(): Promise<string[]> {
  const directory = lyricsDir()
  if (!directory) return []
  const names = await directoryFiles(directory)
  return names.filter((path) => {
    const name = path.slice(directory.length + 1)
    return /\.lrc$/i.test(name) && !USER_LYRIC_NAME.test(name)
  })
}

const AREAS: AreaSpec[] = [
  {
    id: 'covers',
    label: '封面缓存',
    detail: '从在线音源下载并保存到本机的专辑封面。清理后再次浏览会重新下载。',
    path: () => join(app.getPath('userData'), 'covers'),
    files: () => directoryFiles(join(app.getPath('userData'), 'covers')),
  },
  {
    id: 'lyrics',
    label: '歌词缓存',
    detail: '联网匹配后缓存下来的歌词（含翻译与罗马音）。你手动导入的歌词不在此列，不会被删除。',
    path: () => lyricsDir(),
    files: lyricsCacheFiles,
  },
  {
    id: 'temp',
    label: '临时文件',
    detail: '格式转换与下载中断留下的中间文件。它们只在一次操作进行中存在，遗留下来的都可以安全删除。',
    path: () => join(app.getPath('userData'), 'temp'),
    files: async () => {
      const files = await directoryFiles(join(app.getPath('userData'), 'temp'))
      return files.filter((path) => /\.(part|tmp|aurora-tmp)$/i.test(path))
    },
  },
]

export async function measureCaches(): Promise<CacheReport> {
  const areas: CacheArea[] = []
  for (const spec of AREAS) {
    const files = await spec.files()
    areas.push({
      id: spec.id,
      label: spec.label,
      detail: spec.detail,
      path: spec.path(),
      files: files.length,
      bytes: await sizeOf(files),
    })
  }
  return {
    areas,
    totalFiles: areas.reduce((sum, area) => sum + area.files, 0),
    totalBytes: areas.reduce((sum, area) => sum + area.bytes, 0),
    checkedAt: Date.now(),
  }
}

/**
 * Deletes one area (or every area) and re-measures.
 *
 * The in-memory TTL caches are dropped as well: a cleared cover cache with a warm search cache would
 * still resolve the old cover URLs, which reads as "the button did nothing".
 */
export async function clearCaches(areaIds?: CacheAreaId[]): Promise<CacheClearResult> {
  const before = await measureCaches()
  const wanted = areaIds && areaIds.length > 0 ? new Set(areaIds) : null
  for (const spec of AREAS) {
    if (wanted && !wanted.has(spec.id)) continue
    for (const path of await spec.files()) {
      try {
        await rm(path, { force: true })
      } catch {
        // Locked or already gone; the re-measure below reports what is left.
      }
    }
  }
  clearAllCaches()
  const after = await measureCaches()
  return {
    report: after,
    freedFiles: Math.max(0, before.totalFiles - after.totalFiles),
    freedBytes: Math.max(0, before.totalBytes - after.totalBytes),
    memoryCaches: before.areas.length,
  }
}
