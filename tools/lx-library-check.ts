/**
 * Diagnostic: reads a **real** 洛雪 source library (`user_api.json`) and reports what Aurora can do
 * with each source in it.
 *
 * This is the real-world entry point, and it is a *manual* tool on purpose: it needs the user's own
 * file and the live internet, so it cannot be part of `verify`. What it answers is the question a
 * user actually has — "I have twenty sources; which of them work here?" — and it answers it by doing
 * exactly what the app does: decode, load in the sandbox, read the declaration, then search and
 * resolve a play URL, fetching real audio bytes.
 *
 *   npm run check:lx-library                     # the LX profile on this machine
 *   npm run check:lx-library -- <path> 晴天       # a specific file and keyword
 */
import { net, app } from 'electron'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configureCoversDirectory, registerMediaProtocol, registerMediaScheme } from '../src/main/media'
import { initSettings, getSettings, updateSettings } from '../src/main/settings'
import { initSecretStore } from '../src/main/secretStore'
import { initSourceStore } from '../src/main/sources/store'
import { resolveStream, searchOne } from '../src/main/sources'
import { toSourceMusicInfo } from '../src/main/musicSdk'
import { initScriptSources, importLxLibrary, previewLxLibrary } from '../src/main/scriptSources/store'
import { disposeAllScriptHosts } from '../src/main/scriptHost/host'

const DEFAULT_LIBRARY = join(
  process.env.APPDATA ?? join(process.env.HOME ?? '', 'AppData', 'Roaming'),
  'lx-music-desktop',
  'LxDatas',
  'user_api.json',
)

const runDir = join(tmpdir(), `aurora-lx-library-${Date.now()}`)
app.setPath('userData', runDir)

/**
 * Long, because it is a survey of a whole library: a source whose first backend is dead walks its
 * entire fallback list, and several of those take their own timeout to give up. Override the
 * per-call budget with `AURORA_LX_TIMEOUT_MS` when you only care about the sources that answer fast.
 */
const watchdog = setTimeout(() => {
  console.error('FAIL  check:lx-library 超时（1500s），强制退出')
  app.exit(2)
}, 1_500_000)
watchdog.unref?.()

registerMediaScheme()
app.on('window-all-closed', () => undefined)

