/**
 * LyricsManager — the middle layer between "a track is playing" and "here are its lyrics".
 *
 * It owns the four things the request asked for, and nothing else:
 *  - **search**: it walks the provider chain, stopping at the first confident answer;
 *  - **match**: every remote provider's results are scored by `match.ts` before they are accepted;
 *  - **cache**: whatever came off the network is written to disk, so the next play is a local hit;
 *  - **load**: it hands the caller one `Lyrics` object in Aurora's own model, never a provider's.
 *
 * Three design rules worth stating, because they are what keeps this honest:
 *
 *  1. **Local first, and it means it.** For a local file the chain is user import → sidecar `.lrc` →
 *     fetch cache → embedded tags before a single request may leave the machine. A track whose
 *     lyrics are already on disk never touches the network, in the first session or the tenth.
 *  2. **Nothing is invented.** An empty result is reported as an empty result, together with *why*
 *     (which provider was tried, which errored, which matched), and that report is what the UI tells
 *     the user. A fabricated lyric is worse than 暂无歌词.
 *  3. **A provider cannot take the app down.** Each runs inside its own try/catch with its own
 *     timeout; a miss, a crash and an offline machine all just mean "try the next one".
 *
 * The manager keeps no per-call state beyond the shared TTL cache, so one slow provider delays one
 * lookup and cannot poison the next.
 */

import {
  lyricsAreEmpty,
  lyricsToLrcText,
  parseLyricsText,
  type Lyrics,
  type LyricsAttempt,
  type LyricsProviderId,
  type LyricsResolution,
} from '../../shared/lyrics'
import type { AudioTrack, AuroraSettings } from '../../shared/types'
import { caches } from '../cache'
import { chinaProvider } from './providers/china'
import { embeddedProvider } from './providers/embedded'
import { localProvider } from './providers/local'
import { lrclibProvider } from './providers/lrclib'
import { sourceProvider } from './providers/source'
import {
  MAX_LYRICS_BYTES,
  initLyricsStore,
  readIfExists,
  removeCachedLyrics,
  removeUserLyricsFile,
  userLyricsPath,
  writeCachedLyrics,
  writeTextFile,
} from './store'
import { byPriority, type LyricsHit, type LyricsProvider, type LyricsQuery } from './types'

export type { LyricsAttempt, LyricsProvider, LyricsProviderId, LyricsQuery, LyricsResolution }

/**
 * The provider registry — the plugin surface.
 *
 * One ordered chain, sorted by `priority`, and every provider decides for itself whether it can
 * answer (the source provider returns immediately for local files, for example). That means adding a
 * catalogue really is "add a file": no ordering table here to keep in sync, and a provider registered
 * at runtime joins the same chain as the built-in ones.
 */
const registeredProviders: LyricsProvider[] = [
  localProvider,
  embeddedProvider,
  sourceProvider,
  lrclibProvider,
  chinaProvider,
]

/**
 * Registers a provider, or replaces the built-in one with the same id.
 *
 * Replacing is deliberate: it is how a user-supplied catalogue overrides a bundled one, and it is
 * what lets the smoke test drive the chain offline with a stub in place of a real catalogue.
 */
export function registerLyricsProvider(provider: LyricsProvider): void {
  const index = registeredProviders.findIndex((existing) => existing.id === provider.id)
  if (index >= 0) registeredProviders[index] = provider
  else registeredProviders.push(provider)
}

/**
 * Which half of the chain a lookup is allowed to use.
 *
 * This split exists because of a real UX constraint, not for tidiness: the local providers (and the
 * track's own source) answer in milliseconds, while a search catalogue can take seconds and has to
 * time out. Loading a page must never wait on the slow half — so the page asks for `'fast'`, renders
 * what it has, and then asks for `'search'` in the background and adopts whatever arrives.
 *
 * `'all'` is the 联网自动匹配 button, which is a deliberate user action and may take its time.
 */
export type LyricsScope = 'fast' | 'search' | 'all'

/** Providers that answer from the user's disk, or from the service that owns the track. */
const FAST_PROVIDER_IDS: LyricsProviderId[] = ['local', 'embedded', 'source']

/** Milliseconds a single provider may take before it is abandoned and the chain moves on. */
const PROVIDER_TIMEOUT_MS = 10_000
const PROVIDER_TIMEOUT_QUIET_MS = 5_000

