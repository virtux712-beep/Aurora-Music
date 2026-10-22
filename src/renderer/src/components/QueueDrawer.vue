<script setup lang="ts">
import { ref } from 'vue'
import { usePlayerStore } from '../stores/player'
import { useUiStore } from '../stores/ui'
import { formatTime } from '../utils/format'

const player = usePlayerStore()
const ui = useUiStore()

const dragIndex = ref(-1)
const dropIndex = ref(-1)

function onDragStart(index: number): void {
  dragIndex.value = index
}

function onDragOver(index: number): void {
  dropIndex.value = index
}

function onDrop(index: number): void {
  if (dragIndex.value >= 0) player.moveQueueItem(dragIndex.value, index)
  dragIndex.value = -1
  dropIndex.value = -1
}

function onDragEnd(): void {
  dragIndex.value = -1
  dropIndex.value = -1
}

function playAt(index: number): void {
  const track = player.queue[index]
  if (track) void player.playTrack(track, player.queue)
}
</script>

<template>
  <aside class="queue-drawer" :class="{ open: ui.queueOpen }" aria-label="播放队列">
    <header class="queue-header">
      <div>
        <strong>播放队列</strong>
        <span>{{ player.queue.length }} 首 · {{ formatTime(player.duration) }} 当前</span>
      </div>
      <div class="queue-header-actions">
        <button class="ghost-button" :disabled="player.queue.length === 0" @click="player.clearQueue()">清空</button>
        <button class="icon-button" title="关闭" @click="ui.queueOpen = false">✕</button>
      </div>
    </header>

    <div v-if="player.queue.length === 0" class="queue-empty">
      <p>队列是空的</p>
      <span>在音乐库中双击歌曲，或用行内「＋」按钮加入队列。</span>
    </div>

    <ul v-else class="queue-list">
      <li
        v-for="(item, index) in player.queue"
        :key="`${item.id}-${index}`"
        class="queue-item"
        :class="{ active: player.current?.id === item.id, dropping: dropIndex === index && dragIndex !== index }"
        draggable="true"
        @dragstart="onDragStart(index)"
        @dragover.prevent="onDragOver(index)"
        @drop.prevent="onDrop(index)"
        @dragend="onDragEnd"
        @dblclick="playAt(index)"
      >
        <span class="queue-handle" title="拖动排序">⠿</span>
        <span class="queue-text">
          <strong>{{ item.title }}</strong>
          <small>{{ item.artist }} · {{ formatTime(item.duration) }}</small>
        </span>
        <button class="icon-action" title="播放" @click="playAt(index)">▶</button>
        <button class="icon-action danger" title="从队列移除" @click="player.removeFromQueue(index)">✕</button>
      </li>
    </ul>
  </aside>
</template>
