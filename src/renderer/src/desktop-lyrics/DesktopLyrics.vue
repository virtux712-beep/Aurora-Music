<script setup lang="ts">
/**
 * The desktop-lyrics strip.
 *
 * It is a *display*: the app window plays the audio and the main process pushes the clock, so this
 * component owns no playback state at all. Everything it renders is derived from the last track
 * payload and the last tick, which is what keeps it from drifting out of sync with the player.
 *
 * Word-level timing is honoured when the lyric source provided it (`findActiveWord`) — the same
 * parser the immersive page uses, so both views agree on what the current line is.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { DesktopLyricsSettings, DesktopLyricsTick, DesktopLyricsTrack } from '../../../shared/types'
import { findActiveLine, findActiveWord, lyricSyncTime } from '../../../shared/lyrics'

const bridge = window.auroraLyrics

const track = ref<DesktopLyricsTrack | null>(null)
const time = ref(0)
const isPlaying = ref(false)
const duration = ref(0)
/** The user's lyric correction, pushed with the clock so the strip and the app window agree. */
const offsetMs = ref(0)
const options = ref<DesktopLyricsSettings>({
  enabled: true,
  locked: false,
  alwaysOnTop: true,
  fontSize: 34,
  fontFamily: '',
  color: '#8fd0ff',
  inactiveColor: '#e8edf5',
  background: 0.32,
  showTranslation: true,
  showNextLine: true,
  x: -1,
  y: -1,
  width: 900,
  height: 150,
})
const hovered = ref(false)

const lines = computed(() => track.value?.lines ?? [])
/**
 * Lyrics are read at the corrected position; the progress bar below keeps the real `time`.
 *
 * The two must not be the same number: the correction is a statement about lyric timing, and shifting the
 * progress bar by it would misreport where the song actually is.
 */
const syncTime = computed(() => lyricSyncTime(time.value, offsetMs.value))
const activeIndex = computed(() => findActiveLine(lines.value, syncTime.value))
const activeLine = computed(() => (activeIndex.value >= 0 ? (lines.value[activeIndex.value] ?? null) : null))
const nextLine = computed(() => {
  const next = lines.value[activeIndex.value + 1]
  return next && next.text.trim() ? next : null
})
const activeWord = computed(() => findActiveWord(activeLine.value, syncTime.value))

/** Splits the active line into word spans only when the source gave per-word timings. */
const activeWords = computed(() => {
  const line = activeLine.value
  const words = line?.words ?? []
  if (words.length === 0) return null
  return words.map((word, index) => ({ text: word.text, index }))
})

const translation = computed(() => activeLine.value?.translation?.trim() ?? '')
const progress = computed(() => {
  if (!duration.value || duration.value <= 0) return 0
  return Math.min(Math.max(time.value / duration.value, 0), 1)
})

const plateStyle = computed(() => ({
  fontSize: `${options.value.fontSize}px`,
  fontFamily: options.value.fontFamily || undefined,
  color: options.value.inactiveColor,
  background: `rgba(8, 11, 17, ${options.value.background})`,
}))

const activeStyle = computed(() => ({ color: options.value.color }))

/** Locked: no drag handle and no controls, because the window no longer receives clicks. */
const showControls = computed(() => hovered.value && !options.value.locked)

function setOptions(patch: Partial<DesktopLyricsSettings>): void {
  options.value = { ...options.value, ...patch }
  void bridge?.setOptions(patch)
}

function stepFontSize(delta: number): void {
  const next = Math.min(Math.max(options.value.fontSize + delta, 14), 96)
  setOptions({ fontSize: next })
}

onMounted(() => {
  const offTrack = bridge?.onTrack((payload) => {
    track.value = payload
    time.value = 0
  })
  const offTick = bridge?.onTick((payload: DesktopLyricsTick) => {
    time.value = payload.currentTime
    isPlaying.value = payload.isPlaying
    duration.value = payload.duration
    offsetMs.value = payload.offsetMs ?? 0
  })
  const offOptions = bridge?.onOptions((payload) => {
    options.value = payload
  })
  void bridge?.ready()

  onBeforeUnmount(() => {
    offTrack?.()
    offTick?.()
    offOptions?.()
  })
})
</script>

