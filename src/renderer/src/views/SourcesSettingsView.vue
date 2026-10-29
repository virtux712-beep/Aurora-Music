<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import type { CustomSourceManifest, CustomSourceTemplate } from '../../../shared/customSource'
import type {
  SourceCapabilities,
  SourceCheckAllResult,
  SourceCheckVerdict,
  SourceConfigValue,
  SourceDescriptor,
  SourceHealth,
  SourceStatus,
} from '../../../shared/types'
import EmptyState from '../components/EmptyState.vue'
import { useCustomSourceStore } from '../stores/customSource'
import { usePlatformStore } from '../stores/platform'
import { useSourceAdminStore } from '../stores/sourceAdmin'
import { useSourceStore } from '../stores/source'
import { useUiStore } from '../stores/ui'
import { scriptSourceService, settingsService, sourceService } from '../services/aurora'
import { safeExternalUrl } from '../utils/url'
import type { LxLibraryPreview } from '../../../shared/scriptSource'

/**
 * Music source management.
 *
 * Everything on this page is generated from the plugin's own metadata: capabilities, config fields
 * and status. Adding a plugin therefore requires no change here — the page simply reflects what the
 * SourceManager reports. Toggling a source takes effect immediately (the main process drops its
 * caches and re-reads the enabled set on the next request).
 */
const sourceStore = useSourceStore()
const platformStore = usePlatformStore()
const customStore = useCustomSourceStore()
const adminStore = useSourceAdminStore()
const ui = useUiStore()

const drafts = reactive<Record<string, Record<string, SourceConfigValue>>>({})
const health = reactive<Record<string, SourceHealth | null>>({})
const savingId = ref('')
const testingId = ref('')
const checkingAll = ref(false)
const autoHealthCheck = ref(true)
/** Mirrors `settings.autoGrantSourceHosts`: whether a refused host is granted and retried automatically. */
const autoGrantSourceHosts = ref(true)
/** Mirrors `settings.safeMode`: the strict access mode (no auto-grant, no cleartext, new sources disabled). */
const safeMode = ref(false)
const editorOpen = ref(false)
/**
 * 全量自检的结果。Kept on the page (not in a store) because it is a *moment*: the verdicts describe the
 * network as it was when the button was pressed, and a persisted copy would outlive its own truth.
 */
const batchCheck = ref<SourceCheckAllResult | null>(null)
const checkingBatch = ref(false)
const batchKeyword = ref('')
/** Row order: worst first, so the reason the button was pressed is at the top of the list. */
const VERDICT_ORDER: SourceCheckVerdict[] = ['unauthorized', 'timeout', 'unconfigured', 'inactive', 'error', 'empty', 'ok']
const VERDICT_LABELS: Record<SourceCheckVerdict, string> = {
  unauthorized: '待授权',
  timeout: '超时',
  unconfigured: '待配置',
  inactive: '未加载',
  error: '出错',
  empty: '正常（这个词没结果）',
  ok: '正常',
}
const sortedBatchRows = computed(() =>
  [...(batchCheck.value?.sources ?? [])].sort(
    (left, right) => VERDICT_ORDER.indexOf(left.verdict) - VERDICT_ORDER.indexOf(right.verdict),
  ),
)
const editorText = ref('')
const editorErrors = ref<string[]>([])
const editorSaved = ref('')

const CAPABILITY_LABELS: Array<{ key: keyof SourceCapabilities; label: string }> = [
  { key: 'search', label: '搜索' },
  { key: 'stream', label: '播放' },
  { key: 'lyrics', label: '歌词' },
  { key: 'playlists', label: '歌单' },
  { key: 'playlistDetail', label: '歌单详情' },
  { key: 'albums', label: '专辑' },
  { key: 'artists', label: '艺人' },
  { key: 'recommendations', label: '推荐' },
  { key: 'radio', label: '电台' },
  { key: 'download', label: '下载' },
]

const STATUS_LABELS: Record<SourceStatus, string> = {
  ready: '可用',
  disabled: '已禁用',
  'needs-config': '需要配置',
  initializing: '初始化中',
  error: '异常',
}

/**
 * Kind labels come from the registry, so a new source kind shows up here without a new branch in the
 * layout — the same reason the rest of this page is generated from metadata.
 */
const KIND_LABELS: Record<SourceDescriptor['kind'], string> = {
  declarative: 'API 清单',
  script: 'JS 脚本',
}

const PERMISSION_LABELS: Record<string, string> = {
  network: '网络请求',
  crypto: '加密工具',
}

/** Permissions the runtime actually implements, so the import dialog cannot promise more. */
const SCRIPT_PERMISSIONS = ['network', 'crypto'] as const

const enabledCount = computed(() => sourceStore.sources.filter((source) => source.enabled).length)

function capabilityList(source: SourceDescriptor): string[] {
  return CAPABILITY_LABELS.filter((item) => source.capabilities[item.key]).map((item) => item.label)
}

function manifestCapabilities(manifest: CustomSourceManifest): string[] {
  return CAPABILITY_LABELS.filter((item) => manifest.capabilities?.[item.key]).map((item) => item.label)
}

function kindLabel(source: SourceDescriptor): string {
  const base = KIND_LABELS[source.kind] ?? source.kind
  return source.runtime && source.runtime !== 'aurora' ? `${base} · ${source.runtime}` : base
}

function permissionLabel(permission: string): string {
  return PERMISSION_LABELS[permission] ?? permission
}

function formatClock(at: number): string {
  return new Date(at).toLocaleTimeString()
}

/** Pending hosts are what the runtime refused; granting one is a single click. */
function pendingFor(sourceId: string): string[] {
  return adminStore.pendingHosts.filter((pending) => pending.sourceId === sourceId).map((pending) => pending.host)
}

async function grantHosts(sourceId: string, hosts: string[]): Promise<void> {
  await adminStore.grant(sourceId, hosts)
  ui.notify(`已授权 ${hosts.join('、')}，音源已重新加载`, 'success')
}

async function inspectScript(id: string): Promise<void> {
  const result = await adminStore.inspect(id)
  ui.notify(result.message, result.ok ? 'success' : 'error')
}

async function reloadScript(id: string): Promise<void> {
  const ok = await adminStore.reload(id)
  ui.notify(ok ? '音源已重新加载' : adminStore.errors[0] ?? '重新加载失败', ok ? 'success' : 'error')
}

async function removeScript(id: string): Promise<void> {
  const ok = await adminStore.remove(id)
  ui.notify(ok ? '音源已删除（脚本文件一并移除）' : adminStore.errors[0] ?? '删除失败', ok ? 'success' : 'error')
}

