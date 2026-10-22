<script setup lang="ts">
withDefaults(
  defineProps<{
    icon?: string
    title: string
    text?: string
    hint?: string
  }>(),
  { icon: '✦', text: '', hint: '' },
)
</script>

<template>
  <div class="empty-state">
    <div class="empty-art" aria-hidden="true">{{ icon }}</div>
    <h3 class="empty-title">{{ title }}</h3>
    <p v-if="text" class="empty-text">{{ text }}</p>
    <p v-if="hint" class="empty-hint">{{ hint }}</p>
    <div class="empty-actions">
      <slot />
    </div>
  </div>
</template>
