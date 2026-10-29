import { app, dialog, net, shell, type BrowserWindow } from 'electron'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { Readable } from 'node:stream'
import { AUDIO_EXTENSION_SET } from '../shared/constants'
import type { AudioTrack, DownloadSettings, DownloadStartInput, DownloadTask } from '../shared/types'
import { writeId3v23, type CoverArt } from './id3'
import { importAudioFiles, notifyLibraryChanged } from './library'
import { recordDiagnostics } from './diagnostics'
import { upstreamForMediaUrl } from './remote'
import { allSecrets } from './secretStore'
import { getSettings, updateSettings } from './settings'
import { getPlatformDescriptor, resolvePlatformTrack } from './platforms'
import { resolveStream } from './sources'
import { logRequest } from './sources/log'
import { isHostGranted, recordPendingHost } from './sources/permissions'
import { getEntry } from './sources/registry'

/**
 * The download manager.
 *
 * Design notes that matter:
 *
 *  - **Real bytes, real file.** Every task streams the resolved URL over `net.fetch` straight into
 *    `<name>.part` on disk, then renames it. `received` always equals what is actually on disk, so a
 *    pause, a crash or a restart keeps the bytes instead of restarting from zero (a resumed task
 *    sends `Range: bytes=<received>-`; a server that ignores the range makes the task start over
 *    rather than corrupting the file).
 *  - **The renderer never sees a media URL.** `start` takes a track and resolves its stream in the
 *    main process, exactly like playback does. Only the resulting *path* travels back.
 *  - **Host permission is a runtime check, not an admission test.** A source that declares hosts has
 *    its download request authorised the same way its search requests are: refused requests are
 *    recorded as pending and become one-click grants.
 *  - **State is main-process owned.** The renderer renders `DownloadTask` and asks for transitions
 *    (`pause`, `resume`, `retry`, `cancel`); it never computes progress or status by itself.
 */

const INDEX_VERSION = 1
const MAX_TASKS = 500
const MAX_AUTO_RETRIES = 2
const RETRY_DELAY_MS = 1200
const PROGRESS_FLOOR_MS = 250
const MAX_TAG_BYTES = 128 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

interface DownloadRecord {
  task: DownloadTask
  /** Track snapshot: the only way to resolve a stream again after a restart or a retry. */
  track: AudioTrack
  /** Upstream URL, resolved lazily. Never leaves this module. */
  upstreamUrl: string
  partPath: string
  controller: AbortController | null
  /** Set when the user paused/cancelled, so the resulting abort is not reported as a failure. */
  abortReason: 'pause' | 'cancel' | 'replace' | null
  sampleAt: number
  sampleBytes: number
  /** Bookkeeping for `clearFinished`-style sweeps; the DTO uses `task.updatedAt`. */
  settled: boolean
}

const records = new Map<string, DownloadRecord>()
let indexFile = ''
let fallbackDirectory = ''
let notifier: ((channel: string, payload: unknown) => void) | null = null
let ticker: NodeJS.Timeout | null = null
let persistTimer: NodeJS.Timeout | null = null
let lastNotifyAt = 0
let disposed = false

/** The main process broadcasts progress through this (mirrors the library's notifier). */
export function setDownloadNotifier(fn: ((channel: string, payload: unknown) => void) | null): void {
  notifier = fn
}

function notify(force = false): void {
  const now = Date.now()
  if (!force && now - lastNotifyAt < PROGRESS_FLOOR_MS) return
  lastNotifyAt = now
  notifier?.('downloads:progress', listDownloads())
}

function taskDto(record: DownloadRecord): DownloadTask {
  return { ...record.task }
}

export function listDownloads(): DownloadTask[] {
  return [...records.values()]
    .map(taskDto)
    .sort((a, b) => b.createdAt - a.createdAt)
}

export function downloadDirectory(settings: DownloadSettings = getSettings().downloads): string {
  const configured = settings.directory.trim()
  return configured || fallbackDirectory
}

function touch(record: DownloadRecord, patch: Partial<DownloadTask>): void {
  record.task = { ...record.task, ...patch, updatedAt: Date.now() }
}

/* ------------------------------------------------------------------ naming */

