import type { Lyrics } from '../../shared/lyrics'
import type {
  AudioTrack,
  AuroraSettings,
  PlaybackQuality,
  ResolvedStream,
  SearchOptions,
  SourceCapabilities,
  SourceConfigSchema,
  SourceConfigValue,
  SourceHealth,
  SourceId,
  SourceKind,
  SourcePermission,
  SourcePlatform,
  SourcePlaylist,
  SourcePlaylistDetail,
} from '../../shared/types'

/**
 * The Aurora source plugin contract.
 *
 * A plugin declares *what it can do* through `meta.capabilities` and implements only the optional
 * methods it actually supports. The `SourceManager` performs the capability checks, so neither the
 * player nor any Vue component ever branches on a concrete source id.
 *
 * Rules every plugin must respect (technical rules, not an admission list — Aurora does not decide
 * which platforms a user's source may target):
 *  - network access only through the shared HTTP path, so permissions, timeouts and logs apply;
 *  - never touch the filesystem, `child_process` or Electron APIs — network + pure functions only;
 *  - return Aurora's unified models, never raw API payloads.
 */
export interface SourceMeta {
  id: SourceId
  name: string
  version: string
  /** Plugin API version this source targets (see `SUPPORTED_API_VERSIONS` in shared/customSource). */
  apiVersion: string
  author?: string
  /** Emoji or short glyph rendered in the UI; plugins ship no binary assets. */
  icon?: string
  description: string
  homepage: string
  license: string
  capabilities: SourceCapabilities
  requiresConfig: boolean
  /** Always false now: platforms are not sources. Kept for transition compat with persisted descriptors. */
  builtin: false
  /** How this source is hosted. Drives registry bookkeeping and the settings UI, not behaviour. */
  kind: SourceKind
  /** Contract a script source was written against (`aurora`, or `lx` for the compatibility shim). */
  runtime?: string
  /** What the source is allowed to do; enforced by the permission layer on every call. */
  permissions?: SourcePermission[]
  /** Platforms declared by the source; Aurora never invents one. */
  platforms?: SourcePlatform[]
  /** Qualities the source can resolve. */
  qualities?: PlaybackQuality[]
  configSchema?: SourceConfigSchema
  configDefaults?: Record<string, SourceConfigValue>
}

export interface SourceContext {
  /** Effective configuration: declared values merged with decrypted secrets and defaults. */
  config: Record<string, SourceConfigValue>
  settings: AuroraSettings
  /**
   * Legacy user preference (`settings.allowOpenLicenseDownloads`), kept so existing sources that
   * read it keep compiling and behave the same. The download manager does **not** consult it:
   * saving a resolved stream is a host capability, not an admission decision.
   */
  allowDownloads: boolean
}

/**
 * The contract every source fulfils, regardless of how it is hosted (built-in module, declarative
 * manifest or sandboxed script). Implementers only write the methods they declare:
 *
 *  - a declared capability with no backing method is reported as a *capability gap* and shown in the
 *    source manager, instead of failing silently at runtime;
 *  - the manager owns the fallbacks (`track.cover` when `getCover` is absent, `resolve` when
 *    `getPlayUrl` is absent), so plugins never need defensive wrappers;
 *  - a source never touches the filesystem, `child_process` or Electron APIs: its only outside-world
 *    capability is an HTTP request, and the permission layer decides per request whether it is
 *    allowed (an ungranted host is refused with a grant prompt, never by refusing the source).
 */
export interface MusicSource {
  readonly meta: SourceMeta

  /** Prepare caches/clients. Failures here mark the source as errored, never crash the app. */
  initialize?(context: SourceContext): Promise<void>

  dispose?(): void

  /** `true` when the source has everything it needs to run. Defaults to `!requiresConfig`. */
  isConfigured?(config: Record<string, SourceConfigValue>): boolean

  search?(query: string, options: SearchOptions, context: SourceContext): Promise<AudioTrack[]>

  /**
   * Turns a track previously returned by `search` into a playable, relayed stream. Receives the
   * whole track (so script sources can use `track.metadata`) plus the requested quality.
   * Preferred over `resolve` when both are implemented.
   */
  getPlayUrl?(
    track: AudioTrack,
    quality: PlaybackQuality | undefined,
    context: SourceContext,
  ): Promise<ResolvedStream | null>

  /** Legacy, id-only stream resolution. Kept so existing plugins keep working unchanged. */
  resolve?(trackId: string, context: SourceContext): Promise<ResolvedStream | null>

  /** Extra metadata (narrower than `search`, e.g. a platform detail endpoint). */
  getSongDetail?(trackId: string, context: SourceContext): Promise<AudioTrack | null>

  getLyrics?(track: AudioTrack, context: SourceContext): Promise<Lyrics | null>

  /** Cover URL for a track that `search` did not carry one for. */
  getCover?(track: AudioTrack, context: SourceContext): Promise<string | null>

  getRecommendations?(options: SearchOptions, context: SourceContext): Promise<AudioTrack[]>

  getPlaylists?(context: SourceContext): Promise<SourcePlaylist[]>

  getPlaylistDetail?(playlistId: string, context: SourceContext): Promise<SourcePlaylistDetail | null>

  getAlbum?(albumId: string, context: SourceContext): Promise<SourcePlaylistDetail | null>

  getArtist?(artistId: string, context: SourceContext): Promise<SourcePlaylistDetail | null>

  healthCheck?(context: SourceContext): Promise<SourceHealth>
}

/**
 * Capability → the method that has to back it.
 *
 * Used by the registry to detect "declared but not implemented" capabilities, which would otherwise
 * make the UI offer a button that always fails.
 */
export const CAPABILITY_REQUIREMENTS: Array<{
  capability: keyof SourceCapabilities
  methods: Array<keyof MusicSource>
  label: string
}> = [
  { capability: 'search', methods: ['search'], label: '搜索' },
  { capability: 'stream', methods: ['getPlayUrl', 'resolve'], label: '播放' },
  { capability: 'lyrics', methods: ['getLyrics'], label: '歌词' },
  { capability: 'playlists', methods: ['getPlaylists'], label: '歌单' },
  { capability: 'playlistDetail', methods: ['getPlaylistDetail'], label: '歌单详情' },
  { capability: 'albums', methods: ['getAlbum'], label: '专辑' },
  { capability: 'artists', methods: ['getArtist'], label: '艺人' },
  { capability: 'recommendations', methods: ['getRecommendations'], label: '推荐' },
  { capability: 'radio', methods: ['search'], label: '电台' },
]

/** Capabilities a source declares but cannot serve, with a human-readable label. */
export function findCapabilityGaps(source: MusicSource): string[] {
  return CAPABILITY_REQUIREMENTS.filter(
    (requirement) =>
      source.meta.capabilities[requirement.capability] &&
      !requirement.methods.some((method) => typeof source[method] === 'function'),
  ).map((requirement) => requirement.label)
}



/** Builds an online track that already carries its origin and source id. */
export function buildTrack(
  sourceId: SourceId,
  partial: Omit<AudioTrack, 'origin' | 'sourceId' | 'addedAt'> & { addedAt?: number },
): AudioTrack {
  return {
    ...partial,
    origin: 'online',
    sourceId,
    addedAt: partial.addedAt ?? Date.now(),
  }
}

export function defineCapabilities(partial: Partial<SourceCapabilities>): SourceCapabilities {
  return {
    search: false,
    stream: false,
    lyrics: false,
    playlists: false,
    playlistDetail: false,
    albums: false,
    artists: false,
    recommendations: false,
    radio: false,
    download: false,
    recognize: false,
    ...partial,
  }
}
