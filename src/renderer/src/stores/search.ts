import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type { AudioTrack, PlatformId, PlatformSearchOutcome, SearchOptions, SourceSearchOutcome } from '../../../shared/types'
import type { Lyrics } from '../../../shared/lyrics'
import { lyricsService, platformService, sourceService } from '../services/aurora'
import { usePlatformStore } from './platform'
import { useSourceStore } from './source'
import { useUiStore } from './ui'

const HISTORY_KEY = 'aurora:search-history'
const HISTORY_LIMIT = 30
const DEBOUNCE_MS = 360
/** How many of a platform's results get their lyrics fetched in lyric-search mode. */
const LYRIC_PROBE_LIMIT = 5
const LYRIC_PROBE_CONCURRENCY = 4

export interface TrendingKeyword {
  keyword: string
  label: string
  tag?: string
  origin: 'history' | 'directory'
}

/**
 * Fallback suggestions for the empty search box.
 *
 * These are plain *search terms* for the built-in platform search (genre / era vocabulary), not a
 * scraped chart and not a curated artist list. Real user searches are mixed in ahead of these once
 * the user has some history.
 */
const DIRECTORY_TRENDING: TrendingKeyword[] = [
  { keyword: '华语流行', label: '华语流行', origin: 'directory' },
  { keyword: '经典老歌', label: '经典老歌', origin: 'directory' },
  { keyword: '粤语', label: '粤语', origin: 'directory' },
  { keyword: '新歌', label: '新歌', origin: 'directory' },
  { keyword: '纯音乐', label: '纯音乐', origin: 'directory' },
  { keyword: '钢琴', label: '钢琴', origin: 'directory' },
  { keyword: '民谣', label: '民谣', origin: 'directory' },
  { keyword: '古风', label: '古风', origin: 'directory' },
]

export interface SearchHistoryEntry {
  keyword: string
  at: number
}

/**
 * Tabs are **platforms only**. The local library used to appear here; it now belongs to the local
 * page, which searches files directly and never waits on the network.
 */
export type SearchTabId = 'all' | PlatformId

export type SearchMode = 'songs' | 'lyrics'

export interface SearchBoard {
  id: string
  label: string
  /** Platforms are what the tabs switch between; a user source is an extra board under 全部. */
  kind: 'platform' | 'source'
  platformId?: PlatformId
  sourceId?: string
  tracks: AudioTrack[]
  error?: string
  latencyMs?: number
}

/** One lyric-search hit: the song plus the first lines of the lyric that was really fetched. */
export interface LyricHit {
  track: AudioTrack
  platformName: string
  preview: string
  synced: boolean
  lineCount: number
}

function readHistory(): SearchHistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (entry): entry is SearchHistoryEntry =>
          typeof entry === 'object' && entry !== null && typeof (entry as SearchHistoryEntry).keyword === 'string',
      )
      .slice(0, HISTORY_LIMIT)
  } catch {
    return []
  }
}

function lyricPreview(lyrics: Lyrics): string {
  const lines = lyrics.lines
    .map((line) => line.text.trim())
    .filter((text) => text.length > 0)
    .slice(0, 3)
  return lines.join(' / ')
}

