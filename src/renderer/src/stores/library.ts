import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  AudioTrack,
  ConvertFormat,
  ConvertResult,
  FfmpegStatus,
  ImportProgress,
  ScrapeProgress,
  ScrapeReport,
  TagWriteResult,
} from '../../../shared/types'
import { libraryService } from '../services/aurora'
import { isHiRes, isLossless } from '../utils/audio'
import { matchesInitials } from '../utils/pinyin'

const ONLINE_SNAPSHOTS_KEY = 'aurora:online-tracks'
const ONLINE_SNAPSHOT_LIMIT = 400

export const useLibraryStore = defineStore('library', () => {
  const tracks = ref<AudioTrack[]>([])
  /**
   * Online tracks are not part of the local library, but favourites and history still need
   * enough metadata to render them. Snapshots are small and capped.
   */
  const onlineSnapshots = ref<Record<string, AudioTrack>>({})
  const missingIds = ref<string[]>([])
  const loading = ref(false)
  const importing = ref(false)
  const progress = ref<ImportProgress>({ scanning: false, processed: 0, total: 0 })
  const lastError = ref('')

  const trackMap = computed(() => {
    const map = new Map(tracks.value.map((track) => [track.id, track] as const))
    for (const [id, track] of Object.entries(onlineSnapshots.value)) map.set(id, track)
    return map
  })
  const missingSet = computed(() => new Set(missingIds.value))
  const totalDuration = computed(() => tracks.value.reduce((sum, track) => sum + (track.duration || 0), 0))

  function resolve(id: string): AudioTrack | undefined {
    return trackMap.value.get(id)
  }

  function search(keyword: string): AudioTrack[] {
    const needle = keyword.trim().toLowerCase()
    if (!needle) return tracks.value
    return tracks.value.filter((track) =>
      track.title.toLowerCase().includes(needle) ||
      track.artist.toLowerCase().includes(needle) ||
      track.album.toLowerCase().includes(needle),
    )
  }

  /**
   * The local page's search: everything a person can recognise a file by — ID3 fields, the file name
   * on disk, and pinyin initials (`zjl` for 「周杰伦」). Deliberately local-only: this never touches
   * the network, so typing stays instant and offline searching still works.
   */
  function filterLocal(keyword: string): AudioTrack[] {
    const needle = keyword.trim().toLowerCase()
    if (!needle) return tracks.value

    const fileName = (track: AudioTrack): string => {
      if (!track.filePath) return ''
      const parts = track.filePath.split(/[\\/]/)
      return parts[parts.length - 1] ?? ''
    }

    return tracks.value.filter((track) => {
      const name = fileName(track)
      if (
        track.title.toLowerCase().includes(needle) ||
        track.artist.toLowerCase().includes(needle) ||
        track.album.toLowerCase().includes(needle) ||
        name.toLowerCase().includes(needle)
      ) {
        return true
      }
      // Initials are only consulted for ASCII queries so ordinary Chinese input keeps working.
      return matchesInitials([track.title, track.artist, track.album, name], needle)
    })
  }

  function recentlyAdded(limit = 8): AudioTrack[] {
    return [...tracks.value].sort((a, b) => b.addedAt - a.addedAt).slice(0, limit)
  }

  function byIds(ids: string[]): AudioTrack[] {
    const map = trackMap.value
    return ids.map((id) => map.get(id)).filter((track): track is AudioTrack => track !== undefined)
  }

  function loadSnapshots(): void {
    try {
      const raw = localStorage.getItem(ONLINE_SNAPSHOTS_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as unknown
      if (parsed && typeof parsed === 'object') onlineSnapshots.value = parsed as Record<string, AudioTrack>
    } catch {
      onlineSnapshots.value = {}
    }
  }

  /** Keeps metadata for online tracks so favourites/history can still resolve them. */
  /**
   * Snapshots stay small enough for localStorage: a bulky `metadata` blob (which a script source may
   * put on a track) is dropped instead of risking a quota failure. Such a track then needs a fresh
   * search before it can be replayed — a deliberate trade for never breaking the library write.
   */
  function snapshotOf(track: AudioTrack): AudioTrack {
    if (!track.metadata) return track
    try {
      if (JSON.stringify(track.metadata).length <= 1024) return track
    } catch {
      // fall through to the stripped copy
    }
    const { metadata, ...rest } = track
    void metadata
    return rest
  }

  function rememberOnline(incoming: AudioTrack[]): void {
    const next = { ...onlineSnapshots.value }
    for (const track of incoming) {
      if (track.origin !== 'online') continue
      next[track.id] = snapshotOf(track)
    }
    const entries = Object.entries(next)
    if (entries.length > ONLINE_SNAPSHOT_LIMIT) {
      entries.sort((a, b) => (b[1].addedAt ?? 0) - (a[1].addedAt ?? 0))
      onlineSnapshots.value = Object.fromEntries(entries.slice(0, ONLINE_SNAPSHOT_LIMIT))
    } else {
      onlineSnapshots.value = next
    }
    try {
      localStorage.setItem(ONLINE_SNAPSHOTS_KEY, JSON.stringify(onlineSnapshots.value))
    } catch {
      // Quota problems must never break playback.
    }
  }

  async function load(): Promise<void> {
    loadSnapshots()
    loading.value = true
    try {
      const [list, missing] = await Promise.all([libraryService.list(), libraryService.missing()])
      tracks.value = list
      missingIds.value = missing
    } catch {
      lastError.value = '读取本地音乐库失败'
    } finally {
      loading.value = false
    }
  }

  async function importFiles(): Promise<{ added: number; duplicated: number; failed: number }> {
    importing.value = true
    try {
      const result = await libraryService.addFiles()
      mergeAdded(result.added)
      return { added: result.added.length, duplicated: result.duplicated, failed: result.failed }
    } catch {
      lastError.value = '导入文件时出错'
      return { added: 0, duplicated: 0, failed: 0 }
    } finally {
      importing.value = false
      progress.value = { scanning: false, processed: 0, total: 0 }
    }
  }

  /**
   * Imports explicit paths (what a drag-and-drop resolved to).
   *
   * Same pass as the two dialog entries, so a dropped file and a picked file cannot end up differing in
   * metadata, dedupe or artwork caching. `unsupported` rides along because ``"nothing was imported"`` has
   * three different meanings and the caller has to be able to tell them apart.
   */
  async function importPaths(paths: string[]): Promise<{ added: number; duplicated: number; failed: number; unsupported: number }> {
    if (paths.length === 0) return { added: 0, duplicated: 0, failed: 0, unsupported: 0 }
    importing.value = true
    try {
      const result = await libraryService.addPaths(paths)
      mergeAdded(result.added)
      return {
        added: result.added.length,
        duplicated: result.duplicated,
        failed: result.failed,
        unsupported: result.unsupported ?? 0,
      }
    } catch {
      lastError.value = '导入拖入的文件时出错'
      return { added: 0, duplicated: 0, failed: 0, unsupported: 0 }
    } finally {
      importing.value = false
      progress.value = { scanning: false, processed: 0, total: 0 }
    }
  }

  async function importFolder(): Promise<{ added: number; duplicated: number; failed: number }> {
    importing.value = true
    try {
      const result = await libraryService.addFolder()
      mergeAdded(result.added)
      return { added: result.added.length, duplicated: result.duplicated, failed: result.failed }
    } catch {
      lastError.value = '扫描文件夹时出错'
      return { added: 0, duplicated: 0, failed: 0 }
    } finally {
      importing.value = false
      progress.value = { scanning: false, processed: 0, total: 0 }
    }
  }

  function mergeAdded(added: AudioTrack[]): void {
    if (added.length === 0) return
    const known = new Set(tracks.value.map((track) => track.id))
    tracks.value = [...tracks.value, ...added.filter((track) => !known.has(track.id))]
  }

  async function remove(id: string): Promise<boolean> {
    const removed = await libraryService.remove(id)
    if (removed) tracks.value = tracks.value.filter((track) => track.id !== id)
    return removed
  }

  async function reveal(id: string): Promise<boolean> {
    return libraryService.reveal(id)
  }

  function clearLocalState(): void {
    tracks.value = []
    missingIds.value = []
  }

  let unsubscribe: (() => void) | null = null
  let libraryChangeUnsubscribe: (() => void) | null = null
  let scrapeProgressUnsubscribe: (() => void) | null = null

  function startProgressListener(): void {
    unsubscribe?.()
    unsubscribe = libraryService.onImportProgress((next) => {
      progress.value = next
    })
  }

  /* ------------------------------------------------------- local file administration */

  const scraping = ref(false)
  const scrapeProgress = ref<ScrapeProgress | null>(null)
  const ffmpeg = ref<FfmpegStatus>({ available: false, source: 'none' })

  /** Lossless share of the library, as a percentage; `null` when the library is empty. */
  const losslessRatio = computed<number | null>(() => {
    if (tracks.value.length === 0) return null
    return Math.round((tracks.value.filter(isLossless).length / tracks.value.length) * 100)
  })

  const losslessTracks = computed(() => tracks.value.filter(isLossless))
  const hiResTracks = computed(() => tracks.value.filter(isHiRes))

  /**
   * Automatic metadata completion. Returns the real report; `null` means the pass could not run at
   * all (e.g. no bridge), which the caller must not present as "nothing to fill".
   */
  async function scrape(ids?: string[], options: { cover?: boolean; lyrics?: boolean } = {}): Promise<ScrapeReport | null> {
    if (scraping.value) return null
    scraping.value = true
    scrapeProgress.value = { processed: 0, total: ids?.length ?? tracks.value.length, matched: 0 }
    try {
      const report = await libraryService.scrape({
        ...(ids && ids.length > 0 ? { ids } : {}),
        cover: options.cover !== false,
        lyrics: options.lyrics !== false,
      })
      await load()
      return report
    } finally {
      scraping.value = false
      scrapeProgress.value = null
    }
  }

  async function writeTags(patch: { id: string; title?: string; artist?: string; album?: string }): Promise<TagWriteResult> {
    const result = await libraryService.setTags(patch)
    if (result.ok && result.track) {
      tracks.value = tracks.value.map((track) => (track.id === result.track?.id ? (result.track as AudioTrack) : track))
    }
    return result
  }

  async function convert(id: string, format: ConvertFormat): Promise<ConvertResult> {
    const result = await libraryService.convert(id, format)
    if (result.ok) await load()
    return result
  }

  async function refreshFfmpeg(force = false): Promise<FfmpegStatus> {
    ffmpeg.value = await libraryService.ffmpegStatus(force)
    return ffmpeg.value
  }

  /**
   * Keeps the local page in step with changes the main process made on its own: a finished download
   * being imported, a metadata pass filling fields, or a conversion adding a file.
   */
  function startLibraryChangeListener(): void {
    libraryChangeUnsubscribe?.()
    libraryChangeUnsubscribe = libraryService.onChanged((next) => {
      tracks.value = next
      missingIds.value = []
    })
  }

  function startScrapeProgressListener(): void {
    scrapeProgressUnsubscribe?.()
    scrapeProgressUnsubscribe = libraryService.onScrapeProgress((next) => {
      scrapeProgress.value = next
    })
  }

  return {
    tracks,
    missingIds,
    loading,
    importing,
    progress,
    lastError,
    trackMap,
    missingSet,
    totalDuration,
    load,
    resolve,
    search,
    filterLocal,
    recentlyAdded,
    byIds,
    importFiles,
    importFolder,
    importPaths,
    remove,
    reveal,
    clearLocalState,
    startProgressListener,
    onlineSnapshots,
    rememberOnline,
    scraping,
    scrapeProgress,
    ffmpeg,
    losslessRatio,
    losslessTracks,
    hiResTracks,
    scrape,
    writeTags,
    convert,
    refreshFfmpeg,
    startLibraryChangeListener,
    startScrapeProgressListener,
  }
})