async function exportScript(id: string): Promise<void> {
  const text = await adminStore.exportScript(id)
  if (!text) {
    ui.notify('导出失败：找不到脚本文件', 'error')
    return
  }
  const url = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `${id}.js`
  link.click()
  URL.revokeObjectURL(url)
  ui.notify('脚本已导出', 'success')
}

/**
 * The extra sentence every install path says when 安全模式 is holding the source back.
 *
 * The decision is **not** made here. It comes from the main process (`disabledByPolicy` on the save
 * result), because this page cannot tell the two cases apart on its own: safe mode only holds back *new*
 * installs, and re-installing a source the user already enabled leaves it live. Saying "默认禁用" to
 * someone whose source just went live is a policy explained wrongly, which is worse than unexplained.
 */
function installNotice(message: string): void {
  ui.notify(
    adminStore.disabledByPolicy ? `${message}；安全模式已开启，该音源默认禁用，需在列表里手动启用` : message,
    'success',
  )
}

async function installDetected(): Promise<void> {
  const ok = await adminStore.install()
  if (ok) installNotice('音源已安装并注册')
  else ui.notify(adminStore.errors[0] ?? '安装失败', 'error')
}

async function installFromFile(): Promise<void> {
  const result = await adminStore.importFromFile()
  if (result.summary === '已取消') return
  if (result.kind === 'unknown') {
    ui.notify(result.summary, 'error')
    // The detector already worked out *why* ("这是 ZIP 压缩包"、"含 NUL 字节") and the reason was
    // being dropped here, leaving the summary to answer a question it had just refused to ask.
    for (const error of result.errors.slice(0, 2)) ui.notify(error, 'error')
    return
  }
  /*
   * Detection, not installation: nothing has been written yet, so there is no "disabled" state to report —
   * the previous version appended the safe-mode sentence to this summary too, which told the user a source
   * had been held back before they had even pressed install.
   */
  ui.notify(result.summary, 'success')
}

async function installFromPaste(): Promise<void> {
  const text = pasteText.value.trim()
  if (!text) {
    ui.notify('先粘贴脚本或清单内容', 'error')
    return
  }
  await adminStore.detect(text, 'pasted.js')
}

const pasteText = ref('')

/*
 * 洛雪音源库导入。
 *
 * The file is picked and read in the main process; this side only receives a per-source summary, and
 * the import names ids. So the preview list below is the *whole* contract — there is no path here
 * that could import something the user did not just look at.
 */
const lxLibrary = ref<LxLibraryPreview | null>(null)
const lxSelected = ref<string[]>([])
const lxBusy = ref(false)

async function openLxLibrary(): Promise<void> {
  lxBusy.value = true
  try {
    const preview = await scriptSourceService.lxLibraryOpen()
    // Cancelling the dialog returns an empty result with no error; only a real failure has errors.
    if (!preview.fileName) {
      for (const error of preview.errors) ui.notify(error, 'error')
      return
    }
    lxLibrary.value = preview
    // Everything that loaded is selected by default; a broken source is shown but not imported.
    lxSelected.value = preview.items.filter((item) => item.ok).map((item) => item.id)
    for (const error of preview.errors) ui.notify(error, 'error')
    if (preview.items.length === 0) ui.notify('这个文件里没有找到任何音源', 'error')
  } finally {
    lxBusy.value = false
  }
}

function toggleLxItem(id: string): void {
  lxSelected.value = lxSelected.value.includes(id)
    ? lxSelected.value.filter((item) => item !== id)
    : [...lxSelected.value, id]
}

async function importLxLibrary(): Promise<void> {
  if (lxSelected.value.length === 0) {
    ui.notify('先勾选要导入的音源', 'error')
    return
  }
  lxBusy.value = true
  try {
    const result = await scriptSourceService.lxLibraryImport(lxSelected.value)
    if (result.errors.length > 0) {
      for (const error of result.errors) ui.notify(error, 'error')
    }
    for (const failure of result.failed) ui.notify(`${failure.name}：${failure.errors[0] ?? '导入失败'}`, 'error')
    if (result.added > 0) {
      const failedPart = result.failed.length > 0 ? `，${result.failed.length} 个失败` : ''
      ui.notify(`已导入 ${result.added} 个音源${failedPart}`, 'success')
      lxLibrary.value = null
      lxSelected.value = []
      await adminStore.load(true)
      await sourceStore.load(true)
    } else if (result.failed.length === 0) {
      ui.notify('没有音源被导入', 'error')
    }
  } finally {
    lxBusy.value = false
  }
}

function closeLxLibrary(): void {
  void scriptSourceService.lxLibraryCancel()
  lxLibrary.value = null
  lxSelected.value = []
}

/**
 * Drafts are built in a watcher, never during render: writing to a reactive object from inside a
 * template would schedule another render and loop forever.
 */
function buildDrafts(): void {
  for (const source of sourceStore.sources) {
    if (drafts[source.id]) continue
    const initial: Record<string, SourceConfigValue> = {}
    for (const field of source.configSchema.fields) {
      // Secrets never come back from the main process; that field starts empty and shows "已配置".
      initial[field.key] = field.secret ? '' : (source.config[field.key] ?? field.default ?? (field.type === 'boolean' ? false : ''))
    }
    drafts[source.id] = initial
  }
}

watch(() => sourceStore.sources, buildDrafts, { immediate: true })

onMounted(() => {
  /*
   * Forced, including the pending-host list: the interesting moment is *returning* to this page after
   * a source was refused somewhere else. With the cached load, the page showed the list as it was
   * when it was first opened — usually before the refusal — so the host that needed granting was not
   * on screen and the only way forward looked like reinstalling the source.
   */
  void adminStore.load(true)
  void platformStore.load()
})

function draftValue(source: SourceDescriptor, key: string): SourceConfigValue | '' {
  return drafts[source.id]?.[key] ?? ''
}

function onInput(source: SourceDescriptor, key: string, value: string, type: string): void {
  const bucket = drafts[source.id]
  if (!bucket) return
  bucket[key] = type === 'boolean' ? value === 'true' : type === 'number' ? Number(value) : value
}

async function save(source: SourceDescriptor): Promise<void> {
  savingId.value = source.id
  try {
    await sourceStore.setConfig(source.id, { ...(drafts[source.id] ?? {}) })
    const bucket = drafts[source.id]
    if (bucket) {
      for (const field of source.configSchema.fields) {
        if (field.secret) bucket[field.key] = ''
      }
    }
    ui.notify(`已保存「${source.name}」的配置`, 'success')
  } catch (error) {
    ui.notify(error instanceof Error ? error.message : '保存配置失败', 'error')
  } finally {
    savingId.value = ''
  }
}

