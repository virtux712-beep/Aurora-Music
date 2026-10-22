/**
 * End-to-end diagnostic with a **real** LX Music source.
 *
 * Everything the smoke suites do uses local fixtures, which is what makes them deterministic — but it
 * also means they would still pass if Aurora's runtime were subtly incompatible with the sources
 * people actually install. This tool closes that gap by taking a source file from `lx-sources/` (or
 * a path on the command line) and running the whole product chain against the live internet:
 *
 *   read file → probe → install → enable → platform search → resolve play URL → fetch audio bytes
 *
 * It is a *manual* tool (the network is not something a build should depend on). Exit code is 0 only
 * when the chain produced real audio bytes.
 *
 *   npm run check:lx                              # first source in tools/.build/lx-sources
 *   npm run check:lx -- "path/to/source.js" 晴天  # a specific file and keyword
 */
import { net, app } from 'electron'
import { readdir, readFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { toSourceMusicInfo } from '../src/main/musicSdk'
import { configureCoversDirectory, registerMediaProtocol, registerMediaScheme } from '../src/main/media'
import { upstreamForMediaUrl } from '../src/main/remote'
import { initSettings, updateSettings, getSettings } from '../src/main/settings'
import { initSecretStore } from '../src/main/secretStore'
import { initSourceStore } from '../src/main/sources/store'
import { resolveStream, searchOne } from '../src/main/sources'
import { resolvePlatformTrack, searchPlatformOutcome } from '../src/main/platforms'
import { readRequestLog, readErrorLog } from '../src/main/sources'
import { getScriptHost } from '../src/main/scriptHost/host'
import { grantScriptHosts, initScriptSources, probeScriptImport, saveScriptSource } from '../src/main/scriptSources/store'
import { disposeAllScriptHosts } from '../src/main/scriptHost/host'
import { readPendingHosts } from '../src/main/sources/permissions'
import type { AudioTrack, PlaybackQuality } from '../src/shared/types'

const SOURCE_DIR = join(process.cwd(), 'tools', '.build', 'lx-sources')
const DEFAULT_KEYWORD = '周杰伦 晴天'

const runDir = join(tmpdir(), `aurora-lx-real-${Date.now()}`)
app.setPath('userData', runDir)

const watchdog = setTimeout(() => {
  console.error('FAIL  check:lx 超时（180s），强制退出')
  app.exit(2)
}, 180_000)
watchdog.unref?.()

registerMediaScheme()
app.on('window-all-closed', () => undefined)

async function pickSourceFile(): Promise<string> {
  const explicit = process.argv.slice(2).find((arg) => arg.endsWith('.js'))
  if (explicit) return explicit
  const files = (await readdir(SOURCE_DIR)).filter((file) => file.endsWith('.js'))
  if (files.length === 0) throw new Error(`没有找到音源文件：${SOURCE_DIR}`)
  // Prefer a source whose inited declaration covers several platforms; those are the ones that can
  // realistically resolve a play URL for a platform-search track.
  return join(SOURCE_DIR, files[0])
}

/** What a source actually did, so a failure can be explained instead of guessed at. */
function dumpDiagnostics(sourceId: string): void {
  const pending = readPendingHosts(sourceId)
  if (pending.length > 0) console.log(`    pending hosts: ${pending.map((host) => host.host).join(', ')}`)
  for (const entry of readRequestLog(sourceId).slice(-8)) {
    console.log(`    request: ${entry.method ?? 'GET'} ${String(entry.url).slice(0, 120)} → ${entry.status}`)
  }
  for (const entry of readErrorLog(sourceId).slice(-4)) {
    console.log(`    error: ${entry.code} ${entry.message.slice(0, 160)}`)
  }
  for (const line of getScriptHost(sourceId)?.readLog().slice(-8) ?? []) {
    console.log(`    script: ${line.slice(0, 200)}`)
  }
}

async function bytesOf(url: string): Promise<{ status: number; type: string; bytes: number }> {
  const response = await net.fetch(url, { headers: { Range: 'bytes=0-255' } })
  const buffer = Buffer.from(await response.arrayBuffer())
  return {
    status: response.status,
    type: String(response.headers.get('content-type') ?? ''),
    bytes: buffer.length,
  }
}

/** Fetch the upstream directly, bypassing the relay, so a 404 can be attributed. */
async function probeUpstream(relayed: string): Promise<void> {
  const upstream = upstreamForMediaUrl(relayed)
  if (!upstream) {
    console.log('    upstream: (token 不在 relay 注册表里 —— 中继层丢失了它)')
    return
  }
  console.log(`    upstream: ${upstream.url.slice(0, 120)}`)
  try {
    const response = await net.fetch(upstream.url, { headers: { Range: 'bytes=0-255' }, redirect: 'follow' })
    const text = Buffer.from(await response.arrayBuffer())
    console.log(
      `    upstream 直连: HTTP ${response.status} ${String(response.headers.get('content-type') ?? '')} ${text.length} 字节`,
    )
  } catch (error) {
    console.log(`    upstream 直连失败: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function main(): Promise<void> {
  await configureCoversDirectory(join(runDir, 'covers'))
  registerMediaProtocol()
  await initSettings()
  await initSecretStore(runDir)
  await initSourceStore(runDir)

  // Real sources walk a long list of aggregator backends, so a single `musicUrl` call can legitimately
  // take far longer than the in-app default. The number here is a diagnostic budget, not a product
  // setting.
  const callTimeoutMs = Number(process.env.AURORA_LX_TIMEOUT_MS ?? 60_000)
  await initScriptSources(runDir, {
    preloadPath: join(process.cwd(), 'tools', '.build', 'script-host.cjs'),
    callTimeoutMs,
    installTimeoutMs: 30_000,
  })

  const file = await pickSourceFile()
  const sourceText = await readFile(file, 'utf8')
  console.log(`source:   ${basename(decodeURIComponent(file))} (${(sourceText.length / 1024).toFixed(0)}KB)`)

  // ---- probe (import phase 1): run it and read what it declares ------------------------------
  const probe = await probeScriptImport({ sourceText, fileName: basename(file) })
  if (!probe.ok || !probe.declaration) {
    console.log(`FAIL 探测失败：${probe.errors.join(' / ')}`)
    app.exit(1)
    return
  }
  const declaration = probe.declaration
  console.log(`declared: ${declaration.name || '(unnamed)'} — runtime=${declaration.runtime}`)
  console.log(`platforms: ${declaration.platforms.map((platform) => platform.id).join(', ') || '(none)'}`)
  console.log(`actions:   ${declaration.actions.join(', ')}`)
  console.log(`hosts:     ${readPendingHosts(probe.manifest?.id ?? '').map((host) => host.host).join(', ')}`)

  // ---- install (import phase 2): persist what the user would have confirmed -------------------
  const id = probe.manifest.id
  const saved = await saveScriptSource({
    sourceText,
    manifest: {
      ...probe.manifest,
      id,
      permissions: ['network', 'crypto'],
      allowedHosts: probe.manifest.allowedHosts,
    },
  })
  if (!saved.ok) {
    console.log(`FAIL 安装失败：${saved.errors.join(' / ')}`)
    app.exit(1)
    return
  }
  await updateSettings({ enabledSources: { [id]: true } })
  console.log(`installed: ${id} ✓（hosts: ${probe.manifest.allowedHosts.join(', ') || '无'}）`)

  let sawAudio = false
  const platformIds = ['kw', 'wy', 'tx', 'kg', 'mg']
  const keyword = process.argv.slice(2).filter((arg) => !arg.endsWith('.js')).join(' ') || DEFAULT_KEYWORD
  console.log(`\nsearch:   "${keyword}"`)

  for (const platformId of platformIds) {
    let tracks: AudioTrack[] = []
    /*
     * Search the **platform**, not the source.
     *
     * Most 洛雪 sources people install are pure resolvers: they declare `musicUrl` for kw/wy/tx/… but
     * no `search` action (this file's `actions:` line is the proof). Searching the source itself would
     * therefore report "音源不存在" and prove nothing. The real flow — and what this tool must
     * reproduce — is: platform search from Aurora's own registry, then the source resolves that
     * track's play URL. That is also the only path that exercises the platform→resolver fan-out.
     */
    const canSearchItself = (probe.declaration?.actions ?? []).includes('search')
    const outcome = canSearchItself
      ? await searchOne(platformId, keyword, { pageSize: 10 }, getSettings())
      : await searchPlatformOutcome(platformId, keyword, { pageSize: 10 })
    if (!outcome.ok) {
      console.log(`  ${platformId}: 搜索失败 — ${outcome.error?.message ?? '未知错误'}`)
      continue
    }
    tracks = outcome.tracks
    if (tracks.length === 0) {
      console.log(`  ${platformId}: 没有结果`)
      continue
    }
    const track = tracks[0]
    console.log(`  ${platformId}: ${track.title} — ${track.artist}（${tracks.length} 条）`)
    const lx = (track.metadata as { lx?: unknown } | undefined)?.lx
    if (lx) console.log(`  ${platformId}: musicInfo ${JSON.stringify(toSourceMusicInfo(lx as never)).slice(0, 400)}`)
    try {
      // The track must be passed through, exactly as the app does: it carries the `lx` musicInfo the
      // script reads its ids out of. Resolving by id alone would hand the script a stub and make it
      // ask the wrong provider (`wy.php?id=kw_228908`).
      /*
       * Installing a source and letting it use the network are two separate decisions — on purpose.
       * A 洛雪 source discovers its API host while resolving, so the first attempt is refused and the
       * host lands in the pending list; the app surfaces that as a one-click grant in 音源管理. This
       * tool walks the same path: resolve → grant what it asked for → resolve again.
       */
      const attempt = async (
        quality?: PlaybackQuality,
      ): Promise<Awaited<ReturnType<typeof resolvePlatformTrack>> | null> =>
        canSearchItself
          ? await resolveStream(platformId, track.sourceTrackId ?? track.id, getSettings(), {}, { track })
          : await resolvePlatformTrack(track, quality, getSettings(), {})

      /*
       * Try the qualities the track actually advertises, best first.
       *
       * A user picks a quality in the player, so "the lossless request failed at the upstream" is not
       * the same answer as "this track cannot be played". Third-party aggregators frequently refuse a
       * tier they do not serve for that account while serving a lower one, and the app is expected to
       * fall back the same way rather than declaring the song unplayable.
       */
      const wanted: (PlaybackQuality | undefined)[] = (track.qualities ?? []).length > 0
        ? [...(track.qualities ?? [])]
        : ['flac24bit', 'flac', '320k', '128k', undefined]
      let stream: Awaited<ReturnType<typeof attempt>> = null
      let lastError: unknown = null
      for (const quality of wanted) {
        try {
          stream = await attempt(quality)
        } catch (error) {
          lastError = error
          const pendingHosts = readPendingHosts(id).map((request) => request.host)
          if (pendingHosts.length === 0) continue
          console.log(`  ${platformId}: 首次被拒（未授权主机），授权后重试：${pendingHosts.join(', ')}`)
          const granted = await grantScriptHosts(id, pendingHosts)
          if (!granted.ok) continue
          try {
            stream = await attempt(quality)
          } catch (retryError) {
            lastError = retryError
            continue
          }
        }
        if (stream) break
      }
      if (!stream) {
        if (lastError) throw lastError
        console.log(`  ${platformId}: 解析返回空`)
        continue
      }
      const bytes = await bytesOf(stream.url)
      const ok = bytes.status >= 200 && bytes.status < 300 && bytes.bytes > 0
      const host = (() => {
        try {
          return new URL(stream.url).host
        } catch {
          return '(bad url)'
        }
      })()
      console.log(
        `  ${platformId}: ${ok ? 'PASS' : 'FAIL'} → ${host} ${stream.quality ?? '(未标注音质)'} HTTP ${bytes.status} ${bytes.type} ${bytes.bytes} 字节`,
      )
      if (!ok) await probeUpstream(stream.url)
      if (ok) {
        sawAudio = true
        break
      }
    } catch (error) {
      console.log(`  ${platformId}: 解析失败 — ${error instanceof Error ? error.message : String(error)}`)
      dumpDiagnostics(id)
    }
  }

  console.log(sawAudio ? '\nRESULT: PASS（解析出真实音频字节）' : '\nRESULT: FAIL（没有任何平台解析出可播放音频）')
  disposeAllScriptHosts()
  app.exit(sawAudio ? 0 : 1)
}

app.whenReady().then(main).catch((error) => {
  console.log(`FAIL ${error instanceof Error ? error.stack : String(error)}`)
  app.exit(1)
})
