/**
 * Smoke test for the sound pipeline's *decisions*, offline.
 *
 * The audio graph itself can only be judged in a running window (`npm run smoke:app` proves the engine
 * exists, that the EQ switch reaches it and that a device list comes back). What is testable here is
 * everything underneath, and it is where the expensive mistakes live:
 *
 *  - an EQ curve whose band count disagrees with the filter chain;
 *  - a loudness correction that lifts a quiet passage until it clips, or "normalises" silence to full scale;
 *  - a sleep timer that keeps counting down while the player is paused, or that survives a restart;
 *  - **main's sanitizer dropping the whole block** — the trap that ate `theme`, then `skin`, then
 *    `preferredQuality`, and would have eaten `sound` the same way.
 *
 * Run with: npm run smoke:audio
 */
import {
  CROSSFADE_MAX_SECONDS,
  DEFAULT_LOUDNESS_TARGET_DB,
  DEFAULT_SOUND,
  EQ_BAND_COUNT,
  EQ_BAND_FREQUENCIES,
  EQ_GAIN_LIMIT_DB,
  LOUDNESS_TARGETS_DB,
  clampCrossfadeSeconds,
  clampGainDb,
  clampPreampDb,
  formatCrossfade,
  isEqEffectivelyOff,
  loudnessTargetLabel,
  normalizeEqGains,
} from '../src/shared/sound'
import {
  CUSTOM_PRESET_LABEL,
  EQ_PRESETS,
  bandLabel,
  describeEqualizer,
  gainsForPreset,
  presetById,
  presetIdForGains,
  presetLabel,
  suggestedPreampDb,
} from '../src/renderer/src/audio/equalizer'
import {
  SILENCE_FLOOR_DB,
  dbToGain,
  gainDbFor,
  isUsableMeasurement,
  meanDb,
  rmsDb,
  smoothToward,
} from '../src/renderer/src/audio/loudness'
import { app } from 'electron'
import {
  SLEEP_OFF,
  SLEEP_PRESETS_MINUTES,
  describeSleep,
  formatCountdown,
  isExpired,
  remainingMs,
  shouldStopAtTrackEnd,
  sleepLabel,
  startSleepMinutes,
} from '../src/renderer/src/audio/sleep'

const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
const check = (name: string, ok: boolean, detail?: unknown): void => {
  checks.push({ name, ok, detail: detail === undefined ? undefined : String(detail) })
}

/* --------------------------------------------------------------- equalizer model */

check('预设与频段数量一致', EQ_PRESETS.every((preset) => preset.gains.length === EQ_BAND_COUNT), EQ_PRESETS.map((p) => p.gains.length).join(','))
check('每个预设都能被自己的增益识别回来', EQ_PRESETS.every((preset) => presetIdForGains(preset.gains) === preset.id))
check('移动一段就变成自定义', presetIdForGains([3, 0, 0, 0, 0, 0, 0, 0, 0, 0]) === 'custom')
check('0.15 dB 以内仍算属于该预设', presetIdForGains([0, 0, 0, 0, 0, 0, 0, 0, 0, 0.1]) === 'flat')
check('超出容差即自定义', presetIdForGains([0, 0, 0, 0, 0, 0, 0, 0, 0, 0.5]) === 'custom')
check('gainsForPreset 给的是副本而不是表本身', (() => {
  const first = gainsForPreset('bass')
  first[0] = 99
  return gainsForPreset('bass')[0] !== 99
})())
check('未知预设退回平直而不是抛错', presetById('nope').id === 'flat', presetById('nope').id)
check('自定义有名字', presetLabel('custom') === CUSTOM_PRESET_LABEL)
check('频段标签按量级切换单位', bandLabel(0) === '31 Hz' && bandLabel(9) === '16 kHz', `${bandLabel(0)} / ${bandLabel(9)}`)
check('频段表与常见 graphic EQ 布局一致', EQ_BAND_FREQUENCIES.length === EQ_BAND_COUNT && EQ_BAND_FREQUENCIES[5] === 1000)

