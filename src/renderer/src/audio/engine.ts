/**
 * Aurora's audio engine — the one place that owns the Web Audio graph.
 *
 * ## Why this file exists
 *
 * The graph used to be created by whichever visualiser happened to mount first (`utils/spectrum.ts`),
 * purely to get an `AnalyserNode`. That worked for one element and one purpose. It does not work for
 * what a player needs:
 *
 *   - **two decks**, so the next track can be prepared while the current one plays (gapless) or
 *     overlapped with it (crossfade);
 *   - **filters**, because a graphic EQ is just ten `BiquadFilterNode`s in a row;
 *   - **per-track gain**, because loudness normalisation must be applied per deck: during a crossfade
 *     two different tracks are audible at once, each with its own level.
 *
 * ## The shape
 *
 * ```
 *   deck A: element → source → loudnessGain → fadeGain ┐
 *                                                      ├→ bus → preamp → EQ ×10 → analyser → destination
 *   deck B: element → source → loudnessGain → fadeGain ┘
 * ```
 *
 * The analyser sits on the **bus, not on a deck**, and that is deliberate: it keeps working across a
 * track change, so the visualisers never have to re-attach. (`createMediaElementSource` may only be
 * called once per element, so "re-attach on swap" would be impossible anyway.)
 *
 * ## The two constraints inherited from the DOM
 *
 *  1. `createMediaElementSource` is once-per-element and permanent. Both decks are therefore attached
 *     in one go, and never detached.
 *  2. An attached element plays *through the context*, so attaching while the context is `suspended`
 *     silences playback. The graph is only built when the context is genuinely `running`, and `force`
 *     (a user gesture) is the only thing allowed to try to start it.
 *
 * ## Volume, and what this engine deliberately does not touch
 *
 * The element's own `volume` stays the user's volume control, exactly as before — the engine only adds
 * nodes *around* it. Loudness gain and crossfade fades live on the gains, because they are per-track
 * and per-transition, while volume is per-listener.
 */
import { EQ_BAND_FREQUENCIES, EQ_GAIN_LIMIT_DB, type SoundSettings } from '../../../shared/sound'
import { dbToGain } from './loudness'

export interface AnalyserBridge {
  analyser: AnalyserNode
  data: Uint8Array
}

export interface AudioDeck {
  index: 0 | 1
  element: HTMLAudioElement
}

export interface OutputDevice {
  deviceId: string
  label: string
  /** The browser's own default output. Always present, always first. */
  isDefault: boolean
}

export interface AudioEngineSnapshot {
  /** `running` / `suspended` / `closed`, or `unattached` before the graph exists. */
  contextState: string
  /** Whether the elements are routed through the graph at all. */
  attached: boolean
  equalizerEnabled: boolean
  /** Highest band gain currently in force, in dB — the number that explains "why is it loud". */
  peakEqDb: number
  loudnessGainDb: [number, number]
  fade: [number, number]
  /** The device audio is actually going to, as reported back by the context. */
  outputDeviceId: string
  /** `context` when `AudioContext.setSinkId` was used, `element` for the per-element fallback. */
  outputRoute: 'context' | 'element' | 'none'
  decks: number
  /** Nodes in the live chain (bus + preamp + EQ bands + output), for the diagnostics panel. */
  chainNodes: number
  /**
   * Whether the chain was actually connected to the destination.
   *
   * Reported because this is the one failure no other number can see: an analyser measures its *input*, so a
   * graph whose decks feed nothing (`bus` not connected onwards) and a graph whose output never reaches the
   * speakers (`tap` not connected to the destination) both read as "working" from inside the page while the
   * user hears silence. A wiring assertion needs the wiring to say what it did.
   */
  destinationConnected: boolean
}

/** Chromium leaves `resume()` pending until the page may make noise; this bounds the wait. */
const RESUME_DEADLINE_MS = 1500

/** Deck A is the element the store plays first; deck B is the one it prepares. */
const DECK_COUNT = 2

