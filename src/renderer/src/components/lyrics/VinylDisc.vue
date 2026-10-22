<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { allowDraw } from '../../visual/frame'
import { coverStyle } from '../../utils/cover'
import { safeMediaUrl } from '../../utils/url'
import { acquireSpectrum, subscribeSpectrum, type SpectrumFrame } from '../../utils/spectrum'
import { usePlayerStore } from '../../stores/player'
import { useUiStore } from '../../stores/ui'

/**
 * 拟真唱片 — a record that behaves like one.
 *
 * What is real here, and what each part is driven by:
 *
 *  - **grooves** are drawn on a canvas (one ring per ~1.15 px, with deterministic per-ring noise,
 *    brighter track separations and a plain run-out band before the label). A repeating CSS gradient at
 *    this density bands on a dark surface; a drawn texture does not, and it costs one paint per size
 *    change;
 *  - **the rotation is integrated here, not animated by CSS**: a turntable comes up to speed and coasts
 *    to a halt, and `animation-play-state` can only start and stop. So the angle is advanced by hand at
 *    the record's own speed, and the loop stops the moment the platter is at rest — a paused record
 *    costs nothing;
 *  - **the sheen rotates with the disc** (a conic gradient inside the spinning element), while the
 *    **outer highlight does not** — a light source is fixed in the room, so only one of the two may
 *    move. That pair is what reads as "vinyl" rather than as a dark circle;
 *  - **the light follows the music**: bass energy from the real `AnalyserNode` drives `--vinyl-bass`,
 *    which moves the sheen, the halo scale and the groove contrast. Silent audio reports zero, and a
 *    paused record decays to zero rather than freezing at its last value;
 *  - **the tonearm engages on play and tracks across the record** — its angle is a function of the
 *    player's own progress, so it advances as the song does and returns to rest when paused;
 *  - **the centre label is the album artwork**, clipped into the label with the same subject-safe
 *    framing the artwork column uses.
 */
const props = defineProps<{ cover?: string; seed: string; title?: string }>()

const player = usePlayerStore()
/** The pressing in use. It lives in the store so the choice survives leaving the page. */
const ui = useUiStore()

/** The level is published on the wrapper, because the halo (a sibling of the disc) reads it too. */
const root = ref<HTMLElement | null>(null)
const platter = ref<HTMLElement | null>(null)
const grooves = ref<HTMLCanvasElement | null>(null)
const label = computed(() => coverStyle(props.cover, props.seed))
/** The artwork may come from a source, so it is validated before it reaches an `src`. */
const art = computed(() => safeMediaUrl(props.cover))
/**
 * A label whose image failed to load would show Chromium's broken-image glyph printed on the record.
 * The label already carries the id gradient underneath, so the honest fallback is to drop the image
 * and let that show through.
 */
const labelFailed = ref(false)
watch(art, () => {
  labelFailed.value = false
})

const bass = ref(0)
/** `true` once a frame has actually arrived from the analyser, so nothing claims live data it lacks. */
const live = ref(false)

const engaged = computed(() => player.isPlaying && Boolean(props.title))
/** The player store already owns the clock; the arm reads it rather than keeping a second one. */
const progress = computed(() => player.progress)
/**
 * Rest position vs. the playing arc, in degrees of the arm's own sweep.
 *
 * The direction is what matters and it used to be inverted: measured on the live record, a *larger* angle
 * here walks the needle towards the label, so the arc must run from a small angle (the outer groove) up to a
 * large one (the run-out). The old range ran the other way — playing lifted the needle off the record.
 *
 * −3° parks the arm just outside the outer groove, 0.5° sets it down at the start of the side, and 21.5° of
 * travel carries it to the run-out: 0.97 and 0.43 of the disc's radius respectively, which is the arc a real
 * 12" arm sweeps.
 */
const armAngle = computed(() => (engaged.value ? 0.5 + progress.value * 21.5 : -3))

/* ------------------------------------------------------------------ grooves */

/** Deterministic per-ring jitter, so the texture is stable across repaints (no shimmering). */
function ringNoise(radius: number): number {
  const value = Math.sin(radius * 12.9898) * 43758.5453
  return value - Math.floor(value)
}

