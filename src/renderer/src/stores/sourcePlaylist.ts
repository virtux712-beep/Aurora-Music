import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { SourceId, SourcePlaylistDetail } from '../../../shared/types'
import { sourceService } from '../services/aurora'

/** Playlist reference encoded in the route: `/playlist/<sourceId>:<playlistId>`. */
export function encodePlaylistRef(sourceId: SourceId, playlistId: string): string {
  return `${sourceId}:${playlistId}`
}

export function decodePlaylistRef(ref: string): { sourceId: SourceId; playlistId: string } | null {
  const separator = ref.indexOf(':')
  if (separator <= 0) return null
  const sourceId = ref.slice(0, separator)
  const playlistId = ref.slice(separator + 1)
  if (!sourceId || !playlistId) return null
  return { sourceId, playlistId }
}

/**
 * Detail of a playlist owned by a source plugin (e.g. a Radio Browser tag collection). The store
 * keeps the last loaded playlist so navigating back and forth is instant, and it never fabricates
 * tracks: an unsupported or failing source produces an error state.
 */
export const useSourcePlaylistStore = defineStore('sourcePlaylist', () => {
  const detail = ref<SourcePlaylistDetail | null>(null)
  const loading = ref(false)
  const error = ref('')
  const currentRef = ref('')

  const tracks = computed(() => detail.value?.tracks ?? [])
  const playlist = computed(() => detail.value?.playlist ?? null)

  async function load(sourceId: SourceId, playlistId: string): Promise<void> {
    const ref = encodePlaylistRef(sourceId, playlistId)
    if (currentRef.value === ref && detail.value) return
    currentRef.value = ref
    loading.value = true
    error.value = ''
    try {
      const result = await sourceService.playlistDetail(sourceId, playlistId)
      detail.value = result
      if (!result) error.value = '这个歌单没有返回任何内容'
    } catch (loadError) {
      detail.value = null
      error.value = loadError instanceof Error ? loadError.message : '歌单加载失败'
    } finally {
      loading.value = false
    }
  }

  function reset(): void {
    detail.value = null
    currentRef.value = ''
    error.value = ''
  }

  return { detail, loading, error, currentRef, tracks, playlist, load, reset }
})
