/*
 * Aurora Music — Android shell bridge.
 *
 * Implements the `window.aurora` capability surface (the same typed API the
 * Electron preload exposes) on top of WebView primitives, so the unmodified
 * desktop renderer can run inside the Capacitor Android shell:
 *
 *   - settings   -> localStorage, seeded from the desktop defaults
 *   - library    -> user-picked audio files; metadata via music-metadata;
 *                   blobs persisted in IndexedDB; playback via blob: URLs
 *   - lyrics     -> sidecar .lrc files picked together with the audio file
 *   - platforms  -> the five built-in platform descriptors; search reports
 *                   "unavailable" outcomes (resolution lives in the desktop
 *                   main process and is out of scope for this shell)
 *   - everything else -> honest minimal stubs (empty lists / disabled states)
 *
 * Anything not implemented explicitly falls through to a proxy that resolves
 * to undefined, and `on*` subscription methods return an unsubscribe function —
 * the renderer's service layer is written to degrade gracefully on that.
 */
import { parseBlob } from 'music-metadata-browser'
import { Buffer } from 'buffer'

// music-metadata-browser's dependency chain expects the Node-style Buffer
// global in browser environments; without it parseBlob throws and imports
// silently degrade to filename-only tracks.
;(globalThis as any).Buffer = Buffer

declare const window: any

const SEEDS = (window.__AURORA_SEEDS__ || {}) as {
  settings?: any
  platforms?: any[]
  appInfo?: any
}

/* ------------------------------------------------------------------ utils */

const clone = (v: any) => (v === undefined ? v : JSON.parse(JSON.stringify(v)))

function lsGet<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}
function lsSet(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage full / unavailable: session keeps working in memory */
  }
}

function hashString(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return Math.abs(h).toString(36)
}

/* -------------------------------------------------------------- IndexedDB */

let dbPromise: Promise<IDBDatabase> | null = null
function idb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('aurora-shell', 1)
      req.onupgradeneeded = () => {
        req.result.createObjectStore('files')
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }
  return dbPromise
}
async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await idb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('files', 'readwrite')
    tx.objectStore('files').put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}
async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await idb()
  return new Promise((resolve, reject) => {
    const req = db.transaction('files').objectStore('files').get(key)
    req.onsuccess = () => resolve(req.result as T)
    req.onerror = () => reject(req.error)
  })
}
async function idbDel(key: string): Promise<void> {
  const db = await idb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('files', 'readwrite')
    tx.objectStore('files').delete(key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

/* ----------------------------------------------------------------- events */

type Listener = (payload: any) => void
const listeners = new Map<string, Set<Listener>>()
function on(channel: string, fn: Listener): () => void {
  if (!listeners.has(channel)) listeners.set(channel, new Set())
  listeners.get(channel)!.add(fn)
  return () => listeners.get(channel)?.delete(fn)
}
function emit(channel: string, payload: any) {
  listeners.get(channel)?.forEach((fn) => {
    try {
      fn(payload)
    } catch {
      /* a broken listener must not break the bridge */
    }
  })
}

/* --------------------------------------------------------------- settings */

const SETTINGS_KEY = 'aurora-shell:settings'
let settingsCache: any = null
function loadSettings(): any {
  if (!settingsCache) {
    settingsCache = lsGet(SETTINGS_KEY, clone(SEEDS.settings || {}))
  }
  return settingsCache
}
function saveSettings() {
  lsSet(SETTINGS_KEY, settingsCache)
}
function mergePatch(target: any, patch: any): any {
  const out = { ...target }
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target?.[k] && typeof target[k] === 'object') {
      out[k] = mergePatch(target[k], v)
    } else {
      out[k] = v
    }
  }
  return out
}

/* ---------------------------------------------------------------- library */

const TRACKS_KEY = 'aurora-shell:tracks'
type StoredTrack = Record<string, any>
let tracksCache: StoredTrack[] | null = null

function loadTracks(): StoredTrack[] {
  if (!tracksCache) tracksCache = lsGet<StoredTrack[]>(TRACKS_KEY, [])
  return tracksCache
}
function saveTracks() {
  lsSet(TRACKS_KEY, tracksCache)
}

async function materialise(stored: StoredTrack): Promise<any> {
  const track = { ...stored }
  const blob = await idbGet<Blob>(`file:${stored.id}`).catch(() => undefined)
  track.fileUrl = blob ? URL.createObjectURL(blob) : ''
  const cover = await idbGet<Blob>(`cover:${stored.id}`).catch(() => undefined)
  if (cover) track.cover = URL.createObjectURL(cover)
  return track
}
async function materialiseAll(): Promise<any[]> {
  return Promise.all(loadTracks().map(materialise))
}

