import { BrowserWindow, ipcMain, session as electronSession, type Session } from 'electron'
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  publicEncrypt,
  randomBytes as nodeRandomBytes,
  constants as cryptoConstants,
} from 'node:crypto'
import { deflateSync, inflateSync } from 'node:zlib'
import { FORBIDDEN_HEADERS } from '../../shared/customSource'
import type {
  PlaybackQuality,
  SourceConfigValue,
  SourceErrorCode,
  SourcePermission,
} from '../../shared/types'
import type { ScriptDeclaration, ScriptRuntimeKind } from '../../shared/scriptSource'
import { SourceError, toSourceErrorInfo } from '../sources/errors'
import { requestText } from '../sources/http'
import { logSourceError } from '../sources/log'
import { allowAndRecordHost, authorizeRequest, clearPendingHosts } from '../sources/permissions'
import { namePrefixed } from '../sources/errors'
import { SCRIPT_HOST_BOOTSTRAP } from './bootstrap'
import { SCRIPT_HOST_CRYPTO } from './cryptoLite'

/**
 * The sandbox host: one hidden, fully offline renderer per running script source.
 *
 * Design notes that matter for security:
 *
 *  - `sandbox: true` + `contextIsolation: true` means the document has no `require`, no `process`
 *    and no Electron (verified in the smoke suite), so a script cannot reach Node.
 *  - The window gets its own session whose `webRequest` handler **cancels every request**, so even
 *    `fetch()` cannot leave the machine. All egress goes through the preload bridge, which forwards
 *    to the handlers below — where the source's confirmed permissions and host allowlist are enforced.
 *  - A script that hangs cannot freeze Aurora: every call is raced against a timeout and loses the
 *    window when it fires. A crashed window is marked and rebuilt on the next call.
 *
 * Hosts are created lazily, capped, and destroyed after a period of inactivity, because each one
 * costs a renderer process.
 */
const DEFAULT_CALL_TIMEOUT_MS = 10_000
const INSTALL_TIMEOUT_MS = 8_000
const MAX_HOSTS = 4
const IDLE_DESTROY_MS = 10 * 60_000
const SWEEP_INTERVAL_MS = 60_000
const MAX_BRIDGE_BYTES = 2 * 1024 * 1024
const MAX_HOST_LOG_LINES = 80

/**
 * True while the only thing missing is a 洛雪 announcement — the one error that a short wait can fix.
 *
 * Matching on the message is deliberate: a source that announced itself but is *also* broken (no
 * request handler, a load error) must not be retried eight times to no effect.
 */
function waitsForLxInited(declaration: ScriptDeclaration): boolean {
  if ((declaration.errors ?? []).some((message) => message.includes('EVENT_NAMES.inited'))) return true
  // A script that has already used the lx API or opened a request of its own has proved it is a source
  // that is still starting up — that is what `lxPending` / `bridgeUsed` record. Treating those as
  // "declared nothing" is what rejected published sources after two seconds.
  return declaration.lxPending === true || declaration.bridgeUsed === true
}

/**
 * How long a *self-announcing* source is given to announce itself.
 *
 * Published 洛雪 sources commonly fetch a platform config before `lx.send(inited, …)`, and that fetch
 * goes through the bridge, so a few seconds is normal and a slow endpoint can take longer. The wait
 * only applies when there is evidence to wait *for* (see `waitsForLxInited`); a file that loaded no
 * source at all still fails immediately.
 */
const LX_INITED_GRACE_MS = 12_000
/**
 * The one extra window a source can earn, and the rule for earning it.
 *
 * An aggregator source is not unusual: it fetches a list of its own mirrors, tests them, and only then
 * announces its platforms — which routinely outlives even a generous base window. Waiting for such a
 * source is worth it; waiting 30 seconds for a file that silently does nothing is not. So the
 * extension is granted exactly once, and only to a script that has **already issued a request of its
 * own**: evidence that it is still working, rather than a fixed delay everyone pays.
 */
