<script setup lang="ts">
import { computed, ref } from 'vue'
import type { AudioTrack } from '../../../shared/types'
import EmptyState from '../components/EmptyState.vue'
import TrackList from '../components/TrackList.vue'
import { useCollectionStore } from '../stores/collection'
import { useLibraryStore } from '../stores/library'
import { useTrackActions } from '../composables/useTrackActions'
import { formatCount } from '../utils/format'

const library = useLibraryStore()
const collection = useCollectionStore()
const { ui, playList, playShuffled, enqueueNext, reveal, removeFromLibrary } = useTrackActions()

const filter = ref('')

const favorites = computed(() => {
  const needle = filter.value.trim().toLowerCase()
  const tracks = library.byIds(collection.favoriteIds.filter((id) => library.trackMap.has(id)))
  if (!needle) return tracks
  return tracks.filter(
    (track) =>
      track.title.toLowerCase().includes(needle) ||
      track.artist.toLowerCase().includes(needle) ||
      track.album.toLowerCase().includes(needle),
  )
})

function onPlay(track: AudioTrack, index: number): void {
  playList(favorites.value, index)
}

function clearFavorites(): void {
  if (collection.favoriteIds.length === 0) return
  collection.clearFavorites()
  ui.notify('已清空收藏', 'info')
}
</script>

<template>
  <div class="view">
    <header class="view-header">
      <div>
        <h1>收藏</h1>
        <p class="muted">
          {{ formatCount(collection.favoriteIds.length) }} 首已收藏歌曲
          <template v-if="collection.history.length === 0"> · 通过播放器或列表中的 ♡ 按钮添加</template>
        </p>
      </div>
      <div class="view-actions">
        <button class="primary-button" :disabled="favorites.length === 0" @click="playList(favorites, 0)">播放全部</button>
        <button class="ghost-button" :disabled="favorites.length === 0" @click="playShuffled(favorites)">随机播放</button>
        <button class="ghost-button danger" :disabled="collection.favoriteIds.length === 0" @click="clearFavorites">清空收藏</button>
      </div>
    </header>

    <div v-if="collection.favoriteIds.length > 0" class="toolbar">
      <div class="search-wrap compact">
        <span class="search-icon">⌕</span>
        <input v-model="filter" type="search" placeholder="在收藏中筛选..." aria-label="筛选收藏" />
      </div>
    </div>

    <TrackList
      v-if="favorites.length > 0"
      :tracks="favorites"
      @play="onPlay"
      @enqueue="enqueueNext"
      @favorite="(track: AudioTrack) => { collection.toggleFavorite(track.id) }"
      @reveal="reveal"
      @remove="removeFromLibrary"
    />

    <EmptyState
      v-else
      icon="♡"
      title="还没有收藏的歌曲"
      text="在本地音乐、在线音乐或播放器中点击 ♡ 即可收藏，收藏会保存在本机。"
    >
      <RouterLink to="/" class="primary-button">去本地音乐挑几首</RouterLink>
    </EmptyState>
  </div>
</template>
