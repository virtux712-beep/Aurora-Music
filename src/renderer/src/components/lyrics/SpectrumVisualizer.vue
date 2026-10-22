<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { allowDraw } from '../../visual/frame'
import { usePlayerStore } from '../../stores/player'
import { acquireSpectrum, type SpectrumBridge } from '../../utils/spectrum'

/**
 * 频谱律动 — a real spectrum, drawn from the playing audio.
 *
 * There is no simulated motion here: the bars come from an `AnalyserNode` on the player's own audio
 * element, so silence draws a flat line and a bass drop draws tall bars. When the analyser cannot be
 * attached (see `utils/spectrum.ts`) the component says so and offers a click, because a real user
 * gesture is what unblocks the audio context.
 */
const props = defineProps<{ accent?: string }>()

const player = usePlayerStore()

const canvas = ref<HTMLCanvasElement | null>(null)
const state = ref<'connecting' | 'ready' | 'blocked'>('connecting')

let analyserBridge: SpectrumBridge | null = null
let frame = 0
let resizeObserver: ResizeObserver | null = null
/** Removes the element-level `play` hook installed on mount. */
let offPlayHook: (() => void) | null = null

/** Log-spaced band edges: linear bins spend two thirds of the width on inaudible high frequencies. */
const BARS = 48
/**
 * `addColorStop` throws on an unparseable colour, and this runs inside `requestAnimationFrame` — one
 * bad value would then throw on every frame and fill the console. `palette.ts` only ever produces
 * hex, so this is a guard against a future caller, not against the current one.
 */
const HEX = /^#[0-9a-f]{3,8}$/i
const accentColor = computed(() => (HEX.test(props.accent ?? '') ? (props.accent as string) : '#8fa6ff'))

function bandAverage(data: Uint8Array, from: number, to: number): number {
  let total = 0
  for (let index = from; index < to; index += 1) total += data[index]
  return total / Math.max(1, to - from)
}

/**
 * Draws one frame. Returns whether a frame was actually drawn — the caller uses that to decide if the
 * canvas is still dirty, and a frame that bailed out early (no analyser attached yet) must not count
 * as drawn or the canvas would stay blank until the next play state change.
 */
function paint(): boolean {
  const element = canvas.value
  const context = element?.getContext('2d')
  if (!element || !context || !analyserBridge) return false

  const ratio = window.devicePixelRatio || 1
  const width = element.clientWidth
  const height = element.clientHeight
  if (element.width !== Math.round(width * ratio) || element.height !== Math.round(height * ratio)) {
    element.width = Math.round(width * ratio)
    element.height = Math.round(height * ratio)
  }
  context.setTransform(ratio, 0, 0, ratio, 0, 0)
  context.clearRect(0, 0, width, height)

  const { analyser, data } = analyserBridge
  analyser.getByteFrequencyData(data)

  const accent = accentColor.value
  const slot = width / BARS
  const barWidth = Math.max(2, slot * 0.42)
  const usable = Math.floor(data.length * 0.62) // above ~62% of Nyquist there is usually nothing
  const minBin = 2

  for (let bar = 0; bar < BARS; bar += 1) {
    // Geometric spacing, so the low end keeps its resolution.
    const from = Math.floor(minBin * Math.pow(usable / minBin, bar / BARS))
    const to = Math.max(from + 1, Math.floor(minBin * Math.pow(usable / minBin, (bar + 1) / BARS)))
    const level = bandAverage(data, from, to) / 255
    const barHeight = Math.max(2, level * height)
    const x = bar * slot + (slot - barWidth) / 2
    const y = height - barHeight

    const gradient = context.createLinearGradient(0, y, 0, height)
    gradient.addColorStop(0, accent)
    gradient.addColorStop(1, 'rgba(255,255,255,0.06)')
    context.fillStyle = gradient
    const radius = Math.min(barWidth / 2, 3)
    context.beginPath()
    context.roundRect(x, y, barWidth, barHeight, [radius, radius, 0, 0])
    context.fill()
  }
  return true
}

/**
 * A paused player's spectrum does not change, so repainting it 60 times a second is pure CPU. The
 * frame is drawn once per state change and then the loop idles until playback resumes.
 */
let dirty = true

