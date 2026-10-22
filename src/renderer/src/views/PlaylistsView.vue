<script setup lang="ts">
import { computed, ref } from 'vue'
import type { AudioTrack } from '../../../shared/types'
import EmptyState from '../components/EmptyState.vue'
import TrackList from '../components/TrackList.vue'
import { useLibraryStore } from '../stores/library'
import { usePlaylistStore } from '../stores/playlists'
import { useTrackActions } from '../composables/useTrackActions'

const library = useLibraryStore()
const playlists = usePlaylistStore()
const { ui, playList, playShuffled, enqueueNext, reveal } = useTrackActions()

const nameInput = ref('')
const pickerQuery = ref('')
const showPicker = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

const tracks = computed(() => {
  const active = playlists.active
  if (!active) return []
  return library.byIds(active.trackIds.filter((id) => library.trackMap.has(id))) as AudioTrack[]
})

const pickerResults = computed(() => {
  const needle = pickerQuery.value.trim().toLowerCase()
  const pool = needle ? library.search(needle) : library.tracks
  return pool.slice(0, 40)
})

function createPlaylist(): void {
  const name = nameInput.value.trim() || `新建歌单 ${playlists.playlists.length + 1}`
  playlists.create(name)
  nameInput.value = ''
  ui.notify(`已创建歌单：${name}`, 'success')
}

function rename(): void {
  const active = playlists.active
  if (!active) return
  const next = window.prompt('重命名歌单', active.name)
  if (next === null) return
  playlists.rename(active.id, next)
  ui.notify('歌单名称已更新', 'success')
}

function removePlaylist(): void {
  const active = playlists.active
  if (!active) return
  if (!window.confirm(`确定要删除歌单「${active.name}」吗？`)) return
  playlists.remove(active.id)
  ui.notify('歌单已删除', 'info')
}

function addTrack(track: AudioTrack): void {
  const active = playlists.active
  if (!active) return
  const added = playlists.addTracks(active.id, [track.id])
  ui.notify(added > 0 ? `已添加到「${active.name}」` : '这首歌已在歌单中', added > 0 ? 'success' : 'info')
}

function removeFromPlaylist(track: AudioTrack): void {
  const active = playlists.active
  if (!active) return
  playlists.removeTrack(active.id, track.id)
}

function exportJson(): void {
  const payload = playlists.exportJson()
  const blob = new Blob([payload], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `aurora-playlists-${new Date().toISOString().slice(0, 10)}.json`
  anchor.click()
  URL.revokeObjectURL(url)
  ui.notify('歌单已导出为 JSON 文件', 'success')
}

async function importJson(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  try {
    const text = await file.text()
    const parsed = JSON.parse(text) as { playlists?: Array<{ name?: string; trackIds?: string[] }> }
    const incoming = Array.isArray(parsed.playlists) ? parsed.playlists : []
    let created = 0
    for (const item of incoming) {
      const trackIds = Array.isArray(item.trackIds)
        ? item.trackIds.filter((id): id is string => typeof id === 'string' && library.trackMap.has(id))
        : []
      playlists.create(typeof item.name === 'string' && item.name ? item.name : '导入的歌单', trackIds)
      created += 1
    }
    ui.notify(created > 0 ? `已导入 ${created} 个歌单` : '文件中没有可导入的歌单', created > 0 ? 'success' : 'error')
  } catch {
    ui.notify('无法解析该 JSON 文件', 'error')
  }
}
</script>

<template>
  <div class="view">
    <header class="view-header">
      <div>
        <h1>我的歌单</h1>
        <p class="muted">
          {{ playlists.playlists.length }} 个歌单 · 目前保存在本机浏览器存储中，后续阶段会迁移到 SQLite
        </p>
      </div>
      <div class="view-actions">
        <button class="secondary-button" @click="exportJson" :disabled="playlists.playlists.length === 0">导出 JSON</button>
        <button class="secondary-button" @click="fileInput?.click()">导入 JSON</button>
        <input ref="fileInput" type="file" accept="application/json" class="hidden-input" @change="importJson" />
      </div>
    </header>

    <div class="playlist-layout">
      <aside class="playlist-side">
        <div class="playlist-create">
          <input v-model="nameInput" placeholder="新歌单名称" @keyup.enter="createPlaylist" />
          <button class="primary-button small" @click="createPlaylist">新建</button>
        </div>
        <ul v-if="playlists.playlists.length > 0" class="playlist-nav">
          <li v-for="playlist in playlists.playlists" :key="playlist.id">
            <button :class="{ active: playlist.id === playlists.activeId }" @click="playlists.activeId = playlist.id">
              <strong>{{ playlist.name }}</strong>
              <small>{{ playlist.trackIds.length }} 首</small>
            </button>
          </li>
        </ul>
        <p v-else class="muted small-text">还没有歌单，先创建一个。可以用歌单整理学习、运动、通勤等场景。</p>
      </aside>

      <section class="playlist-main">
        <template v-if="playlists.active">
          <div class="playlist-main-head">
            <div>
              <h2>{{ playlists.active.name }}</h2>
              <p class="muted small-text">{{ tracks.length }} 首歌曲</p>
            </div>
            <div class="view-actions">
              <button class="primary-button" :disabled="tracks.length === 0" @click="playList(tracks, 0)">播放</button>
              <button class="ghost-button" :disabled="tracks.length === 0" @click="playShuffled(tracks)">随机</button>
              <button class="ghost-button" @click="showPicker = !showPicker">{{ showPicker ? '收起' : '添加歌曲' }}</button>
              <button class="ghost-button" @click="rename">重命名</button>
              <button class="ghost-button danger" @click="removePlaylist">删除</button>
            </div>
          </div>

          <div v-if="showPicker" class="picker">
            <div class="search-wrap compact">
              <span class="search-icon">⌕</span>
              <input v-model="pickerQuery" type="search" placeholder="从音乐库中添加歌曲..." />
            </div>
            <div v-if="pickerResults.length > 0" class="picker-list">
              <button v-for="track in pickerResults" :key="track.id" class="picker-item" @click="addTrack(track)">
                <span class="picker-text"><strong>{{ track.title }}</strong><small>{{ track.artist }} · {{ track.album }}</small></span>
                <span class="picker-add">＋</span>
              </button>
            </div>
            <p v-else class="muted small-text">音乐库中没有匹配的歌曲。</p>
          </div>

          <TrackList
            v-if="tracks.length > 0"
            :tracks="tracks"
            @play="(_track: AudioTrack, index: number) => playList(tracks, index)"
            @enqueue="enqueueNext"
            @favorite="() => {}"
            @reveal="reveal"
            @remove="removeFromPlaylist"
          />

          <EmptyState v-else icon="♫" title="这个歌单还是空的" text="点击「添加歌曲」从音乐库中挑选。">
            <button class="primary-button" @click="showPicker = true">添加歌曲</button>
          </EmptyState>
        </template>

        <EmptyState v-else icon="♫" title="还没有歌单" text="创建歌单来整理你的本地音乐。" hint="歌单支持 JSON 导入导出，方便备份与迁移。" />
      </section>
    </div>
  </div>
</template>