/*
 * The decks are created on first use, not at import time.
 *
 * A module that touches the DOM just by being imported cannot be loaded anywhere without a window — which is
 * exactly what the offline smoke suites do: they import the theme/effect graph, and that graph reaches this
 * file for the analyser. Under Node the old top-level `new Audio()` threw `ReferenceError: Audio is not
 * defined` before a single assertion ran, so the failure looked like a broken theme suite rather than a
 * constant-time side effect in the audio engine.
 */
const elements: HTMLAudioElement[] = []

function ensureDeck(index: number): HTMLAudioElement {
  const existing = elements[index]
  if (existing) return existing
  const element = new Audio()
  element.preload = 'metadata'
  // Marks the element so a probe (or a confused future reader) can tell which deck it is looking at.
  element.dataset.deck = String(index)
  elements[index] = element
  return element
}

let context: AudioContext | null = null
let attached = false
let attaching: Promise<boolean> | null = null
/** Terminal: `createMediaElementSource` threw, so no retry can ever succeed. */
let unrecoverable = false

let busGain: GainNode | null = null
let preampGain: GainNode | null = null
let outGain: GainNode | null = null
let analyser: AnalyserNode | null = null
let analyserData: Uint8Array | null = null
const filters: BiquadFilterNode[] = []
const sources: (MediaElementAudioSourceNode | null)[] = [null, null]
const loudnessGains: (GainNode | null)[] = [null, null]
const fadeGains: (GainNode | null)[] = [null, null]

let equalizerEnabled = false
/** The last EQ settings handed to `applyEqualizer`, replayed onto the filters once they exist. */
let appliedEqualizer: SoundSettings['equalizer'] = {
  enabled: false,
  preset: 'flat',
  gains: EQ_BAND_FREQUENCIES.map(() => 0),
  preampDb: 0,
}
let loudnessGainDb: [number, number] = [0, 0]
let fadeValues: [number, number] = [1, 1]
let outputDeviceId = ''
let outputRoute: 'context' | 'element' | 'none' = 'none'
let destinationConnected = false

function audioContext(): AudioContext | null {
  if (context) return context
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null
  context = new Ctor()
  return context
}

export function deckElements(): readonly HTMLAudioElement[] {
  return everyDeck()
}

export function deckElement(index: 0 | 1): HTMLAudioElement {
  return ensureDeck(index)
}

/** The engine's own decks, for anything that wants the pair rather than just the active one. */
export function deckIndexOf(element: HTMLAudioElement): 0 | 1 {
  return element === elements[1] ? 1 : 0
}

/** Every deck, created if it has not been touched yet. */
function everyDeck(): HTMLAudioElement[] {
  return Array.from({ length: DECK_COUNT }, (_unused, index) => ensureDeck(index))
}

export function graphReady(): boolean {
  return attached
}

export function analyserBridge(): AnalyserBridge | null {
  if (!attached || !analyser || !analyserData) return null
  return { analyser, data: analyserData }
}

/**
 * Builds the graph, once, or explains why it cannot be built yet.
 *
 * `force` must come from a real gesture. The whole attempt is shared between concurrent callers —
 * two racing attempts on the same elements would have one of them throw on
 * `createMediaElementSource` and mark the engine unrecoverable for the rest of the session.
 */
