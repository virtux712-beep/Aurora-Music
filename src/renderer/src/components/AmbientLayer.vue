<script setup lang="ts">
/*
 * The skin's ambient layer — the thing that makes a theme a *space* rather than a palette.
 *
 * Five particle behaviours share one canvas and one loop, because five separate components would mean
 * five animation frames per screen for something that is decorative by definition. The shapes are
 * drawn from the skin's own ambient colours (read from CSS custom properties, so a user theme tints
 * them the same way a built-in one does) and never use images.
 *
 * Honesty and cost, in that order:
 *
 *  - particles are *motion*, so `prefers-reduced-motion` draws one static frame and stops;
 *  - the loop stops when the document is hidden, so a minimised window costs nothing;
 *  - density is expressed per 100 000 px² and hard-capped, so a 4K window does not silently ask for
 *    ten times the work of a laptop screen;
 *  - every frame goes through the frame governor (`allowDraw`), so the user's frame cap and the display's
 *    own refresh rate both apply here rather than each layer inventing its own cadence. The cost of that
 *    gate on the frame after a *level* change is what `rampFactor` smooths: growing the field fills in
 *    over ~0.7 s instead of snapping from 31 particles to 90.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { subscribeEnergy } from '../theme/effects/energy'
import { allowDraw, rampFactor, renderScaleFactor, reportParticles } from '../visual/frame'
import type { ParticleKind } from '../../../shared/theme'

const props = withDefaults(
  defineProps<{
    particles?: ParticleKind
    density?: number
    speed?: number
    /** Period of the background's drift, in seconds. Longer reads as calmer. */
    driftSeconds?: number
    /** How much playback energy may speed the field up (0…1). Applied per frame, never re-rendered. */
    react?: number
    /** `devicePixelRatio` cap, set by the animation level. */
    dpr?: number
    /** Strength of the ambient glow behind page content (0…1). */
    glow?: number
    /** The user's 氛围动效 switch: off means no particles *and* no glow, not just fewer particles. */
    enabled?: boolean
    /** Lets the immersive page run a denser field than the shell behind the app. */
    boost?: number
  }>(),
  { particles: 'none', density: 0, speed: 10, driftSeconds: 90, glow: 0.1, enabled: true, boost: 1, react: 0, dpr: 1.5 },
)

/** The kind actually drawn: the switch turns the whole field off, whatever the skin asks for. */
const activeKind = computed<ParticleKind>(() => (props.enabled ? props.particles : 'none'))
const activeGlow = computed(() => (props.enabled ? props.glow : 0))

const canvas = ref<HTMLCanvasElement | null>(null)
/**
 * The music's contribution to the field, updated per frame by the shared energy loop.
 *
 * A plain module-scoped number, not a `ref`: this changes 60 times a second, and making it reactive
 * would re-render the component (and every consumer of the object that holds it) at that rate for a
 * value that only ever feeds a canvas draw call.
 */
let energy = 0
let stopEnergy: (() => void) | null = null
/** The idle scale the canvas was last sized with, so the loop can notice a change and re-allocate once. */
let renderScale = 1

interface Particle {
  x: number
  y: number
  size: number
  /** Per-particle speed multiplier, so the field never moves in lockstep. */
  rate: number
  phase: number
  opacity: number
}

let particles: Particle[] = []
let frame = 0
let width = 0
let height = 0
let resizeObserver: ResizeObserver | null = null
let colors = ['#8fa6ff', '#c9a2ff']
let reducedMotion = false

/** Hard ceiling on particles regardless of window size — this layer is decoration, not content. */
const MAX_PARTICLES = 90

function readColors(): void {
  const styles = getComputedStyle(document.documentElement)
  const pick = (name: string, fallback: string): string => styles.getPropertyValue(name).trim() || fallback
  colors = [pick('--ambient-a', '#8fa6ff'), pick('--ambient-b', '#c9a2ff')]
}

function spawn(): void {
  const kind = activeKind.value
  if (kind === 'none' || width === 0 || height === 0) {
    particles = []
    reportParticles(0)
    // Clearing here matters: `draw` bails out early with no particles, so without this the last frame
    // would stay on screen and "氛围动效已关闭" would be a label over a still-visible particle field.
    clear()
    return
  }
  const count = Math.min(MAX_PARTICLES, Math.round((props.density * props.boost * width * height) / 100_000))
  particles = Array.from({ length: Math.max(0, count) }, () => ({
    x: Math.random() * width,
    y: Math.random() * height,
    size: kind === 'mist' ? 90 + Math.random() * 160 : kind === 'rain' ? 8 + Math.random() * 14 : 0.8 + Math.random() * 2.2,
    rate: 0.45 + Math.random(),
    phase: Math.random() * Math.PI * 2,
    opacity: 0.25 + Math.random() * 0.6,
  }))
}

