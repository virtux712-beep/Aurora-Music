import { safeStorage } from 'electron'

/**
 * Secret storage for source credentials (API keys, tokens, user-supplied secrets, ...).
 *
 * Renderer `localStorage` is off limits for secrets, and settings.json is plain text, so secret
 * values are encrypted with Electron's `safeStorage` (OS keychain / DPAPI) before they are written
 * to disk. When the platform has no keychain available the value is still persisted, but marked
 * as `plain:` so the settings UI can warn honestly instead of pretending it is encrypted.
 */
const ENCRYPTED_PREFIX = 'enc:'
const PLAIN_PREFIX = 'plain:'

export function secretsAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

export function encryptSecret(value: string): string {
  const encoded = Buffer.from(value, 'utf8').toString('base64')
  if (!secretsAvailable()) return `${PLAIN_PREFIX}${encoded}`
  try {
    return `${ENCRYPTED_PREFIX}${safeStorage.encryptString(value).toString('base64')}`
  } catch {
    return `${PLAIN_PREFIX}${encoded}`
  }
}

export function decryptSecret(stored: unknown): string {
  if (typeof stored !== 'string') return ''
  if (stored.startsWith(PLAIN_PREFIX)) {
    return Buffer.from(stored.slice(PLAIN_PREFIX.length), 'base64').toString('utf8')
  }
  if (stored.startsWith(ENCRYPTED_PREFIX)) {
    if (!secretsAvailable()) return ''
    try {
      return safeStorage.decryptString(Buffer.from(stored.slice(ENCRYPTED_PREFIX.length), 'base64'))
    } catch {
      // Key rotated, different OS user or corrupted entry: treat as "not configured".
      return ''
    }
  }
  return ''
}

export function isSecretStored(stored: unknown): boolean {
  return typeof stored === 'string' && (stored.startsWith(PLAIN_PREFIX) || stored.startsWith(ENCRYPTED_PREFIX))
}