/**
 * Accepts a restored download name only if it is a plain basename.
 *
 * The index file is written by this module, but it sits in the user's profile where anything (another
 * copy of the app, a backup tool, the user) can edit it — and the name is later `join()`ed onto the
 * download directory. Rejecting separators and traversal keeps a tampered index from turning into a
 * write anywhere on disk.
 */
function plainFileName(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) return ''
  if (value.includes('/') || value.includes('\\') || value.includes('\u0000')) return ''
  if (value === '.' || value === '..' || value.startsWith('..')) return ''
  return value
}

/** Strips anything a filesystem would refuse, and never returns an empty stem. */
function safeStem(value: string): string {
  return (
    value
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^\.+/, '')
      .slice(0, 120) || '未命名'
  )
}

const UNKNOWN_ARTIST = new Set(['', '未知艺术家', '未知歌手', 'Unknown Artist', 'unknown'])

function buildStem(task: DownloadTask, template: DownloadSettings['nameTemplate']): string {
  const title = safeStem(task.title)
  const artist = safeStem(task.artist)
  const hasArtist = !UNKNOWN_ARTIST.has(task.artist.trim())
  if (template === 'title' || !hasArtist) return title
  return template === 'title-artist' ? `${title} - ${artist}` : `${artist} - ${title}`
}

const MIME_EXTENSIONS: Record<string, string> = {
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/flac': '.flac',
  'audio/x-flac': '.flac',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/wave': '.wav',
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/aac': '.aac',
  'audio/ogg': '.ogg',
  'application/ogg': '.ogg',
  'audio/opus': '.opus',
}

/** Prefers the extension the URL already carries, and falls back to the Content-Type. */
function extensionFor(url: string, contentType: string | null): string {
  try {
    const fromPath = extname(new URL(url).pathname).toLowerCase()
    if (fromPath && AUDIO_EXTENSION_SET.has(fromPath)) return fromPath
  } catch {
    // Unparseable URL: fall through to the content type.
  }
  const type = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  return MIME_EXTENSIONS[type] ?? '.mp3'
}

/** Finds a free file name so two tracks with the same title never overwrite each other. */
async function reserveName(directory: string, stem: string, extension: string, ignore: string): Promise<string> {
  for (let index = 1; index <= 200; index += 1) {
    const candidate = index === 1 ? `${stem}${extension}` : `${stem} (${index})${extension}`
    if (candidate === ignore) return candidate
    try {
      await stat(join(directory, candidate))
    } catch {
      return candidate
    }
  }
  return `${stem} (${Date.now()})${extension}`
}

/* ------------------------------------------------------------------ persistence */

interface IndexFileShape {
  version?: number
  tasks?: unknown
}

function asRecord(value: unknown): DownloadRecord | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as { task?: unknown; track?: unknown; upstreamUrl?: unknown }
  const task = raw.task as DownloadTask | undefined
  const track = raw.track as AudioTrack | undefined
  if (!task || typeof task.id !== 'string' || !task.id) return null
  if (!track || typeof track.id !== 'string') return null
  return {
    task: {
      id: task.id,
      trackId: typeof task.trackId === 'string' ? task.trackId : track.id,
      ...(typeof task.sourceId === 'string' ? { sourceId: task.sourceId } : {}),
      title: typeof task.title === 'string' ? task.title : track.title,
      artist: typeof task.artist === 'string' ? task.artist : track.artist,
      album: typeof task.album === 'string' ? task.album : track.album,
      ...(typeof task.cover === 'string' ? { cover: task.cover } : {}),
      ...(typeof task.requestedQuality === 'string' ? { requestedQuality: task.requestedQuality } : {}),
      ...(typeof task.quality === 'string' ? { quality: task.quality } : {}),
      // An interrupted task comes back paused: restarting it silently would surprise the user, and
      // the part file is already there waiting for a `resume`.
      status: task.status === 'completed' ? 'completed' : task.status === 'failed' ? 'failed' : task.status === 'canceled' ? 'canceled' : 'paused',
      received: Number.isFinite(task.received) ? Number(task.received) : 0,
      total: Number.isFinite(task.total) ? Number(task.total) : 0,
      speed: 0,
      eta: 0,
      filePath: typeof task.filePath === 'string' ? task.filePath : '',
      // The index lives on disk in the user's profile, so a name read back from it is untrusted
      // input: only a plain basename is accepted. `join(directory, '..\\..\\x')` would otherwise
      // write outside the download directory.
      fileName: plainFileName(task.fileName),
      ...(typeof task.error === 'string' ? { error: task.error } : {}),
      createdAt: Number.isFinite(task.createdAt) ? Number(task.createdAt) : Date.now(),
      updatedAt: Number.isFinite(task.updatedAt) ? Number(task.updatedAt) : Date.now(),
      attempts: Number.isFinite(task.attempts) ? Number(task.attempts) : 0,
      ...(task.tagged === true ? { tagged: true } : {}),
    },
    track,
    upstreamUrl: typeof raw.upstreamUrl === 'string' ? raw.upstreamUrl : '',
    partPath: '',
    controller: null,
    abortReason: null,
    sampleAt: Date.now(),
    sampleBytes: 0,
    settled: false,
  }
}

