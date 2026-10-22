import { createCipheriv, createHash } from 'node:crypto'
import { formatPlayTime, sizeFormate } from '../helpers'
import { httpFetch } from '../http'
import type { PlatformSearchResult, RawSong } from '../types'

/**
 * 网易云音乐 search.
 *
 * Port of `lx-music-desktop/src/renderer/utils/musicSdk/wy/musicSearch.js` plus the `eapi` signing
 * from `wy/utils/crypto.js`. Netease's batch endpoint expects one AES-ECB encrypted hex `params`
 * field whose plaintext is `path-36cd479b6b5-json-36cd479b6b5-md5`.
 */

const EAPI_KEY = 'e82ckenh8dichen8'
const EAPI_URL = 'http://interface.music.163.com/eapi/batch'
const EAPI_SIGNATURE_SEPARATOR = '36cd479b6b5'

function aesEncryptHex(plain: Buffer): string {
  const cipher = createCipheriv('aes-128-ecb', Buffer.from(EAPI_KEY), null)
  return Buffer.concat([cipher.update(plain), cipher.final()]).toString('hex').toUpperCase()
}

function eapi(path: string, payload: unknown): { params: string } {
  const text = typeof payload === 'object' ? JSON.stringify(payload) : String(payload)
  const digest = createHash('md5').update(`nobody${path}use${text}md5forencrypt`).digest('hex')
  const data = `${path}-${EAPI_SIGNATURE_SEPARATOR}-${text}-${EAPI_SIGNATURE_SEPARATOR}-${digest}`
  return { params: aesEncryptHex(Buffer.from(data)) }
}

function eapiRequest(path: string, payload: unknown) {
  return httpFetch(EAPI_URL, {
    method: 'post',
    headers: {
      'User-Agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.90 Safari/537.36',
      origin: 'https://music.163.com',
    },
    form: eapi(path, payload) as unknown as Record<string, string>,
  })
}

function getSinger(singers: any[]): string {
  return singers.map((singer) => singer.name).join('、')
}

function handleResult(rawList: any[]): RawSong[] {
  return rawList.map((entry) => {
    const item = entry.baseInfo.simpleSongData
    const types: RawSong['types'] = []
    const byType: RawSong['_types'] = {}
    let size: string | null

    if (item.privilege.maxBrLevel === 'hires') {
      size = item.hr ? sizeFormate(item.hr.size) : null
      types.push({ type: 'flac24bit', size })
      byType.flac24bit = { size }
    }
    // Fallthrough is LX's: a `320000` server also serves 128k, so each case intentionally adds to the
    // list rather than replacing it.
    switch (item.privilege.maxbr) {
      case 999000:
        size = item.sq ? sizeFormate(item.sq.size) : null
        types.push({ type: 'flac', size })
        byType.flac = { size }
      // falls through
      case 320000:
        size = item.h ? sizeFormate(item.h.size) : null
        types.push({ type: '320k', size })
        byType['320k'] = { size }
      // falls through
      case 192000:
      case 128000:
        size = item.l ? sizeFormate(item.l.size) : null
        types.push({ type: '128k', size })
        byType['128k'] = { size }
    }
    types.reverse()

    return {
      singer: getSinger(item.ar ?? []),
      name: item.name,
      albumName: item.al?.name ?? '',
      albumId: item.al?.id,
      source: 'wy',
      interval: formatPlayTime(item.dt / 1000),
      songmid: item.id,
      img: item.al?.picUrl ?? null,
      lrc: null,
      types,
      _types: byType,
      typeUrl: {},
    } satisfies RawSong
  })
}

export async function search(
  keyword: string,
  page = 1,
  limit = 30,
  attempt = 0,
): Promise<PlatformSearchResult> {
  if (attempt >= 3) throw new Error('网易云音乐：搜索重试次数过多')
  const { body } = (await eapiRequest('/api/search/song/list/page', {
    keyword,
    needCorrect: '1',
    channel: 'typing',
    offset: limit * (page - 1),
    scene: 'normal',
    total: page === 1,
    limit,
  }).promise) as { body: any }
  if (!body || body.code !== 200) return search(keyword, page, limit, attempt + 1)
  const list = handleResult(body.data?.resources ?? [])
  const total = body.data?.totalCount ?? 0
  return { list, total, allPage: Math.ceil(total / limit), limit, source: 'wy' }
}
