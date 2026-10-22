<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type {
  AppInfo,
  BackupPickResult,
  CacheArea,
  CacheReport,
  DatabaseStats,
  DiagnosticsReport,
  HttpApiStatus,
  PlayMode,
  ThemeMode,
  UpdateCheckResult,
} from '../../../shared/types'
import { PLAY_MODE_LABELS, usePlayerStore } from '../stores/player'
import { useSoundStore } from '../stores/sound'
import { useLyricsStore } from '../stores/lyrics'
import { LYRICS_OFFSET_LIMIT_MS, formatLyricsOffset } from '../../../shared/lyrics'
import { EQ_PRESETS, bandLabel, presetLabel, suggestedPreampDb } from '../audio/equalizer'
import {
  CROSSFADE_MAX_SECONDS,
  EQ_BAND_COUNT,
  EQ_GAIN_LIMIT_DB,
  LOUDNESS_TARGETS_DB,
  formatCrossfade,
  loudnessTargetLabel,
} from '../../../shared/sound'
import { useLibraryStore } from '../stores/library'
import { usePlatformStore } from '../stores/platform'
import { useSourceStore } from '../stores/source'
import { useCollectionStore } from '../stores/collection'
import { usePlaylistStore } from '../stores/playlists'
import { LYRIC_COLOR_OPTIONS, useUiStore } from '../stores/ui'
import { useTrackActions } from '../composables/useTrackActions'
import { appService, desktopLyricsService, settingsService, systemIntegrationService, themesService } from '../services/aurora'
import { swatchOf } from '../theme/apply'
import { LEVEL_ORDER, LEVELS } from '../theme/effects'
import {
  FRAME_RATE_MAX,
  FRAME_RATE_MIN,
  FRAME_RATE_OPTIONS,
  clampFrameRate,
  frameRateLabel,
  parseFrameRateInput,
  type FrameRateChoice,
} from '../visual/budget'
import type { FrameSnapshot } from '../visual/frame'
import { formatCount, formatTime } from '../utils/format'
import { DEFAULT_DESKTOP_LYRICS, DEFAULT_SYSTEM_INTEGRATION } from '../../../shared/types'
import type { DesktopLyricsSettings, SystemIntegrationSettings, SystemIntegrationStatus } from '../../../shared/types'


const player = usePlayerStore()
const sound = useSoundStore()
const lyrics = useLyricsStore()
const library = useLibraryStore()
const collection = useCollectionStore()
const playlists = usePlaylistStore()
const ui = useUiStore()
const platformStore = usePlatformStore()
const { playShuffled } = useTrackActions()

const sourceStore = useSourceStore()
const info = ref<AppInfo | null>(null)
const clearing = ref(false)

/* ------------------------------------------------------------------ 缓存与数据 (B4 / B5 / C1) */

/*
 * Nothing on this page is a local estimate: the byte counts come from the same walk in the main
 * process that does the deleting, the database engine is the one that actually opened, and a restore
 * reports the counts it read out of the file before anything is applied.
 */
const cacheReport = ref<CacheReport | null>(null)
const cacheBusy = ref(false)
const backupBusy = ref(false)
const backupPreview = ref<BackupPickResult | null>(null)
const dbStats = ref<DatabaseStats | null>(null)

const dbEngineLabel = computed(() => {
  if (!dbStats.value) return '读取中…'
  return dbStats.value.engine === 'sqlite'
    ? `SQLite · ${dbStats.value.tracks} 首曲目`
    : 'JSON 回退存储（SQLite 驱动未加载）'
})

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

async function refreshStorage(): Promise<void> {
  cacheBusy.value = true
  try {
    cacheReport.value = await window.aurora.cache.report()
    dbStats.value = await window.aurora.database.stats()
  } finally {
    cacheBusy.value = false
  }
}

async function clearCacheArea(area: CacheArea): Promise<void> {
  cacheBusy.value = true
  try {
    const result = await window.aurora.cache.clear([area.id])
    cacheReport.value = result.report
    ui.notify(
      result.freedFiles > 0
        ? `已清理${area.label}：删除 ${result.freedFiles} 个文件，释放 ${formatBytes(result.freedBytes)}`
        : `${area.label}本来就是空的，没有可清理的内容`,
      result.freedFiles > 0 ? 'success' : 'info',
    )
  } finally {
    cacheBusy.value = false
  }
}

async function clearEveryCache(): Promise<void> {
  cacheBusy.value = true
  try {
    const result = await window.aurora.cache.clear()
    cacheReport.value = result.report
    ui.notify(`已清理全部缓存：${result.freedFiles} 个文件，释放 ${formatBytes(result.freedBytes)}`, 'success')
  } finally {
    cacheBusy.value = false
  }
}

async function exportBackupFile(): Promise<void> {
  backupBusy.value = true
  try {
    const result = await window.aurora.backup.export({
      favorites: collection.favoriteIds,
      history: collection.history.map((entry) => ({ id: entry.id, playedAt: entry.playedAt, playCount: entry.playCount })),
      playlists: playlists.playlists.map((item) => ({ ...item })),
      lyricColor: ui.lyricColor,
      lyricColorCustom: ui.lyricCustomColor,
    })
    if (result.canceled) return
    ui.notify(`备份已导出：${formatBytes(result.bytes)}（收藏 ${result.counts.favorites} · 历史 ${result.counts.history} · 歌单 ${result.counts.playlists}）`, 'success')
  } catch (error) {
    ui.notify(error instanceof Error ? error.message : '导出失败', 'error')
  } finally {
    backupBusy.value = false
  }
}

/** Step one of a restore: validate and show what is inside, before touching anything. */
async function pickBackupFile(): Promise<void> {
  backupBusy.value = true
  try {
    const picked = await window.aurora.backup.pick()
    if (picked.canceled) return
    backupPreview.value = picked
    if (picked.error) ui.notify(picked.error, 'error')
  } finally {
    backupBusy.value = false
  }
}

/**
 * Step two.
 *
 * The renderer snapshots its own stores first: if applying the backup throws half way, the stores are
 * put back and main is told to revert the settings, so a failed restore leaves no partial state behind.
 */
async function applyBackupFile(): Promise<void> {
  const picked = backupPreview.value
  if (!picked || picked.error) return
  backupBusy.value = true
  const snapshot = {
    favorites: [...collection.favoriteIds],
    history: collection.history.map((entry) => ({ ...entry })),
    playlists: playlists.playlists.map((item) => ({ ...item, trackIds: [...item.trackIds] })),
  }
  try {
    const applied = await window.aurora.backup.apply()
    if (!applied.applied || !applied.data) {
      ui.notify(applied.warnings[0] ?? '备份没有应用', 'error')
      return
    }
    collection.replaceAll(applied.data.favorites, applied.data.history)
    playlists.replaceAll(applied.data.playlists)
    if (applied.data.lyricColor) {
      ui.setLyricColor(applied.data.lyricColor as typeof ui.lyricColor)
      if (applied.data.lyricColorCustom) ui.setLyricCustomColor(applied.data.lyricColorCustom)
    }
    await window.aurora.backup.commit()
    await Promise.all([library.load(), refreshStorage()])
    backupPreview.value = null
    ui.notify(
      `已恢复：收藏 ${applied.data.favorites.length} · 历史 ${applied.data.history.length} · 歌单 ${applied.data.playlists.length}`,
      'success',
    )
  } catch (error) {
    collection.replaceAll(snapshot.favorites, snapshot.history)
    playlists.replaceAll(snapshot.playlists)
    await window.aurora.backup.revert()
    ui.notify(`恢复失败，已回滚到导入前的数据：${error instanceof Error ? error.message : '未知错误'}`, 'error')
  } finally {
    backupBusy.value = false
  }
}

/* ------------------------------------------------------------------ 诊断与更新 (C2 / C3 / C4) */

const diagnostics = ref<DiagnosticsReport | null>(null)
const updateResult = ref<UpdateCheckResult | null>(null)
const updateFeed = ref('')
const updateAuto = ref(false)
const updateBusy = ref(false)
const httpStatus = ref<HttpApiStatus | null>(null)
const httpPort = ref(47821)
const httpBusy = ref(false)

async function refreshDiagnostics(): Promise<void> {
  diagnostics.value = await window.aurora.diagnostics.report()
}

/** Clear, then re-read: the row shows what is left, not what was asked for. */
async function refreshDiagnosticsAfterClear(): Promise<void> {
  diagnostics.value = await window.aurora.diagnostics.clear()
  ui.notify('崩溃日志已清空', 'info')
}

async function exportDiagnosticsFile(): Promise<void> {
  const result = await window.aurora.diagnostics.export()
  if (result.canceled) return
  ui.notify(`诊断日志已导出：${formatBytes(result.bytes)}`, 'success')
}

async function revealDiagnostics(): Promise<void> {
  await window.aurora.diagnostics.reveal()
}

async function refreshUpdateSettings(): Promise<void> {
  const settings = await settingsService.get()
  updateFeed.value = settings.updateCheck.feedUrl
  updateAuto.value = settings.updateCheck.autoCheck
  httpPort.value = settings.httpApi.port
  httpStatus.value = await window.aurora.httpApi.status()
}

async function runUpdateCheck(): Promise<void> {
  updateBusy.value = true
  try {
    await settingsService.set({ updateCheck: { feedUrl: updateFeed.value, autoCheck: updateAuto.value } })
    updateResult.value = await window.aurora.updates.check(true)
  } finally {
    updateBusy.value = false
  }
}

