<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { AudioTrack } from '../../../shared/types'
import BatchTagDialog from '../components/BatchTagDialog.vue'
import EmptyState from '../components/EmptyState.vue'
import MiniTrackRow from '../components/MiniTrackRow.vue'
import PlaylistPicker from '../components/PlaylistPicker.vue'
import TrackContextMenu from '../components/TrackContextMenu.vue'
import TrackList from '../components/TrackList.vue'
import TrackToolsDialog from '../components/TrackToolsDialog.vue'
import { useCollectionStore } from '../stores/collection'
import { useLibraryStore } from '../stores/library'
import { usePlayerStore } from '../stores/player'
import { useTrackActions } from '../composables/useTrackActions'
import { describeAudio } from '../utils/audio'
import { formatCount, formatTime } from '../utils/format'

/**
 * 本地音乐 — the local half of Aurora.
 *
 * Everything on this page is file-and-history work: no platform API is contacted for the list, the
 * search, the statistics or the smart playlists. The only deliberate exception is 「自动补齐信息」,
 * which the user starts explicitly and which reports exactly what it matched.
 */

type LibraryTab = 'songs' | 'artists' | 'albums' | 'folders'
type SortKey = 'title' | 'artist' | 'album' | 'duration' | 'addedAt'
type ToolMode = 'tags' | 'convert'

const library = useLibraryStore()
const collection = useCollectionStore()
const player = usePlayerStore()
const { ui, playList, playShuffled, enqueueNext, toggleFavorite, reveal, removeFromLibrary } = useTrackActions()

const tab = ref<LibraryTab>('songs')
const sortKey = ref<SortKey>('addedAt')
const sortAsc = ref(false)
const expanded = ref('')

const menuState = ref<{ track: AudioTrack; x: number; y: number } | null>(null)
const toolsState = ref<{ track: AudioTrack; mode: ToolMode } | null>(null)
const pickerTracks = ref<AudioTrack[] | null>(null)

const tabs: Array<{ id: LibraryTab; label: string; icon: string }> = [
  { id: 'songs', label: '单曲', icon: '♪' },
  { id: 'artists', label: '歌手', icon: '☺' },
  { id: 'albums', label: '专辑', icon: '▣' },
  { id: 'folders', label: '文件夹', icon: '▤' },
]

const sortOptions: Array<{ value: SortKey; label: string }> = [
  { value: 'addedAt', label: '添加时间' },
  { value: 'title', label: '标题' },
  { value: 'artist', label: '艺术家' },
  { value: 'album', label: '专辑' },
  { value: 'duration', label: '时长' },
]

/* --------------------------------------------------------------- filtering & sorting */

/** The header search filters the library *and* the play history, by tag, file name or initials. */
const filtered = computed(() => library.filterLocal(ui.searchQuery))

const visibleTracks = computed(() => {
  const sorted = [...filtered.value].sort((a, b) => {
    const key = sortKey.value
    if (key === 'duration' || key === 'addedAt') return a[key] - b[key]
    return a[key].localeCompare(b[key], 'zh-CN')
  })
  return sortAsc.value ? sorted : sorted.reverse()
})

function playAll(): void {
  playList(visibleTracks.value, 0)
}

/* --------------------------------------------------------------- grouped views */

interface Group {
  key: string
  title: string
  subtitle: string
  tracks: AudioTrack[]
  cover?: string
}

/** Directory of a local file, used as the folder-group key. */
function folderOf(track: AudioTrack): string {
  const path = track.filePath ?? ''
  const parts = path.split(/[\\/]/)
  parts.pop()
  return parts.join('\\') || path
}

const groups = computed<Group[]>(() => {
  const map = new Map<string, Group>()
  for (const track of filtered.value) {
    let key: string
    let title: string
    let subtitle: string
    if (tab.value === 'artists') {
      key = track.artist || '未知艺术家'
      title = key
      subtitle = ''
    } else if (tab.value === 'albums') {
      key = `${track.album || '未知专辑'}||${track.artist}`
      title = track.album || '未知专辑'
      subtitle = track.artist
    } else if (tab.value === 'folders') {
      key = folderOf(track)
      title = key.split(/[\\/]/).pop() || key
      subtitle = key
    } else {
      continue
    }
    const group = map.get(key) ?? { key, title, subtitle, tracks: [], cover: track.cover }
    if (!group.cover && track.cover) group.cover = track.cover
    group.tracks.push(track)
    map.set(key, group)
  }
  return [...map.values()].sort((a, b) => b.tracks.length - a.tracks.length)
})

