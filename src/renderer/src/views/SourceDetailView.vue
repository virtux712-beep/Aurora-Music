<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import type {
  SourceCapabilities,
  SourceConfigValue,
  SourceDescriptor,
  SourceErrorLogEntry,
  SourceHealth,
  SourceSelfCheckResult,
  SourceStatus,
} from '../../../shared/types'
import EmptyState from '../components/EmptyState.vue'
import { useSourceAdminStore } from '../stores/sourceAdmin'
import { useSourceStore } from '../stores/source'
import { useUiStore } from '../stores/ui'
import { customSourceService, sourceService } from '../services/aurora'
import { safeExternalUrl } from '../utils/url'

/**
 * One source, one page.
 *
 * The list page answers "what is installed"; this page answers "is *this* source healthy, what may it
 * reach, and what can I do about it" — without every change touching the other sources' cards. The
 * independence is the point: a source being reconfigured, reloaded, refused or repaired here changes
 * nothing about any other source's state, and the self-check runs its real operations against this
 * source only.
 *
 * Everything on screen is the source's own reported state; the two things the page *does* are grant
 * (or revoke) a host and run the check. Nothing is auto-hidden: a failing step keeps its error code.
 */
const route = useRoute()
const router = useRouter()
const sourceStore = useSourceStore()
const adminStore = useSourceAdminStore()
const ui = useUiStore()

const sourceId = computed(() => String(route.params.id ?? ''))
const descriptor = computed<SourceDescriptor | null>(() => sourceStore.get(sourceId.value))
const pending = computed(() => adminStore.pendingHosts.filter((item) => item.sourceId === sourceId.value).map((item) => item.host))

const check = ref<SourceSelfCheckResult | null>(null)
const checkKeyword = ref('周杰伦')
const running = ref(false)
const errors = ref<SourceErrorLogEntry[]>([])
const health = ref<SourceHealth | null>(null)
const drafts = reactive<Record<string, SourceConfigValue>>({})
const saving = ref(false)
const testing = ref(false)
const busy = ref('')
const confirmingRemove = ref(false)

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

const KIND_LABELS: Record<SourceDescriptor['kind'], string> = {
  declarative: 'API 清单',
  script: 'JS 脚本',
}

const STEP_LABELS: Record<SourceSelfCheckResult['steps'][number]['key'], string> = {
  installed: '已安装',
  registered: '已注册到运行时',
  enabled: '已启用',
  configured: '配置完整',
  search: '搜索',
  stream: '取播放地址',
  hosts: '联网授权',
}

const capabilities = computed(() => CAPABILITY_LABELS.filter((item) => descriptor.value?.capabilities[item.key]).map((item) => item.label))
const grantedHosts = computed(() => descriptor.value?.allowedHosts ?? [])
const failedSteps = computed(() => (check.value?.steps ?? []).filter((step) => !step.ok && !step.skipped))

function formatClock(at: number): string {
  return new Date(at).toLocaleTimeString()
}

function draftValue(key: string): SourceConfigValue | '' {
  return drafts[key] ?? ''
}

function buildDraft(source: SourceDescriptor | null): void {
  if (!source) return
  for (const field of source.configSchema.fields) {
    // Secrets never come back from main: the field starts empty and shows "已配置".
    drafts[field.key] = field.secret ? '' : (source.config[field.key] ?? field.default ?? (field.type === 'boolean' ? false : ''))
  }
}

function onInput(key: string, value: string, type: string): void {
  drafts[key] = type === 'boolean' ? value === 'true' : type === 'number' ? Number(value) : value
}

async function loadErrors(): Promise<void> {
  errors.value = await sourceService.errors(sourceId.value)
}

async function refreshAll(): Promise<void> {
  await Promise.all([sourceStore.load(true), adminStore.refreshPending()])
}

onMounted(async () => {
  await sourceStore.load()
  await adminStore.load()
  await adminStore.refreshPending()
  buildDraft(descriptor.value)
  await loadErrors()
})