async function patchHttpApi(patch: { enabled?: boolean; port?: number }): Promise<void> {
  httpBusy.value = true
  try {
    if (patch.port !== undefined) await settingsService.set({ httpApi: { port: patch.port } })
    httpStatus.value = await window.aurora.httpApi.set(patch)
    if (patch.enabled !== undefined) ui.notify(patch.enabled ? '本地 API 已启动' : '本地 API 已关闭', 'info')
  } finally {
    httpBusy.value = false
  }
}

async function copyHttpToken(): Promise<void> {
  const token = (await settingsService.get()).httpApi.token
  if (!token) return
  try {
    await navigator.clipboard.writeText(token)
    ui.notify('token 已复制', 'success')
  } catch {
    ui.notify('复制失败，可手动选中 token', 'error')
  }
}

/** `+3 dB` / `-1.5 dB` — a gain with its sign, so a row reads as a setting rather than a number. */
function signed(value: number): string {
  const rounded = Math.round(value * 10) / 10
  return `${rounded > 0 ? '+' : ''}${rounded} dB`
}

/** What the highlighted preset means, or the explanation for a hand-made curve. */
const presetHint = computed(() => {
  const preset = EQ_PRESETS.find((item) => item.id === sound.equalizer.preset)
  if (!preset) return '自定义曲线：与任何预设都不一致，移动滑块时就会变成自定义。'
  return `${preset.label}：${preset.hint}。移动任意一段后就会变成自定义。`
})

async function refreshDevices(): Promise<void> {
  await sound.refreshDevices()
  ui.notify(`已扫描到 ${sound.devices.length} 个输出设备`, 'info')
}

/** The lyric-colour row's own explanation: which mode is active, and what it does *not* touch. */
/**
 * What the offset currently means, spelled out.
 *
 * The sign is the part people get wrong (does "early" mean the lyrics move up or the music?), so the hint
 * states the effect rather than the arithmetic.
 */
const lyricOffsetHint = computed(() => {
  const value = lyrics.offsetMs
  if (!value) return '歌词与音乐同步；确认歌词偏早/偏晚时用下面两枚按钮（每步 100 ms）'
  return value < 0
    ? `歌词提前 ${Math.abs(value)} ms：歌词会比音乐早一点出现`
    : `歌词延后 ${value} ms：歌词会比音乐晚一点出现`
})

const lyricColorHint = computed(() => {
  const active = LYRIC_COLOR_OPTIONS.find((option) => option.mode === ui.lyricColor)
  return `${active?.label ?? '自动'}：${active?.hint ?? ''}（只影响歌词显示，不影响歌曲与歌词数据）`
})

/**
 * 自动补齐信息 now lives here (it moved off the library page). It reports the *real* report — a pass
 * that matched nothing says exactly that, and a pass already running is refused rather than queued.
 */
async function scrapeLibrary(): Promise<void> {
  const report = await library.scrape()
  if (!report) {
    ui.notify('已有一次补齐正在进行', 'info')
    return
  }
  if (report.scanned === 0) {
    ui.notify('没有需要补齐的本地歌曲', 'info')
    return
  }
  ui.notify(
    `补齐完成：扫描 ${report.scanned} 首，命中 ${report.matched} 首，封面 ${report.covers}，歌词 ${report.lyrics}`,
    report.matched > 0 ? 'success' : 'info',
  )
}

/** The button reports what was actually found on this machine, not a cached "available". */
async function checkFfmpeg(): Promise<void> {
  const status = await library.refreshFfmpeg(true)
  ui.notify(status.available ? '已检测到 ffmpeg' : '未检测到 ffmpeg（可用环境变量 AURORA_FFMPEG_PATH 指定路径）', status.available ? 'success' : 'info')
}

const themes: Array<{ value: ThemeMode; label: string }> = [
  { value: 'dark', label: '深色' },
  { value: 'light', label: '浅色' },
  { value: 'system', label: '跟随系统' },
]

/* --------------------------------------------------------------- 主题中心 */

/** The mode the page is *actually* painted in — what a skin preview has to be drawn against. */
const resolvedMode = computed<'dark' | 'light'>(() =>
  ui.theme === 'system'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light'
    : ui.theme,
)

/** Three real colours from the skin's own token set, so the card cannot lie about the theme. */
function preview(skinId: string): string[] {
  const theme = ui.availableSkins.find((item) => item.id === skinId)
  return theme ? swatchOf(theme, resolvedMode.value) : ['#101018', '#8ea2ff', '#ffffff']
}

/** User themes that failed to load, so the panel can say why instead of silently showing nothing. */
const brokenThemes = computed(() => ui.userThemes.filter((record) => !record.ok))
const userSkinCount = computed(() => ui.userThemes.filter((record) => record.ok).length)

/**
 * What the current theme + level actually produce, in numbers.
 *
 * Read from the applied plan rather than recomputed, so the line cannot disagree with what the page is
 * doing; when the level is 关闭 it says so instead of showing zeroes that look like a bug.
 */
const effectSummary = computed(() => {
  const plan = ui.effectPlan
  if (!plan || ui.animationLevel === 'off') return '已关闭：不绘制粒子、动态背景与联动'
  const names: Record<string, string> = {
    stars: '星尘',
    leaves: '落叶',
    mist: '晨雾',
    rain: '雨丝',
    dust: '胶片颗粒',
    none: '无粒子',
  }
  const recipes: Record<string, string> = {
    nebula: '星云',
    paper: '纸纹',
    tide: '潮汐',
    wash: '水墨',
    sunset: '落日',
    plain: '素面',
  }
  const particle = names[plan.ambient.particles] ?? plan.ambient.particles
  return `${ui.activeSkin.name} · ${particle}（密度 ${plan.ambient.density.toFixed(3)}）· 背景「${recipes[plan.background.kind] ?? plan.background.kind}」· 音乐联动 ${Math.round(plan.ambient.react * 100)}%`
})

/**
 * The governor's own report, sampled once a second while this page is open.
 *
 * The measurement lives in a render loop that must not be reactive, so the page polls it instead of
 * putting 60 Hz frame data into the render graph — 1 s of freshness is far more than a human needs to
 * judge "is this smooth", and it costs nothing.
 *
 * It reports p95 rather than a mean: the worth-knowing number is the stutter the user can feel, and an
 * average of 16 ms with every twentieth frame at 60 ms is a picture that visibly hitches.
 */
const frameSample = ref<FrameSnapshot | null>(null)
const frameText = computed(() => {
  const info = frameSample.value
  if (!info || info.stats.samples === 0) return '帧耗时测量中'
  if (!info.visible) return '窗口不可见，暂停测量'
  const measured = info.stats.p95Ms
  return `${measured.toFixed(1)}ms/帧(p95) · 屏幕 ${info.displayHz ?? '?'}Hz · 实绘 ${Math.round(info.drawFps)}fps`
})

/** The frame cap, as a segmented control. `follow` is the display, so it needs no number of its own. */
const frameRateOptions: Array<{ value: FrameRateChoice; label: string }> = FRAME_RATE_OPTIONS.map((value) => ({
  value,
  label: value === 'follow' ? '跟随' : String(value),
}))

/*
 * The custom cap.
 *
 * A preset list can only ever hold the rates somebody thought of; the field exists because panels,
 * docks and virtual displays report plenty of others (75, 100, 165, 240) and because "30 or 60" is not
 * a real choice on a 165 Hz laptop. `FRAME_RATE_OPTIONS` stays a list of *shortcuts*, so the preset
 * buttons and this field write the same kind of value and the governor needs no new concept.
 */
const customRateOpen = ref(false)
const customRateText = ref('')
const customRateError = ref('')
const customRateActive = computed(
  () => typeof ui.frameRate === 'number' && !FRAME_RATE_OPTIONS.includes(ui.frameRate),
)

function openCustomRate(): void {
  customRateOpen.value = true
  customRateError.value = ''
  // Prefill with what is actually in force, so opening the field is not a blank page.
  const current = typeof ui.frameRate === 'number' ? ui.frameRate : frameSample.value?.displayHz ?? 60
  customRateText.value = String(clampFrameRate(current))
}

function applyCustomRate(): void {
  const value = parseFrameRateInput(customRateText.value)
  if (value === null) {
    customRateError.value = `请输入 ${FRAME_RATE_MIN}–${FRAME_RATE_MAX} 之间的整数`
    return
  }
  customRateError.value = ''
  ui.setFrameRate(value)
}
const frameRateHint = computed(() =>
  `${frameRateLabel(ui.frameRate, frameSample.value?.displayHz ?? null)}：限制粒子、频谱与唱盘的绘制帧率；歌词滚动与文字填充始终跟手`,
)

function pickSkin(id: string): void {
  const theme = ui.availableSkins.find((item) => item.id === id)
  const switched = ui.setSkin(id)
  ui.notify(switched ? `已切换到「${theme?.name ?? id}」，并随之切到${switched}` : `已切换到「${theme?.name ?? id}」`, 'success')
}

/** Import copies the file into the themes folder after validating it; the reason is reported either way. */
async function importTheme(): Promise<void> {
  const record = await themesService.import()
  if (!record) return
  await ui.loadUserThemes()
  if (!record.ok) {
    ui.notify(`主题不可用：${record.error ?? '未知原因'}`, 'error')
    return
  }
  ui.notify(`已导入主题「${record.name}」`, 'success')
}

async function refreshThemes(): Promise<void> {
  const list = await ui.loadUserThemes()
  const usable = list.filter((record) => record.ok).length
  ui.notify(`主题目录共 ${list.length} 个文件，可用 ${usable} 个`, usable > 0 ? 'success' : 'info')
}

async function removeTheme(id: string, name: string): Promise<void> {
  await themesService.remove(id)
  await ui.loadUserThemes()
  ui.notify(`已删除主题「${name}」`, 'info')
}

