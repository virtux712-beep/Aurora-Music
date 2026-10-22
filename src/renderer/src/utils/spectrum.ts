/**
 * The analyser the visualisers draw from.
 *
 * This file used to *own* the Web Audio graph. It no longer does: `audio/engine.ts` does, because a
 * player needs filters, per-deck gain, and two decks — and `createMediaElementSource` may only be
 * called once per element, so a second graph builder would be a second source of truth that could not
 * even exist. What remains here is the *subscription* layer: one shared rAF loop, one frame shape, and
 * the retry policy that decides when a suspended context may be started.
 *
 * The analyser itself sits on the engine's bus, so it keeps delivering frames across a track change,
 * and the visualisers never re-attach.
 *
 * Nothing here fakes data: when the bridge cannot attach, the caller is told so and the UI says so.
 */
import { analyserBridge, ensureGraph } from '../audio/engine'

export interface SpectrumBridge {
  analyser: AnalyserNode
  /** Reused frame buffer — allocating 1024 bytes per frame is how a visualiser causes GC hitching. */
  data: Uint8Array
}

/**
 * One frame of analysed audio, in 0..1 units.
 *
 * `bass` is the low-frequency energy that a physical record shows as movement, and it is what the
 * vinyl view reacts to; `level` is the overall loudness. Nothing here is simulated — a silent track
 * reports zeros, which is exactly what the UI then shows.
 */
export interface SpectrumFrame {
  bass: number
  level: number
}

/** Bins below this frequency count as "bass"; at fftSize 2048 over 44.1 kHz that is roughly 5 bins. */
const BASS_BINS = 6

/**
 * Attaches (once) and hands back the analyser, or `null` while the audio graph cannot be used (no
 * WebAudio, or a context that is still suspended because the page has had no gesture yet).
 *
 * `force` re-attempts the resume — call it from a click handler, where the gesture unlocks the context,
 * rather than on a timer. The `element` argument is kept for call-site compatibility and for the rare
 * case where the engine has not been told about the deck yet; the graph itself is the engine's.
 */
export async function acquireSpectrum(_element: HTMLAudioElement | null = null, force = false): Promise<SpectrumBridge | null> {
  const ok = await ensureGraph(force)
  if (!ok) return null
  return analyserBridge()
}

/**
 * Frame subscription for anything that wants the audio *values* rather than a drawing of them — the
 * vinyl view uses it to move light with the bass.
 *
 * One `requestAnimationFrame` loop is shared by every listener: a second visualiser must not mean a
 * second 60 Hz loop reading the same analyser. The loop lives exactly as long as it has subscribers,
 * and it never attaches to the element itself — an element the user has not played yet cannot be
 * attached without risking silence (see the note at the top of this file), so a `null` frame is
 * delivered until a bridge exists, and the consumer decides what to show.
 *
 * `getElement` is a getter rather than a value because the audio element is created by the player and
 * handed over later.
 */
export function subscribeSpectrum(
  getElement: () => HTMLAudioElement | null,
  listener: (frame: SpectrumFrame | null) => void,
): () => void {
  listeners.add(listener)
  if (listeners.size === 1) startLoop(getElement)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) stopLoop()
  }
}

/**
 * Whether anything on screen is asking for analyser frames.
 *
 * The player asks this before building the audio graph: the graph is the one operation that can silence
 * playback if it goes wrong, so it is worth building for a live visualiser — and not worth building for a
 * user who never opens one.
 */
export function spectrumWanted(): boolean {
  return listeners.size > 0
}

const listeners = new Set<(frame: SpectrumFrame | null) => void>()
let loopHandle = 0
let getAudioElement: (() => HTMLAudioElement | null) | null = null
/** When the last attach attempt ran, and how many of them were allowed to `resume()` the context. */
let lastAttempt = 0
let forcedAttempts = 0
/** How often the loop may retry an attach — see the note in `startLoop`. */
const ATTEMPT_INTERVAL_MS = 1000
/** How many times a not-yet-running context may be resumed before the loop stops asking. */
const MAX_FORCED_ATTEMPTS = 6

