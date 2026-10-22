/**
 * The code that runs *inside* the sandbox host window (main world of a `sandbox: true` renderer).
 *
 * Three things live here and nothing else:
 *
 *  1. the **Aurora script contract** (`defineAuroraSource({...})` → `globalThis.auroraSource`),
 *  2. the **LX Music compatibility layer**, and
 *  3. the request/signature helpers both of them use.
 *
 * The LX layer is a faithful re-implementation of the object `lx-music-desktop` exposes to a user
 * source (`src/main/modules/userApi/renderer/preload.js`): the same `EVENT_NAMES`, the same
 * `request(url, options, callback)` shape (callback + abort function, not a fetch clone), the same
 * `utils.crypto` / `utils.buffer` / `utils.zlib`, and the same `send` / `on` semantics. Being
 * faithful here is not cosmetic — published sources read `resp.raw`, call
 * `lx.utils.crypto.md5(...)` *synchronously*, and destructure `currentScriptInfo` — so anything
 * shaped differently fails at load with an error the source's author never wrote.
 *
 * What is *not* faithful, on purpose: LX filters a source's declared actions down to the ones LX
 * itself implements (`musicUrl`, plus `lyric`/`pic` for `local`). Aurora keeps every action the
 * source declares, because Aurora implements more of them (search, detail, playlists) and dropping
 * a capability the source really has would hide it from the user.
 *
 * This world has no `require`, no `process` and no Electron (verified: `sandbox: true`), and the
 * window's session blocks every outbound request at the Chromium layer, so the *only* ways out are
 * the `postMessage` bridge (async) and the `__auroraSync` bridge (synchronous, pure computation) to
 * the preload — both forwarded to the main process, where permissions are enforced. Everything a
 * script can do is therefore visible in the `kind` handlers in `main/scriptHost/host.ts`.
 */
