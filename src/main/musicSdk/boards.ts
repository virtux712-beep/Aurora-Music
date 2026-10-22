import { decodeName, formatPlayTime, sizeFormate } from './helpers'
import { httpFetch } from './http'
import type { RawSong } from './types'

/**
 * Platform leaderboards ("全网聚合热榜").
 *
 * Only platforms whose *public* board endpoints answer are listed here. That is a statement about
 * which endpoints exist, not a policy: a platform without a board entry simply contributes no charts
 * to the UI, and the UI renders whatever this list contains instead of hardcoding the five names.
 *
 * The four implementations below are Aurora's own ports of `lx-music-desktop`'s
 * `musicSdk/<platform>/leaderboard.js`. Two deliberate differences from LX:
 *
 *  - LX reads Netease's board detail through its `weapi` signer. The older, still-serving
 *    `music.163.com/api/playlist/detail` returns the same playlist without any signing, so that is
 *    what is used here — fewer moving parts and no secret material in the request path.
 *  - Kuwo's board detail has moved to a signed `wbd.kuwo.cn` API in LX. The legacy
 *    `kbangserver.kuwo.cn/ksong.s` endpoint still serves the same charts, so it is used instead;
 *    qualities are derived from the per-song `formats` list that endpoint returns.
 *
 * Migu is intentionally absent: its board endpoint does not answer, and inventing one would make the
 * feature lie about what it can show.
 */

export interface BoardEntry {
  platformId: string
  boardId: string
  name: string
}

/** A curated set of real charts per platform — the ones a listener actually opens. */
const BOARDS: Record<string, BoardEntry[]> = {
  wy: [
    { boardId: '19723756', name: '飙升榜' },
    { boardId: '3778678', name: '热歌榜' },
    { boardId: '3779629', name: '新歌榜' },
    { boardId: '2884035', name: '原创榜' },
    { boardId: '1978921795', name: '电音榜' },
    { boardId: '991319590', name: '说唱榜' },
    { boardId: '71384707', name: '古典榜' },
    { boardId: '2809513713', name: '欧美热歌榜' },
    { boardId: '745956260', name: '韩语榜' },
    { boardId: '71385702', name: 'ACG榜' },
  ].map((board) => ({ platformId: 'wy', ...board })),
  tx: [
    { boardId: '26', name: '热歌榜' },
    { boardId: '27', name: '新歌榜' },
    { boardId: '62', name: '飙升榜' },
    { boardId: '4', name: '流行指数榜' },
    { boardId: '28', name: '网络歌曲榜' },
    { boardId: '5', name: '内地榜' },
    { boardId: '3', name: '欧美榜' },
    { boardId: '59', name: '香港地区榜' },
    { boardId: '61', name: '台湾地区榜' },
    { boardId: '60', name: '抖快榜' },
  ].map((board) => ({ platformId: 'tx', ...board })),
  kg: [
    { boardId: '6666', name: '飙升榜' },
    { boardId: '8888', name: 'TOP500' },
    { boardId: '52144', name: '抖音热歌榜' },
    { boardId: '31308', name: '内地榜' },
    { boardId: '33160', name: '电音榜' },
    { boardId: '33161', name: '古风新歌榜' },
    { boardId: '33165', name: '粤语金曲榜' },
    { boardId: '33166', name: '欧美金曲榜' },
    { boardId: '33163', name: '影视金曲榜' },
    { boardId: '51340', name: '伤感榜' },
  ].map((board) => ({ platformId: 'kg', ...board })),
  kw: [
    { boardId: '93', name: '飙升榜' },
    { boardId: '16', name: '热歌榜' },
    { boardId: '17', name: '新歌榜' },
    { boardId: '158', name: '抖音热歌榜' },
    { boardId: '284', name: '热评榜' },
    { boardId: '104', name: '华语榜' },
    { boardId: '182', name: '粤语榜' },
    { boardId: '22', name: '欧美榜' },
    { boardId: '184', name: '韩语榜' },
    { boardId: '183', name: '日语榜' },
  ].map((board) => ({ platformId: 'kw', ...board })),
}

/** Platforms that actually have charts, in a stable order. */
export function listBoards(): BoardEntry[] {
  return Object.values(BOARDS).flat()
}

export function hasBoards(platformId: string): boolean {
  return (BOARDS[platformId]?.length ?? 0) > 0
}

type Json = any

/* ------------------------------------------------------------------ 网易云 */

/**
 * Netease's legacy playlist endpoint. Each track carries one object per quality tier
 * (`lMusic`/`mMusic`/`hMusic`/`sqMusic`/`hrMusic`), so the available qualities are read off the tiers
 * that are present rather than from a capability flag.
 */
