import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

const PLAYLISTS_KEY = 'aurora:playlists'

export interface LocalPlaylist {
  id: string
  name: string
  trackIds: string[]
  createdAt: number
  updatedAt: number
}

function readPlaylists(): LocalPlaylist[] {
  try {
    const raw = localStorage.getItem(PLAYLISTS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (value): value is LocalPlaylist =>
        typeof value === 'object' && value !== null &&
        typeof (value as LocalPlaylist).id === 'string' &&
        typeof (value as LocalPlaylist).name === 'string' &&
        Array.isArray((value as LocalPlaylist).trackIds),
    )
  } catch {
    return []
  }
}

export const usePlaylistStore = defineStore('playlists', () => {
  const playlists = ref<LocalPlaylist[]>([])
  const activeId = ref<string>('')

  const active = computed(() => playlists.value.find((playlist) => playlist.id === activeId.value) ?? null)

  function persist(): void {
    try {
      localStorage.setItem(PLAYLISTS_KEY, JSON.stringify(playlists.value))
    } catch {
      // Ignore quota problems; playlists stay in memory for this session.
    }
  }

  function init(): void {
    playlists.value = readPlaylists()
    if (playlists.value.length > 0 && !activeId.value) activeId.value = playlists.value[0].id
  }

  function create(name: string, trackIds: string[] = []): LocalPlaylist {
    const playlist: LocalPlaylist = {
      id: `pl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      name: name.trim() || '新建歌单',
      trackIds,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    playlists.value = [playlist, ...playlists.value]
    activeId.value = playlist.id
    persist()
    return playlist
  }

  function rename(id: string, name: string): void {
    playlists.value = playlists.value.map((playlist) =>
      playlist.id === id ? { ...playlist, name: name.trim() || playlist.name, updatedAt: Date.now() } : playlist,
    )
    persist()
  }

  function remove(id: string): void {
    playlists.value = playlists.value.filter((playlist) => playlist.id !== id)
    if (activeId.value === id) activeId.value = playlists.value[0]?.id ?? ''
    persist()
  }

  function addTracks(id: string, trackIds: string[]): number {
    let added = 0
    playlists.value = playlists.value.map((playlist) => {
      if (playlist.id !== id) return playlist
      const existing = new Set(playlist.trackIds)
      const fresh = trackIds.filter((trackId) => !existing.has(trackId))
      added = fresh.length
      return { ...playlist, trackIds: [...playlist.trackIds, ...fresh], updatedAt: Date.now() }
    })
    if (added > 0) persist()
    return added
  }

  function removeTrack(id: string, trackId: string): void {
    playlists.value = playlists.value.map((playlist) =>
      playlist.id === id
        ? { ...playlist, trackIds: playlist.trackIds.filter((value) => value !== trackId), updatedAt: Date.now() }
        : playlist,
    )
    persist()
  }

  function moveTrack(id: string, from: number, to: number): void {
    playlists.value = playlists.value.map((playlist) => {
      if (playlist.id !== id) return playlist
      if (from === to || from < 0 || to < 0 || from >= playlist.trackIds.length || to >= playlist.trackIds.length) {
        return playlist
      }
      const ids = [...playlist.trackIds]
      const [moved] = ids.splice(from, 1)
      ids.splice(to, 0, moved)
      return { ...playlist, trackIds: ids, updatedAt: Date.now() }
    })
    persist()
  }

  function exportJson(): string {
    return JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), playlists: playlists.value }, null, 2)
  }

  function clearAll(): void {
    playlists.value = []
    activeId.value = ''
    persist()
  }

  /** Replaces every playlist — used by a restore, and by the rollback after a failed one. */
  function replaceAll(next: LocalPlaylist[]): void {
    playlists.value = next.filter((playlist) => typeof playlist?.id === 'string' && typeof playlist.name === 'string')
    activeId.value = playlists.value[0]?.id ?? ''
    persist()
  }

  return { playlists, activeId, active, init, create, rename, remove, addTracks, removeTrack, moveTrack, exportJson, clearAll, replaceAll }
})
