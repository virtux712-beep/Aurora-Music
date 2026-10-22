<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AmbientLayer from './components/AmbientLayer.vue'
import AppSidebar from './components/AppSidebar.vue'
import AuroraLab from './components/AuroraLab.vue'
import PlayerBar from './components/PlayerBar.vue'
import QueueDrawer from './components/QueueDrawer.vue'
import TopBar from './components/TopBar.vue'
import { useCollectionStore } from './stores/collection'
import { useDownloadStore } from './stores/downloads'
import { useLibraryStore } from './stores/library'
import { usePlayerStore } from './stores/player'
import { useSoundStore } from './stores/sound'
import { useLyricsStore } from './stores/lyrics'
import { usePlatformStore } from './stores/platform'
import { usePlaylistStore } from './stores/playlists'
import { useSearchStore } from './stores/search'
import { useSourceStore } from './stores/source'
import { useUiStore } from './stores/ui'
import { libraryService, settingsService } from './services/aurora'
import type { AudioTrack } from '../../shared/types'

const QUEUE_KEY = 'aurora:queue'

const ui = useUiStore()
const player = usePlayerStore()
const sound = useSoundStore()
const lyrics = useLyricsStore()
/** Stops the shared music→visuals loop when the shell unmounts (it owns the audio subscription). */
let stopEnergyLoop: (() => void) | null = null
/** Whether the Aurora Lab overlay is up (Ctrl+Shift+A). Shell-local: nothing else needs to know. */
const labOpen = ref(false)
/** The listening-record tick, cleared when the shell goes away. */
let listeningTimer = 0
const library = useLibraryStore()
const collection = useCollectionStore()
const downloads = useDownloadStore()
const playlists = usePlaylistStore()
const sourceStore = useSourceStore()
const platformStore = usePlatformStore()
const search = useSearchStore()
const router = useRouter()
const route = useRoute()

function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  if (!element) return false
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) || element.isContentEditable
}

async function focusSearch(): Promise<void> {
  if (route.name !== 'search') await router.push('/search')
  await nextTick()
  const input = document.querySelector<HTMLInputElement>('.search-wrap input')
  input?.focus()
  input?.select()
}

async function toggleFullscreen(): Promise<void> {
  try {
    if (document.fullscreenElement) await document.exitFullscreen()
    else await document.documentElement.requestFullscreen()
  } catch {
    // Fullscreen requires a user gesture in some environments; ignore failures.
  }
}

/*
 * Drag-and-drop import.
 *
 * The shell owns it rather than the library page: dropping music onto the window is how people add files to a
 * player, and making them find the right page first would be the only reason the gesture did not work.
 *
 * `dragDepth` counts entries and leaves because `dragleave` also fires when the pointer crosses into a child
 * element — a boolean flag flickers the overlay on every internal boundary, so the counter is what makes the
 * highlight sit still.
 */
const dropActive = ref(false)
let dragDepth = 0

function isFileDrag(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files')
}

function onDragEnter(event: DragEvent): void {
  if (!isFileDrag(event)) return
  event.preventDefault()
  dragDepth += 1
  dropActive.value = true
}

function onDragOver(event: DragEvent): void {
  if (!isFileDrag(event)) return
  // Without preventDefault Chromium refuses the drop and opens the file instead.
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
}

function onDragLeave(event: DragEvent): void {
  if (!isFileDrag(event)) return
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0) dropActive.value = false
}

/**
 * Imports what was dropped, and says which of the four outcomes actually happened.
 *
 * "Nothing was added" has four different causes and they need different words: an empty space the bridge
 * cannot resolve, files that are not audio, files that are already in the library, and a genuine read
 * failure. Reporting all four as "导入失败" would be the same kind of lie as a fake button.
 */
async function onDrop(event: DragEvent): Promise<void> {
  if (!isFileDrag(event)) return
  event.preventDefault()
  dragDepth = 0
  dropActive.value = false

  const files = Array.from(event.dataTransfer?.files ?? [])
  if (files.length === 0) return
  const paths = libraryService.pathsForFiles(files)
  if (paths.length === 0) {
    ui.notify(`无法读取拖入文件的位置：请改用「添加文件」或「扫描文件夹」`, 'error')
    return
  }

  const result = await library.importPaths(paths)
  if (result.added > 0) {
    const rest: string[] = []
    if (result.duplicated > 0) rest.push(`${result.duplicated} 首已在库中`)
    if (result.failed > 0) rest.push(`${result.failed} 首读取失败`)
    if (result.unsupported > 0) rest.push(`${result.unsupported} 个文件不是音频`)
    ui.notify(`已导入 ${result.added} 首${rest.length > 0 ? `（${rest.join('，')}）` : ''}`, 'success')
    return
  }
  if (result.duplicated > 0) ui.notify(`拖入的 ${result.duplicated} 首都已经在音乐库里`, 'info')
  else if (result.unsupported > 0) ui.notify(`拖入的 ${result.unsupported} 个文件不是支持的音频格式`, 'error')
  else if (result.failed > 0) ui.notify(`有 ${result.failed} 个文件没能读取（可能已损坏或被占用）`, 'error')
  else ui.notify('拖入的内容里没有找到可导入的音乐', 'info')
}

