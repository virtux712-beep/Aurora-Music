<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { AudioTrack, PlatformId } from '../../../shared/types'
import { useTrackActions } from '../composables/useTrackActions'
import { useCollectionStore } from '../stores/collection'
import { useLibraryStore } from '../stores/library'
import { usePlatformStore } from '../stores/platform'
import { usePlayerStore } from '../stores/player'
import { useSourceStore } from '../stores/source'
import { bestQualityBadge } from '../utils/audio'
import { coverStyle as buildCoverStyle } from '../utils/cover'
import { formatTime } from '../utils/format'
import { platformBadgeStyle } from '../utils/platformDisplay'

const props = withDefaults(
  defineProps<{
    tracks: AudioTrack[]
    showAlbum?: boolean
    showRemove?: boolean
    /**
     * Multi-select mode.
     *
     * Deliberately a mode rather than always-on checkboxes: a checkbox column costs width on every
     * row, and the list is the product's densest surface. Opting in is one click, and while it is off
     * the rows behave exactly as they always have.
     */
    selectable?: boolean
    /** Selected track ids. A plain array keeps the prop cheap to compare in the virtualised rows. */
    selectedIds?: string[]
  }>(),
  { showAlbum: true, showRemove: false, selectable: false, selectedIds: () => [] },
)

const emit = defineEmits<{
  (event: 'play', track: AudioTrack, index: number): void
  (event: 'enqueue', track: AudioTrack): void
  (event: 'favorite', track: AudioTrack): void
  (event: 'playlist', track: AudioTrack): void
  (event: 'reveal', track: AudioTrack): void
  (event: 'remove', track: AudioTrack): void
  /** Right-click: the row hands its track and the pointer position to whoever owns the menu. */
  (event: 'contextmenu', track: AudioTrack, x: number, y: number): void
  /**
   * A row was clicked in select mode.
   *
   * The modifier is forwarded rather than interpreted here: only the list's owner knows what the
   * previous click was, and a shift-range needs that memory.
   */
  (event: 'select', track: AudioTrack, index: number, shift: boolean): void
  /** The header checkbox: all of the *visible* tracks, which is what the user is looking at. */
  (event: 'select-all', selected: boolean): void
}>()

const ROW_HEIGHT = 54
const OVERSCAN = 8

const player = usePlayerStore()
const collection = useCollectionStore()
const library = useLibraryStore()
const sourceStore = useSourceStore()
const platformStore = usePlatformStore()
const { download } = useTrackActions()

/**
 * A download button appears when the row can actually be turned into a file, which is one of two
 * things depending on what the track is:
 *
 *  - a track from a *user source*: that source must advertise `download`;
 *  - a track from a *platform*: at least one enabled source must be able to resolve that platform
 *    (the download manager resolves the URL itself, so a resolver is exactly what it needs).
 *
 * Neither branch is a hardcoded list of platforms.
 */
function canDownload(track: AudioTrack): boolean {
  if (track.origin !== 'online') return false
  if (sourceStore.can('download', track.sourceId)) return true
  const platformId = track.sourceId as PlatformId
  if (!platformStore.byId.has(platformId)) return false
  return (platformStore.healthFor(platformId)?.resolverCount ?? 0) > 0
}

/*
 * The quality badge reads the qualities *this song* is published in (online) or its own container facts
 * (local) — one of the four product tiers either way, so a 24/96 FLAC in the library and a hi-res master
 * from a platform wear the same badge. A track that advertises neither gets no badge at all.
 */
function qualityBadge(track: AudioTrack) {
  return bestQualityBadge(track)
}

/**
 * What the source badge on a row says.
 *
 * A track that came from a *platform* gets the platform's single glyph, tinted with its colour — the
 * dense list has no room for a name, and the glyph is unambiguous once you have seen it once. A track
 * from a *user source* keeps that source's own name, because a source's name is user-supplied and
 * Aurora has no business renaming it.
 */
function originBadge(track: AudioTrack): { text: string; title: string; isPlatform: boolean } {
  const platformName = platformStore.labelIfKnown(track.sourceId)
  const glyph = platformStore.glyph(track.sourceId)
  if (platformName && glyph) {
    return {
      text: glyph,
      title: `${platformName} · ${track.license || '在线曲库'}`,
      isPlatform: true,
    }
  }
  const sourceName = sourceStore.label(track.sourceId)
  return { text: sourceName, title: `${track.license || '在线音源'} · 来自 ${sourceName}`, isPlatform: false }
}

function onContextMenu(event: MouseEvent, track: AudioTrack): void {
  event.preventDefault()
  emit('contextmenu', track, event.clientX, event.clientY)
}

/** A row's checkbox state, read from the id list the owner keeps. */
function isSelected(track: AudioTrack): boolean {
  return props.selectedIds.includes(track.id)
}