let pendingWrite: Promise<void> = Promise.resolve()
/** A failed index write is recorded once per session, not on every progress tick. */
let indexWriteFailureLogged = false

function persist(): void {
  if (!indexFile) return
  const payload = {
    version: INDEX_VERSION,
    tasks: [...records.values()].map((record) => ({ task: record.task, track: record.track, upstreamUrl: record.upstreamUrl })),
  }
  pendingWrite = writeFile(indexFile, JSON.stringify(payload, null, 2), 'utf8').catch((error: unknown) => {
    // Losing the index means interrupted downloads forget they exist; that must leave a
    // trace in diagnostics instead of vanishing silently.
    if (!indexWriteFailureLogged) {
      indexWriteFailureLogged = true
      recordDiagnostics('main', 'downloads-index-write', error instanceof Error ? error.message : String(error))
    }
    return undefined
  })
}

/**
 * Writes the index now and waits for it. Progress is only persisted on a debounce (and, without
 * this, a hard kill could lose the last few hundred milliseconds of a transfer) — but that costs
 * nothing, because a resumed task re-reads the `.part` file's real size before asking for a range.
 */
export async function flushDownloads(): Promise<void> {
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
  persist()
  await pendingWrite
}

function schedulePersist(): void {
  if (persistTimer) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    persist()
  }, 400)
}

export async function initDownloads(userDataDirectory: string): Promise<void> {
  disposed = false
  fallbackDirectory = join(userDataDirectory, 'downloads')
  indexFile = join(userDataDirectory, 'download-tasks.json')
  try {
    const raw = await readFile(indexFile, 'utf8')
    const parsed = JSON.parse(raw) as IndexFileShape
    const list = Array.isArray(parsed?.tasks) ? parsed.tasks : []
    for (const entry of list.slice(0, MAX_TASKS)) {
      const record = asRecord(entry)
      if (record) records.set(record.task.id, record)
    }
  } catch {
    // No index yet, or an unreadable one: start empty rather than refusing to launch.
  }
  if (!ticker) {
    ticker = setInterval(() => {
      if (disposed) return
      let active = false
      for (const record of records.values()) {
        if (record.task.status !== 'downloading') continue
        active = true
        const elapsed = (Date.now() - record.sampleAt) / 1000
        if (elapsed >= 0.75) {
          const gained = record.task.received - record.sampleBytes
          const speed = gained > 0 ? gained / elapsed : 0
          record.sampleAt = Date.now()
          record.sampleBytes = record.task.received
          touch(record, {
            speed: Math.round(speed),
            eta: speed > 0 && record.task.total > 0 ? Math.max(0, Math.round((record.task.total - record.task.received) / speed)) : 0,
          })
        } else if (record.task.speed > 0) {
          // Stalled stream: let the displayed speed fall back instead of lying indefinitely.
          touch(record, { speed: 0, eta: 0 })
        }
      }
      if (active) notify(true)
    }, 1000)
    ticker.unref?.()
  }
  notify(true)
}

export function disposeDownloads(): void {
  disposed = true
  for (const record of records.values()) {
    record.abortReason = 'cancel'
    record.controller?.abort()
  }
  if (ticker) clearInterval(ticker)
  ticker = null
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = null
  persist()
}

/* ------------------------------------------------------------------ queue */

function activeCount(): number {
  let count = 0
  for (const record of records.values()) {
    if (record.task.status === 'downloading') count += 1
  }
  return count
}