/** Which provider an already-parsed lyric came from, so a cache hit can still be labelled. */
const ORIGIN_TO_PROVIDER: Record<string, LyricsProviderId> = {
  user: 'local',
  sidecar: 'local',
  cache: 'local',
  embedded: 'embedded',
  source: 'source',
  lrclib: 'lrclib',
  china: 'china',
}

let initialised = false

export async function initLyricsManager(directory: string): Promise<void> {
  await initLyricsStore(directory)
  initialised = true
}

export function isLyricsManagerReady(): boolean {
  return initialised
}

function providersFor(scope: LyricsScope): LyricsProvider[] {
  const chain = byPriority(registeredProviders)
  if (scope === 'all') return chain
  const fast = scope === 'fast'
  return chain.filter((provider) => FAST_PROVIDER_IDS.includes(provider.id) === fast)
}

/**
 * Runs one provider with a hard time budget.
 *
 * Without this, a catalogue that accepts the connection and then never answers would hold the whole
 * lookup (and the page's loading state) open indefinitely — the one failure mode a plugin chain must
 * not have. The abandoned request is left to finish in the background; nothing depends on it.
 */
async function findWithTimeout(
  provider: LyricsProvider,
  query: LyricsQuery,
  context: { settings: AuroraSettings; secrets: Record<string, Record<string, string>>; quiet?: boolean },
  timeoutMs: number,
): Promise<LyricsHit | null> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      provider.find(query, context),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${provider.label}：响应超时（${timeoutMs}ms）`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function buildQuery(track: AudioTrack, filePath: string | undefined): LyricsQuery {
  return {
    track,
    title: track.title?.trim() ?? '',
    artist: track.artist?.trim() ?? '',
    album: track.album?.trim() ?? '',
    duration: Number.isFinite(track.duration) ? Math.max(0, track.duration) : 0,
    filePath,
  }
}

function memoryKey(trackId: string): string {
  return `lyrics:${trackId}`
}

/** Records the outcome of one provider so the UI (and the tests) can see what was actually tried. */
function attemptOf(hit: LyricsHit | null, provider: LyricsProvider, error?: unknown): LyricsAttempt {
  if (error) {
    return {
      provider: provider.id,
      label: provider.label,
      result: 'error',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
  if (!hit) return { provider: provider.id, label: provider.label, result: 'miss' }
  if (hit.instrumental) return { provider: provider.id, label: provider.label, result: 'instrumental', detail: hit.detail }
  return { provider: provider.id, label: hit.label || provider.label, result: 'hit', detail: hit.detail }
}

/**
 * Resolves lyrics for a track.
 *
 * `force` (the 「联网自动匹配」 button) skips the in-memory cache. The chain itself is unchanged: the
 * button re-runs the *lookup*, it does not license the engine to skip the files the user put on disk.
 *
 * `filePath` is supplied by the caller instead of looked up here, which keeps this module free of
 * library state and testable without a music library.
 */
export async function resolveLyrics(
  track: AudioTrack,
  settings: AuroraSettings,
  secrets: Record<string, Record<string, string>>,
  options: {
    force?: boolean
    quiet?: boolean
    filePath?: string
    providerTimeoutMs?: number
    scope?: LyricsScope
  } = {},
): Promise<LyricsResolution> {
  const scope = options.scope ?? 'all'
  const started = Date.now()
  const timeoutMs = options.providerTimeoutMs ?? (options.quiet ? PROVIDER_TIMEOUT_QUIET_MS : PROVIDER_TIMEOUT_MS)
  const attempts: LyricsAttempt[] = []
  const query = buildQuery(track, options.filePath)
  const nothing = (): LyricsResolution => ({
    trackId: track.id,
    lyrics: null,
    provider: null,
    label: '',
    instrumental: false,
    fromDisk: false,
    attempts,
    durationMs: Date.now() - started,
  })

  if (!query.title && !query.filePath) return nothing()

  // The in-memory cache holds the verdict of a *complete* lookup, so only a complete lookup may be
  // answered from it. A `'fast'` miss records "nothing local", and letting the later `'search'` pass
  // read that would make the enrichment phase a no-op for exactly the tracks that need it most.
  if (!options.force && scope === 'all') {
    const cached = caches.lyrics.get(memoryKey(track.id))
    if (cached !== undefined) {
      const lyrics = cached as Lyrics | null
      const provider = lyrics ? (ORIGIN_TO_PROVIDER[lyrics.origin] ?? null) : null
      return {
        trackId: track.id,
        lyrics,
        provider,
        label: '',
        instrumental: false,
        fromDisk: true,
        attempts,
        durationMs: Date.now() - started,
      }
    }
  }

  for (const provider of providersFor(scope)) {
    let hit: LyricsHit | null = null
    let failure: unknown
    try {
      hit = await findWithTimeout(provider, query, { settings, secrets, quiet: options.quiet }, timeoutMs)
    } catch (error) {
      failure = error
    }
    attempts.push(attemptOf(hit, provider, failure))

    if (failure || !hit) continue

    if (hit.instrumental) {
      // A positive "there are no lyrics": stop, and say so, rather than letting the next catalogue
      // guess at a different song's words.
      caches.lyrics.set(memoryKey(track.id), null)
      return {
        trackId: track.id,
        lyrics: null,
        provider: hit.provider,
        label: hit.label,
        instrumental: true,
        fromDisk: false,
        attempts,
        durationMs: Date.now() - started,
      }
    }

    if (lyricsAreEmpty(hit.lyrics)) continue

    const fromDisk = provider.kind === 'local'
    let cachedTo: LyricsResolution['cachedTo']
    if (!fromDisk) {
      // Serialise back to LRC so the cache file re-parses into the same timings next session (and so
      // a third-party player can read the sidecar it gets written to).
      const text = hit.lyrics.synced ? lyricsToLrcText(hit.lyrics) : (hit.lyrics.plain ?? '')
      if (text.trim()) cachedTo = await writeCache(track, query, text, hit.provider)
    }

    caches.lyrics.set(memoryKey(track.id), hit.lyrics)
    return {
      trackId: track.id,
      lyrics: hit.lyrics,
      provider: hit.provider,
      label: hit.label,
      confidence: hit.confidence,
      instrumental: false,
      fromDisk,
      cachedTo,
      attempts,
      durationMs: Date.now() - started,
    }
  }

  caches.lyrics.set(memoryKey(track.id), null)
  return nothing()
}

async function writeCache(
  track: AudioTrack,
  query: LyricsQuery,
  text: string,
  provider: LyricsProviderId,
): Promise<{ path: string | null; sidecar: string | null }> {
  try {
    return await writeCachedLyrics(
      {
        title: query.title || track.title || '未知歌曲',
        artist: query.artist,
        duration: query.duration,
        filePath: track.origin === 'local' ? query.filePath : undefined,
      },
      text,
      provider,
    )
  } catch {
    return { path: null, sidecar: null }
  }
}

/** Stores hand-provided lyrics (LRC or plain text) for a track, replacing any previous version. */
export async function saveUserLyrics(track: AudioTrack, raw: string): Promise<Lyrics | null> {
  const text = raw.replace(/\r\n?/g, '\n').trim()
  if (!text) return null
  if (text.length > MAX_LYRICS_BYTES) throw new Error('歌词内容过大（上限 512KB）')
  const parsed = parseLyricsText(text, 'user')
  await writeTextFile(userLyricsPath(track.id), text)
  caches.lyrics.set(memoryKey(track.id), parsed)
  return parsed
}

/** Reads the user's own lyrics for a track, if any. */
export async function readUserLyrics(trackId: string): Promise<Lyrics | null> {
  const raw = await readIfExists(userLyricsPath(trackId))
  if (!raw?.trim()) return null
  return parseLyricsText(raw, 'user')
}

/**
 * Clears what the app stored for a track: the hand-imported file *and* the fetched cache entry.
 *
 * Both, because clearing only the import would look broken — the next load would instantly re-read
 * the cached copy and the lyrics would reappear. A sidecar `.lrc` sitting next to the audio file is
 * deliberately left alone: that file is the user's, not something Aurora wrote on their behalf.
 */
export async function clearStoredLyrics(track: AudioTrack): Promise<boolean> {
  const removedImport = await removeUserLyricsFile(track.id)
  const removedCache = await removeCachedLyrics(track.title ?? '', track.artist ?? '', track.duration ?? 0)
  caches.lyrics.delete(memoryKey(track.id))
  return removedImport || removedCache
}

/** Drops the in-memory copy so the next load re-reads the disk (used after imports and edits). */
export function forgetLyrics(trackId: string): void {
  caches.lyrics.delete(memoryKey(trackId))
}
