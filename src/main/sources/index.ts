/**
 * Sources are user-installed plugins only. Platforms are a separate read-only registry
 * (`main/platforms/registry.ts`) and are never registered here. This keeps Platform (identity +
 * search) and Source (plugin + resolver capability) from ever sharing a table again.
 */

export {
  checkHealth,
  coverFor,
  describeSources,
  runHealthPass,
  startHealthMonitor,
  stopHealthMonitor,
  getEnabledSources,
  getSource,
  initializeSources,
  invalidateSourceRuntime,
  isConfigured,
  isEnabled,
  listSources,
  orderedSources,
  playlistDetail,
  playlists,
  recommendations,
  registerSource,
  resolveConfig,
  resolveStream,
  searchAll,
  searchOne,
  sourceLyrics,
  splitConfigPatch,
  unregisterSource,
} from './manager'
export type { MusicSource, SourceContext, SourceMeta } from './types'
export { PLATFORMS, platformName, searchPlatform } from '../musicSdk'
export { buildTrack, defineCapabilities, findCapabilityGaps } from './types'
export { SourceError, toSourceErrorInfo } from './errors'
export { clearErrorLog, logRequest, logSourceError, readErrorLog, readRequestLog } from './log'
export { getEntry, listEntries, removeEntry, upsertEntry } from './registry'
export type { SourceEntry, SourceEntryPayload } from './registry'
export { initSourceStore, migrationInfo, persistEntries } from './store'
