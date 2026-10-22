import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

const FAVORITES_KEY = 'aurora:favorites'
const HISTORY_KEY = 'aurora:history'
const HISTORY_LIMIT = 500

export interface HistoryEntry {
  id: string
  playedAt: number
  playCount: number
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Quota errors must not break playback.
  }
}

export const useCollectionStore = defineStore('collection', () => {
  const favoriteIds = ref<string[]>([])
  const history = ref<HistoryEntry[]>([])
  const playCount = ref(0)

  const favoriteSet = computed(() => new Set(favoriteIds.value))
  const totalPlays = computed(() => history.value.reduce((sum, entry) => sum + entry.playCount, 0))

  function init(): void {
    const storedFavorites = readJson<unknown>(FAVORITES_KEY, [])
    favoriteIds.value = Array.isArray(storedFavorites)
      ? storedFavorites.filter((value): value is string => typeof value === 'string')
      : []

    const storedHistory = readJson<unknown>(HISTORY_KEY, [])
    history.value = Array.isArray(storedHistory)
      ? storedHistory.filter(
          (value): value is HistoryEntry =>
            typeof value === 'object' && value !== null &&
            typeof (value as HistoryEntry).id === 'string' &&
            typeof (value as HistoryEntry).playedAt === 'number',
        )
      : []
  }

  /**
   * Replaces the whole collection.
   *
   * Used by a restore, and by the rollback that follows a failed one: the caller holds the previous
   * arrays, so recovering is the same call with the old values rather than a special path.
   */
  function replaceAll(favorites: string[], entries: HistoryEntry[]): void {
    favoriteIds.value = favorites.filter((value) => typeof value === 'string')
    history.value = entries
      .filter((entry) => typeof entry?.id === 'string' && typeof entry.playedAt === 'number')
      .slice(0, HISTORY_LIMIT)
    writeJson(FAVORITES_KEY, favoriteIds.value)
    writeJson(HISTORY_KEY, history.value)
  }

  function isFavorite(id: string): boolean {
    return favoriteSet.value.has(id)
  }

  function toggleFavorite(id: string): boolean {
    if (favoriteSet.value.has(id)) {
      favoriteIds.value = favoriteIds.value.filter((value) => value !== id)
    } else {
      favoriteIds.value = [id, ...favoriteIds.value]
    }
    writeJson(FAVORITES_KEY, favoriteIds.value)
    return isFavorite(id)
  }

  function recordPlay(id: string): void {
    playCount.value += 1
    const existing = history.value.find((entry) => entry.id === id)
    if (existing) {
      history.value = [
        { ...existing, playedAt: Date.now(), playCount: existing.playCount + 1 },
        ...history.value.filter((entry) => entry.id !== id),
      ]
    } else {
      history.value = [{ id, playedAt: Date.now(), playCount: 1 }, ...history.value]
    }
    history.value = history.value.slice(0, HISTORY_LIMIT)
    writeJson(HISTORY_KEY, history.value)
  }

  function recentIds(limit = 8): string[] {
    return history.value.slice(0, limit).map((entry) => entry.id)
  }

  function topIds(limit = 8): string[] {
    return [...history.value].sort((a, b) => b.playCount - a.playCount).slice(0, limit).map((entry) => entry.id)
  }

  function dropInvalid(validIds: Set<string>): void {
    favoriteIds.value = favoriteIds.value.filter((id) => validIds.has(id))
    history.value = history.value.filter((entry) => validIds.has(entry.id))
    writeJson(FAVORITES_KEY, favoriteIds.value)
    writeJson(HISTORY_KEY, history.value)
  }

  function clearHistory(): void {
    history.value = []
    writeJson(HISTORY_KEY, history.value)
  }

  function clearFavorites(): void {
    favoriteIds.value = []
    writeJson(FAVORITES_KEY, favoriteIds.value)
  }

  return {
    favoriteIds,
    favoriteSet,
    history,
    playCount,
    totalPlays,
    init,
    replaceAll,
    isFavorite,
    toggleFavorite,
    recordPlay,
    recentIds,
    topIds,
    dropInvalid,
    clearHistory,
    clearFavorites,
  }
})