function nextQueued(): DownloadRecord | null {
  const queued = [...records.values()].filter((record) => record.task.status === 'queued')
  queued.sort((a, b) => a.task.createdAt - b.task.createdAt)
  return queued[0] ?? null
}

function pump(): void {
  if (disposed) return
  const { concurrency } = getSettings().downloads
  while (activeCount() < concurrency) {
    const next = nextQueued()
    if (!next) break
    void run(next)
  }
}

/**
 * Re-evaluates the queue. The IPC layer calls this after the download settings change, so raising
 * the concurrency starts the waiting tasks immediately instead of at the next completion.
 */
export function pumpDownloads(): void {
  pump()
}

/* ------------------------------------------------------------------ the download itself */

function fail(record: DownloadRecord, message: string): void {
  touch(record, { status: 'failed', error: message, speed: 0, eta: 0 })
  record.settled = true
  record.controller = null
  schedulePersist()
  notify(true)
  // A transient network failure retries on its own; a permission or unsupported-stream refusal does
  // not, because repeating it would only produce the same message again.
  if (record.task.attempts < MAX_AUTO_RETRIES && /网络|超时|中断|unavailable/i.test(message)) {
    const delay = RETRY_DELAY_MS * (record.task.attempts + 1)
    setTimeout(() => {
      if (disposed) return
      if (record.task.status !== 'failed') return
      touch(record, { attempts: record.task.attempts + 1, status: 'queued', error: undefined })
      schedulePersist()
      notify(true)
      pump()
    }, delay).unref?.()
  } else {
    pump()
  }
}

async function fetchCover(cover: string | undefined, sourceId: string | undefined): Promise<CoverArt | undefined> {
  if (!cover) return undefined
  const upstream = upstreamForMediaUrl(cover)?.url ?? (/^https?:/.test(cover) ? cover : '')
  if (!upstream) return undefined
  try {
    const response = await net.fetch(upstream, { redirect: 'follow' })
    if (!response.ok) return undefined
    const data = Buffer.from(await response.arrayBuffer())
    if (data.length === 0 || data.length > 4 * 1024 * 1024) return undefined
    return { mime: response.headers.get('content-type')?.split(';')[0] ?? 'image/jpeg', data }
  } catch {
    return undefined
  }
}

/**
 * Writes title/artist/album/cover into the finished file. Only MP3 participates: prepending an ID3
 * tag to any other container would corrupt it, so those files are left exactly as downloaded.
 *
 * The decision is made on the *final* name, not on `partPath` — the working file is called
 * `<name>.mp3.part`, whose extension is `.part`.
 */
async function writeTags(partPath: string, record: DownloadRecord): Promise<boolean> {
  const finalName = record.task.fileName || record.task.filePath
  if (extname(finalName).toLowerCase() !== '.mp3') return false
  try {
    const info = await stat(partPath)
    if (info.size === 0 || info.size > MAX_TAG_BYTES) return false
    const cover = await fetchCover(record.task.cover, record.task.sourceId)
    const tagged = writeId3v23(await readFile(partPath), {
      title: record.task.title,
      artist: record.task.artist,
      album: record.task.album,
      ...(cover ? { cover } : {}),
    })
    await writeFile(partPath, tagged)
    return true
  } catch {
    // Tagging is an enhancement: a failure must not fail the download.
    return false
  }
}