/**
 * Groove ink and relief, read from the record's own computed style.
 *
 * Both come out of CSS rather than out of props, so a pressing is described in one place: `color` is the ink
 * (black vinyl's is silver, 彩胶's is the cover's tint, clear vinyl's is white) and `--vinyl-groove-scale` is
 * how much relief the drawn rings carry.
 *
 * The ink is *resolved by painting it*, not by parsing the string: a material's colour is a `color-mix()`
 * or a `color(srgb …)`, and the canvas is the one authority that always agrees with what gets drawn. One
 * pixel at the origin, read back and wiped — the groove layer is cleared first anyway, so it costs nothing.
 */
function grooveInk(): { ink: string; scale: number } {
  const element = root.value
  const context = grooves.value?.getContext('2d')
  if (!element || !context) return { ink: '#ffffff', scale: 1 }
  const styles = getComputedStyle(element)
  context.save()
  context.globalAlpha = 1
  context.fillStyle = '#000000'
  context.fillStyle = styles.color
  context.fillRect(0, 0, 1, 1)
  const pixel = context.getImageData(0, 0, 1, 1).data
  context.restore()
  context.clearRect(0, 0, 1, 1)
  const ink = pixel[3] > 0 ? 'rgb(' + pixel[0] + ',' + pixel[1] + ',' + pixel[2] + ')' : '#ffffff'
  return { ink, scale: Number.parseFloat(styles.getPropertyValue('--vinyl-groove-scale')) || 1 }
}

function paintGrooves(): boolean {
  const element = grooves.value
  const context = element?.getContext('2d')
  if (!element || !context) return false
  const size = element.clientWidth
  if (size <= 0) return false
  const ratio = window.devicePixelRatio || 1
  if (element.width !== Math.round(size * ratio) || element.height !== Math.round(size * ratio)) {
    element.width = Math.round(size * ratio)
    element.height = Math.round(size * ratio)
  }
  context.setTransform(ratio, 0, 0, ratio, 0, 0)
  context.clearRect(0, 0, size, size)

  const { ink, scale } = grooveInk()
  const centre = size / 2
  const outer = centre * 0.985
  /* Just outside the label (which is `inset: 30%`, i.e. a 0.4 × size diameter): the groove field has
     to *reach* the label rather than hide under it, or the disc reads as a plain black ring. */
  const inner = centre * 0.44
  /* The run-out: the last few millimetres of a side are cut smooth and read as a distinctly darker,
     quieter band. It is what makes the label look pressed into the record instead of pasted on. */
  const runOut = inner + 18

  context.lineWidth = 0.7
  /*
   * The ink has to be set *here*, before the first ring: `strokeStyle` is stateful, so a loop that only
   * sets `globalAlpha` is stroked in whatever the previous paint happened to leave behind — which is black
   * on a fresh context (an invisible pressing under `mix-blend-mode: screen`) and the previous material's
   * ink after a switch.
   */
  context.strokeStyle = ink
  for (let radius = runOut; radius < outer; radius += 1.15) {
    const noise = ringNoise(radius)
    /* Two octaves of deterministic noise: a single one gives an even stipple, two give the banding a
       real pressing shows as the lathe's pitch and depth vary across a side. Both are kept faint —
       the texture should be felt as the disc turns, not read as a printed pattern. */
    const weave = ringNoise(radius * 0.37) * 0.5
    // Relief, not just brightness: the material scales how hard each ring catches the light, which is what
    // separates clear vinyl (sharp, glassy) from a black pressing (a whisper of silver).
    context.globalAlpha = Math.min(1, (0.03 + noise * 0.062 + weave * 0.03) * scale)
    context.beginPath()
    context.arc(centre, centre, radius, 0, Math.PI * 2)
    context.stroke()
  }

  // The run-out band itself: flat, slightly darker than the grooves so the eye reads a real edge.
  context.globalAlpha = 1
  context.strokeStyle = 'rgba(0,0,0,0.36)'
  context.beginPath()
  context.arc(centre, centre, (inner + runOut) / 2, 0, Math.PI * 2)
  context.stroke()

  // Track separations: slightly wider and brighter, every 34 px of radius.
  context.lineWidth = 1.4
  context.strokeStyle = ink
  context.globalAlpha = Math.min(1, 0.08 * scale)
  for (let radius = runOut + 22; radius < outer; radius += 34) {
    context.beginPath()
    context.arc(centre, centre, radius, 0, Math.PI * 2)
    context.stroke()
  }

  // The outer edge, where the pressing meets the rim: brighter and continuous.
  context.lineWidth = 1.2
  context.globalAlpha = Math.min(1, 0.12 * scale)
  context.beginPath()
  context.arc(centre, centre, outer - 1.4, 0, Math.PI * 2)
  context.stroke()
  context.globalAlpha = 1
  return true
}