async function bytesOf(url: string): Promise<{ status: number; type: string; bytes: number }> {
  const response = await net.fetch(url, { headers: { Range: 'bytes=0-255' } })
  const buffer = Buffer.from(await response.arrayBuffer())
  return {
    status: response.status,
    type: String(response.headers.get('content-type') ?? ''),
    bytes: buffer.length,
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const libraryPath = args.find((arg) => arg.endsWith('.json')) ?? DEFAULT_LIBRARY
  const keyword = args.filter((arg) => !arg.endsWith('.json')).join(' ') || '晴天'

  await configureCoversDirectory(join(runDir, 'covers'))
  registerMediaProtocol()
  await initSettings()
  await initSecretStore(runDir)
  await initSourceStore(runDir)

  await initScriptSources(runDir, {
    preloadPath: join(process.cwd(), 'tools', '.build', 'script-host.cjs'),
    callTimeoutMs: Number(process.env.AURORA_LX_TIMEOUT_MS ?? 60_000),
    installTimeoutMs: 30_000,
  })

  const text = await readFile(libraryPath, 'utf8')
  console.log(`library: ${libraryPath}`)
  console.log(`size:    ${(Buffer.byteLength(text, 'utf8') / 1024).toFixed(0)}KB\n`)

  const preview = await previewLxLibrary(text, 'user_api.json')
  console.log(`找到 ${preview.items.length} 个音源，${preview.items.filter((item) => item.ok).length} 个可以加载\n`)
  if (preview.errors.length > 0) {
    console.log('解码问题：')
    for (const error of preview.errors) console.log(`  - ${error}`)
    console.log('')
  }

  for (const item of preview.items) {
    const platforms = item.platforms.map((platform) => platform.id).join(',') || '—'
    console.log(
      `${item.ok ? '✓' : '✗'} ${item.name} v${item.version} [${item.runtime}] 平台=${platforms} 动作=${item.actions.join(',') || '—'}`,
    )
    for (const error of item.errors) console.log(`    ${error}`)
  }

  // Import every source that loaded, then actually search + resolve with it. Installing is not a
  // permission decision, so a broken source is skipped here only because it has nothing to prove.
  const importable = preview.items.filter((item) => item.ok).map((item) => item.id)
  const imported = await importLxLibrary(text, importable, 'user_api.json')
  console.log(`\n导入：成功 ${imported.added}，失败 ${imported.failed.length}`)
  for (const failure of imported.failed) console.log(`  ✗ ${failure.name}: ${failure.errors.join(' / ')}`)
  await updateSettings({ enabledSources: Object.fromEntries(importable.map((id) => [id, true])) })

  // `AURORA_FORCE_PLATFORM=tx` pins every source to one platform: when several sources fail on the
  // same platform, that is how you tell "the backend is down" from "Aurora's query is wrong".
  const forced = process.env.AURORA_FORCE_PLATFORM
  const platformIds = forced ? [forced] : ['kw', 'wy', 'tx', 'kg', 'mg']
  console.log(`\n用每个已导入的音源搜索「${keyword}」并解析播放地址（只试支持该平台的）：`)

  for (const item of preview.items.filter((candidate) => candidate.ok)) {
    const platforms = item.platforms
      .map((platform) => platform.id)
      .filter((id) => platformIds.includes(id))
      // Pinned: a source that does not declare the platform is skipped, since Aurora would refuse
      // the request anyway (`resolversFor` filters on the declaration).
      .filter((id) => !forced || item.platforms.some((platform) => platform.id === id))
    if (platforms.length === 0) continue
    const platformId = platforms[0] as string
    let resolved = false
    const outcome = await searchOne(platformId, keyword, { pageSize: 10 }, getSettings())
    if (!outcome.ok || outcome.tracks.length === 0) {
      console.log(`  ${item.name.padEnd(22)} ${platformId}: 搜索无结果（${outcome.error?.message ?? '空'}）`)
      continue
    }
    // Platform search only gives a track; the play URL comes from a *user* source. `resolveStream`
    // on the platform id fans out to every enabled source that declares it, which is the same path
    // playback takes.
    try {
      const stream = await resolveStream(platformId, outcome.tracks[0].sourceTrackId ?? outcome.tracks[0].id, getSettings(), {}, {
        track: outcome.tracks[0],
        ...(process.env.AURORA_QUALITY ? { quality: process.env.AURORA_QUALITY } : {}),
      })
      if (!stream) {
        console.log(`  ${item.name.padEnd(22)} ${platformId}: 解析返回空`)
        continue
      }
      const bytes = await bytesOf(stream.url)
      const ok = bytes.status >= 200 && bytes.status < 300 && bytes.bytes > 0
      resolved = ok
      console.log(
        `  ${item.name.padEnd(22)} ${platformId}: ${ok ? 'PASS' : 'FAIL'} → HTTP ${bytes.status} ${bytes.type} ${bytes.bytes} 字节`,
      )
      if (!ok) console.log(`    musicInfo: ${JSON.stringify(toSourceMusicInfo((outcome.tracks[0].metadata as { lx?: unknown }).lx as never)).slice(0, 260)}`)
    } catch (error) {
      console.log(`  ${item.name.padEnd(22)} ${platformId}: 解析失败 — ${error instanceof Error ? error.message.slice(0, 120) : String(error)}`)
    }
    if (!resolved) continue
  }

  disposeAllScriptHosts()
  app.exit(0)
}

app.whenReady().then(main).catch((error) => {
  console.log(`FAIL ${error instanceof Error ? error.stack : String(error)}`)
  app.exit(1)
})