function mapWyTrack(track: Json): RawSong {
  const types: RawSong['types'] = []
  const byType: RawSong['_types'] = {}

  const push = (type: string, music: Json): void => {
    if (!music || typeof music.size !== 'number' || music.size === 0) return
    const size = sizeFormate(music.size)
    types.push({ type, size })
    byType[type] = { size }
  }
  push('128k', track.lMusic)
  push('320k', track.hMusic)
  push('flac', track.sqMusic)
  push('flac24bit', track.hrMusic)
  types.reverse()

  return {
    singer: (track.artists ?? []).map((artist: Json) => artist.name).join('、') || '未知艺术家',
    name: track.name,
    albumName: track.album?.name ?? '',
    albumId: track.album?.id,
    source: 'wy',
    interval: formatPlayTime(Math.round((track.duration ?? 0) / 1000)),
    songmid: track.id,
    img: track.album?.picUrl ?? null,
    lrc: null,
    types,
    _types: byType,
    typeUrl: {},
  }
}

async function fetchWy(boardId: string, limit: number): Promise<RawSong[]> {
  const { body } = (await httpFetch(`https://music.163.com/api/playlist/detail?id=${encodeURIComponent(boardId)}`, {
    headers: { Referer: 'https://music.163.com/', 'User-Agent': 'Mozilla/5.0' },
  }).promise) as { body: Json }
  const tracks: Json[] = body?.result?.tracks ?? []
  if (!Array.isArray(tracks) || tracks.length === 0) throw new Error('网易云音乐：该榜单没有返回歌曲')
  return tracks.slice(0, limit).map(mapWyTrack)
}

/* ------------------------------------------------------------------ QQ 音乐 */

function mapTxSong(song: Json): RawSong {
  const types: RawSong['types'] = []
  const byType: RawSong['_types'] = {}
  const push = (type: string, value: unknown): void => {
    const size = Number(value)
    if (!Number.isFinite(size) || size <= 0) return
    const formatted = sizeFormate(size)
    types.push({ type, size: formatted })
    byType[type] = { size: formatted }
  }
  push('128k', song.size128)
  push('320k', song.size320)
  push('flac', song.sizeflac)
  push('flac24bit', song.sizehires)

  const albumMid = song.albummid ?? ''
  const artistMid = song.singer?.[0]?.mid ?? ''
  const cover = albumMid
    ? `https://y.gtimg.cn/music/photo_new/T002R500x500M000${albumMid}.jpg`
    : artistMid
      ? `https://y.gtimg.cn/music/photo_new/T001R500x500M000${artistMid}.jpg`
      : null

  return {
    singer: (song.singer ?? []).map((artist: Json) => artist.name).join('、') || '未知艺术家',
    name: song.songname,
    albumName: song.albumname ?? '',
    albumId: albumMid,
    source: 'tx',
    interval: formatPlayTime(Number(song.interval) || 0),
    songmid: song.songmid,
    // The board endpoint reports the numeric song id, which is what a source reads as `meta.id`.
    songId: song.songid,
    albumMid,
    strMediaMid: song.strMediaMid,
    img: cover,
    lrc: null,
    types,
    _types: byType,
    typeUrl: {},
  }
}

async function fetchTx(boardId: string, limit: number): Promise<RawSong[]> {
  const url =
    'https://c.y.qq.com/v8/fcg-bin/fcg_v8_toplist_cp.fcg' +
    `?topid=${encodeURIComponent(boardId)}&format=json&inCharset=utf8&outCharset=utf-8&notice=0` +
    `&platform=h5&needNewCode=1&tpl=3&page=detail&type=top&song_begin=0&song_num=${limit}`
  const { body } = (await httpFetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }).promise) as { body: Json }
  const list: Json[] = body?.songlist ?? []
  if (!Array.isArray(list) || list.length === 0) throw new Error('QQ音乐：该榜单没有返回歌曲')
  return list.map((entry) => mapTxSong(entry.data ?? entry)).filter((song) => Boolean(song.songmid))
}

/* ------------------------------------------------------------------ 酷狗 */

