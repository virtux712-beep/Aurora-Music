import type {
  BoardDescriptor,
  BoardOutcome,
  PlatformDescriptor,
  PlatformHealthSummary,
  PlatformId,
  PlatformSearchOutcome,
  SearchOptions,
} from '../../shared/types'
import { PLATFORMS, intervalToSeconds, searchPlatform, toLxMusicInfo, type LxMusicInfo } from '../musicSdk'
import { fetchBoardSongs, listBoards } from '../musicSdk/boards'
import { registerRemoteMedia } from '../remote'
import { buildTrack } from '../sources/types'
import type { AudioTrack } from '../../shared/types'

function platformToDescriptor(def: (typeof PLATFORMS)[number]): PlatformDescriptor {
  return {
    id: def.id,
    name: def.name,
    shortLabel: def.short,
    /*
     * The service's real name is deliberately absent: the UI addresses platforms by their own codename, and
     * a read-only capability row that spells out the upstream brand is the one place a user cannot change
     * anything about it. What the row has to say is what it can do, not who it is.
     */
    description: '搜索由 Aurora 直连该平台完成，播放地址由你安装且声明该平台的音源解析。',
    qualities: def.qualities,
    icon: '♫',
  }
}

export function listPlatformDescriptors(): PlatformDescriptor[] {
  return PLATFORMS.map(platformToDescriptor)
}

export function getPlatformDescriptor(id: PlatformId): PlatformDescriptor | undefined {
  return listPlatformDescriptors().find((item) => item.id === id)
}

function toTrack(info: LxMusicInfo): AudioTrack {
  const picUrl = typeof info.meta.picUrl === 'string' ? info.meta.picUrl.trim() : ''
  // Cover art is a real CDN URL, and the renderer's CSP admits only `aurora-media:` for images — so a
  // platform cover takes the same opaque-token relay as the audio stream. Handing the raw URL through
  // meant every platform cover was silently refused by the renderer: the search rows, the queue, the
  // player bar and the artwork canvas all drew a broken image for online tracks while local files
  // looked fine, which is exactly how this was found.
  const cover = picUrl && /^https?:/i.test(picUrl) ? registerRemoteMedia(picUrl, 'image', info.source) : undefined
  // The platform reports what this *song* is available in (`meta.qualitys`, ported from LX's
  // `song.types`) — that is what drives the SQ / Master badges, so the UI never guesses a quality
  // from the platform's capabilities.
  const qualities: string[] = Array.isArray(info.meta.qualitys)
    ? info.meta.qualitys
        .map((item) => (typeof item === 'string' ? item : String((item as { type?: unknown }).type ?? '')))
        .filter((item) => item.length > 0)
    : []
  return buildTrack(info.source, {
    id: `${info.source}:${info.id}`,
    title: info.name,
    artist: info.singer || '未知艺术家',
    album: String(info.meta.albumName || '未知专辑'),
    duration: intervalToSeconds(info.interval),
    format: '—',
    fileUrl: '',
    platform: info.source,
    sourceTrackId: info.id,
    ...(cover ? { cover } : {}),
    ...(qualities.length > 0 ? { qualities } : {}),
    metadata: { lx: info },
  })
}

export async function searchPlatformOutcome(
  platformId: PlatformId,
  query: string,
  options: SearchOptions,
): Promise<PlatformSearchOutcome> {
  const started = Date.now()
  const descriptor = getPlatformDescriptor(platformId)
  const name = descriptor?.name ?? platformId
  try {
    const page = Math.max(1, Math.round(options.page ?? 1))
    const limit = Math.min(Math.max(Math.round(options.pageSize ?? 30), 1), 50)
    const infos = await searchPlatform(platformId, query, page, limit)
    return {
      platformId,
      platformName: name,
      ok: true,
      tracks: infos.map(toTrack),
      latencyMs: Date.now() - started,
    }
  } catch (error) {
    return {
      platformId,
      platformName: name,
      ok: false,
      tracks: [],
      error: { code: 'NETWORK_ERROR', message: error instanceof Error ? error.message : '平台搜索失败' },
      latencyMs: Date.now() - started,
    }
  }
}

/* ------------------------------------------------------------------ charts (热榜) */

/**
 * Charts are a *platform* feature, exactly like search: Aurora reads them straight from the
 * platform's public board endpoint. A chart with no resolver can still be browsed — it just cannot be
 * played until a source declaring that platform is installed and enabled.
 */
export function listBoardDescriptors(): BoardDescriptor[] {
  return listBoards().map((board) => ({
    platformId: board.platformId,
    platformName: getPlatformDescriptor(board.platformId)?.name ?? board.platformId,
    boardId: board.boardId,
    name: board.name,
  }))
}

export async function fetchBoardOutcome(
  platformId: PlatformId,
  boardId: string,
  limit = 50,
): Promise<BoardOutcome> {
  const started = Date.now()
  const descriptor = getPlatformDescriptor(platformId)
  const platformName = descriptor?.name ?? platformId
  const board = listBoardDescriptors().find(
    (item) => item.platformId === platformId && item.boardId === boardId,
  )
  const boardName = board?.name ?? boardId
  try {
    const songs = await fetchBoardSongs(platformId, boardId, limit)
    return {
      platformId,
      platformName,
      boardId,
      boardName,
      ok: true,
      tracks: songs.map((song) => toTrack(toLxMusicInfo(song))),
      latencyMs: Date.now() - started,
    }
  } catch (error) {
    return {
      platformId,
      platformName,
      boardId,
      boardName,
      ok: false,
      tracks: [],
      error: { code: 'NETWORK_ERROR', message: error instanceof Error ? error.message : '榜单加载失败' },
      latencyMs: Date.now() - started,
    }
  }
}

const AGGREGATE_CONCURRENCY = 4

async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await worker(items[index])
    }
  })
  await Promise.all(runners)
  return results
}

export async function searchAllPlatforms(
  query: string,
  options: SearchOptions,
  platformIds?: PlatformId[],
): Promise<PlatformSearchOutcome[]> {
  const ids = platformIds && platformIds.length > 0 ? platformIds : PLATFORMS.map((item) => item.id)
  return mapWithConcurrency(ids, AGGREGATE_CONCURRENCY, (id) => searchPlatformOutcome(id, query, options))
}
