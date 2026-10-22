<script setup lang="ts">
import { computed } from 'vue'
import { useCollectionStore } from '../stores/collection'
import { useLibraryStore } from '../stores/library'
import { formatCount } from '../utils/format'

const library = useLibraryStore()
const collection = useCollectionStore()

const browseLinks = [
  { to: '/', label: '本地音乐', icon: '▣', exact: true },
  { to: '/search', label: '在线音乐', icon: '⌕' },
  { to: '/playlists', label: '我的歌单', icon: '♫' },
  { to: '/lyrics', label: '沉浸歌词', icon: '♪' },
]

const personalLinks = [
  { to: '/favorites', label: '收藏', icon: '♡' },
  { to: '/history', label: '最近播放', icon: '◷' },
  { to: '/downloads', label: '下载', icon: '⇩' },
]

const favoriteCount = computed(() => library.tracks.filter((track) => collection.favoriteSet.has(track.id)).length)

</script>

<template>
  <aside class="sidebar">
    <nav class="nav-group" aria-label="浏览">
      <p class="nav-caption">浏览</p>
      <RouterLink v-for="link in browseLinks" :key="link.to" :to="link.to" class="nav-item" :exact-active-class="link.exact ? 'router-link-active' : undefined">
        <span class="nav-icon">{{ link.icon }}</span>
        <span>{{ link.label }}</span>
        <small v-if="link.to === '/' && library.tracks.length">{{ formatCount(library.tracks.length) }}</small>
      </RouterLink>
    </nav>

    <nav class="nav-group collection-nav" aria-label="你的音乐">
      <p class="nav-caption">你的音乐</p>
      <RouterLink v-for="link in personalLinks" :key="link.to" :to="link.to" class="nav-item">
        <span class="nav-icon">{{ link.icon }}</span>
        <span>{{ link.label }}</span>
        <small v-if="link.to === '/favorites' && favoriteCount">{{ formatCount(favoriteCount) }}</small>
      </RouterLink>
    </nav>

    <div class="sidebar-bottom">
      <RouterLink to="/settings" class="settings-link"><span class="nav-icon">⚙</span>设置</RouterLink>
    </div>
  </aside>
</template>
