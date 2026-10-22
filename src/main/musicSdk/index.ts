import { search as kgSearch } from './platforms/kg'
import { search as kwSearch } from './platforms/kw'
import { search as mgSearch } from './platforms/mg'
import { search as txSearch } from './platforms/tx'
import { search as wySearch } from './platforms/wy'
import type { LxMusicInfo, PlatformSearchResult, RawSong } from './types'

/**
 * Aurora's built-in **platform search**.
 *
 * This is the piece `lx-music-desktop` calls its `musicSdk`: the search/metadata half of online music.
 * It is deliberately separate from the URL-resolution half, because that is exactly how LX splits it
 * — LX searches with its own per-platform code and asks the *user's* source only for a playable URL
 * (`action: 'musicUrl'`) and lyrics (`action: 'lyric'`). Without this half, a user source would have
 * nothing to resolve: published LX sources implement `musicUrl`, almost none implement `search`.
 *
 * The searches are faithful ports of LX's per-platform modules, including their request signing,
 * because a source receives this data as LX's `MusicInfo` and its `musicUrl` handler reads fields
 * like `meta.songId` / `meta.hash` / `meta.copyrightId` out of it.
 */

export interface PlatformDefinition {
  id: string
  name: string
  /** Two-character tab label for the search page. */
  short: string
  search: (keyword: string, page: number, limit: number) => Promise<PlatformSearchResult>
  /** Qualities the platform itself can offer; what a source actually serves is its own business. */
  qualities: string[]
}

export const PLATFORMS: PlatformDefinition[] = [
  { id: 'kw', name: '酷我音乐', short: '酷我', search: kwSearch, qualities: ['128k', '320k', 'flac', 'flac24bit'] },
  { id: 'wy', name: '网易云音乐', short: '网易', search: wySearch, qualities: ['128k', '320k', 'flac', 'flac24bit'] },
  { id: 'tx', name: 'QQ音乐', short: 'QQ', search: txSearch, qualities: ['128k', '320k', 'flac', 'flac24bit'] },
  { id: 'kg', name: '酷狗音乐', short: '酷狗', search: kgSearch, qualities: ['128k', '320k', 'flac', 'flac24bit'] },
  { id: 'mg', name: '咪咕音乐', short: '咪咕', search: mgSearch, qualities: ['128k', '320k', 'flac', 'flac24bit'] },
]

export const PLATFORM_IDS = PLATFORMS.map((platform) => platform.id)

export function platformById(id: string): PlatformDefinition | undefined {
  return PLATFORMS.find((platform) => platform.id === id)
}

/** Presentation names for a platform id, so the UI never hardcodes a label. */
export function platformName(id: string): string {
  return platformById(id)?.name ?? id
}

/**
 * Converts a platform's raw search row into the `MusicInfo` an LX source receives.
 *
 * Port of `toNewMusicInfo` in LX's `src/common/utils/tools.ts`. The per-source `meta` extras matter:
 * a source reading `meta.hash` for Kugou or `meta.copyrightId` for Migu would otherwise resolve a
 * different (or no) song.
 */
export function toLxMusicInfo(song: RawSong): LxMusicInfo {
  const meta: LxMusicInfo['meta'] = {
    songId: song.songmid,
    albumName: song.albumName ?? '',
    picUrl: song.img ?? null,
    albumId: song.albumId,
    qualitys: song.types,
    _qualitys: song._types,
  }
  let id = `${song.source}_${song.songmid}`
  switch (song.source) {
    case 'kg':
      meta.hash = song.hash
      meta.albumAudioId = song.albumAudioId
      id = `${song.songmid}_${song.hash}`
      break
    case 'tx':
      meta.strMediaMid = song.strMediaMid
      meta.id = song.songId
      meta.albumMid = song.albumMid
      break
    case 'mg':
      meta.copyrightId = song.copyrightId
      meta.lrcUrl = song.lrcUrl
      meta.mrcUrl = song.mrcUrl
      meta.trcUrl = song.trcUrl
      break
    default:
      break
  }
  return {
    id,
    name: song.name,
    singer: song.singer,
    source: song.source,
    interval: song.interval ?? null,
    meta,
  }
}

/**
 * The `musicInfo` view Aurora sends to a user source.
 *
 * Two generations of LX sources are published and they read the song id from different places:
 *
 *  - sources written for LX 2.x read `meta.songId` / `meta.hash` / `meta.qualitys`;
 *  - a very common older generation reads the flat pre-2.0 fields (`songmid`, `hash`, `types`, …)
 *    and silently falls back to `musicInfo.id` when `songmid` is absent. That fallback hands the
 *    *prefixed* id (`kw_228908`) to the aggregator, which then resolves the wrong song — or nothing.
 *    This was observable: a real source asked `…&mid=kw_228908` for every provider and never
 *    produced a URL.
 *
 * So both shapes go out, with the modern one winning on conflicts. The flat keys are specifically
 * LX's own `toOldMusicInfo` reverse mapping (see `src/common/utils/tools.ts`) rather than an
 * invention of ours — it is the same conversion LX performs when it hands an old-shaped object to
 * code that predates `MusicInfo`.
 */
export function toSourceMusicInfo(info: LxMusicInfo): Record<string, unknown> {
  const meta = info.meta
  const legacy: Record<string, unknown> = {
    name: info.name,
    singer: info.singer,
    source: info.source,
    songmid: meta.songId,
    interval: info.interval,
    albumName: meta.albumName,
    img: meta.picUrl ?? '',
    typeUrl: {},
    albumId: meta.albumId,
    types: meta.qualitys,
    _types: meta._qualitys,
  }
  switch (info.source) {
    case 'kg':
      legacy.hash = meta.hash
      legacy.albumAudioId = meta.albumAudioId
      break
    case 'tx':
      legacy.strMediaMid = meta.strMediaMid
      legacy.albumMid = meta.albumMid
      // In the flat shape `songId` is the numeric id while `songmid` is the mid string; `meta.id`
      // holds the numeric one, which is why the mapping is not symmetrical with the others.
      legacy.songId = meta.id
      break
    case 'mg':
      legacy.copyrightId = meta.copyrightId
      legacy.lrcUrl = meta.lrcUrl
      legacy.mrcUrl = meta.mrcUrl
      legacy.trcUrl = meta.trcUrl
      legacy.musicrid = `MUSIC_${String(meta.copyrightId ?? '')}`
      break
    case 'kw':
      // Kuwo's flat shape carried both spellings, and sources in the wild read either one.
      legacy.rid = meta.songId
      legacy.musicrid = `MUSIC_${String(meta.songId ?? '')}`
      break
    default:
      break
  }
  return { ...legacy, ...info }
}

export async function searchPlatform(
  platformId: string,
  keyword: string,
  page = 1,
  limit = 30,
): Promise<LxMusicInfo[]> {
  const platform = platformById(platformId)
  if (!platform) throw new Error(`未知平台：${platformId}`)
  const result = await platform.search(keyword, Math.max(1, page), limit)
  return result.list.map(toLxMusicInfo)
}

/** `mm:ss` → seconds. LX stores the formatted string; Aurora's tracks carry seconds. */
export function intervalToSeconds(interval: string | null | undefined): number {
  if (!interval) return 0
  const match = /(\d+):(\d+)/.exec(interval)
  if (!match) return 0
  return Number(match[1]) * 60 + Number(match[2])
}

export type { LxMusicInfo, PlatformSearchResult, RawSong }
