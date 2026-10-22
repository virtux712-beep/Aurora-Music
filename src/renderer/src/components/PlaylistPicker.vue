<script setup lang="ts">
import { computed, ref } from 'vue'
import type { AudioTrack } from '../../../shared/types'
import { useLibraryStore } from '../stores/library'
import { usePlaylistStore } from '../stores/playlists'
import { useUiStore } from '../stores/ui'

/**
 * Adds tracks (local or online) to one of the user's own playlists. Online tracks are snapshotted
 * first so the playlist can still resolve their metadata after a restart.
 *
 * Takes a list rather than a single track because the library's multi-select needs the very same
 * dialog: one track is a list of one, and a second picker written for batches would drift from this
 * one the first time either changed.
 */
const props = defineProps<{ tracks: AudioTrack[] }>()
const emit = defineEmits<{ (event: 'close'): void }>()

const playlists = usePlaylistStore()
const library = useLibraryStore()
const ui = useUiStore()

const newName = ref('')

const ids = computed(() => props.tracks.map((track) => track.id))
/** What the dialog is acting on: a title for one song, a count for a selection. */
const subject = computed(() =>
  props.tracks.length === 1 ? props.tracks[0].title : `已选 ${props.tracks.length} 首`,
)

function remember(): void {
  const online = props.tracks.filter((track) => track.origin === 'online')
  if (online.length > 0) library.rememberOnline(online)
}

function choose(id: string, name: string): void {
  remember()
  const added = playlists.addTracks(id, ids.value)
  if (added <= 0) ui.notify(`「${name}」中已有这些歌曲`, 'info')
  else if (added === ids.value.length) ui.notify(`已加入歌单「${name}」：${added} 首`, 'success')
  // A partial result is stated as a partial result: the rest were already in the playlist.
  else ui.notify(`已加入歌单「${name}」：${added} 首，其余已在歌单中`, 'success')
  emit('close')
}

function createAndAdd(): void {
  const name = newName.value.trim()
  if (!name) return
  remember()
  const playlist = playlists.create(name, ids.value)
  ui.notify(`已创建歌单「${playlist.name}」：${ids.value.length} 首`, 'success')
  newName.value = ''
  emit('close')
}
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <div class="modal-card" role="dialog" aria-label="加入歌单">
      <header class="modal-head">
        <div>
          <strong>加入歌单</strong>
          <span class="muted small-text">{{ subject }}</span>
        </div>
        <button class="icon-button" title="关闭" @click="emit('close')">✕</button>
      </header>

      <div class="modal-body">
        <ul v-if="playlists.playlists.length > 0" class="modal-list">
          <li v-for="playlist in playlists.playlists" :key="playlist.id">
            <button class="modal-list-item" @click="choose(playlist.id, playlist.name)">
              <span class="modal-list-icon">♫</span>
              <span class="modal-list-text">
                <strong>{{ playlist.name }}</strong>
                <small>{{ playlist.trackIds.length }} 首</small>
              </span>
            </button>
          </li>
        </ul>
        <p v-else class="muted small-text">还没有歌单，先创建一个。</p>

        <div class="modal-create">
          <input v-model="newName" class="text-input" type="text" placeholder="新建歌单名称" @keyup.enter="createAndAdd" />
          <button class="primary-button small" :disabled="!newName.trim()" @click="createAndAdd">创建并加入</button>
        </div>
      </div>
    </div>
  </div>
</template>
