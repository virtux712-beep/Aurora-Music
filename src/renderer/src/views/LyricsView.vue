<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import AmbientLayer from '../components/AmbientLayer.vue'
import AmbientBackdrop from '../components/lyrics/AmbientBackdrop.vue'
import ArtworkCanvas from '../components/lyrics/ArtworkCanvas.vue'
import LyricsViewport from '../components/lyrics/LyricsViewport.vue'
import SpectrumVisualizer from '../components/lyrics/SpectrumVisualizer.vue'
import VinylDisc from '../components/lyrics/VinylDisc.vue'
import { VINYL_MATERIAL_OPTIONS } from '../../../shared/vinyl'
import { formatLyricsOffset } from '../../../shared/lyrics'
import { PLAY_MODE_ICONS, PLAY_MODE_LABELS, usePlayerStore } from '../stores/player'
import { useLyricsStore } from '../stores/lyrics'
import { useCollectionStore } from '../stores/collection'
import { usePlatformStore } from '../stores/platform'
import { useSearchStore } from '../stores/search'
import { useSourceStore } from '../stores/source'
import { useUiStore } from '../stores/ui'
import { useTrackActions } from '../composables/useTrackActions'
import { bestQualityBadge } from '../utils/audio'
import { formatTime } from '../utils/format'
import { extractPalette, paletteFromSeed } from '../utils/palette'
import { safeExternalUrl, safeMediaUrl } from '../utils/url'

/**
 * 播放详情 / 沉浸歌词 — route `/lyrics`.
 *
 * Layout is one fluid two-column grid rather than stacked cards: the artwork and the song's identity
 * on the left, the lyric (or whatever is standing in for it) floating unboxed on the right, both over
 * a backdrop painted from the cover's own colours. Nothing here is a mock — the highlighted line comes
 * from `player.currentTime`, the spectrum from the playing audio, the record's rotation from
 * `player.isPlaying`, and the badges from the track's real source and qualities.
 */
type PanelView = 'lyrics' | 'spectrum' | 'vinyl'

const router = useRouter()
const player = usePlayerStore()
const lyrics = useLyricsStore()
const collection = useCollectionStore()
const platformStore = usePlatformStore()
const sourceStore = useSourceStore()
const search = useSearchStore()
const ui = useUiStore()
const { toggleFavorite, download } = useTrackActions()

const viewportRef = ref<InstanceType<typeof LyricsViewport> | null>(null)
/** Auto-follow paused because the user scrolled the sheet (owns the 「回到当前歌词」 button). */
const lyricsSuspended = ref(false)
const importOpen = ref(false)
const importDraft = ref('')
const menuOpen = ref(false)

const view = ref<PanelView>('lyrics')
/** Whether 「联网自动匹配」 has been asked for this track, so the empty state can say what happened. */
const autoTried = ref(false)

const track = computed(() => player.current)
const favorite = computed(() => (track.value ? collection.isFavorite(track.value.id) : false))
const sourceLabel = computed(() =>
  track.value?.origin === 'online'
    ? (platformStore.labelIfKnown(track.value.sourceId) ?? sourceStore.label(track.value.sourceId))
    : '本地音乐',
)
const sourceSupportsLyrics = computed(() => sourceStore.can('lyrics', track.value?.sourceId))
// While a deliberate match is running the panel stays put (buttons disabled, hint showing); only the
// millisecond-scale initial load hides it, so lyrics that do exist never flash an empty state.
const hasLyrics = computed(() => lyrics.available && !(lyrics.loading && !lyrics.matching))
const plainText = computed(() => lyrics.lyrics?.plain ?? '')
const quality = computed(() => (track.value ? bestQualityBadge(track.value) : null))
// Both of these come from a source rather than from Aurora, so they are validated before use.
const coverUrl = computed(() => safeMediaUrl(track.value?.cover))
const homepage = computed(() => safeExternalUrl(track.value?.homepage))
const seed = computed(() => track.value?.id ?? 'aurora')

/**
 * The artwork actually on screen: the track's cover, or the image the user uploaded for this track.
 * The artwork column owns that decision (it is the component that can change it), so it hands the
 * resolved source up and *both* the backdrop and the accent follow it — a user's own picture themes
 * the page exactly like a catalogue cover does.
 */
