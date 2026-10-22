<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { wordFillProgress, type LyricLine } from '../../../../shared/lyrics'
import { FOLLOW_RESUME_MS, LyricScroller } from '../../lyrics/scroll'
import { usePlayerStore } from '../../stores/player'

/**
 * Lyrics viewport.
 *
 * Behaviour that matters:
 *  - the active line is centred with a smooth `scrollTo` (no per-frame `scrollTop` writes);
 *  - when the lyric carries per-word timings those words are filled one at a time, in step with the audio;
 *  - lines fade out with distance so the current line always dominates;
 *  - very long lyrics only render a window around the active line (the project's existing
 *    virtual-scroll approach), so a 2000-line file costs the same as a 40-line one;
 *  - manual scrolling pauses auto-follow for a few seconds instead of fighting the user.
 */
const props = defineProps<{
  lines: LyricLine[]
  activeIndex: number
  activeWordIndex: number
  synced: boolean
}>()

const emit = defineEmits<{ (event: 'seek', index: number): void }>()

/**
 * Whether auto-follow is paused because the user scrolled.
 *
 * A model rather than local state: the 「回到当前歌词」 button has to live *outside* the fading scroll area (see
 * the mask in `app.css`), so the flag is owned by the page while the scrolling that sets it stays here.
 */
const suspended = defineModel<boolean>('suspended', { default: false })

const WINDOW_THRESHOLD = 240
const WINDOW_RADIUS = 80
const ESTIMATED_LINE_HEIGHT = 58

const player = usePlayerStore()
const viewport = ref<HTMLElement | null>(null)
const lineElements = ref<Record<number, HTMLElement | null>>({})
let suspendTimer: ReturnType<typeof setTimeout> | null = null
/**
 * The follow, and the only thing that moves this sheet.
 *
 * It owns nothing reactive on purpose: it is driven by the DOM's own geometry, so a growing active line, a
 * windowing shift or a font that loads late are all just "measure again next frame" rather than a value to
 * keep in sync.
 */
const glide = new LyricScroller(() => lineElements.value[props.activeIndex] ?? null)

const windowed = computed(() => props.lines.length > WINDOW_THRESHOLD)
const windowStart = computed(() => (windowed.value ? Math.max(0, props.activeIndex - WINDOW_RADIUS) : 0))
const windowEnd = computed(() =>
  windowed.value ? Math.min(props.lines.length, props.activeIndex + WINDOW_RADIUS + 1) : props.lines.length,
)
const visibleLines = computed(() =>
  props.lines
    .slice(windowStart.value, windowEnd.value)
    .map((line, offset) => ({ line, index: windowStart.value + offset })),
)
const paddingTop = computed(() => windowStart.value * ESTIMATED_LINE_HEIGHT)
const paddingBottom = computed(() => Math.max(0, (props.lines.length - windowEnd.value) * ESTIMATED_LINE_HEIGHT))

function lineClass(index: number): string {
  if (!props.synced) return 'plain'
  if (props.activeIndex < 0) return index === 0 ? 'near' : 'far'
  const distance = index - props.activeIndex
  if (distance === 0) return 'active'
  /*
   * Past and future are separate states, not just "somewhere else in the list": a line already sung
   * should sit further back than one still coming, and the stylesheet can only say that if it is told.
   */
  const side = distance < 0 ? 'past' : 'future'
  if (Math.abs(distance) === 1) return `near ${side}`
  if (Math.abs(distance) <= 3) return `mid ${side}`
  return `far ${side}`
}

function setLineRef(index: number, element: unknown): void {
  lineElements.value[index] = (element as HTMLElement | null) ?? null
}

function follow(): void {
  glide.follow(viewport.value)
}

function resumeFollowing(): void {
  suspended.value = false
  if (suspendTimer) clearTimeout(suspendTimer)
  suspendTimer = null
  follow()
}

/*
 * A hand scroll pauses the follow, and it resumes by itself.
 *
 * That second half is the point: the reference players never leave the sheet parked after a glance up, and an
 * earlier version of this page only came back when the button was clicked (`suspended` had no timer at all),
 * which reads as "the lyrics stopped working". The button stays for the user who wants to jump back *now*.
 */
function noteUserScroll(): void {
  if (!props.synced || props.activeIndex < 0) return
  glide.stop()
  suspended.value = true
  if (suspendTimer) clearTimeout(suspendTimer)
  suspendTimer = setTimeout(() => {
    suspendTimer = null
    suspended.value = false
    follow()
  }, FOLLOW_RESUME_MS)
}

/* ------------------------------------------------------------------ karaoke */

let fillFrame = 0

/**
 * Paints the active word's fill from the audio clock.
 *
 * Why this writes to the DOM instead of going through the template: the fill changes *every frame*, and a
 * reactive value at that rate would re-render the whole windowed list (up to 160 lines) sixty times a second.
 * The clock is owned by the player store and the word's own start/end times are already in the parsed lyric,
 * so one `requestAnimationFrame` and one custom-property write is the entire cost — and the loop only runs
 * while the player is actually playing.
 *
 * It is only ever applied to lines that really carry per-word timings. A line without them keeps the whole-line
 * highlight: a fake karaoke sweep would claim timing data the lyric does not have.
 */