function toggleGroup(key: string): void {
  expanded.value = expanded.value === key ? '' : key
}

/* --------------------------------------------------------------- dashboard */

const greeting = computed(() => {
  const hour = new Date().getHours()
  if (hour < 6) return '夜深了'
  if (hour < 12) return '早上好'
  if (hour < 18) return '下午好'
  return '晚上好'
})

const todayLabel = computed(() => new Date().toLocaleDateString('zh-CN', { weekday: 'long', month: 'long', day: 'numeric' }))

const recentTracks = computed(() => library.byIds(collection.recentIds(8)))
const continueTrack = computed(() => player.current ?? recentTracks.value[0] ?? null)
const favoriteCount = computed(() => library.tracks.filter((track) => collection.favoriteSet.has(track.id)).length)
const losslessCount = computed(() => library.losslessTracks.length)

const stats = computed(() => [
  {
    label: '本地曲目',
    value: formatCount(library.tracks.length),
    hint: library.missingIds.length ? `${library.missingIds.length} 首文件已丢失` : '来自你导入的文件',
  },
  { label: '总时长', value: formatTime(library.totalDuration), hint: '音乐库总播放时长' },
  {
    label: '无损占比',
    value: library.losslessRatio === null ? '—' : `${library.losslessRatio}%`,
    hint: `${formatCount(losslessCount.value)} 首 FLAC / WAV 等`,
  },
  { label: '总播放次数', value: formatCount(collection.totalPlays), hint: `收藏 ${formatCount(favoriteCount.value)} 首` },
])

const NINETY_DAYS = 90 * 24 * 60 * 60 * 1000

/**
 * 「遗忘金曲」: files the history says you have not listened to in over 90 days — including files that
 * were imported long ago and never played. Tracks with no `addedAt` older than the window are left out
 * rather than guessed at.
 */
const forgotten = computed(() => {
  const cutoff = Date.now() - NINETY_DAYS
  const lastPlayed = new Map(collection.history.map((entry) => [entry.id, entry.playedAt] as const))
  return library.tracks
    .filter((track) => {
      const playedAt = lastPlayed.get(track.id)
      if (playedAt === undefined) return (track.addedAt ?? Date.now()) < cutoff
      return playedAt < cutoff
    })
    .sort((a, b) => (a.addedAt ?? 0) - (b.addedAt ?? 0))
})

const hiRes = computed(() => library.hiResTracks)

const smartPlaylists = computed(() => [
  {
    key: 'forgotten',
    name: '遗忘金曲',
    desc: '超过 90 天没有听过',
    hint: '久未回味的本地歌曲，从最早的开始',
    tracks: forgotten.value,
    tone: 'violet',
  },
  {
    key: 'hires',
    name: 'Hi-Res 无损专区',
    desc: '高于 CD 规格的无损文件',
    hint: '>= 24bit / 48kHz 或更高采样率',
    tracks: hiRes.value,
    tone: 'cyan',
  },
])

function playSmart(tracks: AudioTrack[]): void {
  if (tracks.length === 0) {
    ui.notify('这个智能歌单目前是空的', 'info')
    return
  }
  playList(tracks, 0)
}

/* --------------------------------------------------------------- library actions */

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

/**
 * Re-reads the library from the main process. Not a re-scan of the disk: adding files, converting one
 * and finishing a download all change the index from that side, and this is the manual counterpart to
 * the automatic change listener.
 */
async function refresh(): Promise<void> {
  await library.load()
  ui.notify(`已刷新音乐库：${formatCount(library.tracks.length)} 首`, 'success')
}

function playSingle(track: AudioTrack): void {
  void player.playTrack(track, visibleTracks.value.length > 0 ? visibleTracks.value : library.tracks)
}

/* --------------------------------------------------------------- multi-select & batch actions */

/**
 * Multi-select lives on the page rather than in the list, because the list does not own the selection:
 * the batch bar, the dialogs and the removal confirmation all read the same set, and the list is only
 * one of the places that can change it.
 */
