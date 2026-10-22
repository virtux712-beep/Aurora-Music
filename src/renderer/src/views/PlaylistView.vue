<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { AudioTrack } from '../../../shared/types'
import EmptyState from '../components/EmptyState.vue'
import PlaylistPicker from '../components/PlaylistPicker.vue'
import TrackList from '../components/TrackList.vue'
import { decodePlaylistRef, useSourcePlaylistStore } from '../stores/sourcePlaylist'
import { useCollectionStore } from '../stores/collection'
import { safeExternalUrl, safeMediaUrl } from '../utils/url'
import { usePlatformStore } from '../stores/platform'
import { useSourceStore } from '../stores/source'
import { useLibraryStore } from '../stores/library'
import { useUiStore } from '../stores/ui'
import { useTrackActions } from '../composables/useTrackActions'
import { coverStyle } from '../utils/cover'
import { formatCount, formatTime } from '../utils/format'

/**
 * Detail page for a playlist/collection owned by a source plugin
 * (route: `/playlist/<sourceId>:<playlistId>`, e.g. a Radio Browser tag collection).
 *
 * "Play all" pushes the list straight into the player queue — it never plays track by track.
 */
const route = useRoute()
const router = useRouter()
const store = useSourcePlaylistStore()
const platformStore = usePlatformStore()
const sourceStore = useSourceStore()
const collection = useCollectionStore()
const library = useLibraryStore()
const ui = useUiStore()
const { playList, playShuffled, enqueueEnd, toggleFavorite, reveal, removeFromLibrary } = useTrackActions()

const pickerTrack = ref<AudioTrack | null>(null)

const playlistRef = computed(() => {
  const raw = String(route.params.id ?? '')
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
})
const target = computed(() => decodePlaylistRef(playlistRef.value))
const playlist = computed(() => store.playlist)
const tracks = computed(() => store.tracks)
const totalDuration = computed(() => tracks.value.reduce((sum, track) => sum + (track.duration || 0), 0))
const fallback = computed(() => coverStyle(undefined, playlistRef.value))
// A playlist arrives from a source, so its artwork and link are validated before they are used.
const coverUrl = computed(() => safeMediaUrl(playlist.value?.cover))
const homepage = computed(() => safeExternalUrl(playlist.value?.homepage))
const sourceName = computed(() =>
  target.value
    ? (platformStore.labelIfKnown(target.value.sourceId) ?? sourceStore.label(target.value.sourceId))
    : '',
)

onMounted(() => {
  void load()
})

watch(playlistRef, () => {
  void load()
})

async function load(): Promise<void> {
  const resolved = target.value
  if (!resolved) {
    store.error = '无效的歌单地址'
    return
  }
  await store.load(resolved.sourceId, resolved.playlistId)
  if (route.query.autoplay === '1' && store.tracks.length > 0) {
    playList(store.tracks, 0)
    void router.replace({ query: {} })
  }
}

function playAll(): void {
  playList(tracks.value, 0)
}

function queueAll(): void {
  if (tracks.value.length === 0) return
  for (const track of tracks.value) enqueueEnd(track)
  ui.notify(`已把 ${tracks.value.length} 首加入播放队列`, 'success')
}

function favoriteAll(): void {
  if (tracks.value.length === 0) return
  const online = tracks.value.filter((track) => track.origin === 'online')
  // Snapshot online tracks first so the favourites survive a restart.
  if (online.length > 0) library.rememberOnline(online)
  let added = 0
  let removed = 0
  for (const track of tracks.value) {
    const wasFavorite = collection.isFavorite(track.id)
    collection.toggleFavorite(track.id)
    if (wasFavorite) removed += 1
    else added += 1
  }
  ui.notify(added > 0 ? `已收藏 ${added} 首` : `已取消收藏 ${removed} 首`, 'info')
}
</script>

<template>
  <div class="view">
    <button class="text-button back-link" @click="router.back()">← 返回</button>

    <div v-if="store.loading" class="playlist-hero">
      <span class="skeleton-cover large"></span>
      <div class="playlist-hero-meta">
        <span class="skeleton-line wide"></span>
        <span class="skeleton-line"></span>
      </div>
    </div>

    <div v-else-if="store.error" class="notice-card">
      <span class="notice-icon">!</span>
      <div>
        <strong>无法加载这个歌单</strong>
        <p>{{ store.error }}</p>
      </div>
      <button class="ghost-button small" @click="load()">重试</button>
    </div>

    <template v-else-if="playlist">
      <section class="playlist-hero">
        <div class="playlist-hero-art">
          <img v-if="coverUrl" :src="coverUrl" alt="" decoding="async" />
          <div v-else class="cover-fallback large" :style="fallback"><span>♫</span></div>
        </div>
        <div class="playlist-hero-meta">
          <span class="pill">合集 · {{ sourceName }}</span>
          <h1>{{ playlist.title }}</h1>
          <p v-if="playlist.description" class="muted">{{ playlist.description }}</p>
          <div class="playlist-facts">
            <span v-if="playlist.creator">创建者：{{ playlist.creator }}</span>
            <span>{{ formatCount(tracks.length) }} 首</span>
            <span v-if="totalDuration > 0">总时长 {{ formatTime(totalDuration) }}</span>
            <span v-if="homepage">
              <a :href="homepage" target="_blank" rel="noreferrer">查看来源</a>
            </span>
          </div>
          <div class="hero-buttons">
            <button class="primary-button" :disabled="tracks.length === 0" @click="playAll">播放全部</button>
            <button class="ghost-button" :disabled="tracks.length === 0" @click="playShuffled(tracks)">随机播放</button>
            <button class="ghost-button" :disabled="tracks.length === 0" @click="queueAll">全部加入队列</button>
            <button class="ghost-button" :disabled="tracks.length === 0" @click="favoriteAll">切换收藏</button>
          </div>
        </div>
      </section>

      <TrackList
        v-if="tracks.length > 0"
        :tracks="tracks"
        :show-album="true"
        @play="(track, index) => playList(tracks, index)"
        @enqueue="(track) => enqueueEnd(track)"
        @favorite="toggleFavorite"
        @playlist="(track) => (pickerTrack = track)"
        @reveal="reveal"
        @remove="removeFromLibrary"
      />

      <EmptyState
        v-else
        icon="∅"
        title="这个合集没有可播放的内容"
        :text="`「${playlist.title}」返回了 0 首曲目。`"
        hint="公共目录的合集偶尔会为空，可返回首页或搜索。"
      >
        <button class="ghost-button" @click="router.push('/')">返回首页</button>
      </EmptyState>
    </template>

    <EmptyState
      v-else
      icon="∅"
      title="歌单不存在"
      text="该音源没有返回这个歌单。"
    >
      <button class="ghost-button" @click="router.push('/')">返回首页</button>
    </EmptyState>

    <PlaylistPicker v-if="pickerTrack" :tracks="[pickerTrack]" @close="pickerTrack = null" />
  </div>
</template>
