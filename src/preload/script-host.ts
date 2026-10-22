import { contextBridge, ipcRenderer } from 'electron'

/**
 * The sandbox host window's preload — the only way out of a script source.
 *
 * The window is `sandbox: true` + `contextIsolation: true` and its session cancels **every**
 * outbound request, so a script has no way to reach the network on its own. This preload forwards
 * the two things a script is allowed to ask for (`http`, `crypto`) to the main process, which
 * enforces the source's confirmed permissions and host allowlist, and returns the answer.
 *
 * Note what is *not* here: the script cannot name the source it is running as. The main process
 * derives `sourceId` from `event.sender.id`, so one source cannot borrow another's permissions.
 *
 * There are **two** bridges, and the difference matters:
 *
 *  - the async `postMessage` bridge below (network, and anything that may block), and
 *  - a synchronous one, because every published LX source computes request signatures with
 *    synchronous helpers (`lx.utils.crypto.md5(...)`, `aesEncrypt(...)`, `buffer.from(...)`
 *    interpolated straight into a URL). A Promise-returning hash would silently break them, so the
 *    main world may call the sync bridge directly; the main process still does the work.
 */
interface BridgeEnvelope {
  __auroraBridge?: boolean
  kind?: string
  id?: number
  [key: string]: unknown
}

/**
 * The host world, typed locally: this file is compiled in the Node tsconfig (no DOM lib), and the
 * only DOM surface it touches is `postMessage` plus one `message` listener.
 */
interface HostWindow {
  postMessage: (message: unknown, targetOrigin: string) => void
  addEventListener: (type: 'message', listener: (event: { data: unknown }) => void) => void
}
const hostWindow = globalThis as unknown as HostWindow

function reply(id: number, ok: boolean, payload: unknown, code?: string): void {
  if (ok) hostWindow.postMessage({ __auroraBridgeReply: true, id, ok: true, value: payload }, '*')
  else {
    hostWindow.postMessage(
      { __auroraBridgeReply: true, id, ok: false, error: String(payload ?? '请求失败'), errorCode: code ?? '' },
      '*',
    )
  }
}

function withoutEnvelope(data: BridgeEnvelope): Record<string, unknown> {
  const { __auroraBridge: _flag, kind: _kind, id: _id, ...rest } = data
  return rest
}

async function handle(raw: unknown): Promise<void> {
  if (!raw || typeof raw !== 'object') return
  const data = raw as BridgeEnvelope
  if (data.__auroraBridge !== true) return
  const id = Number(data.id)
  if (!Number.isFinite(id)) return

  if (data.kind === 'log') {
    // Log lines are fire-and-forget; they must never slow a script down.
    ipcRenderer.send('script-host:log', {
      level: typeof data.level === 'string' ? data.level.slice(0, 16) : 'log',
      message: typeof data.message === 'string' ? data.message.slice(0, 500) : '',
    })
    return
  }

  if (data.kind !== 'http' && data.kind !== 'crypto') return

  try {
    const value = await ipcRenderer.invoke(`script-host:${data.kind}`, withoutEnvelope(data))
    // The main process reports *expected* failures (ungranted host, missing permission, HTTP error,
    // timeout) as a value with a machine-readable code, so the script gets a readable message and
    // the runtime keeps the right error code instead of flattening everything into one.
    if (value && typeof value === 'object' && typeof (value as { __bridgeError?: unknown }).__bridgeError === 'string') {
      const failure = value as { __bridgeError: string; __bridgeCode?: string }
      reply(id, false, failure.__bridgeError, failure.__bridgeCode)
      return
    }
    reply(id, true, value)
  } catch (error) {
    reply(id, false, error instanceof Error ? error.message : '桥接请求失败')
  }
}

hostWindow.addEventListener('message', (event) => {
  void handle(event.data)
})

/**
 * Synchronous bridge for the pure-computation helpers a script needs mid-expression.
 *
 * `sendSync` is the only synchronous call available from a sandboxed preload, and it is the right
 * shape here: the caller is a single expression (a signing step), never a long-running job. Results
 * are `{ ok, value }` / `{ ok: false, error }` so the caller can throw a readable error.
 */
contextBridge.exposeInMainWorld('__auroraSync', {
  call: (payload: unknown) =>
    ipcRenderer.sendSync('script-host:sync', payload) as { ok: boolean; value?: unknown; error?: string },
})
