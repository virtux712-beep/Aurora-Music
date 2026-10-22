/**
 * Renderer failures → the crash log.
 *
 * `main/diagnostics.ts` has been able to record renderer errors since the log was added, but nothing ever
 * called it: the log only ever held main-process crashes and what the settings page asked for by hand. That
 * makes it useless for exactly the failures users report — a page that breaks, a click that throws — because
 * those happen in this process and were never written down.
 *
 * Three rules keep this from becoming a problem of its own:
 *
 *  1. **Reporting never throws.** If the bridge is missing (another window's preload, a torn-down page) or
 *     the call rejects, the failure is dropped. An error reporter that raises errors is worse than none.
 *  2. **Rate-limited.** A broken render loop can throw sixty times a second; a log that grows at that rate
 *     is a disk-space bug. Five reports per half minute, counted after deduplication.
 *  3. **Deduplicated.** The same message with the same stack head is recorded once per session window, so one
 *     recurring failure reads as one entry rather than as noise.
 */

const MAX_REPORTS_PER_WINDOW = 5
const WINDOW_MS = 30_000
/** Message length is bounded in main too; trimming here keeps the IPC payload small. */
const MAX_MESSAGE = 400

let sent: number[] = []
const seen = new Map<string, number>()

function allowed(key: string, now: number): boolean {
  sent = sent.filter((at) => now - at < WINDOW_MS)
  if (sent.length >= MAX_REPORTS_PER_WINDOW) return false
  const last = seen.get(key)
  if (last !== undefined && now - last < WINDOW_MS) return false
  seen.set(key, now)
  if (seen.size > 200) {
    // Bounded memory: drop the oldest half rather than growing with the session.
    const entries = [...seen.entries()].sort((a, b) => a[1] - b[1])
    for (const [entryKey] of entries.slice(0, Math.floor(entries.length / 2))) seen.delete(entryKey)
  }
  sent.push(now)
  return true
}

/** First stack line only: the rest is noise for a log meant to be readable (and pasteable). */
function describe(error: unknown): string {
  if (error instanceof Error) {
    const head = (error.stack ?? `${error.name}: ${error.message}`).split('\n').slice(0, 2).join(' | ')
    return head.slice(0, MAX_MESSAGE)
  }
  if (typeof error === 'string') return error.slice(0, MAX_MESSAGE)
  try {
    return JSON.stringify(error).slice(0, MAX_MESSAGE)
  } catch {
    return String(error).slice(0, MAX_MESSAGE)
  }
}

export function reportRendererError(kind: string, error: unknown): void {
  const message = describe(error)
  if (!message) return
  if (!allowed(`${kind}:${message}`, Date.now())) return
  try {
    void window.aurora?.diagnostics?.record(kind, message)?.catch(() => undefined)
  } catch {
    // A missing bridge (or a hostile global) must not turn an error report into a second error.
  }
}

/**
 * Wires the two failures the platform reports to the window: an error thrown outside any handler, and a
 * rejected promise nobody awaited. Returns the handler for the third case — a Vue component that threw
 * during render or in a lifecycle hook, which Vue reports through its own hook instead of `window.onerror`.
 *
 * Returned rather than taken as a callback so the caller cannot forget to install it: the value it hands back
 * is the thing that goes on `app.config.errorHandler`.
 */
export function installCrashReporting(): (error: unknown) => void {
  window.addEventListener('error', (event) => {
    reportRendererError('renderer-error', event.error ?? event.message)
  })
  window.addEventListener('unhandledrejection', (event) => {
    reportRendererError('renderer-rejection', event.reason)
  })
  return (error) => reportRendererError('vue-error', error)
}
