import { decodeName, formatPlayTime } from '../helpers'
import { httpFetch } from '../http'
import type { PlatformSearchResult, RawSong } from '../types'

/**
 * 酷我音乐 search.
 *
 * Port of `lx-music-desktop/src/renderer/utils/musicSdk/kw/musicSearch.js`. The endpoint returns a
 * pseudo-JSON body with `abslist` holding the songs and `N_MINFO` describing the available quality
 * levels as a `level:…,bitrate:…,format:…,size:…` list, which is what the regex below parses.
 */

const M_INFO = /level:(\w+),bitrate:(\d+),format:(\w+),size:([\w.]+)/

/** Kuwo separates multiple artists with `&`; LX renders them with `、`. */
function formatSinger(raw: string): string {
  return raw.replace(/&/g, '、')
}

function handleResult(rawList: any[]): RawSong[] | null {
  const result: RawSong[] = []
  for (const info of rawList) {
    const songId = String(info.MUSICRID).replace('MUSIC_', '')
    if (!info.N_MINFO) return null
    const types: RawSong['types'] = []
    const byType: RawSong['_types'] = {}
    for (const entry of String(info.N_MINFO).split(';')) {
      const match = entry.match(M_INFO)
      if (!match) continue
      const size = match[4].toLocaleUpperCase()
      switch (match[2]) {
        case '4000':
          types.push({ type: 'flac24bit', size: match[4] })
          byType.flac24bit = { size }
          break
        case '2000':
          types.push({ type: 'flac', size: match[4] })
          byType.flac = { size }
          break
        case '320':
          types.push({ type: '320k', size: match[4] })
          byType['320k'] = { size }
          break
        case '128':
          types.push({ type: '128k', size: match[4] })
          byType['128k'] = { size }
          break
      }
    }
    types.reverse()
    const interval = parseInt(info.DURATION, 10)
    result.push({
      name: decodeName(info.SONGNAME),
      singer: formatSinger(decodeName(info.ARTIST)),
      source: 'kw',
      songmid: songId,
      albumId: decodeName(info.ALBUMID || ''),
      interval: Number.isNaN(interval) ? '--/--' : formatPlayTime(interval),
      albumName: info.ALBUM ? decodeName(info.ALBUM) : '',
      lrc: null,
      img: null,
      otherSource: null,
      types,
      _types: byType,
      typeUrl: {},
    })
  }
  return result
}

function request(keyword: string, page: number, limit: number) {
  const url =
    `http://search.kuwo.cn/r.s?client=kt&all=${encodeURIComponent(keyword)}&pn=${page - 1}&rn=${limit}` +
    '&uid=794762570&ver=kwplayer_ar_9.2.2.1&vipver=1&show_copyright_off=1&newver=1&ft=music&cluster=0' +
    '&strategy=2012&encoding=utf8&rformat=json&vermerge=1&mobi=1&issubtitle=1'
  return httpFetch(url).promise
}

export async function search(
  keyword: string,
  page = 1,
  limit = 30,
  attempt = 0,
): Promise<PlatformSearchResult> {
  if (attempt > 2) throw new Error('酷我音乐：搜索重试次数过多')
  const { body } = (await request(keyword, page, limit)) as { body: any }
  // `SHOW === '0'` with a non-zero TOTAL means the page index ran past the result set; LX walks back
  // a page rather than reporting "no results".
  if (!body || (body.TOTAL !== '0' && body.SHOW === '0')) return search(keyword, page, limit, attempt + 1)
  const list = handleResult(body.abslist ?? [])
  if (list === null) return search(keyword, page, limit, attempt + 1)
  const total = parseInt(body.TOTAL, 10) || 0
  return { list, total, allPage: Math.ceil(total / limit), limit, source: 'kw' }
}