const AUDIO_EXT = /\.(mp3|flac|wav|m4a|aac|ogg|oga|opus|webm)$/i

function pickFiles(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.multiple = multiple
    input.style.display = 'none'
    document.body.appendChild(input)
    let settled = false
    const done = (files: File[]) => {
      if (settled) return
      settled = true
      input.remove()
      resolve(files)
    }
    input.addEventListener('change', () => done(Array.from(input.files || [])))
    // If the user cancels, `change` never fires; the focus heuristic keeps
    // the promise from hanging forever in the common case.
    setTimeout(() => done(Array.from(input.files || [])), 120_000)
    input.click()
  })
}

async function importFiles(files: File[]): Promise<any> {
  const added: any[] = []
  let duplicated = 0
  let failed = 0
  let skipped = 0
  const lrcByBase = new Map<string, string>()
  for (const f of files) {
    if (/\.lrc$/i.test(f.name)) {
      lrcByBase.set(f.name.replace(/\.lrc$/i, ''), await f.text().catch(() => ''))
    }
  }
  for (const file of files) {
    if (/\.lrc$/i.test(file.name)) continue
    if (!AUDIO_EXT.test(file.name) && !file.type.startsWith('audio/')) {
      skipped++
      continue
    }
    const id = `local-${hashString(`${file.name}:${file.size}:${file.lastModified}`)}`
    if (loadTracks().some((t) => t.id === id)) {
      duplicated++
      continue
    }
    try {
      const meta = await parseBlob(file).catch(() => null)
      const common: any = meta?.common || {}
      const format: any = meta?.format || {}
      if (common.picture?.length) {
        const pic = common.picture[0]
        await idbSet(`cover:${id}`, new Blob([pic.data], { type: pic.format || 'image/jpeg' })).catch(() => {})
      }
      await idbSet(`file:${id}`, file)
      const base = file.name.replace(/\.[^.]+$/, '')
      const lrc = lrcByBase.get(base)
      if (lrc) await idbSet(`lrc:${id}`, lrc).catch(() => {})
      const stored: StoredTrack = {
        id,
        origin: 'local',
        title: common.title || base,
        artist: common.artist || common.albumartist || '未知歌手',
        album: common.album || '未知专辑',
        duration: typeof format.duration === 'number' ? format.duration : 0,
        format: (format.codec || file.name.split('.').pop() || '').toString().toLowerCase(),
        bitrate: format.bitrate,
        sampleRate: format.sampleRate,
        bitsPerSample: format.bitsPerSample,
        addedAt: Date.now(),
        filePath: file.name,
      }
      loadTracks().push(stored)
      added.push(await materialise(stored))
    } catch {
      failed++
    }
  }
  if (added.length) {
    saveTracks()
    emit('library:changed', await materialiseAll())
  }
  return { added, duplicated, failed, skipped }
}

/* ----------------------------------------------------------------- lyrics */

function parseLrc(raw: string) {
  const lines: { start: number; text: string }[] = []
  let offsetMs = 0
  for (const line of raw.split(/\r?\n/)) {
    const om = line.match(/\[offset:\s*(-?\d+)\]/i)
    if (om) offsetMs = parseInt(om[1], 10)
    const stamps = [...line.matchAll(/\[(\d+):(\d+)(?:[.:](\d+))?\]/g)]
    if (!stamps.length) continue
    const text = line.replace(/\[[^\]]*\]/g, '').trim()
    for (const m of stamps) {
      const t = parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + (m[3] ? parseInt(m[3].padEnd(3, '0'), 10) / 1000 : 0)
      lines.push({ start: t, text })
    }
  }
  lines.sort((a, b) => a.start - b.start)
  return { lines, offsetMs }
}

async function lyricsFor(track: any) {
  const empty = { trackId: track?.id || '', lyrics: null, provider: null, label: '', instrumental: false }
  if (!track?.id) return empty
  const raw = await idbGet<string>(`lrc:${track.id}`).catch(() => undefined)
  if (!raw) return empty
  const { lines, offsetMs } = parseLrc(raw)
  if (!lines.length) return empty
  return {
    trackId: track.id,
    lyrics: { origin: 'local', synced: true, offsetMs, lines, title: track.title, artist: track.artist },
    provider: 'local',
    label: '本地歌词',
    confidence: 100,
    instrumental: false,
  }
}