/** Smoothed so the visual response reads as movement rather than as per-frame noise. */
let smoothedBass = 0
/** Frames still to skip before the next analyser read, while the signal is known to be silent. */
let silentFrames = 0
/** How many frames to skip between reads of a silent signal. */
const SILENT_STRIDE = 6

function startLoop(getElement: () => HTMLAudioElement | null): void {
  getAudioElement = getElement
  const step = (): void => {
    loopHandle = window.requestAnimationFrame(step)
    const element = getAudioElement?.() ?? null
    const bridge = analyserBridge()
    if (!bridge) {
      /*
       * Attaching is attempted lazily, and **throttled**.
       *
       * `force` when the element is already playing is not a shortcut — it is the only signal this loop
       * can have that the audio context is allowed to run: audible playback means a gesture happened, and
       * `resume()` is what turns that into a running context. Without it the loop's very first frame (taken
       * before anything had been played) returned `null` and, because the loop never re-forced,
       * `--music-energy` stayed 0 for the rest of the session — every "the theme moves with the music" rule
       * was multiplying by a constant zero.
       *
       * The throttle is not politeness. Chromium leaves `resume()` *pending* rather than rejecting it while
       * the document may not make noise, so attempting it on every frame would queue ~60 never-settling
       * promises (each with its own 1500 ms deadline timer) every second — a leak that wedges the renderer,
       * which is exactly what a first version of this did. And the attempts stop after a few tries: a
       * context that will not start is not going to start because we asked a sixtieth time.
       */
      const now = performance.now()
      const playing = element !== null && element.paused === false
      if (element && now - lastAttempt >= ATTEMPT_INTERVAL_MS && (playing ? forcedAttempts < MAX_FORCED_ATTEMPTS : true)) {
        lastAttempt = now
        if (playing) forcedAttempts += 1
        // Whatever deck is playing, the engine attaches both — the analyser then sits on their shared
        // bus, so a track change does not interrupt the frames.
        void ensureGraph(playing)
      }
      for (const listener of listeners) listener(null)
      return
    }
    const { analyser, data } = bridge
    /*
     * Silence is read at a fraction of the frame rate.
     *
     * The FFT is the most expensive thing in this loop — a transform over the whole bin array plus two passes
     * over it, at the display's rate, for the entire session. A paused player (or a silent passage) has
     * nothing to report, so the reads are spaced out while the signal is known to be silent and snap back to
     * every frame the moment anything is heard. Nothing about the visuals changes: a silent frame produces
     * zero energy whether it was measured or skipped, and the first audible frame is at most `SILENT_STRIDE`
     * frames (≈ 36 ms on a 165 Hz panel) later than it used to be.
     */
    if (silentFrames > 0) {
      silentFrames -= 1
      const decayed: SpectrumFrame = { bass: smoothedBass * 0.9, level: 0 }
      smoothedBass = decayed.bass
      for (const listener of listeners) listener(decayed)
      return
    }
    analyser.getByteFrequencyData(data)
    let bass = 0
    let silent = true
    for (let index = 0; index < BASS_BINS; index += 1) {
      const bin = data[index] ?? 0
      if (bin !== 0) silent = false
      bass += bin
    }
    bass = bass / BASS_BINS / 255
    let total = 0
    for (let index = 0; index < data.length; index += 1) {
      const bin = data[index]
      if (bin !== 0) silent = false
      total += bin
    }
    if (silent) silentFrames = SILENT_STRIDE - 1
    const level = total / data.length / 255
    // Attack fast, release slow: that asymmetry is what makes the light feel driven by the music.
    smoothedBass = bass > smoothedBass ? bass : smoothedBass * 0.88 + bass * 0.12
    const frame: SpectrumFrame = { bass: smoothedBass, level }
    for (const listener of listeners) listener(frame)
  }
  loopHandle = window.requestAnimationFrame(step)
}

function stopLoop(): void {
  window.cancelAnimationFrame(loopHandle)
  loopHandle = 0
  getAudioElement = null
  smoothedBass = 0
  silentFrames = 0
  lastAttempt = 0
  forcedAttempts = 0
}