function resize(): void {
  const element = canvas.value
  if (!element) return
  /*
   * The backing store is the level's own pixel-ratio cap **times the governor's idle scale**.
   *
   * A paused window keeps drawing this field, and at thirty frames a second the cost left is pure fill —
   * a screen-sized buffer repainted and re-uploaded to move soft dust a few pixels per second. Drawing it
   * at 70 % of the cap and letting the compositor scale it back up is invisible at those speeds and
   * removes about half the pixels; the full cap returns the instant playback starts. See `IDLE_RENDER_SCALE`
   * for the measurement this comes from.
   *
   * The transform is set to the *same* factor, so every shape keeps its CSS-pixel coordinates and only the
   * sharpness changes — nothing in `draw` needs to know about this.
   */
  const scale = renderScaleFactor()
  const ratio = Math.min(window.devicePixelRatio || 1, (props.dpr || 1.5) * scale)
  renderScale = scale
  width = element.clientWidth
  height = element.clientHeight
  element.width = Math.round(width * ratio)
  element.height = Math.round(height * ratio)
  const context = element.getContext('2d')
  context?.setTransform(ratio, 0, 0, ratio, 0, 0)
  spawn()
}

/** Wipes the canvas. Used when the field goes away, not between frames (see `draw`). */
function clear(): void {
  const context = canvas.value?.getContext('2d')
  if (context) context.clearRect(0, 0, width, height)
}

/** `elapsed` in seconds — the shapes are defined in seconds, not frames, so speed is window-rate independent. */
function draw(elapsed: number, moving: boolean): void {
  const element = canvas.value
  const context = element?.getContext('2d')
  if (!element || !context || particles.length === 0) return
  context.clearRect(0, 0, width, height)
  const kind = activeKind.value
  const drift = moving ? elapsed : 0
  /*
   * How many of them are drawn this frame.
   *
   * Slicing the array would allocate once per frame at the display's rate; an index bound costs nothing.
   * The ramp applies to the *count* rather than to size or opacity so a recovery is literally "more of
   * them over the next two thirds of a second", which is what makes it read as filling back in.
   */
  const ramp = rampFactor()
  const bound = ramp >= 1 ? particles.length : Math.max(1, Math.round(particles.length * ramp))
  // Published for Aurora Lab: the count that was actually looped over, not the density that asked for it.
  reportParticles(bound)
  /*
   * The music only ever *adds* motion on top of the skin's tempo (`react` is 0 for themes that ignore
   * playback, and the animation level multiplies it). Because it is derived from the analyser rather
   * than from a CSS variable, the coupling costs no layout and no style recalc.
   */
  const live = 1 + energy * props.react * 0.7

  for (let index = 0; index < bound; index += 1) {
    const particle = particles[index]!
    switch (kind) {
      case 'stars': {
        // Slow diagonal drift plus a twinkle; a star field that only twinkles reads as a screensaver.
        const x = (particle.x + drift * props.speed * live * particle.rate * 0.12) % width
        const y = (particle.y + drift * props.speed * live * particle.rate * 0.05) % height
        const twinkle = 0.55 + 0.45 * Math.sin(elapsed * (1.1 + energy * 1.2) + particle.phase)
        context.fillStyle = colors[0]
        context.globalAlpha = particle.opacity * twinkle
        context.beginPath()
        context.arc(x, y, particle.size * 0.5, 0, Math.PI * 2)
        context.fill()
        break
      }
      case 'leaves': {
        // Falls, sways sideways, and rotates: three motions is the minimum for a leaf to read as a leaf.
        const fall = (particle.y + drift * props.speed * live * particle.rate) % (height + 60)
        const sway = Math.sin(elapsed * 0.6 + particle.phase) * 26
        context.save()
        context.translate((particle.x + sway + width) % width, fall)
        context.rotate(Math.sin(elapsed * 0.5 + particle.phase) * 0.9)
        context.globalAlpha = particle.opacity * 0.5
        context.fillStyle = particle.phase % 2 > 1 ? colors[0] : colors[1]
        context.beginPath()
        context.ellipse(0, 0, particle.size * 2.4, particle.size, 0, 0, Math.PI * 2)
        context.fill()
        context.restore()
        break
      }
      case 'mist': {
        // Wide soft blobs, additive so overlapping puffs brighten instead of flattening.
        const x = (particle.x + drift * props.speed * live * particle.rate * 0.4) % (width + 240)
        const y = particle.y + Math.sin(elapsed * 0.25 + particle.phase) * 12
        const gradient = context.createRadialGradient(x, y, 0, x, y, particle.size)
        gradient.addColorStop(0, colors[particle.phase % 2 > 1 ? 0 : 1])
        gradient.addColorStop(1, 'rgba(0,0,0,0)')
        context.globalAlpha = particle.opacity * 0.16
        context.fillStyle = gradient
        context.beginPath()
        context.arc(x, y, particle.size, 0, Math.PI * 2)
        context.fill()
        break
      }
      case 'rain': {
        const fall = (particle.y + drift * props.speed * live * particle.rate * 3) % (height + 40)
        const x = (particle.x + fall * 0.18) % width
        context.globalAlpha = particle.opacity * 0.45
        context.strokeStyle = colors[0]
        context.lineWidth = 1
        context.beginPath()
        context.moveTo(x, fall)
        context.lineTo(x - 2, fall + particle.size)
        context.stroke()
        break
      }
      case 'dust': {
        // Rises and flickers: film grain that drifts upward, which is what warm light does.
        const rise = (particle.y - drift * props.speed * live * particle.rate * 0.5 + height) % height
        const x = (particle.x + Math.sin(elapsed * 0.4 + particle.phase) * 18 + width) % width
        context.globalAlpha = particle.opacity * (0.4 + 0.6 * Math.abs(Math.sin(elapsed * 0.9 + particle.phase)))
        context.fillStyle = particle.phase % 2 > 1 ? colors[0] : colors[1]
        context.fillRect(x, rise, particle.size * 0.8, particle.size * 0.8)
        break
      }
      default:
        break
    }
  }
  context.globalAlpha = 1
}

