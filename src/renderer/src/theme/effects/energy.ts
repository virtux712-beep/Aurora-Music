/*
 * Music energy: the analyser's bass, as one number the visuals can read.
 *
 * Delivered two ways on purpose — a subscription for the canvas layers (which are already redrawing every
 * frame) and a CSS custom property (`--music-energy`) for everything styled — so no component has to
 * re-render 60 times a second just to react to music.
 *
 * This module used to *also* run the performance watchdog, which was wrong on two counts: it measured
 * frame cost with a fixed 22 ms threshold that is a third of a frame on a 120 Hz panel, and it only ran
 * while something was subscribed to energy — so a theme with no music coupling had no watchdog at all.
 * That job now lives in `visual/frame.ts`, which measures independently of audio and grades the load
 * against the display's own budget.
 *
 * The loop only attaches to the audio element through `subscribeSpectrum`, which is a no-op until the
 * analyser can genuinely be attached — so a silent or unplayed app costs one rAF callback and nothing
 * else.
 */
import { subscribeSpectrum } from '../../utils/spectrum'

export type EnergyListener = (energy: number) => void

const listeners = new Set<EnergyListener>()
let unsubscribeSpectrum: (() => void) | null = null
let energy = 0
let lastWrite = 0

/** How often `--music-energy` is written. 20 Hz is smooth for glow and 3× cheaper than 60 Hz. */
const CSS_WRITE_INTERVAL_MS = 50

/** The last text written, so an unchanged value is not written again. */
let lastCssText = ''

function writeCss(next: number): void {
  const text = next.toFixed(3)
  /*
   * Skip the write when the value has not changed.
   *
   * Setting a custom property on `<html>` invalidates style for everything that reads it, and this whole
   * design leans on that being read by a lot of elements. While nothing is playing — or through any quiet
   * passage — the value is a constant 0.000, and the old code was still re-writing it twenty times a second,
   * forcing a style recalculation each time to produce exactly the styles that were already there.
   */
  if (text === lastCssText) return
  lastCssText = text
  document.documentElement.style.setProperty('--music-energy', text)
}

function tick(frame: { bass: number; level: number } | null, now: number): void {
  /*
   * Energy is a blend of bass and overall loudness: bass alone makes a kick drum dominate and a quiet
   * acoustic passage look dead, while loudness alone barely moves on the low end that a halo reads.
   */
  const next = frame ? Math.min(1, Math.max(0, frame.bass * 0.7 + frame.level * 0.6)) : 0
  // Fast attack, slow release: visuals should follow a hit immediately and fall back gently.
  energy = next > energy ? next : energy * 0.9 + next * 0.1
  for (const listener of listeners) listener(energy)

  if (now - lastWrite >= CSS_WRITE_INTERVAL_MS) {
    lastWrite = now
    writeCss(energy)
  }
}

function ensureLoop(): void {
  if (unsubscribeSpectrum) return
  unsubscribeSpectrum = subscribeSpectrum(getElement, (frame) => tick(frame, performance.now()))
}

let getElement: () => HTMLAudioElement | null = () => null

/**
 * Starts the shared loop. `element` is a getter because the player creates its audio element during
 * store setup, which can happen after the first call here.
 */
export function startEnergy(getAudioElement: () => HTMLAudioElement | null): () => void {
  getElement = getAudioElement
  ensureLoop()
  return () => {
    unsubscribeSpectrum?.()
    unsubscribeSpectrum = null
  }
}

/** Subscribes to the energy value. Returns the last known value immediately, so a late subscriber is not blank. */
export function subscribeEnergy(listener: EnergyListener): () => void {
  ensureLoop()
  listeners.add(listener)
  listener(energy)
  return () => {
    listeners.delete(listener)
  }
}

export function currentEnergy(): number {
  return energy
}
