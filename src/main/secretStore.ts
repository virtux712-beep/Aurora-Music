import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { decryptSecret, encryptSecret, isSecretStored } from './secrets'

/**
 * Source secrets live in their own file, separate from `settings.json`, and each value is encrypted
 * with `safeStorage` before it touches the disk. The renderer only ever learns *whether* a secret
 * exists (`secretKeys`), never its value.
 */
type SecretFile = Record<string, Record<string, string>>

let secretsFile = ''
let data: SecretFile = {}

export async function initSecretStore(userDataDirectory: string): Promise<void> {
  secretsFile = join(userDataDirectory, 'secrets.json')
  try {
    const raw = await readFile(secretsFile, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object') {
      const next: SecretFile = {}
      for (const [sourceId, values] of Object.entries(parsed as SecretFile)) {
        if (!values || typeof values !== 'object') continue
        next[sourceId] = {}
        for (const [key, stored] of Object.entries(values)) {
          if (isSecretStored(stored)) next[sourceId][key] = stored
        }
      }
      data = next
    }
  } catch {
    data = {}
  }
}

/** Decrypted secrets for one source, ready to be merged into a plugin's effective config. */
export function getSecrets(sourceId: string): Record<string, string> {
  const stored = data[sourceId]
  if (!stored) return {}
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(stored)) {
    const plain = decryptSecret(value)
    if (plain) result[key] = plain
  }
  return result
}

/** Every source's secrets, for calls that need to describe or enumerate sources. */
export function allSecrets(): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {}
  for (const sourceId of Object.keys(data)) result[sourceId] = getSecrets(sourceId)
  return result
}

/** Encrypts and persists secrets; an empty value removes the stored secret. */
export async function writeSecrets(sourceId: string, values: Record<string, string>): Promise<void> {
  const next: SecretFile = { ...data }
  const bucket = { ...(next[sourceId] ?? {}) }
  for (const [key, value] of Object.entries(values)) {
    if (value) bucket[key] = encryptSecret(value)
    else delete bucket[key]
  }
  if (Object.keys(bucket).length === 0) delete next[sourceId]
  else next[sourceId] = bucket
  data = next
  try {
    await writeFile(secretsFile, JSON.stringify(data, null, 2), 'utf8')
  } catch {
    // Keeping the in-memory value is still better than losing the user's key for this session.
  }
}
