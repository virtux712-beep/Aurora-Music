import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { SourceImportResult } from '../../../shared/sourceImport'
import type { ScriptProbeOptions, ScriptSourceRecord } from '../../../shared/scriptSource'
import type { SourcePendingHost } from '../../../shared/types'
import { customSourceService, scriptSourceService, sourceImportService, sourceService } from '../services/aurora'
import { useSourceStore } from './source'

/**
 * Source installation and runtime permissions.
 *
 * Two responsibilities, both deliberately thin — the decisions live in the main process:
 *
 *  1. **Install** — hand a file (or pasted text) to the Source Detector, show what it recognised, and
 *     let the user confirm. Nothing is written before that confirmation, and nothing about the file's
 *     hosts or platform can block it: the detector only reports *format*.
 *  2. **Grants** — the runtime refuses an ungranted host rather than blocking the source, so this
 *     store surfaces those refusals and turns them into one-click grants.
 *
 * A script source is code that runs in a sandbox, so the review step matters: the probe result is
 * what the user confirms (name, actions, platforms, hosts) — never a claim made by the script.
 */
export const useSourceAdminStore = defineStore('sourceAdmin', () => {
  const scripts = ref<ScriptSourceRecord[]>([])
  const pendingHosts = ref<SourcePendingHost[]>([])
  const detected = ref<SourceImportResult | null>(null)
  /** Text to install: the detected file's contents, or whatever the user pasted. */
  const draftText = ref('')
  const draftFileName = ref('')
  const draftRuntime = ref<ScriptProbeOptions['runtime']>('aurora')
  /** Permissions the user is willing to grant; the probe never grants anything on its own. */
  const draftPermissions = ref<string[]>(['network'])
  const draftHosts = ref<string[]>([])

  const busy = ref(false)
  const loading = ref(false)
  const errors = ref<string[]>([])
  /**
   * Non-blocking observations from the last probe: reasons to look closer, not reasons to refuse.
   *
   * A script that loaded but has not declared its capabilities lands here, and the install button
   * stays available — the manager can re-probe the source afterwards.
   */
  const warnings = ref<string[]>([])
  const notice = ref('')
  /**
   * Did 安全模式 disable what we just installed, *because it was new*?
   *
   * The main process' answer (`disabledByPolicy` on the save result), kept here so the notice text has one
   * source of truth. It is deliberately **not** re-derived from the safe-mode flag: a re-install of a source
   * the user already enabled stays enabled, and saying otherwise would be explaining the policy wrongly.
   */
  const disabledByPolicy = ref(false)
  const loaded = ref(false)

  const scriptCount = computed(() => scripts.value.length)
  const detection = computed(() => detected.value)

  async function load(force = false): Promise<void> {
    if (loaded.value && !force) return
    loading.value = true
    try {
      const [list, pending] = await Promise.all([scriptSourceService.list(), sourceService.pendingHosts()])
      scripts.value = list
      pendingHosts.value = pending
      loaded.value = true
    } finally {
      loading.value = false
    }
  }

  /** Runs detection on already-known text (a paste, or a file the picker returned). */
  async function detect(text: string, fileName: string): Promise<SourceImportResult> {
    busy.value = true
    errors.value = []
    warnings.value = []
    notice.value = ''
    try {
      const result = await sourceImportService.fromText(text, fileName)
      applyDetection(result)
      return result
    } finally {
      busy.value = false
    }
  }

  /** Opens the OS file picker and detects whatever the user chose. */
  async function importFromFile(): Promise<SourceImportResult> {
    busy.value = true
    errors.value = []
    warnings.value = []
    notice.value = ''
    try {
      const result = await sourceImportService.fromFile()
      applyDetection(result)
      return result
    } finally {
      busy.value = false
    }
  }

  function applyDetection(result: SourceImportResult): void {
    detected.value = result
    errors.value = result.errors
    warnings.value = result.warnings ?? []
    if (result.kind === 'unknown') return
    draftText.value = result.text ?? ''
    draftFileName.value = result.fileName
    if (result.kind === 'script' && result.script) {
      draftRuntime.value = result.script.runtime
      // Suggested, not enforced: the user adjusts both lists before confirming.
      draftPermissions.value = ['network']
      draftHosts.value = [...result.script.suggestedHosts]
      notice.value = result.summary
    } else {
      notice.value = result.summary
    }
  }

  /** Installs what the detector recognised. Scripts persist the text; manifests are saved as JSON. */
  async function install(): Promise<boolean> {
    const result = detected.value
    if (!result || result.kind === 'unknown') return false
    busy.value = true
    errors.value = []
    /*
     * Reset **before** installing, and set only from the main process' answer.
     *
     * The settings page used to append "安全模式已开启，该音源默认禁用" to its own success message whenever
     * its local safe-mode flag was on — which is also true when the user re-installs a source they had
     * already enabled, where the main process deliberately leaves it enabled. Two sources of truth for one
     * policy is how a feature ends up explaining itself wrongly, so the flag now has exactly one source.
     */
    disabledByPolicy.value = false
    try {
      if (result.kind === 'script') {
        const outcome = await scriptSourceService.probe({
          sourceText: draftText.value,
          fileName: draftFileName.value,
          runtime: draftRuntime.value,
        })
        if (!outcome.ok || !outcome.manifest) {
          // The probe failed (the script threw while loading): its errors are what the user needs to
          // see, and nothing is written.
          errors.value = outcome.errors.length > 0 ? outcome.errors : ['脚本试运行失败']
          return false
        }
        // Advisory only — install proceeds either way, and the notices stay on screen afterwards.
        warnings.value = outcome.warnings ?? []
        const saved = await scriptSourceService.save({
          sourceText: draftText.value,
          manifest: {
            ...outcome.manifest,
            runtime: draftRuntime.value,
            permissions: draftPermissions.value,
            allowedHosts: draftHosts.value,
          },
        })
        if (!saved.ok) {
          errors.value = saved.errors
          return false
        }
        disabledByPolicy.value = saved.disabledByPolicy === true
        notice.value =
          `已安装脚本音源${outcome.declaration?.name ? `「${outcome.declaration.name}」` : ''}` +
          (warnings.value.length > 0 ? '：暂未声明能力，可用「重新检查」重新探测' : '')
      } else {
        const raw = result.manifestJson ?? draftText.value
        const saved = await customSourceService.save(raw)
        if (!saved.ok) {
          errors.value = saved.errors
          return false
        }
        disabledByPolicy.value = saved.disabledByPolicy === true
        notice.value = '已安装 API 音源'
      }
      await Promise.all([load(true), useSourceStore().load(true)])
      detected.value = null
      return true
    } finally {
      busy.value = false
    }
  }

  async function reload(id: string): Promise<boolean> {
    busy.value = true
    try {
      const result = await scriptSourceService.reload(id)
      scripts.value = result.sources
      errors.value = result.errors
      if (result.ok) await useSourceStore().load(true)
      return result.ok
    } finally {
      busy.value = false
    }
  }

  async function remove(id: string): Promise<boolean> {
    busy.value = true
    try {
      const result = await scriptSourceService.remove(id)
      scripts.value = result.sources
      errors.value = result.errors
      if (result.ok) await Promise.all([useSourceStore().load(true), refreshPending()])
      return result.ok
    } finally {
      busy.value = false
    }
  }

  async function exportScript(id: string): Promise<string | null> {
    return scriptSourceService.export(id)
  }

  async function inspect(id: string): Promise<{ ok: boolean; message: string }> {
    return scriptSourceService.inspect(id)
  }

  /** Grants one host (or several) and refreshes both the descriptors and the pending list. */
  async function grant(sourceId: string, hosts: string[]): Promise<void> {
    busy.value = true
    try {
      const descriptors = await sourceService.grantHosts(sourceId, hosts)
      if (descriptors.length > 0) useSourceStore().apply(descriptors)
      await refreshPending()
      notice.value = `已授权 ${hosts.join('、')}`
    } finally {
      busy.value = false
    }
  }

  async function refreshPending(): Promise<void> {
    pendingHosts.value = await sourceService.pendingHosts()
  }

  function dismiss(): void {
    detected.value = null
    draftText.value = ''
    draftFileName.value = ''
    draftHosts.value = []
    errors.value = []
    notice.value = ''
  }

  function togglePermission(permission: string): void {
    draftPermissions.value = draftPermissions.value.includes(permission)
      ? draftPermissions.value.filter((item) => item !== permission)
      : [...draftPermissions.value, permission]
  }

  function addHost(host: string): void {
    const value = host.trim().toLowerCase()
    if (!value || draftHosts.value.includes(value)) return
    draftHosts.value = [...draftHosts.value, value]
  }

  function removeHost(host: string): void {
    draftHosts.value = draftHosts.value.filter((item) => item !== host)
  }

  return {
    scripts,
    pendingHosts,
    detected,
    draftText,
    draftFileName,
    draftRuntime,
    draftPermissions,
    draftHosts,
    busy,
    loading,
    errors,
    warnings,
    notice,
    disabledByPolicy,
    loaded,
    scriptCount,
    detection,
    load,
    detect,
    importFromFile,
    install,
    reload,
    remove,
    exportScript,
    inspect,
    grant,
    refreshPending,
    dismiss,
    togglePermission,
    addHost,
    removeHost,
  }
})