const artworkSource = ref<string | undefined>(undefined)

/** The ambient accent: the artwork's dominant colour, falling back to the deterministic seed palette. */
const accent = ref(paletteFromSeed(seed.value)[0] ?? '#8fa6ff')
let accentToken = 0

watch(
  () => [artworkSource.value, seed.value] as const,
  async ([source, currentSeed]) => {
    const mine = ++accentToken
    if (!source) {
      accent.value = paletteFromSeed(currentSeed)[0] ?? '#8fa6ff'
      return
    }
    const palette = await extractPalette(source, currentSeed)
    if (mine === accentToken) accent.value = palette[0] ?? '#8fa6ff'
  },
  { immediate: true },
)

/*
 * The accent is published for the chrome that sits *above* this page rather than inside it: the player
 * bar and the native title-bar strip are siblings of this page in the DOM, so they cannot inherit the
 * colour the room is lit by. Handing it to the store is what lets them follow the cover — a new song
 * re-tints the bar and the strip, over the same 900 ms the page's own transition takes.
 */
watch(accent, (value) => ui.setArtworkAccent(value), { immediate: true })

/** The song is instrumental when nothing in its lyric text is a word — a lyric sheet of pure "♪". */
const instrumental = computed(() => {
  const text = plainText.value || lyrics.lyrics?.lines.map((line) => line.text).join(' ') || ''
  return text.trim().length > 0 && !/[\p{L}\p{Script=Han}]/u.test(text)
})

/** A download button appears only when the row can really be turned into a file — same rule as the lists. */
const canDownload = computed(() => {
  const current = track.value
  if (!current || current.origin !== 'online') return false
  if (!current.sourceId) return false
  if (sourceStore.can('download', current.sourceId)) return true
  return (platformStore.healthFor(current.sourceId)?.resolverCount ?? 0) > 0
})

// A new song resets the per-track bits: view choice, the auto-match attempt, and the open menu.
watch(
  () => track.value?.id,
  () => {
    autoTried.value = false
    menuOpen.value = false
    void lyrics.load(track.value)
  },
  { immediate: true },
)

// The lyric panel is only the default *when there are lyrics*: a song without them should open on the
// spectrum rather than on an empty state nobody asked for.
watch(
  () => [track.value?.id, hasLyrics.value] as const,
  () => {
    if (hasLyrics.value) view.value = 'lyrics'
    else if (view.value === 'lyrics') view.value = 'spectrum'
  },
  { immediate: true },
)

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  if (importOpen.value) {
    importOpen.value = false
    return
  }
  if (menuOpen.value) {
    menuOpen.value = false
    return
  }
  if (ui.immersive) {
    event.preventDefault()
    void ui.setImmersive(false)
  }
}

function onDocumentClick(): void {
  menuOpen.value = false
}

onMounted(() => {
  ui.initImmersiveSync()
  window.addEventListener('keydown', onKeydown)
  document.addEventListener('click', onDocumentClick)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  document.removeEventListener('click', onDocumentClick)
})

function close(): void {
  if (ui.immersive) void ui.setImmersive(false)
  void router.push('/')
}

function openImport(): void {
  importDraft.value = plainText.value || lyrics.lyrics?.lines.map((line) => line.text).join('\n') || ''
  importOpen.value = true
}

async function submitImport(): Promise<void> {
  const ok = await lyrics.importText(importDraft.value)
  if (ok) {
    ui.notify('歌词已保存到本机', 'success')
    importOpen.value = false
    viewportRef.value?.resumeFollowing()
  } else {
    ui.notify(lyrics.error || '歌词保存失败', 'error')
  }
}

/**
 * 「联网自动匹配」 hands the track to the LyricsManager (local files first, then LRCLIB and the domestic
 * catalogue) and reports what actually happened. It cannot invent lyrics no catalogue has, so a miss
 * says which sources were asked instead of pretending something matched.
 */
async function autoMatch(): Promise<void> {
  autoTried.value = true
  await lyrics.load(track.value, true)
  if (hasLyrics.value) {
    ui.notify(`已匹配到「${lyrics.originLabel || sourceLabel.value}」的歌词`, 'success')
    view.value = 'lyrics'
  } else if (lyrics.report?.instrumental) {
    ui.notify(`「${lyrics.report.label}」标记这首歌为纯音乐`)
  } else {
    const tried = lyrics.triedLabels
    ui.notify(
      tried.length > 0 ? `已尝试 ${tried.join('、')}，这首歌都没有可用的歌词` : '这首歌都没有可用的歌词',
    )
  }
}