export function ensureGraph(force = false): Promise<boolean> {
  if (attached) return Promise.resolve(true)
  if (unrecoverable) return Promise.resolve(false)
  if (attaching) return attaching

  const attempt = (async (): Promise<boolean> => {
    const ctx = audioContext()
    if (!ctx) return false
    if (ctx.state !== 'running') {
      if (!force) return false
      try {
        await Promise.race([ctx.resume(), new Promise((resolve) => setTimeout(resolve, RESUME_DEADLINE_MS))])
      } catch {
        // A rejected resume is the normal autoplay-policy answer; the caller stays un-attached.
      }
    }
    // Checked *after* the resume: attaching a suspended context is what silences playback.
    if (ctx.state !== 'running') return false

    const bus = ctx.createGain()
    const preamp = ctx.createGain()
    const out = ctx.createGain()
    /*
     * Every band exists from the start, with gain 0. Creating and destroying filters on enable/disable
     * would click (a node swap is not a parameter change), and 0 dB of a peak filter is a true bypass of
     * that band, so "disabled" is just "all zero" rather than a rewiring.
     */
    const bandFilters = EQ_BAND_FREQUENCIES.map((frequency, index) => {
      const filter = ctx.createBiquadFilter()
      // Band 0 is a low shelf and the last band is a high shelf: a peaking filter at 31 Hz has almost
      // no effect on real speakers, and a shelf is what "more bass" actually means.
      filter.type = index === 0 ? 'lowshelf' : index === EQ_BAND_FREQUENCIES.length - 1 ? 'highshelf' : 'peaking'
      filter.frequency.value = frequency
      filter.Q.value = 1
      filter.gain.value = 0
      return filter
    })
    const tap = ctx.createAnalyser()
    tap.fftSize = 2048
    tap.smoothingTimeConstant = 0.8

    /*
     * The bus is where both decks arrive, and it *must* be connected onwards. It was not, in the first
     * version of this graph — the decks fed a node connected to nothing, so attaching the graph (that is,
     * switching the EQ on, or letting a visualiser take the analyser) silenced playback completely while
     * the element clock kept running. That failure mode is the reason this line has a comment at all:
     * "the music went quiet when I turned the EQ on" is a wiring mistake, not a mysterious codec problem.
     */
    bus.connect(preamp)
    preamp.connect(bandFilters[0] as BiquadFilterNode)
    for (let index = 0; index < bandFilters.length - 1; index += 1) {
      ;(bandFilters[index] as BiquadFilterNode).connect(bandFilters[index + 1] as BiquadFilterNode)
    }
    ;(bandFilters[bandFilters.length - 1] as BiquadFilterNode).connect(out)
    out.connect(tap)
    // The analyser is a tap, not a sink: without this the graph would be silent.
    tap.connect(ctx.destination)
    destinationConnected = true

    try {
      for (let index = 0; index < DECK_COUNT; index += 1) {
        const element = everyDeck()[index] as HTMLAudioElement
        const source = ctx.createMediaElementSource(element)
        const loudness = ctx.createGain()
        const fade = ctx.createGain()
        fade.gain.value = 1
        source.connect(loudness)
        loudness.connect(fade)
        fade.connect(bus)
        sources[index] = source
        loudnessGains[index] = loudness
        fadeGains[index] = fade
      }
    } catch {
      // Second source for the same element — unrecoverable by construction.
      unrecoverable = true
      return false
    }

    busGain = bus
    preampGain = preamp
    outGain = out
    filters.splice(0, filters.length, ...bandFilters)
    analyser = tap
    analyserData = new Uint8Array(tap.frequencyBinCount)
    attached = true
    /*
     * A device chosen *before* the graph existed was applied to the elements, which no longer reach the
     * speakers once they are attached. Re-applying it on the context is what keeps "I picked my DAC" true
     * across the moment the EQ gets switched on.
     */
    if (outputDeviceId) void setOutputDevice(outputDeviceId)
    /*
     * Replay the state that was configured *before* the graph existed. The settings page can arm the EQ
     * while a song is already playing (no `play` event is coming), and a curve that silently waited for the
     * next track would read as "the switch does nothing" — which is exactly the bug this replays away.
     */
    applyEqualizer(appliedEqualizer)
    setLoudnessGain(0, loudnessGainDb[0], 0)
    setLoudnessGain(1, loudnessGainDb[1], 0)
    setFade(0, fadeValues[0], 0)
    setFade(1, fadeValues[1], 0)
    mirrorToDom()
    return true
  })()

  attaching = attempt.then(
    (result) => {
      attaching = null
      return result
    },
    () => {
      attaching = null
      return false
    },
  )
  return attaching
}

/**
 * Applies the EQ settings.
 *
 * `enabled: false` zeroes every band rather than bypassing the chain: a 0 dB peak filter is
 * mathematically flat, and keeping the nodes in place is what makes toggling the switch click-free.
 */
