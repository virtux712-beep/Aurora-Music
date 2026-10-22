import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { AudioTrack, DownloadSettings, DownloadTask } from '../../../shared/types'
import { DEFAULT_QUALITY, chooseQuality } from '../../../shared/quality'
import { downloadService, settingsService } from '../services/aurora'
import { useUiStore } from './ui'

/**
 * The download list, as reported by the main process.
 *
 * This store owns no derived truth: `tasks` is always the array the manager sent, and every action
 * forwards to the manager and adopts whatever it returns. That is what keeps the page honest — a
 * progress bar here cannot disagree with the transfer that is really running.
 */
export const useDownloadStore = defineStore('downloads', () => {
  const tasks = ref<DownloadTask[]>([])
  const settings = ref<DownloadSettings | null>(null)
  const loaded = ref(false)
  const busyId = ref('')

  let unsubscribe: (() => void) | null = null

  const active = computed(() => tasks.value.filter((task) => task.status === 'downloading' || task.status === 'queued'))
  const finished = computed(() =>
    tasks.value.filter((task) => task.status === 'completed' || task.status === 'failed' || task.status === 'canceled'),
  )
  const totalSpeed = computed(() => active.value.reduce((sum, task) => sum + task.speed, 0))

  function adopt(next: DownloadTask[]): void {
    if (Array.isArray(next)) tasks.value = next
  }

  /** Subscribes to `downloads:progress`; the manager pushes on every state change and once a second. */
  function init(): void {
    if (unsubscribe) return
    unsubscribe = downloadService.onProgress((next) => {
      adopt(Array.isArray(next) ? next : [])
      loaded.value = true
    })
    void refresh()
  }

  function dispose(): void {
    unsubscribe?.()
    unsubscribe = null
  }

  async function refresh(): Promise<void> {
    adopt(await downloadService.list())
    loaded.value = true
  }

  async function loadSettings(force = false): Promise<void> {
    if (settings.value && !force) return
    const current = await settingsService.get()
    settings.value = current.downloads
  }

  /**
   * Starts (or matches an existing) download for a track. Returns false when nothing was queued.
   *
   * The quality is the same decision playback makes — the user's tier preference narrowed to what this song
   * is published in — so a download is never quietly a different tier than the song you just listened to. An
   * explicit `quality` argument still wins, for a caller that offers a per-download choice.
   */
  async function start(track: AudioTrack, quality?: string): Promise<boolean> {
    const preferred = settingsService.cached()?.preferredQuality ?? DEFAULT_QUALITY
    const chosen = quality ?? chooseQuality(track.qualities, preferred).quality
    const created = await downloadService.start({ track, ...(chosen ? { quality: chosen } : {}) })
    if (!created) return false
    await refresh()
    const existing = tasks.value.find((task) => task.id === created.id)
    // Deduplicated requests come back as the task that was already there; say so instead of
    // pretending a second transfer started.
    const message =
      existing && existing.status === 'completed'
        ? `已下载过：${created.title}`
        : existing && existing.status !== 'queued'
          ? `该曲目已在下载列表：${created.title}`
          : `已开始下载：${created.title}`
    useUiStore().notify(message, 'success')
    return true
  }

  async function run(id: string, action: (id: string) => Promise<DownloadTask[]>): Promise<void> {
    busyId.value = id
    try {
      adopt(await action(id))
    } finally {
      busyId.value = ''
    }
  }

  const pause = (id: string): Promise<void> => run(id, downloadService.pause)
  const resume = (id: string): Promise<void> => run(id, downloadService.resume)
  const retry = (id: string): Promise<void> => run(id, downloadService.retry)
  const cancel = (id: string): Promise<void> => run(id, downloadService.cancel)
  const remove = (id: string): Promise<void> => run(id, downloadService.remove)

  async function clearFinished(): Promise<void> {
    adopt(await downloadService.clearFinished())
  }

  async function reveal(id: string): Promise<boolean> {
    return downloadService.reveal(id)
  }

  async function openDirectory(): Promise<boolean> {
    return downloadService.openDirectory()
  }

  /** Opens the native folder picker and persists the choice (the main process owns the setting). */
  async function chooseDirectory(): Promise<void> {
    const next = await downloadService.chooseDirectory()
    if (next) settings.value = next
  }

  async function saveSettings(patch: Partial<DownloadSettings>): Promise<void> {
    const next = await settingsService.set({ downloads: patch })
    settings.value = next.downloads
  }

  function progressOf(task: DownloadTask): number {
    if (task.status === 'completed') return 1
    if (task.total <= 0) return 0
    return Math.min(1, task.received / task.total)
  }

  function taskForTrack(trackId: string): DownloadTask | null {
    return tasks.value.find((task) => task.trackId === trackId) ?? null
  }

  return {
    tasks,
    settings,
    loaded,
    busyId,
    active,
    finished,
    totalSpeed,
    init,
    dispose,
    refresh,
    loadSettings,
    start,
    pause,
    resume,
    retry,
    cancel,
    remove,
    clearFinished,
    reveal,
    openDirectory,
    chooseDirectory,
    saveSettings,
    progressOf,
    taskForTrack,
  }
})
