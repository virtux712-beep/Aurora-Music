import { createHash } from 'node:crypto'
import { formatPlayTime, formatSingerName, sizeFormate } from '../helpers'
import { httpFetch } from '../http'
import type { PlatformSearchResult, RawSong } from '../types'

/**
 * QQ 音乐 search.
 *
 * Port of `lx-music-desktop/src/renderer/utils/musicSdk/tx/musicSearch.js` and the `zzcSign` helper
 * from `tx/utils/crypto.js`. The `sign` query parameter is derived from the SHA-1 of the request body
 * by picking fixed character positions, XOR-scrambling a byte table with the hash, and base64-ing the
 * result — the server rejects anything else, so this is reproduced exactly.
 */

const PART_1_INDEXES = [23, 14, 6, 36, 16, 40, 7, 19]
const PART_2_INDEXES = [16, 1, 32, 12, 19, 27, 8, 5]
const SCRAMBLE_VALUES = [
  89, 39, 179, 150, 218, 82, 58, 252, 177, 52, 186, 123, 120, 64, 242, 133, 143, 161, 121, 179,
]

function zzcSign(text: string): string {
  const hash = createHash('sha1').update(text).digest('hex')
  const pick = (indexes: number[]): string => indexes.map((index) => hash[index]).join('')
  const scrambled = SCRAMBLE_VALUES.map(
    (value, index) => value ^ parseInt(hash.slice(index * 2, index * 2 + 2), 16),
  )
  const b64 = Buffer.from(scrambled).toString('base64').replace(/[\\/+=]/g, '')
  return `zzc${pick(PART_1_INDEXES)}${b64}${pick(PART_2_INDEXES)}`.toLowerCase()
}

function signRequest(data: unknown) {
  return httpFetch(`https://u.y.qq.com/cgi-bin/musics.fcg?sign=${zzcSign(JSON.stringify(data))}`, {
    method: 'post',
    headers: { 'User-Agent': 'QQMusic 14090508(android 12)' },
    body: data,
  }).promise
}

/** 32 hex chars + a 5-digit counter, i.e. the shape the desktop client sends as a session id. */
function getSearchId(): string {
  let guid = ''
  for (let index = 0; index < 32; index += 1) guid += Math.floor(Math.random() * 16).toString(16)
  return guid.toUpperCase() + String(Math.floor(Math.random() * 100000)).padStart(5, '0')
}

function handleResult(rawList: any[]): RawSong[] {
  const list: RawSong[] = []
  for (const item of rawList) {
    // Without a media mid there is nothing the URL resolver can ask for, so such rows are dropped.
    if (!item.file?.media_mid) continue
    const file = item.file
    const types: RawSong['types'] = []
    const byType: RawSong['_types'] = {}
    if (file.size_128mp3 !== 0) {
      const size = sizeFormate(file.size_128mp3)
      types.push({ type: '128k', size })
      byType['128k'] = { size }
    }
    if (file.size_320mp3 !== 0) {
      const size = sizeFormate(file.size_320mp3)
      types.push({ type: '320k', size })
      byType['320k'] = { size }
    }
    if (file.size_flac !== 0) {
      const size = sizeFormate(file.size_flac)
      types.push({ type: 'flac', size })
      byType.flac = { size }
    }
    if (file.size_hires !== 0) {
      const size = sizeFormate(file.size_hires)
      types.push({ type: 'flac24bit', size })
      byType.flac24bit = { size }
    }
    const albumId = item.album?.mid ?? ''
    const albumName = item.album?.name ?? ''
    list.push({
      singer: formatSingerName(item.singer, 'name'),
      name: item.title,
      albumName,
      albumId,
      source: 'tx',
      interval: item.interval ? formatPlayTime(item.interval) : null,
      songId: item.id,
      albumMid: albumId,
      strMediaMid: file.media_mid,
      songmid: item.mid,
      img:
        albumId === '' || albumId === '空'
          ? item.singer?.length
            ? `https://y.gtimg.cn/music/photo_new/T001R500x500M000${item.singer[0].mid}.jpg`
            : ''
          : `https://y.gtimg.cn/music/photo_new/T002R500x500M000${albumId}.jpg`,
      types,
      _types: byType,
      typeUrl: {},
    })
  }
  return list
}

async function musicSearch(keyword: string, page: number, limit: number, attempt = 0): Promise<any> {
  if (attempt > 5) throw new Error('QQ 音乐：搜索失败')
  const { body } = (await signRequest({
    comm: {
      _channelid: '0',
      _os_version: '6.2.9200-2',
      ct: '19',
      cv: '2151',
      guid: '1F70E520B2EAA7D25E11760783C53CA9',
      patch: '118',
      psrf_access_token_expiresAt: 0,
      psrf_qqaccess_token: '',
      psrf_qqopenid: '',
      psrf_qqunionid: '',
      tmeAppID: 'qqmusic',
      tmeLoginType: 0,
      uin: '0',
      wid: '7223299733393904640',
    },
    'music.search.SearchCgiService': {
      module: 'music.search.SearchCgiService',
      method: 'DoSearchForQQMusicDesktop',
      param: {
        grp: 1,
        num_per_page: limit,
        page_num: page,
        query: keyword,
        remoteplace: 'txt.newclient.top',
        search_type: 0,
        searchid: getSearchId(),
      },
    },
  })) as { body: any }
  const req = body?.['music.search.SearchCgiService'] ?? body?.req
  if (!req || body.code !== 0 || req.code !== 0) return musicSearch(keyword, page, limit, attempt + 1)
  return req.data
}

export async function search(
  keyword: string,
  page = 1,
  limit = 50,
  attempt = 0,
): Promise<PlatformSearchResult> {
  if (attempt >= 3) throw new Error('QQ 音乐：搜索重试次数过多')
  const data = await musicSearch(keyword, page, limit)
  const list = handleResult(data?.body?.song?.list ?? [])
  const total = data?.meta?.sum ?? 0
  return { list, total, allPage: Math.ceil(total / limit), limit, source: 'tx' }
}