export function applyEqualizer(settings: SoundSettings['equalizer']): void {
  equalizerEnabled = settings.enabled
  appliedEqualizer = { ...settings, gains: [...settings.gains] }
  if (attached) {
    const target = settings.enabled ? 1 : 0
    const peak = settings.gains.reduce((best, gain) => Math.max(best, Math.abs(gain)), 0)
    // Guard in the graph too, not only in the settings sanitizer: a hand-built patch in dev tools must
    // not be able to drive a 400 dB boost into a filter.
    const scale = settings.enabled && peak > EQ_GAIN_LIMIT_DB ? EQ_GAIN_LIMIT_DB / peak : 1
    if (preampGain) preampGain.gain.value = target === 1 ? dbToGain(settings.preampDb) : 1
    for (let index = 0; index < filters.length; index += 1) {
      const filter = filters[index]
      if (!filter) continue
      filter.gain.value = settings.enabled ? (settings.gains[index] ?? 0) * scale : 0
    }
  }
  mirrorToDom()
}

/** Per-deck loudness gain. Ramped, because a jump here is an audible click. */
export function setLoudnessGain(index: 0 | 1, db: number, rampSeconds = 0.4): void {
  loudnessGainDb[index] = db
  const node = loudnessGains[index]
  if (!node || !context) {
    mirrorToDom()
    return
  }
  if (rampSeconds <= 0) {
    node.gain.setValueAtTime(dbToGain(db), context.currentTime)
  } else {
    node.gain.setTargetAtTime(dbToGain(db), context.currentTime, rampSeconds / 3)
  }
  mirrorToDom()
}

/**
 * Crossfade fader for one deck. `rampSeconds === 0` is an instant set (used when a deck is (re)started
 * outside a fade, where a ramp would delay the first sample).
 */
export function setFade(index: 0 | 1, value: number, rampSeconds = 0): void {
  const target = Math.min(1, Math.max(0, value))
  fadeValues[index] = target
  const node = fadeGains[index]
  if (!node || !context) {
    mirrorToDom()
    return
  }
  if (rampSeconds <= 0) {
    node.gain.cancelScheduledValues(context.currentTime)
    node.gain.setValueAtTime(target, context.currentTime)
  } else {
    node.gain.cancelScheduledValues(context.currentTime)
    node.gain.setValueAtTime(node.gain.value, context.currentTime)
    node.gain.linearRampToValueAtTime(target, context.currentTime + rampSeconds)
  }
  mirrorToDom()
}

export function fadeValue(index: 0 | 1): number {
  return fadeValues[index]
}

export function setOutputDeviceId(id: string): void {
  outputDeviceId = id
  mirrorToDom()
}

export function currentOutputDeviceId(): string {
  return outputDeviceId
}

/**
 * Routes playback to an output device.
 *
 * Two mechanisms, because there are two situations. Once the elements are inside the graph the audio
 * leaves through the context, so `AudioContext.setSinkId` is the only one that matters (routing the
 * *elements* would then be a no-op — the elements no longer reach the speakers directly). Before that,
 * the elements are on their own, and their own `setSinkId` is exactly right.
 *
 * The returned `via` is what actually happened, reported back rather than assumed: a build without
 * `AudioContext.setSinkId` must show "not supported" instead of a switch that silently does nothing.
 */
export async function setOutputDevice(deviceId: string): Promise<{ applied: boolean; via: 'context' | 'element' | 'none'; reason?: string }> {
  const wanted = deviceId || ''
  const ctx = context
  if (attached && ctx) {
    const target = ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> }
    if (typeof target.setSinkId !== 'function') {
      setOutputDeviceId(wanted)
      outputRoute = 'none'
      mirrorToDom()
      return { applied: false, via: 'none', reason: '当前运行时（Electron/Chromium）不支持在音频上下文上切换输出设备' }
    }
    try {
      await target.setSinkId(wanted)
      setOutputDeviceId(wanted)
      outputRoute = 'context'
      mirrorToDom()
      return { applied: true, via: 'context' }
    } catch (error) {
      const message = error instanceof Error ? error.message : '切换输出设备失败'
      mirrorToDom()
      return { applied: false, via: 'none', reason: message }
    }
  }

  const element = everyDeck()[0] as HTMLAudioElement
  const target = element as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }
  if (typeof target.setSinkId !== 'function') {
    setOutputDeviceId(wanted)
    outputRoute = 'none'
    mirrorToDom()
    return { applied: false, via: 'none', reason: '当前运行时不支持切换输出设备' }
  }
  try {
    await Promise.all(everyDeck().map((item) => (item as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }).setSinkId?.(wanted) ?? Promise.resolve()))
    setOutputDeviceId(wanted)
    outputRoute = 'element'
    mirrorToDom()
    return { applied: true, via: 'element' }
  } catch (error) {
    const message = error instanceof Error ? error.message : '切换输出设备失败'
    mirrorToDom()
    return { applied: false, via: 'none', reason: message }
  }
}

