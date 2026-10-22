/*
 * The window's own chrome — the native strip Windows draws behind the minimise/maximise/close
 * buttons, plus the colour scheme Electron uses for native form controls and scrollbars.
 *
 * None of it is reachable from CSS: the overlay is painted by the OS and the controls follow
 * `nativeTheme`. That is exactly why the light theme used to look half-finished — the app turned
 * white and the top 36 pixels stayed `#0d1016`, so the window read as a dark title bar sitting on a
 * light app. The renderer pushes its resolved theme here on every change, and the value is persisted
 * so the *next* launch draws the right strip before the first frame instead of flashing.
 */

import { nativeTheme, type BrowserWindow } from 'electron'
import type { ThemeMode } from '../shared/types'

/** Mirrors `titleBarOverlay.height` — the renderer's `--titlebar-h` must match it. */
export const TITLEBAR_HEIGHT = 36

const CHROME: Record<'dark' | 'light', { color: string; symbolColor: string }> = {
  // Matches `--bg` in each theme, so the buttons sit on the strip rather than on a shade of it.
  dark: { color: '#0d1016', symbolColor: '#f1f2f7' },
  light: { color: '#ffffff', symbolColor: '#1a1c23' },
}

export function titleBarOverlay(mode: 'dark' | 'light'): { color: string; symbolColor: string; height: number } {
  return { ...CHROME[mode], height: TITLEBAR_HEIGHT }
}

/**
 * `'system'` is only knowable in the main process — the renderer's `prefers-color-scheme` and
 * Electron's `shouldUseDarkColors` agree in practice, but resolving in one place keeps the strip and
 * the page from ever disagreeing.
 */
export function resolveThemeMode(mode: ThemeMode): 'dark' | 'light' {
  if (mode !== 'system') return mode
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}

/** Applies `mode` to the running window. Safe to call before the window exists or after it is gone. */
export function applyWindowChrome(
  window: BrowserWindow | null,
  mode: ThemeMode,
  /**
   * The active skin's own strip colours. The renderer has them because they come out of the generated
   * token set; without them a light skin would keep the default dark strip and the window would look
   * half-painted. Absent (or unusable) means "keep the defaults above".
   */
  chrome?: { color: string; symbolColor: string } | null,
): void {
  nativeTheme.themeSource = mode === 'system' ? 'system' : resolveThemeMode(mode)
  if (!window || window.isDestroyed()) return
  const base = titleBarOverlay(resolveThemeMode(mode))
  const colour = safeColor(chrome?.color) ?? base.color
  const symbol = safeColor(chrome?.symbolColor) ?? base.symbolColor
  try {
    // `height` is fixed here on purpose: it must stay equal to the renderer's `--titlebar-h`, and a
    // skin is not allowed to resize window chrome.
    window.setTitleBarOverlay({ color: colour, symbolColor: symbol, height: base.height })
  } catch {
    // Throws when the window was not created with `titleBarStyle: 'hidden'`; nothing to apply then.
  }
}

/**
 * Electron throws on a malformed overlay colour, so anything from the renderer is checked first.
 *
 * The allowlist matches what a theme is permitted to write (`shared/theme.ts`), which means a value
 * that got this far is already a colour — this is the one place it crosses into the OS, so it is not
 * taken on faith.
 */
function safeColor(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return /^[#a-z0-9(),.%\s/+-]{2,64}$/i.test(trimmed) ? trimmed : null
}
