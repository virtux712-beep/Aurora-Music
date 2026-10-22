import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { BoardDescriptor, BoardOutcome, PlatformDescriptor, PlatformHealthSummary, PlatformId } from '../../../shared/types'
import { platformService } from '../services/aurora'
import { ALL_GLYPH, platformAccent, platformDisplayName, platformGlyph } from '../utils/platformDisplay'

export const usePlatformStore = defineStore('platform', () => {
  const platforms = ref<PlatformDescriptor[]>([])
  const healthSummaries = ref<PlatformHealthSummary[]>([])
  /** Charts the built-in platform layer can actually read — empty for a platform without one. */
  const boards = ref<BoardDescriptor[]>([])
  const loading = ref(false)
  const loaded = ref(false)

  const byId = computed(() => new Map(platforms.value.map((item) => [item.id, item] as const)))
  const healthById = computed(() => new Map(healthSummaries.value.map((item) => [item.platformId, item] as const)))

  /**
   * What the UI shows for a platform id. The alias wins so every surface — tabs, charts, the player
   * badge, lyric headers — reads the same, and a registry entry that is not one of the five (a
   * future platform, or a custom one) still renders whatever the registry reports.
   */
  function label(id?: string): string {
    if (!id) return id ?? ''
    return platformDisplayName(id, byId.value.get(id)?.name ?? id)
  }

  /** The one-character row badge, falling back to the registry's own short label. */
  function glyph(id?: string): string | null {
    if (!id) return null
    if (id === 'all') return ALL_GLYPH
    return platformGlyph(id) ?? byId.value.get(id)?.shortLabel ?? null
  }

  /** Badge tint for a platform; `null` when the id is not a platform Aurora knows. */
  function accent(id?: string): string | null {
    return platformAccent(id)
  }

  /** `label(id)` only when `id` really is a platform — used to keep source names untouched. */
  function labelIfKnown(id?: string): string | null {
    if (!id) return null
    if (!byId.value.has(id)) return null
    return label(id)
  }

  function healthFor(platformId: PlatformId): PlatformHealthSummary | null {
    return healthById.value.get(platformId) ?? null
  }

  const boardsByPlatform = computed(() => {
    const map = new Map<PlatformId, BoardDescriptor[]>()
    for (const board of boards.value) {
      const list = map.get(board.platformId) ?? []
      list.push(board)
      map.set(board.platformId, list)
    }
    return map
  })

  async function load(force = false): Promise<void> {
    if (loaded.value && !force) return
    loading.value = true
    try {
      const [list, health, charts] = await Promise.all([
        platformService.list(),
        platformService.healthAll(),
        platformService.boards(),
      ])
      platforms.value = list
      healthSummaries.value = health
      boards.value = charts
      loaded.value = true
    } finally {
      loading.value = false
    }
  }

  /**
   * Loads one chart. The store keeps the last chart per platform so switching platforms back and
   * forth does not re-hit the network, and a failed chart is stored as its own failed outcome rather
   * than replacing another platform's result.
   */
  const chartOutcomes = ref<Record<string, BoardOutcome>>({})
  const chartLoading = ref(false)

  function chartKey(platformId: PlatformId, boardId: string): string {
    return `${platformId}:${boardId}`
  }

  function chart(platformId: PlatformId, boardId: string): BoardOutcome | null {
    return chartOutcomes.value[chartKey(platformId, boardId)] ?? null
  }

  async function loadChart(platformId: PlatformId, boardId: string, force = false): Promise<BoardOutcome | null> {
    const key = chartKey(platformId, boardId)
    const cached = chartOutcomes.value[key]
    if (cached?.ok && !force) return cached
    chartLoading.value = true
    try {
      const outcome = await platformService.boardSongs(platformId, boardId, 50)
      chartOutcomes.value = { ...chartOutcomes.value, [key]: outcome }
      return outcome
    } finally {
      chartLoading.value = false
    }
  }

  async function refreshHealth(): Promise<void> {
    healthSummaries.value = await platformService.healthAll()
  }

  return {
    platforms,
    healthSummaries,
    boards,
    boardsByPlatform,
    chartOutcomes,
    chartLoading,
    loading,
    loaded,
    byId,
    healthById,
    label,
    glyph,
    accent,
    labelIfKnown,
    healthFor,
    chart,
    loadChart,
    load,
    refreshHealth,
  }
})
