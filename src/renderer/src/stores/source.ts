import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { SourceCapabilities, SourceConfigValue, SourceDescriptor, SourceHealth, SourceId } from '../../../shared/types'
import { NO_CAPABILITIES, sourceService } from '../services/aurora'

/**
 * The UI's view of the plugin registry.
 *
 * Components never hardcode a source id: they ask this store for capabilities
 * (`can('lyrics')`), labels and the current enabled set. Toggling a source here round-trips to the
 * SourceManager, which drops its caches immediately — no restart, no stale tabs.
 */
export const useSourceStore = defineStore('source', () => {
  const sources = ref<SourceDescriptor[]>([])
  const loading = ref(false)
  const error = ref('')
  const loaded = ref(false)
  const busyId = ref('')

  const byId = computed(() => new Map(sources.value.map((source) => [source.id, source] as const)))
  const enabled = computed(() => sources.value.filter((source) => source.enabled))
  const searchable = computed(() => enabled.value.filter((source) => source.capabilities.search))
  const needsConfig = computed(() => enabled.value.filter((source) => source.status === 'needs-config'))
  const hasErrors = computed(() => enabled.value.filter((source) => source.status === 'error'))

  function get(id?: SourceId): SourceDescriptor | null {
    return id ? (byId.value.get(id) ?? null) : null
  }

  function label(id?: SourceId): string {
    if (!id) return '本地音乐'
    return byId.value.get(id)?.name ?? id
  }

  function capabilities(id?: SourceId): SourceCapabilities {
    return get(id)?.capabilities ?? NO_CAPABILITIES
  }

  /** `can('lyrics', track.sourceId)` — the capability-based replacement for id checks. */
  function can(capability: keyof SourceCapabilities, id?: SourceId): boolean {
    const source = get(id)
    if (!source) return false
    return source.enabled && source.capabilities[capability]
  }

  function apply(next: SourceDescriptor[]): void {
    if (Array.isArray(next) && next.length > 0) sources.value = next
  }

  async function load(force = false): Promise<void> {
    if (loaded.value && !force) return
    loading.value = true
    try {
      sources.value = await sourceService.list()
      loaded.value = true
      error.value = ''
    } catch (loadError) {
      error.value = loadError instanceof Error ? loadError.message : '读取音源列表失败'
    } finally {
      loading.value = false
    }
  }

  async function setEnabled(id: SourceId, next: boolean): Promise<void> {
    busyId.value = id
    try {
      // Optimistic flip keeps the switch responsive; the authoritative list follows immediately.
      sources.value = sources.value.map((source) => (source.id === id ? { ...source, enabled: next } : source))
      apply(await sourceService.setEnabled(id, next))
    } finally {
      busyId.value = ''
    }
  }

  async function setConfig(id: SourceId, patch: Record<string, SourceConfigValue>): Promise<void> {
    busyId.value = id
    try {
      apply(await sourceService.setConfig(id, patch))
    } finally {
      busyId.value = ''
    }
  }

  async function move(id: SourceId, direction: -1 | 1): Promise<void> {
    const order = sources.value.map((source) => source.id)
    const index = order.indexOf(id)
    const target = index + direction
    if (index < 0 || target < 0 || target >= order.length) return
    ;[order[index], order[target]] = [order[target], order[index]]
    apply(await sourceService.setOrder(order))
  }

  async function checkHealth(id: SourceId): Promise<SourceHealth | null> {
    busyId.value = id
    try {
      const health = await sourceService.health(id)
      sources.value = sources.value.map((source) => (source.id === id ? { ...source, health } : source))
      return health
    } catch {
      return null
    } finally {
      busyId.value = ''
    }
  }

  return {
    sources,
    loading,
    error,
    loaded,
    busyId,
    byId,
    enabled,
    searchable,
    needsConfig,
    hasErrors,
    get,
    label,
    capabilities,
    can,
    /** Replaces the whole descriptor list (used by grants, which reload a source in place). */
    apply,
    load,
    setEnabled,
    setConfig,
    move,
    checkHealth,
  }
})
