<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { AudioTrack } from '../../../shared/types'

/**
 * The right-click menu for a local track.
 *
 * It is a dumb menu on purpose: it knows nothing about the library, so the actions it can offer are
 * passed in. Online tracks get a different action set from the caller, which is what keeps "打开文件
 * 位置" from ever appearing on a track that has no file on disk.
 */
const props = defineProps<{
  track: AudioTrack
  x: number
  y: number
  actions: Array<{ id: string; label: string; hint?: string; disabled?: boolean; danger?: boolean }>
}>()

const emit = defineEmits<{
  (event: 'select', id: string): void
  (event: 'close'): void
}>()

const menu = ref<HTMLElement | null>(null)
const position = ref({ left: props.x, top: props.y })

/**
 * Flips the menu when it would leave the viewport. Measured after mount because the menu's height
 * depends on how many actions the caller passed.
 */
function place(): void {
  const element = menu.value
  if (!element) return
  const rect = element.getBoundingClientRect()
  const left = Math.min(props.x, Math.max(0, window.innerWidth - rect.width - 8))
  const top = Math.min(props.y, Math.max(0, window.innerHeight - rect.height - 8))
  position.value = { left, top }
}

function onDocumentPointerDown(event: MouseEvent): void {
  if (menu.value && !menu.value.contains(event.target as Node)) emit('close')
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close')
}

const visibleActions = computed(() => props.actions.filter((action) => action.id !== ''))

onMounted(() => {
  place()
  window.addEventListener('pointerdown', onDocumentPointerDown, true)
  window.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', onDocumentPointerDown, true)
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div
    ref="menu"
    class="context-menu"
    role="menu"
    :style="{ left: `${position.left}px`, top: `${position.top}px` }"
  >
    <p class="context-menu-title" :title="track.title">{{ track.title }}</p>
    <button
      v-for="action in visibleActions"
      :key="action.id"
      role="menuitem"
      class="context-menu-item"
      :class="{ danger: action.danger }"
      :disabled="action.disabled"
      :title="action.hint"
      @click="emit('select', action.id)"
    >
      {{ action.label }}
    </button>
  </div>
</template>
