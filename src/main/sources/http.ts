import { SourceError, classifyStatus, statusMessage } from './errors'
import { logRequest } from './log'
import { isHostGranted, recordPendingHost } from './permissions'
import { insecureRequestReason } from './policy'

/**
 * The one HTTP path every source plugin may use. Centralising it means timeout, retry, abort and
 * response-size limits are implemented once instead of being re-invented (or forgotten) per plugin.
 *
 * Renderer code never reaches this file: the main process is the only network egress. Script sources
 * reach it through the sandbox bridge (`main/scriptHost/host.ts`), which enforces the host allowlist
 * before calling in here — so `hostAllowlist` has exactly one meaning everywhere.
 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'

export interface RequestOptions {
  /** Milliseconds before the request is aborted. Defaults to 12s. */
  timeoutMs?: number
  /** Extra attempts after the first failure (only for retryable failures). Defaults to 1. */
  retries?: number
  headers?: Record<string, string>
  /** Request method. Defaults to GET; anything else requires `body` or `form`. */
  method?: HttpMethod
  /** Raw request body (sent as-is; set `Content-Type` yourself when it is not JSON). */
  body?: string
  /** `application/x-www-form-urlencoded` body, encoded here so callers cannot get it subtly wrong. */
  form?: Record<string, string>
  /** Hard cap on the response body, to survive a misbehaving endpoint. Defaults to 6 MiB. */
  maxBytes?: number
  /** Human label used inside error messages. */
  label?: string
  /**
   * Redirect policy. Built-in sources follow redirects; custom sources pass `'error'` so a
   * redirect can never send a request to a host the manifest did not declare.
   */
  redirect?: 'follow' | 'error' | 'manual'
  /** When present, the request proceeds only if the URL's host is listed here. */
  hostAllowlist?: string[]
  /** Which source is making the request, so the request log can attribute it. */
  sourceId?: string
  /**
   * Headers are logged (redacted) when this is true. Off by default so the existing built-in
   * sources keep their compact log lines.
   */
  logHeaders?: boolean
}

/** A response that has not been interpreted yet — text/status/headers, nothing more. */
export interface TextResponse {
  status: number
  ok: boolean
  headers: Record<string, string>
  text: string
  /** Final URL after redirects, when the platform reports one. */
  url: string
}

const USER_AGENT = 'AuroraMusic/0.1.0 (+https://github.com/aurora-music)'

function isRetryable(error: unknown): boolean {
  return error instanceof SourceError && (error.code === 'NETWORK_ERROR' || error.code === 'TIMEOUT' || error.code === 'RATE_LIMITED')
}

/**
 * Enforces the caller's granted hosts. A refusal is a runtime permission event, not a compile-time
 * judgement about the source: it is logged (status 0) and recorded as *pending*, so the source
 * manager can offer a one-click grant and the same request will then succeed.
 */
function assertHostAllowed(url: string, options: RequestOptions): void {
  if (!options.hostAllowlist) return
  let host: string
  try {
    host = new URL(url).host.toLowerCase()
  } catch {
    throw new SourceError('INVALID_RESPONSE', `${options.label ?? '音源'}：请求地址不合法`)
  }
  // 安全模式 is checked before the allowlist: a refused host is a thing the user is offered a grant
  // for, and offering one for a request that safe mode would refuse anyway is a dead end.
  const insecure = insecureRequestReason(url)
  if (insecure) throw new SourceError('UNSUPPORTED', `${options.label ?? '音源'}：${insecure}`)
  if (isHostGranted(options.hostAllowlist, url)) return
  // Recorded with status 0: a refused request is exactly what a user needs to be able to see.
  logRequest({
    sourceId: options.sourceId ?? 'unknown',
    url,
    method: options.method ?? 'GET',
    status: 0,
    durationMs: 0,
  })
  recordPendingHost(options.sourceId ?? 'unknown', host, url)
  throw new SourceError(
    'PERMISSION',
    `${options.label ?? '音源'}：尚未授权访问 ${host}，请在音源管理页允许该主机后重试`,
  )
}