const LX_INITED_EXTENSION_MS = 18_000
const LX_INITED_POLL_MS = 400
const LX_INITED_POLL_EVAL_MS = 4_000
const HOST_DOCUMENT =
  'data:text/html,<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-eval\' \'unsafe-inline\'"><title>Aurora Source</title>'

export interface ScriptHostSettings {
  runtime: ScriptRuntimeKind
  permissions: SourcePermission[]
  allowedHosts: string[]
  qualities: PlaybackQuality[]
  config: Record<string, SourceConfigValue>
  /**
   * **Import mode.** A source is allowed to reach any host while it is being inspected, and every
   * host it touches is recorded as a pending grant for the user to review.
   *
   * This is not a loophole — it is what makes import possible at all. A large share of published LX
   * sources fetch a config or a version manifest *before* they announce their platforms via
   * `inited`; refusing that request would mean "this source cannot even describe itself", which is
   * exactly the admission gate this runtime is not supposed to have. The requests happen in the
   * sandbox, with the result only used to read a declaration, and the resulting host list is what
   * the confirmation dialog shows.
   */
  probe?: boolean
  /** Author/version metadata surfaced to the script through `lx.currentScriptInfo`. */
  info?: { name?: string; version?: string; author?: string; homepage?: string }
}

interface BridgeHttpPayload {
  url?: string
  method?: string
  headers?: Record<string, string>
  body?: unknown
  form?: Record<string, string>
  timeoutMs?: number
}

interface BridgeCryptoPayload {
  op?: string
  value?: string
  key?: string
  iv?: string
  mode?: string
  size?: number
}

interface BridgeSyncPayload extends BridgeCryptoPayload {
  /** 'hex' | 'base64' — how a crypto result should be rendered back to the script. */
  encoding?: string
}

interface BridgeSyncResult {
  ok: boolean
  value?: unknown
  error?: string
}

let preloadFilePath = ''
let callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS
let installTimeoutMs = INSTALL_TIMEOUT_MS
let sweepTimer: NodeJS.Timeout | null = null
const hosts = new Map<string, ScriptHost>()
const hostByWebContents = new Map<number, ScriptHost>()
let bridgeRegistered = false

/**
 * Where the sandbox preload lives, plus the timeouts a stuck script is measured against.
 *
 * The app passes only the path; the timeouts are configurable so the smoke suite can prove the
 * timeout path (and the rebuild that follows it) in seconds instead of minutes.
 */
export function initScriptHost(options: { preloadPath: string; callTimeoutMs?: number; installTimeoutMs?: number }): void {
  preloadFilePath = options.preloadPath
  if (options.callTimeoutMs && options.callTimeoutMs > 0) callTimeoutMs = options.callTimeoutMs
  if (options.installTimeoutMs && options.installTimeoutMs > 0) installTimeoutMs = options.installTimeoutMs
  if (!sweepTimer) {
    sweepTimer = setInterval(() => {
      const now = Date.now()
      for (const host of hosts.values()) {
        if (now - host.lastUsedAt > IDLE_DESTROY_MS) host.dispose('idle')
      }
    }, SWEEP_INTERVAL_MS)
    sweepTimer.unref?.()
  }
}

/**
 * Renders a value as a JS expression to inline into `executeJavaScript`.
 *
 * `JSON.stringify` is exactly the right encoder here: it produces valid JS literal syntax for
 * objects/arrays/strings/numbers (`null`, `true`, quotes and newlines all escaped), so the payload is
 * delivered as a real object and cannot terminate the expression early.
 */
function jsonLiteral(value: unknown): string {
  return JSON.stringify(value)
}

/** Wraps user code so a load-time throw becomes a readable error instead of a rejected promise. */
function wrapScriptText(sourceText: string): string {
  return [
    '(async () => {',
    '  try {',
    sourceText,
    '  } catch (error) {',
    '    const list = (globalThis.__auroraScriptLoadErrors = globalThis.__auroraScriptLoadErrors || [])',
    '    list.push(String((error && error.stack) || error))',
    '  }',
    '})()',
  ].join('\n')
}