/**
 * The header checkbox has three states, and the third one is not cosmetic: with a subset selected,
 * a plain unticked box would tell the user "nothing is selected" while the batch bar says otherwise.
 */
const allVisibleSelected = computed(
  () => props.tracks.length > 0 && props.tracks.every((track) => props.selectedIds.includes(track.id)),
)
const someVisibleSelected = computed(
  () => !allVisibleSelected.value && props.tracks.some((track) => props.selectedIds.includes(track.id)),
)

function onRowClick(event: MouseEvent, row: { track: AudioTrack; index: number }): void {
  if (!props.selectable) return
  emit('select', row.track, row.index, event.shiftKey)
}

const viewport = ref<HTMLElement | null>(null)
const scrollTop = ref(0)
const viewportHeight = ref(640)
/**
 * The measured width of the list itself, which is what decides the columns.
 *
 * Deliberately not a media query on the window: the same window shows the list at very different
 * widths (sidebar collapsed, queue drawer open, immersive lyrics), and a breakpoint on the viewport
 * would hide the album column while there is still room for it. The container is the honest input.
 */
const viewportWidth = ref(1200)

const COLUMN_BREAKPOINTS = { format: 1180, album: 980, artist: 720 } as const
/** Below this there is no honest way to show five text columns; the row goes dense instead. */
const COMPACT_WIDTH = 620

const showFormat = computed(() => viewportWidth.value >= COLUMN_BREAKPOINTS.format)
const showAlbumColumn = computed(() => props.showAlbum && viewportWidth.value >= COLUMN_BREAKPOINTS.album)
const showArtist = computed(() => viewportWidth.value >= COLUMN_BREAKPOINTS.artist)
const compact = computed(() => viewportWidth.value < COMPACT_WIDTH)
const showActions = computed(() => !compact.value || viewportWidth.value >= 420)

/** The modifier classes the grid templates in `app.css` key off, kept in one place. */
const columnClasses = computed(() => ({
  'no-album': !showAlbumColumn.value,
  'no-format': !showFormat.value,
  'no-artist': !showArtist.value,
  compact: compact.value,
}))
let observer: ResizeObserver | null = null

const startIndex = computed(() => Math.max(0, Math.floor(scrollTop.value / ROW_HEIGHT) - OVERSCAN))
const endIndex = computed(() => {
  const visibleCount = Math.ceil(viewportHeight.value / ROW_HEIGHT) + OVERSCAN * 2
  return Math.min(props.tracks.length, startIndex.value + visibleCount)
})
const visibleRows = computed(() =>
  props.tracks.slice(startIndex.value, endIndex.value).map((track, offset) => ({
    track,
    index: startIndex.value + offset,
  })),
)
const totalHeight = computed(() => props.tracks.length * ROW_HEIGHT)
const offsetY = computed(() => startIndex.value * ROW_HEIGHT)

function onScroll(): void {
  scrollTop.value = viewport.value?.scrollTop ?? 0
}

function measure(): void {
  if (!viewport.value) return
  viewportHeight.value = viewport.value.clientHeight
  viewportWidth.value = viewport.value.clientWidth
}

function coverStyle(track: AudioTrack): Record<string, string> {
  return buildCoverStyle(track.cover, track.id)
}

function isCurrent(track: AudioTrack): boolean {
  return player.current?.id === track.id
}

onMounted(() => {
  measure()
  if (typeof ResizeObserver !== 'undefined' && viewport.value) {
    observer = new ResizeObserver(measure)
    observer.observe(viewport.value)
  }
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
})

watch(() => props.tracks.length, () => {
  if (viewport.value) viewport.value.scrollTop = Math.min(viewport.value.scrollTop, Math.max(0, totalHeight.value - viewportHeight.value))
})
</script>