export const SCRIPT_HOST_BOOTSTRAP = `
(function () {
  if (globalThis.__auroraRuntime && globalThis.__auroraRuntime.installed) {
    return { installed: true, already: true }
  }

  var LOG_LIMIT = 80
  var logs = []
  // Non-blocking problems: a thrown handler, a console.error, an event the runtime does not
  // implement. They are shown to the user and never used to refuse an install — the only thing that
  // decides whether a source is usable is whether it declared itself (see describe()).
  var warnings = []
  var pending = new Map()
  var nextId = 1
  var runtimeKind = 'aurora'
  var context = { config: {}, sourceId: '', permissions: [], qualities: [] }

  function post(payload) {
    // The only async channel out of this world. The preload owns the other end.
    window.postMessage(Object.assign({ __auroraBridge: true }, payload), '*')
  }

  function record(kind, text) {
    var line = String(text == null ? '' : text).slice(0, 500)
    logs.push(kind + ': ' + line)
    if (logs.length > LOG_LIMIT) logs.shift()
    // Uncaught errors are also kept in their own list, so the source manager can show them without
    // making the user read the whole console log.
    if (kind === 'error' || kind === 'warn') {
      warnings.push(line)
      if (warnings.length > LOG_LIMIT) warnings.shift()
    }
  }

  window.addEventListener('message', function (event) {
    var data = event.data
    if (!data || data.__auroraBridgeReply !== true) return
    var entry = pending.get(data.id)
    if (!entry) return
    pending.delete(data.id)
    if (data.ok) entry.resolve(data.value)
    else {
      var failure = new Error(typeof data.error === 'string' ? data.error : '桥接请求失败')
      // The code travels with the error so the main process can report PERMISSION vs TIMEOUT vs a
      // plain network failure instead of collapsing every refusal into one message.
      if (typeof data.errorCode === 'string') failure.code = data.errorCode
      entry.reject(failure)
    }
  })

  function call(kind, payload, timeoutMs) {
    var id = nextId++
    return new Promise(function (resolve, reject) {
      pending.set(id, { resolve: resolve, reject: reject })
      post(Object.assign({ kind: kind, id: id, timeoutMs: timeoutMs || 0 }, payload))
    })
  }

  /** Runs one synchronous main-process helper (hashing, ciphers, zlib). Pure computation only. */
  function syncCall(op, payload) {
    var bridge = globalThis.__auroraSync
    if (!bridge || typeof bridge.call !== 'function') {
      throw new Error('同步桥接不可用（脚本宿主未就绪）')
    }
    var result = bridge.call(Object.assign({ op: op }, payload || {}))
    if (!result || result.ok !== true) {
      throw new Error(String((result && result.error) || ('同步操作失败：' + op)))
    }
    return result.value
  }

  // --- console capture: what a script logs must be visible in the source manager ---------------
  var nativeConsole = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    info: console.info,
  }
  function wrapConsole(method, kind) {
    console[method] = function () {
      var parts = []
      for (var i = 0; i < arguments.length; i++) {
        var value = arguments[i]
        try {
          parts.push(typeof value === 'string' ? value : JSON.stringify(value))
        } catch (error) {
          parts.push('[unserialisable]')
        }
      }
      record(kind, parts.join(' '))
      post({ kind: 'log', level: kind, message: parts.join(' ') })
      nativeConsole[method].apply(console, arguments)
    }
  }
  wrapConsole('log', 'log')
  wrapConsole('info', 'info')
  wrapConsole('warn', 'warn')
  wrapConsole('error', 'error')

  window.addEventListener('error', function (event) {
    record('error', event && event.message ? event.message : 'unknown error')
  })
  window.addEventListener('unhandledrejection', function (event) {
    var reason = event && event.reason
    // A warning, not a failure. Published sources do background work (update checks, config
    // fetches) and a rejection there says nothing about whether the source can serve music; making
    // it fatal is how a perfectly usable source ends up reported as "failed to connect".
    record('warn', '未处理的 Promise 拒绝：' + (reason && reason.message ? reason.message : String(reason)))
  })

  // --- byte helpers ---------------------------------------------------------------------------
  //
  // LX hands sources real Node Buffers. There is no Buffer in a sandboxed renderer, so a small
  // stand-in carries base64 internally and answers the two things sources actually ask of it:
  // \`.toString(format)\` and \`.length\`. Anything crossing the bridge is base64.
  function bytesToBase64(bytes) {
    var binary = ''
    var chunk = 0x8000
    for (var i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
    }
    return btoa(binary)
  }
  function base64ToBytes(value) {
    var binary = atob(String(value == null ? '' : value).replace(/^data:[^;]+;base64,/, ''))
    var out = new Uint8Array(binary.length)
    for (var i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
    return out
  }
  function base64ToHex(value) {
    var bytes = base64ToBytes(value)
    var out = ''
    for (var i = 0; i < bytes.length; i++) out += ('0' + bytes[i].toString(16)).slice(-2)
    return out
  }
  function hexToBase64(hex) {
    var text = String(hex == null ? '' : hex).replace(/[^0-9a-f]/gi, '')
    if (text.length % 2 === 1) text = '0' + text
    var out = new Uint8Array(text.length / 2)
    for (var i = 0; i < out.length; i++) out[i] = parseInt(text.substr(i * 2, 2), 16)
    return bytesToBase64(out)
  }
  function utf8ToBase64(text) {
    return bytesToBase64(new TextEncoder().encode(String(text == null ? '' : text)))
  }
  function base64ToUtf8(value) {
    return new TextDecoder().decode(base64ToBytes(value))
  }

  function LxBytes(base64) {
    this.__base64 = String(base64 == null ? '' : base64)
  }
  Object.defineProperty(LxBytes.prototype, 'length', {
    get: function () {
      return base64ToBytes(this.__base64).length
    },
  })
  LxBytes.prototype.toString = function (format) {
    var kind = String(format == null ? 'utf8' : format).toLowerCase()
    if (kind === 'base64') return this.__base64
    if (kind === 'hex') return base64ToHex(this.__base64)
    if (kind === 'binary' || kind === 'latin1') return atob(this.__base64)
    return base64ToUtf8(this.__base64)
  }
  LxBytes.prototype.slice = function (start, end) {
    return new LxBytes(bytesToBase64(base64ToBytes(this.__base64).slice(start, end)))
  }
  LxBytes.prototype.equals = function (other) {
    return this.__base64 === lxBuffer.from(other).__base64
  }
  function isBytes(value) {
    return value instanceof LxBytes
  }

  /** Normalises any accepted operand (string / bytes / typed array / number list) to base64. */
  function toBase64(value) {
    if (isBytes(value)) return value.__base64
    if (value instanceof Uint8Array) return bytesToBase64(value)
    if (Array.isArray(value)) return bytesToBase64(Uint8Array.from(value))
    if (typeof value === 'string') return utf8ToBase64(value)
    if (typeof value === 'number' && Number.isFinite(value)) {
      return bytesToBase64(Uint8Array.from([value & 0xff]))
    }
    return ''
  }

  var lxBuffer = {
    from: function (input, encoding) {
      if (isBytes(input)) return input
      var kind = String(encoding == null ? 'utf8' : encoding).toLowerCase()
      if (typeof input === 'string') {
        if (kind === 'base64') return new LxBytes(input.replace(/^data:[^;]+;base64,/, ''))
        if (kind === 'hex') return new LxBytes(hexToBase64(input))
        if (kind === 'binary' || kind === 'latin1') return new LxBytes(btoa(input))
        return new LxBytes(utf8ToBase64(input))
      }
      return new LxBytes(toBase64(input))
    },
    bufToString: function (buffer, format) {
      return lxBuffer.from(buffer).toString(format == null ? 'utf8' : format)
    },
    concat: function (list) {
      var binary = ''
      var items = list || []
      for (var i = 0; i < items.length; i++) binary += atob(lxBuffer.from(items[i]).__base64)
      return new LxBytes(btoa(binary))
    },
    isBuffer: isBytes,
    byteLength: function (value) {
      return isBytes(value) ? base64ToBytes(value.__base64).length : toBase64(value).length
    },
  }

  var lxCrypto = {
    // md5 and sha1 stay synchronous on purpose: signatures interpolate them straight into a URL.
    md5: function (input) {
      var value = isBytes(input) ? base64ToUtf8(input.__base64) : String(input == null ? '' : input)
      var hash = globalThis.__auroraHash
      return hash ? hash.md5(value) : syncCall('md5', { value: utf8ToBase64(value) })
    },
    sha1: function (input) {
      var value = isBytes(input) ? base64ToUtf8(input.__base64) : String(input == null ? '' : input)
      var hash = globalThis.__auroraHash
      return hash ? hash.sha1(value) : syncCall('sha1', { value: utf8ToBase64(value) })
    },
    aesEncrypt: function (buffer, mode, key, iv) {
      return new LxBytes(
        syncCall('aesEncrypt', {
          value: toBase64(buffer),
          mode: String(mode == null ? 'aes-128-ecb' : mode).toLowerCase(),
          key: toBase64(key),
          iv: iv == null ? '' : toBase64(iv),
        }),
      )
    },
    aesDecrypt: function (buffer, mode, key, iv) {
      return new LxBytes(
        syncCall('aesDecrypt', {
          value: toBase64(buffer),
          mode: String(mode == null ? 'aes-128-ecb' : mode).toLowerCase(),
          key: toBase64(key),
          iv: iv == null ? '' : toBase64(iv),
        }),
      )
    },
    rsaEncrypt: function (buffer, key) {
      return new LxBytes(
        syncCall('rsaEncrypt', {
          value: toBase64(buffer),
          key: isBytes(key) ? base64ToUtf8(key.__base64) : String(key == null ? '' : key),
        }),
      )
    },
    randomBytes: function (size) {
      return new LxBytes(syncCall('randomBytes', { size: Number(size) || 8 }))
    },
    hmacSha1: function (text, key) {
      return call('crypto', { op: 'hmacSha1', value: String(text), key: String(key) })
    },
  }

  var lxZlib = {
    inflate: function (buffer) {
      return Promise.resolve().then(function () {
        return new LxBytes(syncCall('inflate', { value: toBase64(buffer) }))
      })
    },
    deflate: function (data) {
      return Promise.resolve().then(function () {
        return new LxBytes(syncCall('deflate', { value: toBase64(data) }))
      })
    },
  }

  // --- Aurora script contract -----------------------------------------------------------------
  var auroraSource = null
  var AURORA_METHODS = [
    'search',
    'getSongDetail',
    'getPlayUrl',
    'getLyric',
    'getCover',
    'getAlbum',
    'getArtist',
    'getPlaylist',
    'getLeaderboard',
    'healthCheck',
  ]

  globalThis.defineAuroraSource = function (source) {
    auroraSource = source
    return source
  }

  /*
   * A CommonJS-shaped bundle needs somewhere to export into.
   *
   * There is no Node here and this is *not* a module system: it is a plain object that lets a
   * "module.exports = { search() … }" source finish loading instead of dying on "module is not
   * defined", and gives autoDetectedSource() somewhere to look. Added after the first contract so
   * defineAuroraSource keeps the priority.
   */
  globalThis.module = { exports: {} }
  globalThis.exports = globalThis.module.exports

  /** Globals that are Aurora's own surface, never a candidate for "the source". */
  var RUNTIME_GLOBALS = {
    auroraSource: 1,
    defineAuroraSource: 1,
    auroraRequest: 1,
    auroraHttp: 1,
    lx: 1,
    module: 1,
    exports: 1,
    __auroraRuntime: 1,
    __auroraSync: 1,
  }

  function isSourceShaped(value) {
    return Boolean(value) && typeof value === 'object' && declaredMethods(value).length > 0
  }

  /**
   * Last-resort discovery of the song-source object, for bundles that export in a shape neither of
   * the two documented contracts describes.
   *
   * It only runs when the script declared nothing through defineAuroraSource / globalThis.
   * auroraSource / the 洛雪 API, so it cannot shadow a source that announced itself properly. The
   * test is the *shape* (at least one of the known methods), never a name — which is what keeps this
   * from being a heuristic that guesses.
   */
  /**    * The shape test, without the ability to take the runtime down.
    *
    * Reading a global can *run code*: globalThis.window, globalThis.top and friends are getters,
   * and a host object is outside the script's control — a getter that throws (or a proxy that throws
   * on an unknown property) would otherwise turn "this script declares nothing" into "the runtime    * crashed while describing the script", which is exactly what describe() used to report.
   */
  function isSourceShapedSafe(value) {
    try {
      return isSourceShaped(value)
    } catch (error) {
      return false
    }
  }

  function readGlobal(key) {
    try {
      return { ok: true, value: globalThis[key] }
    } catch (error) {
      return { ok: false, value: null }
    }
  }

  function autoDetectedSource() {
    var exported = globalThis.module && globalThis.module.exports
    if (exported) {
      if (isSourceShapedSafe(exported)) return exported
      if (exported.default && isSourceShapedSafe(exported.default)) return exported.default
      if (Array.isArray(exported)) {
        for (var a = 0; a < exported.length; a++) if (isSourceShapedSafe(exported[a])) return exported[a]
      }
    }
    var keys = Object.keys(globalThis)
    for (var i = 0; i < keys.length; i++) {
      if (RUNTIME_GLOBALS[keys[i]]) continue
      var read = readGlobal(keys[i])
      // A global whose getter throws is not a source; skipping it is the whole point of the guard.
      if (!read.ok) continue
      if (isSourceShapedSafe(read.value)) return read.value
    }
    return null
  }

  /** Every place a source may legitimately live, in priority order. */
  function resolveAuroraSource() {
    if (auroraSource) return auroraSource
    if (globalThis.auroraSource && typeof globalThis.auroraSource === 'object') return globalThis.auroraSource
    return autoDetectedSource()
  }

  /*
   * Evidence the test suite asserts on: a script has no Node surface at all.
   *
   * module is deliberately reported as moduleIsNode rather than by its typeof, because the CommonJS
   * shim below makes typeof module be "object" on purpose. What matters is that it is an empty object
   * a script can assign into — not Node's module object, which would carry require.
   */
  record(
    'log',
    'sandbox: require=' +
      typeof require +
      ' process=' +
      typeof process +
      ' module=' +
      typeof module +
      ' moduleIsNode=' +
      (typeof module === 'object' && module && typeof module.require === 'function') +
      ' fetch=' +
      typeof fetch,
  )

  /*
   * Other spellings of the same operation, seen in the wider plugin ecosystem.
   *
   * These are aliases, never a second capability: a source that implements 'getMediaSource' *is*
   * reported as implementing 'getPlayUrl', so nothing downstream (capability chips, the adapter, the
   * player) needs to know which spelling the author chose. The MusicFree convention alone would
   * otherwise make an otherwise-complete plugin look like a source with no play action at all.
   */
  var METHOD_ALIASES = {
    getPlayUrl: ['getMediaSource', 'getMusicUrl'],
    getSongDetail: ['getMusicInfo'],
  }

  /** Every name that can satisfy one canonical operation, canonical first. */
  function methodCandidates(name) {
    var list = METHOD_ALIASES[name]
    return list ? [name].concat(list) : [name]
  }

  /** The concrete function to call for an operation, plus the name it was found under. */
  function pickMethod(source, name) {
    var names = methodCandidates(name)
    for (var i = 0; i < names.length; i++) {
      if (typeof source[names[i]] === 'function') return { called: names[i], fn: source[names[i]] }
    }
    return null
  }

  function declaredMethods(source) {
    var found = []
    if (!source || typeof source !== 'object') return found
    for (var i = 0; i < AURORA_METHODS.length; i++) {
      if (pickMethod(source, AURORA_METHODS[i])) found.push(AURORA_METHODS[i])
    }
    return found
  }

  // --- LX Music compatibility layer -----------------------------------------------------------
  var EVENT_NAMES = { request: 'request', inited: 'inited', updateAlert: 'updateAlert' }
  var eventNames = [EVENT_NAMES.request, EVENT_NAMES.inited, EVENT_NAMES.updateAlert]
  var lxEvents = { request: null }
  var lxInited = null
  var lxInitedOnce = false
  var lxUpdateAlert = null
  /**
   * Evidence instead of assumption.
   *
   * A published source is not required to announce itself synchronously: many fetch their own
   * platform config first and only then call lx.send(inited, …). Without these two flags the host
   * could not tell "this is not a source" from "this source is still starting", and it rejected
   * working sources after two seconds with "脚本没有导出音源".
   */
  var lxTouched = false
  var bridgeUsed = false

  /** Reads the lx.send(lx.EVENT_NAMES.inited, ...) payload into the shape the rest of Aurora uses. */
  function normalizeInit(info) {
    var out = {
      name: '',
      description: '',
      version: '',
      author: '',
      homepage: '',
      sources: {},
      openDevTools: false,
    }
    if (!info || typeof info !== 'object') return out
    out.name = String(info.name == null ? '' : info.name)
    out.description = String(info.description == null ? '' : info.description)
    out.version = String(info.version == null ? '' : info.version)
    out.author = String(info.author == null ? '' : info.author)
    out.homepage = String(info.homepage == null ? '' : info.homepage)
    out.openDevTools = info.openDevTools === true
    var sources = info.sources && typeof info.sources === 'object' ? info.sources : {}
    Object.keys(sources).forEach(function (id) {
      var entry = sources[id]
      if (!entry || typeof entry !== 'object') return
      // LX only ever exposes sources with type 'music'; a source declaring something else is
      // declaring a capability Aurora does not host.
      if (entry.type && entry.type !== 'music') return
      var actions = []
      var list = Array.isArray(entry.actions) ? entry.actions : []
      for (var i = 0; i < list.length; i++) {
        if (typeof list[i] === 'string' && actions.indexOf(list[i]) < 0) actions.push(list[i])
      }
      var qualityList = Array.isArray(entry.qualitys)
        ? entry.qualitys
        : Array.isArray(entry.qualities)
          ? entry.qualities
          : []
      var qualities = []
      for (var q = 0; q < qualityList.length; q++) {
        if (typeof qualityList[q] === 'string' && qualities.indexOf(qualityList[q]) < 0) {
          qualities.push(qualityList[q])
        }
      }
      // 'qualitys' is the LX spelling and 'qualities' Aurora's; keep both so neither reader breaks.
      out.sources[String(id)] = {
        type: 'music',
        actions: actions,
        qualitys: qualities,
        qualities: qualities,
        name: String(entry.name == null ? id : entry.name),
      }
    })
    return out
  }

  function declaredActions() {
    var found = []
    if (!lxInited) return found
    Object.keys(lxInited.sources).forEach(function (id) {
      var actions = lxInited.sources[id].actions || []
      for (var i = 0; i < actions.length; i++) {
        if (found.indexOf(actions[i]) < 0) found.push(actions[i])
      }
    })
    return found
  }

  function declaredPlatforms() {
    if (!lxInited) return []
    return Object.keys(lxInited.sources)
  }

  function hasAction(action) {
    return declaredActions().indexOf(action) >= 0
  }

  /**
   * The response object LX hands a callback: needle's response with a parsed body and a raw text
   * form. Sources read resp.body.songs, resp.statusCode, resp.headers and resp.raw.toString()
   * interchangeably, so all of them have to be present.
   */
  function shapeResponse(response) {
    var text = response && typeof response.body === 'string' ? response.body : ''
    var parsed = null
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      parsed = null
    }
    var status = response ? response.statusCode : 0
    return {
      statusCode: status,
      // status / ok are what the Aurora contract reads; LX sources read statusCode. Both are
      // served from the same object so a source written against either contract behaves the same.
      status: status,
      statusMessage: (response && response.statusMessage) || '',
      ok: Boolean(response && response.ok),
      headers: (response && response.headers) || {},
      bytes: text.length,
      raw: text,
      body: parsed === null ? text : parsed,
      url: response ? response.url : '',
    }
  }

  function formEncode(value) {
    if (typeof value === 'string') return value
    if (!value || typeof value !== 'object') return ''
    var parts = []
    Object.keys(value).forEach(function (key) {
      parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value[key])))
    })
    return parts.join('&')
  }

  /**
   * lx.request(url, options, callback).
   *
   * Faithful in three details that matter: method defaults to a lower-case 'get', timeout is
   * clamped to 60s, and the return value is an **abort function** rather than a promise. Sources
   * routinely do \`const cancel = lx.request(...)\` and call it on unmount.
   */
  function lxRequest(url, options, callback) {
    var opts = options || {}
    var cancelled = false
    var method = String(opts.method == null ? 'get' : opts.method).toUpperCase()
    var body = null
    if (opts.body != null) body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)
    else if (opts.form != null) body = formEncode(opts.form)
    else if (opts.formData != null) body = formEncode(opts.formData)
    var timeoutMs = typeof opts.timeout === 'number' && opts.timeout > 0 ? Math.min(opts.timeout, 60000) : 60000

    var promise = call(
      'http',
      {
        url: url,
        method: method,
        headers: opts.headers || null,
        body: body,
        timeoutMs: timeoutMs,
      },
      timeoutMs,
    )
      .then(function (response) {
        if (cancelled) return null
        var shaped = shapeResponse(response)
        if (typeof callback === 'function') callback.call(lxApi, null, shaped, shaped.body)
        return shaped
      })
      .catch(function (error) {
        if (cancelled) return null
        if (typeof callback === 'function') {
          callback.call(lxApi, error, null, null)
          return null
        }
        throw error
      })

    var abort = function () {
      cancelled = true
    }
    abort.abort = abort
    abort.aborted = false
    // The then/catch above are an extension: LX sources always pass a callback, but awaiting the
    // is the obvious mistake to make, and returning something awaitable is harmless.
    abort.then = promise.then.bind(promise)
    abort.catch = promise.catch.bind(promise)
    return abort
  }

  var lxApi = {
    EVENT_NAMES: EVENT_NAMES,
    env: 'desktop',
    version: '2.0.0',
    currentScriptInfo: {
      name: '',
      description: '',
      version: '',
      author: '',
      homepage: '',
      rawScript: '',
    },
    on: function (name, handler) {
      if (name === EVENT_NAMES.request) {
        lxEvents.request = handler
        return Promise.resolve()
      }
      // Forward compatibility, deliberately: sources in the wild already use event names newer than
      // this runtime (showConfigView, …). Rejecting would surface as an unhandled rejection during
      // init and make an otherwise working source look broken. A name the runtime does not know is
      // recorded and ignored, so the source keeps its own logic and still announces inited.
      record('warn', '运行时未实现的事件（已忽略）：' + String(name))
      return Promise.resolve()
    },
    send: function (name, data) {
      lxTouched = true
      return new Promise(function (resolve, reject) {
        if (name === EVENT_NAMES.inited) {
          if (lxInitedOnce) {
            reject(new Error('Script is inited'))
            return
          }
          lxInitedOnce = true
          lxInited = normalizeInit(data)
          resolve()
          return
        }
        if (name === EVENT_NAMES.updateAlert) {
          lxUpdateAlert = data && typeof data === 'object' ? data : null
          resolve()
          return
        }
        record('warn', '运行时未实现的事件（已忽略）：' + String(name))
        resolve()
      })
    },
    request: lxRequest,
    utils: {
      crypto: lxCrypto,
      buffer: lxBuffer,
      zlib: lxZlib,
    },
  }
  globalThis.lx = lxApi

  // --- Aurora request API ---------------------------------------------------------------------
  //
  // This is the ONLY way a script can reach the network: fetch() inside this window is cancelled by
  // the host session, so scripts use these helpers, which go over the bridge and are therefore
  // subject to the permission layer. Both the aurora.request.* global and the third argument
  // every source method receives point at the same object.
  function requestOnce(url, options) {
    var opts = options || {}
    // Any bridge use is evidence the script is alive and mid-bootstrap, not that it is inert.
    bridgeUsed = true
    return call(
      'http',
      {
        url: url,
        method: String(opts.method || 'GET').toUpperCase(),
        headers: opts.headers || null,
        body:
          opts.body != null
            ? typeof opts.body === 'string'
              ? opts.body
              : JSON.stringify(opts.body)
            : null,
        form: opts.form || null,
        timeoutMs: opts.timeout || opts.timeoutMs || 0,
      },
      opts.timeout || opts.timeoutMs || 0,
    ).then(shapeResponse)
  }

  var auroraRequest = {
    request: requestOnce,
    raw: requestOnce,
    get: function (url, options) {
      return requestOnce(url, Object.assign({}, options || {}, { method: 'GET' }))
    },
    post: function (url, body, options) {
      return requestOnce(url, Object.assign({}, options || {}, { method: 'POST', body: body }))
    },
    /** Convenience: throws when the response is not ok, and returns the parsed JSON body. */
    json: async function (url, options) {
      var response = await requestOnce(url, options)
      if (!response.ok) throw new Error('HTTP ' + response.statusCode + ' @ ' + url)
      if (response.body && typeof response.body === 'object') return response.body
      try {
        return JSON.parse(response.raw)
      } catch (error) {
        throw new Error('响应不是 JSON：' + response.raw.slice(0, 120))
      }
    },
    /** Convenience: throws when the response is not ok, and returns the raw text body. */
    text: async function (url, options) {
      var response = await requestOnce(url, options)
      if (!response.ok) throw new Error('HTTP ' + response.statusCode + ' @ ' + url)
      return response.raw
    },
  }
  globalThis.auroraRequest = auroraRequest
  globalThis.auroraHttp = auroraRequest

  /** What every source method receives as its last argument. */
  function apiContext() {
    return {
      http: auroraRequest,
      request: auroraRequest,
      config: context.config,
      permissions: context.permissions,
      sourceId: context.sourceId,
    }
  }

  // --- dispatch --------------------------------------------------------------------------------
  function auroraSourceOrThrow() {
    var source = resolveAuroraSource()
    if (!source || typeof source !== 'object') {
      throw new Error(
        '脚本没有导出音源：请使用 defineAuroraSource({...})、globalThis.auroraSource = {...} 或 module.exports = {...}',
      )
    }
    return source
  }

  /** Throws a readable *unsupported* error, naming every spelling that would have worked. */
  function requireMethod(source, name) {
    var found = pickMethod(source, name)
    if (!found) throw new Error('该脚本没有实现 ' + methodCandidates(name).join(' / '))
    return found.fn
  }

  async function dispatchAurora(request) {
    var source = auroraSourceOrThrow()
    var api = apiContext()
    switch (request.op) {
      case 'search':
        if (typeof source.search !== 'function') throw new Error('该脚本没有实现 search')
        // Results may be a bare array or a nested object; the adapter finds the array in both.
        return await source.search(String(request.keyword || ''), Number(request.page || 1), api)
      case 'getSongDetail':
        return await requireMethod(source, 'getSongDetail')(String(request.id), api)
      case 'getPlayUrl':
        return await requireMethod(source, 'getPlayUrl')(request.track, request.quality || undefined, api)
      case 'getLyric':
        return await requireMethod(source, 'getLyric')(request.track, api)
      case 'getCover':
        return await requireMethod(source, 'getCover')(request.track, api)
      case 'getAlbum':
        return await requireMethod(source, 'getAlbum')(String(request.id), api)
      case 'getArtist':
        return await requireMethod(source, 'getArtist')(String(request.id), api)
      case 'getPlaylist':
        return await requireMethod(source, 'getPlaylist')(String(request.id), api)
      case 'getLeaderboard':
        return await requireMethod(source, 'getLeaderboard')(api)
      case 'healthCheck':
        if (typeof source.healthCheck === 'function') return await source.healthCheck(api)
        return { ok: true, message: '脚本已加载' }
      default:
        throw new Error('不支持的操作：' + String(request.op))
    }
  }

  /**
   * The LX protocol request, in the shape existing sources destructure:
   *
   *   musicUrl → { source, action: 'musicUrl', info: { type, musicInfo } }
   *   lyric    → { source, action: 'lyric',    info: { type, musicInfo } }
   *   pic      → { source, action: 'pic',      info: { type, musicInfo } }
   *   search   → { source, action: 'search',   info: { keyword, page } }
   *
   * musicInfo is the raw object the source (or Aurora's platform search) produced, which is why
   * nothing here reshapes it.
   */
  async function dispatchLx(request) {
    var op = String(request.op == null ? '' : request.op)

    // Readiness is part of the runtime, not a request: an LX source answers musicUrl, never
    // healthCheck. Answering it locally is also what stops the "action not support: undefined"
    // failure that used to appear when a source was merely *connected*.
    if (op === 'healthCheck' || op === 'describe') {
      if (!lxInited) {
        throw new Error('脚本没有发送 lx.EVENT_NAMES.inited，无法确认它支持哪些平台')
      }
      if (typeof lxEvents.request !== 'function') {
        throw new Error('脚本没有通过 lx.on(lx.EVENT_NAMES.request, handler) 注册请求处理器')
      }
      var platforms = declaredPlatforms()
      if (platforms.length === 0) {
        throw new Error('脚本声明的音源里没有 type: "music" 的条目')
      }
      return {
        ok: true,
        message: '运行时就绪：' + platforms.length + ' 个平台',
        platforms: platforms,
        actions: declaredActions(),
      }
    }

    var handler = lxEvents.request
    if (typeof handler !== 'function') {
      throw new Error('脚本没有通过 lx.on(lx.EVENT_NAMES.request, handler) 注册请求处理器')
    }

    var action = op === 'search' ? 'search' : String(request.action == null ? '' : request.action)
    if (!action) {
      throw new Error('缺少 action：musicUrl / lyric / pic / search 之一')
    }
    if (!hasAction(action) && action !== 'search') {
      // Not a veto: the source may still answer. It is reported so a mismatch is visible in the log.
      record('warn', '脚本没有在 inited 里声明 ' + action + '，仍然尝试调用')
    }

    var info
    if (action === 'musicUrl') {
      info = { type: String(request.quality || '320k'), musicInfo: request.info || {} }
    } else if (action === 'search') {
      info = {
        keyword: String(request.keyword || ''),
        page: Number(request.page || 1),
        limit: Number(request.pageSize || 30),
      }
    } else {
      info = { musicInfo: request.info || {} }
    }

    return await handler({
      source: String(request.source || ''),
      action: action,
      info: info,
    })
  }

  function jsonSafe(value) {
    if (value === undefined) return null
    return JSON.parse(JSON.stringify(value))
  }

  globalThis.__auroraRuntime = {
    installed: true,
    setup: function (options) {
      var next = options || {}
      runtimeKind = next.runtime === 'lx' ? 'lx' : 'aurora'
      context = {
        config: next.config || {},
        sourceId: String(next.sourceId || ''),
        permissions: next.permissions || [],
        qualities: next.qualities || [],
      }
      globalThis.auroraContext = context
      if (next.scriptInfo && typeof next.scriptInfo === 'object') {
        var info = next.scriptInfo
        lxApi.currentScriptInfo = {
          name: String(info.name == null ? '' : info.name),
          description: String(info.description == null ? '' : info.description),
          version: String(info.version == null ? '' : info.version),
          author: String(info.author == null ? '' : info.author),
          homepage: String(info.homepage == null ? '' : info.homepage),
          rawScript: String(info.rawScript == null ? '' : info.rawScript),
        }
      }
      return { runtime: runtimeKind }
    },
    /**
     * Runs one operation and returns a *tagged* result.
     *
     * It must not throw across the executeJavaScript boundary: Electron only preserves the message
     * of a rejected error, so an error code would be lost and a refusal would look like a crash. The
     * envelope keeps the code intact for the main process to rethrow as a typed SourceError.
     */
    invoke: async function (request) {
      try {
        var result =
          runtimeKind === 'lx' ? await dispatchLx(request || {}) : await dispatchAurora(request || {})
        return { ok: true, value: jsonSafe(result) }
      } catch (error) {
        return {
          ok: false,
          code: (error && error.code) || 'INVALID_RESPONSE',
          message: String((error && error.message) || error),
        }
      }
    },
    describe: function () {
      var declaration = {
        runtime: runtimeKind,
        name: '',
        version: '',
        description: '',
        author: '',
        homepage: '',
        platforms: [],
        actions: [],
        qualities: [],
        canSearch: false,
        logs: logs.slice(0, LOG_LIMIT),
        warnings: warnings.slice(0, LOG_LIMIT),
        // Blocking problems only — filled in below. Everything logged by the script is a warning.
        errors: [],
      }

      var loadErrors = globalThis.__auroraScriptLoadErrors || []
      for (var loadIndex = 0; loadIndex < loadErrors.length; loadIndex++) {
        declaration.errors.push(String(loadErrors[loadIndex]))
      }
      /*
       * The one hard failure, reported as itself.
       *
       * "The script threw while loading" and "the script loaded but has not declared itself yet"
       * look the same to a caller that only reads the error list, not the same thing at all:
       * the first one cannot work, the second one is routinely just a source that is still starting
       * (or that announces itself through a runtime this host does not speak). Flagging it keeps that
       * difference visible all the way to the import decision.
       */
      declaration.loadFailed = loadErrors.length > 0

      /*
       * Auto-upgrade on execution evidence.
       *
       * In the wild most 洛雪 sources are minified/obfuscated, and the file names are mangled too,
       * so a text heuristic ("does the file mention globalThis.lx?") misses them: the source ends up
       * probed as an Aurora source and is then reported as "this script did not export a source",
       * which is a false failure — the script *did* announce itself, just through lx.send(inited).
       * The runtime is the only thing that can actually observe that, so it upgrades here and the
       * declaration below reports runtime 'lx' to everyone downstream (persistence, adapter, UI).
       */
      /*
       * Execution evidence travels with the declaration on **both** paths, and it has to be set
       * before the 洛雪 branch returns.
       *
       * It used to be set only on the Aurora path, which quietly disabled the host's wait for exactly
       * the sources that need it most: a source classified as 洛雪 (or auto-upgraded to it) reported no
       * evidence, so the host's wait was disabled and it was declared "no capabilities" on the first
       * read — before the fetch it was waiting on had a chance to finish.
       */
      declaration.lxPending = lxTouched && !lxInited
      declaration.bridgeUsed = bridgeUsed

      if (runtimeKind !== 'lx' && lxInited) {
        runtimeKind = 'lx'
        declaration.runtime = 'lx'
        record('warn', '升级为洛雪协议：脚本通过 lx.EVENT_NAMES.inited 声明了自己')
      }

      if (runtimeKind === 'lx') {
        if (!lxInited) {
          declaration.errors.push('脚本没有发送 lx.EVENT_NAMES.inited，无法确认它支持哪些平台')
          return declaration
        }
        declaration.name = lxInited.name
        declaration.description = lxInited.description
        declaration.version = lxInited.version
        declaration.author = lxInited.author
        declaration.homepage = lxInited.homepage
        if (typeof lxEvents.request !== 'function') {
          declaration.errors.push('脚本没有通过 lx.on(lx.EVENT_NAMES.request, handler) 注册请求处理器')
        }
        Object.keys(lxInited.sources).forEach(function (id) {
          var entry = lxInited.sources[id]
          declaration.platforms.push({ id: String(id), name: String(entry.name || id) })
        })
        declaration.actions = declaredActions()
        declaration.qualities = []
        Object.keys(lxInited.sources).forEach(function (id) {
          var list = lxInited.sources[id].qualities || []
          for (var q = 0; q < list.length; q++) {
            if (declaration.qualities.indexOf(list[q]) < 0) declaration.qualities.push(list[q])
          }
        })
        declaration.canSearch = declaration.actions.indexOf('search') >= 0
        if (lxUpdateAlert) {
          declaration.updateAlert = {
            log: String((lxUpdateAlert && lxUpdateAlert.log) || '').slice(0, 1024),
            updateUrl: String((lxUpdateAlert && lxUpdateAlert.updateUrl) || '').slice(0, 1024),
          }
        }
        return declaration
      }

      /*
       * Discovery failures are reported, never thrown.
       *        * describe() is how a source is judged at import time; a global getter that throws while
       * looking for the source object used to abort the whole description, so a file that merely
       * *declares nothing* came back as "the runtime could not run it" — a real refusal, for a file
       * that runs perfectly. The failure belongs in the warnings, where it explains itself.
       */
      var source = null
      try {
        source = resolveAuroraSource()
      } catch (error) {
        declaration.warnings.push(
          '在全局对象里寻找音源时出现异常（已跳过这一项）：' + String((error && error.message) || error),
        )
      }
      if (!source) {
        /*
         * Two very different outcomes, and the difference is the whole point of reporting evidence
         * rather than a verdict:
         *
         *  - the script used the 洛雪 API (or already made a request) but has not announced itself yet
         *    → it is still bootstrapping. The host waits; if the wait expires the message says that,
         *    instead of telling the author of a working source to rewrite it against a contract it
         *    never claimed to implement.
         *  - nothing at all → it really is not a source, and the message lists every accepted shape.
         */
        if (lxTouched && !lxInited) {
          declaration.lxPending = true
          declaration.errors.push(
            '这是一个洛雪风格脚本：它已经用到了 lx API，但还没有发送 lx.EVENT_NAMES.inited。若它需要先拉取自身配置，请稍后点「重新加载」；若始终不发，通常是它依赖的接口已经失效。',
          )
        } else {
          /*
           * Not a verdict, and deliberately not phrased as one.
           *
           * Minified/obfuscated published sources build the name 'inited' out of a string table, so
           * neither the text hint nor the LX shim necessarily sees them touch lx at import time —
           * and telling their author to rewrite the file against defineAuroraSource would be wrong
           * twice over. What this says is only what was observed: it loaded and declared nothing
           * *yet*. The import flow lets it through on that basis, and the
           * source manager can re-probe it later with「重新加载」.
           */
          declaration.errors.push(
            '脚本已加载并执行，但没有声明任何音源能力：既没有调用 defineAuroraSource / globalThis.auroraSource / module.exports，也没有发送洛雪 inited。如果是需要先拉取自身配置的音源，可以先安装，再用「重新加载」重新探测（需要几秒）；若始终不声明，通常是它依赖的接口或版本已失效。',
          )
        }
        return declaration
      }
      declaration.actions = declaredMethods(source)
      declaration.canSearch = declaration.actions.indexOf('search') >= 0
      declaration.name = String(source.name || '')
      declaration.version = String(source.version || '')
      declaration.description = String(source.description || '')
      declaration.author = String(source.author || '')
      declaration.homepage = String(source.homepage || '')
      var platforms = Array.isArray(source.platforms) ? source.platforms : []
      for (var p = 0; p < platforms.length; p++) {
        var item = platforms[p]
        if (typeof item === 'string') declaration.platforms.push({ id: item, name: item })
        else if (item && item.id) {
          declaration.platforms.push({ id: String(item.id), name: String(item.name || item.id) })
        }
      }
      declaration.qualities = (Array.isArray(source.qualities) ? source.qualities : []).map(String)
      return declaration
    },
  }

  return { installed: true }
})()
`
