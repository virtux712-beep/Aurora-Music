<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { AudioTrack, BoardDescriptor, PlatformId } from '../../../shared/types'
import EmptyState from '../components/EmptyState.vue'
import PlaylistPicker from '../components/PlaylistPicker.vue'
import TrackList from '../components/TrackList.vue'
import { useSearchStore, type SearchBoard } from '../stores/search'
import { usePlatformStore } from '../stores/platform'
import { useSourceStore } from '../stores/source'
import { useTrackActions } from '../composables/useTrackActions'
import { formatCount } from '../utils/format'
import { platformBadgeStyle } from '../utils/platformDisplay'

/**
 * 在线音乐 — the online half of Aurora.
 *
 * The page header (and with it the global search box) is hidden for this route, because the search
 * *is* the page: a centred hero box with its own mode switch. Tabs are platforms only; the local
 * library lives on its own page and is never mixed in here.
 */
const search = useSearchStore()
const platformStore = usePlatformStore()
const sourceStore = useSourceStore()
const { ui, playList, playShuffled, enqueueNext, toggleFavorite, reveal, removeFromLibrary } = useTrackActions()

const pickerTrack = ref<AudioTrack | null>(null)

/**
 * 「热门搜索」角栏的展开状态。
 *
 * Read synchronously in the initialiser rather than in `onMounted`: the panel is painted on the first
 * frame, and a state that arrives one tick later would make it visibly jump open after mount. Default is
 * expanded — it is a way in, not a hidden feature — and only an explicit collapse (`'0'`) is remembered,
 * so a storage hiccup opens it instead of hiding it.
 */
const TRENDING_KEY = 'aurora:trending-open'
const trendingOpen = ref(localStorage.getItem(TRENDING_KEY) !== '0')

function toggleTrending(): void {
  trendingOpen.value = !trendingOpen.value
  localStorage.setItem(TRENDING_KEY, trendingOpen.value ? '1' : '0')
}

/** Platforms that actually publish a chart, in registry order. */
const chartPlatforms = computed(() => platformStore.platforms.filter((item) => (platformStore.boardsByPlatform.get(item.id)?.length ?? 0) > 0))

const chartPlatform = ref<PlatformId | ''>('')
const chartBoardId = ref('')

const boardsForPlatform = computed<BoardDescriptor[]>(() =>
  chartPlatform.value ? (platformStore.boardsByPlatform.get(chartPlatform.value) ?? []) : [],
)

const activeChart = computed(() => {
  if (!chartPlatform.value || !chartBoardId.value) return null
  return platformStore.chart(chartPlatform.value, chartBoardId.value)
})

/**
 * 「听歌识曲」 is capability-driven and nothing else. Aurora ships no audio-fingerprint service, so
 * the entry is only usable when an installed source *declares* the ability to identify a song from
 * recorded audio; with none installed the button is disabled and says exactly why.
 */
const recognizer = computed(() => sourceStore.sources.find((source) => source.enabled && source.capabilities.recognize) ?? null)

const platformsWithoutResolver = computed(() =>
  platformStore.platforms
    .filter((item) => (platformStore.healthFor(item.id)?.resolverCount ?? 0) === 0)
    .map((item) => platformStore.label(item.id)),
)

onMounted(async () => {
  search.initHistory()
  await Promise.all([platformStore.load(), sourceStore.load()])
  const first = chartPlatforms.value[0]
  const firstBoard = first ? platformStore.boardsByPlatform.get(first.id)?.[0] : undefined
  if (first && firstBoard) {
    chartPlatform.value = first.id
    chartBoardId.value = firstBoard.boardId
  }
  if (search.query.trim()) void search.runNow()
})

// Selecting a platform resets the board to that platform's first chart.
watch(chartPlatform, (platformId) => {
  if (!platformId) return
  const first = platformStore.boardsByPlatform.get(platformId)?.[0]
  if (first) chartBoardId.value = first.boardId
})

// One watcher loads, keyed on the pair, so switching either half is exactly one request.
watch(
  () => (chartPlatform.value && chartBoardId.value ? `${chartPlatform.value}:${chartBoardId.value}` : ''),
  (key) => {
    if (!key || !chartPlatform.value || !chartBoardId.value) return
    void platformStore.loadChart(chartPlatform.value, chartBoardId.value)
  },
  { immediate: true },
)