async function attempt(url: string, options: RequestOptions): Promise<TextResponse> {
  const {
    timeoutMs = 12_000,
    maxBytes = 6 * 1024 * 1024,
    headers = {},
    label = '音源',
    redirect = 'follow',
    method = 'GET',
  } = options

  assertHostAllowed(url, options)

  const outgoing: Record<string, string> = { 'User-Agent': USER_AGENT, Accept: 'application/json', ...headers }
  let body: string | undefined
  if (options.form) {
    body = new URLSearchParams(options.form).toString()
    if (!Object.keys(outgoing).some((name) => name.toLowerCase() === 'content-type')) {
      outgoing['Content-Type'] = 'application/x-www-form-urlencoded'
    }
  } else if (options.body !== undefined) {
    body = options.body
    if (!Object.keys(outgoing).some((name) => name.toLowerCase() === 'content-type')) {
      outgoing['Content-Type'] = 'application/json'
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const started = Date.now()
  const log = (status: number): void =>
    logRequest({
      sourceId: options.sourceId ?? 'unknown',
      url,
      method,
      status,
      durationMs: Date.now() - started,
      ...(options.logHeaders ? { headers: outgoing } : {}),
    })

  try {
    let response: Response
    try {
      response = await fetch(url, {
        method,
        headers: outgoing,
        body,
        signal: controller.signal,
        redirect,
      })
    } catch (error) {
      log(0)
      if (controller.signal.aborted) throw new SourceError('TIMEOUT', `${label}：请求超时（${timeoutMs}ms）`)
      void error
      throw new SourceError('NETWORK_ERROR', `${label}：网络请求失败`)
    }

    log(response.status)

    if (!response.ok) {
      const code = classifyStatus(response.status)
      throw new SourceError(code, statusMessage(code, label))
    }

    const declared = Number(response.headers.get('content-length') ?? '0')
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new SourceError('INVALID_RESPONSE', `${label}：响应体过大（${declared} 字节）`)
    }

    const text = await response.text()
    if (text.length > maxBytes) {
      throw new SourceError('INVALID_RESPONSE', `${label}：响应体过大`)
    }

    const responseHeaders: Record<string, string> = {}
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value
    })

    return { status: response.status, ok: true, headers: responseHeaders, text, url: response.url || url }
  } finally {
    clearTimeout(timer)
  }
}

/** Fetches a URL and returns the raw text plus status/headers, retrying transient failures. */
export async function requestText(url: string, options: RequestOptions = {}): Promise<TextResponse> {
  const { retries = 1 } = options
  let lastError: unknown
  for (let attemptIndex = 0; attemptIndex <= retries; attemptIndex += 1) {
    try {
      return await attempt(url, options)
    } catch (error) {
      lastError = error
      if (attemptIndex === retries || !isRetryable(error)) break
      await new Promise((resolve) => setTimeout(resolve, 250 * (attemptIndex + 1)))
    }
  }
  throw lastError
}

/** Fetches and parses JSON, retrying transient failures with a short backoff. */
export async function fetchJson<T>(url: string, options: RequestOptions = {}): Promise<T> {
  const response = await requestText(url, options)
  try {
    return JSON.parse(response.text) as T
  } catch {
    throw new SourceError('INVALID_RESPONSE', `${options.label ?? '音源'}：无法解析返回的 JSON`)
  }
}

/**
 * Tries each URL in order (for APIs published on several independent mirrors) and only fails when
 * every mirror is unreachable.
 */
export async function fetchJsonFromMirrors<T>(urls: string[], options: RequestOptions = {}): Promise<T> {
  let lastError: unknown
  for (const url of urls) {
    try {
      return await fetchJson<T>(url, { retries: 0, ...options })
    } catch (error) {
      lastError = error
    }
  }
  throw lastError ?? new SourceError('NETWORK_ERROR', '所有镜像均不可用')
}