/**
 * Global shortcuts. The existing set (space / arrows / Ctrl+K) is preserved and extended with the
 * lyrics and fullscreen entries; page-specific keys stay inside their pages.
 */
function onKeydown(event: KeyboardEvent): void {
  const withModifier = event.ctrlKey || event.metaKey

  if (event.code === 'F11') {
    event.preventDefault()
    if (route.name === 'lyrics') ui.toggleImmersive()
    else void toggleFullscreen()
    return
  }

  if (withModifier && event.shiftKey && event.key.toLowerCase() === 'l') {
    event.preventDefault()
    void router.push('/lyrics')
    return
  }

  /*
   * Aurora Lab — the hidden instrument panel.
   *
   * Shift+Ctrl+A rather than a plain key: it is a diagnostic overlay, and a bare letter would fight the
   * page-level shortcuts. It opens over whatever page is showing, including the lyrics page, because the
   * frame numbers are most interesting exactly when the heavy visuals are running.
   */
  if (withModifier && event.shiftKey && event.key.toLowerCase() === 'a') {
    event.preventDefault()
    labOpen.value = !labOpen.value
    return
  }

  if (withModifier && (event.key.toLowerCase() === 'k' || event.key.toLowerCase() === 'f')) {
    event.preventDefault()
    void focusSearch()
    return
  }

  if (isTypingTarget(event.target)) return

  if (event.code === 'Space') {
    event.preventDefault()
    player.toggle()
    return
  }
  if (event.code === 'ArrowRight') {
    event.preventDefault()
    player.seek(player.currentTime + 5)
    return
  }
  if (event.code === 'ArrowLeft') {
    event.preventDefault()
    player.seek(player.currentTime - 5)
    return
  }
  if (withModifier && event.code === 'ArrowUp') {
    event.preventDefault()
    player.setVolume(player.volume + 0.05)
    return
  }
  if (withModifier && event.code === 'ArrowDown') {
    event.preventDefault()
    player.setVolume(player.volume - 0.05)
  }
}

function restoreQueue(): void {
  try {
    const raw = localStorage.getItem(QUEUE_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw) as { ids?: string[]; index?: number; currentId?: string }
    const ids = Array.isArray(parsed.ids) ? parsed.ids : []
    /*
     * The snapshot stores ids, and an id that no longer resolves (a local file that moved, an online
     * track whose metadata snapshot was evicted) simply drops out of the restored queue. That is what
     * makes the *position* the wrong thing to restore: index 7 of the old queue is not index 7 of the
     * shorter one, so the app reopened on a different song — right queue, wrong track, and with it the
     * wrong cover and the wrong lyrics, which reads as "my music changed by itself".
     *
     * So the current track is remembered by id and looked up again; the old index is only the fallback
     * for a snapshot written before the id was stored, and is always clamped into the restored queue.
     */
    const tracks = library.byIds(ids)
    if (tracks.length === 0) return
    const remembered = typeof parsed.currentId === 'string' ? parsed.currentId : ''
    const found = remembered ? tracks.findIndex((track) => track.id === remembered) : -1
    const fallback = typeof parsed.index === 'number' ? parsed.index : 0
    player.replaceQueue(tracks, found >= 0 ? found : Math.min(Math.max(fallback, 0), tracks.length - 1))
  } catch {
    // A corrupt queue snapshot is not worth failing startup over.
  }
}

watch(
  () => player.queue.map((track: AudioTrack) => track.id).join('|'),
  () => {
    try {
      localStorage.setItem(
        QUEUE_KEY,
        JSON.stringify({
          ids: player.queue.slice(0, 500).map((track) => track.id),
          index: player.currentIndex,
          // Stored alongside the index because only the id survives a queue that comes back shorter.
          currentId: player.current?.id ?? '',
        }),
      )
    } catch {
      // Ignore storage failures.
    }
  },
)

// Each page renders inside its own scroll container, which the router cannot manage for us.
watch(
  () => route.fullPath,
  async () => {
    await nextTick()
    document.querySelector('.content-scroll')?.scrollTo({ top: 0 })
  },
)