watch(() => descriptor.value?.id, () => buildDraft(descriptor.value))

async function runCheck(repair: boolean): Promise<void> {
  if (!descriptor.value) return
  running.value = true
  try {
    const result = await sourceService.selfCheck(sourceId.value, { repair, keyword: checkKeyword.value })
    if (!result) {
      ui.notify('自检没有返回结果（音源可能已被移除）', 'error')
      return
    }
    check.value = result
    if (result.repaired.length > 0) {
      ui.notify(`自检发现未授权主机，已自动允许 ${result.repaired.join('、')} 并重试`, 'success')
    } else if (result.repairBlocked) {
      /*
       * "Nothing needed repairing" and "safe mode would not let me" are different answers, and only one
       * of them needs the user to do something. The repair button used to grant hosts under safe mode
       * anyway; now that it refuses, the refusal has to be said out loud or the button looks broken.
       */
      ui.notify(result.repairBlocked, 'info')
    } else if (result.ok) {
      ui.notify(`「${result.name}」自检通过：搜索与取地址都正常`, 'success')
    } else {
      ui.notify(`「${result.name}」自检未通过：${failedSteps.value.map((step) => step.label).join('、')}`, 'error')
    }
    await refreshAll()
    await loadErrors()
  } finally {
    running.value = false
  }
}

async function grant(hosts: string[]): Promise<void> {
  if (hosts.length === 0) return
  busy.value = 'grant'
  try {
    sourceStore.apply(await sourceService.grantHosts(sourceId.value, hosts))
    await adminStore.refreshPending()
    ui.notify(`已允许 ${hosts.join('、')}，音源已重新加载`, 'success')
  } finally {
    busy.value = ''
  }
}

async function revoke(host: string): Promise<void> {
  busy.value = 'revoke'
  try {
    sourceStore.apply(await sourceService.revokeHosts(sourceId.value, [host]))
    await adminStore.refreshPending()
    ui.notify(`已撤销 ${host} 的访问授权（下次请求会重新被拒）`, 'info')
  } finally {
    busy.value = ''
  }
}

async function toggleEnabled(): Promise<void> {
  const source = descriptor.value
  if (!source) return
  await sourceStore.setEnabled(source.id, !source.enabled)
  ui.notify(source.enabled ? `已启用「${source.name}」（立即生效）` : `已禁用「${source.name}」（其他音源不受影响）`, 'info')
}

async function testHealth(): Promise<void> {
  testing.value = true
  try {
    health.value = await sourceStore.checkHealth(sourceId.value)
    ui.notify(health.value?.ok ? `连接正常${health.value.latency ? `（${health.value.latency}ms）` : ''}` : `连接失败：${health.value?.message ?? '未知原因'}`, health.value?.ok ? 'success' : 'error')
  } finally {
    testing.value = false
  }
}

async function saveConfig(): Promise<void> {
  const source = descriptor.value
  if (!source) return
  saving.value = true
  try {
    await sourceStore.setConfig(source.id, { ...drafts })
    for (const field of source.configSchema.fields) if (field.secret) drafts[field.key] = ''
    ui.notify('配置已保存', 'success')
  } catch (error) {
    ui.notify(error instanceof Error ? error.message : '保存配置失败', 'error')
  } finally {
    saving.value = false
  }
}

async function reload(): Promise<void> {
  busy.value = 'reload'
  try {
    const ok = await adminStore.reload(sourceId.value)
    ui.notify(ok ? '音源已重新加载' : (adminStore.errors[0] ?? '重新加载失败'), ok ? 'success' : 'error')
    await refreshAll()
  } finally {
    busy.value = ''
  }
}

async function exportScript(): Promise<void> {
  busy.value = 'export'
  try {
    const text = await adminStore.exportScript(sourceId.value)
    if (!text) {
      ui.notify('导出失败：找不到脚本文件', 'error')
      return
    }
    const url = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `${sourceId.value}.js`
    link.click()
    URL.revokeObjectURL(url)
    ui.notify('脚本已导出', 'success')
  } finally {
    busy.value = ''
  }
}

