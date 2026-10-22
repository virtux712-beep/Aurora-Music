import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type { AudioTrack, PlayMode, PlaybackQuality } from '../../../shared/types'
import { chooseQuality, qualityTier, qualityBadge, tierOfToken, type QualityTierId } from '../../../shared/quality'
import { appService, platformService, settingsService, sourceService } from '../services/aurora'
import { useCollectionStore } from './collection'
import { useLibraryStore } from './library'
import { useSoundStore } from './sound'
import { useUiStore } from './ui'
import { analyserBridge, deckElement, deckElements, ensureGraph, graphReady, setFade, setLoudnessGain } from '../audio/engine'
import { spectrumWanted } from '../utils/spectrum'
import { cachedMeasurement, gainDbFor, meanDb, rememberMeasurement, rmsDb } from '../audio/loudness'
import {
  SLEEP_OFF,
  describeSleep,
  isExpired,
  remainingMs,
  shouldStopAtTrackEnd,
  sleepLabel,
  startSleepMinutes,
  type SleepState,
} from '../audio/sleep'

const PREFS_KEY = 'aurora:player-prefs'

interface PlayerPrefs {
  volume: number
  muted: boolean
  mode: PlayMode
}

const PLAY_MODES: PlayMode[] = ['list-loop', 'single', 'shuffle', 'sequential']

export const PLAY_MODE_LABELS: Record<PlayMode, string> = {
  'list-loop': '列表循环',
  single: '单曲循环',
  shuffle: '随机播放',
  sequential: '顺序播放',
}

export const PLAY_MODE_ICONS: Record<PlayMode, string> = {
  'list-loop': '↻',
  single: '↻¹',
  shuffle: '⤨',
  sequential: '→',
}

function isPlayMode(value: unknown): value is PlayMode {
  return typeof value === 'string' && PLAY_MODES.includes(value as PlayMode)
}

function readPrefs(): PlayerPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PlayerPrefs>
      return {
        volume: typeof parsed.volume === 'number' && Number.isFinite(parsed.volume)
          ? Math.min(1, Math.max(0, parsed.volume))
          : 0.72,
        muted: parsed.muted === true,
        mode: isPlayMode(parsed.mode) ? parsed.mode : 'list-loop',
      }
    }
  } catch {
    // Fall through to defaults.
  }
  return { volume: 0.72, muted: false, mode: 'list-loop' }
}

/** How long before a track ends the next one is fetched and prepared. */
const PRELOAD_WINDOW_SECONDS = 20

/** How precisely the crossfade clock is watched. 100 ms is well inside "sounds like a fade". */
const CROSSFADE_TICK_MS = 100

/** Loudness: how often the analyser is sampled, and how many readings make a measurement. */
const LOUDNESS_TICK_MS = 250
const LOUDNESS_READINGS = 12