function mapKgSong(song: Json): RawSong {
  const types: RawSong['types'] = []
  const byType: RawSong['_types'] = {}
  const push = (type: string, size: unknown, hash: unknown): void => {
    const bytes = Number(size)
    if (!Number.isFinite(bytes) || bytes <= 0) return
    const formatted = sizeFormate(bytes)
    types.push({ type, size: formatted, ...(typeof hash === 'string' ? { hash } : {}) })
    byType[type] = { size: formatted, ...(typeof hash === 'string' ? { hash } : {}) }
  }
  push('128k', song.filesize, song.hash)
  push('320k', song['320filesize'], song['320hash'])
  push('flac', song.sqfilesize, song.sqhash)
  push('flac24bit', song.filesize_high, song.hash_high)

  return {
    singer: (song.authors ?? []).map((author: Json) => author.author_name).join('、') || '未知艺术家',
    name: decodeName(song.songname),
    albumName: decodeName(song.remark),
    albumId: song.album_id,
    source: 'kg',
    interval: formatPlayTime(Number(song.duration) || 0),
    songmid: song.audio_id,
    hash: song.hash,
    albumAudioId: String(song.album_audio_id ?? ''),
    img: null,
    lrc: null,
    types,
    _types: byType,
    typeUrl: {},
  }
}

async function fetchKg(boardId: string, limit: number): Promise<RawSong[]> {
  const url =
    'http://mobilecdnbj.kugou.com/api/v3/rank/song' +
    `?version=9108&plat=0&pagesize=${limit}&area_code=1&page=1&rankid=${encodeURIComponent(boardId)}&with_res_tag=0`
  const { body } = (await httpFetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }).promise) as { body: Json }
  const list: Json[] = body?.data?.info ?? []
  if (!Array.isArray(list) || list.length === 0) throw new Error('酷狗音乐：该榜单没有返回歌曲')
  return list.map(mapKgSong)
}

/* ------------------------------------------------------------------ 酷我 */

/** Kuwo's `formats` string is a `|`-separated token list; these tokens mean the four tiers. */
const KW_FORMAT_TIERS: Array<{ token: string; type: string }> = [
  { token: 'MP3128', type: '128k' },
  { token: 'MP3H', type: '320k' },
  { token: 'ALFLAC', type: 'flac' },
  { token: 'FLAC', type: 'flac' },
]

const KW_TIER_ORDER = ['128k', '320k', 'flac', 'flac24bit']

function mapKwSong(song: Json): RawSong {
  const tokens = String(song.formats ?? '').split('|')
  const types: RawSong['types'] = []
  const byType: RawSong['_types'] = {}
  for (const tier of KW_FORMAT_TIERS) {
    if (!tokens.includes(tier.token) || byType[tier.type]) continue
    // This board endpoint lists *which* tiers exist but not their byte sizes, so the size stays
    // null rather than being invented — the badge only needs the tier, and a made-up size would be
    // shown to the user as if it were measured.
    types.push({ type: tier.type, size: null })
    byType[tier.type] = { size: null }
  }
  types.sort((a, b) => KW_TIER_ORDER.indexOf(a.type) - KW_TIER_ORDER.indexOf(b.type))

  const duration = Number(song.song_duration ?? song.duration) || 0
  return {
    singer: decodeName(String(song.artist ?? '')).replace(/&/g, '、') || '未知艺术家',
    name: decodeName(song.name),
    albumName: decodeName(song.album),
    albumId: song.albumid,
    source: 'kw',
    interval: formatPlayTime(duration),
    songmid: song.id,
    img: song.pic ?? null,
    lrc: null,
    types,
    _types: byType,
    typeUrl: {},
  }
}

async function fetchKw(boardId: string, limit: number): Promise<RawSong[]> {
  const url =
    'http://kbangserver.kuwo.cn/ksong.s' +
    `?from=pc&fmt=json&pn=0&rn=${limit}&type=bang&data=content&id=${encodeURIComponent(boardId)}`
  const { body } = (await httpFetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }).promise) as { body: Json }
  const list: Json[] = body?.musiclist ?? []
  if (!Array.isArray(list) || list.length === 0) throw new Error('酷我音乐：该榜单没有返回歌曲')
  return list.map(mapKwSong)
}

/* ------------------------------------------------------------------ entry point */

const FETCHERS: Record<string, (boardId: string, limit: number) => Promise<RawSong[]>> = {
  wy: fetchWy,
  tx: fetchTx,
  kg: fetchKg,
  kw: fetchKw,
}

/**
 * Reads one chart.
 *
 * Deliberately one attempt with no retry loop: a chart that fails is reported to the UI as that
 * platform's failure, and the other platforms' charts are unaffected.
 */
export async function fetchBoardSongs(platformId: string, boardId: string, limit = 50): Promise<RawSong[]> {
  const fetcher = FETCHERS[platformId]
  if (!fetcher) throw new Error(`暂无该平台的榜单：${platformId}`)
  const known = BOARDS[platformId]?.some((board) => board.boardId === boardId)
  if (!known) throw new Error(`未知榜单：${platformId}/${boardId}`)
  return fetcher(boardId, Math.min(Math.max(limit, 1), 100))
}