async function run(record: DownloadRecord): Promise<void> {
  const settings = getSettings()
  const downloadSettings = settings.downloads
  touch(record, { status: 'downloading', error: undefined, speed: 0, eta: 0 })
  record.abortReason = null
  record.sampleAt = Date.now()
  record.sampleBytes = record.task.received
  notify(true)

  // 1. Resolve the stream (once). A retry after a failure resolves again, because stream URLs expire.
  if (!record.upstreamUrl) {
    const sourceId = record.track.sourceId
    const wanted = record.task.requestedQuality
    if (!sourceId || !record.track.sourceTrackId) {
      fail(record, '该曲目缺少音源信息，无法下载')
      return
    }
    try {
      // Two resolution paths, because a track's `sourceId` is either a user source or a platform:
      // platform search results carry the *platform* id, and their play URL comes from whichever
      // enabled source declares that platform. Downloading a platform track must not need a second
      // code path in the UI, so the choice is made here.
      const resolved = getPlatformDescriptor(sourceId)
        ? await resolvePlatformTrack(record.track, wanted, settings, allSecrets())
        : await resolveStream(sourceId, record.track.sourceTrackId, settings, allSecrets(), {
            ...(wanted ? { quality: wanted } : {}),
            track: record.track,
          })
      if (!resolved?.url) {
        fail(record, '音源没有返回可下载的地址')
        return
      }
      if (resolved.live) {
        fail(record, '直播流没有结尾，无法下载')
        return
      }
      touch(record, {
        ...(resolved.quality ? { quality: resolved.quality } : {}),
      })
      record.upstreamUrl = upstreamForMediaUrl(resolved.url)?.url ?? resolved.url
    } catch (error) {
      fail(record, error instanceof Error ? error.message : '解析下载地址失败')
      return
    }
  }

  // 2. Authorise the host exactly like any other runtime request: a refusal is a grant prompt.
  const entry = record.task.sourceId ? getEntry(record.task.sourceId) : undefined
  if (entry && entry.allowedHosts.length > 0 && !isHostGranted(entry.allowedHosts, record.upstreamUrl)) {
    try {
      recordPendingHost(entry.id, new URL(record.upstreamUrl).host.toLowerCase(), record.upstreamUrl)
    } catch {
      // Malformed URL is handled by the fetch below.
    }
    fail(record, '尚未授权访问该主机，请在音源管理页允许后重试')
    return
  }

  // 3. Decide the file name once, so a resume keeps writing to the same target.
  const directory = downloadDirectory(downloadSettings)
  try {
    await mkdir(directory, { recursive: true })
  } catch (error) {
    fail(record, `无法创建下载目录：${error instanceof Error ? error.message : directory}`)
    return
  }

  // On a resume the part file on disk — not the persisted counter — is the source of truth for how
  // much was really written, so a crash mid-write cannot make the next range request skip bytes.
  if (record.task.fileName) {
    if (!record.partPath) record.partPath = join(directory, `${record.task.fileName}.part`)
    try {
      touch(record, { received: (await stat(record.partPath)).size })
    } catch {
      touch(record, { received: 0 })
    }
  }

  const controller = new AbortController()
  record.controller = controller

  let response: Response
  const started = Date.now()
  try {
    const headers: Record<string, string> = {}
    if (record.task.received > 0 && record.task.fileName) headers.Range = `bytes=${record.task.received}-`
    response = await net.fetch(record.upstreamUrl, { headers, redirect: 'follow', signal: controller.signal })
  } catch (error) {
    record.controller = null
    if (record.abortReason === 'pause') {
      touch(record, { status: 'paused', speed: 0, eta: 0 })
      record.abortReason = null
      schedulePersist()
      notify(true)
      pump()
      return
    }
    if (record.abortReason === 'cancel') {
      record.abortReason = null
      return
    }
    fail(record, controller.signal.aborted ? '下载超时' : `网络请求失败：${error instanceof Error ? error.message : ''}`)
    return
  }

  logRequest({
    sourceId: record.task.sourceId ?? 'download',
    url: record.upstreamUrl,
    method: 'GET',
    status: response.status,
    durationMs: Date.now() - started,
  })

  if (!response.ok || !response.body) {
    record.controller = null
    fail(record, `服务器返回 ${response.status}`)
    return
  }

  // A server that ignores `Range` answers 200: restart the file instead of appending to garbage.
  const resumable = response.status === 206 && record.task.received > 0
  const declared = Number(response.headers.get('content-length') ?? '0')
  const total = Number.isFinite(declared) && declared > 0 ? declared + (resumable ? record.task.received : 0) : record.task.total
  if (!resumable) touch(record, { received: 0 })

  if (!record.task.fileName) {
    const extension = extensionFor(record.upstreamUrl, response.headers.get('content-type'))
    const stem = buildStem(record.task, downloadSettings.nameTemplate)
    const fileName = await reserveName(directory, stem, extension, '')
    record.partPath = join(directory, `${fileName}.part`)
    touch(record, { fileName, filePath: join(directory, fileName), total, received: 0 })
  } else {
    touch(record, { total, received: resumable ? record.task.received : 0 })
  }
  schedulePersist()
  notify(true)

  const stream = createWriteStream(record.partPath, { flags: resumable ? 'a' : 'w' })
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)
  timeout.unref?.()

  try {
    const source = Readable.fromWeb(response.body as unknown as Parameters<typeof Readable.fromWeb>[0])
    for await (const chunk of source) {
      const buffer = chunk as Buffer
      if (!stream.write(buffer)) await once(stream, 'drain')
      record.task.received += buffer.length
    }
    stream.end()
    await once(stream, 'close')
  } catch (error) {
    clearTimeout(timeout)
    stream.destroy()
    record.controller = null
    if (record.abortReason === 'pause') {
      touch(record, { status: 'paused', speed: 0, eta: 0 })
      record.abortReason = null
      schedulePersist()
      notify(true)
      pump()
      return
    }
    if (record.abortReason === 'cancel') {
      record.abortReason = null
      return
    }
    fail(record, controller.signal.aborted ? '下载超时' : `连接中断：${error instanceof Error ? error.message : ''}`)
    return
  }
  clearTimeout(timeout)
  record.controller = null

  // 4. Finish: tag (MP3 only), then move the part file into place.
  const tagged = downloadSettings.writeTags && record.task.filePath ? await writeTags(record.partPath, record) : false
  try {
    await rename(record.partPath, record.task.filePath)
  } catch (error) {
    fail(record, `无法写入文件：${error instanceof Error ? error.message : ''}`)
    return
  }

  touch(record, {
    status: 'completed',
    received: record.task.received,
    total: record.task.total > 0 ? record.task.total : record.task.received,
    speed: 0,
    eta: 0,
    error: undefined,
    ...(tagged ? { tagged: true } : {}),
  })
  record.settled = true
  schedulePersist()
  notify(true)

  // A finished download is a real file on disk, so the local library should show it without the
  // user importing it by hand — that is the "下载完成后自动同步到本地音乐" behaviour. Importing is
  // idempotent (the library is keyed by path hash), so re-downloading the same song is a no-op
  // that reports "already in library" instead of duplicating the entry.
  if (record.task.filePath && AUDIO_EXTENSION_SET.has(extname(record.task.filePath).toLowerCase())) {
    void importAudioFiles([record.task.filePath])
      .then(() => notifyLibraryChanged())
      .catch(() => undefined)
  }

  pump()
}