/** The line under the empty state: what was asked, and what it means. Always the real report. */
const lyricMissNote = computed(() => {
  if (lyrics.report?.instrumental) return `「${lyrics.report.label}」把这首歌标记为纯音乐，因此没有歌词。`
  const tried = lyrics.triedLabels
  if (tried.length > 0) {
    return `已联网尝试 ${tried.join('、')}，这首歌都没有可用的歌词；仍可打开「频谱律动」或「拟真唱片」。`
  }
  return '这首歌都没有可用的歌词，仍可打开「频谱律动」或「拟真唱片」。'
})

async function clearLyrics(): Promise<void> {
  await lyrics.clearCurrent()
  ui.notify('已清除本机保存的歌词', 'info')
}

function searchSimilar(): void {
  const current = track.value
  if (!current) return
  // A real search, with a real query: title + artist, then the online page.
  search.searchKeyword(`${current.title} ${current.artist}`.trim())
  void router.push('/search')
}
</script>

<template>
  <Teleport to="body">
    <section
      class="lyrics-page"
      :class="{ immersive: ui.immersive }"
      :style="{ '--amb-accent': accent }"
      aria-label="播放详情"
    >
      <AmbientBackdrop :cover="artworkSource ?? track?.cover" :seed="seed" />
      <!-- The same ambient layer the shell runs, at a higher density: this page is a whole space rather
           than a panel, so its atmosphere is allowed to be more present than the app's. -->
      <AmbientLayer
        :particles="ui.effectPlan?.ambient.particles ?? 'none'"
        :density="ui.effectPlan?.ambient.density ?? 0"
        :speed="ui.effectPlan?.ambient.speed ?? 0"
        :react="ui.effectPlan?.ambient.react ?? 0"
        :dpr="1.5"
        :drift-seconds="ui.activeSkin.effects.driftSeconds"
        :glow="0"
        :enabled="ui.animationLevel !== 'off'"
        :boost="2.4"
      />

      <header class="lp-head">
        <button class="glass-icon-button" title="返回" aria-label="返回" @click="close">←</button>
        <div class="lp-head-status">
          <span v-if="lyrics.wordTimings" class="badge-source">逐字同步</span>
          <span v-else-if="lyrics.synced" class="badge-source">逐行同步</span>
          <span v-else-if="hasLyrics" class="badge-source">纯文本歌词</span>
        </div>
      </header>

      <div class="lp-grid">
        <aside v-if="!ui.immersive" class="lp-left">
          <ArtworkCanvas
            :track-id="track?.id"
            :cover="coverUrl"
            :seed="seed"
            :title="track?.title"
            @update:source="artworkSource = $event"
          />

          <div class="lp-meta">
            <h1 class="lp-title" :title="track?.title">{{ track?.title ?? '还没有播放任何音乐' }}</h1>
            <p class="lp-sub">
              <span>{{ track?.artist ?? '从音乐库或搜索页选择一首开始' }}</span>
              <template v-if="track?.album"><i class="lp-dot">·</i><span>{{ track.album }}</span></template>
            </p>
            <div class="lp-badges">
              <em v-if="track" class="badge-source">{{ sourceLabel }}</em>
              <em v-if="quality" class="lp-quality" :class="quality.tone" :data-tier="quality.tier" :title="quality.title">
                {{ quality.name }} · {{ quality.icon }} {{ quality.label }}
              </em>
              <em v-if="track?.license" class="badge-license" :title="track.license">开放授权</em>
              <em v-if="player.isLive" class="badge-source">LIVE</em>
            </div>
          </div>

          <div class="lp-actions">
            <button
              class="glass-icon-button"
              :class="{ active: favorite }"
              :disabled="!track"
              :title="favorite ? '取消收藏' : '收藏'"
              @click="track && toggleFavorite(track)"
            >{{ favorite ? '♥' : '♡' }}</button>
            <button class="glass-icon-button" :disabled="!track" title="搜索相似音乐" @click="searchSimilar">⌕</button>
            <button class="glass-icon-button" :disabled="!canDownload" title="下载到本地音乐库" @click="track && download(track)">⇩</button>
            <div class="lp-more">
              <button class="glass-icon-button" :disabled="!track" title="更多操作" @click.stop="menuOpen = !menuOpen">···</button>
              <div v-if="menuOpen" class="lp-menu" @click.stop>
                <!--
                  Lyric timing, right where the lyrics are.

                  The canonical control is in 设置 (with a value that can be read at a glance), but the moment
                  someone notices "the words are late" is while listening, so the correction is also one click
                  away here. Both call the same store action, so there is one value and one writer.
                -->
                <button data-testid="lyric-offset-earlier-inline" @click="lyrics.nudgeOffset(-1)">
                  歌词提前 100 ms（当前 {{ formatLyricsOffset(lyrics.offsetMs) }}）
                </button>
                <button data-testid="lyric-offset-later-inline" @click="lyrics.nudgeOffset(1)">歌词延后 100 ms</button>
                <button @click="openImport">导入歌词（LRC / 文本）</button>
                <button :disabled="lyrics.lyrics?.origin !== 'user'" @click="clearLyrics">清除本机歌词</button>
                <button @click="ui.toggleImmersive()">{{ ui.immersive ? '退出沉浸模式' : '进入沉浸模式' }}</button>
                <button @click="router.push('/settings/sources')">查看音源能力</button>
                <a v-if="homepage" :href="homepage" target="_blank" rel="noreferrer">查看来源</a>
              </div>
            </div>
          </div>
        </aside>

        <section class="lp-right">
          <div class="lp-panel-head">
            <!-- The header holds the view switcher and nothing else: the lyric-colour choice is a saved
                 preference, not a per-glance control, so it lives in 设置 with the rest of them instead of
                 adding a fourth button to this row. -->
            <div class="lp-viewswitch" role="tablist" aria-label="视图">
              <button :class="{ active: view === 'lyrics' }" @click="view = 'lyrics'">歌词</button>
              <button :class="{ active: view === 'spectrum' }" @click="view = 'spectrum'">频谱律动</button>
              <button :class="{ active: view === 'vinyl' }" @click="view = 'vinyl'">拟真唱片</button>
            </div>
          </div>

          <div class="lp-body">
            <div v-if="!track" class="lp-empty">
              <p class="lp-empty-title">还没有正在播放的歌曲</p>
              <p class="lp-empty-hint">从音乐库或搜索页播放一首歌，歌词会自动跟随播放进度。</p>
              <div class="lp-empty-actions">
                <button class="glass-button primary" @click="router.push('/search')">去搜索</button>
                <button class="glass-button" @click="router.push('/')">回到本地音乐</button>
              </div>
            </div>

            <div v-else-if="lyrics.loading" class="lyrics-skeleton">
              <span v-for="row in 7" :key="row" class="skeleton-line" :style="{ width: `${40 + ((row * 13) % 45)}%` }"></span>
            </div>

            <div v-else-if="lyrics.error" class="lp-empty">
              <p class="lp-empty-title">歌词加载失败</p>
              <p class="lp-empty-hint">{{ lyrics.error }}</p>
              <div class="lp-empty-actions">
                <button class="glass-button primary" @click="lyrics.load(track, true)">重试</button>
              </div>
            </div>

            <!-- The empty state is deliberately unboxed: no card, no border, just text over colour. -->
            <div v-else-if="view === 'lyrics' && !hasLyrics && !plainText" class="lp-empty">
              <p class="lp-empty-title">{{ instrumental ? '纯音乐 / 暂无歌词' : '暂无歌词' }}</p>
              <p class="lp-empty-hint">
                尚未匹配到 LRC 歌词文件
                <span class="lp-info" tabindex="0" role="note" aria-label="音源说明">
                  ⓘ
                  <span class="lp-tooltip">
                    Aurora 依次查找：你导入的歌词、同名 .lrc 文件、本机歌词缓存、音频内嵌歌词，然后才联网查询公开歌词库（LRCLIB / 国内接口），命中的歌词会缓存到本机。
                    <template v-if="track.origin === 'online'">
                      本曲音源「{{ sourceLabel }}」{{ sourceSupportsLyrics ? '没有为这首歌返回歌词。' : '未声明 lyrics 能力。' }}
                    </template>
                  </span>
                </span>
              </p>
              <div class="lp-empty-actions">
                <button class="glass-button primary" @click="openImport">📥 手动导入 LRC 歌词</button>
                <button class="glass-button" :disabled="lyrics.loading" @click="autoMatch">🔍 联网自动匹配</button>
              </div>
              <p v-if="lyrics.matching" class="lp-empty-note">正在联网查找歌词…</p>
              <p v-else-if="autoTried" class="lp-empty-note">{{ lyricMissNote }}</p>
            </div>

            <div v-else-if="view === 'spectrum'" class="lp-panel-view">
              <SpectrumVisualizer :accent="accent" />
            </div>

            <div v-else-if="view === 'vinyl'" class="lp-panel-view lp-vinyl-panel">
              <VinylDisc :cover="artworkSource ?? coverUrl" :seed="seed" :title="track.title" />
              <!--
                The pressing is chosen next to the record rather than in 设置: it is a property of what you
                are looking at, and changing it has to be one click away from the object it repaints.
              -->
              <div class="vinyl-materials" role="group" aria-label="唱片材质">
                <button
                  v-for="option in VINYL_MATERIAL_OPTIONS"
                  :key="option.id"
                  :class="{ active: ui.vinylMaterial === option.id }"
                  :title="option.hint"
                  @click="ui.setVinylMaterial(option.id)"
                >
                  {{ option.label }}
                </button>
              </div>
            </div>

            <!--
              The scroll area fades at both edges, so lines enter and leave instead of being cut off by a hard
              border. The resume button is a *sibling* of that area rather than a child: a mask applies to a
              whole subtree, so a pill inside it would be faded away exactly where it has to be readable.
            -->
            <div v-else class="lyrics-pane">
              <div class="lyrics-scroll" @dblclick="ui.toggleImmersive()">
                <LyricsViewport
                  v-if="lyrics.synced && lyrics.lyrics"
                  ref="viewportRef"
                  v-model:suspended="lyricsSuspended"
                  :lines="lyrics.lyrics.lines"
                  :active-index="lyrics.activeIndex"
                  :active-word-index="lyrics.activeWordIndex"
                  :synced="lyrics.synced"
                  @seek="lyrics.seekToLine"
                />
                <div v-else class="lyrics-plain">
                  <p v-for="(line, index) in plainText.split('\n')" :key="index">{{ line || ' ' }}</p>
                </div>
              </div>
              <button v-if="lyricsSuspended" class="lyrics-resume" @click="viewportRef?.resumeFollowing()">
                回到当前歌词 ↓
              </button>
            </div>
          </div>
        </section>
      </div>

      <!--
        There is deliberately no transport here.
       
        This page used to carry its own copy of the bottom strip (progress, play/pause, volume, queue) in the
        same 100px as the app-wide player bar. Two strips stacked in one place is a layout bug on its own, but
        it also hid the bar's controls: the page sits at `--z-overlay`, the bar was at 20, so the *page's*
        containers — transparent but hit-testable — swallowed every click aimed at the bar. That is why the
        quality picker could be opened but never used from this page. The bar is the app's single transport
        and it now floats above the page, so this copy is redundant.
      -->

      <div v-if="importOpen" class="modal-backdrop" @click.self="importOpen = false">
        <div class="modal-card wide" role="dialog" aria-label="导入歌词">
          <header class="modal-head">
            <div>
              <strong>导入歌词</strong>
              <span class="muted small-text">支持 LRC（含逐字时间轴）与纯文本，保存在本机</span>
            </div>
            <button class="icon-button" title="关闭" @click="importOpen = false">✕</button>
          </header>
          <div class="modal-body">
            <textarea
              v-model="importDraft"
              class="lyrics-textarea"
              rows="12"
              placeholder="[00:12.30]第一句歌词&#10;[00:16.80]第二句歌词"
              spellcheck="false"
            ></textarea>
            <div class="modal-create">
              <span class="muted small-text">带时间戳时会自动启用逐行同步；带 &lt;mm:ss.xx&gt; 时启用逐字高亮。</span>
              <button class="primary-button small" :disabled="lyrics.importing" @click="submitImport">
                {{ lyrics.importing ? '保存中…' : '保存' }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  </Teleport>
</template>
