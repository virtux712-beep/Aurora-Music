import { decodeName, formatPlayTime, formatSingerName, sizeFormate } from '../helpers'
import { httpFetch } from '../http'
import type { PlatformSearchResult, RawSong } from '../types'

/**
 * 酷狗音乐 search.
 *
 * Port of `lx-music-desktop/src/renderer/utils/musicSdk/kg/musicSearch.js`. Kugou returns four
 * parallel quality slots (`FileSize` / `HQFileSize` / `SQFileSize` / `ResFileSize`), each with its own
 * hash — the `hash` per quality is what the URL resolver later needs, so it is carried through here.
 */

function filterData(raw: any): RawSong {
  const types: RawSong['types'] = []
  const byType: RawSong['_types'] = {}
  if (raw.FileSize !== 0) {
    const size = sizeFormate(raw.FileSize)
    types.push({ type: '128k', size, hash: raw.FileHash })
    byType['128k'] = { size, hash: raw.FileHash }
  }
  if (raw.HQFileSize !== 0) {
    const size = sizeFormate(raw.HQFileSize)
    types.push({ type: '320k', size, hash: raw.HQFileHash })
    byType['320k'] = { size, hash: raw.HQFileHash }
  }
  if (raw.SQFileSize !== 0) {
    const size = sizeFormate(raw.SQFileSize)
    types.push({ type: 'flac', size, hash: raw.SQFileHash })
    byType.flac = { size, hash: raw.SQFileHash }
  }
  if (raw.ResFileSize !== 0) {
    const size = sizeFormate(raw.ResFileSize)
    types.push({ type: 'flac24bit', size, hash: raw.ResFileHash })
    byType.flac24bit = { size, hash: raw.ResFileHash }
  }
  return {
    singer: decodeName(formatSingerName(raw.Singers, 'name')),
    name: decodeName(`${raw.OriSongName}${raw.Suffix ? ` ${raw.Suffix}` : ''}`),
    albumName: decodeName(raw.AlbumName),
    albumId: raw.AlbumID,
    songmid: raw.Audioid,
    albumAudioId: raw.MixSongID,
    source: 'kg',
    interval: formatPlayTime(raw.Duration),
    _interval: raw.Duration,
    img: null,
    lrc: null,
    otherSource: null,
    hash: raw.FileHash,
    types,
    _types: byType,
    typeUrl: {},
  }
}

function handleResult(rawList: any[]): RawSong[] {
  const seen = new Set<string>()
  const list: RawSong[] = []
  for (const item of rawList) {
    // The same song arrives once as `Audioid + FileHash` and again as a group member; the dedupe key
    // is LX's, so the result set matches what an LX source expects to see.
    const add = (raw: any): void => {
      const key = `${raw.Audioid}${raw.FileHash}`
      if (seen.has(key)) return
      seen.add(key)
      list.push(filterData(raw))
    }
    add(item)
    for (const child of item.Grp ?? []) add(child)
  }
  return list
}

function request(keyword: string, page: number, limit: number) {
  const url =
    'http://songsearch.kugou.com/song_search_v2?platform=AndroidFilter&iscorrection=1' +
    `&keyword=${encodeURIComponent(keyword)}&hifiquality=0&pagesize=${limit}` +
    `&PrivilegeFilter=0&page=${page}`
  return httpFetch(url).promise
}

export async function search(
  keyword: string,
  page = 1,
  limit = 30,
  attempt = 0,
): Promise<PlatformSearchResult> {
  if (attempt >= 3) throw new Error('酷狗音乐：搜索重试次数过多')
  const { body } = (await request(keyword, page, limit)) as { body: any }
  if (!body || body.error_code !== 0) return search(keyword, page, limit, attempt + 1)
  const list = handleResult(body.data?.lists ?? [])
  const total = body.data?.total ?? 0
  return { list, total, allPage: Math.ceil(total / limit), limit, source: 'kg' }
}