/* ------------------------------------------------------------------ public controls */

export function startDownload(input: DownloadStartInput): DownloadTask | null {
  const track = input.track
  if (!track || track.origin !== 'online' || !track.sourceId) return null
  const existing = [...records.values()].find(
    (record) =>
      record.task.trackId === track.id &&
      (record.task.requestedQuality ?? '') === (input.quality ?? '') &&
      record.task.status !== 'failed' &&
      record.task.status !== 'canceled',
  )
  if (existing) return taskDto(existing)

  const now = Date.now()
  const id = createHash('sha1').update(`${track.id}|${input.quality ?? ''}|${now}`).digest('hex').slice(0, 16)
  const record: DownloadRecord = {
    task: {
      id,
      trackId: track.id,
      sourceId: track.sourceId,
      title: track.title,
      artist: track.artist,
      album: track.album,
      ...(track.cover ? { cover: track.cover } : {}),
      ...(input.quality ? { requestedQuality: input.quality } : {}),
      status: 'queued',
      received: 0,
      total: 0,
      speed: 0,
      eta: 0,
      filePath: '',
      fileName: '',
      createdAt: now,
      updatedAt: now,
      attempts: 0,
    },
    track,
    upstreamUrl: '',
    partPath: '',
    controller: null,
    abortReason: null,
    sampleAt: now,
    sampleBytes: 0,
    settled: false,
  }
  records.set(id, record)
  // Bounded: the oldest finished task is dropped rather than growing the index forever.
  if (records.size > MAX_TASKS) {
    const finished = [...records.values()]
      .filter((candidate) => candidate.settled)
      .sort((a, b) => a.task.updatedAt - b.task.updatedAt)
    for (const candidate of finished) {
      if (records.size <= MAX_TASKS) break
      records.delete(candidate.task.id)
    }
  }
  schedulePersist()
  notify(true)
  pump()
  return taskDto(record)
}