/*
 * The playback-detail page owns the window while it is open, and it is a night room in every theme —
 * including a light one. Two pieces of chrome float above it and follow the app's mode instead: the
 * player bar and the strip Windows draws the window buttons on. Left alone they stay cream, so the two
 * brightest objects on screen are the two that ignore the room they are in. Announcing the route is
 * what lets them resolve the skin's dark variant for exactly as long as the page is up.
 *
 * Leaving must not leave the app stuck in immersive fullscreen either, which is the same transition.
 */
watch(
  () => route.name,
  (name) => {
    const onNightPage = name === 'lyrics'
    ui.setNightPage(onNightPage)
    if (!onNightPage && ui.immersive) void ui.setImmersive(false)
  },
  { immediate: true },
)

watch(() => player.isPlaying, (value) => ui.setPlaying(value))

/*
 * The two "music drives the picture" cues that are *moments* rather than states.
 *
 * Both are watched here, in the shell, for the same reason the energy loop is: this is the one place that
 * outlives every page, so a skip from the search page and a skip from the queue drawer behave identically.
 */
watch(
  () => player.current?.id ?? '',
  (id, previous) => {
    // Any change of *identity* sweeps, including "nothing → the restored last song": that is the moment the
    // window goes from an empty room to a space, which is the same gesture from the user's side.
    if (id && id !== previous) {
      ui.signalTrackChange()
      /*
       * …and the bookkeeping that belongs to "a song started".
       *
       * Separated from the sweep because they are different kinds of thing: the sweep is a visual *signal*
       * (and disappears at 节能), while the record and the easter eggs are state that must count what
       * happened even when nothing is drawn for it.
       */
      ui.noteTrackStart(id)
    }
  },
)

/*
 * Pressing play on the song the app restored counts as listening.
 *
 * The identity watcher above misses it — nothing changed, so nothing fired — and a listening record that
 * ignores the most common way an evening starts would be wrong about the thing it exists to measure. The
 * store deduplicates by id, so a pause/resume of the same song counts once.
 */
watch(
  () => player.isPlaying,
  (playing) => {
    if (playing) ui.noteTrackStart(player.current?.id ?? '')
  },
)

watch(
  () => (player.muted ? 0 : player.volume),
  (level, previous) => ui.signalVolume(level, level - (typeof previous === 'number' ? previous : level)),
  { immediate: true },
)

onMounted(async () => {
  // Theme is initialised before mount in main.ts; only the fullscreen listener is bound here.
  ui.initImmersiveSync()
  /*
   * The listening record, one second at a time.
   *
   * A one-second timer rather than counting frames or slicing the audio clock: the number this produces is
   * "how long did I have music playing", which is a wall-clock question. Paused seconds do not count, and
   * the store flushes to storage every twenty of them so a crash costs at most that much.
   */
  ui.initCompanion()
  listeningTimer = window.setInterval(() => {
    if (player.isPlaying) ui.tickListening(1)
  }, 1000)
  /*
   * Music → visuals, wired once for the whole session.
   *
   * `isPlaying` is mirrored into the ui store (CSS reads it as `data-playing`), and the energy loop is
   * started here because it needs the player's audio element — which the player store creates during
   * setup, i.e. before this runs.
   */
  ui.setPlaying(player.isPlaying)
  /*
   * Music → visuals only. The frame measurement that used to be bolted onto this loop is gone: it lived
   * here because both jobs wanted the same tick, which meant a theme with no music coupling had no
   * performance guard at all. `visual/frame.ts` now runs its own loop from `initTheme`.
   */
  stopEnergyLoop = ui.startEnergy(() => player.audio)
  /*
   * Warm the settings cache before the first resolve can happen.
   *
   * The playback path is synchronous where it matters (a double-click decides a quality and starts a
   * request), so it reads `settingsService.cached()` rather than awaiting a round trip — which means
   * something has to have filled it. Doing it here also means a restored queue plays at the user's chosen
   * tier rather than at the default for the first song.
   */
  void settingsService.refresh()
  /*
   * The sound block (EQ / loudness / output device / gapless / crossfade) is read once here and pushed
   * into the audio engine. It has to happen before the first play, not when the settings page is first
   * opened: a stored EQ curve is a property of the player, and a song that starts at a flat response
   * would make the setting look lost until the page was visited.
   */
  void sound.load()
  /*
   * The lyric offset is read with the rest of the startup settings: it is added to the playback clock, so a
   * session that started before it was loaded would show uncorrected lyrics on the immersive page and in the
   * desktop strip until some later page happened to read it.
   */
  void lyrics.initOffset()
  collection.init()
  playlists.init()
  // Subscribed once for the whole session: progress pushes then reach the sidebar badge and the
  // downloads page even before that page is opened.
  downloads.init()
  search.initHistory()
  await library.load()
  library.startProgressListener()
  // A finished download, a metadata pass or a conversion all change the library from the main
  // process side; these two keep the 本地音乐 page in step without a manual refresh.
  library.startLibraryChangeListener()
  library.startScrapeProgressListener()
  collection.dropInvalid(new Set([...library.tracks.map((track) => track.id), ...Object.keys(library.onlineSnapshots)]))
  restoreQueue()
  // Loaded app-wide because the player bar labels the current track's origin, and the source
  // manager page needs the resolver counts before it is opened.
  void sourceStore.load()
  void platformStore.load()
  window.addEventListener('keydown', onKeydown)
  /*
   * Drag-and-drop import, bound to the window so it works on every page.
   *
   * `dragover` must be prevented as well as `drop`: without it Chromium refuses the drop and the file ends
   * up being *opened* by the window instead, which for a player would mean navigating away from the app.
   */
  window.addEventListener('dragenter', onDragEnter)
  window.addEventListener('dragover', onDragOver)
  window.addEventListener('dragleave', onDragLeave)
  window.addEventListener('drop', onDrop)
})

