import { gunzipSync, inflateRawSync, inflateSync } from 'node:zlib'
import { isValidScriptId } from '../../shared/scriptSource'

/**
 * Reads a 洛雪音乐 (LX Music) **source library** file.
 *
 * This is the format LX writes to `<userData>/LxDatas/user_api.json`, and it is what a user actually
 * has on their machine: one file holding every source they ever installed. Asking them to re-export
 * twenty `.js` files by hand would be the difference between "Aurora can host your sources" and
 * "Aurora can host your sources if you retype them", so the library file is a first-class import.
 *
 * Three shapes exist in the wild, and all three are accepted — the detection is by structure, not by
 * a version number, because LX never wrote one:
 *
 *   1. `{ userApis: [ { id, name, version, author, script }, … ] }`  — current (2.x)
 *   2. `[ { id, name, script }, … ]`                                 — a bare array, from exports
 *   3. `{ "<id>": "<gz_…>", … }`                                     — the older key→payload map
 *
 * `script` is `gz_` followed by base64-encoded **zlib deflate** (not gzip, despite the prefix — the
 * magic bytes are `78 9c`). Both are tolerated, and so is plain source text, because a
 * hand-assembled library file is a legitimate thing to have.
 *
 * Nothing here decides whether a source may run: this module only turns bytes into text. Whether the
 * text is *usable* is answered by actually running it (see `probeScriptImport`).
 */
export interface LxLibraryEntry {
  /** The library's own id, when it has one. Stable across re-imports, so upgrades land in place. */
  libraryId: string
  name: string
  version: string
  author: string
  description: string
  homepage: string
  sourceText: string
}

export interface LxLibraryParseResult {
  ok: boolean
  errors: string[]
  entries: LxLibraryEntry[]
  /**
   * Entries whose payload could not be turned into text.
   *
   * They are reported separately instead of being dropped: "one of your twenty sources cannot be
   * read" is information the user needs, and a list that is quietly shorter than their library is
   * how they end up wondering which one went missing.
   */
  undecodable: { id: string; name: string; reason: string }[]
}

const MAX_LIBRARY_BYTES = 64 * 1024 * 1024
const MAX_LIBRARY_ENTRIES = 200

function inflateAny(kind: 'inflate' | 'inflateRaw' | 'gunzip', raw: Buffer): Buffer {
  if (kind === 'inflate') return inflateSync(raw)
  if (kind === 'inflateRaw') return inflateRawSync(raw)
  return gunzipSync(raw)
}

/** `gz_<base64>` (or bare base64) → text; already-plain text is returned unchanged. */
export function decodeLxScript(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null

  // Plain source text: a library file may legitimately hold it.
  if (/^\/[/*]|^\s*(?:const|let|var|function|\(function|import)\b/.test(trimmed) && !trimmed.startsWith('gz_')) {
    return trimmed
  }

  const body = trimmed.startsWith('gz_') ? trimmed.slice(3) : trimmed
  // Base64 only: any other character means this was never encoded.
  if (!/^[A-Za-z0-9+/=\s]+$/.test(body)) return null
  let raw: Buffer
  try {
    raw = Buffer.from(body, 'base64')
  } catch {
    return null
  }
  if (raw.length === 0) return null

  // `inflate` (zlib-wrapped) is what LX writes; `inflateRaw` covers a file that was re-compressed
  // without the zlib header, and `gunzip` covers one saved through a gzip-only tool. Trying all
  // three costs nothing and means a user never has to know which one their file used.
  for (const attempt of ['inflate', 'inflateRaw', 'gunzip'] as const) {
    try {
      const text = inflateAny(attempt, raw).toString('utf8')
      if (text.trim()) return text
    } catch {
      // next candidate
    }
  }
  return null
}

/** Named `field`, not `text`: `parseLxLibrary(text)` takes a parameter with that name, and shadowing
 * the helper would turn a typo into "Type 'String' has no call signatures". */
function field(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

/**
 * A library id has to survive becoming a directory name, and `isValidScriptId` is that rule. An id
 * that fails it is regenerated from the display name instead of being rejected — the id is plumbing,
 * not something the user cares about.
 */
function sourceIdFor(libraryId: string, name: string, index: number): string {
  if (isValidScriptId(libraryId)) return libraryId
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  if (isValidScriptId(slug)) return slug
  return `lx-${index}`
}

function entryFrom(
  raw: Record<string, unknown>,
  index: number,
  fallbackId: string,
  sourceText: string,
): LxLibraryEntry {
  const name = field(raw.name, 80) || fallbackId || `音源 ${index + 1}`
  return {
    libraryId: sourceIdFor(field(raw.id, 48), name, index),
    name,
    version: field(raw.version, 40) || '1.0.0',
    author: field(raw.author, 80),
    description: field(raw.description, 200),
    homepage: field(raw.homepage, 200),
    sourceText,
  }
}

/** Parses a library file. Every entry is decoded; a broken one is reported, not silently dropped. */
export function parseLxLibrary(text: string): LxLibraryParseResult {
  const errors: string[] = []
  if (Buffer.byteLength(text, 'utf8') > MAX_LIBRARY_BYTES) {
    return {
      ok: false,
      errors: [`文件过大（上限 ${Math.round(MAX_LIBRARY_BYTES / 1024 / 1024)}MB）`],
      entries: [],
      undecodable: [],
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, errors: ['不是合法的 JSON（洛雪音源库应是 user_api.json）'], entries: [], undecodable: [] }
  }

  const entries: LxLibraryEntry[] = []
  const undecodable: { id: string; name: string; reason: string }[] = []
  const push = (candidate: unknown, index: number, fallbackId: string): void => {
    const record =
      candidate && typeof candidate === 'object' && !Array.isArray(candidate)
        ? (candidate as Record<string, unknown>)
        : null
    const payload = record ? (record.script ?? record.source ?? record.text ?? record.code) : candidate
    const decoded = decodeLxScript(payload)
    if (!decoded) {
      const label = record ? field(record.name, 40) || fallbackId : fallbackId
      const reason = '脚本无法解码（不是 gz_ 压缩内容，也不是纯文本）'
      errors.push(`「${label}」的${reason}`)
      undecodable.push({ id: sourceIdFor(field(record?.id, 48), label, index), name: label, reason })
      return
    }
    entries.push(entryFrom(record ?? {}, index, fallbackId, decoded))
  }

  if (Array.isArray(parsed)) {
    parsed.slice(0, MAX_LIBRARY_ENTRIES).forEach((item, index) => push(item, index, `lx-${index + 1}`))
  } else if (parsed && typeof parsed === 'object') {
    const root = parsed as Record<string, unknown>
    const list = [root.userApis, root.scripts, root.sources, root.data, root.list].find((value) => Array.isArray(value))
    if (Array.isArray(list)) {
      list.slice(0, MAX_LIBRARY_ENTRIES).forEach((item, index) => push(item, index, `lx-${index + 1}`))
    } else {
      // The key→payload map: every string value is a source.
      const keys = Object.keys(root).slice(0, MAX_LIBRARY_ENTRIES)
      keys.forEach((key, index) => {
        if (typeof root[key] === 'string') push({ id: key, name: key }, index, key)
      })
    }
  }

  if (entries.length === 0 && undecodable.length === 0 && errors.length === 0) {
    errors.push('这个文件里没有找到任何音源（未识别到 userApis / 脚本数组 / id→脚本 映射）')
  }
  return {
    ok: errors.length === 0 && (entries.length > 0 || undecodable.length > 0),
    errors,
    entries,
    undecodable,
  }
}