function stopActive(record: DownloadRecord, reason: 'pause' | 'cancel' | 'replace'): void {
  record.abortReason = reason
  record.controller?.abort()
}

export function pauseDownload(id: string): DownloadTask[] {
  const record = records.get(id)
  if (record) {
    if (record.task.status === 'downloading') stopActive(record, 'pause')
    else if (record.task.status === 'queued') {
      touch(record, { status: 'paused' })
      schedulePersist()
    }
    notify(true)
  }
  return listDownloads()
}

export function resumeDownload(id: string): DownloadTask[] {
  const record = records.get(id)
  if (record && (record.task.status === 'paused' || record.task.status === 'failed')) {
    touch(record, { status: 'queued', error: undefined })
    schedulePersist()
    notify(true)
    pump()
  }
  return listDownloads()
}

export function retryDownload(id: string): DownloadTask[] {
  const record = records.get(id)
  if (record) {
    if (record.task.status === 'downloading') stopActive(record, 'replace')
    // A fresh resolve: the previous URL may have expired, which is often why it failed at all.
    record.upstreamUrl = ''
    touch(record, { status: 'queued', error: undefined, received: 0, total: 0, speed: 0, eta: 0, attempts: 0 })
    schedulePersist()
    notify(true)
    pump()
  }
  return listDownloads()
}

export function cancelDownload(id: string): DownloadTask[] {
  const record = records.get(id)
  if (record) {
    const wasActive = record.task.status === 'downloading'
    if (wasActive) stopActive(record, 'cancel')
    const partPath = record.partPath
    void (async () => {
      if (partPath) await rm(partPath, { force: true }).catch(() => undefined)
      touch(record, { status: 'canceled', speed: 0, eta: 0, received: 0 })
      record.settled = true
      schedulePersist()
      notify(true)
    })()
  }
  return listDownloads()
}

export function removeDownload(id: string): DownloadTask[] {
  const record = records.get(id)
  if (record) {
    if (record.task.status === 'downloading') stopActive(record, 'cancel')
    const partPath = record.partPath || (record.task.filePath ? `${record.task.filePath}.part` : '')
    records.delete(id)
    if (partPath) void rm(partPath, { force: true }).catch(() => undefined)
    schedulePersist()
    notify(true)
  }
  return listDownloads()
}

export function clearFinishedDownloads(): DownloadTask[] {
  for (const [id, record] of [...records]) {
    if (record.task.status === 'completed' || record.task.status === 'failed' || record.task.status === 'canceled') {
      records.delete(id)
    }
  }
  schedulePersist()
  notify(true)
  return listDownloads()
}

export function revealDownload(id: string): boolean {
  const record = records.get(id)
  if (!record) return false
  const target = record.task.filePath || record.partPath
  if (!target) return false
  shell.showItemInFolder(target)
  return true
}

export async function openDownloadDirectory(): Promise<boolean> {
  const directory = downloadDirectory()
  await mkdir(directory, { recursive: true }).catch(() => undefined)
  const error = await shell.openPath(directory)
  return error === ''
}

export async function chooseDownloadDirectory(window: BrowserWindow | null): Promise<DownloadSettings | null> {
  const current = getSettings().downloads
  const result = window
    ? await dialog.showOpenDialog(window, {
        title: '选择下载目录',
        defaultPath: downloadDirectory(current),
        properties: ['openDirectory', 'createDirectory'],
      })
    : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
  if (result.canceled || result.filePaths.length === 0) return null
  const next = await updateSettings({ downloads: { directory: result.filePaths[0] ?? '' } })
  return next.downloads
}

/** Exposed for the smoke suites: the default target directory, so a test can assert on real files. */
export function defaultDownloadDirectory(): string {
  return fallbackDirectory || join(app.getPath('userData'), 'downloads')
}

/** Used by the tests to wait for a deterministic state without polling internals. */
export function waitForDownload(id: string, timeoutMs = 30_000): Promise<DownloadTask | null> {
  return new Promise((resolve) => {
    const started = Date.now()
    const check = (): void => {
      const record = records.get(id)
      if (!record) {
        resolve(null)
        return
      }
      if (record.settled || Date.now() - started > timeoutMs) {
        resolve(taskDto(record))
        return
      }
      setTimeout(check, 120)
    }
    check()
  })
}