export const useSearchStore = defineStore('search', () => {
  const platformStore = usePlatformStore()
  const sourceStore = useSourceStore()
  const ui = useUiStore()

  const query = ref('')
  const tab = ref<SearchTabId>('all')
  const mode = ref<SearchMode>('songs')
  const activeTag = ref('')
  const lastQuery = ref('')
  const outcomes = ref<PlatformSearchOutcome[]>([])
  /**
   * Results from user sources that declare `search`. They are searched only under 全部 — a platform
   * tab is a platform, and mixing a source's results into it would be the conflation the platform/
   * source split exists to prevent.
   */
  const sourceOutcomes = ref<SourceSearchOutcome[]>([])
  const lyricHits = ref<LyricHit[]>([])
  const lyricsLoading = ref(false)
  const loading = ref(false)
  const error = ref('')
  const history = ref<SearchHistoryEntry[]>([])

  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let requestToken = 0

  const tabs = computed(() => [
    { id: 'all' as SearchTabId, label: '全部' },
    ...platformStore.platforms.map((item) => ({ id: item.id as SearchTabId, label: platformStore.label(item.id) })),
  ])

  watch(
    () => platformStore.platforms.map((item) => item.id).join('|'),
    () => {
      if (tab.value === 'all') return
      if (!platformStore.platforms.some((item) => item.id === tab.value)) tab.value = 'all'
    },
  )

  const trending = computed<TrendingKeyword[]>(() => {
    const fromHistory: TrendingKeyword[] = history.value
      .slice(0, 4)
      .map((entry) => ({ keyword: entry.keyword, label: entry.keyword, origin: 'history' as const }))
    const seen = new Set(fromHistory.map((item) => item.keyword.toLowerCase()))
    const directory = DIRECTORY_TRENDING.filter((item) => !seen.has(item.keyword.toLowerCase()))
    return [...fromHistory, ...directory].slice(0, 10)
  })

  const boards = computed<SearchBoard[]>(() => {
    if (!lastQuery.value) return []
    const platformBoards = outcomes.value
      .filter((outcome) => (tab.value === 'all' ? true : outcome.platformId === tab.value))
      .map((outcome): SearchBoard => ({
        id: `platform:${outcome.platformId}`,
        // The registry's alias if the platform is still known, otherwise whatever the outcome said.
        label: platformStore.label(outcome.platformId) || outcome.platformName,
        kind: 'platform',
        platformId: outcome.platformId,
        tracks: outcome.tracks,
        error: outcome.ok ? undefined : (outcome.error?.message ?? '平台暂时不可用'),
        latencyMs: outcome.latencyMs,
      }))
    const sourceBoards =
      tab.value === 'all'
        ? sourceOutcomes.value.map((outcome): SearchBoard => ({
            id: `source:${outcome.sourceId}`,
            label: outcome.sourceName,
            kind: 'source',
            sourceId: outcome.sourceId,
            tracks: outcome.tracks,
            error: outcome.ok ? undefined : (outcome.error?.message ?? '音源暂时不可用'),
            latencyMs: outcome.latencyMs,
          }))
        : []
    return [...platformBoards, ...sourceBoards]
  })

  const resultCount = computed(() => boards.value.reduce((sum, board) => sum + board.tracks.length, 0))

  const failureCount = computed(() => boards.value.filter((board) => board.error).length)

  const statusSummary = computed(() => {
    if (!lastQuery.value) return ''
    const searched = outcomes.value.length
    const ok = searched - outcomes.value.filter((outcome) => !outcome.ok).length
    const parts: string[] = [`已搜索 ${searched} 个在线平台`, `${ok} 个返回结果`]
    if (sourceOutcomes.value.length > 0) parts.push(`${sourceOutcomes.value.length} 个音源参与聚合`)
    if (failureCount.value > 0) parts.push(`${failureCount.value} 个暂时不可用`)
    return parts.join(' · ')
  })

  function initHistory(): void {
    if (history.value.length === 0) history.value = readHistory()
  }

  function persistHistory(): void {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history.value))
    } catch {
      // A full quota must never break searching.
    }
  }

  function addHistory(keyword: string): void {
    const term = keyword.trim()
    if (!term) return
    history.value = [{ keyword: term, at: Date.now() }, ...history.value.filter((entry) => entry.keyword !== term)].slice(
      0,
      HISTORY_LIMIT,
    )
    persistHistory()
  }

  function removeHistory(keyword: string): void {
    history.value = history.value.filter((entry) => entry.keyword !== keyword)
    persistHistory()
  }

  function clearHistory(): void {
    history.value = []
    persistHistory()
    ui.notify('已清空搜索历史', 'info')
  }

  function cancelPending(): void {
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    // Invalidates any in-flight response so a stale search can never overwrite a newer one.
    requestToken += 1
  }

  function clearResults(): void {
    outcomes.value = []
    sourceOutcomes.value = []
    lyricHits.value = []
    lastQuery.value = ''
    error.value = ''
  }

  function searchOptions(): SearchOptions {
    return { pageSize: 40, ...(activeTag.value ? { tag: activeTag.value } : {}) }
  }

  async function searchPlatforms(term: string): Promise<PlatformSearchOutcome[]> {
    const options = searchOptions()
    return tab.value === 'all'
      ? platformService.searchAll(term, options)
      : [await platformService.searchOne(tab.value, term, options)]
  }

  /**
   * Searches the user's own sources. Only 全部 does this, and a failure stays inside its own board: a
   * source that is offline must never remove the platform results.
   */
  async function searchSources(term: string): Promise<SourceSearchOutcome[]> {
    if (tab.value !== 'all') return []
    if (sourceStore.searchable.length === 0) return []
    try {
      return await sourceService.searchAll(term, searchOptions())
    } catch {
      return []
    }
  }

  /** Lyrics for one track, whichever half of the online world it came from. */
  function lyricsFor(track: AudioTrack): Promise<Lyrics | null> {
    return track.platform ? platformService.lyrics(track) : lyricsService.get(track)
  }

  /**
   * Lyric search ("歌词搜索"): searches the platforms, then asks each result for its lyrics and keeps
   * only the ones that really have them. There is no lyric-only index available anywhere, so the
   * honest implementation is "find the song, then fetch the lyric" — and the preview shown in the UI
   * is the lyric that came back, not a search snippet.
   */
  async function runLyricSearch(term: string, token: number): Promise<void> {
    lyricsLoading.value = true
    try {
      const [boards, sources] = await Promise.all([searchPlatforms(term), searchSources(term)])
      if (token !== requestToken) return
      outcomes.value = boards
      sourceOutcomes.value = sources
      const candidates: Array<{ track: AudioTrack; platformName: string }> = []
      for (const board of boards) {
        if (!board.ok) continue
        for (const track of board.tracks.slice(0, LYRIC_PROBE_LIMIT)) {
          candidates.push({ track, platformName: platformStore.label(board.platformId) || board.platformName })
        }
      }
      for (const source of sources) {
        if (!source.ok) continue
        for (const track of source.tracks.slice(0, LYRIC_PROBE_LIMIT)) {
          candidates.push({ track, platformName: source.sourceName })
        }
      }
      const hits: LyricHit[] = []
      let cursor = 0
      const workers = Array.from({ length: Math.min(LYRIC_PROBE_CONCURRENCY, candidates.length) }, async () => {
        for (;;) {
          const index = cursor++
          const candidate = candidates[index]
          if (!candidate || token !== requestToken) return
          try {
            const lyrics = await lyricsFor(candidate.track)
            if (!lyrics || lyrics.lines.length === 0) continue
            hits[index] = {
              track: candidate.track,
              platformName: candidate.platformName,
              preview: lyricPreview(lyrics),
              synced: lyrics.synced,
              lineCount: lyrics.lines.length,
            }
          } catch {
            // A platform without lyric support is not an error worth surfacing per row.
          }
        }
      })
      await Promise.all(workers)
      if (token !== requestToken) return
      lyricHits.value = hits.filter((hit): hit is LyricHit => Boolean(hit))
    } finally {
      if (token === requestToken) lyricsLoading.value = false
    }
  }

  async function runNow(text?: string, tag?: string): Promise<void> {
    const term = (text ?? query.value).trim()
    if (tag !== undefined) activeTag.value = tag
    cancelPending()
    const token = ++requestToken

    if (!term) {
      clearResults()
      loading.value = false
      return
    }

    loading.value = true
    error.value = ''
    query.value = term
    lastQuery.value = term
    addHistory(term)

    try {
      if (mode.value === 'lyrics') {
        await runLyricSearch(term, token)
        if (token !== requestToken) return
        if (lyricHits.value.length === 0) ui.notify('这些平台没有返回匹配的歌词', 'info')
        return
      }
      const [results, sources] = await Promise.all([searchPlatforms(term), searchSources(term)])
      if (token !== requestToken) return
      outcomes.value = results
      sourceOutcomes.value = sources
      lyricHits.value = []
      if (resultCount.value === 0) ui.notify('没有找到相关音乐，可以换个关键词或平台', 'info')
    } catch (searchError) {
      if (token !== requestToken) return
      outcomes.value = []
      sourceOutcomes.value = []
      lyricHits.value = []
      error.value = searchError instanceof Error ? searchError.message : '搜索失败'
    } finally {
      if (token === requestToken) loading.value = false
    }
  }

  /** Debounced entry point for typing; `runNow` is used for Enter, tabs and history clicks. */
  function schedule(text?: string): void {
    if (text !== undefined) query.value = text
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      void runNow()
    }, DEBOUNCE_MS)
  }

  function setTab(id: SearchTabId): void {
    if (tab.value === id) return
    tab.value = id
    if (lastQuery.value) void runNow(lastQuery.value)
  }

  function setMode(next: SearchMode): void {
    if (mode.value === next) return
    mode.value = next
    if (lastQuery.value) void runNow(lastQuery.value)
  }

  function searchKeyword(keyword: string): void {
    query.value = keyword
    const trendingHit = trending.value.find((item) => item.keyword === keyword)
    void runNow(keyword, trendingHit?.tag ?? '')
  }

  function resetQuery(): void {
    cancelPending()
    query.value = ''
    clearResults()
  }

  return {
    query,
    tab,
    mode,
    activeTag,
    lastQuery,
    outcomes,
    sourceOutcomes,
    lyricHits,
    lyricsLoading,
    loading,
    error,
    history,
    tabs,
    trending,
    boards,
    resultCount,
    failureCount,
    statusSummary,
    initHistory,
    addHistory,
    removeHistory,
    clearHistory,
    schedule,
    runNow,
    setTab,
    setMode,
    searchKeyword,
    resetQuery,
    cancelPending,
  }
})