async function revealThemes(): Promise<void> {
  const directory = await themesService.reveal()
  if (directory) ui.notify(`已打开主题目录：${directory}`, 'info')
}

const modes = Object.keys(PLAY_MODE_LABELS) as PlayMode[]

/* ---------------------------------------------------------------- desktop lyrics */

const lyricsOptions = ref<DesktopLyricsSettings>({ ...DEFAULT_DESKTOP_LYRICS })

async function refreshDesktopLyrics(): Promise<void> {
  const next = await desktopLyricsService.options()
  if (next) lyricsOptions.value = next
}

async function toggleDesktopLyrics(): Promise<void> {
  const next = await desktopLyricsService.setEnabled(!lyricsOptions.value.enabled)
  if (next) lyricsOptions.value = next
}

async function patchDesktopLyrics(patch: Partial<DesktopLyricsSettings>): Promise<void> {
  // Optimistic so the slider feels immediate; the main process echoes back the clamped value.
  lyricsOptions.value = { ...lyricsOptions.value, ...patch }
  const next = await desktopLyricsService.setOptions(patch)
  if (next) lyricsOptions.value = next
}

/*
 * 系统集成（托盘 / 任务栏按钮 / 媒体键）。
 *
 * The page shows two things: the switches the user set, and `status` — what the operating system
 * actually accepted. Showing only the switches would let "media keys on" sit next to media keys that
 * another application owns, which is exactly the kind of fake state this app avoids.
 */
const integration = ref<SystemIntegrationSettings>({ ...DEFAULT_SYSTEM_INTEGRATION })
const integrationStatus = ref<SystemIntegrationStatus>({
  trayActive: false,
  launchAtLogin: false,
  trayTooltip: '',
  mediaKeys: [],
  taskbarButtons: false,
  platform: '',
})
const integrationBusy = ref(false)

async function refreshIntegration(): Promise<void> {
  integrationStatus.value = await systemIntegrationService.status()
}

async function patchIntegration(patch: Partial<SystemIntegrationSettings>): Promise<void> {
  integrationBusy.value = true
  try {
    const next = await systemIntegrationService.set(patch)
    integration.value = next
    // Re-read the real state: the answer is whatever the OS did with the request.
    await refreshIntegration()
  } finally {
    integrationBusy.value = false
  }
}

async function resetDesktopLyrics(): Promise<void> {
  const next = await desktopLyricsService.resetPosition()
  if (next) lyricsOptions.value = next
}

/*
 * 功能状态。
 *
 * 这份列表的唯一职责是**如实**回答「现在能用什么、还差什么」。所以每条都在源码里对过：
 * 已实现的写清楚边界（例如 ID3 写入只对 MP3 生效），没实现的直接标出来，不写含糊的「部分支持」。
 * 原来这里有三条写错了——托盘/全局快捷键/频谱其实早就有了，而真正缺的能力反而没列出来。
 */
const featureGroups = computed<Array<{ title: string; items: Array<{ name: string; state: string; done: boolean }> }>>(() => [
  {
    title: '本地音乐',
    items: [
    { name: '本地音乐库（元数据解析 / 封面落盘缓存 / 增量去重 / 文件丢失标记）', state: '已实现', done: true },
    { name: '音频播放（播放 / 暂停 / 拖动进度 / 音量 / 静音）', state: '已实现', done: true },
    { name: '播放队列（拖动排序 / 移除 / 清空 / 插入下一首）', state: '已实现', done: true },
    { name: '播放模式（列表循环 / 单曲 / 随机 / 顺序）', state: '已实现', done: true },
    { name: '本地搜索（标题 / 艺术家 / 专辑 / 文件名 / 拼音首字母）', state: '已实现', done: true },
    { name: '全量曲库四维视图（单曲 / 歌手 / 专辑 / 文件夹）与排序（标题 / 时长 / 添加时间）', state: '已实现', done: true },
    { name: '音乐统计（曲目 / 总时长 / 无损占比 / 播放次数）与智能动态歌单（遗忘金曲 / Hi-Res 专区）', state: '已实现', done: true },
    { name: '收藏与播放历史（含播放次数）', state: '已实现', done: true },
    { name: '歌单（创建 / 重命名 / 删除 / JSON 导入导出）', state: '已实现（本机存储）', done: true },
    { name: '曲库工具：自动补齐信息（在线匹配封面与 LRC）/ 格式转换（ffmpeg）/ 修改 ID3 标签', state: '已实现', done: true },
    { name: 'ID3 标签写入', state: '已实现（仅 MP3）', done: true },
    {
      name: '曲库多选与批量操作（全选 / 反选 / Shift 连选 / 批量加入歌单 / 批量移除 / 批量改信息 / 两步确认）',
      state: '已实现（批量改信息与其他标签写入一样仅限 MP3，且会写进文件）',
      done: true,
    },
    { name: '文件 / 文件夹拖拽导入（拖入窗口即扫描并入库，支持 MP3 / FLAC / WAV / M4A / OGG）', state: '已实现', done: true },
    {
      name: '曲库数据库（曲库索引存于 SQLite，未变动文件按 mtime + 大小跳过重读；library.json 同步保留为镜像）',
      state: '已实现（收藏 / 历史 / 歌单仍以本机存储为准）',
      done: true,
    },
    { name: '缓存管理（封面 / 歌词 / 临时文件分别统计与清理，自己导入的歌词不删）', state: '已实现', done: true },
    { name: '完整数据备份与恢复（设置 + 收藏 + 历史 + 歌单导出 JSON；导入前校验，失败回滚）', state: '已实现', done: true },
    ],
  },
  {
    title: '播放与音效',
    items: [
    { name: '均衡器与音效链（10 段 + 前级 + 9 套预设，关闭时是全 0 dB 真旁路）', state: '已实现', done: true },
    { name: '音频输出设备选择', state: '已实现（实际走 context 还是 element 会在界面上说明）', done: true },
    { name: '无缝播放与淡入淡出（双牌轮转 + 提前预载，淡入淡出按增益斜坡）', state: '已实现', done: true },
    { name: '音量均衡（ReplayGain：逐曲 RMS 测量并缓存，两副牌各自增益）', state: '已实现', done: true },
    { name: '睡眠定时（15 / 30 / 45 / 60 / 90 分钟与「本曲结束后」，倒计时可见）', state: '已实现', done: true },
    ],
  },
  {
    title: '歌词',
    items: [
  {
    name: '歌词引擎（本地 .lrc / 内嵌标签 / LRCLIB 公开歌词库 / 国内歌词接口 / 逐行 + 逐字 + 翻译 + 罗马音 / 自动缓存 / 手动导入 / 失败重试）',
      state: '已实现',
      done: true,
  },
    { name: '歌词显示（颜色五档 / 跟随播放平滑滚动 / 逐字填充 / 手动滚动时暂停跟随并可回到当前句）', state: '已实现', done: true },
    { name: '沉浸式歌词页（模糊封面背景 / 居中滚动 / 点击跳转 / F11 沉浸 / 歌词·频谱·唱片三视图）', state: '已实现', done: true },
    { name: '歌词偏移校准（编辑器与沉浸页都能调，±1000 ms / 100 ms 一档，实时生效、落库；不改写 .lrc 文件）', state: '已实现', done: true },
    { name: '桌面歌词独立窗口（置顶透明 / 逐字高亮 / 翻译 / 字号配色 / 锁定鼠标穿透 / 位置持久化）', state: '已实现', done: true },
    ],
  },
  {
    title: '主题与视觉',
    items: [
    { name: '主题系统（6 套皮肤 × 明暗两套配色 / 主题包导入 / 主题自动推荐）', state: '已实现', done: true },
    { name: '视觉引擎（动画等级 / 渲染帧率上限可自定 24–240 或跟随屏幕 / 负载自动降档与恢复 / 外壳跟随背景亮度与封面色）', state: '已实现', done: true },
    { name: '隐藏彩蛋（连听极光 / 雨夜窗 / 陪伴记录 / Signal Lost / Ctrl+Shift+A 诊断面板）', state: '已实现', done: true },
    ],
  },
  {
    title: '在线音源与下载',
    items: [
    { name: '多音源统一搜索（Tabs / 防抖 / 取消旧请求 / 局部失败不影响其他源）', state: '已实现', done: true },
    { name: '音源合集与歌单详情（合集详情 + 队列/收藏）', state: '已实现', done: true },
    { name: '音质偏好四档（播放栏徽章切换，改完立即按新档位重新解析）', state: '已实现', done: true },
    { name: 'SourceManager 插件架构（能力模型 / 启用禁用 / 排序 / 配置 / 健康检查）', state: '已实现', done: true },
    { name: '内置平台搜索：青空纯音 / 红云心语 / 绿洲曲海 / 蔚蓝声浪 / 暖橙彩韵（搜索与元数据）', state: '已实现', done: true },
    { name: '洛雪音源兼容运行时（沙箱执行 / request / utils / inited / search / musicUrl / lyric / pic）', state: '已实现', done: true },
    { name: '声明式 API 音源（JSON 清单 / 字段映射 / 导入导出 / 校验 / 内置样板，安装区可直接新建一个，不经过脚本协议）', state: '已实现', done: true },
    { name: '平台访问安全模式（拒绝明文 http 接口 / 未授权主机不自动放行 / 新装音源默认禁用）', state: '已实现', done: true },
    { name: '脚本音源运行时（隐藏沙箱渲染进程 / 权限桥 / 洛雪协议兼容 / 热重载）', state: '已实现', done: true },
    { name: '音源安装与权限（.js / .json 自动识别 / 主机授权 / 出错后一键授权并重载）', state: '已实现', done: true },
    { name: '后台自动健康检查（可关闭，失败只标记单个音源）', state: '已实现', done: true },
    { name: '全量自检（一次跑遍所有已启用音源，按待授权 / 超时 / 待配置 / 未加载 / 正常分类，行内可直接放行主机）', state: '已实现', done: true },
    { name: '主进程网络代理与远程流中继（Range 透传）', state: '已实现', done: true },
    { name: '下载管理器（并发 / 断点续传 / 进度速度剩余时间 / 文件名模板 / 写 ID3 标签 / 重启恢复）', state: '已实现', done: true },
    ],
  },
  {
    title: '系统与快捷键',
    items: [
    { name: '系统集成（托盘图标与菜单 / 双击恢复窗口 / 任务栏缩略图按钮 / 全局媒体键）', state: '已实现', done: true },
    { name: '开机自启动（写入系统登录项，界面显示的是系统实际登记状态）', state: '已实现', done: true },
    { name: '关闭窗口时最小化到托盘', state: '已实现（托盘未注册成功时该选项不生效）', done: true },
    { name: '系统媒体控制（Media Session：元数据与播放状态上报，支持系统媒体面板操作）', state: '已实现', done: true },
    { name: '快捷键（空格 / ←→ 快退快进 / Ctrl+↑↓ 音量 / Ctrl+K 搜索 / Ctrl+Shift+L 歌词页 / F11 / Ctrl+Shift+A）', state: '已实现（固定键位）', done: true },
    { name: '崩溃日志（错误类型 / 时间 / 版本，写入前抹掉路径与 token，可导出与清空）', state: '已实现', done: true },
    { name: '更新检查（对着真实版本清单比对，发现新版本给出下载入口）', state: '已实现（只提示并打开下载页，不做静默安装）', done: true },
    { name: '本地 HTTP API（只读 / 默认关闭 / 只绑 127.0.0.1 / 除健康检查外都要 token）', state: '已实现', done: true },
    ],
  },
  {
    title: '待实现',
    /*
     * 已确认缺失的能力。列出来是为了让缺口可见，不代表正在开发。
     * 只剩这一条：C 档其余项都已落地，所以这一组现在是「唯一缺口」，而不是一份愿望清单。
     */
    items: [
    { name: '迷你播放器窗口（小窗常驻：封面 / 歌名 / 歌手 / 播放控制，与主窗口状态同步）', state: '待实现', done: false },
    ],
  },
])