async function test(source: SourceDescriptor): Promise<void> {
  testingId.value = source.id
  const result = await sourceStore.checkHealth(source.id)
  health[source.id] = result
  testingId.value = ''
  if (result?.ok) ui.notify(`「${source.name}」连接正常${result.latency ? `（${result.latency}ms）` : ''}`, 'success')
  else ui.notify(`「${source.name}」连接失败：${result?.message ?? '未知原因'}`, 'error')
}

async function toggle(source: SourceDescriptor): Promise<void> {
  await sourceStore.setEnabled(source.id, !source.enabled)
  ui.notify(source.enabled ? `已启用「${source.name}」` : `已禁用「${source.name}」（立即生效）`, 'info')
}

async function checkAll(): Promise<void> {
  checkingAll.value = true
  try {
    // Sequential on purpose: probing every source at once would flood a slow network.
    for (const source of sourceStore.sources) {
      if (!source.enabled) continue
      health[source.id] = await sourceStore.checkHealth(source.id)
    }
    const failed = sourceStore.sources.filter((source) => source.enabled && health[source.id]?.ok === false).length
    ui.notify(failed === 0 ? '所有已启用音源连接正常' : `${failed} 个音源暂时不可用（其他音源不受影响）`, failed === 0 ? 'success' : 'error')
  } finally {
    checkingAll.value = false
  }
}

/**
 * 全量自检：run the real check over every enabled source and report categories.
 *
 * Distinct from 检查全部 above on purpose. That one asks the cheap "is it reachable" question and paints a
 * dot; this one does what a single source's 自检 does (a real search, a real resolve) across the whole list,
 * which is what "换了一台机器 / 换了一张网，谁还能用" actually needs. Neither replaces the other: the cheap
 * one is for watching, this one is for the morning after.
 */
async function runBatchCheck(repair = false): Promise<void> {
  checkingBatch.value = true
  try {
    const result = await sourceService.selfCheckAll({
      repair,
      ...(batchKeyword.value.trim() ? { keyword: batchKeyword.value.trim() } : {}),
    })
    batchCheck.value = result
    /*
     * The toast summarises; the panel keeps the detail. Both come from the same run, so they cannot
     * disagree — which they would if the toast counted on its own.
     */
    const needsAttention = result.counts.unauthorized + result.counts.timeout + result.counts.error + result.counts.inactive
    ui.notify(result.headline, needsAttention > 0 ? 'error' : 'success')
    // A granted host changes the pending list the cards below draw from.
    if (repair) await Promise.all([adminStore.refreshPending(), adminStore.load(true)])
  } finally {
    checkingBatch.value = false
  }
}

/**
 * Grants a host straight from a batch row, then re-runs the batch.
 *
 * Re-running rather than patching the row in place is deliberate: the verdict is computed in the main
 * process (it is the same code the source's own page shows), and re-classifying it here would be a second
 * implementation of that rule — the one thing this feature cannot afford, since the whole point is that
 * the list agrees with the pages it links to. The cost of the re-run is bounded (two at a time).
 */
async function grantBatchHosts(sourceId: string, hosts: string[]): Promise<void> {
  await grantHosts(sourceId, hosts)
  await runBatchCheck()
}

async function toggleAutoHealth(): Promise<void> {
  autoHealthCheck.value = !autoHealthCheck.value
  await settingsService.set({ autoHealthCheck: autoHealthCheck.value })
  ui.notify(autoHealthCheck.value ? '已开启后台自动健康检查' : '已关闭后台自动健康检查', 'info')
}

/**
 * 播放时自动允许音源申请的主机。
 *
 * 关掉之后，被拒的主机会退回“拒绝 + 在音源卡片上一键允许”的严格行为——这正是这个开关的意义：
 * 自动化是可撤销的策略，而不是把授权默认交给脚本。
 */
async function toggleAutoGrant(): Promise<void> {
  autoGrantSourceHosts.value = !autoGrantSourceHosts.value
  await settingsService.set({ autoGrantSourceHosts: autoGrantSourceHosts.value })
  ui.notify(
    autoGrantSourceHosts.value
      ? '已开启：播放时遇到未授权主机会自动允许并重试'
      : '已关闭：未授权主机会拒绝，需要你在音源卡片上点「允许」',
    'info',
  )
}

/**
 * 安全模式（平台访问）。
 *
 * 开启后三条都真实生效，而且都在请求路径上、不是界面上的样子：未授权主机不再自动放行（会盖过上一个开关）、
 * 明文 <code>http://</code> 的接口请求被拒、新装的音源默认禁用（不加载、不注册、不会联网）。
 * 所以在开关旁边直接说清代价：很多音源只用 http，开了会需要逐个手动启用。
 */
async function toggleSafeMode(): Promise<void> {
  const next = !safeMode.value
  safeMode.value = next
  await settingsService.set({ safeMode: next })
  ui.notify(
    next
      ? '安全模式已开启：拒绝明文 http 接口请求、不再自动放行主机、新装音源默认禁用'
      : '安全模式已关闭：授权与联网恢复为原来的行为',
    'info',
  )
}

/* ----------------------------------------------------------------- 自定义音源 */

/** A minimal, valid manifest the user can edit instead of writing JSON from scratch. */
function manifestTemplate(id = 'my-source'): string {
  return JSON.stringify(
    {
      apiVersion: '1',
      id,
      name: '我的音源',
      version: '1.0.0',
      author: '我',
      description: '示例：一个返回 JSON 的曲库接口',
      homepage: 'https://example.com',
      license: 'CC BY 4.0',
      capabilities: { search: true, stream: true },
      permissions: ['network'],
      allowedHosts: ['api.example.com'],
      search: {
        url: 'https://api.example.com/search',
        query: { q: '{query}', limit: '{limit}' },
        resultsPath: 'results',
        fields: {
          id: 'id',
          title: 'title',
          artist: 'artist.name',
          album: 'album.title',
          cover: 'cover',
          duration: 'duration',
          durationUnit: 'seconds',
          streamUrl: 'stream',
        },
      },
    },
    null,
    2,
  )
}

function openEditor(raw?: string): void {
  editorText.value = raw ?? manifestTemplate()
  editorErrors.value = []
  editorSaved.value = ''
  editorOpen.value = true
}

