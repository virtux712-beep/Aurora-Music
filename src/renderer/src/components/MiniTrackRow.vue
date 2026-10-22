<script setup lang="ts">
import { computed } from 'vue'
import type { AudioTrack } from '../../../shared/types'
import { useCollectionStore } from '../stores/collection'
import { usePlayerStore } from '../stores/player'
import { coverStyle as buildCoverStyle } from '../utils/cover'
import { formatTime } from '../utils/format'

const props = defineProps<{
  track: AudioTrack
  meta?: string
  actionLabel?: string
  actionTitle?: string
}>()

const emit = defineEmits<{
  (event: 'play', track: AudioTrack): void
  (event: 'action', track: AudioTrack): void
  (event: 'favorite', track: AudioTrack): void
}>()

const player = usePlayerStore()
const collection = useCollectionStore()

const isCurrent = computed(() => player.current?.id === props.track.id)
const coverStyle = computed<Record<string, string>>(() => buildCoverStyle(props.track.cover, props.track.id))
const favorite = computed(() => collection.isFavorite(props.track.id))
</script>

<template>
  <article class="mini-track" :class="{ active: isCurrent }" @dblclick="emit('play', track)">
    <span class="mini-track-cover" :style="coverStyle"><span v-if="!track.cover">✦</span></span>
    <span class="mini-track-text">
      <strong>{{ track.title }}</strong>
      <small>{{ track.artist }}<template v-if="meta"> · {{ meta }}</template><template v-else> · {{ formatTime(track.duration) }}</template></small>
    </span>
    <button class="icon-action" :class="{ favored: favorite }" :title="favorite ? '取消收藏' : '收藏'" @click.stop="emit('favorite', track)">
      {{ favorite ? '♥' : '♡' }}
    </button>
    <button v-if="actionLabel" class="ghost-button small" :title="actionTitle || actionLabel" @click.stop="emit('action', track)">
      {{ actionLabel }}
    </button>
    <button class="icon-action" title="播放" @click.stop="emit('play', track)">▶</button>
  </article>
</template>
