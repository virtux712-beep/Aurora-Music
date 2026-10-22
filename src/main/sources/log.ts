import type { SourceErrorCode, SourceErrorLogEntry, SourceRequestLogEntry } from '../../shared/types'

/**
 * Diagnostics for the source layer.
 *
 * This lives *below* the registry and *above* the HTTP path so that both are recorded the same way,
 * whoever the caller is (built-in plugin, declarative manifest or sandboxed script):
 *
 *  - `logSourceError` keeps a small per-source history, which is the only way a user can see why a
 *    source misbehaves (the previous implementation kept this in a private Map nothing could read);
 *  - `logRequest` records every outbound request so the source manager can show what a source
 *    actually asked for — including rejected hosts.
 *
 * Both buffers are bounded: a broken or chatty source must not grow memory without limit.
 */
const ERROR_LOG_LIMIT = 20
const REQUEST_LOG_LIMIT = 50

/**
 * Query parameters whose *value* is never written to the log.
 *
 * Plenty of APIs take their key as a query parameter, and a script source is free to do the
 * same, so a log that shows the raw URL would quietly persist credentials. Values are replaced
 * wholesale; the key is kept so the log still shows what was asked for.
 */
const SENSITIVE_QUERY_KEYS = [
  'token',
  'access_token',
  'refresh_token',
  'api_key',
  'apikey',
  'key',
  'secret',
  'client_secret',
  'password',
  'passwd',
  'pwd',
  'sign',
  'signature',
  'signaturenonce',
  'auth',
  'authorization',
  'session',
  'sessionid',
  'cookie',
  'ticket',
]

const SENSITIVE_HEADER_HINTS = ['auth', 'cookie', 'token', 'key', 'secret', 'credential', 'password', 'sign']

function isSensitiveName(name: string): boolean {
  const lower = name.toLowerCase()
  return SENSITIVE_QUERY_KEYS.includes(lower) || SENSITIVE_HEADER_HINTS.some((hint) => lower.includes(hint))
}

/** Masks credential-bearing query values. Never throws: an unparseable URL is passed through. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.username || parsed.password) {
      parsed.username = '***'
      parsed.password = ''
    }
    for (const key of [...parsed.searchParams.keys()]) {
      if (isSensitiveName(key)) parsed.searchParams.set(key, '***')
    }
    return parsed.toString()
  } catch {
    return url.length > 300 ? `${url.slice(0, 300)}…` : url
  }
}

/** Masks credential-bearing header values, keeping the header names visible. */
export function redactHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    out[name] = isSensitiveName(name) ? '***' : String(value).slice(0, 200)
  }
  return Object.keys(out).length > 0 ? out : undefined
}

const errorLogs = new Map<string, SourceErrorLogEntry[]>()
const requestLog: SourceRequestLogEntry[] = []

export function logSourceError(sourceId: string, code: SourceErrorCode, message: string, operation: string): void {
  const entry: SourceErrorLogEntry = { at: Date.now(), code, message: message.slice(0, 500), operation }
  const list = errorLogs.get(sourceId) ?? []
  // Newest first.
  errorLogs.set(sourceId, [entry, ...list].slice(0, ERROR_LOG_LIMIT))
}

export function readErrorLog(sourceId: string): SourceErrorLogEntry[] {
  return [...(errorLogs.get(sourceId) ?? [])]
}

export function clearErrorLog(sourceId?: string): void {
  if (sourceId) errorLogs.delete(sourceId)
  else errorLogs.clear()
}

export function logRequest(entry: Omit<SourceRequestLogEntry, 'at'> & { at?: number }): void {
  requestLog.unshift({
    at: entry.at ?? Date.now(),
    ...entry,
    url: redactUrl(entry.url),
    headers: redactHeaders(entry.headers),
  })
  requestLog.length = Math.min(requestLog.length, REQUEST_LOG_LIMIT)
}

export function readRequestLog(sourceId?: string): SourceRequestLogEntry[] {
  return sourceId ? requestLog.filter((entry) => entry.sourceId === sourceId) : [...requestLog]
}
