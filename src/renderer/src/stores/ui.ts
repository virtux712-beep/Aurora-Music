import { computed, ref } from 'vue'
import { isHexColor, isLyricColorMode, type LyricColorMode } from '../../../shared/lyricInk'
import { isVinylMaterial, type VinylMaterial } from '../../../shared/vinyl'
import type { AnimationLevel, ThemeTokens } from '../../../shared/theme'
import { defineStore } from 'pinia'
import type { ThemeMode, UserThemeRecord } from '../../../shared/types'
import type { ThemeDefinition } from '../../../shared/theme'
import { themesService } from '../services/aurora'
import { AUTO_LEVEL_KEY, levelSlot, LEVEL_KEY, resolveStoredLevel } from '../theme/effects/levelStore'
import { installThemeCss, themeCss } from '../theme/apply'
import { mix } from '../theme/palette'
import { BUILT_IN_SKINS, DEFAULT_SKIN_ID, findBuiltInSkin, skinChrome } from '../theme/skins'
import {
  applyEffects,
  downgrade,
  LEVELS,
  planEffects,
  startEnergy,
  upgrade,
  type EffectPlan,
} from '../theme/effects'
import {
  frameSnapshot,
  installGovernor,
  setFrameActivity,
  setFrameRate as applyFrameRate,
  startFrames,
  type FrameSnapshot,
  type LoadAction,
} from '../visual/frame'
import {
  frameRateLabel,
  isFrameRateChoice,
  parseFrameRateChoice,
  type FrameRateChoice,
  type FrameStats,
  type LoadGrade,
} from '../visual/budget'
import {
  dateKey,
  easterAura,
  EMPTY_COMPANION,
  formatCompanionTime,
  nextStreak,
  parseCompanion,
  recordListening,
  recordPlay,
  SIGNAL_LOST_MS,
  type CompanionRecord,
} from '../theme/easter'
import { recommendSkin, recommendable, type Recommendation } from '../theme/recommend'

const THEME_KEY = 'aurora:theme'
const SKIN_KEY = 'aurora:skin'
const LYRIC_COLOR_KEY = 'aurora:lyric-color'
const VINYL_KEY = 'aurora:vinyl'
const LYRIC_CUSTOM_KEY = 'aurora:lyric-custom'
/**
 * The frame cap, in its own slot for the same reason the animation level has one: it is a preference the
 * user set, and it must not be confused with a value the load guard produced.
 */
const FRAME_RATE_KEY = 'aurora:frame-rate'
/** The listening record. Its own slot: it is history, not a preference. */
const COMPANION_KEY = 'aurora:companion'
/** When the night aurora was first unlocked, so the badge survives a restart. */
const NIGHT_KEY = 'aurora:easter-night'

/** Carried over from the previous build's on/off switch, so an existing choice is not silently lost. */
const LEGACY_EFFECTS_KEY = 'aurora:ambient-effects'

/** Custom properties the last applied plan set, so switching levels cannot leave a stale one behind. */
let appliedVars = new Set<string>()

/**
 * The `--night-*` properties the last skin published, so switching to a skin that declares fewer of them
 * cannot leave the previous skin's dark colours behind on the bar.
 */
let nightVars = new Set<string>()

/** How long the track-change sweep runs, and how long a volume bump lasts. Mirrored by the CSS keyframes. */
const SWITCH_MS = 1100
const VOLUME_MS = 320

/** The strip colour when the active skin declares none (the default skin *is* `base.css`). */
const STRIP_FALLBACK: Record<'dark' | 'light', string> = { dark: '#0d1016', light: '#ffffff' }

/**
 * The ink the immersive page is built on, and what the shell starts from before anything is measured.
 *
 * Kept in step with `.ambient` in `app.css`, which builds the room from `color-mix(--bg 28%, #04050a)`.
 */
const NIGHT_INK = '#0a0c12'

/**
 * How much of the cover's accent the shell carries.
 *
 * Non-zero on purpose, and this is the half a pure sample cannot supply. The veil over the top and
 * bottom edges is 52%…90% ink, so the colour *exactly* behind either piece of chrome is nearly neutral:
 * measured on a purple cover, `#504551` at the top and `#4a4849` above the bar. Painting those matched the
 * backdrop pixel-perfectly and looked like grey plastic. Measured value supplies the brightness — which is
 * what makes the seam invisible — and the accent supplies the hue.
 */
const SHELL_ACCENT_SHARE = 0.3

/** How long the native strip takes to travel to a new colour. Roughly the room's own 900 ms fade. */
const STRIP_FADE_MS = 620

/** `#rgb` / `#rrggbb` to channels, or `null` when it is not a hex colour. */
function channels(color: string): [number, number, number] | null {
  const raw = color.trim().replace(/^#/, '')
  const full = raw.length === 3 ? raw.replace(/./g, (char) => char + char) : raw
  if (!/^[0-9a-f]{6}$/i.test(full)) return null
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ]
}

export interface Toast {
  id: number
  message: string
  tone: 'info' | 'success' | 'error'
}

export { LYRIC_COLOR_OPTIONS, type LyricColorMode } from '../../../shared/lyricInk'

function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'dark' || value === 'light' || value === 'system'
}