export const usePlayerStore = defineStore('player', () => {
  const prefs = readPrefs()

  /*
   * Two decks, not one element.
   *
   * Every feature in this store that is about *transitions* — gapless, crossfade — needs the next track
   * to exist somewhere before the current one finishes. A single element cannot do that: assigning a new
   * `src` tears down what is playing. So deck A and deck B are alternated, and `deckIndex` is which one
   * the UI is currently describing.
   */
  const decks = deckElements()
  const deckIndex = ref<0 | 1>(0)

  const queue = ref<AudioTrack[]>([])
  const currentIndex = ref(-1)
  /**
   * What the *source* said it handed back, not what was asked for.
   *
   * A resolved URL is the only proof of the quality actually in play: a source is free to substitute a
   * cheaper stream, and showing the requested tier would then be a badge that lies.
   */
  const resolvedQuality = ref<PlaybackQuality | ''>('')
  /** Why the last resolve picked what it did — shown in the player bar's tooltip. */
  const lastQualityReason = ref('')

  /**
   * The tier the *current* stream is in, for the player bar's badge.
   *
   * A source that says which quality it returned is believed. When it says nothing (which is the normal
   * answer from a 洛雪-style script) the *requested* token is shown — the request is what chose the URL, and
   * showing the song's best published tier instead made a changed preference invisible. Only when neither
   * exists does the badge fall back to the track's own availability, and then to nothing.
   */
  const currentQualityTier = computed<QualityTierId | null>(() => {
    const track = current.value
    if (!track) return null
    if (track.origin !== 'online') return qualityBadge(track)?.tier ?? null
    const raw = String(resolvedQuality.value || '')
    const fromStream = raw ? tierOfToken(raw) : null
    return fromStream ?? qualityBadge(track)?.tier ?? null
  })
  const isPlaying = ref(false)
  const isBuffering = ref(false)
  const currentTime = ref(0)
  const duration = ref(0)
  const volume = ref(prefs.volume)
  const muted = ref(prefs.muted)
  const mode = ref<PlayMode>(prefs.mode)
  const lastError = ref('')
  const missedTracks = ref<Set<string>>(new Set())
  /** Live radio has no duration and cannot be seeked. */
  const isLive = ref(false)
  let loadToken = 0

  /**
   * Which track each deck currently *holds*, by id.
   *
   * Two decks mean an element's `src` is no longer self-evidently "the song that is playing": it may hold
   * the track prepared for the next swap, or nothing at all because `releaseDeck` dropped it after a
   * transition. `play()` used to check only for an empty `src`, so a deck still holding the *prepared next*
   * track would happily play that instead of the song the UI was describing. Comparing ids is what makes
   * "press play and hear the current song" true in every state the two-deck machine can be in.
   */
  const loadedTrackId: [string, string] = ['', '']

  /** Milliseconds until the sleep timer fires; `null` when nothing is armed. Refreshed once a second. */
  const sleepClock = ref(Date.now())
  const sleep = ref<SleepState>({ ...SLEEP_OFF })
  const sleepRemaining = computed(() => remainingMs(sleep.value, sleepClock.value))
  const sleepLabelText = computed(() => sleepLabel(sleep.value, sleepClock.value))

  /**
   * The prepared next track: which queue index, which deck holds it, and whether it can be started
   * without a stall.
   *
   * `ready` is set by the deck's own `canplay` — not by "the URL resolved", which says nothing about
   * whether a single byte has arrived. A crossfade started on an un-buffered deck is a hole in the
   * music, which is the exact thing this feature exists to remove.
   */
  const pending = ref<{ index: number; deck: 0 | 1; track: AudioTrack; ready: boolean } | null>(null)
  const deckInUse = computed<0 | 1>(() => deckIndex.value)

  const current = computed(() => (currentIndex.value >= 0 ? queue.value[currentIndex.value] ?? null : null))
  const progress = computed(() => (duration.value > 0 ? Math.min(1, currentTime.value / duration.value) : 0))
  const hasQueue = computed(() => queue.value.length > 0)
  const upNext = computed(() => queue.value.slice(currentIndex.value + 1))

  /** The element the UI is describing — and the one the audio-visualisers read. */
  const audio = computed(() => deckElement(deckIndex.value))

  function activeElement(): HTMLAudioElement {
    return deckElement(deckIndex.value)
  }

  function idleIndex(): 0 | 1 {
    return deckIndex.value === 0 ? 1 : 0
  }

  function applyVolume(): void {
    // Both decks, always: a crossfade into a deck that still had last week's volume would be audible.
    for (const element of decks) {
      element.volume = volume.value
      element.muted = muted.value
    }
  }

  applyVolume()

  function persistPrefs(): void {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ volume: volume.value, muted: muted.value, mode: mode.value }))
    } catch {
      // Ignore storage failures.
    }
  }

  function updateMediaSession(track: AudioTrack | null): void {
    if (!('mediaSession' in navigator)) return
    navigator.mediaSession.metadata = track
      ? new MediaMetadata({
          title: track.title,
          artist: track.artist,
          album: track.album,
          artwork: track.cover ? [{ src: track.cover }] : [],
        })
      : null
    navigator.mediaSession.playbackState = isPlaying.value ? 'playing' : 'paused'
  }

  function registerMediaSessionHandlers(): void {
    if (!('mediaSession' in navigator)) return
    const session = navigator.mediaSession
    session.setActionHandler('play', () => void play())
    session.setActionHandler('pause', () => pause())
    session.setActionHandler('previoustrack', () => void previous())
    session.setActionHandler('nexttrack', () => void next(false))
    session.setActionHandler('seekto', (details) => {
      if (typeof details.seekTime === 'number') seek(details.seekTime)
    })
  }

  /**
   * Which token to ask a source for, from the user's tier preference and *this song's* availability list.
   *
   * The preference is applied here rather than stored on the track because availability is per song: the
   * same source offers `flac` for one track and only `128k` for the next, and a stored quality would go
   * stale the moment the queue advances. `chooseQuality` owns the rule (never silently above the pick).
   */
  function desiredQuality(track: AudioTrack): string | undefined {
    if (!track.qualities || track.qualities.length === 0) return undefined
    const preferred = settingsService.cached()?.preferredQuality ?? 'lossless'
    const choice = chooseQuality(track.qualities, preferred)
    lastQualityReason.value = choice.reason
    return choice.quality
  }

  /**
   * Resolves a playable URL, **without touching the badge state**.
   *
   * That separation is load-bearing now that the next track is resolved while the current one is still
   * playing: the first version of the preload path reused the resolve that writes `resolvedQuality`, so
   * preparing the next song rewrote the *current* song's badge and reason. The badge belongs to what is
   * playing, and only `load` may write it.
   */
  /**
   * The sentence the user should read when a resolve fails.
   *
   * A rejected `ipcRenderer.invoke` reaches the renderer wrapped by Electron as
   * `Error invoking remote method 'platforms:resolve': Error: <our message>` — a stack-flavoured
   * prefix around a message that is already written for a person. It buried the part that matters
   * (which host, and which page fixes it) behind framework text, so it is stripped here, at the one
   * place every resolve failure passes through.
   */
  function describeResolveError(error: unknown): string {
    const raw = error instanceof Error ? error.message : ''
    const message = raw.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '').trim()
    return message || '在线音源解析失败，请稍后重试'
  }

  async function resolveUrl(track: AudioTrack, requested?: string): Promise<{ url: string; quality?: string; live: boolean }> {
    if (track.origin !== 'online') return { url: track.fileUrl, live: false }
    if (track.platform) {
      const resolved = await platformService.resolve(track, requested)
      if (!resolved?.url) throw new Error('没有可用音源能解析该平台的播放地址，请在音源管理中安装并启用支持该平台的音源')
      return { url: resolved.url, quality: resolved.quality, live: resolved.live }
    }
    if (!track.sourceId) throw new Error('该在线曲目缺少音源信息')
    const resolved = await sourceService.resolve(track.sourceId, track, requested)
    if (!resolved?.url) throw new Error('音源没有返回可播放的地址')
    return { url: resolved.url, quality: resolved.quality, live: resolved.live }
  }

  /**
   * Records what the tier picker actually achieved for this resolve.
   *
   * The subtle case is a source that answers with a URL and says nothing about its quality — which is
   * normal for 洛雪-style scripts: the quality *is* the token the request carried, and the URL is that
   * quality's URL. Falling back to the song's best published tier in that case (the old behaviour) meant a
   * preference change looked like it did nothing at all: the badge stayed pinned to the same tier no matter
   * which one the user picked. The request token is shown instead, and the reason says so plainly.
   *
   * A source that *does* report a quality is believed, and a mismatch is stated rather than hidden — a
   * source substituting a cheaper or richer stream is something the listener deserves to see.
   */
  function recordResolvedQuality(actualRaw: unknown, requestedRaw: string | undefined): void {
    const actual = String(actualRaw ?? '').trim()
    const asked = String(requestedRaw ?? '').trim()
    const askedTier = asked ? tierOfToken(asked) : null
    if (actual) {
      resolvedQuality.value = actual as PlaybackQuality
      const actualTier = tierOfToken(actual)
      const note =
        askedTier && actualTier && actualTier !== askedTier
          ? `音源回报的是「${qualityTier(actualTier).name}」，没有按偏好给（请求的是 ${asked}）`
          : `音源回报：${actual}`
      lastQualityReason.value = [lastQualityReason.value, note].filter(Boolean).join(' · ')
      return
    }
    resolvedQuality.value = (asked || '') as PlaybackQuality | ''
    lastQualityReason.value = [lastQualityReason.value, asked ? `音源未回报音质，按请求的 ${asked} 播放` : '']
      .filter(Boolean)
      .join(' · ')
  }

  /* ------------------------------------------------------------------ loudness */

  let loudnessTimer = 0

  function stopLoudnessMeasurement(): void {
    if (loudnessTimer) window.clearInterval(loudnessTimer)
    loudnessTimer = 0
  }

  /**
   * Puts the current track's loudness gain on a deck.
   *
   * Order of preference, and each step is a different kind of answer:
   *
   *  1. a previous **measurement** for this track (instant, no ramp-in);
   *  2. otherwise **measure now** — but only when the audio graph exists, because the analyser lives on
   *     it and a fake number is worse than no correction;
   *  3. otherwise leave the deck at 0 dB and say so.
   */
  function applyLoudness(deck: 0 | 1, track: AudioTrack): void {
    const sound = useSoundStore()
    stopLoudnessMeasurement()
    if (!sound.loudness.enabled) {
      setLoudnessGain(deck, 0, 0.2)
      sound.noteMeasurement(null, 'none', track.title)
      return
    }

    const cached = cachedMeasurement(track.id)
    if (cached !== null) {
      const gain = gainDbFor(cached, sound.loudness.targetDb) ?? 0
      setLoudnessGain(deck, gain, 0.5)
      sound.noteMeasurement(cached, 'measured', track.title)
      return
    }

    const bridge = analyserBridge()
    if (!bridge) {
      setLoudnessGain(deck, 0, 0.2)
      sound.noteMeasurement(null, 'none', track.title)
      return
    }

    const timeData = new Float32Array(bridge.analyser.fftSize)
    const readings: number[] = []
    setLoudnessGain(deck, 0, 0.2)
    sound.noteMeasurement(null, 'none', track.title)
    loudnessTimer = window.setInterval(() => {
      // A track change (or a deck swap) ends the measurement: these samples belong to a song that is no
      // longer playing, and averaging them into the next one would be measuring a different recording.
      if (deckIndex.value !== deck || !sound.loudness.enabled) {
        stopLoudnessMeasurement()
        return
      }
      bridge.analyser.getFloatTimeDomainData(timeData)
      readings.push(rmsDb(timeData))
      if (readings.length < LOUDNESS_READINGS) return
      stopLoudnessMeasurement()
      const measured = meanDb(readings)
      const gain = gainDbFor(measured, sound.loudness.targetDb)
      if (gain === null) {
        sound.noteMeasurement(null, 'none', track.title)
        return
      }
      rememberMeasurement(track.id, measured)
      // Ramped over ~1.2 s: the correction is right, but arriving all at once sounds like a fault.
      setLoudnessGain(deck, gain, 1.2)
      sound.noteMeasurement(measured, 'measured', track.title)
    }, LOUDNESS_TICK_MS)
  }

  /* ------------------------------------------------------------------ loading */

  /**
   * Anything in the sound block that needs the audio graph — EQ, loudness, crossfade — asks for it here.
   *
   * Deliberately *not* requested unconditionally: attaching the graph is the one operation that can, if
   * it goes wrong, silence playback, and the default install (EQ off, loudness off, no crossfade) has no
   * reason to take that risk. This is also why the request is made from a `play` event, where a gesture
   * is known to have happened.
   */
  function ensureGraphForSound(): void {
    const sound = useSoundStore()
    const soundNeedsGraph = sound.equalizer.enabled || sound.loudness.enabled || sound.crossfadeSeconds > 0
    /*
     * A live visualiser needs the graph as well, and a `play` event is the reliable moment to build it:
     * the context may only be resumed once the page is allowed to make noise, and by the time a track is
     * playing that has demonstrably happened. Without this the analyser existed only when a *sound feature*
     * was on, so `--music-energy` stayed 0 on every ordinary page and every "the theme moves with the
     * music" rule was multiplying by a constant zero.
     */
    if (soundNeedsGraph || spectrumWanted()) void ensureGraph(true)
  }

  async function load(track: AudioTrack, autoplay: boolean, deck: 0 | 1 = deckIndex.value): Promise<void> {
    lastError.value = ''
    isBuffering.value = true
    const isActive = deck === deckIndex.value
    if (isActive) {
      currentTime.value = 0
      duration.value = track.duration || 0
      isLive.value = false
    }
    const token = ++loadToken
    /*
     * Both the resolved quality and the reason behind it describe *this* resolve, so both are cleared
     * together. Leaving the reason behind meant the player bar could explain a decision that belonged to
     * the previous song while showing the current one.
     */
    if (isActive && track.origin === 'online') {
      resolvedQuality.value = ''
      lastQualityReason.value = ''
    }
    const requested = isActive && track.origin === 'online' ? desiredQuality(track) : undefined

    let resolved: { url: string; quality?: string; live: boolean }
    try {
      if (track.origin === 'online') useLibraryStore().rememberOnline([track])
      resolved = await resolveUrl(track, requested)
    } catch (error) {
      if (token !== loadToken || !isActive) return
      const message = describeResolveError(error)
      lastError.value = message
      isBuffering.value = false
      isPlaying.value = false
      useUiStore().notify(message, 'error')
      return
    }
    // A newer track was requested while this one was resolving.
    if (token !== loadToken) return

    if (isActive) {
      if (track.origin === 'online') recordResolvedQuality(resolved.quality, requested)
      isLive.value = resolved.live
      updateMediaSession(track)
    }

    const element = deckElement(deck)
    element.preload = isActive ? 'auto' : 'metadata'
    element.src = resolved.url
    loadedTrackId[deck] = track.id
    element.volume = volume.value
    element.muted = muted.value

    if (!isActive) return
    // Everything prepared for the *old* next track is now wrong: this load replaced it.
    clearPending()
    releaseDeck(idleIndex())
    applyLoudness(deck, track)
    if (autoplay) await play()
  }

  /** Stops a deck and drops its media, so a reused deck never replays a stale source. */
  function releaseDeck(deck: 0 | 1): void {
    const element = deckElement(deck)
    try {
      element.pause()
    } catch {
      // A paused/loose element is fine; releasing is best-effort.
    }
    element.removeAttribute('src')
    loadedTrackId[deck] = ''
    setFade(deck, 1, 0)
  }

  /* ------------------------------------------------------------------ transitions */

  let crossfadeTimer = 0

  function clearPending(): void {
    pending.value = null
    if (crossfadeTimer) window.clearInterval(crossfadeTimer)
    crossfadeTimer = 0
  }

  /**
   * Fetches and buffers the track that comes next, into the idle deck.
   *
   * Runs once per track: `pending` is the guard, because timeupdate fires ~4×/s and a resolve per tick
   * would be five network round trips a second.
   */
  async function prepareNext(): Promise<void> {
    const sound = useSoundStore()
    if (!sound.gapless && sound.crossfadeSeconds <= 0) return
    if (pending.value) return
    if (mode.value === 'single') return
    if (isLive.value) return
    const index = pickNextIndex()
    if (index === null) return
    const track = queue.value[index]
    if (!track) return
    const deck = idleIndex()
    const token = loadToken
    try {
      const resolved = await resolveUrl(track)
      // The world moved on: a different track was chosen, or this queue is gone.
      if (token !== loadToken || pending.value || deckIndex.value === deck) return
      const element = deckElement(deck)
      element.volume = volume.value
      element.muted = muted.value
      // `auto` while preparing, `metadata` afterwards: we want the bytes now, not after the swap.
      element.preload = 'auto'
      element.src = resolved.url
      loadedTrackId[deck] = track.id
      pending.value = { index, deck, track, ready: false }
      const onReady = (): void => {
        if (pending.value?.deck === deck) pending.value = { ...pending.value, ready: true }
      }
      element.addEventListener('canplay', onReady, { once: true })
    } catch {
      // A next track that cannot be resolved is not an error *now*: the normal advance path will retry
      // it when the time comes, and report the failure then, in context.
    }
  }

  /**
   * The overlap itself.
   *
   * Only used when the graph exists: without it there are no gains to ramp, and "crossfading" would mean
   * starting the next deck at full volume on top of the current one. In that case the plain gapless path
   * is used instead, which is a hard cut but never a doubled-up mess.
   */
  function startCrossfade(seconds: number): boolean {
    const ready = pending.value
    if (!ready || !ready.ready || !graphReady()) return false
    const outgoing = deckIndex.value
    const incoming = ready.deck
    const previousIndex = currentIndex.value
    const previousDuration = duration.value
    /*
     * The logical switch happens *before* the incoming deck starts, so the events it is about to emit
     * (play, timeupdate) belong to the track the UI has already switched to. Doing it afterwards made
     * the play-counting guard drop the first `play` of every crossfaded track.
     */
    pending.value = null
    currentIndex.value = ready.index
    duration.value = ready.track.duration || 0
    currentTime.value = 0
    isLive.value = false
    deckIndex.value = incoming
    applyLoudness(incoming, ready.track)
    updateMediaSession(ready.track)

    const element = deckElement(incoming)
    setFade(incoming, 0, 0)
    setFade(outgoing, 1, 0)
    element.muted = muted.value
    element.volume = volume.value
    void element
      .play()
      .then(() => {
        setFade(incoming, 1, seconds)
        setFade(outgoing, 0, seconds)
        isPlaying.value = true
      })
      .catch(() => {
        // If the incoming deck refuses to start, the old one must not be left fading to silence — and the
        // descriptors must go back with it, or the UI would be describing a deck that never played.
        setFade(incoming, 0, 0)
        setFade(outgoing, 1, 0)
        deckIndex.value = outgoing
        currentIndex.value = previousIndex
        duration.value = previousDuration
      })

    window.setTimeout(() => releaseDeck(outgoing), seconds * 1000 + 150)
    return true
  }

  /** Hard swap at the end of a track: the next deck is already buffered, so there is nothing to wait for. */
  async function advanceGapless(): Promise<boolean> {
    const ready = pending.value
    if (!ready || !ready.ready) return false
    const outgoing = deckIndex.value
    const incoming = ready.deck
    const previousIndex = currentIndex.value
    const previousDuration = duration.value
    pending.value = null
    currentIndex.value = ready.index
    duration.value = ready.track.duration || 0
    currentTime.value = 0
    isLive.value = false
    deckIndex.value = incoming
    applyLoudness(incoming, ready.track)
    updateMediaSession(ready.track)
    setFade(incoming, 1, 0)
    const element = deckElement(incoming)
    element.muted = muted.value
    element.volume = volume.value
    try {
      await element.play()
      isPlaying.value = true
    } catch {
      /*
       * Roll the swap back.
       *
       * Switching `deckIndex` *before* the incoming deck has started is what makes the transition gapless,
       * and it is also what makes a failed start so damaging: the UI would then describe a deck that never
       * played a note, reporting 0:00 while the previous deck (which is still playing and whose events are
       * now ignored) drives the sound. Restoring the descriptors lets the caller's normal advance path take
       * over and report the failure in context.
       */
      deckIndex.value = outgoing
      currentIndex.value = previousIndex
      duration.value = previousDuration
      isPlaying.value = false
      return false
    }
    releaseDeck(outgoing)
    return true
  }

  /**
   * The transition clock.
   *
   * `timeupdate` is far too coarse for a fade (4 Hz means up to 250 ms of drift, which is audible as
   * "the fade started late"), so while a next track is prepared a 100 ms timer watches the remaining
   * time and starts the overlap at the right moment.
   */
  function watchTransition(): void {
    if (crossfadeTimer) return
    const sound = useSoundStore()
    const seconds = sound.crossfadeSeconds
    // Nothing to watch without a prepared deck, and nothing to fade without the graph's gains.
    if (!pending.value || seconds <= 0 || !graphReady()) return
    crossfadeTimer = window.setInterval(() => {
      const ready = pending.value
      if (!ready) {
        window.clearInterval(crossfadeTimer)
        crossfadeTimer = 0
        return
      }
      if (!ready.ready) return
      const element = activeElement()
      const total = Number.isFinite(element.duration) && element.duration > 0 ? element.duration : duration.value
      const left = total - element.currentTime
      if (left <= seconds) {
        window.clearInterval(crossfadeTimer)
        crossfadeTimer = 0
        startCrossfade(seconds)
      }
    }, CROSSFADE_TICK_MS)
  }

  /* ------------------------------------------------------------------ transport */

  async function play(): Promise<void> {
    const track = current.value
    if (!track) {
      if (queue.value.length > 0) {
        currentIndex.value = 0
        const first = queue.value[0]
        if (first) await load(first, true)
      }
      return
    }
    ensureGraphForSound()
    /*
     * Load when the element does not hold *this* song.
     *
     * An empty `src` is the obvious case (a queue restored from the last session), and a deck holding a
     * different track is the subtle one: after a transition the idle deck carries the next song, and a
     * deck released by `releaseDeck` carries nothing but may still be the one the UI describes. In both
     * cases the honest answer is to load the current track, not to press play on whatever is loaded.
     */
    const deck = deckIndex.value
    const element = activeElement()
    if (!element.getAttribute('src') || loadedTrackId[deck] !== track.id) {
      await load(track, true, deck)
      return
    }
    try {
      await element.play()
      isPlaying.value = true
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'
    } catch {
      isPlaying.value = false
      isBuffering.value = false
      lastError.value = `无法播放「${current.value.title}」，文件可能已被移动或删除。`
      missedTracks.value = new Set(missedTracks.value).add(current.value.id)
      useUiStore().notify(lastError.value, 'error')
    }
  }

  function pause(): void {
    activeElement().pause()
    isPlaying.value = false
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'
  }

  function toggle(): void {
    if (isPlaying.value) pause()
    else void play()
  }

  async function playTrack(track: AudioTrack, list?: AudioTrack[]): Promise<void> {
    const source = list && list.length > 0 ? list : queue.value
    const onlineItems = source.filter((item) => item.origin === 'online')
    if (onlineItems.length > 0) useLibraryStore().rememberOnline(onlineItems)
    const index = source.findIndex((item) => item.id === track.id)
    if (index < 0) {
      queue.value = [track]
      currentIndex.value = 0
    } else {
      queue.value = [...source]
      currentIndex.value = index
    }
    await load(track, true)
  }

  function pickNextIndex(): number | null {
    if (queue.value.length === 0) return null
    if (mode.value === 'shuffle') {
      if (queue.value.length === 1) return 0
      let candidate = currentIndex.value
      while (candidate === currentIndex.value) candidate = Math.floor(Math.random() * queue.value.length)
      return candidate
    }
    const next = currentIndex.value + 1
    if (next < queue.value.length) return next
    return mode.value === 'sequential' ? null : 0
  }

  async function next(auto: boolean): Promise<boolean> {
    clearPending()
    if (mode.value === 'single' && auto) {
      const element = activeElement()
      element.currentTime = 0
      await play()
      return true
    }
    const index = pickNextIndex()
    if (index === null) {
      pause()
      currentTime.value = 0
      return false
    }
    currentIndex.value = index
    const track = queue.value[index]
    if (!track) return false
    await load(track, true)
    return true
  }

  async function previous(): Promise<void> {
    if (currentTime.value > 3) {
      seek(0)
      return
    }
    clearPending()
    if (queue.value.length === 0) return
    const index = currentIndex.value - 1 < 0 ? queue.value.length - 1 : currentIndex.value - 1
    currentIndex.value = index
    const track = queue.value[index]
    if (track) await load(track, true)
  }

  function seek(seconds: number): void {
    if (!Number.isFinite(seconds)) return
    const target = Math.min(Math.max(seconds, 0), duration.value || seconds)
    activeElement().currentTime = target
    currentTime.value = target
  }

  function seekRatio(ratio: number): void {
    if (duration.value <= 0) return
    seek(ratio * duration.value)
  }

  function setVolume(value: number): void {
    const next = Math.min(1, Math.max(0, value))
    volume.value = next
    if (next > 0 && muted.value) muted.value = false
    applyVolume()
    persistPrefs()
  }

  function toggleMute(): void {
    muted.value = !muted.value
    applyVolume()
    persistPrefs()
  }

  function cycleMode(): void {
    const index = PLAY_MODES.indexOf(mode.value)
    setMode(PLAY_MODES[(index + 1) % PLAY_MODES.length])
  }

  function setMode(next: PlayMode): void {
    mode.value = next
    persistPrefs()
  }

  function enqueue(track: AudioTrack, position: 'end' | 'next' = 'end'): void {
    if (track.origin === 'online') useLibraryStore().rememberOnline([track])
    const existing = queue.value.findIndex((item) => item.id === track.id)
    if (existing >= 0) {
      queue.value = queue.value.filter((item) => item.id !== track.id)
    }
    if (position === 'next') {
      const insertAt = currentIndex.value < 0 ? 0 : currentIndex.value + 1
      queue.value = [...queue.value.slice(0, insertAt), track, ...queue.value.slice(insertAt)]
      if (currentIndex.value < 0) currentIndex.value = 0
    } else {
      queue.value = [...queue.value, track]
      if (currentIndex.value < 0) currentIndex.value = 0
    }
    // The queue just changed under a prepared next track: drop it and let the transition clock refill it.
    if (pending.value && pending.value.index !== currentIndex.value + 1) clearPending()
  }

  function removeFromQueue(index: number): void {
    const removing = queue.value[index]
    if (!removing) return
    queue.value = queue.value.filter((_, position) => position !== index)
    clearPending()
    if (index < currentIndex.value) currentIndex.value -= 1
    else if (index === currentIndex.value) {
      pause()
      currentIndex.value = Math.min(currentIndex.value, queue.value.length - 1)
      const track = queue.value[currentIndex.value]
      if (track) void load(track, false)
      else currentIndex.value = -1
      updateMediaSession(current.value)
    }
  }

  function moveQueueItem(from: number, to: number): void {
    if (from === to || from < 0 || to < 0 || from >= queue.value.length || to >= queue.value.length) return
    const items = [...queue.value]
    const [moved] = items.splice(from, 1)
    items.splice(to, 0, moved)
    const currentId = current.value?.id
    queue.value = items
    currentIndex.value = currentId ? items.findIndex((item) => item.id === currentId) : -1
    clearPending()
  }

  /** Drops a removed track from the queue without disturbing playback of other tracks. */
  function clearIfCurrent(trackId: string): void {
    const index = queue.value.findIndex((item) => item.id === trackId)
    if (index < 0) return
    removeFromQueue(index)
  }

  function clearQueue(): void {
    pause()
    recordedTrackId = ''
    clearPending()
    stopLoudnessMeasurement()
    queue.value = []
    currentIndex.value = -1
    releaseDeck(0)
    releaseDeck(1)
    currentTime.value = 0
    duration.value = 0
    updateMediaSession(null)
  }

  function replaceQueue(tracks: AudioTrack[], startIndex = 0): void {
    queue.value = [...tracks]
    currentIndex.value = tracks.length > 0 ? Math.min(Math.max(startIndex, 0), tracks.length - 1) : -1
    clearPending()
  }

  /* ------------------------------------------------------------------ sleep timer */

  /**
   * The 1 Hz sleep clock — running **only while a countdown is armed**.
   *
   * It used to be a module-level `setInterval` started at store setup and never cleared, i.e. it wrote to a
   * reactive ref once a second for the whole session even when no timer was set, waking every computed that
   * reads it (`sleepRemaining`, `sleepLabelText`) and re-rendering the label. Same numbers, same behaviour
   * while armed; nothing at all when the feature is off, which is how it almost always is.
   */
  let sleepTicker = 0

  function stopSleepClock(): void {
    if (sleepTicker) window.clearInterval(sleepTicker)
    sleepTicker = 0
  }

  function startSleepClock(): void {
    if (sleepTicker) return
    sleepClock.value = Date.now()
    sleepTicker = window.setInterval(() => {
      sleepClock.value = Date.now()
      if (sleep.value.mode !== 'minutes') return
      if (!isExpired(sleep.value, sleepClock.value)) return
      sleep.value = { ...SLEEP_OFF }
      stopSleepClock()
      pause()
      useUiStore().notify('睡眠定时到，已停止播放', 'info')
    }, 1000)
  }

  function startSleep(minutes: number): void {
    sleep.value = startSleepMinutes(minutes)
    startSleepClock()
    sleepClock.value = Date.now()
    useUiStore().notify(describeSleep(sleep.value), 'info')
  }

  function startSleepAfterTrack(): void {
    sleep.value = { mode: 'track', deadline: 0, minutes: 0 }
    // No countdown to tick: this mode ends with the track, and the label does not read the clock.
    stopSleepClock()
    sleepClock.value = Date.now()
    useUiStore().notify(describeSleep(sleep.value), 'info')
  }

  function cancelSleep(): void {
    sleep.value = { ...SLEEP_OFF }
    stopSleepClock()
    useUiStore().notify('睡眠定时已关闭', 'info')
  }

  /* ------------------------------------------------------------------ element events */

  let recordedTrackId = ''

  function bindDeck(deck: 0 | 1): void {
    const element = deckElement(deck)
    const isActiveDeck = (): boolean => deckIndex.value === deck

    element.addEventListener('timeupdate', () => {
      // The outgoing deck keeps playing through a crossfade; its clock must not drive the UI.
      if (!isActiveDeck()) return
      currentTime.value = element.currentTime
      if (duration.value === 0 && Number.isFinite(element.duration)) duration.value = element.duration
      // Clock-only report: `timeupdate` fires several times a second, and re-sending the whole track
      // payload on each one is pure IPC weight — the main process already has it (see `reportState`).
      reportState(false)
      if (pending.value) return
      const sound = useSoundStore()
      if (!sound.gapless && sound.crossfadeSeconds <= 0) return
      const total = Number.isFinite(element.duration) ? element.duration : duration.value
      if (total > 0 && total - element.currentTime <= PRELOAD_WINDOW_SECONDS) {
        void prepareNext().then(() => watchTransition())
      }
    })
    element.addEventListener('loadedmetadata', () => {
      if (!isActiveDeck()) return
      isBuffering.value = false
      if (Number.isFinite(element.duration)) duration.value = element.duration
    })
    element.addEventListener('play', () => {
      if (!isActiveDeck()) return
      isPlaying.value = true
      const track = current.value
      // Resuming the same song must not count as another play.
      if (track && track.id !== recordedTrackId) {
        recordedTrackId = track.id
        useCollectionStore().recordPlay(track.id)
      }
    })
    element.addEventListener('pause', () => {
      if (!isActiveDeck()) return
      isPlaying.value = false
    })
    element.addEventListener('waiting', () => {
      if (!isActiveDeck()) return
      isBuffering.value = true
    })
    element.addEventListener('playing', () => {
      if (!isActiveDeck()) return
      isBuffering.value = false
      ensureGraphForSound()
    })
    element.addEventListener('error', () => {
      if (!isActiveDeck()) return
      isBuffering.value = false
      const track = current.value
      if (!track) return
      isPlaying.value = false
      missedTracks.value = new Set(missedTracks.value).add(track.id)
      lastError.value = `无法读取「${track.title}」，文件可能已被移动或删除。`
      useUiStore().notify(lastError.value, 'error')
    })
    element.addEventListener('ended', () => {
      if (!isActiveDeck()) return
      /*
       * The sleep timer gets first refusal on the end of a track: in 「本曲结束后」 mode the whole point is
       * that the queue does *not* advance. In countdown mode the answer is always "keep going" — the
       * deadline is what stops playback, and a track that ends before it should roll on as usual.
       */
      if (shouldStopAtTrackEnd(sleep.value)) {
        sleep.value = { ...SLEEP_OFF }
        stopSleepClock()
        pause()
        useUiStore().notify('睡眠定时：当前歌曲已播完，停止播放', 'info')
        return
      }
      void (async () => {
        // The prepared next deck is already buffered — that *is* gapless: no re-resolve, no wait.
        if (await advanceGapless()) return
        await next(true)
      })()
    })
  }

  bindDeck(0)
  bindDeck(1)

  /**
   * One report carries everything a second window needs to follow playback. It is sent on state
   * changes *and* on `timeupdate`, because the desktop-lyrics window keeps its own clock from it;
   * the main process throttles before forwarding, so this is not an IPC storm.
   */