const selectMode = ref(false)
/** The chosen ids as a plain array: the virtualised rows compare against it on every frame. */
const selectedIds = ref<string[]>([])
/** The last row clicked without shift, which is what a shift-click extends from. */
const anchorIndex = ref<number | null>(null)
const batchTagsOpen = ref(false)
/** Two-step removal: the button asks, the second button acts. No separate modal needed for one question. */
const confirmRemove = ref(false)
const batchBusy = ref(false)

/** The chosen tracks, in the order the list shows them rather than the order they were clicked. */
const selectedTracks = computed(() => {
  const wanted = new Set(selectedIds.value)
  return visibleTracks.value.filter((track) => wanted.has(track.id))
})

function clearSelection(): void {
  selectedIds.value = []
  anchorIndex.value = null
  confirmRemove.value = false
}

function toggleSelectMode(): void {
  selectMode.value = !selectMode.value
  // Leaving the mode has to leave the selection behind as well, or the batch bar would describe
  // tracks the list no longer marks.
  if (!selectMode.value) clearSelection()
}

function onSelect(track: AudioTrack, index: number, shift: boolean): void {
  const ids = new Set(selectedIds.value)
  if (shift && anchorIndex.value !== null) {
    // Shift adds the whole span instead of replacing it: extending a selection must never drop what
    // was already chosen, which is how every file manager behaves.
    const from = Math.min(index, anchorIndex.value)
    const to = Math.max(index, anchorIndex.value)
    for (let cursor = from; cursor <= to; cursor += 1) {
      const candidate = visibleTracks.value[cursor]
      if (candidate) ids.add(candidate.id)
    }
  } else if (ids.has(track.id)) {
    ids.delete(track.id)
  } else {
    ids.add(track.id)
  }
  anchorIndex.value = index
  confirmRemove.value = false
  selectedIds.value = [...ids]
}

/** Select-all means the list in front of the user — the *visible* order after search and sorting. */
function onSelectAll(want: boolean): void {
  selectedIds.value = want ? visibleTracks.value.map((track) => track.id) : []
  anchorIndex.value = null
  confirmRemove.value = false
}

function invertSelection(): void {
  const chosen = new Set(selectedIds.value)
  selectedIds.value = visibleTracks.value.filter((track) => !chosen.has(track.id)).map((track) => track.id)
  anchorIndex.value = null
  confirmRemove.value = false
}

/**
 * Removes the selection from the library index.
 *
 * One file at a time, and the failures are named: a read-only folder or a file moved since the scan
 * fails for one track, and reporting "完成" for the batch would hide exactly the case the user needs to
 * know about. The files themselves are never deleted — the same contract as the single-track action.
 */