/**
 * 新建一个自己的音源 —— 这条路径不运行任何脚本，也就没有“协议”需要遵守。
 *
 * This is the third install route, and the only one that needs no runtime at all: a manifest is URLs,
 * query templates and JSON paths, and it goes through the same validator whether it was hand-written,
 * pasted or imported. No sandbox script, no LX bridge, nothing to execute — which is exactly why it can
 * be offered next to 「安装 .js 脚本」 without asking the user to trust anything first.
 *
 * The id is made unique up front so the starter manifest cannot be blocked by a name collision on the
 * very first save (`my-source`, then `my-source-2`, …).
 */
function newCustomSource(): void {
  const taken = new Set(customStore.manifests.map((item) => item.id))
  let id = 'my-source'
  for (let index = 2; taken.has(id); index += 1) id = `my-source-${index}`
  openEditor(manifestTemplate(id))
  ui.notify('已新建一个空白音源：填好接口地址与字段映射后保存，全程不运行任何脚本', 'info')
}

function closeEditor(): void {
  editorOpen.value = false
  editorErrors.value = []
}

/** Loads a shipped template into the editor: the user still reviews and saves it themselves. */
function loadTemplate(template: CustomSourceTemplate): void {
  editorText.value = template.json
  editorErrors.value = []
  editorSaved.value = ''
  ui.notify(`${template.name}：${template.description}`, 'info')
}

async function editManifest(manifest: CustomSourceManifest): Promise<void> {
  const raw = await customStore.exportManifest(manifest.id)
  if (!raw) {
    ui.notify('无法读取该音源的定义', 'error')
    return
  }
  openEditor(raw)
}

async function validateEditor(): Promise<void> {
  editorErrors.value = await customStore.validate(editorText.value)
  editorSaved.value = ''
  if (editorErrors.value.length === 0) ui.notify('校验通过，可以保存', 'success')
}

async function saveEditor(): Promise<void> {
  const ok = await customStore.save(editorText.value)
  editorErrors.value = customStore.errors
  if (!ok) {
    ui.notify(`保存失败：${customStore.errors[0] ?? '未知原因'}`, 'error')
    return
  }
  // Same source of truth as the script paths: the main process' answer, not this page's safe-mode flag.
  editorSaved.value = customStore.disabledByPolicy
    ? '已保存。安全模式下新音源为禁用状态，在列表里启用后才会联网'
    : '已保存并立即注册，无需重启 Aurora'
  ui.notify(
    customStore.disabledByPolicy ? '自定义音源已保存；安全模式已开启，该音源默认禁用' : '自定义音源已保存并生效',
    'success',
  )
}

async function removeManifest(manifest: CustomSourceManifest): Promise<void> {
  if (!window.confirm(`确定要删除自定义音源「${manifest.name}」吗？该音源的配置会一并清除。`)) return
  const ok = await customStore.remove(manifest.id)
  ui.notify(ok ? `已删除「${manifest.name}」` : customStore.errors[0] ?? '删除失败', ok ? 'success' : 'error')
}

async function exportManifest(manifest: CustomSourceManifest): Promise<void> {
  const raw = await customStore.exportManifest(manifest.id)
  if (!raw) return
  const blob = new Blob([raw], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `aurora-source-${manifest.id}.json`
  anchor.click()
  URL.revokeObjectURL(url)
}

/** Imports a manifest from a file into the editor (it still has to pass validation). */
async function importManifestFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  const text = await file.text()
  openEditor(text)
}

onMounted(async () => {
  await Promise.all([sourceStore.load(true), customStore.load(true)])
  const settings = await settingsService.get()
  autoHealthCheck.value = settings.autoHealthCheck
  autoGrantSourceHosts.value = settings.autoGrantSourceHosts
  safeMode.value = settings.safeMode
})
</script>