onBeforeUnmount(() => {
  downloads.dispose()
  stopEnergyLoop?.()
  window.clearInterval(listeningTimer)
  // The last partial minute is still the user's.
  ui.flushCompanion()
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('dragenter', onDragEnter)
  window.removeEventListener('dragover', onDragOver)
  window.removeEventListener('dragleave', onDragLeave)
  window.removeEventListener('drop', onDrop)
})
</script>

<template>
  <div class="app-shell">
    <!-- The window's drag strip (the native caption is hidden, see main/index.ts). -->
    <div class="titlebar" aria-hidden="true" />
    <!--
      The skin's atmosphere, behind everything and behind every page.

      Mounted once here rather than per page: the layer belongs to the window, and re-creating its
      particles on every navigation would both cost frames and make the drift visibly restart. It is
      `pointer-events: none`, so nothing above it can be shadowed by it.
    -->
    <AmbientLayer
      :particles="ui.effectPlan?.ambient.particles ?? 'none'"
      :density="ui.effectPlan?.ambient.density ?? 0"
      :speed="ui.effectPlan?.ambient.speed ?? 0"
      :react="ui.effectPlan?.ambient.react ?? 0"
      :dpr="ui.effectPlan?.level === 'standard' || ui.effectPlan?.level === 'immersive' ? 1.5 : 1"
      :drift-seconds="ui.activeSkin.effects.driftSeconds"
      :glow="ui.activeSkin.effects.glow"
      :enabled="ui.animationLevel !== 'off'"
    />
    <!--
      The track-change sweep: one composited layer the theme paints in its own colour when the song changes
      (see `signalTrackChange`). It sits above the ambience but below the shell's own chrome, is
      `pointer-events: none`, and is fully transparent until the animation runs — so at 关闭/节能, where the
      signal never fires, it is a single invisible div.
    -->
    <div class="scene-sweep" aria-hidden="true" />
    <AppSidebar />

    <main class="main-content">
      <!-- 在线音乐 is a search terminal: its own hero search replaces the global bar. -->
      <TopBar v-if="route.name !== 'search'" />
      <section class="content-scroll">
        <RouterView v-slot="{ Component }">
          <component :is="Component" />
        </RouterView>
      </section>
    </main>

    <QueueDrawer />
    <PlayerBar />

    <div class="toast-stack" aria-live="polite">
      <div v-for="toast in ui.toasts" :key="toast.id" class="toast" :class="toast.tone">
        <span>{{ toast.message }}</span>
        <button class="toast-close" @click="ui.dismissToast(toast.id)">✕</button>
      </div>
    </div>

    <!-- The hidden instrument panel (Ctrl+Shift+A). Mounted only while open, so it costs exactly nothing
         when closed — a polling overlay that is always mounted would be measuring itself. -->
    <AuroraLab v-if="labOpen" @click.self="labOpen = false" />

    <!--
      Signal Lost (彩蛋 5).

      Half a second, no controls, `aria-hidden` — it is a glitch, and a glitch you can interact with is a
      dialog. The chance is one in ~250 track changes and the store cools it down, so this element almost
      never exists.
    -->
    <div v-if="ui.signalLost" class="signal-lost" aria-hidden="true">
      <span>Aurora Signal Lost…</span>
    </div>

    <!--
      The drop target's visible answer. `aria-hidden` because it appears and disappears with the pointer —
      announcing it would interrupt a screen reader for something the user is already doing with their hands.
    -->
    <div v-if="dropActive" class="drop-veil" data-testid="drop-veil" aria-hidden="true">
      <div class="drop-card">
        <span class="drop-icon">⇣</span>
        <strong>松开即可导入</strong>
        <small>支持 MP3 · FLAC · WAV · M4A · OGG · OPUS，也可以直接拖入整个文件夹</small>
      </div>
    </div>
  </div>
</template>
