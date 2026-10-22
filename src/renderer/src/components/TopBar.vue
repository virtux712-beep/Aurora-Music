<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { ThemeMode } from '../../../shared/types'
import { useLibraryStore } from '../stores/library'
import { useUiStore } from '../stores/ui'
import { useTrackActions } from '../composables/useTrackActions'

/**
 * The global top bar.
 *
 * It is deliberately route-aware, because "search" means two different things now:
 *
 *  - on **本地音乐** (`/`) the box is a live filter over the local library and play history — the text
 *    is never sent anywhere, which is why there is no Enter handler there;
 *  - on every other page Enter jumps to **在线音乐**, which is the only page that searches the network.
 *
 * The online page hides this bar entirely (the search box *is* that page).
 */
const route = useRoute()
const router = useRouter()
const ui = useUiStore()
const library = useLibraryStore()
const { playShuffled } = useTrackActions()

const themeOpen = ref(false)

const themes: Array<{ value: ThemeMode; label: string }> = [
  { value: 'dark', label: '深色主题' },
  { value: 'light', label: '浅色主题' },
  { value: 'system', label: '跟随系统' },
]

const onLocalPage = computed(() => route.name === 'home')
const placeholder = computed(() => (onLocalPage.value ? '搜索本地音乐：标题、歌手、专辑、文件名或拼音首字母…' : '搜索在线音乐…'))

function submitSearch(): void {
  if (onLocalPage.value) return
  if (ui.searchQuery.trim()) void router.push('/search')
}

async function addFiles(): Promise<void> {
  const result = await library.importFiles()
  if (result.added > 0) ui.notify(`已添加 ${result.added} 首音乐`, 'success')
  else if (result.duplicated > 0) ui.notify('所选音乐已在音乐库中', 'info')
  else if (result.failed > 0) ui.notify('没有可导入的音频文件', 'error')
}

async function addFolder(): Promise<void> {
  const result = await library.importFolder()
  if (result.added > 0) ui.notify(`已从文件夹导入 ${result.added} 首音乐`, 'success')
  else if (result.duplicated > 0) ui.notify('文件夹中的音乐都已在音乐库中', 'info')
  else ui.notify('该文件夹中没有找到支持的音频文件', 'error')
}

function applyTheme(mode: ThemeMode): void {
  ui.setTheme(mode)
  themeOpen.value = false
}

/** Skins are previewed, so the quick switch links to 主题中心 instead of guessing at them here. */
function openThemeCenter(): void {
  themeOpen.value = false
  void router.push({ name: 'settings', hash: '#theme-center' })
}
</script>

<template>
  <header class="topbar">
    <div class="search-wrap">
      <span class="search-icon">⌕</span>
      <input
        v-model="ui.searchQuery"
        type="search"
        :placeholder="placeholder"
        :aria-label="onLocalPage ? '筛选本地音乐' : '搜索在线音乐'"
        @keyup.enter="submitSearch"
      />
      <kbd>{{ onLocalPage ? '实时筛选' : 'Enter' }}</kbd>
    </div>

    <div class="top-actions">
      <div v-if="library.importing" class="import-progress" :title="`正在读取元数据 ${library.progress.processed}/${library.progress.total}`">
        <span class="spinner"></span>
        <span>导入中 {{ library.progress.total ? `${library.progress.processed}/${library.progress.total}` : '' }}</span>
      </div>
      <!--
        曲库动作只在没有更好入口的页面上出现。

        在本地音乐页，欢迎区里同一组「添加文件 / 添加文件夹 / 随机播放全部」就在标题旁边，
        顶栏再放一份只是重复：同一件事在同一屏上出现两次，用户要多花一次目光去分辨它们是否一样。
        其它页面（歌单、收藏、下载…）本页没有导入入口，这三个按钮就留在这里。
      -->
      <template v-if="!onLocalPage">
        <button class="ghost-button" @click="addFiles">添加文件</button>
        <button class="ghost-button" @click="addFolder">添加文件夹</button>
        <button
          class="ghost-button"
          :disabled="library.tracks.length === 0"
          :title="library.tracks.length === 0 ? '曲库还没有歌曲：先「添加文件」或「扫描文件夹」' : '随机打乱整个曲库并开始播放'"
          @click="playShuffled(library.tracks)"
        >
          随机播放全部
        </button>
      </template>
      <div class="theme-control">
        <button class="icon-button" title="外观主题" @click="themeOpen = !themeOpen">◐</button>
        <div v-if="themeOpen" class="theme-menu">
          <button v-for="item in themes" :key="item.value" :class="{ active: ui.theme === item.value }" @click="applyTheme(item.value)">
            {{ item.label }}
          </button>
          <!--
            The quick switch stays about *mode* (a one-click decision). Skins change the whole space, so
            they live in 主题中心 where they can be previewed — this entry is the way there, not a
            second half-built picker in the top bar.
          -->
          <button class="theme-menu-more" @click="openThemeCenter">主题中心 …</button>
        </div>
      </div>
    </div>
  </header>
</template>
