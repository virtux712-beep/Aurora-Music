import { app, dialog, shell, type BrowserWindow } from 'electron'
import { appendFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DiagnosticsEntry, DiagnosticsExportResult, DiagnosticsReport, DiagnosticsSource } from '../shared/maintenance'

/**
 * The crash log.
 *
 * A music player that dies silently on someone's machine is unfixable — there is nothing to ask for.
 * So every failure Aurora can see is appended to one JSONL file with a category, a timestamp and the
 * app version, and the settings page can show, copy or export it.
 *
 * What is deliberately *not* recorded: file paths, track metadata, source credentials, the local API
 * token. The log is meant to be safe to paste into a bug report, so `scrub` strips anything that looks
 * like a Windows path or a long token before the line is written.
 */

const MAX_MESSAGE = 600
const MAX_ENTRIES_KEPT = 300
const MAX_LOG_BYTES = 512 * 1024

let logPath = ''
let entries: DiagnosticsEntry[] = []
let logBytes = 0
let sequence = 0
let installed = false

/**
 * Every write goes through this chain.
 *
 * Appends and rotations both touch the same file, and `appendFile` is asynchronous: without ordering, a
 * rotation can read the file while an append is still in flight and write back a version missing that line.
 * Chaining them means the log on disk is always one of the sequential outcomes, never a mixture.
 */
let writeQueue: Promise<void> = Promise.resolve()

function enqueueWrite(task: () => Promise<void>): void {
  writeQueue = writeQueue.then(task).catch(() => undefined)
}

/** Removes paths and token-shaped strings: the log is a support artifact, not a privacy leak. */
function scrub(message: string): string {
  return message
    .replace(/[A-Za-z]:\\[^\s"']+/g, '<path>')
    .replace(/\\\\[^\s"']+/g, '<path>')
    .replace(/\/(?:Users|home)\/[^\s"']+/g, '<path>')
    .replace(/[A-Za-z0-9_-]{32,}/g, '<token>')
    .slice(0, MAX_MESSAGE)
}

export function recordDiagnostics(source: DiagnosticsSource, kind: string, message: string): DiagnosticsEntry {
  sequence += 1
  const entry: DiagnosticsEntry = {
    id: `${Date.now().toString(36)}-${sequence.toString(36)}`,
    at: Date.now(),
    source,
    kind: kind.slice(0, 60) || 'error',
    message: scrub(message || 'no message'),
    version: app.getVersion(),
  }
  entries = [entry, ...entries].slice(0, MAX_ENTRIES_KEPT)
  if (logPath) {
    const line = `${JSON.stringify(entry)}\n`
    logBytes += Buffer.byteLength(line)
    // A log that grows forever eventually becomes a disk-space bug of its own.
    const rotate = logBytes > MAX_LOG_BYTES
    enqueueWrite(async () => {
      await appendFile(logPath, line, 'utf8')
      if (rotate) await trimLog()
    })
  }
  return entry
}

/**
 * Keeps the newest half of an oversized log.
 *
 * This used to delete the file outright. That discarded the entire history at exactly the moment someone
 * would want it: a crash loop is both the reason the log grew past its cap and the only record of why.
 */
async function trimLog(): Promise<void> {
  const raw = await readFile(logPath, 'utf8')
  const lines = raw.split('\n').filter(Boolean)
  const keep: string[] = []
  let bytes = 0
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const size = Buffer.byteLength(lines[index], 'utf8') + 1
    if (bytes + size > MAX_LOG_BYTES / 2 && keep.length > 0) break
    keep.unshift(lines[index])
    bytes += size
  }
  await writeFile(logPath, keep.length ? `${keep.join('\n')}\n` : '', 'utf8')
  logBytes = bytes
}

async function loadExisting(): Promise<void> {
  try {
    const raw = await readFile(logPath, 'utf8')
    logBytes = Buffer.byteLength(raw)
    entries = raw
      .split('\n')
      .filter(Boolean)
      .slice(-MAX_ENTRIES_KEPT)
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line) as DiagnosticsEntry
          return typeof parsed.at === 'number' ? [parsed] : []
        } catch {
          return []
        }
      })
      .reverse()
  } catch {
    entries = []
  }
}

export async function initDiagnostics(userData: string): Promise<void> {
  logPath = join(userData, 'logs', 'crash.jsonl')
  try {
    await mkdir(join(userData, 'logs'), { recursive: true })
  } catch {
    // A missing log directory must not stop startup; the in-memory list still works.
  }
  await loadExisting()
  if (installed) return
  installed = true
  process.on('uncaughtException', (error) => {
    recordDiagnostics('main', 'uncaught-exception', error?.stack ?? String(error))
  })
  process.on('unhandledRejection', (reason) => {
    recordDiagnostics('main', 'unhandled-rejection', reason instanceof Error ? (reason.stack ?? reason.message) : String(reason))
  })
}

function version(): string {
  return app.getVersion()
}

export async function diagnosticsReport(): Promise<DiagnosticsReport> {
  let bytes = logBytes
  try {
    bytes = (await stat(logPath)).size
  } catch {
    bytes = logBytes
  }
  return { logPath, bytes, entries: entries.slice(0, MAX_ENTRIES_KEPT), version: version(), total: entries.length }
}

export async function clearDiagnostics(): Promise<DiagnosticsReport> {
  // Cleared through the same queue as the writes, so a line that was already in flight cannot land after
  // the clear and make the button look like it half-worked. The wait is also why the report below is
  // truthful: it measures the file after the removal, not before.
  entries = []
  logBytes = 0
  await writeQueue.then(() => rm(logPath, { force: true })).catch(() => undefined)
  return diagnosticsReport()
}

export async function exportDiagnostics(window: BrowserWindow | null): Promise<DiagnosticsExportResult> {
  const content = entries.map((entry) => JSON.stringify(entry)).join('\n')
  const body = `${JSON.stringify({ kind: 'aurora-diagnostics', version: version(), exportedAt: new Date().toISOString() }, null, 2)}\n${content}\n`
  const choice = window
    ? await dialog.showSaveDialog(window, {
        title: '导出诊断日志',
        defaultPath: join(app.getPath('documents'), `aurora-diagnostics-${Date.now()}.txt`),
        filters: [{ name: '诊断日志', extensions: ['txt', 'jsonl'] }],
      })
    : { canceled: true, filePath: undefined }
  if (choice.canceled || !choice.filePath) return { saved: false, canceled: true, path: '', bytes: 0 }
  await writeFile(choice.filePath, body, 'utf8')
  return { saved: true, canceled: false, path: choice.filePath, bytes: Buffer.byteLength(body) }
}

export function revealLogFolder(): boolean {
  // Best effort by definition: opening the OS file browser has no failure channel we could report,
  // and a `void` return is not something to test for truthiness.
  shell.showItemInFolder(logPath)
  return true
}