/*
 * 分组收起。
 *
 * 默认就把「已经做完的组」收起来、只留标题与 已实现/总数 —— 这份列表本来就是为了让缺口一眼可见，
 * 全部铺开时缺口反而被几百行实现说明埋掉。完全实现的分组默认收起，还有缺口的默认展开；
 * 顶部一个按钮可以一次全开 / 全收，用户自己的选择优先于默认值。
 */
const collapsedGroups = ref<Record<string, boolean>>(
  Object.fromEntries(featureGroups.value.filter((group) => group.items.every((item) => item.done)).map((group) => [group.title, true])),
)
const everyGroupCollapsed = computed(() => featureGroups.value.every((group) => collapsedGroups.value[group.title]))

function toggleGroup(title: string): void {
  collapsedGroups.value = { ...collapsedGroups.value, [title]: !collapsedGroups.value[title] }
}

function toggleAllGroups(): void {
  const collapse = !everyGroupCollapsed.value
  collapsedGroups.value = Object.fromEntries(featureGroups.value.map((group) => [group.title, collapse]))
}

async function clearLibrary(): Promise<void> {
  if (library.tracks.length === 0 || clearing.value) return
  if (!window.confirm(`确定要从音乐库移除全部 ${library.tracks.length} 首记录吗？不会删除磁盘上的音乐文件。`)) return
  clearing.value = true
  try {
    for (const track of [...library.tracks]) {
      await library.remove(track.id)
    }
    player.clearQueue()
    ui.notify('已清空音乐库记录（磁盘文件未受影响）', 'success')
  } finally {
    clearing.value = false
  }
}

function clearFavorites(): void {
  if (collection.favoriteIds.length === 0) return
  collection.clearFavorites()
  ui.notify('已清空收藏', 'info')
}

function clearHistory(): void {
  if (collection.history.length === 0) return
  collection.clearHistory()
  ui.notify('已清空播放历史', 'info')
}

function clearPlaylists(): void {
  if (playlists.playlists.length === 0) return
  if (!window.confirm('确定要删除全部歌单吗？')) return
  playlists.clearAll()
  ui.notify('已删除全部歌单', 'info')
}