export const useUiStore = defineStore('ui', () => {
  const theme = ref<ThemeMode>('dark')
  /** The active skin's id. Resolved against built-ins first, then the user's folder. */
  const skin = ref<string>(DEFAULT_SKIN_ID)
  /** Files found in the user's themes folder, including the ones that were rejected (with why). */
  const userThemes = ref<UserThemeRecord[]>([])
  /**
   * The animation budget: 关闭 / 节能 / 标准 / 沉浸.
   *
   * A level rather than an on/off switch, because the honest answer to "the effects cost too much" is
   * "here is a cheaper one that still looks like your theme", and because the automatic fallback below
   * needs somewhere to fall back *to*.
   */
  const animationLevel = ref<AnimationLevel>('standard')
  /**
   * The level the *user* chose, kept apart from the level currently running.
   *
   * It is the guard's ceiling: an automatic recovery may climb back to this and no further, so a machine
   * that has a good hour cannot quietly talk the user's own dial up. `setAnimationLevel` maintains it —
   * a manual choice writes here, an automatic one never does.
   */
  const userLevel = ref<AnimationLevel>('standard')
  /**
   * The frame cap: `follow` for the display's own rate, or a number of frames per second.
   *
   * A cap rather than a target, which is the only honest way to offer 144 on a 60 Hz panel: the effective
   * rate is the lower of the two, so picking a higher number changes nothing and picking a lower one
   * really does reduce the work.
   */
  const frameRate = ref<FrameRateChoice>('follow')
  /**
   * Set when the load guard changes the level itself, so the UI can say so instead of the change being a
   * mystery. Carries the measurement, and which way it moved — a silent recovery is as confusing as a
   * silent downgrade ("why is my picture different from this morning?").
   */
  const autoDowngraded = ref<{
    from: AnimationLevel
    to: AnimationLevel
    frameMs: number
    direction: LoadAction
    grade: LoadGrade
    reason: string
  } | null>(null)
  /** Mirrors the player's play/pause, so CSS can slow down (and not merely stop) when music pauses. */
  const playing = ref(false)
  /**
   * The listening record: tracks started, seconds listened, and the first day Aurora was used.
   *
   * Written to storage, which is the point — it is the one number in the app that gets more valuable with
   * time, and losing it to a ref that dies with the window would make the settings card a lie.
   */
  const companion = ref<CompanionRecord>({ ...EMPTY_COMPANION })
  /** Tracks in a row this session. Five of them unlock the night aurora. */
  const streak = ref(0)
  /** Whether the half-second "Signal Lost" glitch is on screen. */
  const signalLost = ref(false)
  /** When the glitch last fired, so two fast skips cannot stack it. */
  const lastSignalLostAt = ref(0)
  const effectPlan = ref<EffectPlan | null>(null)
  const searchQuery = ref('')
  const queueOpen = ref(false)
  const toasts = ref<Toast[]>([])
  /** Immersive mode: the lyrics page hides its chrome and takes over the whole window. */
  const immersive = ref(false)
  /**
   * Whether the播放详情 page is open.
   *
   * That page is its own lighting environment and stays dark in *every* theme by design (see
   * `.lyrics-page`), but the two pieces of chrome that float above it — the player bar and the native
   * title-bar strip — follow the app's mode. In a light theme that left a cream bar and a cream strip
   * sitting on a night room: the brightest things on screen, and the only two that ignored it.
   *
   * So while the page is open the shell resolves its skin's *dark* variant. Only the resolved mode
   * changes; the preference that gets persisted is still the user's own (see `applyTheme`).
   */
  const nightPage = ref(false)
  /**
   * The artwork's dominant colour, published by the playback-detail page.
   *
   * That page is a *sibling* of the player bar in the DOM — both sit under `<body>` — so the bar cannot
   * inherit the page's colours. Publishing this on the root is what lets the bar and the native strip
   * tint themselves with the same colour the room is using, per song rather than per theme.
   */
  const artworkAccent = ref('#8fa6ff')
  /** The two colours the shell is painted with, after the measurement and the cover's hue are composed. */
  const shellStrip = ref('')
  const shellBar = ref('')
  /**
   * The *measured* backdrop, kept apart from the composed colour above.
   *
   * Keeping the two apart is what makes the shell feel immediate: a track change can recompose both
   * colours in the same tick out of the last measurement, and the capture that follows only corrects the
   * backdrop's brightness. Composing straight from a fresh sample is what made switching songs take a
   * full second to show up at all.
   */
  let edgeStrip = ''
  let edgeBar = ''
  /** The lyric ink choice. Pure presentation, so it lives here rather than in main's settings. */
  const lyricColor = ref<LyricColorMode>('auto')
  /** Only meaningful in `custom`, but remembered regardless so switching back and forth is lossless. */
  const lyricCustomColor = ref('#ffffff')
  /** What the 拟真唱片 record is pressed from. Presentation only, so it lives here, not in main. */
  const vinylMaterial = ref<VinylMaterial>('black')
  let toastId = 0
  let fullscreenBound = false

  function resolveTheme(mode: ThemeMode): 'dark' | 'light' {
    if (mode !== 'system') return mode
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }

  /**
   * The page owns the look; main owns the native chrome (title-bar strip, native control scheme).
   *
   * Pushing on every apply — not only on user action — is what keeps the two in step when the mode
   * is `system` and Windows flips underneath us. `setTheme` on the bridge is a no-op without it, and
   * the call is fire-and-forget: a failed repaint of the title bar must not stop the page from
   * switching.
   */
  /** Every usable skin: the built-ins first, then the user's, in the order the folder returned them. */
  const availableSkins = computed<ThemeDefinition[]>(() => [
    ...BUILT_IN_SKINS,
    ...userThemes.value.filter((record) => record.ok && record.theme).map((record) => record.theme as ThemeDefinition),
  ])

  /** The active skin, or the default when the stored id no longer exists (a deleted user theme). */
  const activeSkin = computed<ThemeDefinition>(
    () => availableSkins.value.find((item) => item.id === skin.value) ?? BUILT_IN_SKINS[0],
  )

  /**
   * Applies everything the current theme implies, in the order it has to happen.
   *
   * Three things have to move together or the window looks half-painted: the CSS (`data-theme` +
   * `data-skin`), the ambient parameters, and the *native* chrome. That last one is why this pushes to
   * main on every apply rather than only on a click — with `system` the OS can flip underneath us and
   * the strip would stay on the old scheme.
   */
  function applyTheme(): void {
    const mode = resolveTheme(theme.value)
    const current = activeSkin.value
    document.documentElement.dataset.theme = mode
    document.documentElement.dataset.skin = current.id
    // Exposed as an attribute so the stylesheet and the packaged suite can both see the state.
    document.documentElement.dataset.night = nightPage.value ? 'on' : ''

    /*
     * The night page paints its room from the skin's *dark* palette, so the player bar — which sits above
     * the page rather than inside it — has to be able to reach that same palette.
     *
     * It is published under a prefix instead of re-declared by hand in CSS: a hand-written dark list is a
     * second definition of the token set and would drift from the generated one. The default skin declares
     * no tokens at all (its colours *are* `base.css`), which is why the CSS side supplies fallbacks. The
     * previous skin's keys are cleared first, or a switch to the default skin would inherit the last
     * skin's dark colours.
     */
    const root = document.documentElement
    for (const name of nightVars) root.style.removeProperty(name)
    nightVars = new Set()
    for (const [token, value] of Object.entries(current.dark)) {
      const name = `--night${token.slice(1)}`
      root.style.setProperty(name, value)
      nightVars.add(name)
    }
    pushStrip()

    /*
     * The plan is built *after* the attributes are set and its accent colours are read back from the
     * computed style.
     *
     * That ordering is what makes the aura correct for every theme including the default one (whose
     * tokens live in `base.css`, not in JavaScript) and for user themes (whose colours only exist once
     * their generated rules apply) — the browser is the single source of truth for what a token actually
     * resolves to in this mode.
     */
    const styles = getComputedStyle(document.documentElement)
    const tokens: ThemeTokens = {
      '--accent': styles.getPropertyValue('--accent').trim(),
      '--accent-strong': styles.getPropertyValue('--accent-strong').trim(),
      '--ambient-b': styles.getPropertyValue('--ambient-b').trim(),
    }
    const plan = planEffects(current, animationLevel.value, tokens)
    appliedVars = applyEffects(document.documentElement, plan, appliedVars)
    effectPlan.value = plan
    const profile = LEVELS[animationLevel.value]
    document.documentElement.style.setProperty('--ambient-glow', String(current.effects.glow * profile.glow))
    document.documentElement.style.setProperty('--ambient-drift', `${current.effects.driftSeconds}s`)

    /*
     * A skin carries its own ambient colours, so switching skin or mode *while the night page is open*
     * repaints the room under the shell — and the sampled colours are now stale. `setNightPage` schedules
     * its own sample one call later, so this only fires for a change made while the page is already up.
     */
    if (nightPage.value) scheduleSample(600)

  }

  /**
   * The shell's colour: a measured backdrop, carried by the current cover's hue.
   *
   * See `SHELL_ACCENT_SHARE` for why neither half is optional, and `edgeStrip` for why the measurement is
   * stored rather than used directly — this is called on every track change, and it must not have to wait
   * for a capture before the screen moves.
   */
  function composedShell(edge: string): string {
    return mix(edge || NIGHT_INK, artworkAccent.value, SHELL_ACCENT_SHARE)
  }

  /** Publishes both shell colours and hands them to the window chrome. The only place they change. */
  function applyShell(): void {
    shellStrip.value = composedShell(edgeStrip)
    shellBar.value = composedShell(edgeBar)
    if (!nightPage.value) return
    const root = document.documentElement
    root.style.setProperty('--shell-strip', shellStrip.value)
    root.style.setProperty('--shell-bar', shellBar.value)
    pushStrip()
  }

  /**
   * Ink for a surface whose colour came from the cover, decided from that colour's own luminance.
   *
   * A theme's `symbolColor` cannot answer this: the strip is the *room*, so a bright cover in a dark
   * theme would put pale glyphs on a pale strip. It is only ever asked for the native window buttons.
   */
  function inkOn(color: string): string {
    const rgb = channels(color)
    if (!rgb) return '#f1f2f7'
    const luminance = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255
    return luminance > 0.6 ? '#14161c' : '#f1f2f7'
  }

  function nightChrome(): { color: string; symbolColor: string } {
    const color = shellStrip.value || composedShell(edgeStrip)
    return { color, symbolColor: inkOn(color) }
  }

  let sampleTimers: number[] = []
  let sampling = false
  let resizeBound = false
  let stripTween: number | null = null
  let shownStrip = ''
  /** The last night/day + skin combination main was told about; see `pushStrip`. */
  let announcedStrip = ''

  /** One colour to the native overlay. Deliberately not `setTheme`: a fade must not write settings. */
  function sendNativeStrip(color: string): void {
    const bridge = window.aurora?.app
    if (!bridge?.setChrome) return
    void bridge.setChrome({ color, symbolColor: inkOn(color) }).catch(() => undefined)
  }

  /**
   * Fades the native strip to `target`.
   *
   * The renderer's copy of the strip is a custom property, so CSS interpolates it for free — but the
   * overlay is painted by the OS and takes one concrete colour, so a new cover used to cut the top of the
   * window in a single frame while everything around it travelled. Twelve steps over `STRIP_FADE_MS`
   * reads as motion, and costs a repaint of a 36px strip.
   */
  function fadeNativeStrip(target: string): void {
    if (stripTween !== null) {
      window.clearInterval(stripTween)
      stripTween = null
    }
    const from = shownStrip || target
    shownStrip = target
    if (from === target) {
      sendNativeStrip(target)
      return
    }
    const steps = 12
    let step = 0
    stripTween = window.setInterval(() => {
      step += 1
      const eased = 1 - Math.pow(1 - step / steps, 3)
      sendNativeStrip(mix(from, target, eased))
      if (step >= steps && stripTween !== null) {
        window.clearInterval(stripTween)
        stripTween = null
      }
    }, Math.max(16, Math.round(STRIP_FADE_MS / steps)))
  }

  /**
   * Measures what is behind the two pieces of chrome.
   *
   * This is a *measurement*, not the colour: what it stores is composed with the cover's hue by
   * `composedShell`. Two regions, and deliberately not the bar itself — the band sampled for the bar sits
   * *above* it, because sampling the bar would feed its own colour back in.
   *
   * Two reads per change (an early one and a settled one). The room is still travelling during the first,
   * so it lands close but not exact; the second corrects it while the eye is following a 620 ms fade
   * rather than watching a step.
   */
  async function sampleShell(): Promise<void> {
    if (!nightPage.value || sampling) return
    const bridge = window.aurora?.app
    if (!bridge?.sampleBackdrop) return
    sampling = true
    try {
      const width = window.innerWidth
      const height = window.innerHeight
      const bar = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--player-h')) || 100
      /*
       * Wide enough to average past the veil's ramp and the grain, narrow enough to stay clear of the
       * window buttons and the page's own chrome at either edge.
       */
      const band = Math.round(Math.min(160, Math.max(48, width * 0.07)))
      const x = Math.max(0, Math.round((width - band) / 2))
      const [strip, barEdge] = await bridge.sampleBackdrop([
        { x, y: 2, width: band, height: 12 },
        { x, y: Math.max(0, Math.round(height - bar - 16)), width: band, height: 12 },
      ])
      // The page may have been left while the capture was in flight; its colours mean nothing then.
      if (!nightPage.value) return
      if (strip) edgeStrip = strip
      if (barEdge) edgeBar = barEdge
      applyShell()
    } catch {
      // A failed sample needs no toast: the composed colour is already on screen and looks right.
    } finally {
      sampling = false
    }
  }

  /**
   * Cancels pending measurements and schedules new ones.
   *
   * More than one delay is the point: the first read is early enough that the page has painted, and the
   * second lands after the room's 900 ms accent crossfade has finished. Sampling once, late, was a second
   * of nothing moving; sampling once, early, would leave the shell on a colour the room has left.
   */
  function scheduleSample(...delays: number[]): void {
    for (const timer of sampleTimers) window.clearTimeout(timer)
    sampleTimers = delays.map((delay) => {
      const handle = window.setTimeout(() => {
        sampleTimers = sampleTimers.filter((id) => id !== handle)
        void sampleShell()
      }, delay)
      return handle
    })
  }

  /** The backdrop is a set of gradients, so resizing moves what colour sits under each region. */
  function onShellResize(): void {
    if (nightPage.value) scheduleSample(220)
  }

  /**
   * Paints and sends the strip. One place, so `--titlebar-bg` (the strip the renderer draws under the OS
   * buttons) and the native overlay can never disagree — and so a new cover can move the strip without
   * rebuilding the whole effect plan.
   *
   * `theme.value` — the user's own choice — is what main persists, so a visit to the lyrics page can never
   * rewrite the saved preference. `night` travels separately and only decides what the strip and
   * `nativeTheme` (which is what native scrollbars follow) do right now.
   */
  function pushStrip(): void {
    const current = activeSkin.value
    const night = nightPage.value
    const mode = night ? 'dark' : resolveTheme(theme.value)
    const chrome = night ? nightChrome() : skinChrome(current, mode)
    const color = chrome?.color || STRIP_FALLBACK[mode]
    document.documentElement.style.setProperty('--titlebar-bg', color)
    const bridge = window.aurora?.app
    if (!bridge) return
    /*
     * `setTheme` also persists the mode/skin and moves `nativeTheme`, so it is for a change of *state*;
     * `setChrome` only repaints the overlay, so it is for a change of *colour*. Splitting them is what
     * lets a track change fade the strip without a settings write per frame.
     */
    const state = `${night ? 'night' : mode}|${current.id}`
    if (state !== announcedStrip) {
      announcedStrip = state
      if (stripTween !== null) {
        window.clearInterval(stripTween)
        stripTween = null
      }
      shownStrip = color
      void bridge.setTheme(theme.value, chrome, current.id, night).catch(() => undefined)
      return
    }
    if (night) {
      fadeNativeStrip(color)
      return
    }
    // Leaving the page hands the strip back at once: a fade on the way out reads as the app being stuck.
    shownStrip = color
    void bridge.setChrome({ color, symbolColor: inkOn(color) }).catch(() => undefined)
  }

  /**
   * Re-tints the chrome for a new cover. Deliberately not `applyTheme()`: that rebuilds and re-applies the
   * effect plan, and a track change should not restart the particles to recolour a hairline.
   */
  function setArtworkAccent(color: string): void {
    if (artworkAccent.value === color) return
    artworkAccent.value = color
    if (!nightPage.value) return
    document.documentElement.style.setProperty('--amb-accent', color)
    /*
     * Recolour *now*, out of the last measurement.
     *
     * This is the whole reason the measurement and the composition are separate: a new song can move the
     * shell in the same tick the room starts travelling, and the captures that follow only correct the
     * backdrop's brightness. Waiting for a capture was a second of the screen doing nothing, which reads
     * as "the feature is broken".
     */
    applyShell()
    scheduleSample(420, 1150)
  }

  /**
   * Opens/closes the night adaptation for the playback-detail page. Idempotent, because it is driven by a
   * route watcher that can fire more than once per navigation.
   */
  function setNightPage(next: boolean): void {
    if (nightPage.value === next) return
    nightPage.value = next
    /*
     * Publish the accent on the root only while the page needs it. The page sets its own copy inline, so
     * this is purely for the chrome above it — the bar and the strip are not descendants of the page.
     */
    if (next) {
      document.documentElement.style.setProperty('--amb-accent', artworkAccent.value)
      if (!resizeBound) {
        window.addEventListener('resize', onShellResize)
        resizeBound = true
      }
    } else {
      for (const timer of sampleTimers) window.clearTimeout(timer)
      sampleTimers = []
    }
    applyTheme()
    if (!next) return
    /*
     * Paint from whatever is already known, so the first frame on this page is not a bare ink, then start
     * measuring. The early read needs the page painted; the late one needs the room's accent fade done.
     */
    applyShell()
    scheduleSample(320, 1100)
  }

  /** Writes the generated stylesheet for every known skin. Cheap, and only on skin-set changes. */
  function installSkins(): void {
    installThemeCss(themeCss(availableSkins.value))
  }

  function setTheme(mode: ThemeMode): void {
    theme.value = mode
    localStorage.setItem(THEME_KEY, mode)
    applyTheme()
    void persistSkin()
  }

  /**
   * Switches skin, and with it the mode the skin was designed around.
   *
   * Applying `preferredMode` is deliberate: 星河入梦 is a night-time space and opening it in daylight
   * colours is not the theme anyone asked for. It is announced rather than silent, and the mode buttons
   * stay right there in the theme centre for anyone who disagrees.
   */
  function setSkin(id: string, options: { applyPreferred?: boolean } = {}): string | null {
    const target = availableSkins.value.find((item) => item.id === id) ?? findBuiltInSkin(id)
    if (!target) return null
    skin.value = target.id
    localStorage.setItem(SKIN_KEY, target.id)
    let switched = ''
    if (options.applyPreferred !== false && resolveTheme(theme.value) !== target.preferredMode) {
      theme.value = target.preferredMode
      localStorage.setItem(THEME_KEY, target.preferredMode)
      switched = target.preferredMode === 'dark' ? '深色' : '浅色'
    }
    applyTheme()
    void persistSkin()
    return switched
  }

  /** Mirrors the choice into main's settings, which is what a restart reads before the page loads. */
  async function persistSkin(): Promise<void> {
    try {
      await window.aurora?.settings.set({ skin: skin.value, theme: theme.value })
    } catch {
      // Storage is best-effort here: the page has already switched, and localStorage still holds it.
    }
  }

  /** Rescans the user's themes folder, reinstalls the stylesheet and re-applies the active skin. */
  async function loadUserThemes(): Promise<UserThemeRecord[]> {
    try {
      userThemes.value = await themesService.list()
    } catch {
      userThemes.value = []
    }
    installSkins()
    // A user theme that has just appeared (or vanished) changes what the stored id resolves to.
    if (!availableSkins.value.some((item) => item.id === skin.value)) {
      skin.value = DEFAULT_SKIN_ID
      localStorage.setItem(SKIN_KEY, DEFAULT_SKIN_ID)
    }
    applyTheme()
    return userThemes.value
  }

  /**
   * Publishes the lyric ink as a data attribute plus the custom colour.
   *
   * The recipes themselves live in the stylesheet: the renderer owns *which* mode is active, `app.css`
   * owns what each mode looks like, so the picker and the painted lyrics cannot drift apart.
   */
  function applyLyricColor(): void {
    const root = document.documentElement
    root.dataset.lyricColor = lyricColor.value
    root.style.setProperty('--lyric-custom', lyricCustomColor.value)
  }

  function setLyricColor(mode: LyricColorMode): void {
    if (!isLyricColorMode(mode)) return
    lyricColor.value = mode
    localStorage.setItem(LYRIC_COLOR_KEY, mode)
    applyLyricColor()
  }

  /**
   * Switches the record's pressing.
   *
   * Published on the root rather than passed down as a prop: the record reads its own material from CSS
   * (`data-vinyl`), and it is the same attribute the packaged suite asserts against.
   */
  function setVinylMaterial(material: VinylMaterial): void {
    if (!isVinylMaterial(material)) return
    vinylMaterial.value = material
    localStorage.setItem(VINYL_KEY, material)
    document.documentElement.dataset.vinyl = material
  }

  function setLyricCustomColor(color: string): void {
    if (!isHexColor(color)) return
    lyricCustomColor.value = color.toLowerCase()
    localStorage.setItem(LYRIC_CUSTOM_KEY, lyricCustomColor.value)
    applyLyricColor()
  }

  function setAnimationLevel(next: AnimationLevel, options: { automatic?: boolean } = {}): void {
    const from = animationLevel.value
    animationLevel.value = next
    /*
     * An automatic change is parked in its own slot so the guard can never overwrite a choice the user
     * made: this session runs quieter, the next launch starts from their own dial again. A manual change
     * is the opposite — it is the choice, so it is what later launches read, and any session value still
     * lying around is dropped. A manual choice also *is* the ceiling the guard may recover to.
     */
    localStorage.setItem(levelSlot(Boolean(options.automatic)), next)
    if (!options.automatic) {
      localStorage.removeItem(AUTO_LEVEL_KEY)
      userLevel.value = next
      // The user has just spoken: whatever the guard did earlier is no longer news.
      autoDowngraded.value = null
    }
    applyTheme()
  }

  /**
   * The frame cap, from the settings page.
   *
   * Stored as a preference and pushed straight into the governor, which owns the actual interval — the
   * store never computes a budget of its own, so there is exactly one place where "how fast may we draw"
   * is decided.
   */
  function setFrameRate(next: unknown): void {
    if (!isFrameRateChoice(next)) return
    frameRate.value = next
    localStorage.setItem(FRAME_RATE_KEY, String(next))
    applyFrameRate(next)
    notify(`渲染帧率已设为${frameRateLabel(next, frameSnapshot().displayHz)}`, 'info')
  }

  /**
   * The load guard's callback — the only place an automatic level change happens.
   *
   * `down` steps one rung and stops at 节能 (a laptop must not silently lose every effect because one
   * second was slow); `up` steps one rung and stops at the user's own choice. Both are reported, because
   * a level that changes by itself with no explanation reads as a bug.
   */
  function handleLoad(action: LoadAction, stats: FrameStats, grade: LoadGrade): void {
    const from = animationLevel.value
    const next = action === 'down' ? downgrade(from) : upgrade(from, userLevel.value)
    if (next === from) return
    const frameMs = stats.p95Ms
    animationLevel.value = next
    localStorage.setItem(levelSlot(true), next)
    applyTheme()
    /*
     * `reason` comes from the governor rather than being rebuilt here: the numbers it quotes (p95 against
     * the budget) are the ones it actually decided on, and recomputing them here is how a message starts
     * disagreeing with the behaviour.
     */
    autoDowngraded.value = {
      from,
      to: next,
      frameMs,
      direction: action,
      grade,
      reason: frameSnapshot().reason,
    }
    notify(
      action === 'down'
        ? `已自动降到「${LEVELS[next].label}」动效：检测到帧耗时偏高（p95 ${Math.round(frameMs)}ms），设置页可改回`
        : `已自动恢复到「${LEVELS[next].label}」动效：帧率已稳定`, 
      'info',
    )
  }

  /**
   * Starts the frame governor. Called once from `initTheme`, i.e. before the first paint.
   *
   * The loop is started here rather than in a component on purpose: it must keep measuring even when no
   * visual is mounted (a level of 关闭, or the settings page with the lyrics page closed), otherwise the
   * guard's view of the machine is "whatever happened to be on screen".
   */
  function initFrames(): void {
    // `parseFrameRateChoice`, not `isFrameRateChoice`: the stored form is a string, and the raw test
    // rejects strings, so every numeric cap used to be thrown away here on the way back in.
    const stored = localStorage.getItem(FRAME_RATE_KEY)
    const parsed = parseFrameRateChoice(stored)
    const initial: FrameRateChoice = parsed ?? 'follow'
    frameRate.value = initial
    applyFrameRate(initial)
    installGovernor(handleLoad, () => userLevel.value)
    startFrames()
  }

  /** Playback state, pushed from the app shell: CSS slows the ambience when the music stops. */
  function setPlaying(next: boolean): void {
    if (playing.value === next) return
    playing.value = next
    document.documentElement.dataset.playing = next ? 'true' : 'false'
    /*
     * …and tell the frame governor, which is where the cost is.
     *
     * This is the one place the player state enters the visual engine, and it exists because a paused window
     * does not need the display's frame rate to show a still room: it drops to 60, and to 12 while it is not
     * focused. See `PAUSED_GATE_MS` / `BACKGROUND_GATE_MS` in `visual/budget.ts` for the numbers behind that.
     */
    setFrameActivity(next)
  }

  /*
   * The two remaining "the music drives the picture" cues live here rather than in a component, because both
   * are *signals* — a moment, not a state — and both have to respect the animation level: at 关闭/节能 they
   * must not fire at all, which is exactly what a CSS transition on a class would get wrong.
   *
   * They are deliberately DOM-only: no reactive state changes, so a volume drag or a track skip cannot
   * re-render the shell 60 times a second. The CSS reads the attributes and the custom properties.
   */
  let switchTimer = 0
  let volumeTimer = 0

  /*
   * The listening record and the hidden layer.
   *
   * Both live here rather than in App.vue because both outlive the shell in intent: the record is storage and
   * the aurora badge is a state that survives a restart, while the *triggers* (a track change, one second of
   * playback) arrive from the shell. The store decides what a trigger means; the shell only reports it.
   */
  let pendingSeconds = 0
  let companionTimer = 0

  function persistCompanion(): void {
    try {
      localStorage.setItem(COMPANION_KEY, JSON.stringify(companion.value))
    } catch {
      // A full or unavailable storage is not a reason to interrupt playback or the visuals.
    }
  }

  /**
   * Keeps the two time-based easter eggs current.
   *
   * The night aurora is a *badge* (once earned, kept — see `nightUnlockedAt`), the rainy window is a *moment*
   * (true only while the clock is inside the window). Reading the clock on every track change alone would
   * miss a user who plays one long album past ten o'clock, hence the slow timer — five minutes is far finer
   * than an hour boundary needs to be.
   */
  /** The last track this session's record counted, so a resume of the same song is not a second play. */
  let countedTrackId = ''

  function refreshEaster(): void {
    const root = document.documentElement
    const aura = easterAura({ streak: 0, now: new Date(), random: () => 1 })
    if (aura.window) root.dataset.easterWindow = 'true'
    else delete root.dataset.easterWindow
    if (companion.value.nightUnlockedAt) root.dataset.easterNight = 'true'
    else delete root.dataset.easterNight
  }

  function initCompanion(): void {
    try {
      companion.value = parseCompanion(localStorage.getItem(COMPANION_KEY))
    } catch {
      companion.value = { ...EMPTY_COMPANION }
    }
    // The stored badge is the durable half; the window is recomputed from the clock.
    companion.value = { ...companion.value, nightUnlockedAt: companion.value.nightUnlockedAt || localStorage.getItem(NIGHT_KEY) || '' }
    refreshEaster()
    window.clearInterval(companionTimer)
    companionTimer = window.setInterval(refreshEaster, 300_000)
  }

  /**
   * A track actually started.
   *
   * Counted here rather than where the queue is built: a queue of forty songs is one play, and the record is
   * meant to be "how much music have I listened to", not "how many rows are in my library".
   *
   * Deduplicated by id, because there are two ways a song starts — the current track changing, and playback
   * being resumed on the song that is already loaded — and the second one used to count for nothing. A user
   * who opens the app and presses play on the song it restored has absolutely started a song; so both call
   * sites report here and the id decides whether it is news.
   */
  function noteTrackStart(trackId = ''): void {
    if (!trackId || trackId === countedTrackId) return
    countedTrackId = trackId
    const now = new Date()
    streak.value = nextStreak(streak.value, true)
    companion.value = recordPlay(companion.value, now)
    const aura = easterAura({
      streak: streak.value,
      now,
      random: Math.random,
      lastSignalLostAt: lastSignalLostAt.value,
      nowMs: Date.now(),
    })
    if (aura.night && !companion.value.nightUnlockedAt) {
      companion.value = { ...companion.value, nightUnlockedAt: dateKey(now) }
      localStorage.setItem(NIGHT_KEY, companion.value.nightUnlockedAt)
      notify('Aurora Night：连听五首，极光为你亮起', 'success')
    }
    persistCompanion()
    refreshEaster()
    // The glitch is an *effect*, so a level that promises none must not produce one.
    if (aura.signalLost && LEVELS[animationLevel.value].heavy) triggerSignalLost()
  }

  /**
   * Half a second of static. `Aurora Signal Lost…` then back.
   *
   * Rare (see `SIGNAL_LOST_CHANCE`), cooled down, and short: the whole point is that a user who sees it
   * wonders whether the app glitched. Anything longer reads as a crash and anything more frequent reads as a
   * bug, which is the line between an easter egg and a defect.
   */
  function triggerSignalLost(): void {
    lastSignalLostAt.value = Date.now()
    signalLost.value = true
    window.setTimeout(() => {
      signalLost.value = false
    }, SIGNAL_LOST_MS)
  }

  /**
   * One second of playback, accumulated.
   *
   * Wall-clock rather than a sum of track durations: the record says how long someone *listened*, which is
   * what makes it a memory, and a skipped half of a song was never listening.
   */
  function tickListening(seconds = 1): void {
    companion.value = recordListening(companion.value, seconds)
    pendingSeconds += seconds
    // Flushed every twenty seconds: often enough to survive a crash, rare enough to be free.
    if (pendingSeconds >= 20) {
      pendingSeconds = 0
      persistCompanion()
    }
  }

  /** Flushes the last partial minute, called when the shell goes away. */
  function flushCompanion(): void {
    if (pendingSeconds > 0) {
      pendingSeconds = 0
      persistCompanion()
    }
  }

  const companionSummary = computed(() => ({
    plays: companion.value.plays,
    listened: formatCompanionTime(companion.value.seconds),
    since: companion.value.firstPlayedAt,
    night: companion.value.nightUnlockedAt,
  }))

  /** The last answer from the recommender, shown in the theme centre with its reason. */
  const recommendation = ref<Recommendation | null>(null)

  /**
   * Answers "which space does this track belong in?" — and never switches anything by itself.
   *
   * The caller passes the track because this store must not depend on the player store (the player already
   * depends on this one). An abstention (`null`) is reported as "nothing fits well enough", which is the
   * honest answer for most songs and keeps the button from being a random theme generator.
   */
  function recommendForTrack(track: {
    title?: string
    artist?: string
    genre?: string
    duration?: number
    accent?: string
  } | null): Recommendation | null {
    if (!track) {
      recommendation.value = null
      return null
    }
    const picked = recommendSkin(
      { title: track.title, artist: track.artist, genre: track.genre, duration: track.duration, accent: track.accent },
      recommendable(availableSkins.value),
    )
    recommendation.value = picked
    return picked
  }

  /**
   * The room changes when the song does.
   *
   * A theme is a space, and a space that swaps its artwork with no transition reads as a glitch rather than
   * as moving from one place to another — so switching tracks sweeps the theme's own veil across the window.
   */
  function signalTrackChange(): void {
    if (!LEVELS[animationLevel.value].heavy) return
    const root = document.documentElement
    // Restart the animation even when two skips land inside one sweep: without the reflow Chromium keeps
    // the old animation running and the second song changes with the same (already finished) gesture.
    delete root.dataset.scene
    void root.offsetWidth
    root.dataset.scene = 'switch'
    window.clearTimeout(switchTimer)
    switchTimer = window.setTimeout(() => {
      delete root.dataset.scene
    }, SWITCH_MS)
  }

  /**
   * Volume, as a light touch rather than a meter.
   *
   * `--volume-level` is the absolute position (so a rule can scale with loudness — the slider's own glow),
   * and `--volume-delta` says how much it just moved, which is what the bump is sized by. A drag fires this
   * continuously, so the timer only ever restarts: the bump follows the *last* movement and settles once the
   * user stops, instead of flickering on every input event.
   */
  function signalVolume(level: number, delta: number): void {
    const root = document.documentElement
    root.style.setProperty('--volume-level', String(Math.min(1, Math.max(0, level))))
    if (!LEVELS[animationLevel.value].heavy) return
    // A direction, not a magnitude: a small nudge and a big jump should read the same shape, only the size
    // differs. Turning it off and back on should not fire a bump each frame either — hence the threshold.
    root.style.setProperty('--volume-delta', String(Math.min(1, Math.abs(delta) * 4)))
    root.dataset.volume = delta > 0 ? 'up' : 'down'
    window.clearTimeout(volumeTimer)
    volumeTimer = window.setTimeout(() => {
      delete root.dataset.volume
      root.style.setProperty('--volume-delta', '0')
    }, VOLUME_MS)
  }

  function initTheme(): void {
    const stored = localStorage.getItem(THEME_KEY)
    theme.value = isThemeMode(stored) ? stored : 'dark'
    /*
     * The stored id is trusted as-is, even when it belongs to a user theme that has not been read off
     * disk yet — refusing it here would silently drop the user's choice on every launch, because the
     * themes folder is only scanned asynchronously below. Until that scan lands, `activeSkin` falls back
     * to the default for painting, and `loadUserThemes` resets the id only if it is *still* unknown.
     */
    skin.value = localStorage.getItem(SKIN_KEY) || DEFAULT_SKIN_ID
    /*
     * Migration from the previous on/off switch: "关闭" becomes the 关闭 level, and anything else keeps
     * the standard budget rather than jumping straight to the expensive one.
     *
     * The session downgrade is read here and immediately cleared, so it can never outlive the session
     * that measured the slow frames in the first place.
     */
    const resolved = resolveStoredLevel(
      localStorage.getItem(LEVEL_KEY),
      localStorage.getItem(AUTO_LEVEL_KEY),
      localStorage.getItem(LEGACY_EFFECTS_KEY) === '0',
    )
    localStorage.removeItem(AUTO_LEVEL_KEY)
    animationLevel.value = resolved.level
    // The ceiling is the *user's* choice, which `chosen` reports directly — never the session's automatic value.
    userLevel.value = resolved.chosen
    initFrames()
    const storedLyricColor = localStorage.getItem(LYRIC_COLOR_KEY)
    lyricColor.value = isLyricColorMode(storedLyricColor) ? storedLyricColor : 'auto'
    const storedLyricCustom = localStorage.getItem(LYRIC_CUSTOM_KEY)
    lyricCustomColor.value = isHexColor(storedLyricCustom) ? storedLyricCustom.toLowerCase() : '#ffffff'
    const storedVinyl = localStorage.getItem(VINYL_KEY)
    vinylMaterial.value = isVinylMaterial(storedVinyl) ? storedVinyl : 'black'
    document.documentElement.dataset.vinyl = vinylMaterial.value
    document.documentElement.dataset.playing = 'false'
    installSkins()
    applyTheme()
    applyLyricColor()
    void loadUserThemes()
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (theme.value === 'system') applyTheme()
    })
  }

  function notify(message: string, tone: Toast['tone'] = 'info'): void {
    const toast: Toast = { id: ++toastId, message, tone }
    toasts.value = [...toasts.value, toast]
    setTimeout(() => {
      toasts.value = toasts.value.filter((item) => item.id !== toast.id)
    }, 3600)
  }

  function dismissToast(id: number): void {
    toasts.value = toasts.value.filter((item) => item.id !== id)
  }

  function toggleQueue(): void {
    queueOpen.value = !queueOpen.value
  }

  /**
   * Immersive mode toggles real OS fullscreen as well as the chrome-free layout. Exiting with Esc
   * is handled by the browser, so a `fullscreenchange` listener keeps the flag truthful.
   */
  async function setImmersive(next: boolean): Promise<void> {
    immersive.value = next
    try {
      if (next && !document.fullscreenElement) await document.documentElement.requestFullscreen()
      else if (!next && document.fullscreenElement) await document.exitFullscreen()
    } catch {
      // Fullscreen needs a user gesture; the chrome-free layout still applies.
    }
  }

  function toggleImmersive(): void {
    void setImmersive(!immersive.value)
  }

  function initImmersiveSync(): void {
    if (fullscreenBound) return
    fullscreenBound = true
    document.addEventListener('fullscreenchange', () => {
      immersive.value = Boolean(document.fullscreenElement)
    })
  }

  return {
    theme,
    skin,
    userThemes,
    animationLevel,
    autoDowngraded,
    playing,
    effectPlan,
    availableSkins,
    activeSkin,
    setSkin,
    loadUserThemes,
    setAnimationLevel,
    frameRate,
    setFrameRate,
    frameInfo: frameSnapshot,
    initFrames,
    lyricColor,
    lyricCustomColor,
    vinylMaterial,
    setLyricColor,
    setVinylMaterial,
    setLyricCustomColor,
    setPlaying,
    signalTrackChange,
    signalVolume,
    startEnergy,
    searchQuery,
    queueOpen,
    toasts,
    immersive,
    nightPage,
    artworkAccent,
    shellStrip,
    shellBar,
    setNightPage,
    setArtworkAccent,
    sampleShell,
    initTheme,
    companionSummary,
    signalLost,
    recommendation,
    initCompanion,
    noteTrackStart,
    tickListening,
    flushCompanion,
    recommendForTrack,
    setTheme,
    notify,
    dismissToast,
    toggleQueue,
    setImmersive,
    toggleImmersive,
    initImmersiveSync,
  }
})