/** The track id whose payload the main process already holds, so it is not sent twice. */
  let reportedTrackId = ''

  /**
   * Pushes the playback state to main (tray, desktop lyrics, local API).
   *
   * `withTrack` is what keeps a few-times-a-second message cheap: the clock needs to keep arriving, but the
   * track object — a full `AudioTrack`, with its source fields — only has to move when the song changes. A
   * missing `track` already means "nothing new" on the receiving side, so the light report is not a
   * truncated one; it is the same message with the part that did not change left out.
   */
  function reportState(withTrack = true): void {
    const track = current.value
    const sendTrack = withTrack && (track?.id ?? '') !== reportedTrackId
    if (sendTrack) reportedTrackId = track?.id ?? ''
    void appService.reportPlayerState({
      isPlaying: isPlaying.value,
      title: track?.title ?? '',
      artist: track?.artist ?? '',
      currentTime: Number.isFinite(currentTime.value) ? currentTime.value : 0,
      duration: Number.isFinite(duration.value) ? duration.value : 0,
      trackId: track?.id ?? '',
      ...(sendTrack ? { track: track ?? null } : {}),
    })
  }

  watch([isPlaying, () => current.value?.title, () => current.value?.artist], () => {
    reportState()
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = isPlaying.value ? 'playing' : 'paused'
    }
  })

  /*
   * The track payload follows the *id*, not the labels.
   *
   * Since the clock reports stopped carrying the track object, the payload would otherwise be missed for the
   * one case where title and artist do not change (two files with identical tags — a real thing in a local
   * library). Watching the id is what keeps the desktop-lyrics strip and the tray pinned to the right song.
   */
  watch(() => current.value?.id, () => reportState())

  // Commands from outside this window (the desktop-lyrics strip, the tray/media keys).
  appService.onPlayerCommand((command) => {
    if (command === 'toggle-play') toggle()
    // `auto = false`: an explicit "next" must not restart a track in single-repeat mode.
    else if (command === 'next') void next(false)
    else if (command === 'previous') void previous()
  })

  registerMediaSessionHandlers()

  /**
   * Re-resolves the *current* song against the quality preference that is in force now.
   *
   * Changing the preference under a playing track has to be audible immediately — otherwise the setting
   * looks inert until the next song, which is exactly how "the picker did nothing" gets reported. The
   * playback position is carried over, because the same song at another tier is still the same song.
   */
  async function refreshQuality(): Promise<boolean> {
    const track = current.value
    if (!track || track.origin !== 'online') return false
    const element = activeElement()
    const resumeAt = element.currentTime
    const wasPlaying = !element.paused
    if (resumeAt > 0.5) {
      element.addEventListener(
        'loadedmetadata',
        () => {
          try {
            element.currentTime = resumeAt
          } catch {
            // A stream that refuses a seek simply starts from the beginning; not worth an error toast.
          }
        },
        { once: true },
      )
    }
    await load(track, wasPlaying)
    return true
  }

  return {
    audio,
    deckIndex,
    deckInUse,
    sleep,
    sleepRemaining,
    sleepLabelText,
    pendingNext: computed(() => pending.value?.track ?? null),
    queue,
    currentIndex,
    current,
    isPlaying,
    isBuffering,
    currentTime,
    duration,
    progress,
    hasQueue,
    upNext,
    volume,
    resolvedQuality,
    lastQualityReason,
    currentQualityTier,
    muted,
    mode,
    lastError,
    missedTracks,
    isLive,
    play,
    pause,
    toggle,
    next,
    previous,
    seek,
    seekRatio,
    setVolume,
    toggleMute,
    cycleMode,
    setMode,
    playTrack,
    refreshQuality,
    enqueue,
    removeFromQueue,
    moveQueueItem,
    clearQueue,
    clearIfCurrent,
    replaceQueue,
    startSleep,
    startSleepAfterTrack,
    cancelSleep,
  }
})