check('前级建议等于最大抬升的反数', suggestedPreampDb([6, 3, 0, 0, 0, 0, 0, 0, 0, 0]) === -6, suggestedPreampDb([6, 3, 0, 0, 0, 0, 0, 0, 0, 0]))
check('没有抬升时前级建议为 0', suggestedPreampDb(gainsForPreset('flat')) === 0)
check('关闭时说明是直通', describeEqualizer({ enabled: false, preset: 'bass', gains: gainsForPreset('bass'), preampDb: 8 }).includes('关闭中'))
check('开启但全 0 时说明等于直通', isEqEffectivelyOff({ enabled: true, preset: 'flat', gains: gainsForPreset('flat'), preampDb: 0 }))
check('开启且有变化时不算直通', !isEqEffectivelyOff({ enabled: true, preset: 'bass', gains: gainsForPreset('bass'), preampDb: 0 }))

/* --------------------------------------------------------------- clamps (shared) */

check('单段增益被限幅到 ±12 dB', clampGainDb(40) === EQ_GAIN_LIMIT_DB && clampGainDb(-40) === -EQ_GAIN_LIMIT_DB)
check('非数字增益归零', clampGainDb('abc') === 0 && clampGainDb(Number.NaN) === 0)
check('增益保留一位小数（滑块步长的精度）', clampGainDb(3.17) === 3.2, clampGainDb(3.17))
check('过短的数组补齐、过长的数组截断', (() => {
  const short = normalizeEqGains([5])
  const long = normalizeEqGains(new Array(20).fill(1))
  return short.length === EQ_BAND_COUNT && short[0] === 5 && short[9] === 0 && long.length === EQ_BAND_COUNT
})())
check('前级也被限幅', clampPreampDb(99) === 12 && clampPreampDb(-99) === -12)
check('淡入淡出时长被限幅到 0..12 秒', clampCrossfadeSeconds(-3) === 0 && clampCrossfadeSeconds(30) === CROSSFADE_MAX_SECONDS)
check('淡入淡出读出来是关闭/秒', formatCrossfade(0) === '关闭' && formatCrossfade(4) === '4 秒', `${formatCrossfade(0)} / ${formatCrossfade(4)}`)
check('响度目标有对应的说法', LOUDNESS_TARGETS_DB.every((target) => loudnessTargetLabel(target).length > 0))
check('默认声音设置是「什么都不做」', !DEFAULT_SOUND.equalizer.enabled && !DEFAULT_SOUND.loudness.enabled && DEFAULT_SOUND.crossfadeSeconds === 0 && DEFAULT_SOUND.gapless)
check('默认目标是最常用的那一档', DEFAULT_SOUND.loudness.targetDb === DEFAULT_LOUDNESS_TARGET_DB)

/* --------------------------------------------------------------- loudness maths */

/** A sine of the given peak amplitude, as the analyser would hand it over. */
function tone(peak: number, length = 2048): Float32Array {
  const samples = new Float32Array(length)
  for (let index = 0; index < length; index += 1) samples[index] = peak * Math.sin((index / length) * Math.PI * 8)
  return samples
}

check('满量程正弦的 RMS 约 -3 dB', Math.abs(rmsDb(tone(1)) + 3.01) < 0.1, rmsDb(tone(1)).toFixed(2))
check('半幅正弦低约 6 dB', Math.abs(rmsDb(tone(0.5)) - rmsDb(tone(1)) + 6.02) < 0.15)
check('静音不会算出 -Infinity', rmsDb(new Float32Array(2048)) === SILENCE_FLOOR_DB, rmsDb(new Float32Array(2048)))
check('空缓冲也是静音而不是 NaN', rmsDb(new Float32Array(0)) === SILENCE_FLOOR_DB)

check('安静的材料被抬起来', (gainDbFor(-22, -14) ?? 0) > 7.5, gainDbFor(-22, -14))
check('过响的材料被压下去', (gainDbFor(-6, -14) ?? 0) < 0, gainDbFor(-6, -14))
check('修正量不会无限大（有限幅）', gainDbFor(-60, -14) === 12, gainDbFor(-60, -14))
check('静音不参与归一化', gainDbFor(SILENCE_FLOOR_DB, -14) === null && gainDbFor(null, -14) === null)
check('测量可用性判断与 dB 一致', isUsableMeasurement(-20) && !isUsableMeasurement(null) && !isUsableMeasurement(SILENCE_FLOOR_DB))

