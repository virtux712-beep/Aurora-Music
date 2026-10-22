/** One quality a platform can serve, in the shape LX's `MusicQualityType` uses. */
export interface RawQuality {
  type: string
  size: string | null
  /** Only Kugou carries a per-quality hash. */
  hash?: string
}

/**
 * A song exactly as a platform's search returns it, before it becomes `MusicInfo`.
 *
 * The field names are LX's (`songmid`, `albumName`, `_types`, …) on purpose: this object is what the
 * per-platform formatting code produces, and the LX sources a user installs were written against the
 * `MusicInfo` derived from it.
 */
export interface RawSong {
  name: string
  singer: string
  source: string
  songmid: string | number
  albumName?: string
  albumId?: string | number
  interval?: string | null
  img?: string | null
  copyrightId?: string
  lrcUrl?: string
  mrcUrl?: string
  trcUrl?: string
  hash?: string
  albumAudioId?: string
  strMediaMid?: string
  songId?: string | number
  albumMid?: string
  types: RawQuality[]
  _types: Record<string, { size: string | null; hash?: string }>
  typeUrl: Record<string, string>
  [key: string]: unknown
}

export interface PlatformSearchResult {
  list: RawSong[]
  total: number
  allPage: number
  limit: number
  source: string
}

/**
 * The `MusicInfo` the LX compatibility layer hands to a user source.
 *
 * This is the *only* object an LX source understands, so everything Aurora sends through
 * `action: 'musicUrl'` / `'lyric'` / `'pic'` must have this shape — not Aurora's own track model.
 */
export interface LxMusicInfo {
  id: string
  name: string
  singer: string
  source: string
  interval: string | null
  meta: Record<string, unknown> & {
    songId: string | number
    albumName: string
    qualitys: RawQuality[]
    _qualitys: Record<string, { size: string | null; hash?: string }>
  }
}