let started = 0
function loop(): void {
  frame = window.requestAnimationFrame(loop)
  if (document.hidden) return
  const now = performance.now()
  /*
   * Playback started or stopped: re-allocate the backing store before drawing this frame.
   *
   * A plain comparison rather than a reactive prop, for the same reason `energy` is not a `ref` — this loop
   * must not re-render the component. `resize()` is a couple of integer writes plus one transform, so
   * paying for it on the single frame that changes state is cheaper than keeping a watcher alive for it.
   */
  if (renderScaleFactor() !== renderScale) resize()
  // The governor owns the cadence: a frame past this layer's budget is skipped, and skipping is free.
  if (!allowDraw('ambient', now)) return
  draw((now - started) / 1000, !reducedMotion)
}

function restart(): void {
  readColors()
  spawn()
}

onMounted(() => {
  reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  // The shared energy loop: one analyser subscription for every visual that wants the music's level.
  stopEnergy = subscribeEnergy((value) => {
    energy = value
  })
  restart()
  resize()
  if (typeof ResizeObserver !== 'undefined' && canvas.value) {
    resizeObserver = new ResizeObserver(() => resize())
    resizeObserver.observe(canvas.value)
  }
  started = performance.now()
  frame = window.requestAnimationFrame(loop)
  // A reduced-motion user still gets the field, drawn once instead of animated.
  if (reducedMotion) window.setTimeout(() => draw(0, false), 60)
})

onBeforeUnmount(() => {
  window.cancelAnimationFrame(frame)
  resizeObserver?.disconnect()
  resizeObserver = null
  stopEnergy?.()
  stopEnergy = null
})

watch(
  () => [activeKind.value, props.density, props.speed, props.boost, props.dpr],
  () => resize(),
)
</script>

<template>
  <!--
    Two stacked layers: the drifting colour field (cheap, pure CSS, animated by the compositor) and the
    painted particles on top. Both are fixed, `pointer-events: none`, and behind the app's own content.
  -->
  <canvas ref="canvas" class="ambient-layer" aria-hidden="true"></canvas>
  <div
    v-if="activeGlow > 0"
    class="ambient-glow"
    aria-hidden="true"
    :style="{ '--ambient-glow': String(activeGlow), '--ambient-drift': `${driftSeconds}s` }"
  ></div>
</template>