check('dB 折算成线性增益', Math.abs(dbToGain(6) - 1.995) < 0.01 && Math.abs(dbToGain(0) - 1) < 1e-9)
check('多段读数按功率平均而不是直接平均 dB', (() => {
  // -6 dB 与 -40 dB 按功率平均是 -9.0 dB；按 dB 直接平均会得到 -23 dB，那是把“安静的一段”当成
  // 与“大声的一段”同等权重——正是响度归一化里最容易压偏的地方。
  const mixed = meanDb([-6, -40])
  return Math.abs(mixed + 9.01) < 0.2
})(), meanDb([-6, -40]).toFixed(2))
check('安静但真实的一段仍参与平均', meanDb([-6, -40]) < -6 && meanDb([-6, -40]) > -12)
check('全静音的读数就是静音', meanDb([SILENCE_FLOOR_DB, SILENCE_FLOOR_DB]) === SILENCE_FLOOR_DB)
check('触及底噪的读数被排除，不拉低平均', Math.abs(meanDb([-6, -6, SILENCE_FLOOR_DB]) - meanDb([-6, -6])) < 1e-9)

check('增益平滑会收敛，且不会过冲', (() => {
  let value = 0
  for (let index = 0; index < 40; index += 1) value = smoothToward(value, 6, 0.25)
  return value === 6
})())
check('平滑一步不会跳到目标以上', smoothToward(0, 6, 0.25) < 6)

/* --------------------------------------------------------------- sleep timer */

const T0 = 1_700_000_000_000

check('设定后剩余时间就是设定值', remainingMs(startSleepMinutes(15, T0), T0) === 15 * 60_000)
check('倒计时会走', remainingMs(startSleepMinutes(15, T0), T0 + 60_000) === 14 * 60_000)
check('到点即到期', isExpired(startSleepMinutes(1, T0), T0 + 61_000))
check('未到点不算到期', !isExpired(startSleepMinutes(30, T0), T0 + 60_000))
check('到期不返回负数', remainingMs(startSleepMinutes(1, T0), T0 + 10_000_000) === 0)
check('非法分钟数被夹到 1..600', startSleepMinutes(0, T0).minutes === 1 && startSleepMinutes(9999, T0).minutes === 600)
check('关闭状态没有剩余时间', remainingMs(SLEEP_OFF, T0) === null && !isExpired(SLEEP_OFF, T0))

check('倒计时读成 mm:ss', formatCountdown(14 * 60_000 + 32_000) === '14:32', formatCountdown(14 * 60_000 + 32_000))
check('超过一小时读成 h:mm:ss', formatCountdown(3_900_000) === '1:05:00', formatCountdown(3_900_000))
check('负数读成 0:00 而不是 -1:-1', formatCountdown(-5) === '0:00')

check('按钮文案：倒计时', sleepLabel(startSleepMinutes(15, T0), T0 + 60_000) === '14:00', sleepLabel(startSleepMinutes(15, T0), T0 + 60_000))
check('按钮文案：本曲结束后', sleepLabel({ mode: 'track', deadline: 0, minutes: 0 }, T0) === '本曲结束后')
check('按钮文案：未设置时为空', sleepLabel(SLEEP_OFF, T0) === '')
check('通知文案随模式变化', describeSleep(SLEEP_OFF).includes('关闭') && describeSleep(startSleepMinutes(30, T0)).includes('30 分钟'))
check('只有「本曲结束后」会拦住下一首', shouldStopAtTrackEnd({ mode: 'track', deadline: 0, minutes: 0 }) && !shouldStopAtTrackEnd(startSleepMinutes(30, T0)) && !shouldStopAtTrackEnd(SLEEP_OFF))
check('预设有 15/30/45/60/90', SLEEP_PRESETS_MINUTES.join(',') === '15,30,45,60,90')

/* --------------------------------------------------------------- settings round trip */

