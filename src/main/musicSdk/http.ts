import { requestText, type HttpMethod } from '../sources/http'

/**
 * The `httpFetch` the ported platform search code expects.
 *
 * LX's version returns `{ promise, cancelHttp }` where `promise` resolves a needle response whose
 * `body` is already parsed when the payload was JSON. Keeping that shape (rather than "just use
 * fetch") is what lets the per-platform code stay a straight port: every function there destructures
 * `{ body }` or `statusCode` out of the result.
 *
 * Requests go through Aurora's shared HTTP layer, so they inherit the same timeout, redirect and
 * request-log behaviour as everything else. They are *not* subject to a source's host allowlist —
 * this is Aurora's own built-in search talking to fixed, well-known endpoints, not a user source
 * asking for a host.
 */
export interface HttpResult {
  statusCode: number
  statusMessage: string
  headers: Record<string, string>
  bytes: number
  /** The raw text body. LX sources occasionally call `.toString()` on it; a string answers that. */
  raw: string
  /** Parsed JSON when the payload was JSON, otherwise the raw text. */
  body: unknown
  url: string
}

export interface HttpHandle {
  promise: Promise<HttpResult>
  cancelHttp: () => void
}

export interface HttpFetchOptions {
  method?: HttpMethod | Lowercase<HttpMethod>
  headers?: Record<string, string>
  /** Serialised as JSON when it is an object and no `form` is given — matching needle's default. */
  body?: unknown
  form?: Record<string, string>
  timeout?: number
}

const DEFAULT_TIMEOUT_MS = 15_000
const MAX_BODY_BYTES = 4 * 1024 * 1024

export function httpFetch(url: string, options: HttpFetchOptions = {}): HttpHandle {
  const method = String(options.method ?? 'get').toUpperCase() as HttpMethod
  const headers: Record<string, string> = { ...(options.headers ?? {}) }
  let body: string | undefined

  if (options.form) {
    body = new URLSearchParams(options.form).toString()
    headers['Content-Type'] = headers['Content-Type'] ?? 'application/x-www-form-urlencoded'
  } else if (options.body !== undefined) {
    if (typeof options.body === 'string') body = options.body
    else {
      body = JSON.stringify(options.body)
      headers['Content-Type'] = headers['Content-Type'] ?? 'application/json'
    }
  }

  if (!Object.keys(headers).some((name) => name.toLowerCase() === 'user-agent')) {
    headers['User-Agent'] =
      'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/69.0.3497.100 Safari/537.36'
  }

  const promise = requestText(url, {
    method,
    headers,
    ...(body !== undefined ? { body } : {}),
    timeoutMs: options.timeout && options.timeout > 0 ? Math.min(options.timeout, 60_000) : DEFAULT_TIMEOUT_MS,
    // The platform code has its own retry loops (they retry on a *bad payload*, which the HTTP layer
    // cannot see), so retrying here would only multiply requests.
    retries: 0,
    redirect: 'follow',
    maxBytes: MAX_BODY_BYTES,
    label: 'musicSdk',
    sourceId: 'musicSdk',
  })
    .then((response): HttpResult => {
      let parsed: unknown = response.text
      try {
        parsed = JSON.parse(response.text)
      } catch {
        parsed = response.text
      }
      return {
        statusCode: response.status,
        statusMessage: '',
        headers: response.headers,
        bytes: Buffer.byteLength(response.text, 'utf8'),
        raw: response.text,
        body: parsed,
        url: response.url,
      }
    })

  return {
    promise,
    // The ported code stores the handle and calls `cancelHttp()` before a new request, purely to
    // avoid overlapping calls. Aurora's HTTP layer already bounds every request with its own timeout,
    // so dropping the in-flight one is not worth a second abort path; the argument is accepted and
    // ignored so the ported call sites stay readable.
    cancelHttp: () => undefined,
  }
}

/** Convenience for the call sites that only need the parsed body. */
export async function httpJson<T = unknown>(url: string, options: HttpFetchOptions = {}): Promise<T> {
  const result = await httpFetch(url, options).promise
  return result.body as T
}
