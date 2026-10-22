import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { CustomSourceManifest, CustomSourceSaveResult, CustomSourceTemplate } from '../../../shared/customSource'
import { customSourceService } from '../services/aurora'
import { useSourceStore } from './source'

/**
 * User-defined ("自定义音源") declarative sources.
 *
 * Saving or removing a manifest changes the *plugin registry* in the main process, so this store
 * reloads the source descriptors afterwards — every other page (search tabs,
 * capability-gated buttons) then reflects the new source without a restart.
 *
 * A manifest is data, never code: the editor validates first and reports every problem at once so
 * the user is not left fixing one field per attempt.
 */
export const useCustomSourceStore = defineStore('customSource', () => {
  const manifests = ref<CustomSourceManifest[]>([])
  const templates = ref<CustomSourceTemplate[]>([])
  const loading = ref(false)
  const saving = ref(false)
  const error = ref('')
  const errors = ref<string[]>([])
  /**
   * Did 安全模式 disable the source we just saved, *because it was new*?
   *
   * Comes from the main process (`disabledByPolicy`), never from this side's copy of the safe-mode flag:
   * re-saving a source the user already enabled leaves it enabled, and a page that guessed would tell them
   * it is disabled while it is live.
   */
  const disabledByPolicy = ref(false)
  const loaded = ref(false)

  const count = computed(() => manifests.value.length)
  /** Templates Aurora ships: offered in the editor, never installed behind the user's back. */
  const shipped = computed(() => templates.value)

  function applyResult(result: CustomSourceSaveResult): boolean {
    manifests.value = result.manifests
    errors.value = result.errors
    return result.ok
  }

  async function load(force = false): Promise<void> {
    if (loaded.value && !force) return
    loading.value = true
    try {
      const [list, offered] = await Promise.all([customSourceService.list(), customSourceService.templates()])
      manifests.value = list
      templates.value = offered
      loaded.value = true
      error.value = ''
    } catch (loadError) {
      error.value = loadError instanceof Error ? loadError.message : '读取自定义音源失败'
    } finally {
      loading.value = false
    }
  }

  /** Validates without saving; returns the error list (empty means the manifest is acceptable). */
  async function validate(raw: string): Promise<string[]> {
    const result = await customSourceService.validate(raw)
    errors.value = result.errors
    return result.errors
  }

  async function save(raw: string): Promise<boolean> {
    saving.value = true
    try {
      const result = await customSourceService.save(raw)
      const ok = applyResult(result)
      disabledByPolicy.value = result.disabledByPolicy === true
      if (ok) await useSourceStore().load(true)
      return ok
    } finally {
      saving.value = false
    }
  }

  async function remove(id: string): Promise<boolean> {
    saving.value = true
    try {
      const result = await customSourceService.remove(id)
      const ok = applyResult(result)
      if (ok) await useSourceStore().load(true)
      return ok
    } finally {
      saving.value = false
    }
  }

  /** The manifest as pretty JSON, used both for file export and for loading it back into the editor. */
  async function exportManifest(id: string): Promise<string | null> {
    return customSourceService.export(id)
  }

  function clearErrors(): void {
    errors.value = []
  }

  return {
    manifests,
    templates,
    shipped,
    loading,
    saving,
    error,
    errors,
    disabledByPolicy,
    loaded,
    count,
    load,
    validate,
    save,
    remove,
    exportManifest,
    clearErrors,
  }
})
