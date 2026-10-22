import { formatPlayTime, formatSingerName, sizeFormate, toMD5 } from '../helpers'
import { httpFetch } from '../http'
import type { PlatformSearchResult, RawSong } from '../types'

/**
 * 咪咕音乐 search.
 *
 * Port of `lx-music-desktop/src/renderer/utils/musicSdk/mg/musicSearch.js`. The endpoint demands a
 * `sign` header built from a fixed app secret, so the signature helper is reproduced here; the
 * results arrive as a list of per-position arrays (`songResultData.resultList`), which is why the
 * filter below is double-nested.
 */

const DEVICE_ID = '963B7AA0D21511ED807EE5846EC87D20'
const SIGNATURE_MD5 = '6cdc72a439cef99a3418d2a78aa28c73'
const APP_SALT = 'yyapp2d16148780a1dcc7408e06336b98cfd50'

export function createSignature(time: string, keyword: string): { sign: string; deviceId: string } {
  return {
    sign: toMD5(`${keyword}${SIGNATURE_MD5}${APP_SALT}${DEVICE_ID}${time}`),
    deviceId: DEVICE_ID,
  }
}

function filterData(rawData: any[][]): RawSong[] {
  const list: RawSong[] = []
  const seen = new Set<string>()
  for (const group of rawData) {
    for (const data of group ?? []) {
      if (!data.songId || !data.copyrightId || seen.has(data.copyrightId)) continue
      seen.add(data.copyrightId)
      const types: RawSong['types'] = []
      const byType: RawSong['_types'] = {}
      for (const format of data.audioFormats ?? []) {
        const size = sizeFormate(format.asize ?? format.isize)
        switch (format.formatType) {
          case 'PQ':
            types.push({ type: '128k', size })
            byType['128k'] = { size }
            break
          case 'HQ':
            types.push({ type: '320k', size })
            byType['320k'] = { size }
            break
          case 'SQ':
            types.push({ type: 'flac', size })
            byType.flac = { size }
            break
          case 'ZQ24':
            types.push({ type: 'flac24bit', size })
            byType.flac24bit = { size }
            break
        }
      }
      let img = data.img3 || data.img2 || data.img1 || null
      if (img && !/https?:/.test(data.img3 ?? '')) img = `http://d.musicapp.migu.cn${img}`
      list.push({
        singer: formatSingerName(data.singerList),
        name: data.name,
        albumName: data.album,
        albumId: data.albumId,
        songmid: data.songId,
        copyrightId: data.copyrightId,
        source: 'mg',
        interval: formatPlayTime(data.duration),
        img,
        lrc: null,
        lrcUrl: data.lrcUrl,
        mrcUrl: data.mrcurl,
        trcUrl: data.trcUrl,
        types,
        _types: byType,
        typeUrl: {},
      })
    }
  }
  return list
}

function request(keyword: string, page: number, limit: number) {
  const time = Date.now().toString()
  const signature = createSignature(time, keyword)
  const url =
    'https://jadeite.migu.cn/music_search/v3/search/searchAll?isCorrect=0&isCopyright=1' +
    '&searchSwitch=%7B%22song%22%3A1%2C%22album%22%3A0%2C%22singer%22%3A0%2C%22tagSong%22%3A1' +
    '%2C%22mvSong%22%3A0%2C%22bestShow%22%3A1%2C%22songlist%22%3A0%2C%22lyricSong%22%3A0%7D' +
    `&pageSize=${limit}&text=${encodeURIComponent(keyword)}&pageNo=${page}&sort=0&sid=USS`
  return httpFetch(url, {
    headers: {
      uiVersion: 'A_music_3.6.1',
      deviceId: signature.deviceId,
      timestamp: time,
      sign: signature.sign,
      channel: '0146921',
      'User-Agent':
        'Mozilla/5.0 (Linux; U; Android 11.0.0; zh-cn; MI 11 Build/OPR1.170623.032) AppleWebKit/534.30 (KHTML, like Gecko) Version/4.0 Mobile Safari/534.30',
    },
  }).promise
}

export async function search(
  keyword: string,
  page = 1,
  limit = 20,
  attempt = 0,
): Promise<PlatformSearchResult> {
  if (attempt >= 3) throw new Error('咪咕音乐：搜索重试次数过多')
  const { body } = (await request(keyword, page, limit)) as { body: any }
  if (!body || body.code !== '000000') {
    return search(keyword, page, limit, attempt + 1)
  }
  const songResultData = body.songResultData ?? { resultList: [], totalCount: 0 }
  const list = filterData(songResultData.resultList ?? [])
  const total = parseInt(songResultData.totalCount, 10) || 0
  return { list, total, allPage: Math.ceil(total / limit), limit, source: 'mg' }
}
