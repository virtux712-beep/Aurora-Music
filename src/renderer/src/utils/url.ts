/**
 * URL hygiene for data that came from a source.
 *
 * Track covers, playlist art and "homepage" links all arrive from sources the user installed (or from
 * a platform search), so they are *outside Aurora's control*. Handing such a string straight to `src`,
 * `href` or a CSS `url()` is how a `file://` path or a `javascript:` URL gets a foothold: an `<img>`
 * cannot run script, but a `file://` cover still reads a local file into the renderer, and an anchor
 * decides what the main process is asked to open.
 *
 * The main process already refuses to open anything but https, and navigation is blocked outright —
 * this is the second layer, at the point where the value is used, so the rule holds even if a future
 * surface forgets that the data is untrusted. Anything rejected simply does not render.
 */

/** Schemes an image or a media element may load. */
const MEDIA_SCHEMES = new Set(['http:', 'https:', 'aurora-media:', 'blob:'])
/** Schemes the OS is allowed to be asked to open. Deliberately narrower than the media list. */
const EXTERNAL_SCHEMES = new Set(['http:', 'https:'])
/** `data:` is allowed for images only — `data:text/html` has no business in a cover slot. */
const DATA_IMAGE = /^data:image\/[a-z0-9.+-]+[;,]/i
/** A same-origin relative path (the only relative form that is unambiguous here). */
const RELATIVE = /^\/(?!\/)/

function parse(raw: string | undefined): URL | null {
  const value = raw?.trim()
  if (!value) return null
  try {
    return new URL(value)
  } catch {
    return null
  }
}

/** A cover / artwork URL, or `undefined` when it is not something safe to load. */
export function safeMediaUrl(raw: string | undefined): string | undefined {
  const value = raw?.trim()
  if (!value) return undefined
  if (DATA_IMAGE.test(value)) return value
  if (RELATIVE.test(value)) return value
  const url = parse(value)
  if (!url || !MEDIA_SCHEMES.has(url.protocol)) return undefined
  // `href` is the parsed, percent-encoded form: a `"` in the original can no longer close a CSS
  // `url("…")`, which is what makes this safe to drop into a style binding.
  return url.href
}

/** A link Aurora may hand to the OS, or `undefined` when it must not be offered at all. */
export function safeExternalUrl(raw: string | undefined): string | undefined {
  const url = parse(raw)
  if (!url || !EXTERNAL_SCHEMES.has(url.protocol)) return undefined
  return url.href
}