<template>
  <div class="view">
    <header class="view-header">
      <div>
        <h1>音源管理</h1>
        <p class="muted">
          共 {{ sourceStore.sources.length }} 个音源，{{ enabledCount }} 个已启用。启用状态、顺序与配置会立即生效，不需要重启 Aurora。
        </p>
      </div>
      <div class="view-actions">
        <button class="ghost-button" :disabled="checkingAll" @click="checkAll">
          {{ checkingAll ? '检查中…' : '检查全部' }}
        </button>
        <button
          class="ghost-button"
          data-check-all-run
          :disabled="checkingBatch"
          @click="runBatchCheck()"
        >
          {{ checkingBatch ? '自检中…' : '全量自检' }}
        </button>
        <button class="ghost-button" @click="sourceStore.load(true)">刷新</button>
        <RouterLink to="/settings" class="ghost-button">返回设置</RouterLink>
      </div>
    </header>

    <!--
      全量自检的面板。默认不占地方，跑过一次才出现，并且每行都是一个结论加一句“下一步”——
      “谁未授权、谁超时、谁没返回”是这一整块存在的理由。
    -->
    <section v-if="batchCheck" class="check-all-panel" data-check-all-panel>
      <header class="check-all-head">
        <div>
          <strong>{{ batchCheck.headline }}</strong>
          <span class="muted small-text">
            · 关键词「{{ batchCheck.keyword }}」 · {{ formatClock(batchCheck.at) }}
            <template v-if="batchCheck.skipped > 0"> · 另有 {{ batchCheck.skipped }} 个已停用未检查</template>
          </span>
        </div>
        <div class="slider-row">
          <input v-model="batchKeyword" class="glass-input check-keyword" placeholder="搜索关键词（默认 周杰伦）" />
          <button class="ghost-button small" :disabled="checkingBatch" @click="runBatchCheck()">重跑</button>
          <button
            class="ghost-button small"
            :disabled="checkingBatch"
            :title="safeMode ? '安全模式已开启：不会自动允许主机' : '只修“被拒”这一种失败，别的不重试'"
            @click="runBatchCheck(true)"
          >
            自检并修复
          </button>
          <button class="ghost-button small" @click="batchCheck = null">收起</button>
        </div>
      </header>
      <ul class="check-all-list">
        <li v-for="row in sortedBatchRows" :key="row.id" class="check-all-row" :class="row.verdict">
          <span class="check-verdict">{{ VERDICT_LABELS[row.verdict] }}</span>
          <div class="check-why">
            <strong>{{ row.name }}</strong>
            <span class="muted small-text">{{ row.kind === 'declarative' ? '声明式' : '脚本' }} · {{ row.detail }}</span>
          </div>
          <div class="check-row-actions">
            <button
              v-if="row.pendingHosts.length > 0"
              class="ghost-button small"
              data-check-all-grant
              @click="grantBatchHosts(row.id, row.pendingHosts)"
            >
              允许 {{ row.pendingHosts[0] }}{{ row.pendingHosts.length > 1 ? ` 等 ${row.pendingHosts.length} 台` : '' }}
            </button>
            <RouterLink :to="`/settings/sources/${row.id}`" class="ghost-button small">详情</RouterLink>
          </div>
        </li>
      </ul>
    </section>

    <div class="notice-card subtle">
      <span class="notice-icon">🧩</span>
      <div>
        <strong>音源由你提供，Runtime 负责加载</strong>
        <p>
          上方列表是**音源插件**（你安装的 .js 脚本 / 声明式清单），下方「平台支持」是只读的平台能力与解析器计数；
          播放地址由声明该平台的已启用插件解析，平台本身不可安装/卸载。脚本在独立沙箱中运行，出网必须经过按主机的运行时授权。
        </p>
      </div>
    </div>

    <div class="setting-row flat">
      <div class="setting-label">
        <strong>后台自动健康检查</strong>
        <span>每隔一段时间探测已启用音源的连通性，失败只会标记该音源，并在搜索页显示为不可用，不会影响其他音源</span>
      </div>
      <div class="slider-row">
        <button class="ghost-button small" @click="toggleAutoHealth">
          {{ autoHealthCheck ? '已开启（点击关闭）' : '已关闭（点击开启）' }}
        </button>
      </div>
    </div>

    <div class="setting-row flat">
      <div class="setting-label">
        <strong>播放时自动允许音源申请的主机</strong>
        <span>
          很多音源要到取播放地址时才知道自己要访问哪个主机（主机名是运行时拼出来的），安装时的清单看不到它。
          开启后，首次被拒的主机会被自动允许并立即重试，授权记在该音源的允许列表里（可随时撤销）；
          关闭后恢复严格行为：拒绝该请求，并在音源卡片上给出「允许」按钮。
        </span>
      </div>
      <div class="slider-row">
        <button
          class="ghost-button small"
          data-auto-grant
          :disabled="safeMode"
          :title="safeMode ? '安全模式已开启，此项被强制关闭' : ''"
          @click="toggleAutoGrant"
        >
          {{ safeMode ? '安全模式下强制关闭' : autoGrantSourceHosts ? '已开启（点击关闭）' : '已关闭（点击开启）' }}
        </button>
      </div>
    </div>

    <!--
      安全模式。先说代价，再说好处：它确实会让一批只用明文 http 的音源需要逐个手动放行，
      而一个不说清代价的安全开关，用起来就和“这东西坏了”没区别。
    -->
    <div class="setting-row flat">
      <div class="setting-label">
        <strong>安全模式（平台访问）</strong>
        <span>
          开启后三项策略同时生效：① 未授权主机不再自动放行（上面的开关失去作用）；
          ② 拒绝明文 http:// 的接口请求（音频字节不受影响，仍按主机白名单中继）；
          ③ 之后新装/导入的音源默认禁用，需要你在列表里手动启用后才会加载或联网。
          代价：只用 http 接口的音源会解析失败，报错里会写明是安全模式拒的。
        </span>
      </div>
      <div class="slider-row">
        <button
          class="ghost-button small"
          :class="{ active: safeMode }"
          data-safe-mode
          @click="toggleSafeMode"
        >
          {{ safeMode ? '已开启（点击关闭）' : '已关闭（点击开启）' }}
        </button>
      </div>
    </div>

    <div v-if="sourceStore.loading" class="skeleton-list">
      <div v-for="row in 3" :key="row" class="skeleton-row">
        <span class="skeleton-cover"></span>
        <span class="skeleton-line"></span>
      </div>
    </div>

    <section class="settings-section" v-if="!sourceStore.loading">
      <header class="section-heading">
        <div>
          <h3>平台支持</h3>
          <p class="muted small-text">
            平台是只读的音乐服务身份（搜索能力），音源插件负责解析播放地址。安装音源后，对应平台会显示为「在线」（详情里写着有几个音源可以解析）；没有可用解析器时搜索仍可执行，但播放会提示去安装音源。
          </p>
        </div>
        <button class="ghost-button small" :disabled="platformStore.loading" @click="platformStore.refreshHealth()">刷新平台状态</button>
      </header>
      <div v-if="platformStore.loading" class="skeleton-list">
        <div v-for="row in 3" :key="row" class="skeleton-row"><span class="skeleton-cover"></span><span class="skeleton-line"></span></div>
      </div>
      <ul v-else class="custom-source-list">
        <li v-for="platform in platformStore.platforms" :key="platform.id" class="custom-source-item">
          <div class="custom-source-main">
            <strong>{{ platform.icon || '♫' }} {{ platformStore.label(platform.id) }}</strong>
            <small>{{ platform.id }} · {{ platform.description }}</small>
            <div class="source-caps">
              <span v-for="quality in platform.qualities" :key="quality" class="quality-chip">{{ quality }}</span>
            </div>
          </div>
          <div class="slider-row">
            <!--
              The row answers one question — is this platform playable right now — so the pill says 在线 / 离线
              and nothing else. The count stays reachable on hover: it is the *reason* for the state, not the
              state itself, and a number in the badge reads as a score to compare rather than as a capability.
            -->
            <span
              class="status-pill"
              :class="platformStore.healthFor(platform.id)?.health.ok ? 'ready' : 'error'"
              :title="`${platformStore.healthFor(platform.id)?.resolverCount ?? 0} 个已启用音源声明了该平台`"
            >
              {{ platformStore.healthFor(platform.id)?.health.ok ? '在线' : '离线' }}
            </span>
            <span class="muted small-text">{{ platformStore.healthFor(platform.id)?.health.message || '—' }}</span>
          </div>
        </li>
      </ul>
    </section>

    <EmptyState
      v-if="!sourceStore.loading && sourceStore.sources.length === 0"
      icon="⌁"
      title="还没有安装任何音源插件"
      text="在下方「安装音源」中添加 .js 脚本或声明式清单，或一键导入洛雪音源库；平台搜索（青空纯音/红云心语/绿洲曲海/蔚蓝声浪/暖橙彩韵）始终可用，是否能播放取决于已安装音源对该平台的解析能力。"
    />

    <section v-if="sourceStore.sources.length > 0" class="source-list">
      <article v-for="source in sourceStore.sources" :key="source.id" class="source-panel" :class="{ off: !source.enabled }">
        <header class="source-panel-head">
          <div class="source-identity">
            <span class="source-logo">{{ source.icon || '♪' }}</span>
            <div>
              <strong>{{ source.name }}</strong>
              <small>
                v{{ source.version }}
                <template v-if="source.author"> · {{ source.author }}</template>
                <template v-if="source.apiVersion"> · apiVersion {{ source.apiVersion }}</template>
              </small>
              <div class="kind-row">
                <span class="kind-chip">{{ kindLabel(source) }}</span>
                <span v-for="permission in source.permissions" :key="permission" class="perm-chip">
                  {{ permissionLabel(permission) }}
                </span>
              </div>
            </div>
          </div>

          <div class="source-head-actions">
            <span class="status-pill" :class="source.status">{{ STATUS_LABELS[source.status] }}</span>
            <!-- 每个音源都有自己的管理页：自检、授权、配置与错误历史都在那里，互不影响。 -->
            <RouterLink class="ghost-button small" :to="`/settings/sources/${source.id}`">管理</RouterLink>
            <button
              class="switch"
              :class="{ on: source.enabled }"
              role="switch"
              :aria-checked="source.enabled"
              :title="source.enabled ? '禁用音源' : '启用音源'"
              :disabled="sourceStore.busyId === source.id"
              @click="toggle(source)"
            >
              <span class="switch-knob"></span>
            </button>
            <div class="order-buttons">
              <button class="icon-action" title="上移（影响搜索顺序）" :disabled="source.order === 0" @click="sourceStore.move(source.id, -1)">↑</button>
              <button class="icon-action" title="下移（影响搜索顺序）" :disabled="source.order === sourceStore.sources.length - 1" @click="sourceStore.move(source.id, 1)">↓</button>
            </div>
          </div>
        </header>

        <p class="source-desc">{{ source.description }}</p>

        <div class="source-caps">
          <span v-for="label in capabilityList(source)" :key="label" class="cap-chip">{{ label }}</span>
          <span v-if="capabilityList(source).length === 0" class="muted small-text">未声明任何能力</span>
        </div>

        <div v-if="source.platforms.length > 0 || source.qualities.length > 0" class="source-caps">
          <span v-for="platform in source.platforms" :key="platform.id" class="platform-chip">
            {{ platform.icon || '♫' }} {{ platformStore.labelIfKnown(platform.id) ?? platform.id }}
          </span>
          <span v-for="quality in source.qualities" :key="quality" class="quality-chip">{{ quality }}</span>
        </div>

        <p v-if="source.capabilityGaps.length > 0" class="capability-gap">
          ⚠ 该音源声明了「{{ source.capabilityGaps.join(' / ') }}」能力，但没有对应实现，Aurora 不会展示这些入口。
        </p>

        <div v-if="pendingFor(source.id).length > 0" class="pending-hosts">
          <p class="small-text">
            该音源请求了尚未授权的主机。安装与联网是两件事：授权后音源会立即重新加载，无需重启。
          </p>
          <div class="slider-row">
            <button
              v-for="host in pendingFor(source.id)"
              :key="host"
              class="ghost-button small"
              :disabled="adminStore.busy"
              @click="grantHosts(source.id, [host])"
            >
              允许 {{ host }}
            </button>
            <button
              class="ghost-button small"
              :disabled="adminStore.busy"
              @click="grantHosts(source.id, pendingFor(source.id))"
            >
              全部允许
            </button>
          </div>
        </div>

        <dl class="source-facts">
          <div><dt>许可</dt><dd>{{ source.license }}</dd></div>
          <div>
            <dt>主页</dt>
            <dd>
              <!-- The homepage is whatever the source file declared, so it is validated before it can
                   become something the main process is asked to open. -->
              <a v-if="safeExternalUrl(source.homepage)" :href="safeExternalUrl(source.homepage)" target="_blank" rel="noreferrer">{{ source.homepage }}</a>
              <template v-else>{{ source.homepage }}</template>
            </dd>
          </div>
          <div v-if="source.health"><dt>上次检查</dt><dd>{{ source.health.ok ? '正常' : '失败' }} · {{ source.health.message || '—' }}</dd></div>
        </dl>

        <details v-if="source.errorLog.length > 0" class="error-log">
          <summary>错误日志（最近 {{ source.errorLog.length }} 条）</summary>
          <ul>
            <li v-for="entry in source.errorLog.slice(0, 6)" :key="`${entry.at}-${entry.operation}`">
              <span class="log-time">{{ formatClock(entry.at) }}</span>
              <span class="log-op">{{ entry.operation }}</span>
              <span class="log-code">{{ entry.code }}</span>
              <span class="log-message">{{ entry.message }}</span>
            </li>
          </ul>
        </details>

        <form v-if="source.configSchema.fields.length > 0" class="source-config" @submit.prevent="save(source)">
          <label v-for="field in source.configSchema.fields" :key="field.key" class="config-field">
            <span class="config-label">
              {{ field.label }}
              <em v-if="field.required !== false" class="required">必填</em>
              <em v-if="field.secret && source.secretKeys[field.key] && !source.secretsPlain" class="secret-set">已配置（加密存储）</em>
              <em v-if="field.secret && source.secretKeys[field.key] && source.secretsPlain" class="secret-set">已配置（明文存储：本机没有系统密钥环，密钥以明文保存在本机文件中）</em>
            </span>
            <input
              v-if="field.type !== 'boolean'"
              class="text-input"
              :type="field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text'"
              :placeholder="field.placeholder || field.description || ''"
              :value="draftValue(source, field.key)"
              spellcheck="false"
              autocomplete="off"
              @input="onInput(source, field.key, ($event.target as HTMLInputElement).value, field.type)"
            />
            <select
              v-else
              class="text-input"
              :value="String(draftValue(source, field.key))"
              @change="onInput(source, field.key, ($event.target as HTMLSelectElement).value, 'boolean')"
            >
              <option value="false">关闭</option>
              <option value="true">开启</option>
            </select>
            <small v-if="field.description" class="config-hint">{{ field.description }}</small>
          </label>

          <div class="config-actions">
            <button class="primary-button small" type="submit" :disabled="savingId === source.id">
              {{ savingId === source.id ? '保存中…' : '保存配置' }}
            </button>
            <button class="ghost-button small" type="button" :disabled="testingId === source.id" @click="test(source)">
              {{ testingId === source.id ? '测试中…' : '测试连接' }}
            </button>
            <span v-if="health[source.id]" class="config-result" :class="{ ok: health[source.id]?.ok }">
              {{ health[source.id]?.ok ? `连接正常${health[source.id]?.latency ? `（${health[source.id]?.latency}ms）` : ''}` : health[source.id]?.message }}
            </span>
          </div>
        </form>

        <div v-else class="config-actions">
          <button class="ghost-button small" :disabled="testingId === source.id" @click="test(source)">
            {{ testingId === source.id ? '测试中…' : '测试连接' }}
          </button>
          <span class="muted small-text">这个音源无需配置。</span>
        </div>

        <p v-if="!source.enabled" class="muted small-text">
          已禁用：搜索、发现与音源 Tab 都不会再请求它，其他音源不受影响。
        </p>
      </article>
    </section>

    <section class="settings-section">
      <header class="section-heading">
        <div>
          <h3>安装音源</h3>
          <p class="muted small-text">
            安装你自己的音乐 Source：Aurora 根据 Source Runtime 能力加载并管理，不要求它属于任何已批准的列表。
            支持 <code>.js</code>（Aurora 脚本契约或洛雪风格协议）与 <code>.json</code>（声明式 API 清单）。
            能否安装只看格式能否识别、Runtime 能否执行；<strong>能不能联网是运行时的另一件事</strong>，由你在下面按主机授权。
          </p>
        </div>
        <div class="slider-row">
          <button class="primary-button small" :disabled="adminStore.busy" @click="installFromFile">安装音源（选择文件）</button>
          <button class="ghost-button small" :disabled="lxBusy" @click="openLxLibrary">
            {{ lxBusy ? '读取中…' : '导入洛雪音源库（user_api.json）' }}
          </button>
          <!--
            第三条安装路径，也是唯一不需要 Runtime 的一条：直接新建一个自己的音源。
            它不经过洛雪协议，也不经过 Aurora 的脚本契约——清单里只有 URL、参数模板和字段映射，
            主进程执行不了任何来自它的代码。
          -->
          <button class="ghost-button small" data-new-custom-source @click="newCustomSource">
            新增自定义音源（不用脚本协议）
          </button>
        </div>
      </header>

      <!--
        洛雪音源库预览。

        每个音源都真在沙箱里跑过一次，所以这里能说的不只是“文件是 JSON”，而是这个音源能不能起来、
        声明了哪些平台——一个二十个音源的库里死几个是常事，导入前先说清楚比事后追查便宜。
      -->
      <div v-if="lxLibrary" class="import-result script">
        <strong>洛雪音源库：{{ lxLibrary.fileName }}</strong>
        <p class="muted small-text">
          找到 {{ lxLibrary.items.length }} 个音源，已勾选 {{ lxSelected.length }} 个。每个都在沙箱里真实加载过：
          标「加载失败」的仍可勾选，但多半装上也跑不起来。
        </p>

        <ul class="lx-library-list">
          <li v-for="item in lxLibrary.items" :key="item.id" class="lx-library-item" :class="{ broken: !item.ok }">
            <label class="checkbox-field">
              <input type="checkbox" :checked="lxSelected.includes(item.id)" @change="toggleLxItem(item.id)" />
              <span>
                <strong>{{ item.name }}</strong>
                <small>
                  v{{ item.version }}
                  <template v-if="item.author"> · {{ item.author }}</template>
                  · {{ item.runtime }} · {{ Math.max(1, Math.round(item.bytes / 1024)) }}KB
                  <template v-if="item.installed"> · 已安装（导入即更新）</template>
                </small>
              </span>
            </label>
            <div class="source-caps">
              <span v-for="platform in item.platforms" :key="platform.id" class="platform-chip">
                {{ platformStore.labelIfKnown(platform.id) ?? platform.id }}
              </span>
              <span v-for="action in item.actions" :key="action" class="cap-chip">{{ action }}</span>
            </div>
            <ul v-if="item.errors.length > 0" class="import-errors">
              <li v-for="error in item.errors" :key="error">{{ error }}</li>
            </ul>
          </li>
        </ul>

        <div class="slider-row">
          <button class="primary-button small" :disabled="lxBusy || lxSelected.length === 0" @click="importLxLibrary">
            {{ lxBusy ? '导入中…' : `导入选中的 ${lxSelected.length} 个音源` }}
          </button>
          <button class="ghost-button small" :disabled="lxBusy" @click="closeLxLibrary">取消</button>
        </div>
      </div>

      <div class="paste-block">
        <textarea
          v-model="pasteText"
          class="text-input mono"
          rows="5"
          spellcheck="false"
          placeholder="也可以直接粘贴脚本或清单内容（.js / .json）"
        ></textarea>
        <div class="slider-row">
          <button class="ghost-button small" :disabled="adminStore.busy" @click="installFromPaste">识别内容</button>
          <button v-if="adminStore.detected" class="ghost-button small" @click="adminStore.dismiss()">清除</button>
        </div>
      </div>

      <div v-if="adminStore.detected" class="import-result" :class="adminStore.detected.kind">
        <strong>{{ adminStore.detected.summary }}</strong>
        <p class="muted small-text">识别类型：{{ adminStore.detected.kind }}</p>

        <ul v-if="adminStore.errors.length > 0" class="import-errors">
          <li v-for="error in adminStore.errors" :key="error">{{ error }}</li>
        </ul>

        <!-- Advisory: the probe's own observations about one run, never a reason to refuse a file. -->
        <ul v-if="adminStore.warnings.length > 0" class="import-warnings">
          <li v-for="warning in adminStore.warnings" :key="warning">{{ warning }}</li>
        </ul>

        <template v-if="adminStore.detected.kind === 'script' && adminStore.detected.script">
          <div class="source-caps">
            <span v-for="action in adminStore.detected.script.actions" :key="action" class="cap-chip">{{ action }}</span>
            <span v-for="platform in adminStore.detected.script.platforms" :key="platform.id" class="platform-chip">
              {{ platform.icon || '♫' }} {{ platformStore.labelIfKnown(platform.id) ?? platform.id }}
            </span>
            <span v-for="quality in adminStore.detected.script.qualities" :key="quality" class="quality-chip">{{ quality }}</span>
          </div>

          <div class="permission-row">
            <label v-for="permission in SCRIPT_PERMISSIONS" :key="permission" class="checkbox-field">
              <input
                type="checkbox"
                :checked="adminStore.draftPermissions.includes(permission)"
                @change="adminStore.togglePermission(permission)"
              />
              <span>{{ permissionLabel(permission) }}</span>
            </label>
            <label class="select-field">
              <span>运行时</span>
              <select v-model="adminStore.draftRuntime" class="text-input">
                <option value="aurora">Aurora 契约</option>
                <option value="lx">洛雪兼容</option>
              </select>
            </label>
          </div>

          <div class="host-grants">
            <p class="small-text">
              脚本可达主机（可留空：运行时会记录被拒的主机并在此处一键授权）。
            </p>
            <div class="source-caps">
              <span v-for="host in adminStore.draftHosts" :key="host" class="host-chip">
                {{ host }}
                <button class="chip-remove" title="移除" @click="adminStore.removeHost(host)">×</button>
              </span>
            </div>
            <div class="slider-row">
              <button
                v-for="host in adminStore.detected.script.suggestedHosts.filter((item) => !adminStore.draftHosts.includes(item))"
                :key="host"
                class="ghost-button small"
                @click="adminStore.addHost(host)"
              >
                + {{ host }}
              </button>
            </div>
          </div>
        </template>

        <div v-if="adminStore.detected.kind !== 'unknown'" class="slider-row">
          <button class="primary-button small" :disabled="adminStore.busy" @click="installDetected">
            {{ adminStore.busy ? '安装中…' : '确认安装' }}
          </button>
        </div>
      </div>
    </section>

    <section class="settings-section">
      <header class="section-heading">
        <div>
          <h3>JS 音源</h3>
          <p class="muted small-text">
            脚本在独立沙箱渲染进程中执行：没有 <code>require</code>、没有 <code>process</code>、没有文件系统，
            自身 <code>fetch</code> 被会话层拦截，所有出网都必须经过权限桥。文件被改动后会被标记为需要重新确认，
            而不是静默执行未审阅的代码。
          </p>
        </div>
      </header>

      <div v-if="adminStore.scripts.length === 0" class="inline-empty">
        <span>🧩</span>
        <p>还没有脚本音源。用上面的「安装音源」选择一个 <code>.js</code> 文件即可。</p>
      </div>

      <ul v-else class="custom-source-list">
        <li v-for="record in adminStore.scripts" :key="record.manifest.id" class="custom-source-item">
          <div class="custom-source-main">
            <strong>{{ record.manifest.name }}</strong>
            <small>
              {{ record.manifest.id }} · v{{ record.manifest.version }} · 运行时 {{ record.manifest.runtime }}
              <template v-if="record.manifest.author"> · {{ record.manifest.author }}</template>
            </small>
            <div class="source-caps">
              <span v-for="host in record.manifest.allowedHosts" :key="host" class="host-chip">{{ host }}</span>
              <span v-for="platform in record.manifest.platforms" :key="platform.id" class="platform-chip">
                {{ platformStore.labelIfKnown(platform.id) ?? platform.id }}
              </span>
            </div>
          </div>
          <div class="slider-row">
            <button class="ghost-button small" @click="inspectScript(record.manifest.id)">检查</button>
            <button class="ghost-button small" :disabled="adminStore.busy" @click="reloadScript(record.manifest.id)">重新加载</button>
            <button class="ghost-button small" @click="exportScript(record.manifest.id)">导出</button>
            <button class="ghost-button small danger" :disabled="adminStore.busy" @click="removeScript(record.manifest.id)">删除</button>
          </div>
        </li>
      </ul>
    </section>

    <section class="settings-section">
      <header class="section-heading">
        <div>
          <h3>API 音源（声明式清单）</h3>
          <p class="muted small-text">
            用一份 JSON 描述接口：URL 模板、字段映射、字段模板。Aurora 不执行你提供的任何代码，所以清单可以被完整校验。
            <code>allowedHosts</code> 是<strong>授权</strong>而不是准入条件：留空也能安装，运行时被拒的主机会在音源卡片上给出一键授权。
            编辑器里可以载入内置样板（Internet Archive 的两个预设，均已对真实 API 验证过）。
          </p>
        </div>
        <div class="slider-row">
          <button class="primary-button small" @click="openEditor()">添加 API 音源</button>
          <label class="ghost-button small file-button">
            编辑已有清单
            <input type="file" accept="application/json,.json" @change="importManifestFile" />
          </label>
        </div>
      </header>

      <div v-if="customStore.manifests.length === 0" class="inline-empty">
        <span>🧩</span>
        <p>还没有 API 音源。编辑器内置了可直接载入的样板，也支持粘贴/导入你自己的清单。</p>
      </div>

      <ul v-else class="custom-source-list">
        <li v-for="manifest in customStore.manifests" :key="manifest.id" class="custom-source-item">
          <div class="custom-source-main">
            <strong>{{ manifest.icon || '🧩' }} {{ manifest.name }}</strong>
            <small>
              {{ manifest.id }} · v{{ manifest.version }} · apiVersion {{ manifest.apiVersion }}
              <template v-if="manifest.author"> · {{ manifest.author }}</template>
            </small>
            <div class="source-caps">
              <span v-for="label in manifestCapabilities(manifest)" :key="label" class="cap-chip">{{ label }}</span>
              <span v-for="host in manifest.allowedHosts" :key="host" class="host-chip">{{ host }}</span>
            </div>
          </div>
          <div class="slider-row">
            <button class="ghost-button small" @click="editManifest(manifest)">编辑</button>
            <button class="ghost-button small" @click="exportManifest(manifest)">导出</button>
            <button class="ghost-button small danger" :disabled="customStore.saving" @click="removeManifest(manifest)">删除</button>
          </div>
        </li>
      </ul>
    </section>

    <div v-if="editorOpen" class="modal-backdrop" @click.self="closeEditor">
      <div class="modal-card wide manifest-modal">
        <header class="modal-head">
          <div>
            <strong>自定义音源定义</strong>
            <span class="small-text">
              必填：<code>apiVersion</code> <code>id</code> <code>name</code> <code>version</code> <code>homepage</code>
              <code>license</code> <code>permissions</code> <code>allowedHosts</code>，以及 <code>search</code> 或 <code>recommend</code> 之一。
            </span>
          </div>
          <button class="ghost-button small" @click="closeEditor">关闭</button>
        </header>

        <div class="modal-body">
          <div v-if="customStore.templates.length > 0" class="template-row">
            <span class="muted small-text">载入样板（已对真实 API 验证过，可修改后再保存）：</span>
            <button
              v-for="template in customStore.templates"
              :key="template.id"
              class="ghost-button small"
              :title="template.description"
              @click="loadTemplate(template)"
            >
              {{ template.name }}
            </button>
          </div>
          <textarea v-model="editorText" class="lyrics-textarea manifest-editor" spellcheck="false" wrap="off"></textarea>
        </div>

        <ul v-if="editorErrors.length > 0" class="manifest-errors">
          <li v-for="message in editorErrors" :key="message">{{ message }}</li>
        </ul>
        <p v-else-if="editorSaved" class="config-result ok manifest-status">{{ editorSaved }}</p>
        <p v-else class="muted small-text manifest-status">先校验再保存：所有问题会一次性列出，而不是逐条报错。</p>

        <div class="modal-actions">
          <button class="ghost-button small" @click="validateEditor">校验</button>
          <button class="primary-button small" :disabled="customStore.saving" @click="saveEditor">
            {{ customStore.saving ? '保存中…' : '保存并生效' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