function playBoard(board: SearchBoard, index = 0): void {
  if (board.tracks.length === 0) return
  playList(board.tracks, index)
}

function playChart(): void {
  const chart = activeChart.value
  if (chart && chart.tracks.length > 0) playList(chart.tracks, 0)
}

const identify = (): void => {
  const source = recognizer.value ?? undefined
  if (!source) {
    ui.notify('当前没有音源声明「听歌识曲」能力。Aurora 不内置音频指纹服务，安装一个声明该能力的音源后即可使用。', 'info')
    return
  }
  // A source that declares the capability is what this entry would call. Aurora itself ships no
  // fingerprint service, so it names the source instead of pretending to listen.
  ui.notify(`听歌识曲将由「${source.name}」完成。`, 'info')
}
</script>

<template>
  <div class="view online-view">
    <section class="online-hero">
      <p class="eyebrow">在线音乐</p>
      <h1>搜索在线歌曲、歌手、歌词</h1>
      <p class="muted">
        一次并发查询 {{ platformStore.platforms.length }} 个在线平台。搜索由平台完成，播放地址由你安装的音源解析。
      </p>

      <div class="hero-search">
        <span class="search-icon">⌕</span>
        <input
          v-model="search.query"
          type="search"
          placeholder="搜索在线歌曲、歌手、歌词..."
          aria-label="搜索在线音乐"
          autofocus
          @input="search.mode === 'songs' ? search.schedule() : undefined"
          @keyup.enter="search.runNow()"
        />
        <button v-if="search.query" class="icon-button" title="清空" @click="search.resetQuery()">✕</button>
      </div>

      <div class="hero-modes">
        <button class="chip" :class="{ active: search.mode === 'songs' }" @click="search.setMode('songs')">歌曲</button>
        <button class="chip" :class="{ active: search.mode === 'lyrics' }" @click="search.setMode('lyrics')">歌词搜索</button>
        <button
          class="chip"
          :class="{ active: Boolean(recognizer) }"
          :disabled="!recognizer"
          :title="recognizer ? `由「${recognizer.name}」识别` : '当前没有音源声明「听歌识曲」能力；Aurora 不内置音频指纹服务'"
          @click="identify"
        >
          听歌识曲
        </button>
      </div>

      <div class="chip-row source-tabs">
        <button
          v-for="tab in search.tabs"
          :key="tab.id"
          class="chip"
          :class="{ active: search.tab === tab.id }"
          @click="search.setTab(tab.id)"
        >
          {{ tab.label }}
        </button>
      </div>

      <p v-if="platformsWithoutResolver.length > 0" class="muted small-text hero-hint">
        {{ platformsWithoutResolver.join('、') }} 目前没有可用的解析音源：可以搜索与浏览，但播放地址需要在「音源管理」安装并启用对应音源。
      </p>
    </section>

    <template v-if="!search.lastQuery && !search.loading">
      <!--
       * 空状态 = 左侧正文 + 右边偏上一条常驻的「热门搜索」角栏。
       *
       * 用网格列而不是浮层：角栏占掉的是真实列宽，所以它永远不会压住热榜的「播放全部」或任何一行结果
       * —— 悬浮面板在这里一定会盖住东西，而盖住内容比不好看更糟。收起时列宽跟着变窄（同上一条缓动），
       * 于是“收起来”是真的把空间还回来，而不是只把内容藏起来。
       *
       * `align-items: start` 是 `position: sticky` 能生效的前提：网格项一旦被拉伸到列高，就没有可滑动的余量。
       -->
      <div class="online-body" :class="{ 'trending-collapsed': !trendingOpen }">
        <div class="online-main">
      <section v-if="chartPlatforms.length > 0" class="section-block">
        <div class="section-heading">
          <div><h3>全网聚合热榜</h3><p>聚合各源实时热榜，探索多元音浪</p></div>
          <button class="ghost-button small" :disabled="!activeChart || activeChart.tracks.length === 0" @click="playChart">播放全部</button>
        </div>

        <div class="chip-row">
          <button
            v-for="platform in chartPlatforms"
            :key="platform.id"
            class="chip soft"
            :class="{ active: chartPlatform === platform.id }"
            @click="chartPlatform = platform.id"
          >
            {{ platformStore.label(platform.id) }}
          </button>
        </div>

        <div class="chip-row board-row">
          <button
            v-for="board in boardsForPlatform"
            :key="board.boardId"
            class="chip"
            :class="{ active: chartBoardId === board.boardId }"
            @click="chartBoardId = board.boardId"
          >
            {{ board.name }}
          </button>
        </div>

        <div v-if="platformStore.chartLoading && !activeChart" class="skeleton-list">
          <div v-for="row in 5" :key="row" class="skeleton-row">
            <span class="skeleton-cover"></span>
            <span class="skeleton-line"></span>
          </div>
        </div>

        <div v-else-if="activeChart && !activeChart.ok" class="notice-card">
          <span class="notice-icon">!</span>
          <div>
            <strong>{{ activeChart.boardName }}加载失败</strong>
            <p>{{ activeChart.error?.message }}</p>
          </div>
          <button class="ghost-button small" @click="platformStore.loadChart(activeChart.platformId, activeChart.boardId, true)">重试</button>
        </div>

        <TrackList
          v-else-if="activeChart && activeChart.tracks.length > 0"
          :tracks="activeChart.tracks"
          @play="(track, index) => playList(activeChart!.tracks, index)"
          @enqueue="enqueueNext"
          @favorite="toggleFavorite"
          @playlist="(track) => (pickerTrack = track)"
          @reveal="reveal"
          @remove="removeFromLibrary"
        />
      </section>

      <section v-if="search.history.length > 0" class="section-block">
        <div class="section-heading">
          <div><h3>搜索历史</h3><p>保存在本机，最近优先，最多 30 条</p></div>
          <button class="text-button" @click="search.clearHistory()">清空历史</button>
        </div>
        <ul class="history-list">
          <li v-for="entry in search.history" :key="entry.keyword">
            <button class="history-term" @click="search.searchKeyword(entry.keyword)">
              <span class="history-icon">◷</span>
              {{ entry.keyword }}
            </button>
            <button class="icon-action" title="删除这条记录" @click="search.removeHistory(entry.keyword)">✕</button>
          </li>
        </ul>
      </section>
        </div>

        <aside class="corner-panel" :class="{ collapsed: !trendingOpen }" aria-label="热门搜索">
          <!--
            整条标题行都是开关：角栏在角落里，一个小箭头会变成很难点中的目标。
          -->
          <button
            class="corner-head"
            :aria-expanded="trendingOpen"
            aria-controls="trending-chips"
            :title="trendingOpen ? '收起热门搜索' : '展开热门搜索'"
            @click="toggleTrending()"
          >
            <span class="corner-mark" aria-hidden="true">⌕</span>
            <span class="corner-title">热门搜索</span>
            <span class="corner-chevron" aria-hidden="true">⌄</span>
          </button>

          <div id="trending-chips" class="corner-body">
            <div class="corner-body-inner">
              <p class="corner-sub">曲风标签 + 你自己的搜索记录</p>
              <span class="corner-divider" aria-hidden="true"></span>
              <div class="chip-row corner-chips">
                <button
                  v-for="item in search.trending"
                  :key="`${item.origin}-${item.keyword}`"
                  class="chip soft"
                  @click="search.searchKeyword(item.keyword)"
                >
                  {{ item.label }}
                  <small v-if="item.origin === 'history'">最近</small>
                </button>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </template>

    <template v-else>
      <div class="search-status" aria-live="polite">
        <span v-if="search.loading" class="spinner"></span>
        <span>{{ search.loading ? (search.mode === 'lyrics' ? '正在搜索并抓取歌词…' : '正在搜索…') : search.statusSummary }}</span>
        <span v-if="search.failureCount > 0" class="status-warn">{{ search.failureCount }} 个平台暂时不可用</span>
      </div>

      <div v-if="search.loading" class="skeleton-list">
        <div v-for="row in 6" :key="row" class="skeleton-row">
          <span class="skeleton-cover"></span>
          <span class="skeleton-line"></span>
        </div>
      </div>

      <div v-else-if="search.error" class="notice-card">
        <span class="notice-icon">!</span>
        <div>
          <strong>搜索失败</strong>
          <p>{{ search.error }}</p>
        </div>
        <button class="ghost-button small" @click="search.runNow()">重试</button>
      </div>

      <template v-else-if="search.mode === 'lyrics'">
        <section v-if="search.lyricHits.length > 0" class="section-block">
          <div class="section-heading">
            <div><h3>歌词匹配</h3><p>{{ formatCount(search.lyricHits.length) }} 首歌曲真正返回了歌词</p></div>
          </div>
          <ul class="lyric-hit-list">
            <li v-for="hit in search.lyricHits" :key="hit.track.id" class="lyric-hit">
              <div class="lyric-hit-head">
                <strong>{{ hit.track.title }}</strong>
                <span class="muted small-text">
                  {{ hit.track.artist }} ·
                  <em
                    v-if="platformStore.glyph(hit.track.sourceId)"
                    class="badge-source badge-platform"
                    :style="platformBadgeStyle(hit.track.sourceId)"
                  >{{ platformStore.glyph(hit.track.sourceId) }}</em>
                  {{ hit.platformName }} · {{ hit.lineCount }} 行{{ hit.synced ? ' · 逐行' : '' }}
                </span>
              </div>
              <p class="lyric-hit-preview">{{ hit.preview }}</p>
              <div class="lyric-hit-actions">
                <button class="ghost-button small" @click="playList(search.lyricHits.map((item) => item.track), 0)">播放</button>
                <button class="ghost-button small" @click="enqueueNext(hit.track)">下一首播放</button>
                <button class="ghost-button small" @click="toggleFavorite(hit.track)">收藏</button>
              </div>
            </li>
          </ul>
        </section>
        <EmptyState
          v-else
          icon="∅"
          title="没有匹配到歌词"
          text="歌词搜索会先搜索歌曲，再逐首抓取歌词，只保留真正有歌词的结果。"
          hint="换个关键词，或切换到「歌曲」模式查看完整搜索结果。"
        />
      </template>

      <template v-else>
        <section v-for="board in search.boards" :key="board.id" class="section-block">
          <div class="section-heading">
            <div>
              <h3>{{ board.label }} <em class="badge-source">{{ board.kind === 'platform' ? '平台' : '音源' }}</em></h3>
              <p>
                <template v-if="board.error">{{ board.error }}</template>
                <template v-else>{{ formatCount(board.tracks.length) }} 个结果<template v-if="board.latencyMs"> · {{ board.latencyMs }}ms</template></template>
              </p>
            </div>
            <div class="section-actions">
              <button class="ghost-button small" :disabled="board.tracks.length === 0" @click="playBoard(board)">播放全部</button>
              <button class="ghost-button small" :disabled="board.tracks.length === 0" @click="playShuffled(board.tracks)">随机播放</button>
              <button v-if="board.error && board.platformId" class="ghost-button small" @click="platformStore.refreshHealth(); search.runNow()">重试</button>
            </div>
          </div>

          <TrackList
            v-if="board.tracks.length > 0"
            :tracks="board.tracks"
            :show-album="true"
            @play="(track, index) => playBoard(board, index)"
            @enqueue="enqueueNext"
            @favorite="toggleFavorite"
            @playlist="(track) => (pickerTrack = track)"
            @reveal="reveal"
            @remove="removeFromLibrary"
          />

          <div v-else-if="board.error" class="inline-empty">
            <span>⚠</span>
            <p>{{ board.error }} · 其他平台不受影响</p>
          </div>

          <div v-else class="inline-empty">
            <span>∅</span>
            <p>{{ board.label }} 没有返回与「{{ search.lastQuery }}」匹配的结果。</p>
          </div>
        </section>

        <EmptyState
          v-if="search.boards.length === 0"
          icon="∅"
          title="没有找到相关音乐"
          :text="`「${search.lastQuery}」在已选平台中没有结果。`"
          hint="换个关键词，或检查支持该平台的音源是否已安装启用。"
        >
          <button class="ghost-button" @click="$router.push('/settings/sources')">去音源管理</button>
        </EmptyState>
      </template>
    </template>

    <PlaylistPicker v-if="pickerTrack" :tracks="[pickerTrack]" @close="pickerTrack = null" />
  </div>
</template>