async function removeSource(): Promise<void> {
  const source = descriptor.value
  if (!source) return
  busy.value = 'remove'
  try {
    const removed =
      source.kind === 'script' ? await adminStore.remove(source.id) : (await customSourceService.remove(source.id)).ok
    if (!removed) {
      ui.notify(adminStore.errors[0] ?? '删除失败', 'error')
      return
    }
    ui.notify(`已删除「${source.name}」`, 'success')
    await sourceStore.load(true)
    await router.push('/settings/sources')
  } finally {
    busy.value = ''
    confirmingRemove.value = false
  }
}
</script>

<template>
  <div class="view source-detail">
    <header class="view-header">
      <div class="source-identity">
        <template v-if="descriptor">
          <span class="source-logo">{{ descriptor.icon || '♪' }}</span>
          <div>
            <h2>{{ descriptor.name }}</h2>
            <small class="muted">
              v{{ descriptor.version }}
              <template v-if="descriptor.author"> · {{ descriptor.author }}</template>
              <template v-if="descriptor.apiVersion"> · apiVersion {{ descriptor.apiVersion }}</template>
              <template v-if="descriptor.runtime"> · runtime {{ descriptor.runtime }}</template>
            </small>
            <div class="kind-row">
              <span class="kind-chip">{{ KIND_LABELS[descriptor.kind] ?? descriptor.kind }}</span>
              <span class="kind-chip">{{ descriptor.id }}</span>
              <span v-for="permission in descriptor.permissions" :key="permission" class="perm-chip">{{ permission }}</span>
            </div>
          </div>
        </template>
        <div v-else>
          <h2>音源不存在</h2>
          <small class="muted">它可能已经被删除</small>
        </div>
      </div>

      <div v-if="descriptor" class="view-actions">
        <RouterLink class="ghost-button small" to="/settings/sources">← 返回列表</RouterLink>
        <span class="status-pill" :class="descriptor.status">{{ STATUS_LABELS[descriptor.status] }}</span>
        <button class="switch" :class="{ on: descriptor.enabled }" role="switch" :aria-checked="descriptor.enabled" @click="toggleEnabled">
          <span class="switch-knob"></span>
        </button>
        <button class="ghost-button small" :disabled="testing" @click="testHealth">{{ testing ? '测试中…' : '测试连接' }}</button>
        <button v-if="descriptor.kind === 'script'" class="ghost-button small" :disabled="busy === 'reload'" @click="reload">重新加载</button>
        <button v-if="descriptor.kind === 'script'" class="ghost-button small" :disabled="busy === 'export'" @click="exportScript">导出脚本</button>
        <button class="ghost-button small danger" :disabled="busy === 'remove'" @click="confirmingRemove = true">删除</button>
      </div>
    </header>

    <template v-if="descriptor">
      <div v-if="confirmingRemove" class="notice-card danger">
        <div>
          <strong>删除「{{ descriptor.name }}」？</strong>
          <p v-if="descriptor.kind === 'script'">脚本文件会一并从磁盘移除，已授权的主机（{{ grantedHosts.length }} 台）随之消失。其他音源不受影响。</p>
          <p v-else>这个 API 清单会从注册表移除，其他音源不受影响。</p>
        </div>
        <div class="slider-row">
          <button class="ghost-button small" @click="confirmingRemove = false">取消</button>
          <button class="danger-button small" :disabled="busy === 'remove'" @click="removeSource">确认删除</button>
        </div>
      </div>

      <!-- 自检：真的搜索、真的取地址，并且只会自动修“未授权”这一种失败 -->
      <section class="settings-section">
        <header class="section-heading">
          <div>
            <h3>自检与修复</h3>
            <p class="muted small-text">
              用真实操作逐步检查这个音源：已安装 → 已注册 → 已启用 → 配置完整 → 搜索 → 取播放地址 → 联网授权。
              「自检并自动修复」会自动允许被拒的主机并重试一次；其余失败（超时、无返回、配置不对）保持原样，不做假装成功的重试。
            </p>
          </div>
          <div class="slider-row">
            <input v-model="checkKeyword" class="text-input compact" placeholder="探测关键词" spellcheck="false" />
            <button class="ghost-button small" :disabled="running" @click="runCheck(false)">{{ running ? '检查中…' : '运行自检' }}</button>
            <button class="primary-button small" :disabled="running" @click="runCheck(true)">自检并自动修复</button>
          </div>
        </header>

        <div v-if="check" class="check-result" :class="{ ok: check.ok }">
          <div class="check-summary">
            <strong>{{ check.ok ? '自检通过' : '自检未通过' }}</strong>
            <span class="muted small-text">
              {{ formatClock(check.at) }} · 关键词「{{ check.keyword }}」 · {{ check.steps.length }} 步
              <template v-if="check.repaired.length > 0"> · 本次自动允许 {{ check.repaired.join('、') }}</template>
              <template v-else-if="check.repairBlocked"> · 未自动允许（安全模式）</template>
            </span>
          </div>
          <ul class="check-steps">
            <li v-for="step in check.steps" :key="step.key" class="check-step" :class="{ bad: !step.ok && !step.skipped, skipped: step.skipped }">
              <span class="step-mark">{{ step.skipped ? '–' : step.ok ? '✓' : '✕' }}</span>
              <span class="step-label">{{ STEP_LABELS[step.key] ?? step.key }}</span>
              <span class="step-message">{{ step.message }}</span>
              <span v-if="step.code" class="step-code">{{ step.code }}</span>
              <span class="step-ms">{{ step.ms }}ms</span>
            </li>
          </ul>
        </div>
        <p v-else class="muted small-text">还没有运行过自检。</p>
      </section>

      <!-- 联网授权：这里是“这个音源能去哪里”的唯一真实来源 -->
      <section class="settings-section">
        <header class="section-heading">
          <div>
            <h3>联网授权</h3>
            <p class="muted small-text">
              这台主机之外的一律拒绝。自动允许由「设置 → 音源管理」里的开关控制；在这里撤销之后，下一次请求会重新被拒
              （再播放时会再次自动允许）。内置平台的允许列表写死在代码里，不在这个列表里。
            </p>
          </div>
        </header>

        <div v-if="pending.length > 0" class="pending-hosts">
          <p class="small-text">有 {{ pending.length }} 台主机正在等待授权：</p>
          <div class="slider-row">
            <button v-for="host in pending" :key="host" class="ghost-button small" :disabled="busy === 'grant'" @click="grant([host])">允许 {{ host }}</button>
            <button class="ghost-button small" :disabled="busy === 'grant'" @click="grant(pending)">全部允许</button>
          </div>
        </div>

        <div v-if="grantedHosts.length > 0" class="host-rows">
          <div v-for="host in grantedHosts" :key="host" class="host-row">
            <span class="host-chip">{{ host }}</span>
            <button class="ghost-button small" :disabled="busy === 'revoke'" @click="revoke(host)">撤销</button>
          </div>
        </div>
        <p v-else class="muted small-text">还没有授权任何主机。</p>
      </section>

      <!-- 配置：与列表页同一套字段，但只作用于这个音源 -->
      <section class="settings-section">
        <header class="section-heading">
          <div>
            <h3>配置</h3>
            <p class="muted small-text">只影响这个音源。密钥字段保存后不再回读，界面只显示“已配置”。</p>
          </div>
        </header>

        <form v-if="descriptor.configSchema.fields.length > 0" class="source-config" @submit.prevent="saveConfig">
          <label v-for="field in descriptor.configSchema.fields" :key="field.key" class="config-field">
            <span class="config-label">
              {{ field.label }}
              <em v-if="field.required !== false" class="required">必填</em>
              <em v-if="field.secret && descriptor.secretKeys[field.key]" class="secret-set">已配置（加密存储）</em>
            </span>
            <input
              v-if="field.type !== 'boolean'"
              class="text-input"
              :type="field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text'"
              :placeholder="field.placeholder || field.description || ''"
              :value="draftValue(field.key)"
              spellcheck="false"
              autocomplete="off"
              @input="onInput(field.key, ($event.target as HTMLInputElement).value, field.type)"
            />
            <select v-else class="text-input" :value="String(draftValue(field.key))" @change="onInput(field.key, ($event.target as HTMLSelectElement).value, 'boolean')">
              <option value="false">关闭</option>
              <option value="true">开启</option>
            </select>
            <small v-if="field.description" class="config-hint">{{ field.description }}</small>
          </label>
          <div class="config-actions">
            <button class="primary-button small" type="submit" :disabled="saving">{{ saving ? '保存中…' : '保存配置' }}</button>
            <span v-if="health" class="config-result" :class="{ ok: health.ok }">{{ health.ok ? `连接正常${health.latency ? `（${health.latency}ms）` : ''}` : health.message }}</span>
          </div>
        </form>
        <p v-else class="muted small-text">这个音源不需要配置。</p>
      </section>

      <section class="settings-section">
        <header class="section-heading">
          <div>
            <h3>能力与平台</h3>
            <p class="muted small-text">来自音源自己的声明，Aurora 只按此显示入口；声明了却没有实现的能力会被标出。</p>
          </div>
        </header>
        <div class="source-caps">
          <span v-for="label in capabilities" :key="label" class="cap-chip">{{ label }}</span>
          <span v-if="capabilities.length === 0" class="muted small-text">未声明任何能力</span>
        </div>
        <div class="source-caps">
          <span v-for="platform in descriptor.platforms" :key="platform.id" class="platform-chip">{{ platform.icon || '♫' }} {{ platform.id }}</span>
          <span v-for="quality in descriptor.qualities" :key="quality" class="quality-chip">{{ quality }}</span>
        </div>
        <p v-if="descriptor.capabilityGaps.length > 0" class="capability-gap">
          ⚠ 声明了「{{ descriptor.capabilityGaps.join(' / ') }}」但没有对应实现。
        </p>
        <dl class="source-facts">
          <div><dt>许可</dt><dd>{{ descriptor.license }}</dd></div>
          <div>
            <dt>主页</dt>
            <dd>
              <a v-if="safeExternalUrl(descriptor.homepage)" :href="safeExternalUrl(descriptor.homepage)" target="_blank" rel="noreferrer">{{ descriptor.homepage }}</a>
              <template v-else>{{ descriptor.homepage || '—' }}</template>
            </dd>
          </div>
          <div v-if="descriptor.health"><dt>上次检查</dt><dd>{{ descriptor.health.ok ? '正常' : '失败' }} · {{ descriptor.health.message || '—' }}</dd></div>
        </dl>
      </section>

      <section class="settings-section">
        <header class="section-heading">
          <div>
            <h3>错误历史</h3>
            <p class="muted small-text">这个音源自己的失败记录（最近 {{ errors.length }} 条），包含授权、加载与解析失败的原因。</p>
          </div>
          <button class="ghost-button small" @click="loadErrors">刷新</button>
        </header>
        <details v-if="errors.length > 0" class="error-log" open>
          <summary>最近 {{ errors.length }} 条</summary>
          <ul>
            <li v-for="entry in errors" :key="`${entry.at}-${entry.operation}-${entry.message}`">
              <span class="log-time">{{ formatClock(entry.at) }}</span>
              <span class="log-op">{{ entry.operation }}</span>
              <span class="log-code">{{ entry.code }}</span>
              <span class="log-message">{{ entry.message }}</span>
            </li>
          </ul>
        </details>
        <p v-else class="muted small-text">没有错误记录。</p>
      </section>
    </template>

    <EmptyState
      v-else
      icon="⌁"
      title="找不到这个音源"
      text="它可能已经被删除。返回音源管理可以看到当前安装的全部音源。"
    />
  </div>
</template>