function exportPlaylists(): void {
  if (playlists.playlists.length === 0) {
    ui.notify('还没有歌单可以导出', 'info')
    return
  }
  const blob = new Blob([playlists.exportJson()], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `aurora-playlists-${new Date().toISOString().slice(0, 10)}.json`
  anchor.click()
  URL.revokeObjectURL(url)
  ui.notify('歌单已导出', 'success')
}

/**
 * Asks the recommender about the song that is playing right now.
 *
 * A button, not an automatic switch: the recommender is a suggestion with a reason attached, and a theme that
 * changes under a listener is the kind of cleverness that makes an app feel out of control. An abstention is
 * reported as such — most songs genuinely do not suggest a world.
 */
function recommendForTrack(): void {
  const track = player.current
  const picked = ui.recommendForTrack(
    track
      ? {
          title: track.title,
          artist: track.artist,
          genre: (track as { genre?: string }).genre,
          duration: track.duration,
          accent: ui.artworkAccent ?? undefined,
        }
      : null,
  )
  if (!track) return ui.notify('还没有正在播放的歌曲：先放一首再让它推荐', 'info')
  if (!picked) return ui.notify('这首歌没有足够的信息可以推荐主题（标题、流派、封面色都不足以判断）', 'info')
  ui.setSkin(picked.skinId)
  ui.notify(`这首歌适合「${picked.name}」：${picked.reason}`, 'success')
}

function resetPlayer(): void {
  player.setVolume(0.72)
  player.setMode('list-loop')
  ui.notify('播放偏好已重置', 'success')
}

let frameTimer = 0

onMounted(async () => {
  frameTimer = window.setInterval(() => {
    frameSample.value = ui.frameInfo()
  }, 1000)
  info.value = await appService.info()
  const settings = await settingsService.refresh()
  lyricsOptions.value = settings.desktopLyrics
  integration.value = settings.systemIntegration
  await refreshIntegration()
  await refreshStorage()
  await refreshDiagnostics()
  await refreshUpdateSettings()
  await sourceStore.load()
  // The window can also be toggled from the player bar, so re-read when the page is shown again.
  window.addEventListener('focus', refreshDesktopLyrics)
})

onBeforeUnmount(() => {
  window.removeEventListener('focus', refreshDesktopLyrics)
  window.clearInterval(frameTimer)
})
</script>

<template>
  <div class="view">
    <header class="view-header">
      <div>
        <h1>设置</h1>
        <p class="muted">Aurora Music · 本地优先的桌面音乐播放器</p>
      </div>
    </header>

    <section id="theme-center" class="settings-section theme-center">
      <h3>主题中心</h3>
      <p class="section-hint">每个主题都有自己的明暗两套配色与氛围效果。切主题不是换颜色，是换一个听歌的空间。</p>

      <div class="skin-grid">
        <button
          v-for="skin in ui.availableSkins"
          :key="skin.id"
          class="skin-card"
          :class="{ active: ui.skin === skin.id }"
          :data-skin-id="skin.id"
          @click="pickSkin(skin.id)"
        >
          <span class="skin-swatch">
            <i v-for="(color, index) in preview(skin.id)" :key="index" :style="{ background: color }"></i>
          </span>
          <span class="skin-title">
            <strong>{{ skin.name }}</strong>
            <em v-if="ui.skin === skin.id">当前</em>
          </span>
          <span class="skin-tagline">{{ skin.tagline }}</span>
          <span class="skin-keywords"><i v-for="word in skin.keywords" :key="word">{{ word }}</i></span>
        </button>
      </div>

      <div class="setting-row">
        <div class="setting-label"><strong>明暗</strong><span>深色、浅色或跟随系统；主题会记住自己的推荐明暗</span></div>
        <div class="segmented">
          <button v-for="item in themes" :key="item.value" :class="{ active: ui.theme === item.value }" @click="ui.setTheme(item.value)">
            {{ item.label }}
          </button>
        </div>
      </div>

      <div class="setting-row">
        <div class="setting-label">
          <strong>动画等级</strong>
          <span>{{ LEVELS[ui.animationLevel].hint }}</span>
        </div>
        <div class="segmented">
          <button
            v-for="level in LEVEL_ORDER"
            :key="level"
            :class="{ active: ui.animationLevel === level }"
            :data-level="level"
            @click="ui.setAnimationLevel(level)"
          >
            {{ LEVELS[level].label }}
          </button>
        </div>
      </div>

      <div class="setting-row">
        <div class="setting-label">
          <strong>渲染帧率上限</strong>
          <span>{{ frameRateHint }}</span>
        </div>
        <div class="segmented">
          <button
            v-for="option in frameRateOptions"
            :key="String(option.value)"
            :class="{ active: ui.frameRate === option.value }"
            :data-frame-rate="String(option.value)"
            @click="ui.setFrameRate(option.value)"
          >
            {{ option.label }}
          </button>
          <button
            class="frame-rate-custom"
            :class="{ active: customRateActive }"
            data-frame-rate="custom"
            @click="openCustomRate"
          >
            {{ customRateActive ? `${ui.frameRate}` : '自定义' }}
          </button>
        </div>
      </div>

      <!--
        自定义帧率。出现的时机只有两个：用户点了「自定义」，或当前生效值本来就不是预设 —— 于是
        设置页永远能把这些数字原样显示出来，而不是显示成没有一档被选中。
      -->
      <div v-if="customRateOpen" class="setting-row">
        <div class="setting-label">
          <strong>自定义帧率上限</strong>
          <span>
            {{ customRateError || `输入 ${FRAME_RATE_MIN}–${FRAME_RATE_MAX} 之间的整数；高于屏幕刷新率时按屏幕上限执行` }}
          </span>
        </div>
        <div class="slider-row">
          <input
            v-model="customRateText"
            class="text-input frame-rate-input"
            inputmode="numeric"
            maxlength="3"
            aria-label="自定义帧率上限"
            data-frame-rate-input
            @keyup.enter="applyCustomRate"
          />
          <button class="primary-button small" data-frame-rate-apply @click="applyCustomRate">应用</button>
          <button class="ghost-button small" @click="customRateOpen = false">收起</button>
        </div>
      </div>

      <!--
        当前效果的真实运行状态。

        这不是装饰：主题决定“画什么”，等级决定“画多少”，而这一行说的是两者最终实际跑的粒子数、
        实测帧耗时，以及跳过仪自动降档时降到了哪一档。只把控件画出来、不说它实际干了什么，就回到了
        “UI 伪装状态”那个老问题上。
      -->
      <div class="setting-row">
        <div class="setting-label">
          <strong>当前效果</strong>
          <span>
            {{ effectSummary }}
          </span>
        </div>
        <div class="effect-status">
          <span class="effect-pill" :class="{ active: ui.autoDowngraded }">{{ frameText }}</span>
          <!--
            自动降档 / 自动恢复都要说清。

            静默恢复和静默降档一样让人困惑（“我早上看着不是这样”），所以两边都报：降档引用的是判定
            当时真的量到的那两个数（p95 对预算），而不是事后重算出来的。
          -->
          <span v-if="ui.autoDowngraded" class="faint small-text">
            {{ ui.autoDowngraded.reason }}
            （「{{ LEVELS[ui.autoDowngraded.from].label }}」
            {{ ui.autoDowngraded.direction === 'down' ? '→' : '←' }}
            「{{ LEVELS[ui.autoDowngraded.to].label }}」，实测 p95
            {{ Math.round(ui.autoDowngraded.frameMs) }}ms）
          </span>
        </div>
      </div>

      <!--
        更多主题 is a real loader, not an entry that leads nowhere: the folder, the schema readme and an
        editable example are all written by the main process on demand.
      -->
      <!--
        主题推荐 + 音乐陪伴。

        两件事放在一起，因为它们回答的是同一个问题：“这套空间陪了我多久”。推荐必须给出理由（没有理由的推荐
        等于随便换主题），陪伴记录里的数字是真实累计——播放次数是“真的开始播了一首”，时长是“有音乐在响的秒数”。
      -->
      <div class="setting-row">
        <div class="setting-label">
          <strong>按当前歌曲推荐主题</strong>
          <span>
            {{ ui.recommendation ? `建议「${ui.recommendation.name}」：${ui.recommendation.reason}` : '用标题 / 流派 / 封面色匹配这一套主题的性格；不会自动切换' }}
          </span>
        </div>
        <button class="secondary-button" data-recommend-theme @click="recommendForTrack">推荐并切换</button>
      </div>

      <div class="setting-row">
        <div class="setting-label">
          <strong>音乐陪伴</strong>
          <span data-companion-summary>
            播放 {{ ui.companionSummary.plays }} 首 · 陪伴 {{ ui.companionSummary.listened }}
            <template v-if="ui.companionSummary.since"> · 从 {{ ui.companionSummary.since }} 开始</template>
            <template v-if="ui.companionSummary.night"> · Aurora Night 已解锁（{{ ui.companionSummary.night }}）</template>
          </span>
        </div>
        <span class="effect-pill" :class="{ active: Boolean(ui.companionSummary.night) }" data-companion>
          {{ ui.companionSummary.night ? 'Aurora Night' : '连听 5 首解锁极光' }}
        </span>
      </div>

      <div class="theme-more">
        <header>
          <strong>更多主题</strong>
          <span class="faint">{{ userSkinCount }} 个自装主题{{ brokenThemes.length > 0 ? ` · ${brokenThemes.length} 个无法加载` : '' }}</span>
        </header>
        <p class="muted small-text">
          主题是数据，不是代码：把主题 JSON 放进主题目录，就能像内置主题一样切换。目录里已经放了一份可以直接改的示例。
        </p>
        <div class="theme-more-actions">
          <button class="primary-button small" @click="importTheme()">导入主题文件</button>
          <button class="ghost-button small" @click="refreshThemes()">刷新</button>
          <button class="ghost-button small" @click="revealThemes()">打开主题目录</button>
        </div>
        <ul v-if="ui.userThemes.length > 0" class="theme-list">
          <li v-for="record in ui.userThemes" :key="record.file" :class="{ broken: !record.ok }">
            <div>
              <strong>{{ record.name }}</strong>
              <span v-if="record.ok" class="faint small-text">可用 · 点击上方列表即可选中</span>
              <span v-else class="warn small-text">{{ record.error }}</span>
            </div>
            <div class="theme-list-actions">
              <button v-if="record.ok" class="text-button" @click="pickSkin(record.id)">使用</button>
              <button class="text-button" @click="removeTheme(record.id, record.name)">删除</button>
            </div>
          </li>
        </ul>
        <p v-else class="faint small-text">主题目录暂无自定义主题。</p>
      </div>
    </section>

    <section class="settings-section">
      <h3>播放</h3>
      <!--
        音质偏好已经搬到播放栏的徽章上（点徽章就是四档选择器）。这里只留一句话指路 ——
        再放一份四档卡片，就是两个会不同步的真相。
      -->
      <p class="muted small-text">
        音质偏好（四档）在播放栏的音质徽章上：点一下就能切，改完会立刻按新档位重新解析当前歌曲。
      </p>
      <!--
        歌词颜色：五档（自动 / 白色 / 暖白 / 主题色 / 自定义），保存在本机。
        它只改变歌词 *怎么显示*，不碰歌曲与歌词数据。
      -->
      <div class="setting-row">
        <div class="setting-label">
          <strong>歌词颜色</strong>
          <span>{{ lyricColorHint }}</span>
        </div>
        <div class="segmented ink-segmented">
          <button
            v-for="option in LYRIC_COLOR_OPTIONS"
            :key="option.mode"
            :class="{ active: ui.lyricColor === option.mode }"
            :data-ink-mode="option.mode"
            @click="ui.setLyricColor(option.mode)"
          >
            <span class="lp-ink-swatch" :data-ink="option.mode" aria-hidden="true">A</span>
            {{ option.label }}
          </button>
        </div>
      </div>
      <div v-if="ui.lyricColor === 'custom'" class="setting-row">
        <div class="setting-label"><strong>自定义颜色</strong><span>{{ ui.lyricCustomColor }}</span></div>
        <div class="slider-row">
          <input
            type="color"
            :value="ui.lyricCustomColor"
            aria-label="自定义歌词颜色"
            @input="ui.setLyricCustomColor(($event.target as HTMLInputElement).value)"
          />
        </div>
      </div>
      <!--
        歌词偏移：歌词显示时间 = 播放位置 + 该值（±1000 ms，100 ms 一档）。
        它只改“什么时候读哪一句”，不碰磁盘上的 .lrc，也不改播放本身。
      -->
      <div class="setting-row" data-testid="lyric-offset-row">
        <div class="setting-label">
          <strong>歌词偏移</strong>
          <span>{{ lyricOffsetHint }}</span>
        </div>
        <div class="slider-row offset-row">
          <button
            class="ghost-button small"
            data-testid="lyric-offset-earlier"
            :disabled="lyrics.offsetMs <= -LYRICS_OFFSET_LIMIT_MS"
            title="歌词提前 100 ms"
            @click="lyrics.nudgeOffset(-1)"
          >提前</button>
          <span class="offset-value" data-testid="lyric-offset-value">{{ formatLyricsOffset(lyrics.offsetMs) }}</span>
          <button
            class="ghost-button small"
            data-testid="lyric-offset-later"
            :disabled="lyrics.offsetMs >= LYRICS_OFFSET_LIMIT_MS"
            title="歌词延后 100 ms"
            @click="lyrics.nudgeOffset(1)"
          >延后</button>
          <button
            class="ghost-button small"
            data-testid="lyric-offset-reset"
            :disabled="lyrics.offsetMs === 0"
            @click="lyrics.setOffset(0)"
          >归零</button>
        </div>
      </div>
      <div class="setting-row">
        <div class="setting-label"><strong>播放模式</strong><span>也可以在播放栏中随时切换</span></div>
        <div class="segmented">
          <button v-for="mode in modes" :key="mode" :class="{ active: player.mode === mode }" @click="player.setMode(mode)">
            {{ PLAY_MODE_LABELS[mode] }}
          </button>
        </div>
      </div>
      <div class="setting-row">
        <div class="setting-label"><strong>默认音量</strong><span>当前 {{ Math.round(player.volume * 100) }}%</span></div>
        <div class="slider-row">
          <input type="range" min="0" max="1" step="0.01" :value="player.volume" @input="player.setVolume(Number(($event.target as HTMLInputElement).value))" />
          <button class="ghost-button small" @click="resetPlayer">重置偏好</button>
        </div>
      </div>
      <div class="setting-row">
        <div class="setting-label"><strong>播放队列</strong><span>{{ player.queue.length }} 首待播放</span></div>
        <div class="slider-row">
          <button class="ghost-button small" :disabled="player.queue.length === 0" @click="playShuffled(player.queue)">随机播放队列</button>
          <button class="ghost-button small danger" :disabled="player.queue.length === 0" @click="player.clearQueue()">清空队列</button>
        </div>
      </div>
    </section>

    <!--
      声音. Ordered the way someone troubleshoots: shape it (EQ), then level it (loudness), then say where
      it comes out (device), then decide how tracks join (gapless / crossfade).
    -->
    <section class="settings-section" data-testid="sound-section">
      <h3>声音</h3>

      <div class="setting-row">
        <div class="setting-label">
          <strong>均衡器</strong>
          <span>{{ sound.eqSummary }}</span>
        </div>
        <div class="slider-row">
          <button
            class="ghost-button small"
            :class="{ active: sound.equalizer.enabled }"
            data-testid="eq-toggle"
            @click="sound.setEqualizerEnabled(!sound.equalizer.enabled)"
          >
            {{ sound.equalizer.enabled ? '已开启' : '已关闭' }}
          </button>
          <button class="ghost-button small" data-testid="eq-reset" @click="sound.resetEqualizer()">重置曲线</button>
        </div>
      </div>

      <div class="eq-presets">
        <button
          v-for="preset in EQ_PRESETS"
          :key="preset.id"
          class="eq-preset"
          :class="{ active: sound.equalizer.preset === preset.id }"
          :data-preset="preset.id"
          :title="preset.hint"
          @click="sound.setEqualizerPreset(preset.id)"
        >
          {{ preset.label }}
        </button>
        <span v-if="sound.equalizer.preset === 'custom'" class="eq-preset active" data-preset="custom">{{ presetLabel('custom') }}</span>
      </div>
      <p class="muted small-text">{{ presetHint }}</p>

      <div class="eq-bands" :class="{ disabled: !sound.equalizer.enabled }">
        <div v-for="index in EQ_BAND_COUNT" :key="index" class="eq-band">
          <span class="eq-band-label">{{ bandLabel(index - 1) }}</span>
          <input
            type="range"
            min="-12"
            max="12"
            step="0.5"
            :value="sound.equalizer.gains[index - 1] ?? 0"
            :disabled="!sound.equalizer.enabled"
            :data-band="index - 1"
            :aria-label="`${bandLabel(index - 1)} 增益`"
            @input="sound.setEqBand(index - 1, Number(($event.target as HTMLInputElement).value))"
          />
          <span class="eq-band-value">{{ signed(sound.equalizer.gains[index - 1] ?? 0) }}</span>
        </div>
        <div class="eq-band preamp">
          <span class="eq-band-label">前级</span>
          <input
            type="range"
            :min="-EQ_GAIN_LIMIT_DB"
            :max="EQ_GAIN_LIMIT_DB"
            step="0.5"
            :value="sound.equalizer.preampDb"
            :disabled="!sound.equalizer.enabled"
            data-band="preamp"
            aria-label="前级增益"
            @input="sound.setPreamp(Number(($event.target as HTMLInputElement).value))"
          />
          <span class="eq-band-value">{{ signed(sound.equalizer.preampDb) }}</span>
        </div>
        <div class="eq-foot">
          <span class="muted small-text">
            多段同时抬升会把声音推满量程，需要余量时用前级退回一点。建议前级
            {{ signed(suggestedPreampDb(sound.equalizer.gains)) }} dB。
          </span>
          <button class="ghost-button small" :disabled="!sound.equalizer.enabled" @click="sound.applySuggestedPreamp()">
            按建议设置前级
          </button>
        </div>
      </div>

      <div class="setting-row spaced">
        <div class="setting-label">
          <strong>音量均衡</strong>
          <span>{{ sound.loudnessSummary }}</span>
        </div>
        <div class="slider-row">
          <button
            class="ghost-button small"
            :class="{ active: sound.loudness.enabled }"
            data-testid="loudness-toggle"
            @click="sound.setLoudnessEnabled(!sound.loudness.enabled)"
          >
            {{ sound.loudness.enabled ? '已开启' : '已关闭' }}
          </button>
          <button class="ghost-button small" @click="sound.forgetLoudnessMeasurements()">清除已测响度</button>
        </div>
      </div>
      <p class="muted small-text">
        目标越接近 0 dB 越响；同一个目标下，慢歌与快歌的平均电平会被拉到相近，不再一首震耳一首听不清。
        本地文件能用内嵌标签时优先用标签，否则会在开头几秒实测一次并缓存下来。
      </p>
      <div class="segmented loudness-targets" data-testid="loudness-targets">
        <button
          v-for="target in LOUDNESS_TARGETS_DB"
          :key="target"
          :class="{ active: sound.loudness.targetDb === target }"
          :data-target="target"
          @click="sound.setLoudnessTarget(target)"
        >
          {{ loudnessTargetLabel(target) }}
        </button>
      </div>

      <div class="setting-row spaced">
        <div class="setting-label">
          <strong>输出设备</strong>
          <span>{{ sound.outputSummary }}<template v-if="sound.deviceMessage"> · {{ sound.deviceMessage }}</template></span>
        </div>
        <div class="slider-row">
          <button class="ghost-button small" :disabled="sound.outputBusy" @click="refreshDevices">重新扫描设备</button>
        </div>
      </div>
      <ul class="device-list" data-testid="device-list">
        <li v-for="device in sound.devices" :key="device.deviceId || 'default'">
          <button
            class="device-row"
            :class="{ active: sound.settings.outputDeviceId === device.deviceId }"
            :data-device="device.deviceId || 'default'"
            :disabled="sound.outputBusy"
            @click="sound.chooseOutputDevice(device.deviceId)"
          >
            <span class="device-name">{{ device.label }}</span>
            <span class="device-tag">{{ sound.settings.outputDeviceId === device.deviceId ? '正在使用' : '切换' }}</span>
          </button>
        </li>
      </ul>

      <div class="setting-row spaced">
        <div class="setting-label">
          <strong>无缝播放</strong>
          <span>提前把下一首准备好，当前这首结束时直接接上，不重新解析地址</span>
        </div>
        <div class="slider-row">
          <button
            class="ghost-button small"
            :class="{ active: sound.gapless }"
            data-testid="gapless-toggle"
            @click="sound.setGapless(!sound.gapless)"
          >
            {{ sound.gapless ? '已开启' : '已关闭' }}
          </button>
        </div>
      </div>
      <div class="setting-row">
        <div class="setting-label">
          <strong>淡入淡出</strong>
          <span>{{ formatCrossfade(sound.crossfadeSeconds) }}（拖到最左是关闭）</span>
        </div>
        <div class="slider-row">
          <input
            type="range"
            min="0"
            :max="CROSSFADE_MAX_SECONDS"
            step="0.5"
            :value="sound.crossfadeSeconds"
            data-testid="crossfade-slider"
            aria-label="淡入淡出时长"
            @input="sound.setCrossfade(Number(($event.target as HTMLInputElement).value))"
          />
        </div>
      </div>
      <p class="muted small-text">
        淡入淡出需要音频图（均衡器或音量均衡开着时会建立）；音频图还没建立时会退回到无缝播放，
        而不是把两首歌同时响到底。
      </p>
    </section>

    <section id="storage-section" class="settings-section" data-testid="storage-section">
      <h3>缓存与数据</h3>
      <p class="muted small-text">
        下面的字节数来自主进程真实的目录扫描，清理按钮删的就是这些文件本身。
        你自己导入的歌词不在清理范围内。
      </p>
      <div v-for="area in cacheReport?.areas ?? []" :key="area.id" class="setting-row">
        <div class="setting-label">
          <strong>{{ area.label }}</strong>
          <span>{{ area.files }} 个文件 · {{ formatBytes(area.bytes) }}<template v-if="area.id === 'lyrics' && cacheReport"> · 已索引 {{ area.files }} 条</template></span>
          <span class="muted small-text" data-testid="cache-path">{{ area.path }}</span>
        </div>
        <div class="slider-row">
          <button
            class="ghost-button small"
            :disabled="cacheBusy || area.files === 0"
            :data-testid="`clear-${area.id}`"
            @click="clearCacheArea(area)"
          >
            清理
          </button>
        </div>
      </div>
      <div class="setting-row">
        <div class="setting-label">
          <strong>全部缓存</strong>
          <span data-testid="cache-total">{{ cacheReport?.totalFiles ?? 0 }} 个文件 · {{ formatBytes(cacheReport?.totalBytes ?? 0) }}</span>
        </div>
        <div class="slider-row">
          <button class="ghost-button small" :disabled="cacheBusy" @click="refreshStorage">重新统计</button>
          <button class="ghost-button small" data-testid="clear-all-caches" :disabled="cacheBusy" @click="clearEveryCache">全部清理</button>
        </div>
      </div>
      <div class="setting-row">
        <div class="setting-label">
          <strong>曲库数据库</strong>
          <span data-testid="db-engine">{{ dbEngineLabel }}</span>
          <span class="muted small-text" data-testid="db-path">{{ dbStats?.path }}</span>
          <span v-if="dbStats?.migratedFrom" class="muted small-text">已从 {{ dbStats.migratedFrom }} 迁移</span>
        </div>
      </div>
      <div class="setting-row">
        <div class="setting-label">
          <strong>导出备份</strong>
          <span>设置、收藏、播放历史、歌单导出为一个 JSON 文件</span>
        </div>
        <div class="slider-row">
          <button class="ghost-button small" data-testid="backup-export" :disabled="backupBusy" @click="exportBackupFile">导出</button>
        </div>
      </div>
      <div class="setting-row">
        <div class="setting-label">
          <strong>从备份恢复</strong>
          <span v-if="backupPreview && !backupPreview.error">
            校验通过：收藏 {{ backupPreview.counts.favorites }} · 历史 {{ backupPreview.counts.history }} · 歌单 {{ backupPreview.counts.playlists }}（格式 v{{ backupPreview.formatVersion }}）
          </span>
          <span v-else>先选择文件校验，确认后再写入；导入失败会自动回滚</span>
          <span v-if="backupPreview?.warnings.length" class="muted small-text" data-testid="backup-warning">{{ backupPreview.warnings.join('；') }}</span>
        </div>
        <div class="slider-row">
          <button class="ghost-button small" data-testid="backup-pick" :disabled="backupBusy" @click="pickBackupFile">选择文件</button>
          <button
            class="ghost-button small"
            data-testid="backup-apply"
            :disabled="backupBusy || !backupPreview || Boolean(backupPreview.error)"
            @click="applyBackupFile"
          >确认恢复</button>
        </div>
      </div>
    </section>

    <section id="diagnostics-section" class="settings-section" data-testid="diagnostics-section">
      <h3>诊断与更新</h3>
      <p class="muted small-text">
        崩溃日志只记录错误类型、时间与版本号；路径和 token 在写入前已被抹掉，可以直接贴进反馈里。
      </p>
      <div class="setting-row">
        <div class="setting-label">
          <strong>崩溃日志</strong>
          <span data-testid="diagnostics-count">
            {{ diagnostics?.total ?? 0 }} 条记录 · {{ formatBytes(diagnostics?.bytes ?? 0) }}
          </span>
          <span class="muted small-text" data-testid="diagnostics-path">{{ diagnostics?.logPath }}</span>
        </div>
        <div class="slider-row">
          <button class="ghost-button small" data-testid="diagnostics-export" @click="exportDiagnosticsFile">导出</button>
          <button class="ghost-button small" @click="revealDiagnostics">打开所在目录</button>
          <button
            class="ghost-button small"
            data-testid="diagnostics-clear"
            :disabled="(diagnostics?.total ?? 0) === 0"
            @click="refreshDiagnosticsAfterClear"
          >清空</button>
        </div>
      </div>
      <div class="setting-row">
        <div class="setting-label">
          <strong>更新源地址</strong>
          <span>GitHub releases API 或 返回 { version, url } 的 JSON；留空即不检查</span>
        </div>
        <div class="slider-row">
          <input v-model="updateFeed" class="text-input" type="url" placeholder="https://api.github.com/repos/owner/repo/releases/latest" data-testid="update-feed" />
          <button class="ghost-button small" :class="{ active: updateAuto }" @click="updateAuto = !updateAuto">
            {{ updateAuto ? '启动时检查：开' : '启动时检查：关' }}
          </button>
          <button class="ghost-button small" data-testid="update-check" :disabled="updateBusy" @click="runUpdateCheck">检查更新</button>
        </div>
      </div>
      <p v-if="updateResult" class="muted small-text" data-testid="update-result">{{ updateResult.detail }}</p>
      <div class="setting-row">
        <div class="setting-label">
          <strong>本地 HTTP API</strong>
          <span data-testid="http-api-status">
            {{ httpStatus?.running ? `运行中 · ${httpStatus.url}` : '已关闭' }}
            <template v-if="httpStatus?.requests"> · 已处理 {{ httpStatus.requests }} 次请求</template>
          </span>
          <span v-if="httpStatus?.error" class="muted small-text">{{ httpStatus.error }}</span>
          <span class="muted small-text">只绑定 127.0.0.1，只读（{{ (httpStatus?.endpoints ?? []).join(' ') }}），除 /api/health 外都需要 token</span>
        </div>
        <div class="slider-row">
          <input v-model.number="httpPort" class="text-input small" type="number" min="1024" max="65535" @change="patchHttpApi({ port: httpPort })" />
          <button class="ghost-button small" :class="{ active: httpStatus?.running }" :disabled="httpBusy" data-testid="http-api-toggle" @click="patchHttpApi({ enabled: !httpStatus?.running })">
            {{ httpStatus?.running ? '已开启' : '已关闭' }}
          </button>
          <button class="ghost-button small" @click="copyHttpToken">复制 token</button>
        </div>
      </div>
    </section>

    <section class="settings-section" data-testid="desktop-lyrics-section">
      <h3>桌面歌词</h3>
      <p class="muted small-text">
        独立的置顶歌词条：跟随播放进度、支持逐字高亮与翻译，锁定后鼠标可以直接穿透到下面的窗口。
        位置与外观保存在本机，重启后原样恢复。
      </p>
      <div class="setting-row">
        <div class="setting-label">
          <strong>显示桌面歌词</strong>
          <span>{{ lyricsOptions.enabled ? '已开启（关闭主窗口时会一起退出）' : '关闭中' }}</span>
        </div>
        <div class="slider-row">
          <button class="primary-button small" @click="toggleDesktopLyrics()">
            {{ lyricsOptions.enabled ? '关闭' : '开启' }}
          </button>
          <button class="ghost-button small" :disabled="!lyricsOptions.enabled" @click="resetDesktopLyrics()">
            重置位置
          </button>
        </div>
      </div>
      <div class="setting-row">
        <div class="setting-label"><strong>字号</strong><span>{{ lyricsOptions.fontSize }}px，也可以在歌词条上直接调</span></div>
        <div class="slider-row">
          <input
            type="range"
            min="14"
            max="96"
            step="1"
            :value="lyricsOptions.fontSize"
            @input="patchDesktopLyrics({ fontSize: Number(($event.target as HTMLInputElement).value) })"
          />
        </div>
      </div>
      <div class="setting-row">
        <div class="setting-label"><strong>配色</strong><span>当前行 / 其他行</span></div>
        <div class="slider-row">
          <input
            type="color"
            class="color-input"
            :value="lyricsOptions.color"
            title="当前行颜色"
            @input="patchDesktopLyrics({ color: ($event.target as HTMLInputElement).value })"
          />
          <input
            type="color"
            class="color-input"
            :value="lyricsOptions.inactiveColor"
            title="其他行颜色"
            @input="patchDesktopLyrics({ inactiveColor: ($event.target as HTMLInputElement).value })"
          />
          <button
            class="ghost-button small"
            :class="{ active: lyricsOptions.showTranslation }"
            @click="patchDesktopLyrics({ showTranslation: !lyricsOptions.showTranslation })"
          >
            翻译{{ lyricsOptions.showTranslation ? '开' : '关' }}
          </button>
          <button
            class="ghost-button small"
            :class="{ active: lyricsOptions.locked }"
            @click="patchDesktopLyrics({ locked: !lyricsOptions.locked })"
          >
            {{ lyricsOptions.locked ? '已锁定' : '锁定' }}
          </button>
        </div>
      </div>
    </section>

    <section class="settings-section" data-testid="system-integration-section">
      <h3>系统集成</h3>
      <p class="muted small-text">
        不切换窗口就能控制播放：托盘图标与菜单、Windows 任务栏缩略图按钮、全局媒体键。
        三者都通过同一条命令通道下发到播放器，所以托盘上显示的曲目就是播放栏正在放的那一首。
      </p>
      <div class="setting-row">
        <div class="setting-label">
          <strong>系统托盘图标</strong>
          <span>{{ integrationStatus.trayActive ? '已注册' : integration.tray ? '未生效（系统托盘不可用）' : '关闭中' }}</span>
        </div>
        <div class="slider-row">
          <button
            class="ghost-button small"
            :class="{ active: integration.tray }"
            :disabled="integrationBusy"
            @click="patchIntegration({ tray: !integration.tray })"
          >
            {{ integration.tray ? '已开启' : '已关闭' }}
          </button>
        </div>
      </div>
      <div class="setting-row">
        <div class="setting-label"><strong>托盘显示当前曲目</strong><span>鼠标悬停时的提示与菜单首行</span></div>
        <div class="slider-row">
          <button
            class="ghost-button small"
            :class="{ active: integration.showTrackInTray }"
            :disabled="integrationBusy"
            @click="patchIntegration({ showTrackInTray: !integration.showTrackInTray })"
          >
            {{ integration.showTrackInTray ? '已开启' : '已关闭' }}
          </button>
        </div>
      </div>
      <div class="setting-row">
        <div class="setting-label">
          <strong>任务栏缩略图按钮</strong>
          <span>
            <template v-if="integrationStatus.platform !== 'win32'">仅 Windows 支持</template>
            <template v-else>{{ integrationStatus.taskbarButtons ? '上一首 / 播放暂停 / 下一首' : '关闭中' }}</template>
          </span>
        </div>
        <div class="slider-row">
          <button
            class="ghost-button small"
            :class="{ active: integration.taskbarButtons }"
            :disabled="integrationBusy || integrationStatus.platform !== 'win32'"
            @click="patchIntegration({ taskbarButtons: !integration.taskbarButtons })"
          >
            {{ integration.taskbarButtons ? '已开启' : '已关闭' }}
          </button>
        </div>
      </div>
      <div class="setting-row">
        <div class="setting-label">
          <strong>全局媒体键</strong>
          <span>
            <template v-if="integration.mediaKeys">
              已占用 {{ integrationStatus.mediaKeys.length }} 个键<template v-if="integrationStatus.mediaKeys.length">（{{ integrationStatus.mediaKeys.join(' / ') }}）</template>
            </template>
            <template v-else>关闭中</template>
          </span>
        </div>
        <div class="slider-row">
          <button
            class="ghost-button small"
            :class="{ active: integration.mediaKeys }"
            :disabled="integrationBusy"
            @click="patchIntegration({ mediaKeys: !integration.mediaKeys })"
          >
            {{ integration.mediaKeys ? '已开启' : '已关闭' }}
          </button>
        </div>
      </div>
      <div class="setting-row">
        <div class="setting-label">
          <strong>开机自启动</strong>
          <span data-testid="login-item">
            系统登记状态：{{ integrationStatus.launchAtLogin ? '已在登录时启动' : '未登记' }}
          </span>
        </div>
        <div class="slider-row">
          <button
            class="ghost-button small"
            :class="{ active: integration.launchAtLogin }"
            :disabled="integrationBusy"
            data-testid="launch-at-login"
            @click="patchIntegration({ launchAtLogin: !integration.launchAtLogin })"
          >
            {{ integration.launchAtLogin ? '已开启' : '已关闭' }}
          </button>
        </div>
      </div>
      <div class="setting-row">
        <div class="setting-label">
          <strong>关闭窗口时最小化到托盘</strong>
          <span>{{ integration.closeToTray ? '关闭窗口后仍在托盘里播放' : '关闭窗口即退出程序' }}</span>
        </div>
        <div class="slider-row">
          <button
            class="ghost-button small"
            :class="{ active: integration.closeToTray }"
            :disabled="integrationBusy || !integration.tray"
            data-testid="close-to-tray"
            @click="patchIntegration({ closeToTray: !integration.closeToTray })"
          >
            {{ integration.closeToTray ? '已开启' : '已关闭' }}
          </button>
        </div>
      </div>
    </section>

    <section class="settings-section">
      <h3>音乐库</h3>
      <div class="setting-row">
        <div class="setting-label">
          <strong>{{ formatCount(library.tracks.length) }} 首本地音乐</strong>
          <span>总时长 {{ formatTime(library.totalDuration) }}<template v-if="library.missingIds.length"> · {{ library.missingIds.length }} 首文件已丢失</template></span>
        </div>
        <div class="slider-row">
          <button class="ghost-button small" :disabled="clearing" @click="library.importFiles()">添加文件</button>
          <button class="ghost-button small" :disabled="clearing" @click="library.importFolder()">添加文件夹</button>
          <button class="ghost-button small danger" :disabled="library.tracks.length === 0 || clearing" @click="clearLibrary">
            {{ clearing ? '处理中…' : '清空音乐库记录' }}
          </button>
        </div>
      </div>
      <p class="muted small-text">
        「清空音乐库记录」只会删除 Aurora 的索引数据，不会删除你磁盘上的音乐文件。
      </p>

      <!--
        曲库工具. These two used to sit in the header of 全量曲库, where they competed with the list
        for attention and read as if they acted on whatever was selected. They act on the whole library
        and describe how Aurora processes files, so they belong where the library is configured.
      -->
      <h4 class="settings-subheading">曲库工具</h4>
      <div class="setting-row">
        <div class="setting-label">
          <strong>自动补齐信息</strong>
          <span>
            用已启用的在线音源给缺失的本地歌曲匹配封面与 LRC 歌词，命中后写回音乐库
            <template v-if="library.scrapeProgress">
              · 进行中 {{ library.scrapeProgress.processed }} / {{ library.scrapeProgress.total }}，已命中 {{ library.scrapeProgress.matched }}
            </template>
          </span>
        </div>
        <div class="slider-row">
          <button class="ghost-button small" :disabled="library.scraping" @click="scrapeLibrary">
            {{ library.scraping ? '正在补齐…' : '开始补齐' }}
          </button>
        </div>
      </div>
      <div class="setting-row">
        <div class="setting-label">
          <strong>格式转换（ffmpeg）</strong>
          <span>
            {{ library.ffmpeg.available ? '已检测到 ffmpeg，可转换格式' : '未检测到 ffmpeg，格式转换不可用' }}
            <template v-if="library.ffmpeg.path"> · {{ library.ffmpeg.path }}</template>
          </span>
        </div>
        <div class="slider-row">
          <button class="ghost-button small" @click="checkFfmpeg">重新检测</button>
        </div>
      </div>
    </section>

    <section class="settings-section">
      <h3>音乐源</h3>
      <div class="setting-row">
        <div class="setting-label">
          <strong>音源管理</strong>
          <span>启用 / 禁用、排序、配置与连通性测试，改动立即生效，无需重启</span>
        </div>
        <div class="slider-row">
          <RouterLink to="/settings/sources" class="primary-button small">打开音源管理</RouterLink>
          <RouterLink to="/search" class="ghost-button small">前往搜索</RouterLink>
        </div>
      </div>
      <ul class="source-status">
        <li v-for="source in sourceStore.sources" :key="source.id">
          <span class="feature-dot" :class="source.status === 'ready' ? 'done' : 'pending'"></span>
          <span class="feature-name">
            {{ source.name }}
            <small>v{{ source.version }} · {{ source.description }}</small>
          </span>
          <span class="feature-state" :class="{ done: source.status === 'ready' }">
            {{ !source.enabled ? '已禁用' : source.status === 'ready' ? '可用' : source.status === 'needs-config' ? '需要配置' : source.status === 'initializing' ? '初始化中' : '异常' }}
          </span>
        </li>
      </ul>
      <div class="setting-row">
        <div class="setting-label">
          <strong>下载</strong>
          <span>
            保存位置、文件名格式、并发数量与标签写入都在「下载」页设置。只要音源能解析出播放地址，
            就能把该地址保存成文件；Aurora 自己不判断平台、不绕过任何访问控制。
          </span>
        </div>
        <div class="slider-row">
          <RouterLink class="ghost-button small" to="/downloads">前往下载页</RouterLink>
        </div>
      </div>
    </section>

    <section class="settings-section">
      <h3>数据与备份</h3>
      <div class="setting-row">
        <div class="setting-label"><strong>歌单备份</strong><span>导出为 JSON 文件，可再次导入</span></div>
        <div class="slider-row">
          <button class="ghost-button small" @click="exportPlaylists">导出歌单</button>
          <button class="ghost-button small danger" :disabled="playlists.playlists.length === 0" @click="clearPlaylists">删除全部歌单</button>
        </div>
      </div>
      <div class="setting-row">
        <div class="setting-label"><strong>收藏与历史</strong><span>收藏 {{ collection.favoriteIds.length }} 首 · 历史 {{ collection.history.length }} 条</span></div>
        <div class="slider-row">
          <button class="ghost-button small" :disabled="collection.favoriteIds.length === 0" @click="clearFavorites">清空收藏</button>
          <button class="ghost-button small" :disabled="collection.history.length === 0" @click="clearHistory">清空历史</button>
        </div>
      </div>
      <p class="muted small-text">
        「导出备份」会把设置、收藏、播放历史与歌单一起写成一个 JSON（上面那块）。
      </p>
    </section>

    <section class="settings-section feature-status-section" data-testid="feature-status-section">
      <h3>
        功能状态
        <span class="feature-total" data-testid="feature-total">
          {{ featureGroups.reduce((sum, group) => sum + group.items.filter((item) => item.done).length, 0) }} /
          {{ featureGroups.reduce((sum, group) => sum + group.items.length, 0) }}
        </span>
        <button class="ghost-button small" data-testid="feature-toggle-all" @click="toggleAllGroups">
          {{ everyGroupCollapsed ? '全部展开' : '全部收起' }}
        </button>
      </h3>
      <p class="muted small-text">
        按模块分组，点标题即可收起 / 展开；已经做完的分组默认收起，只留 已实现 / 总数，缺口一眼就能看到。
        已实现的写清边界（例如 ID3 写入只对 MP3 生效），未实现的单独归到最后一组，不写含糊的「部分支持」。
      </p>
      <div v-for="group in featureGroups" :key="group.title" class="feature-group">
        <button
          class="feature-group-head"
          :aria-expanded="!collapsedGroups[group.title]"
          :data-testid="`feature-group-${group.title}`"
          @click="toggleGroup(group.title)"
        >
          <span class="feature-group-caret" :class="{ open: !collapsedGroups[group.title] }">▸</span>
          <span class="feature-group-title">{{ group.title }}</span>
          <span class="feature-group-count" :class="{ pending: group.items.some((item) => !item.done) }">
            {{ group.items.filter((item) => item.done).length }} / {{ group.items.length }}
          </span>
        </button>
        <ul v-show="!collapsedGroups[group.title]" class="feature-list">
          <li v-for="item in group.items" :key="item.name">
            <span :class="['feature-dot', item.done ? 'done' : 'pending']"></span>
            <span class="feature-name">{{ item.name }}</span>
            <span class="feature-state" :class="{ done: item.done }">{{ item.state }}</span>
          </li>
        </ul>
      </div>
    </section>

    <section class="settings-section">
      <h3>关于</h3>
      <div class="about-grid">
        <div><span>应用名称</span><strong>{{ info?.name || 'Aurora Music' }}</strong></div>
        <div><span>版本</span><strong>{{ info?.version || '0.1.0' }}</strong></div>
        <div><span>Electron</span><strong>{{ info?.electron || '—' }}</strong></div>
        <div><span>平台</span><strong>{{ info ? `${info.platform} ${info.arch}` : '—' }}</strong></div>
        <div class="span-2"><span>数据目录</span><strong class="path">{{ info?.dataPath || '—' }}</strong></div>
      </div>
      <p class="muted small-text">
        曲库索引保存在数据目录的 aurora.db（SQLite），library.json 作为同一份数据的镜像一并保留；
        封面缓存在 covers 目录，歌词缓存在 lyrics 目录。
      </p>
    </section>
  </div>
</template>