/*
 * The sanitizer is the one place a hostile or hand-edited patch is stopped, so it gets the last word in
 * this suite: it is imported directly, which also proves main can import the shared sound module without
 * pulling in anything renderer-only.
 */
async function settingsChecks(): Promise<void> {
  const { defaultSettings, updateSettings } = await import('../src/main/settings')

  const defaults = defaultSettings()
  check('默认设置里带上了 sound 区块', Boolean(defaults.sound) && defaults.sound.equalizer.gains.length === EQ_BAND_COUNT)

  const written = await updateSettings({
    sound: {
      equalizer: { enabled: true, preset: 'bass', gains: [12, 12, 6, 0, 0, 0, 0, 0, 0, 0], preampDb: -6 },
      loudness: { enabled: true, targetDb: -18 },
      outputDeviceId: 'device-abc',
      gapless: false,
      crossfadeSeconds: 6,
    },
  })
  check('写的值真的存下来了', written.sound.equalizer.enabled && written.sound.equalizer.preset === 'bass' && written.sound.loudness.targetDb === -18)
  check('输出设备与衔接设置也存下来了', written.sound.outputDeviceId === 'device-abc' && written.sound.gapless === false && written.sound.crossfadeSeconds === 6)

  const clamped = await updateSettings({
    sound: {
      equalizer: { enabled: true, preset: 'rock', gains: [400, -400, 0, 0, 0, 0, 0, 0, 0, 0], preampDb: 90 },
      loudness: { enabled: true, targetDb: -3 as never },
      outputDeviceId: 'x'.repeat(500),
      gapless: true,
      crossfadeSeconds: 999,
    },
  })
  check('过大的增益被钳到 ±12 dB', clamped.sound.equalizer.gains[0] === 12 && clamped.sound.equalizer.gains[1] === -12, clamped.sound.equalizer.gains.slice(0, 2).join(','))
  check('过大的前级被钳', clamped.sound.equalizer.preampDb === 12, clamped.sound.equalizer.preampDb)
  // Same rule as the preset: an illegal value is *rejected*, and what was stored before survives. The
  // shipped default is checked against `DEFAULT_SOUND` above; this is about not letting a bad patch win.
  check('非法响度目标被拒绝（保留旧值）', clamped.sound.loudness.targetDb === -18, clamped.sound.loudness.targetDb)
  check('默认响度目标就是共享常量', DEFAULT_SOUND.loudness.targetDb === DEFAULT_LOUDNESS_TARGET_DB)
  check('过长的设备 id 被截断', clamped.sound.outputDeviceId.length === 200, clamped.sound.outputDeviceId.length)
  check('过长的淡入淡出被钳到上限', clamped.sound.crossfadeSeconds === CROSSFADE_MAX_SECONDS)

  const partial = await updateSettings({ sound: { crossfadeSeconds: 3 } })
  check('只发一个字段不会抹掉其它字段', partial.sound.equalizer.enabled === true && partial.sound.equalizer.preset === 'rock' && partial.sound.crossfadeSeconds === 3)

  const bogusPreset = await updateSettings({ sound: { equalizer: { preset: 'NOT A PRESET' } } })
  check('非法预设名被拒绝（保留旧值）', bogusPreset.sound.equalizer.preset === 'rock', bogusPreset.sound.equalizer.preset)

  // Restore the shipped defaults: this suite runs against the real user-data directory, and leaving the
  // EQ armed at +12 dB would be a very audible test artefact.
  await updateSettings({ sound: structuredClone(DEFAULT_SOUND) })
  const restored = defaultSettings()
  check('套件结束后声音设置回到默认', !restored.sound.equalizer.enabled && restored.sound.crossfadeSeconds === 0)
}

await settingsChecks()

/* --------------------------------------------------------------- report */

let failed = 0
for (const item of checks) {
  if (!item.ok) failed += 1
  const detail = item.detail === undefined ? '' : `  ${item.detail}`
  console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${detail}`)
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`)
/*
 * Explicit exit: this suite runs inside a real Electron main process (it imports `main/settings`), and an
 * Electron app with no windows never exits on its own — the first version relied on `process.exitCode`
 * and hung the run for three minutes.
 */
app.exit(failed === 0 ? 0 : 1)
