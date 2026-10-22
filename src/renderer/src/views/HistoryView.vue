<script setup lang="ts">
import { computed, ref } from 'vue'
import type { AudioTrack } from '../../../shared/types'
import EmptyState from '../components/EmptyState.vue'
import MiniTrackRow from '../components/MiniTrackRow.vue'
import { useCollectionStore, type HistoryEntry } from '../stores/collection'
import { useLibraryStore } from '../stores/library'
import { useTrackActions } from '../composables/useTrackActions'
import { formatCount, formatRelativeTime } from '../utils/format'

type Tab = 'recent' | 'top'

const library = useLibraryStore()
const collection = useCollectionStore()
const { ui, playList, enqueueNext, toggleFavorite } = useTrackActions()

const tab = ref<Tab>('recent')

interface HistoryRow {
  entry: HistoryEntry
  track: AudioTrack
}

const entries = computed<HistoryRow[]>(() => {
  const source = tab.value === 'recent'
    ? collection.history
    : [...collection.history].sort((a, b) => b.playCount - a.playCount)
  const rows: HistoryRow[] = []
  for (const entry of source) {
    const track = library.trackMap.get(entry.id)
    if (track) rows.push({ entry, track })
  }
  return rows
})

const tracks = computed(() => entries.value.map((row) => row.track))
const lastPlayed = computed(() => entries.value[0]?.track ?? null)

function playTrack(track: AudioTrack): void {
  playList(tracks.value, tracks.value.findIndex((item) => item.id === track.id))
}
</script>

<template>
  <div class="view">
    <header class="view-header">
      <div>
        <h1>最近播放</h1>
        <p class="muted">
          共 {{ formatCount(collection.history.length) }} 首记录 · 累计播放 {{ formatCount(collection.totalPlays) }} 次
        </p>
      </div>
      <div class="view-actions">
        <button class="primary-button" :disabled="!lastPlayed" @click="lastPlayed && playTrack(lastPlayed)">继续播放</button>
        <button class="ghost-button" :disabled="tracks.length === 0" @click="playList(tracks, 0)">播放全部记录</button>
        <button class="ghost-button danger" :disabled="collection.history.length === 0" @click="collection.clearHistory(); ui.notify('已清空播放历史', 'info')">清空历史</button>
      </div>
    </header>

    <div v-if="entries.length > 0" class="segmented">
      <button :class="{ active: tab === 'recent' }" @click="tab = 'recent'">最近播放</button>
      <button :class="{ active: tab === 'top' }" @click="tab = 'top'">最常播放</button>
    </div>

    <div v-if="entries.length > 0" class="mini-list">
      <MiniTrackRow
        v-for="row in entries"
        :key="row.track.id"
        :track="row.track"
        :meta="`${formatRelativeTime(row.entry.playedAt)} · 播放 ${row.entry.playCount} 次`"
        action-label="下一首"
        action-title="插入到下一首播放"
        @play="playTrack"
        @action="enqueueNext"
        @favorite="toggleFavorite"
      />
    </div>

    <EmptyState
      v-else
      icon="◷"
      title="还没有播放历史"
      text="播放本地音乐后，这里会记录每首歌的播放时间与次数。"
    >
      <RouterLink to="/" class="primary-button">打开本地音乐</RouterLink>
    </EmptyState>
  </div>
</template>
