import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  LYRICS_OFFSET_STEP_MS,
  clampLyricsOffset,
  findActiveLine,
  findActiveWord,
  hasRomanisation,
  hasWordTimings,
  lyricsAreEmpty,
  lyricSyncTime,
  type Lyrics,
  type LyricsResolution,
} from '../../../shared/lyrics'
import type { AudioTrack } from '../../../shared/types'
import { lyricsService, settingsService } from '../services/aurora'
import { usePlayerStore } from './player'

/**
 * Lyrics state.
 *
 * The critical rule: this store never keeps its own clock. `activeIndex` is derived from
 * `player.currentTime`, so seeking, pausing, track changes and repeat all stay in sync for free.
 *
 * `report` is the honest half of the lyrics engine: when 「联网自动匹配」 comes back empty, the page can
 * say *which* catalogues were asked instead of a bare "no lyrics". It is only ever filled from a real
 * resolution returned by the main process — never synthesised here.
 */
export const useLyricsStore = defineStore('lyrics', () => {
  const player = usePlayerStore()

  const lyrics = ref<Lyrics | null>(null)
  const loading = ref(false)
  const error = ref('')
  const trackId = ref('')
  const importing = ref(false)
  const report = ref<LyricsResolution | null>(null)
  /**
   * A user-initiated forced match is running.
   *
   * Kept apart from `loading` because the two have opposite UI needs: the fast load is over in
   * milliseconds (nothing should flash), while a forced match may search several catalogues and the
   * user needs to keep seeing the panel — with the buttons disabled and a hint — instead of a blank
   * one.
   */
  const matching = ref(false)

  /**
   * The listener's lyric correction in milliseconds (negative = lyrics earlier).
   *
   * The one thing this store is allowed to add to the clock: lyrics are read at `currentTime + offset`, while
   * every other consumer (progress bar, statistics, desktop strip) keeps reading the real position. The LRC
   * files on disk are never rewritten — a correction is an opinion about playback, not an edit of the song's
   * timing data.
   */
  const offsetMs = ref(0)
  /** The playback position the lyrics are read at. Derived, so seeking and offset changes are the same act. */
  const syncTime = computed(() => lyricSyncTime(player.currentTime, offsetMs.value))

  const activeIndex = computed(() =>
    lyrics.value?.synced ? findActiveLine(lyrics.value.lines, syncTime.value) : -1,
  )
  const activeLine = computed(() => (activeIndex.value >= 0 ? (lyrics.value?.lines[activeIndex.value] ?? null) : null))
  const activeWordIndex = computed(() => findActiveWord(activeLine.value, syncTime.value))
  const wordTimings = computed(() => hasWordTimings(lyrics.value))
  const romanised = computed(() => hasRomanisation(lyrics.value))
  const available = computed(() => !lyricsAreEmpty(lyrics.value))
  const synced = computed(() => lyrics.value?.synced === true)

  const originLabel = computed(() => {
    switch (lyrics.value?.origin) {
      case 'user':
        return '你导入的歌词'
      case 'sidecar':
        return '.lrc 歌词文件'
      case 'cache':
        return '本机歌词缓存'
      case 'embedded':
        return '音频内嵌歌词'
      case 'source':
        return '音源提供的歌词'
      case 'lrclib':
        return 'LRCLIB 公开歌词库'
      case 'china':
        return '国内歌词接口'
      default:
        return ''
    }
  })

  /** What was tried, for the empty state: "LRCLIB 公开歌词库、国内歌词接口 均无结果". */
  const triedLabels = computed(() =>
    (report.value?.attempts ?? [])
      .filter((attempt) => attempt.result === 'hit' || attempt.result === 'miss' || attempt.result === 'error')
      .map((attempt) => attempt.label),
  )

  function adopt(resolution: LyricsResolution | null): void {
    if (!resolution) return
    report.value = resolution
    lyrics.value = resolution.lyrics
    trackId.value = resolution.trackId
  }

  /**
   * Loads lyrics for a track (defaults to the currently playing one).
   *
   * Two phases, and the split is the whole point: the fast half (the user's import, a sidecar
   * `.lrc`, the fetch cache, embedded tags, the track's own source) answers in milliseconds and is
   * what the page renders; only when that comes back empty are the public catalogues searched, in
   * the background. Waiting on a catalogue *before* rendering would leave the lyrics page blank for
   * as long as a search takes — on every track.
   */
  async function load(track?: AudioTrack | null, force = false): Promise<void> {
    const target = track ?? player.current
    if (!target) {
      lyrics.value = null
      trackId.value = ''
      report.value = null
      return
    }
    if (!force && trackId.value === target.id && lyrics.value) return
    const targetId = target.id
    trackId.value = targetId
    loading.value = true
    error.value = ''
    try {
      if (force) {
        // 「联网自动匹配」 goes through the LyricsManager explicitly, so the outcome carries the
        // per-provider report the page needs to explain a miss.
        matching.value = true
        try {
          adopt(await lyricsService.match(target))
        } finally {
          matching.value = false
        }
      } else {
        report.value = null
        lyrics.value = await lyricsService.get(target)
      }
    } catch (loadError) {
      lyrics.value = null
      error.value = loadError instanceof Error ? loadError.message : '歌词加载失败'
    } finally {
      loading.value = false
    }

    if (force || !lyricsAreEmpty(lyrics.value)) return
    // Phase two: best effort, and only adopted if the track has not changed meanwhile (otherwise the
    // previous song's lyrics would land under the current one).
    try {
      const resolution = await lyricsService.search(target)
      if (trackId.value !== targetId || !resolution) return
      if (!lyricsAreEmpty(resolution.lyrics)) adopt(resolution)
      else report.value = resolution
    } catch {
      // A catalogue that is unreachable simply means this track stays without lyrics.
    }
  }

  /** Imports user-provided lyrics (LRC or plain text) for the current track. */
  async function importText(raw: string): Promise<boolean> {
    const target = player.current
    if (!target) return false
    if (!raw.trim()) {
      error.value = '歌词内容为空'
      return false
    }
    importing.value = true
    try {
      const parsed = await lyricsService.save(target, raw)
      if (!parsed) {
        error.value = '歌词保存失败'
        return false
      }
      lyrics.value = parsed
      trackId.value = target.id
      report.value = null
      error.value = ''
      return true
    } catch (saveError) {
      error.value = saveError instanceof Error ? saveError.message : '歌词保存失败'
      return false
    } finally {
      importing.value = false
    }
  }

  /**
   * Reads the stored offset once at startup.
   *
   * Before the first lyric renders, not when the lyrics page opens: the desktop strip and the immersive page
   * would otherwise show uncorrected timing for however long it takes the user to visit a page.
   */
  async function initOffset(): Promise<void> {
    try {
      const stored = await settingsService.get()
      offsetMs.value = clampLyricsOffset(stored.lyricsOffsetMs)
    } catch {
      // Unreadable settings leave the default (no correction) in force.
    }
  }

  /**
   * Sets the offset and persists it. Clamped and snapped in the shared helper, so the UI, the stored file and
   * the desktop strip cannot disagree about what the value is.
   */
  async function setOffset(ms: number): Promise<number> {
    const next = clampLyricsOffset(ms)
    offsetMs.value = next
    try {
      const stored = await settingsService.set({ lyricsOffsetMs: next })
      // Trust what main stored (it clamps too) instead of what was asked for.
      offsetMs.value = clampLyricsOffset(stored.lyricsOffsetMs)
    } catch {
      // A failed write keeps the correction for this session; the value is in force either way.
    }
    return offsetMs.value
  }

  /** Moves the offset by whole steps, which is what the ± buttons in the UI need. */
  async function nudgeOffset(steps: number): Promise<number> {
    return setOffset(offsetMs.value + steps * LYRICS_OFFSET_STEP_MS)
  }

  async function clearCurrent(): Promise<void> {
    const target = player.current
    if (!target) return
    // The whole track goes to the main process: the fetched cache is keyed by the song, so an id
    // alone could not find the copy that has to be cleared along with the import.
    await lyricsService.clear(target)
    await load(target, true)
  }

  /** Clicking a lyric line seeks the *player*; the store then follows automatically. */
  function seekToLine(index: number): void {
    const line = lyrics.value?.lines[index]
    if (!line) return
    player.seek(Math.max(0, line.start))
  }

  function reset(): void {
    lyrics.value = null
    trackId.value = ''
    error.value = ''
    report.value = null
  }

  return {
    lyrics,
    loading,
    matching,
    error,
    trackId,
    importing,
    report,
    offsetMs,
    syncTime,
    activeIndex,
    activeLine,
    activeWordIndex,
    wordTimings,
    romanised,
    available,
    synced,
    originLabel,
    triedLabels,
    load,
    importText,
    clearCurrent,
    initOffset,
    setOffset,
    nudgeOffset,
    seekToLine,
    reset,
  }
})
