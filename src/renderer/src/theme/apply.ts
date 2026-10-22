/*
 * Turns theme definitions into CSS, and keeps that CSS in one place in the document.
 *
 * The point of generating CSS from tokens (rather than hand-writing six stylesheets) is that user
 * themes take exactly the same path as built-ins: there is one code path, so a theme that works for
 * the built-ins works for a file someone wrote, and a broken one is caught by the same validator.
 *
 * Everything lands in a single `<style id="aurora-skins">` element that is *replaced*, never
 * appended to — otherwise every skin switch would leave another copy of the same rules behind.
 */
import type { ThemeDefinition } from '../../../shared/theme'

const STYLE_ID = 'aurora-skins'

/**
 * `:root[data-skin="x"]` carries the dark appearance and the light block adds the `[data-theme="light"]`
 * attribute on top, matching how `base.css` already layers its own two modes.
 *
 * The default skin renders no rules: it *is* the base stylesheet.
 */
export function themeCss(themes: ThemeDefinition[]): string {
  const blocks: string[] = []
  for (const theme of themes) {
    for (const mode of ['dark', 'light'] as const) {
      const tokens = theme[mode]
      const declarations = Object.entries(tokens)
        .map(([name, value]) => `  ${name}: ${value};`)
        .join('\n')
      if (declarations.length === 0) continue
      const selector =
        mode === 'dark'
          ? `:root[data-skin="${theme.id}"]`
          : `:root[data-skin="${theme.id}"][data-theme="light"]`
      blocks.push(`/* ${theme.name} · ${mode === 'dark' ? '深色' : '浅色'} */\n${selector} {\n${declarations}\n}`)
    }
  }
  return blocks.join('\n\n')
}

/** Writes `css` into the document, creating the style element on first use. */
export function installThemeCss(css: string): void {
  let element = document.getElementById(STYLE_ID) as HTMLStyleElement | null
  if (!element) {
    element = document.createElement('style')
    element.id = STYLE_ID
    // Before every stylesheet the app loaded, so a skin's tokens win over `base.css` defaults.
    document.head.prepend(element)
  }
  if (element.textContent !== css) element.textContent = css
}

/** The token values a skin resolves to in `mode` — used for previews and the native chrome. */
export function resolvedTokens(theme: ThemeDefinition, mode: 'dark' | 'light'): Record<string, string> {
  return mode === 'dark' ? theme.dark : theme.light
}

/** Three colours for the theme centre's swatch, falling back to the skin's own declaration. */
export function swatchOf(theme: ThemeDefinition, mode: 'dark' | 'light'): string[] {
  const tokens = resolvedTokens(theme, mode)
  const picked = ['--bg', '--accent', '--text']
    .map((name) => tokens[name])
    .filter((value): value is string => Boolean(value))
  return picked.length === 3 ? picked : theme.swatch
}