/* ------------------------------------------------------------- the bridge */

const platformUnavailable = (p: any) => ({
  platformId: p.id,
  platformName: p.name,
  ok: false,
  tracks: [],
  error: { code: 'unavailable', message: '安卓版暂未接入在线平台解析' },
  latencyMs: 0,
})

const api: any = {
  library: {
    list: async () => materialiseAll(),
    missing: async () => [],
    addFiles: async () => importFiles(await pickFiles('audio/*,.mp3,.flac,.wav,.m4a,.aac,.ogg,.opus,.lrc', true)),
    addFolder: async () => importFiles(await pickFiles('audio/*,.mp3,.flac,.wav,.m4a,.aac,.ogg,.opus,.lrc', true)),
    addPaths: async () => ({ added: [], duplicated: 0, failed: 0, skipped: 0 }),
    pathsForFiles: () => [],
    remove: async (id: string) => {
      tracksCache = loadTracks().filter((t) => t.id !== id)
      saveTracks()
      await idbDel(`file:${id}`).catch(() => {})
      await idbDel(`cover:${id}`).catch(() => {})
      await idbDel(`lrc:${id}`).catch(() => {})
      emit('library:changed', await materialiseAll())
      return true
    },
    reveal: async () => false,
    onImportProgress: (fn: Listener) => on('library:import-progress', fn),
    scrape: async () => ({ updated: 0, failed: 0 }),
    setTags: async () => null,
    convert: async () => null,
    ffmpegStatus: async () => ({ available: false, installed: false, path: '', version: '' }),
    onScrapeProgress: (fn: Listener) => on('library:scrape-progress', fn),
    onChanged: (fn: Listener) => on('library:changed', fn),
  },
  platforms: {
    list: async () => clone(SEEDS.platforms || []),
    searchAll: async () => (SEEDS.platforms || []).map(platformUnavailable),
    searchOne: async (platformId: string) => {
      const p = (SEEDS.platforms || []).find((x: any) => x.id === platformId) || { id: platformId, name: platformId }
      return platformUnavailable(p)
    },
    health: async () => ({ ok: false, message: '安卓版暂未接入', checkedAt: Date.now() }),
    healthAll: async () => ({}),
    resolve: async () => ({ url: '', downloadAllowed: false }),
    lyrics: async (track: any) => lyricsFor(track),
    boards: async () => [],
    boardSongs: async () => [],
  },
  sources: {
    list: async () => [],
    searchAll: async () => [],
    searchOne: async () => ({ sourceId: '', sourceName: '', ok: false, tracks: [] }),
    recommendations: async () => [],
    playlists: async () => [],
    playlistDetail: async () => null,
    resolve: async () => ({ url: '', downloadAllowed: false }),
    requests: async () => [],
    setEnabled: async () => true,
    setConfig: async () => true,
    setOrder: async () => true,
    health: async () => ({ ok: false, message: '安卓版暂未接入', checkedAt: Date.now() }),
    pendingHosts: async () => [],
    grantHosts: async () => true,
    revokeHosts: async () => true,
    selfCheck: async () => null,
    selfCheckAll: async () => null,
    errors: async () => [],
  },
  customSources: {
    list: async () => [],
    templates: async () => [],
    validate: async () => ({ ok: false, errors: ['安卓版暂未接入自定义音源'] }),
    save: async () => ({ ok: false, errors: ['安卓版暂未接入自定义音源'] }),
    remove: async () => false,
    export: async () => '',
  },
  scriptSources: {
    list: async () => [],
    probe: async () => ({ ok: false, errors: ['安卓版暂未接入脚本音源'] }),
    save: async () => ({ ok: false, errors: ['安卓版暂未接入脚本音源'] }),
    remove: async () => false,
    reload: async () => false,
    export: async () => '',
    inspect: async () => null,
    lxLibraryOpen: async () => null,
    lxLibraryImport: async () => ({ ok: false, imported: 0 }),
    lxLibraryCancel: async () => true,
  },
  systemIntegration: {
    get: async () => clone(loadSettings().systemIntegration || {}),
    set: async (patch: any) => {
      settingsCache = mergePatch(loadSettings(), { systemIntegration: patch })
      saveSettings()
      return clone(settingsCache.systemIntegration)
    },
    status: async () => ({ supported: false, tray: false, taskbarButtons: false, mediaKeys: false, launchAtLogin: false }),
  },
  sourceImport: {
    fromFile: async () => ({ ok: false, message: '安卓版暂未接入音源导入' }),
    fromText: async () => ({ ok: false, message: '安卓版暂未接入音源导入' }),
  },
  lyrics: {
    get: async (track: any) => lyricsFor(track),
    search: async (track: any) => lyricsFor(track),
    match: async (track: any) => lyricsFor(track),
    save: async (track: any, raw: string) => {
      if (track?.id && raw) await idbSet(`lrc:${track.id}`, raw).catch(() => {})
      return lyricsFor(track)
    },
    clear: async (track: any) => {
      if (track?.id) await idbDel(`lrc:${track.id}`).catch(() => {})
      return true
    },
  },
  settings: {
    get: async () => clone(loadSettings()),
    set: async (patch: any) => {
      settingsCache = mergePatch(loadSettings(), patch)
      saveSettings()
      return clone(settingsCache)
    },
  },
  player: {
    report: async () => true,
    onCommand: (_fn: Listener) => () => {},
  },
  desktopLyrics: {
    setEnabled: async (enabled: boolean) => {
      settingsCache = mergePatch(loadSettings(), { desktopLyrics: { enabled } })
      saveSettings()
      return enabled
    },
    toggle: async () => {
      const next = !loadSettings().desktopLyrics?.enabled
      settingsCache = mergePatch(loadSettings(), { desktopLyrics: { enabled: next } })
      saveSettings()
      return next
    },
    options: async () => clone(loadSettings().desktopLyrics || {}),
    setOptions: async (patch: any) => {
      settingsCache = mergePatch(loadSettings(), { desktopLyrics: patch })
      saveSettings()
      return clone(settingsCache.desktopLyrics)
    },
    resetPosition: async () => true,
  },
  downloads: {
    list: async () => [],
    start: async () => null,
    pause: async () => false,
    resume: async () => false,
    retry: async () => false,
    cancel: async () => false,
    remove: async () => false,
    clearFinished: async () => true,
    reveal: async () => false,
    openDirectory: async () => false,
    chooseDirectory: async () => '',
    onProgress: (fn: Listener) => on('downloads:progress', fn),
  },
  app: {
    info: async () => ({
      name: 'aurora-music',
      version: '0.1.0',
      electron: '',
      platform: 'android',
      arch: '',
      dataPath: '',
      ...(SEEDS.appInfo ? { version: SEEDS.appInfo.version } : {}),
    }),
    setTheme: async () => true,
    sampleBackdrop: async (rects: any[]) => (rects || []).map(() => null),
    setChrome: async () => true,
  },
  themes: {
    list: async () => [],
    import: async () => null,
    remove: async () => false,
    reveal: async () => false,
  },
  cache: {
    report: async () => ({ total: 0, areas: {} }),
    clear: async () => true,
  },
  backup: {
    export: async () => '',
    pick: async () => null,
    apply: async () => false,
    revert: async () => false,
    commit: async () => false,
  },
  diagnostics: {
    report: async () => ({ entries: [], crashes: [] }),
    clear: async () => true,
    export: async () => '',
    reveal: async () => false,
    record: async () => true,
  },
  updates: {
    check: async () => ({ available: false, current: '0.1.0', latest: '0.1.0' }),
    open: async () => false,
  },
  httpApi: {
    status: async () => ({ running: false, enabled: false, port: loadSettings().httpApi?.port || 47821, token: '' }),
    set: async (patch: any) => {
      settingsCache = mergePatch(loadSettings(), { httpApi: patch })
      saveSettings()
      return { running: false, enabled: Boolean(settingsCache.httpApi?.enabled), port: settingsCache.httpApi?.port, token: '' }
    },
    regenerateToken: async () => '',
  },
  database: {
    stats: async () => ({ tracks: loadTracks().length, sizeBytes: 0 }),
  },
}

/* Safety net: any surface the shim does not implement explicitly resolves
 * harmlessly instead of throwing inside the renderer. */
function withSafetyNet(target: any): any {
  return new Proxy(target, {
    get(t, prop) {
      if (prop in t) return t[prop]
      return new Proxy(
        {},
        {
          get(_t2, method) {
            if (typeof method === 'string' && method.startsWith('on')) {
              return (_fn: Listener) => () => {}
            }
            return async () => undefined
          },
        },
      )
    },
  })
}

window.aurora = withSafetyNet(api)
window.__AURORA_SHELL__ = true