/**
 * The system's output devices, as Chromium reports them.
 *
 * Labels need permission on some platforms and come back empty without it; an empty label is shown as
 * an indexed name rather than hidden, because a device with no name is still a device you may want.
 */
export async function listOutputDevices(): Promise<OutputDevice[]> {
  const devices: OutputDevice[] = [{ deviceId: '', label: '系统默认输出', isDefault: true }]
  try {
    if (!navigator.mediaDevices?.enumerateDevices) return devices
    const all = await navigator.mediaDevices.enumerateDevices()
    const outputs = all.filter((device) => device.kind === 'audiooutput')
    for (const device of outputs) {
      // `default` and `communications` are duplicate aliases of the empty-string default.
      if (!device.deviceId || device.deviceId === 'default' || device.deviceId === 'communications') continue
      devices.push({
        deviceId: device.deviceId,
        label: device.label || `输出设备 ${devices.length}`,
        isDefault: false,
      })
    }
  } catch {
    // No enumeration (rare, and not fatal): the default entry still lets the user get back to it.
  }
  return devices
}

export function snapshot(): AudioEngineSnapshot {
  return {
    contextState: attached ? (context?.state ?? 'unknown') : 'unattached',
    attached,
    equalizerEnabled,
    peakEqDb: filters.reduce((best, filter) => Math.max(best, Math.abs(filter.gain.value)), 0),
    loudnessGainDb: [loudnessGainDb[0], loudnessGainDb[1]],
    fade: [fadeValues[0], fadeValues[1]],
    outputDeviceId,
    outputRoute,
    decks: DECK_COUNT,
    chainNodes: [busGain, preampGain, outGain].filter(Boolean).length + filters.length,
    destinationConnected,
  }
}

/**
 * Mirrors the engine's state onto `<html>` as `data-audio-*`.
 *
 * Same reason the frame governor publishes a DOM mirror: a test — and a person with dev tools — must be
 * able to read what the audio graph is *actually* doing, not what the settings page says it should be
 * doing. The values are cheap strings, written only when something changes.
 */
export function mirrorToDom(): void {
  const root = typeof document === 'undefined' ? null : document.documentElement
  if (!root) return
  const state = snapshot()
  root.dataset.audioAttached = state.attached ? 'true' : 'false'
  root.dataset.audioContext = state.contextState
  root.dataset.audioEq = equalizerEnabled ? 'on' : 'off'
  root.dataset.audioEqPeak = state.peakEqDb.toFixed(1)
  root.dataset.audioLoudnessA = state.loudnessGainDb[0].toFixed(1)
  root.dataset.audioLoudnessB = state.loudnessGainDb[1].toFixed(1)
  root.dataset.audioFadeA = state.fade[0].toFixed(2)
  root.dataset.audioFadeB = state.fade[1].toFixed(2)
  root.dataset.audioOutput = state.outputDeviceId || 'default'
  root.dataset.audioOutputRoute = state.outputRoute
  root.dataset.audioDecks = String(state.decks)
  root.dataset.audioChainNodes = String(state.chainNodes)
  root.dataset.audioDestination = state.destinationConnected ? 'connected' : 'disconnected'
}

/** Test/diagnostic helper: does the graph expose a running analyser right now? */
export function hasAnalyser(): boolean {
  return analyser !== null && attached
}

mirrorToDom()
