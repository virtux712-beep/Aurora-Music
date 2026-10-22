/*
 * Reads the window's own backdrop back out of the compositor.
 *
 * The playback-detail page is painted by a stack of layers — an ink, a blurred cover, three radial
 * fields derived from the artwork and a veil whose alpha varies with height. Nothing in CSS can hand
 * that composite to a *sibling* element, which is why the player bar and the native title-bar strip
 * used to approximate it: they took the skin's dark palette and mixed in the artwork's accent, and the
 * approximation was visibly wrong wherever the photo or the fields dominated (the top edge, where the
 * veil is only 52% ink).
 *
 * So the shell does not approximate. It asks the compositor what is actually behind it and paints
 * itself that colour. Two small regions are enough: the top edge for the strip, and the band just
 * above the bar for the bar.
 *
 * The capture is deliberately tiny (a few hundred pixels each) and only happens while that page is
 * open, on a debounce — see `scheduleSample` in the ui store.
 */

import type { BrowserWindow } from 'electron'
import type { BackdropRect } from '../shared/types'

/**
 * Averages each region and returns it as `#rrggbb`.
 *
 * `null` means "no answer" — no window, a capture that produced nothing, or a frame the compositor had
 * not painted yet. The caller keeps whatever colour it already had rather than painting black.
 */
export async function sampleBackdrop(
  window: BrowserWindow | null,
  rects: BackdropRect[],
): Promise<(string | null)[]> {
  if (!window || window.isDestroyed() || rects.length === 0) return rects.map(() => null)
  // In parallel, not in a loop: these are two frames of the same moment, and a sequential pair doubled the
  // latency of every track change for no benefit.
  return Promise.all(rects.map((rect) => sampleOne(window, rect)))
}

async function sampleOne(window: BrowserWindow, rect: BackdropRect): Promise<string | null> {
  const region = {
    x: Math.max(0, Math.round(rect.x)),
    y: Math.max(0, Math.round(rect.y)),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
  }
  try {
    const image = await window.webContents.capturePage(region)
    if (image.isEmpty()) return null
    // Chromium hands back its native 8-bit surface, which on every platform Electron ships is BGRA.
    const bitmap = image.getBitmap()
    if (bitmap.length < 4) return null
    let red = 0
    let green = 0
    let blue = 0
    let pixels = 0
    for (let index = 0; index + 3 < bitmap.length; index += 4) {
      blue += bitmap[index] ?? 0
      green += bitmap[index + 1] ?? 0
      red += bitmap[index + 2] ?? 0
      pixels += 1
    }
    if (pixels === 0) return null
    const channel = (total: number): string =>
      Math.min(255, Math.round(total / pixels))
        .toString(16)
        .padStart(2, '0')
    const sampled = `#${channel(red)}${channel(green)}${channel(blue)}`
    /*
     * A capture taken before the page has painted comes back as an opaque *black* frame rather than an
     * error. The room is never black — its ink is the skin's background mixed 28/72 with `#04050a`,
     * which lands around `rgb(74 70 63)` even in the lightest theme — so pure black means "the
     * compositor had nothing", and painting the shell with it would be a visible flash.
     */
    return sampled === '#000000' ? null : sampled
  } catch {
    return null
  }
}
