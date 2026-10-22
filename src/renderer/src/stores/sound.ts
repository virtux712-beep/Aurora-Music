/**
 * The sound settings store: the single writer for everything in the `sound` block, and the bridge
 * between the settings file, the engine, and the UI.
 *
 * It exists because those three have to agree *at every moment*, and there are four ways they can
 * drift: a preset click, a hand-moved slider, a device change that fails, and a settings file that was
 * edited outside the app. Every one of them goes through `commit` here:
 *
 *   1. merge the change into local state,
 *   2. push it into the audio engine (which is what the listener actually hears),
 *   3. persist it through the main process (which clamps it again — main never trusts a renderer),
 *   4. replace local state with what main stored, so a clamped value is what the UI shows.
 *
 * Step 4 is the one that makes this honest: if main clamps `+40 dB` to `+12 dB`, the slider must read
 * +12, not the number that was typed.
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { DEFAULT_SOUND, type LoudnessSettings, type SoundSettings, type EqualizerSettings } from '../../../shared/sound'
import { settingsService } from '../services/aurora'
import {
  applyEqualizer,
  ensureGraph,
  listOutputDevices,
  setOutputDevice,
  snapshot as engineSnapshot,
  type AudioEngineSnapshot,
  type OutputDevice,
} from '../audio/engine'
import { gainsForPreset, presetIdForGains, suggestedPreampDb } from '../audio/equalizer'
import { clearMeasurements, type LoudnessState } from '../audio/loudness'

export const useSoundStore = defineStore('sound', () => {
  const settings = ref<SoundSettings>(structuredClone(DEFAULT_SOUND))
  const devices = ref<OutputDevice[]>([{ deviceId: '', label: '系统默认输出', isDefault: true }])
  const deviceMessage = ref('')
  const outputBusy = ref(false)
  const engine = ref<AudioEngineSnapshot>(engineSnapshot())
  /** The busiest change in flight wins; a second click must not interleave two writes. */
  let pending: Promise<void> = Promise.resolve()

  const equalizer = computed(() => settings.value.equalizer)
  const loudness = computed(() => settings.value.loudness)
  // Exposed flat as well as inside `settings`: the playback path reads these two on every track end,
  // and `sound.gapless` reads better at the call site than `sound.settings.gapless`.
  const gapless = computed(() => settings.value.gapless)
  const crossfadeSeconds = computed(() => settings.value.crossfadeSeconds)

  const eqSummary = computed(() => {
    const eq = settings.value.equalizer
    if (!eq.enabled) return '关闭中：音频不经过任何滤波'
    const peak = eq.gains.reduce((best, gain) => (Math.abs(gain) > Math.abs(best) ? gain : best), 0)
    const flat = peak === 0 && eq.preampDb === 0
    return flat ? '已开启，但各段都是 0 dB（等于直通）' : `已开启 · 最大调整 ${peak > 0 ? '+' : ''}${peak} dB`
  })

  /*
   * What the loudness meter last saw, pushed here by the player (which owns the analyser loop).
   *
   * The settings page must be able to say *why* a track sounds level with the last one — a target with
   * no measurement behind it would read as "normalisation on" while nothing had been normalised yet.
   */
  const measurement = ref<{ db: number | null; source: 'tag' | 'measured' | 'none'; trackTitle: string }>({
    db: null,
    source: 'none',
    trackTitle: '',
  })

  /** The gain the *audible* deck is carrying: during a crossfade, the louder of the two. */
  const audibleLoudnessDb = computed(() => {
    const [a, b] = engine.value.loudnessGainDb
    const [fa, fb] = engine.value.fade
    if (fa === 0 && fb === 0) return a
    return fa >= fb ? a : b
  })

  const loudnessSummary = computed(() => {
    if (!settings.value.loudness.enabled) return '关闭中：按文件原样播放'
    if (measurement.value.source === 'none') return `目标 ${settings.value.loudness.targetDb} dB · 还没测到可用的响度`
    const applied = audibleLoudnessDb.value
    const sign = applied > 0 ? '+' : ''
    const origin = measurement.value.source === 'tag' ? '文件标签' : '实测'
    const measured = measurement.value.db === null ? '—' : `${measurement.value.db.toFixed(1)} dB`
    return `目标 ${settings.value.loudness.targetDb} dB · ${origin} ${measured} → ${sign}${applied.toFixed(1)} dB`
  })

  function noteMeasurement(db: number | null, source: 'tag' | 'measured' | 'none', trackTitle: string): void {
    measurement.value = { db, source, trackTitle }
    refreshEngineState()
  }

  const outputSummary = computed(() => {
    const current = settings.value.outputDeviceId
    if (!current) return '系统默认输出'
    return devices.value.find((device) => device.deviceId === current)?.label ?? '已选设备（当前不可见）'
  })

  /** Reads the stored block and pushes it into the engine — called once at startup. */
  async function load(): Promise<void> {
    const stored = await settingsService.get()
    settings.value = structuredClone(stored.sound ?? DEFAULT_SOUND)
    applyEqualizer(settings.value.equalizer)
    refreshEngineState()
    if (settings.value.outputDeviceId) await chooseOutputDevice(settings.value.outputDeviceId, { quiet: true })
    await refreshDevices()
  }

  function refreshEngineState(): void {
    engine.value = engineSnapshot()
  }

  /**
   * Writes a partial `sound` block through to main and adopts what came back.
   *
   * `patch` is merged into the *current* value here and re-clamped by main, so a UI that sends only
   * `equalizer.gains` never wipes the loudness block — a field the user did not touch must survive a
   * patch about a different field.
   */
  function commit(patch: Partial<SoundSettings>): Promise<void> {
    pending = pending
      .then(async () => {
        const merged: Partial<SoundSettings> = {
          equalizer: { ...settings.value.equalizer, ...(patch.equalizer ?? {}) },
          loudness: { ...settings.value.loudness, ...(patch.loudness ?? {}) },
          outputDeviceId: patch.outputDeviceId ?? settings.value.outputDeviceId,
          gapless: patch.gapless ?? settings.value.gapless,
          crossfadeSeconds: patch.crossfadeSeconds ?? settings.value.crossfadeSeconds,
        }
        /*
         * Arming anything that needs the audio graph requests it here, from a click handler.
         *
         * Without this the EQ could be switched on during a song and change nothing until the next
         * track: the graph is only *created* on a gesture, and no `play` event was coming. The engine
         * replays the settings it was given onto the filters it just built, so this ordering works.
         */
        if ((merged.equalizer as EqualizerSettings).enabled || merged.loudness?.enabled || (merged.crossfadeSeconds ?? 0) > 0) {
          void ensureGraph(true)
        }
        // Applied before persisting: the sound must change the moment the switch moves, and a failed
        // write must not leave the app silent-but-set.
        applyEqualizer(merged.equalizer as EqualizerSettings)
        const next = await settingsService.set({ sound: merged })
        settings.value = structuredClone(next.sound ?? DEFAULT_SOUND)
        refreshEngineState()
      })
      .catch(() => {
        // A storage failure leaves the in-memory value in force; the engine already has it.
      })
    return pending
  }

  function setEqualizerEnabled(enabled: boolean): Promise<void> {
    return commit({ equalizer: { ...settings.value.equalizer, enabled } })
  }

  function setEqualizerPreset(id: string): Promise<void> {
    const gains = gainsForPreset(id)
    return commit({ equalizer: { ...settings.value.equalizer, preset: id, gains } })
  }

  function setEqBand(index: number, db: number): Promise<void> {
    const gains = [...settings.value.equalizer.gains]
    gains[index] = db
    // A curve that matches a preset exactly is that preset again (drag a slider back to 0 and 「平直」
    // lights up); anything else is custom. Deriving it beats remembering it.
    return commit({ equalizer: { ...settings.value.equalizer, gains, preset: presetIdForGains(gains) } })
  }

  function setPreamp(db: number): Promise<void> {
    return commit({ equalizer: { ...settings.value.equalizer, preampDb: db } })
  }

  function setGains(gains: number[]): Promise<void> {
    return commit({ equalizer: { ...settings.value.equalizer, gains, preset: presetIdForGains(gains) } })
  }

  function applySuggestedPreamp(): Promise<void> {
    return setPreamp(suggestedPreampDb(settings.value.equalizer.gains))
  }

  function resetEqualizer(): Promise<void> {
    return commit({
      equalizer: { ...settings.value.equalizer, preset: 'flat', gains: gainsForPreset('flat'), preampDb: 0 },
    })
  }

  function setLoudnessEnabled(enabled: boolean): Promise<void> {
    return commit({ loudness: { ...settings.value.loudness, enabled } })
  }

  function setLoudnessTarget(targetDb: number): Promise<void> {
    return commit({ loudness: { ...settings.value.loudness, targetDb } })
  }

  function forgetLoudnessMeasurements(): void {
    clearMeasurements()
  }

  function setGapless(gapless: boolean): Promise<void> {
    return commit({ gapless })
  }

  function setCrossfade(seconds: number): Promise<void> {
    return commit({ crossfadeSeconds: seconds })
  }

  async function refreshDevices(): Promise<void> {
    devices.value = await listOutputDevices()
  }

  /**
   * Routes output to `deviceId` and reports *what actually happened*.
   *
   * The engine distinguishes "routed" from "this runtime cannot" and from "the device refused", and
   * those three must not look the same in the UI: a device picker that silently keeps playing through
   * the speakers is worse than no picker.
   */
  async function chooseOutputDevice(deviceId: string, options: { quiet?: boolean } = {}): Promise<void> {
    outputBusy.value = true
    try {
      const result = await setOutputDevice(deviceId)
      refreshEngineState()
      if (result.applied) {
        deviceMessage.value = result.via === 'context' ? '' : '已切换到所选设备（在音频图建立前由音频元素直接输出）'
        if (!options.quiet) await commit({ outputDeviceId: deviceId })
        else settings.value.outputDeviceId = deviceId
        return
      }
      deviceMessage.value = result.reason ?? '切换输出设备失败'
      if (!options.quiet) return
      // A stored device that this machine no longer has must not be reported as the current one.
      settings.value.outputDeviceId = ''
    } finally {
      outputBusy.value = false
    }
  }

  function loudnessState(measuredDb: number | null, source: LoudnessState['source']): LoudnessState {
    return {
      enabled: settings.value.loudness.enabled,
      targetDb: settings.value.loudness.targetDb,
      appliedDb: audibleLoudnessDb.value,
      measuredDb,
      source,
    }
  }

  return {
    settings,
    equalizer,
    loudness,
    gapless,
    crossfadeSeconds,
    devices,
    deviceMessage,
    outputBusy,
    engine,
    measurement,
    audibleLoudnessDb,
    noteMeasurement,
    eqSummary,
    loudnessSummary,
    outputSummary,
    load,
    commit,
    refreshEngineState,
    setEqualizerEnabled,
    setEqualizerPreset,
    setEqBand,
    setGains,
    setPreamp,
    applySuggestedPreamp,
    resetEqualizer,
    setLoudnessEnabled,
    setLoudnessTarget,
    forgetLoudnessMeasurements,
    setGapless,
    setCrossfade,
    refreshDevices,
    chooseOutputDevice,
    loudnessState,
  }
})
