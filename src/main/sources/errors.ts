import type { SourceErrorCode, SourceErrorInfo } from '../../shared/types'

/**
 * Typed error for the source layer. Every plugin failure is normalised into a
 * `SourceError` (or a `SourceErrorInfo` payload) so the UI never shows
 * "Cannot read properties of undefined" for a flaky public API.
 */
export class SourceError extends Error {
  readonly code: SourceErrorCode

  constructor(code: SourceErrorCode, message: string) {
    super(message)
    this.name = 'SourceError'
    this.code = code
  }
}

export function isSourceError(value: unknown): value is SourceError {
  return value instanceof SourceError
}

function isAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const name = (error as { name?: unknown }).name
  return name === 'AbortError' || name === 'TimeoutError'
}

/** Maps an HTTP status onto Aurora's error vocabulary. */
export function classifyStatus(status: number): SourceErrorCode {
  if (status === 401 || status === 403) return 'UNAUTHORIZED'
  if (status === 404) return 'NOT_FOUND'
  if (status === 429) return 'RATE_LIMITED'
  if (status >= 500) return 'NETWORK_ERROR'
  if (status >= 400) return 'INVALID_RESPONSE'
  return 'UNKNOWN'
}

export function statusMessage(code: SourceErrorCode, label: string): string {
  switch (code) {
    case 'UNAUTHORIZED':
      return `${label}：鉴权失败，请检查配置中的 API Key / Client ID`
    case 'NOT_FOUND':
      return `${label}：请求的内容不存在`
    case 'RATE_LIMITED':
      return `${label}：请求过于频繁，请稍后再试`
    case 'NETWORK_ERROR':
      return `${label}：无法连接服务，请检查网络`
    default:
      return `${label}：服务返回了无法识别的响应`
  }
}

/**
 * Prefixes a message with the source's name — **once**.
 *
 * Error messages in this codebase are built by wrapping: the authorization layer leads with the source
 * name, the sandbox host adds it to whatever came back, the platform resolver adds it to every failure
 * it collects. Each of those is right on its own and wrong together: the refusal a user sees under safe
 * mode read "E2E 解析音源：E2E 解析音源：安全模式已开启…". Doubled text does not throw, it just makes the
 * one sentence that says which switch to flip look broken, so people stop reading it.
 *
 * Wrapping is otherwise deliberate and worth keeping — every layer's message has to stand on its own,
 * because each of them is also logged or surfaced where the others never ran. So the rule is "add the
 * name unless it is already there", in one place, instead of each layer knowing what the others did.
 */
export function namePrefixed(name: string, message: string): string {
  const label = typeof name === 'string' ? name.trim() : ''
  if (!label) return message
  const prefix = `${label}：`
  return message.startsWith(prefix) ? message : `${prefix}${message}`
}

/** Converts anything thrown by a plugin into a renderer-safe payload. */
export function toSourceErrorInfo(error: unknown, fallbackLabel = '音源'): SourceErrorInfo {
  if (isSourceError(error)) return { code: error.code, message: error.message }
  if (isAbortError(error)) return { code: 'TIMEOUT', message: `${fallbackLabel}：请求超时` }
  if (error instanceof TypeError) return { code: 'NETWORK_ERROR', message: `${fallbackLabel}：网络请求失败` }
  if (error instanceof Error && error.message) return { code: 'UNKNOWN', message: error.message }
  return { code: 'UNKNOWN', message: `${fallbackLabel}：未知错误` }
}