/* ------------------------------------------------------------------ rotation */

/** One revolution per 26 s at full speed — the feel of a 33⅓ record scaled to a UI, not to scale. */
const FULL_SPEED = 360 / 26
/** Degrees/s². Up to speed in ~1.2 s; a stop takes ~2.4 s, because a platter coasts rather than brakes. */
const ACCEL = FULL_SPEED / 1.2
const DECEL = FULL_SPEED / 2.4
/** Below this the platter is treated as stopped, and its frame loop is released. */
const REST_SPEED = 0.15

let angle = 0
let speed = 0
let frame = 0
let last = 0

/**
 * Advances the disc by real elapsed time.
 *
 * Integrating `dt` (rather than adding a fixed step per frame) is what keeps the speed the same on a
 * 60 Hz and a 144 Hz display, and clamping `dt` stops a backgrounded tab from snapping the record a
 * full turn when it comes back.
 */
function spin(now: number): void {
  /*
   * The record obeys the user's frame cap too.
   *
   * This is angular *decorative* motion — unlike the lyric scroll, nothing is being read while it turns —
   * so it is exactly what a lower cap is for. Skipping is safe because the angle is integrated from real
   * elapsed time, not advanced per frame: a skipped frame costs one comparison and the disc is simply a
   * little further along on the next one, at the same speed.
   */
  if (!allowDraw('vinyl', now)) {
    frame = requestAnimationFrame(spin)
    return
  }
  const dt = last > 0 ? Math.min(0.05, (now - last) / 1000) : 1 / 60
  last = now
  const target = player.isPlaying ? FULL_SPEED : 0
  const rate = player.isPlaying ? ACCEL : DECEL
  if (speed < target) speed = Math.min(target, speed + rate * dt)
  else if (speed > target) speed = Math.max(target, speed - rate * dt)
  angle = (angle + speed * dt) % 360

  const element = platter.value
  if (element) {
    element.style.transform = `rotate(${angle.toFixed(2)}deg)`
    element.dataset.vinylAngle = angle.toFixed(2)
  }

  if (!player.isPlaying && speed <= REST_SPEED) {
    speed = 0
    frame = 0
    last = 0
    return
  }
  frame = requestAnimationFrame(spin)
}

/** Starts the loop when it is not already running, so a play/pause flip never stacks two of them. */
function ensureSpin(): void {
  if (frame) return
  last = 0
  frame = requestAnimationFrame(spin)
}

let observer: ResizeObserver | null = null

/* ------------------------------------------------------------------ live audio */

function applyFrame(frame: SpectrumFrame | null): void {
  if (!frame) {
    live.value = false
    bass.value = 0
    return
  }
  live.value = true
  // A paused record has no motion: the analyser keeps returning its last buffer, which would
  // otherwise leave the light frozen at whatever the previous frame happened to be.
  bass.value = player.isPlaying ? frame.bass : 0
}

let unsubscribe: (() => void) | null = null

onMounted(() => {
  /*
   * Always, not only while playing.
   *
   * A disc that mounts paused published nothing at all — no transform, and no angle attribute for anything
   * to read — because the loop was only started by the play/pause watcher. The visible result was fine, and
   * the *invisible* result was that "the platter is there but has never turned" and "there is no platter
   * here" were indistinguishable. One pass costs a single frame: it applies the resting transform, writes
   * the angle, and the loop releases itself a frame later when the platter is at rest.
   *
   * Started *before* the texture is painted, and that ordering is deliberate: the grooves are decoration on
   * the record, while the rotation is the record. `paintGrooves` reads colours back out of CSS and can fail
   * on a stylesheet mid-swap, and when it did, the whole mount aborted with it — the disc stayed on screen,
   * motionless, with no angle for anything to read, which looked exactly like "the animation is broken".
   */
  ensureSpin()
  try {
    paintGrooves()
  } catch {
    // A texture that cannot be painted is a flat record, not a broken player.
  }
  unsubscribe = subscribeSpectrum(() => player.audio, applyFrame)
  if (typeof ResizeObserver !== 'undefined' && grooves.value) {
    observer = new ResizeObserver(() => paintGrooves())
    observer.observe(grooves.value)
  }
})

