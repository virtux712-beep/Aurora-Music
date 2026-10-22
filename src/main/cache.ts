/**
 * Small TTL cache used by the source layer (search results, playlists, recommendations).
 *
 * Deliberately tiny: Aurora is desktop software, so an LRU-bounded map with a time-to-live is
 * enough to stop the app from hammering a source's API while the user clicks around. Only
 * *metadata* is cached — a play URL is never persisted, because it may expire.
 */
export interface TtlCache<V> {
  get(key: string): V | undefined
  set(key: string, value: V, ttlMs?: number): void
  delete(key: string): void
  clear(): void
  readonly size: number
}

interface Entry<V> {
  value: V
  expiresAt: number
}

export function createTtlCache<V>(defaultTtlMs: number, maxEntries: number): TtlCache<V> {
  const entries = new Map<string, Entry<V>>()

  function evictExpired(now: number): void {
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= now) entries.delete(key)
    }
  }

  return {
    get(key) {
      const entry = entries.get(key)
      if (!entry) return undefined
      if (entry.expiresAt <= Date.now()) {
        entries.delete(key)
        return undefined
      }
      // Refresh recency: re-inserting moves the key to the end of the Map iteration order.
      entries.delete(key)
      entries.set(key, entry)
      return entry.value
    },
    set(key, value, ttlMs) {
      const now = Date.now()
      if (entries.size >= maxEntries) {
        evictExpired(now)
        while (entries.size >= maxEntries) {
          const oldest = entries.keys().next().value
          if (oldest === undefined) break
          entries.delete(oldest)
        }
      }
      entries.set(key, { value, expiresAt: now + (ttlMs ?? defaultTtlMs) })
    },
    delete(key) {
      entries.delete(key)
    },
    clear() {
      entries.clear()
    },
    get size() {
      return entries.size
    },
  }
}

/** Cache instances shared by the source manager and the lyrics service. */
export const caches = {
  /** Search hits change slowly; a minute of staleness feels instant and stays polite. */
  search: createTtlCache<unknown>(60_000, 160),
  recommendations: createTtlCache<unknown>(5 * 60_000, 120),
  playlists: createTtlCache<unknown>(5 * 60_000, 120),
  playlistDetail: createTtlCache<unknown>(5 * 60_000, 80),
  lyrics: createTtlCache<unknown>(30 * 60_000, 200),
}

export function clearAllCaches(): void {
  for (const cache of Object.values(caches)) cache.clear()
}