function paintWordFill(): void {
  fillFrame = 0
  if (!props.synced) return
  const words = props.lines[props.activeIndex]?.words
  const container = lineElements.value[props.activeIndex]
  if (!words || words.length === 0 || !container) return
  // Before the first word's timestamp the karaoke sits at the start of the line rather than nowhere.
  const index = Math.max(0, props.activeWordIndex)
  const progress = wordFillProgress(words, index, player.currentTime)
  if (progress === null) return
  const word = container.querySelectorAll<HTMLElement>('.lyric-word')[index]
  if (word) word.style.setProperty('--word-fill', `${(progress * 100).toFixed(1)}%`)
  if (player.isPlaying) scheduleFill()
}

function scheduleFill(): void {
  if (fillFrame) return
  fillFrame = requestAnimationFrame(paintWordFill)
}

function stopFill(): void {
  if (fillFrame) cancelAnimationFrame(fillFrame)
  fillFrame = 0
}

watch(
  () => props.activeIndex,
  () => {
    if (props.synced && !suspended.value) follow()
  },
)

/*
 * The fill follows the word, the line, the lyrics and the transport: a new word restarts the sweep, a pause
 * freezes it where it stands (and releases the frame loop), and resuming picks it up from the audio clock
 * rather than from where it stopped. `props.lines` is in the list because importing or re-matching lyrics
 * replaces the array under the same play head.
 */
watch(
  () => [props.lines, props.activeIndex, props.activeWordIndex, props.synced, player.isPlaying],
  () => {
    stopFill()
    paintWordFill()
  },
)

/*
 * Opening the page in the middle of a word while *paused* has to show the word already partly filled — the
 * watcher alone would leave it at zero until the next word, because nothing changes while the clock is stopped.
 */
onMounted(() => nextTick(() => paintWordFill()))

/*
 * A paused seek has to repaint too, and this is the only way to notice one: the word index does not change when
 * the play head moves *inside* the current word, so the watcher above stays quiet and the sweep would keep
 * showing where the previous position left it. While playing the source is a constant `0`, so the watcher costs
 * nothing per frame — the frame loop is what follows the clock then.
 */
watch(
  () => (player.isPlaying ? 0 : player.currentTime),
  () => {
    if (!player.isPlaying) paintWordFill()
  },
)

watch(
  () => [props.lines, props.synced],
  () =>
    nextTick(() => {
      suspended.value = false
      // Land (no animation) when a different track's lyrics arrive: a glide across a whole song is a blur.
      glide.jump(viewport.value)
    }),
)

/*
 * The column is as wide as the window and so is the mask; both change meaning when the window is resized, so
 * the line that was centred a moment ago is not centred any more. Landing again is enough — there is nothing
 * to animate, the whole box moved.
 */
let resizeFrame = 0
function onResize(): void {
  if (resizeFrame) return
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = 0
    if (!suspended.value) glide.jump(viewport.value)
    paintWordFill()
  })
}

onMounted(() => {
  window.addEventListener('resize', onResize)
  /*
   * Opening the page mid-track is the normal case, and no watcher fires for it: the lyrics are already here
   * when this component is created, so without this the sheet would sit at the top of the song until the next
   * line change.
   */
  nextTick(() => glide.jump(viewport.value))
})

onBeforeUnmount(() => {
  if (suspendTimer) clearTimeout(suspendTimer)
  if (resizeFrame) cancelAnimationFrame(resizeFrame)
  window.removeEventListener('resize', onResize)
  glide.stop()
  stopFill()
})

defineExpose({ resumeFollowing })
</script>

<template>
  <div
    ref="viewport"
    class="lyrics-viewport"
    :class="{ suspended }"
    @wheel.passive="noteUserScroll"
    @touchmove.passive="noteUserScroll"
    @keydown.passive="noteUserScroll"
  >
    <div class="lyrics-lines" :style="{ paddingTop: `${paddingTop}px`, paddingBottom: `${paddingBottom}px` }">
      <p
        v-for="row in visibleLines"
        :key="row.index"
        :ref="(element) => setLineRef(row.index, element)"
        class="lyric-line"
        :class="lineClass(row.index)"
        :data-lyric-state="row.index === activeIndex ? 'active' : lineClass(row.index).includes('past') ? 'past' : 'future'"
        @click="synced && emit('seek', row.index)"
      >
        <template v-if="row.line.words && row.line.words.length > 1">
          <span class="lyric-words">
            <span
              v-for="(word, wordIndex) in row.line.words"
              :key="wordIndex"
              class="lyric-word"
              :class="{
                'word-active': row.index === activeIndex && wordIndex === activeWordIndex,
                'word-done': row.index === activeIndex && wordIndex < activeWordIndex,
              }"
            >{{ word.text }}</span>
          </span>
        </template>
        <span v-else class="lyric-text">{{ row.line.text || '♪' }}</span>
        <!-- Romanisation only exists for providers that publish a separate romaji track, so it is
             absent from most songs and costs nothing when it is. -->
        <span v-if="row.line.roman" class="lyric-roman">{{ row.line.roman }}</span>
        <span v-if="row.line.translation" class="lyric-translation">{{ row.line.translation }}</span>
      </p>
    </div>

  </div>
</template>