onBeforeUnmount(() => {
  unsubscribe?.()
  unsubscribe = null
  observer?.disconnect()
  observer = null
  if (frame) cancelAnimationFrame(frame)
  frame = 0
  // The audio graph is deliberately left alone: tearing down the MediaElementSource would take
  // playback with it and can never be rebuilt for the same element.
})

// Playback starts on a real user gesture (the play button), which is the moment an audio context may
// legally resume — so that is when attaching is retried, exactly once per transition.
watch(
  () => player.isPlaying,
  (playing) => {
    if (!playing) {
      bass.value = 0
      // Not cancelled: the loop coasts the platter down and then releases itself.
      ensureSpin()
      return
    }
    ensureSpin()
    void acquireSpectrum(player.audio, true)
  },
)

/*
 * A new pressing repaints the texture: the ink and the relief both come from the material, and the canvas
 * is the one part of the record CSS cannot restyle. 彩胶 also follows the *cover*, so a track change
 * repaints it too — once per song, not per frame.
 */
/*
 * `flush: 'post'`, and it is load-bearing: `data-vinyl` (and `--amb-accent`) are read back through
 * `getComputedStyle`, so a pre-flush watcher would repaint from the material that is *leaving* — measured on
 * the live page, that painted every pressing one selection behind. Post-flush runs after the attribute is
 * patched, which is the first moment the new ink exists.
 */
watch(() => ui.vinylMaterial, () => paintGrooves(), { flush: 'post' })
watch(
  () => ui.artworkAccent,
  () => {
    if (ui.vinylMaterial === 'colour') paintGrooves()
  },
  { flush: 'post' },
)

// Publishes the level to CSS. `--vinyl-bass` is what the stylesheet reads, so the light maths lives
// in the stylesheet rather than in per-frame inline styles.
watch(bass, (value) => {
  const element = root.value
  if (!element) return
  element.style.setProperty('--vinyl-bass', value.toFixed(3))
  element.dataset.vinylBass = value.toFixed(3)
})
</script>

<template>
  <div
    ref="root"
    class="vinyl"
    :data-vinyl="ui.vinylMaterial"
    style="--vinyl-bass: 0"
    :data-vinyl-live="live ? 'true' : 'false'"
    :data-vinyl-progress="progress.toFixed(3)"
  >
    <div class="vinyl-halo" aria-hidden="true"></div>

    <div ref="platter" class="vinyl-platter" :class="{ spinning: player.isPlaying }">
      <div class="vinyl-material" aria-hidden="true"></div>
      <canvas ref="grooves" class="vinyl-grooves" aria-hidden="true"></canvas>
      <div class="vinyl-sheen" aria-hidden="true"></div>
      <div class="vinyl-label" :style="label">
        <img v-if="art && !labelFailed" :src="art" alt="" decoding="async" @error="labelFailed = true" />
        <span class="vinyl-label-ring" aria-hidden="true"></span>
      </div>
      <div class="vinyl-spindle"></div>
    </div>

    <!-- Fixed light: it must not rotate with the disc. -->
    <div class="vinyl-light" aria-hidden="true"></div>
    <div class="vinyl-edge" aria-hidden="true"></div>

    <div
      class="vinyl-tonearm"
      :class="{ engaged }"
      :style="{ transform: `rotate(${armAngle}deg)` }"
      :data-vinyl-arm="armAngle.toFixed(2)"
    >
      <!-- Nested, so the headshell and its needle ride the tube's angle instead of being placed by hand. -->
      <span class="vinyl-arm">
        <span class="vinyl-head"></span>
      </span>
    </div>
  </div>
</template>