function sanitizeHeaders(input: unknown): Record<string, string> | undefined {
  if (!input || typeof input !== 'object') return undefined
  const out: Record<string, string> = {}
  let count = 0
  for (const [rawName, rawValue] of Object.entries(input as Record<string, unknown>)) {
    if (count >= 24) break
    const name = String(rawName).trim()
    if (!name || (FORBIDDEN_HEADERS as readonly string[]).includes(name.toLowerCase())) continue
    if (rawValue === undefined || rawValue === null) continue
    out[name] = String(rawValue).slice(0, 2000)
    count += 1
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function clampTimeout(value: unknown, fallback: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(Math.max(Math.round(parsed), 1_000), 20_000)
}

function aesPlan(mode: string, keyLength: number): { algorithm: string; iv: boolean } {
  const bits = keyLength === 16 ? 128 : keyLength === 24 ? 192 : keyLength === 32 ? 256 : 0
  if (!bits) throw new Error(`不支持的 AES 密钥长度：${keyLength} 字节（只支持 16 / 24 / 32 字节）`)
  const cbc = mode.includes('cbc')
  return { algorithm: `aes-${bits}-${cbc ? 'cbc' : 'ecb'}`, iv: cbc }
}

class ScriptHost {
  readonly sourceId: string
  readonly sourceName: string
  lastUsedAt = Date.now()
  private window: BrowserWindow | null = null
  private ses: Session | null = null
  private settings: ScriptHostSettings = {
    runtime: 'aurora',
    permissions: [],
    allowedHosts: [],
    qualities: [],
    config: {},
  }
  private installPromise: Promise<void> | null = null
  private installed = false
  private gone = false
  private logs: string[] = []
  /**
   * Hosts this *probe run* was allowed to reach, so the HTTP layer can honour the same decision.
   *
   * A probe deliberately has no granted hosts: it runs the source once to see what it declares, and
   * every host it touches is recorded as pending for the user to approve afterwards. But the
   * permission decision and the HTTP call are two layers, and the empty allowlist was passed to both
   * — so the request the source was *authorised* to make was refused one layer down. The result was a
   * source that could never describe itself while importing, i.e. exactly the aggregators that fetch
   * their own config before announcing their platforms (see the grace window in `describe`).
   */
  private probeGrantedHosts = new Set<string>()

  constructor(sourceId: string, sourceName: string) {
    this.sourceId = sourceId
    this.sourceName = sourceName
  }

  private async createWindow(): Promise<BrowserWindow> {
    if (this.window && !this.window.isDestroyed() && !this.gone) return this.window

    if (!preloadFilePath) throw new SourceError('UNKNOWN', '脚本宿主未初始化（缺少 preload 路径）')

    // Each source gets an isolated session so its storage and its request policy cannot mix with
    // another source's — and so that cancelling requests here cannot affect the app window.
    const ses = electronSession.fromPartition(`aurora-script-${this.sourceId}`, { cache: false })
    // Everything that could reach the network is refused at the Chromium layer, so a script cannot
    // bypass the bridge with fetch/XHR/WebSocket. Local schemes (the host document itself is a
    // `data:` URL) must still load, or the host could not even start.
    ses.webRequest.onBeforeRequest((details, callback) =>
      callback({ cancel: /^(https?|wss?|ftp):/i.test(details.url ?? '') }),
    )
    ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    ses.setPermissionCheckHandler(() => false)
    this.ses = ses

    const window = new BrowserWindow({
      show: false,
      width: 420,
      height: 320,
      skipTaskbar: true,
      webPreferences: {
        preload: preloadFilePath,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
        backgroundThrottling: false,
        session: ses,
      },
    })

    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event) => event.preventDefault())
    window.webContents.on('will-attach-webview', (event) => event.preventDefault())
    window.webContents.on('render-process-gone', () => {
      // Crash isolation: the host dies, Aurora does not. The next call rebuilds it.
      this.gone = true
      this.installed = false
      this.installPromise = null
      hostByWebContents.delete(window.webContents.id)
      logSourceError(this.sourceId, 'UNKNOWN', `${this.sourceName}：脚本宿主进程已崩溃，将在下次调用时重建`, 'script-host')
      if (!window.isDestroyed()) window.destroy()
      if (this.window === window) this.window = null
    })

    this.window = window
    hostByWebContents.set(window.webContents.id, this)
    await window.loadURL(HOST_DOCUMENT)
    await window.webContents.executeJavaScript(SCRIPT_HOST_CRYPTO, true)
    await window.webContents.executeJavaScript(SCRIPT_HOST_BOOTSTRAP, true)
    return window
  }

  /** Evaluates one expression in the host and rejects with a timeout, killing the window. */
  private async race<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        // A script stuck in an infinite loop keeps its renderer busy forever, so the only way back
        // is to throw the window away. The next call transparently rebuilds it.
        this.dispose('timeout')
        reject(new SourceError('TIMEOUT', `${this.sourceName}：${operation}超时（${timeoutMs}ms），已强制终止脚本宿主`))
      }, timeoutMs)
    })
    try {
      return await Promise.race([promise, deadline])
    } finally {
      clearTimeout(timer)
    }
  }

  private async evaluate<T>(code: string, timeoutMs: number, operation: string): Promise<T> {
    const window = await this.createWindow()
    try {
      return await this.race(window.webContents.executeJavaScript(code, true) as Promise<T>, timeoutMs, operation)
    } catch (error) {
      if (error instanceof SourceError) throw error
      const message = error instanceof Error ? error.message : String(error)
      throw new SourceError('INVALID_RESPONSE', `${this.sourceName}：脚本执行出错 — ${message.slice(0, 300)}`)
    }
  }

  /** Loads the script once per host lifetime (and again after a crash or a reload). */
  async install(sourceText: string, settings: ScriptHostSettings, options: { timeoutMs?: number } = {}): Promise<void> {
    if (this.installed) return
    if (this.installPromise) return this.installPromise
    this.settings = settings
    const timeoutMs = options.timeoutMs ?? installTimeoutMs
    this.installPromise = (async () => {
      const window = await this.createWindow()
      await this.evaluate<void>(
        `globalThis.__auroraRuntime.setup(${jsonLiteral({
          runtime: settings.runtime,
          sourceId: this.sourceId,
          config: settings.config,
          permissions: settings.permissions,
          qualities: settings.qualities,
          scriptInfo: {
            name: settings.info?.name ?? this.sourceName,
            version: settings.info?.version ?? '',
            author: settings.info?.author ?? '',
            homepage: settings.info?.homepage ?? '',
            rawScript: sourceText,
          },
        })})`,
        timeoutMs,
        '初始化',
      )
      this.logs = []
      await this.evaluate(wrapScriptText(sourceText), timeoutMs, '加载脚本')
      void window
      this.installed = true
    })()
    try {
      await this.installPromise
    } catch (error) {
      this.installPromise = null
      throw error
    }
    this.installPromise = null
  }

  /**
   * Runs one operation in the sandbox and turns the tagged envelope into a typed result.
   *
   * The envelope (rather than a rejected promise) is what keeps error *codes* alive across
   * `executeJavaScript`, which only preserves an error's message.
   */
  async invoke<T>(request: Record<string, unknown>, timeout?: number): Promise<T> {
    const timeoutMs = timeout ?? callTimeoutMs
    this.lastUsedAt = Date.now()
    const result = await this.evaluate<{ ok?: boolean; value?: unknown; code?: string; message?: string }>(
      `globalThis.__auroraRuntime.invoke(${jsonLiteral(request)})`,
      timeoutMs,
      `调用 ${String(request.op ?? '操作')}`,
    )
    if (!result || result.ok !== true) {
      const code = (result?.code ?? 'INVALID_RESPONSE') as SourceErrorCode
      /*
       * Named here because most sandbox errors are bare ("缺少请求地址") — but some already carry the
       * name, since the authorization layer leads with the same `${name}：` prefix before its refusal
       * travels out through the sandbox. `namePrefixed` is what keeps the two from stacking; see it for
       * why the doubling mattered (the safe-mode sentence is the one that names the switch to flip).
       */
      const detail = result?.message ?? '脚本执行失败'
      throw new SourceError(code, namePrefixed(this.sourceName, detail))
    }
    return result.value as T
  }

  /** Whether the script is loaded into the current window (false after a crash or a disposal). */
  get isLoaded(): boolean {
    return this.installed
  }

  async describe(): Promise<ScriptDeclaration> {
    this.lastUsedAt = Date.now()
    let declaration = await this.readDeclaration()

    /*
     * Re-read while the only complaint is a missing 洛雪 announcement.
     *
     * Many published sources fetch their platform config first and only then call
     * `lx.send(lx.EVENT_NAMES.inited, …)` from a promise callback — i.e. after the script body has
     * already returned. Describing once would report "this source declared nothing" for a source that
     * works perfectly in 洛雪音乐. The retry lives here rather than inside the page so that every
     * individual evaluate stays inside the install timeout; the script keeps running between polls and
     * its pending bridge request can finish.
     */
    let deadline = Date.now() + LX_INITED_GRACE_MS
    let extended = false
    while (waitsForLxInited(declaration)) {
      const now = Date.now()
      if (now >= deadline) {
        // One extension, and only on evidence (see LX_INITED_EXTENSION_MS).
        if (extended || declaration.bridgeUsed !== true) break
        extended = true
        deadline = now + LX_INITED_EXTENSION_MS
        continue
      }
      await new Promise((resolve) => setTimeout(resolve, LX_INITED_POLL_MS))
      declaration = await this.readDeclaration()
    }

    for (const line of declaration.logs ?? []) {
      if (this.logs.length >= MAX_HOST_LOG_LINES) break
      this.logs.push(line)
    }
    return declaration
  }

  private readDeclaration(): Promise<ScriptDeclaration> {
    // Each individual read stays well inside the install budget even while the grace window is open.
    const timeoutMs = Math.max(installTimeoutMs, LX_INITED_POLL_EVAL_MS)
    return this.evaluate<ScriptDeclaration>('globalThis.__auroraRuntime.describe()', timeoutMs, '读取脚本声明')
  }

  readLog(): string[] {
    return [...this.logs]
  }

  /**
   * Enforced on every bridge request, against the *granted* hosts and permissions — never against
   * anything the script claims about itself. A refusal is reported as a pending grant (see
   * `sources/permissions.ts`), because "this host is not allowed yet" is something the user can fix
   * without reinstalling anything.
   */
  private assertNetworkAllowed(url: string): URL {
    if (this.settings.probe) {
      const parsed = allowAndRecordHost(this.sourceId, url)
      this.probeGrantedHosts.add(parsed.host.toLowerCase())
      return parsed
    }
    return authorizeRequest({
      sourceId: this.sourceId,
      sourceName: this.sourceName,
      url,
      permissions: this.settings.permissions,
      grantedHosts: this.settings.allowedHosts,
    })
  }

  /** Hosts just granted through the source manager no longer need to be offered again. */
  acknowledgeGrants(allowedHosts: string[]): void {
    this.settings = { ...this.settings, allowedHosts }
    clearPendingHosts(this.sourceId)
  }

  async handleHttp(payload: BridgeHttpPayload): Promise<Record<string, unknown>> {
    this.lastUsedAt = Date.now()
    try {
      const url = typeof payload.url === 'string' ? payload.url : ''
      if (!url) throw new Error(`${this.sourceName}：缺少请求地址`)
      this.assertNetworkAllowed(url)

      const method = String(payload.method ?? 'GET').toUpperCase()
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(method)) {
        throw new Error(`${this.sourceName}：不支持的请求方法 ${method}`)
      }

      const response = await requestText(url, {
        method: method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD',
        headers: sanitizeHeaders(payload.headers),
        body: typeof payload.body === 'string' ? payload.body.slice(0, 256 * 1024) : undefined,
        form: payload.form && typeof payload.form === 'object' ? payload.form : undefined,
        timeoutMs: clampTimeout(payload.timeoutMs, 12_000),
        retries: 0,
        // A script may only reach hosts the user approved, so a redirect must never silently
        // move the request somewhere else.
        redirect: 'error',
        maxBytes: MAX_BRIDGE_BYTES,
        hostAllowlist: [...this.settings.allowedHosts, ...this.probeGrantedHosts],
        sourceId: this.sourceId,
        label: this.sourceName,
        logHeaders: true,
      })

      return {
        statusCode: response.status,
        status: response.status,
        ok: response.ok,
        headers: response.headers,
        body: response.text,
        raw: response.text,
        url: response.url,
      }
    } catch (error) {
      const info = toSourceErrorInfo(error, this.sourceName)
      return { __bridgeError: info.message, __bridgeCode: info.code }
    }
  }

  async handleCrypto(payload: BridgeCryptoPayload): Promise<Record<string, unknown>> {
    this.lastUsedAt = Date.now()
    try {
      if (!this.settings.permissions.includes('crypto')) {
        throw new Error(`${this.sourceName}：没有 crypto 权限`)
      }
      const value = String(payload.value ?? '')
      if (value.length > 256 * 1024) throw new Error('crypto 输入过大')
      const op = String(payload.op ?? '')
      switch (op) {
        case 'md5':
          return { value: createHash('md5').update(value, 'utf8').digest('hex') }
        case 'sha1':
          return { value: createHash('sha1').update(value, 'utf8').digest('hex') }
        case 'hmacSha1':
          return { value: createHmac('sha1', String(payload.key ?? '')).update(value, 'utf8').digest('hex') }
        case 'aesEncrypt': {
          const key = Buffer.from(String(payload.key ?? ''), 'utf8')
          const plan = aesPlan(String(payload.mode ?? 'ecb'), key.length)
          const cipher = plan.iv
            ? createCipheriv(plan.algorithm, key, Buffer.from(String(payload.iv ?? ''), 'utf8'))
            : createCipheriv(plan.algorithm, key, null)
          return { value: Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]).toString('base64') }
        }
        case 'aesDecrypt': {
          const key = Buffer.from(String(payload.key ?? ''), 'utf8')
          const plan = aesPlan(String(payload.mode ?? 'ecb'), key.length)
          const decipher = plan.iv
            ? createDecipheriv(plan.algorithm, key, Buffer.from(String(payload.iv ?? ''), 'utf8'))
            : createDecipheriv(plan.algorithm, key, null)
          const input = Buffer.from(value, 'base64')
          return { value: Buffer.concat([decipher.update(input), decipher.final()]).toString('utf8') }
        }
        case 'rsaEncrypt':
          return {
            value: publicEncrypt(
              { key: String(payload.key ?? ''), padding: cryptoConstants.RSA_PKCS1_PADDING },
              Buffer.from(value, 'utf8'),
            ).toString('base64'),
          }
        case 'randomBytes': {
          const size = Math.min(Math.max(Number(payload.size) || 8, 1), 64)
          return { value: nodeRandomBytes(size).toString('hex') }
        }
        default:
          throw new Error(`不支持的 crypto 操作：${op}`)
      }
    } catch (error) {
      const info = toSourceErrorInfo(error, this.sourceName)
      return {
        __bridgeError: info.message,
        __bridgeCode: this.settings.permissions.includes('crypto') ? 'INVALID_RESPONSE' : 'PERMISSION',
      }
    }
  }

  /**
   * The **synchronous** bridge: the pure-computation helpers an LX source calls inside one
   * expression while building a request signature.
   *
   * It is deliberately a separate path from `handleCrypto`:
   *
   *  - the operands and results are raw bytes (base64 on the wire) rather than UTF-8 text, because
   *    a signature is computed over bytes, not characters;
   *  - it is allowed regardless of the `crypto` permission. `crypto` gates the *async* request-signing
   *    helpers; hashing and AES in here are pure arithmetic with no egress, so gating them would buy
   *    no safety and would break every source that signs before it can even ask for anything;
   *  - `zlib` is here too, for the same reason: inflate/deflate touch nothing outside the process.
   *
   * Network access is still only reachable through the async bridge, so this path cannot exfiltrate
   * anything on its own.
   */
  handleSync(payload: BridgeSyncPayload): BridgeSyncResult {
    this.lastUsedAt = Date.now()
    try {
      const op = String(payload.op ?? '')
      const bytes = (value: unknown): Buffer => Buffer.from(String(value ?? ''), 'base64')
      const value = bytes(payload.value)
      if (value.length > 1024 * 1024) throw new Error('同步桥接的输入过大')

      switch (op) {
        case 'md5':
          return { ok: true, value: createHash('md5').update(value).digest('hex') }
        case 'sha1':
          return { ok: true, value: createHash('sha1').update(value).digest('hex') }
        case 'aesEncrypt':
        case 'aesDecrypt': {
          const key = bytes(payload.key)
          const plan = aesPlan(String(payload.mode ?? 'ecb'), key.length)
          const ivText = String(payload.iv ?? '')
          const iv = ivText ? bytes(ivText) : null
          if (op === 'aesEncrypt') {
            const cipher = iv ? createCipheriv(plan.algorithm, key, iv) : createCipheriv(plan.algorithm, key, null)
            return { ok: true, value: Buffer.concat([cipher.update(value), cipher.final()]).toString('base64') }
          }
          const decipher = iv ? createDecipheriv(plan.algorithm, key, iv) : createDecipheriv(plan.algorithm, key, null)
          return { ok: true, value: Buffer.concat([decipher.update(value), decipher.final()]).toString('base64') }
        }
        case 'rsaEncrypt': {
          // Faithful to LX: the plaintext is left-padded with zero bytes to the 128-byte modulus and
          // encrypted with RSA_NO_PADDING. PKCS#1 padding here would produce a different ciphertext
          // than the server expects, so the padding choice is part of the protocol, not a detail.
          const modulus = 128
          const padded = Buffer.alloc(modulus - Math.min(value.length, modulus))
          const plain = Buffer.concat([padded, value.subarray(Math.max(0, value.length - modulus))])
          return {
            ok: true,
            value: publicEncrypt(
              { key: String(payload.key ?? ''), padding: cryptoConstants.RSA_NO_PADDING },
              plain,
            ).toString('base64'),
          }
        }
        case 'randomBytes': {
          const size = Math.min(Math.max(Number(payload.size) || 8, 1), 1024)
          return { ok: true, value: nodeRandomBytes(size).toString('base64') }
        }
        case 'inflate':
          return { ok: true, value: inflateSync(value).toString('base64') }
        case 'deflate':
          return { ok: true, value: deflateSync(value).toString('base64') }
        default:
          throw new Error(`不支持的同步操作：${op}`)
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  pushLog(line: string): void {
    if (this.logs.length >= MAX_HOST_LOG_LINES) this.logs.shift()
    this.logs.push(line.slice(0, 500))
  }

  dispose(reason = 'manual'): void {
    this.installed = false
    this.installPromise = null
    this.gone = false
    const window = this.window
    this.window = null
    if (window) {
      hostByWebContents.delete(window.webContents.id)
      if (!window.isDestroyed()) window.destroy()
    }
    void reason
  }
}

function enforceHostCap(): void {
  if (hosts.size < MAX_HOSTS) return
  let oldest: ScriptHost | null = null
  for (const host of hosts.values()) {
    if (!oldest || host.lastUsedAt < oldest.lastUsedAt) oldest = host
  }
  if (oldest) {
    oldest.dispose('cap')
    hosts.delete(oldest.sourceId)
  }
}

/** Returns (creating if needed) the host for a source. Callers must `install` once per load. */
export function acquireScriptHost(sourceId: string, sourceName: string): ScriptHost {
  const existing = hosts.get(sourceId)
  if (existing) return existing
  enforceHostCap()
  const host = new ScriptHost(sourceId, sourceName)
  hosts.set(sourceId, host)
  return host
}

export function getScriptHost(sourceId: string): ScriptHost | undefined {
  return hosts.get(sourceId)
}

export function disposeScriptHost(sourceId: string): void {
  const host = hosts.get(sourceId)
  if (!host) return
  host.dispose('unregister')
  hosts.delete(sourceId)
}

export function disposeAllScriptHosts(): void {
  for (const host of hosts.values()) host.dispose('quit')
  hosts.clear()
  if (sweepTimer) {
    clearInterval(sweepTimer)
    sweepTimer = null
  }
}

/**
 * Runs a script once in a throwaway host with **no** network permission and returns what it declared.
 * This is what the import flow shows the user before anything is persisted.
 */
export async function probeScriptSource(options: {
  sourceId: string
  sourceText: string
  runtime: ScriptRuntimeKind
  info?: { name?: string; version?: string; author?: string; homepage?: string }
}): Promise<ScriptDeclaration> {
  const host = acquireScriptHost(`probe-${options.sourceId}`, options.sourceId)
  try {
    await host.install(options.sourceText, {
      runtime: options.runtime,
      // Any host, recorded as a pending grant: a source must be able to fetch whatever it needs to
      // describe itself. Nothing is written to disk by the probe; the user confirms afterwards.
      probe: true,
      permissions: ['network', 'crypto'],
      allowedHosts: [],
      qualities: [],
      config: {},
      ...(options.info ? { info: options.info } : {}),
    })
    return await host.describe()
  } finally {
    disposeScriptHost(`probe-${options.sourceId}`)
  }
}

/** Registers the preload bridge handlers once per process. */
export function registerScriptBridge(): void {
  if (bridgeRegistered) return
  bridgeRegistered = true

  ipcMain.handle('script-host:http', async (event, payload: unknown) => {
    const host = hostByWebContents.get(event.sender.id)
    if (!host) return { __bridgeError: '未知的脚本宿主' }
    return host.handleHttp((payload ?? {}) as BridgeHttpPayload)
  })

  ipcMain.handle('script-host:crypto', async (event, payload: unknown) => {
    const host = hostByWebContents.get(event.sender.id)
    if (!host) return { __bridgeError: '未知的脚本宿主' }
    return host.handleCrypto((payload ?? {}) as BridgeCryptoPayload)
  })

  // `sendSync` demands a synchronous `returnValue`, so this handler does its work inline. It is
  // intentionally not `ipcMain.handle` (which would need an await and therefore a round trip).
  ipcMain.on('script-host:sync', (event, payload: unknown) => {
    const host = hostByWebContents.get(event.sender.id)
    event.returnValue = host
      ? host.handleSync((payload ?? {}) as BridgeSyncPayload)
      : ({ ok: false, error: '未知的脚本宿主' } satisfies BridgeSyncResult)
  })

  ipcMain.on('script-host:log', (event, payload: unknown) => {
    const host = hostByWebContents.get(event.sender.id)
    if (!host) return
    const line = (payload ?? {}) as { level?: string; message?: string }
    host.pushLog(`${line.level ?? 'log'}: ${String(line.message ?? '')}`)
  })
}