<template>
  <!-- `no-album` keeps the grid template in step with the conditional album column. -->
  <div ref="viewport" class="track-list" :class="columnClasses" @scroll.passive="onScroll">
    <div class="track-list-head">
      <span class="col-index">
        <input
          v-if="selectable"
          class="row-check"
          data-testid="select-all"
          type="checkbox"
          :checked="allVisibleSelected"
          :indeterminate="someVisibleSelected"
          :title="allVisibleSelected ? '取消全选' : '全选当前列表'"
          @change="emit('select-all', !allVisibleSelected)"
        />
        <template v-else>#</template>
      </span>
      <span class="col-title">标题</span>
      <span v-if="showArtist" class="col-artist">艺术家</span>
      <span v-if="showAlbumColumn" class="col-album">专辑</span>
      <span v-if="showFormat" class="col-format">格式</span>
      <span class="col-duration">时长</span>
      <span v-if="showActions" class="col-actions"></span>
    </div>
    <div class="track-list-body">
      <div class="track-list-spacer" :style="{ height: `${totalHeight}px` }">
        <div class="track-list-window" :style="{ transform: `translateY(${offsetY}px)` }">
          <div
            v-for="row in visibleRows"
            :key="row.track.id"
            class="track-row"
            :class="{
              active: isCurrent(row.track),
              missing: library.missingSet.has(row.track.id),
              selected: selectable && isSelected(row.track),
            }"
            :style="{ height: `${ROW_HEIGHT}px` }"
            @click="onRowClick($event, row)"
            @dblclick="emit('play', row.track, row.index)"
            @contextmenu="onContextMenu($event, row.track)"
          >
            <span class="col-index">
              <!--
                `stop` (don't reach the row's own handler) and `prevent` (don't let the browser move the
                box itself), so the selection model is the single source of the tick. Letting both the
                native toggle and the handler run makes them cancel out — a checkbox that breaks exactly
                where the user aims.
              -->
              <input
                v-if="selectable"
                class="row-check"
                type="checkbox"
                :data-track-id="row.track.id"
                :checked="isSelected(row.track)"
                :aria-label="`选择 ${row.track.title}`"
                @click.stop.prevent="emit('select', row.track, row.index, $event.shiftKey)"
              />
              <span v-else-if="isCurrent(row.track) && player.isPlaying" class="playing-bars"><i></i><i></i><i></i></span>
              <span v-else>{{ row.index + 1 }}</span>
            </span>
            <span class="col-title">
              <span class="row-cover" :style="coverStyle(row.track)"></span>
              <span class="row-text">
                <strong :title="row.track.title">{{ row.track.title }}</strong>
                <!-- With the artist column visible the sub-line carries status only, and disappears
                     entirely when there is nothing to say — an empty line would just inflate the row. -->
                <small v-if="!showArtist">{{ row.track.artist }}</small>
                <small v-else-if="row.track.sourceId || library.missingSet.has(row.track.id)">
                  <em v-if="row.track.origin === 'online' && row.track.sourceId" class="badge-source" :class="{ 'badge-platform': originBadge(row.track).isPlatform }" :style="platformBadgeStyle(row.track.sourceId)" :title="originBadge(row.track).title">{{ originBadge(row.track).text }}</em>
                  <em v-if="library.missingSet.has(row.track.id)" class="badge-missing">文件丢失</em>
                </small>
              </span>
              <!--
                The quality badge lives in the format column, which a narrow list hides — and for an online
                row that badge is the only signal of SQ/Master. So when there is no room for that column it
                moves next to the title rather than disappearing with it. Never both at once.
              -->
              <i
                v-if="!showFormat && qualityBadge(row.track)"
                class="quality-badge inline-badge"
                :class="qualityBadge(row.track)?.tone"
                :data-tier="qualityBadge(row.track)?.tier"
                :title="qualityBadge(row.track)?.title"
              >
                {{ qualityBadge(row.track)?.icon }}
              </i>
            </span>
            <span v-if="showArtist" class="col-artist" :title="row.track.artist">{{ row.track.artist }}</span>
            <span v-if="showAlbumColumn" class="col-album" :title="row.track.album">{{ row.track.album }}</span>
            <span v-if="showFormat" class="col-format">
              <i
                v-if="qualityBadge(row.track)"
                class="quality-badge"
                :class="qualityBadge(row.track)?.tone"
                :data-tier="qualityBadge(row.track)?.tier"
                :title="qualityBadge(row.track)?.title"
              >
                {{ qualityBadge(row.track)?.icon }} {{ qualityBadge(row.track)?.label }}
              </i>
              <i class="format-badge">{{ row.track.format }}</i>
            </span>
            <span class="col-duration">{{ formatTime(row.track.duration) }}</span>
            <span v-if="showActions" class="col-actions">
              <button class="icon-action" title="播放" @click.stop="emit('play', row.track, row.index)">▶</button>
              <button class="icon-action" title="下一首播放" @click.stop="emit('enqueue', row.track)">＋</button>
              <button class="icon-action" title="加入歌单" @click.stop="emit('playlist', row.track)">♫</button>
              <button
                class="icon-action"
                :class="{ favored: collection.isFavorite(row.track.id) }"
                :title="collection.isFavorite(row.track.id) ? '取消收藏' : '收藏'"
                @click.stop="emit('favorite', row.track)"
              >{{ collection.isFavorite(row.track.id) ? '♥' : '♡' }}</button>
              <button
                v-if="canDownload(row.track)"
                class="icon-action"
                title="下载"
                @click.stop="download(row.track)"
              >⇩</button>
              <button v-if="row.track.origin === 'local'" class="icon-action" title="在文件夹中显示" @click.stop="emit('reveal', row.track)">⌸</button>
              <button v-if="showRemove" class="icon-action danger" title="从音乐库移除" @click.stop="emit('remove', row.track)">✕</button>
            </span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