function loop(): void {
  /*
   * The governor's cadence, then the work.
   *
   * The gate is second because `paint()` is the expensive part: a spectrum with 60+ bars and gradients is
   * the single heaviest thing the lyrics page draws, and it is decoration over decoration. A skipped frame
   * still leaves the previous bars on screen, so a user who caps at 30 fps sees a spectrum that updates 30
   * times a second rather than a spectrum that flickers.
   */
  if ((dirty || player.isPlaying) && allowDraw('spectrum')) {
    // Only a frame that really drew clears the flag: the first pass usually runs before the analyser
    // has attached, and treating that as "drawn" would leave a blank canvas on a paused player.
    if (paint()) dirty = false
  }
  frame = window.requestAnimationFrame(loop)
}

async function attach(force = false): Promise<void> {
  state.value = 'connecting'
  analyserBridge = await acquireSpectrum(player.audio, force)
  state.value = analyserBridge ? 'ready' : 'blocked'
  dirty = true
}

/**
 * The player's audio element, or `null` when it cannot be reached *yet*.
 *
 * Deliberately not `player.audio` at the call site: reading it during `onMounted` and having it throw
 * takes the paint loop and the resize observer down with it, and the visible result is a permanently
 * blank canvas with no error anywhere — the exact failure this component must not have.
 */
function audioElement(): HTMLAudioElement | null {
  try {
    const element = (player as unknown as { audio?: HTMLAudioElement }).audio
    return element && typeof element.addEventListener === 'function' ? element : null
  } catch {
    return null
  }
}

onMounted(() => {
  const element = audioElement()
  /*
   * `force` means "a gesture has already unlocked audio". A track that is already playing at mount
   * time is that case — and it is the *only* chance to say so, because the `play` event has already
   * fired and `isPlaying` will not change again until the user toggles it.
   */
  void attach(element ? element.paused === false : false)
  /*
   * The element's own `play` event is the most reliable "now the browser will let us have audio"
   * signal there is: it only fires once playback has genuinely been permitted (usually by a real
   * user gesture), which is exactly when `AudioContext.resume()` will succeed. The `isPlaying` watch
   * below covers the store-driven path, but it only fires on a *change* — if the store already
   * believed it was playing (a track that ended, or a restore after restart) no change arrives and
   * the analyser would never attach at all.
   */
  if (element) {
    const onPlay = (): void => {
      if (!analyserBridge) void attach(true)
    }
    element.addEventListener('play', onPlay)
    offPlayHook = () => element.removeEventListener('play', onPlay)
  }
  // The canvas only needs to repaint while the view is open; the analyser keeps the last frame's data
  // either way, so a paused player simply draws its (near-flat) current spectrum.
  frame = window.requestAnimationFrame(loop)
  if (typeof ResizeObserver !== 'undefined' && canvas.value) {
    resizeObserver = new ResizeObserver(() => {
      dirty = true
      paint()
    })
    resizeObserver.observe(canvas.value)
  }
})

onBeforeUnmount(() => {
  window.cancelAnimationFrame(frame)
  resizeObserver?.disconnect()
  resizeObserver = null
  offPlayHook?.()
  offPlayHook = null
  // The audio graph itself is deliberately left alone: tearing down a MediaElementSource would take
  // playback with it, and it can never be rebuilt for the same element.
})

watch(() => player.isPlaying, () => {
  dirty = true
  /*
   * Starting playback *is* the gesture that unlocks the audio context, and this view is routinely
   * opened before anything has been played. Retrying here is what turns "the visualiser never
   * attached (the page opened too early) and stayed blank" into "it lights up as soon as music
   * starts". `acquireSpectrum` is idempotent and returns early once a bridge exists.
   */
  if (!analyserBridge) void attach(true)
})
</script>

<template>
  <div class="spectrum">
    <canvas ref="canvas" class="spectrum-canvas" :style="{ '--spectrum-accent': accent || 'var(--accent)' }"></canvas>
    <div v-if="state === 'blocked'" class="spectrum-blocked">
      <p>音频分析需要一次交互才能启用（浏览器音频上下文尚未运行）。</p>
      <button class="glass-button" @click="attach(true)">开启律动</button>
    </div>
  </div>
</template>