<template>
  <div
    class="dl-root"
    :class="{ locked: options.locked }"
    @mouseenter="hovered = true"
    @mouseleave="hovered = false"
  >
    <div class="dl-plate" :style="plateStyle">
      <div class="dl-body">
        <p v-if="activeLine" class="dl-line-active" :style="activeStyle">
          <template v-if="activeWords && activeWord >= 0">
            <span
              v-for="word in activeWords"
              :key="word.index"
              class="dl-word"
              :class="{ sung: word.index <= activeWord }"
            >{{ word.text }}</span>
          </template>
          <template v-else>{{ activeLine.text }}</template>
        </p>
        <p v-else-if="track" class="dl-line-active dl-placeholder" :style="activeStyle">
          {{ track.title }}<span v-if="track.artist" class="dl-artist"> · {{ track.artist }}</span>
        </p>
        <p v-else class="dl-line-active dl-placeholder">Aurora 桌面歌词</p>

        <p v-if="options.showTranslation && translation" class="dl-translation">{{ translation }}</p>
      </div>

      <p v-if="options.showNextLine && nextLine" class="dl-line-next">{{ nextLine.text }}</p>

      <div class="dl-progress" :style="{ transform: `scaleX(${progress})` }"></div>
    </div>

    <div class="dl-controls" :class="{ visible: showControls }">
      <button class="dl-button" title="上一首" @click="bridge?.control('previous')">⏮</button>
      <button class="dl-button" title="播放 / 暂停" @click="bridge?.control('toggle-play')">
        {{ isPlaying ? '⏸' : '▶' }}
      </button>
      <button class="dl-button" title="下一首" @click="bridge?.control('next')">⏭</button>
      <span class="dl-sep"></span>
      <button class="dl-button" title="减小字号" @click="stepFontSize(-2)">A－</button>
      <button class="dl-button" title="增大字号" @click="stepFontSize(2)">A＋</button>
      <button
        class="dl-button"
        :title="options.showTranslation ? '隐藏翻译' : '显示翻译'"
        @click="setOptions({ showTranslation: !options.showTranslation })"
      >
        译
      </button>
      <button class="dl-button" title="锁定（鼠标穿透）" @click="setOptions({ locked: true })">🔒</button>
      <button class="dl-button" title="关闭桌面歌词" @click="bridge?.hide()">✕</button>
    </div>
  </div>
</template>

<style scoped>
.dl-root {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 4px;
  box-sizing: border-box;
  /* The whole strip is a drag handle, so the window can be placed anywhere; controls opt out. */
  -webkit-app-region: drag;
  user-select: none;
}

.dl-root.locked {
  -webkit-app-region: no-drag;
}

.dl-plate {
  position: relative;
  width: 100%;
  border-radius: 14px;
  padding: 12px 20px 16px;
  box-sizing: border-box;
  text-align: center;
  backdrop-filter: blur(6px);
  overflow: hidden;
}

.dl-line-active {
  margin: 0;
  font-size: 1em;
  font-weight: 600;
  line-height: 1.28;
  text-shadow: 0 2px 10px rgba(0, 0, 0, 0.72);
}

.dl-placeholder {
  opacity: 0.92;
}

.dl-artist {
  font-size: 0.62em;
  font-weight: 500;
  opacity: 0.78;
}

.dl-word {
  color: inherit;
  opacity: 0.55;
  transition: opacity 120ms linear;
}

.dl-word.sung {
  opacity: 1;
}

.dl-translation {
  margin: 4px 0 0;
  font-size: 0.56em;
  line-height: 1.2;
  opacity: 0.82;
  text-shadow: 0 2px 8px rgba(0, 0, 0, 0.7);
}

.dl-line-next {
  margin: 0;
  font-size: 0.46em;
  opacity: 0.62;
  line-height: 1.2;
  text-shadow: 0 2px 8px rgba(0, 0, 0, 0.7);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}

.dl-progress {
  position: absolute;
  left: 0;
  bottom: 0;
  height: 2px;
  width: 100%;
  transform-origin: left center;
  background: currentColor;
  opacity: 0.35;
  transition: transform 200ms linear;
}

.dl-controls {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(8, 11, 17, 0.72);
  opacity: 0;
  pointer-events: none;
  transition: opacity 140ms ease;
  -webkit-app-region: no-drag;
}

.dl-controls.visible {
  opacity: 1;
  pointer-events: auto;
}

.dl-button {
  border: 0;
  background: transparent;
  color: #e8edf5;
  font-size: 12px;
  line-height: 1;
  padding: 4px 6px;
  border-radius: 8px;
  cursor: pointer;
}

.dl-button:hover {
  background: rgba(255, 255, 255, 0.14);
}

.dl-sep {
  width: 1px;
  height: 12px;
  background: rgba(255, 255, 255, 0.2);
  margin: 0 4px;
}
</style>