async function batchRemove(): Promise<void> {
  if (batchBusy.value) return
  batchBusy.value = true
  const targets = [...selectedTracks.value]
  const failedIds: string[] = []
  let failed = 0
  let removed = 0
  try {
    for (const track of targets) {
      const ok = await library.remove(track.id)
      if (ok) {
        player.clearIfCurrent(track.id)
        removed += 1
      } else {
        failedIds.push(track.id)
        failed += 1
      }
    }
  } finally {
    batchBusy.value = false
  }

  // Only the ones that really went away leave the selection: keeping the failures selected is what
  // makes a retry possible without hunting for them again.
  selectedIds.value = failedIds
  confirmRemove.value = false
  anchorIndex.value = null
  if (failed === 0) ui.notify(`已从音乐库移除 ${removed} 首（文件仍在磁盘上）`, 'success')
  else ui.notify(`已移除 ${removed} 首，${failed} 首失败并保留在选中状态`, 'error')
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  if (!selectMode.value) return
  // Escape is the way out of a selection; the batch bar's own button stays for the mouse.
  if (confirmRemove.value) confirmRemove.value = false
  else clearSelection()
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

// The grouped tabs have no checkboxes, so a selection made on 单曲 would silently follow the user there.
watch(tab, () => clearSelection())

function resume(): void {
  if (player.current) player.toggle()
  else if (continueTrack.value) playSingle(continueTrack.value)
}

function openMenu(track: AudioTrack, x: number, y: number): void {
  menuState.value = { track, x, y }
}

const menuActions = computed(() => {
  const track = menuState.value?.track
  if (!track) return []
  return [
    { id: 'play', label: '播放' },
    { id: 'enqueue', label: '下一首播放' },
    { id: 'favorite', label: collection.isFavorite(track.id) ? '取消收藏' : '收藏' },
    { id: 'playlist', label: '加入歌单' },
    { id: '', label: '' },
    { id: 'reveal', label: '打开文件位置' },
    { id: 'tags', label: '修改 ID3 标签', hint: '仅 MP3 可写入' },
    { id: 'convert', label: '格式转换', hint: '需要本机 ffmpeg' },
    { id: '', label: '' },
    { id: 'remove', label: '从音乐库移除', danger: true },
  ]
})

async function onMenuSelect(id: string): Promise<void> {
  const track = menuState.value?.track
  menuState.value = null
  if (!track) return
  switch (id) {
    case 'play':
      playSingle(track)
      break
    case 'enqueue':
      enqueueNext(track)
      break
    case 'favorite':
      toggleFavorite(track)
      break
    case 'playlist':
      pickerTracks.value = [track]
      break
    case 'reveal':
      await reveal(track)
      break
    case 'tags':
      toolsState.value = { track, mode: 'tags' }
      break
    case 'convert':
      toolsState.value = { track, mode: 'convert' }
      break
    case 'remove':
      await removeFromLibrary(track)
      break
    default:
      break
  }
}
</script>

<template>
  <div class="view">
    <section class="welcome-row">
      <div>
        <p class="eyebrow">{{ todayLabel }}</p>
        <h1>{{ greeting }}，这是你的本地音乐 <span>✦</span></h1>
        <p class="muted">
          全部数据保存在这台电脑上：文件、统计、歌单与播放记录都不依赖网络。在线探索在「在线音乐」页面。
        </p>
      </div>
      <div class="welcome-actions">
        <button class="secondary-button" @click="addFiles"><span>＋</span> 添加文件</button>
        <button class="secondary-button" @click="addFolder"><span>▤</span> 添加文件夹</button>
        <!-- The reason a disabled button cannot be pressed belongs on the button, not in the user's head. -->
        <button
          class="primary-button"
          :disabled="library.tracks.length === 0"
          :title="library.tracks.length === 0 ? '曲库还没有歌曲：先「添加文件」或「扫描文件夹」' : '随机打乱整个曲库并开始播放'"
          @click="playShuffled(library.tracks)"
        >
          <span>⚄</span> 随机播放全部
        </button>
      </div>
    </section>

    <section v-if="library.tracks.length === 0" class="hero-card empty-hero">
      <div class="hero-copy">
        <span class="pill">开始使用</span>
        <h2>先让 Aurora<br /><em>认识你的音乐</em></h2>
        <p>支持 MP3 · FLAC · WAV · M4A · AAC · OGG · OPUS<br />自动读取标题、艺术家、专辑与封面。</p>
        <div class="hero-buttons">
          <button class="primary-button" @click="addFiles">选择音乐文件 <span>→</span></button>
          <button class="secondary-button" @click="addFolder">扫描音乐文件夹</button>
        </div>
      </div>
      <div class="hero-art art-violet"><div class="hero-orb orb-one"></div><div class="hero-orb orb-two"></div><span class="art-label">NO MUSIC<br /><b>YET</b></span></div>
    </section>

    <template v-else>
      <section class="section-block">
        <div class="section-heading">
          <div><h3>继续播放</h3><p>从这里接着听</p></div>
          <button class="text-button" @click="ui.toggleQueue()">播放队列 <span>→</span></button>
        </div>
        <div v-if="continueTrack" class="continue-card">
          <MiniTrackRow
            :track="continueTrack"
            :meta="player.current ? player.current.album : '最近播放'"
            @play="playSingle"
            @favorite="toggleFavorite"
          />
          <div class="continue-side">
            <button class="play-button wide" @click="resume">{{ player.isPlaying ? '暂停' : '继续播放' }}</button>
            <span class="muted small-text">
              {{ formatTime(player.current ? player.currentTime : 0) }} /
              {{ formatTime(player.duration || continueTrack.duration) }}
            </span>
          </div>
        </div>
      </section>

      <section class="section-block">
        <div class="section-heading"><div><h3>音乐统计</h3><p>你的本地聆听概览</p></div></div>
        <div class="stat-grid">
          <article v-for="item in stats" :key="item.label" class="stat-card">
            <strong>{{ item.value }}</strong>
            <span>{{ item.label }}</span>
            <small>{{ item.hint }}</small>
          </article>
        </div>
      </section>

      <section class="section-block">
        <div class="section-heading">
          <div><h3>智能动态歌单</h3><p>由你的文件与播放记录自动聚类</p></div>
        </div>
        <div class="smart-grid">
          <article v-for="item in smartPlaylists" :key="item.key" class="smart-card" :class="item.tone">
            <header>
              <strong>{{ item.name }}</strong>
              <span class="smart-count">{{ formatCount(item.tracks.length) }} 首</span>
            </header>
            <p class="muted small-text">{{ item.desc }}</p>
            <ul class="smart-preview">
              <li v-for="track in item.tracks.slice(0, 3)" :key="track.id" :title="describeAudio(track)">
                {{ track.title }} <em>{{ track.artist }}</em>
              </li>
              <li v-if="item.tracks.length === 0" class="muted">暂无符合条件的歌曲</li>
            </ul>
            <footer>
              <button class="ghost-button small" :disabled="item.tracks.length === 0" @click="playSmart(item.tracks)">播放全部</button>
              <button class="ghost-button small" :disabled="item.tracks.length === 0" @click="playShuffled(item.tracks)">随机播放</button>
            </footer>
          </article>
        </div>
      </section>

      <section class="section-block">
        <div class="section-heading">
          <div>
            <h3>全量曲库</h3>
            <p>
              {{ formatCount(visibleTracks.length) }} 首
              <template v-if="ui.searchQuery"> · 筛选「{{ ui.searchQuery }}」</template>
              <template v-else> · 支持标题、时长与添加时间排序</template>
            </p>
          </div>
          <!--
            The library page keeps only actions that are about the library itself.

            「自动补齐信息」and the ffmpeg check moved to 设置 → 曲库工具: they configure *how Aurora
            processes* files rather than showing you files, and they were sitting on top of the list
            competing with it.
          -->
          <div class="section-actions">
            <button class="ghost-button small" @click="addFiles">添加歌曲</button>
            <button class="ghost-button small" @click="addFolder">扫描文件夹</button>
            <button
              class="ghost-button small"
              data-testid="select-mode"
              :class="{ active: selectMode }"
              :title="selectMode ? '退出多选（Esc）' : '多选：批量加入歌单、移除或修改歌曲信息'"
              @click="toggleSelectMode"
            >
              {{ selectMode ? '退出多选' : '多选' }}
            </button>
            <button class="ghost-button small" :disabled="library.loading" @click="refresh">
              {{ library.loading ? '刷新中…' : '刷新' }}
            </button>
          </div>
        </div>

        <div v-if="library.scraping || library.scrapeProgress" class="import-banner">
          <span class="spinner"></span>
          <span>
            正在在线匹配缺失的封面与歌词
            <template v-if="library.scrapeProgress">
              （{{ library.scrapeProgress.processed }} / {{ library.scrapeProgress.total }}，已命中 {{ library.scrapeProgress.matched }}）
            </template>
          </span>
        </div>

        <div class="toolbar">
          <div class="chip-row library-tabs">
            <button
              v-for="item in tabs"
              :key="item.id"
              class="chip"
              :class="{ active: tab === item.id }"
              @click="tab = item.id; expanded = ''"
            >
              <span>{{ item.icon }}</span> {{ item.label }}
            </button>
          </div>
          <div class="toolbar-right">
            <label class="select-wrap">
              <span>排序</span>
              <select v-model="sortKey">
                <option v-for="option in sortOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
              </select>
            </label>
            <button class="ghost-button small" @click="sortAsc = !sortAsc">{{ sortAsc ? '↑ 升序' : '↓ 降序' }}</button>
          </div>
        </div>

        <!--
          The batch bar sits between the toolbar and the list, and only while something is selected.

          It repeats the two things a destructive batch needs: how many are affected, and a second
          press to confirm the removal. "Are you sure?" as a separate modal for one question costs more
          attention than the answer is worth.
        -->
        <div v-if="selectMode && selectedIds.length > 0" class="batch-bar" data-testid="batch-bar">
          <span class="batch-count" data-testid="batch-count">已选 {{ selectedIds.length }} 首</span>
          <div class="batch-actions">
            <button class="ghost-button small" @click="onSelectAll(true)">全选</button>
            <button class="ghost-button small" @click="invertSelection">反选</button>
            <button class="ghost-button small" data-testid="batch-clear" @click="clearSelection">清空</button>
            <button class="ghost-button small" data-testid="batch-playlist" @click="pickerTracks = [...selectedTracks]">
              加入歌单
            </button>
            <button class="ghost-button small" data-testid="batch-tags" @click="batchTagsOpen = true">修改信息</button>
            <template v-if="!confirmRemove">
              <button class="ghost-button small danger" data-testid="batch-remove" @click="confirmRemove = true">从音乐库移除</button>
            </template>
            <template v-else>
              <span class="batch-warning">文件不会被删除，只是从音乐库移除</span>
              <button class="ghost-button small danger" data-testid="batch-remove-confirm" :disabled="batchBusy" @click="batchRemove">
                {{ batchBusy ? '移除中…' : `确认移除 ${selectedIds.length} 首` }}
              </button>
              <button class="ghost-button small" data-testid="batch-remove-cancel" @click="confirmRemove = false">取消</button>
            </template>
          </div>
        </div>

        <template v-if="tab === 'songs'">
          <TrackList
            v-if="visibleTracks.length > 0"
            :tracks="visibleTracks"
            show-remove
            :selectable="selectMode"
            :selected-ids="selectedIds"
            @play="(track, index) => playList(visibleTracks, index)"
            @enqueue="enqueueNext"
            @favorite="toggleFavorite"
            @playlist="(track) => (pickerTracks = [track])"
            @reveal="reveal"
            @remove="removeFromLibrary"
            @contextmenu="openMenu"
            @select="onSelect"
            @select-all="onSelectAll"
          />
        </template>

        <template v-else>
          <ul v-if="groups.length > 0" class="group-list">
            <li v-for="group in groups" :key="group.key" class="group-item">
              <button class="group-head" @click="toggleGroup(group.key)">
                <span class="group-cover" :style="group.cover ? { backgroundImage: `url('${group.cover}')` } : {}">
                  <span v-if="!group.cover">{{ tab === 'folders' ? '▤' : tab === 'albums' ? '▣' : '☺' }}</span>
                </span>
                <span class="group-text">
                  <strong>{{ group.title }}</strong>
                  <small>{{ group.subtitle || `${group.tracks.length} 首` }}</small>
                </span>
                <span class="group-count">{{ formatCount(group.tracks.length) }} 首</span>
                <span class="group-chevron">{{ expanded === group.key ? '▾' : '▸' }}</span>
              </button>
              <div v-if="expanded === group.key" class="group-body">
                <div class="group-actions">
                  <button class="ghost-button small" @click="playList(group.tracks, 0)">播放全部</button>
                  <button class="ghost-button small" @click="playShuffled(group.tracks)">随机播放</button>
                </div>
                <MiniTrackRow
                  v-for="track in group.tracks"
                  :key="track.id"
                  :track="track"
                  :meta="tab === 'artists' ? track.album : tab === 'albums' ? track.artist : track.artist"
                  @play="playSingle"
                  @favorite="toggleFavorite"
                />
              </div>
            </li>
          </ul>
        </template>

        <EmptyState
          v-if="visibleTracks.length === 0"
          :icon="ui.searchQuery ? '⌕' : '▣'"
          :title="ui.searchQuery ? '没有匹配的本地音乐' : '音乐库是空的'"
          :text="ui.searchQuery ? '支持标题、艺术家、专辑、文件名，以及拼音首字母（如 zjl）。' : '添加本地文件或扫描一个音乐文件夹。'"
          hint="支持格式：MP3 · FLAC · WAV · M4A · AAC · OGG · OPUS"
        >
          <button v-if="ui.searchQuery" class="ghost-button" @click="ui.searchQuery = ''">清空筛选</button>
          <button v-else class="primary-button" @click="addFiles">添加音乐文件</button>
          <button v-if="!ui.searchQuery" class="secondary-button" @click="addFolder">扫描文件夹</button>
        </EmptyState>
      </section>
    </template>

    <TrackContextMenu
      v-if="menuState"
      :track="menuState.track"
      :x="menuState.x"
      :y="menuState.y"
      :actions="menuActions"
      @select="onMenuSelect"
      @close="menuState = null"
    />

    <TrackToolsDialog
      v-if="toolsState"
      :track="toolsState.track"
      :mode="toolsState.mode"
      @close="toolsState = null"
    />

    <PlaylistPicker v-if="pickerTracks" :tracks="pickerTracks" @close="pickerTracks = null" />

    <BatchTagDialog v-if="batchTagsOpen" :tracks="selectedTracks" @close="batchTagsOpen = false" />
  </div>
</template>
