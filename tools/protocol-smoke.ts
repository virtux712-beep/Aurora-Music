/**
 * Integration smoke test for the Aurora Music media pipeline.
 *
 * It exercises the real `src/main/media.ts` code inside Electron and asserts:
 *   1. range requests return 206 with correct Content-Range
 *   2. files that were never authorized by the user are unreachable
 *   3. the cover endpoint rejects path-traversal style names   *   4. a renderer <audio> element can decode and actually play an authorized file
   *   5. a cover — local file or relayed remote — reaches the renderer and can be *read back*, which
   *      is what the ambient backdrop's dominant-colour extraction depends on
   *   6. the generated tray / taskbar icons are real decodable PNGs with visible content
 *
 * Run with: npm run smoke:media
 */
import { app, BrowserWindow, nativeImage, net } from 'electron'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { authorizeAudio, configureCoversDirectory, registerMediaProtocol, registerMediaScheme } from '../src/main/media'
import { glyphImage, glyphPng, trayImage } from '../src/main/mediaGlyphs'
import { registerRemoteMedia } from '../src/main/remote'

registerMediaScheme()

const checks: Array<{ name: string; ok: boolean; detail: unknown }> = []

function check(name: string, ok: boolean, detail: unknown = ''): void {
  checks.push({ name, ok, detail })
}

function makeWav(seconds: number, sampleRate = 8000): Buffer {
  const sampleCount = seconds * sampleRate
  const samples = Buffer.alloc(sampleCount * 2)
  for (let index = 0; index < sampleCount; index += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 0.3 * 32767)
    samples.writeInt16LE(value, index * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + samples.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(samples.length, 40)
  return Buffer.concat([header, samples])
}

const page = `<!doctype html>
<html><body><script>
window.__result = null
;(async () => {
  const out = {}
  const audio = new Audio('aurora-media://audio/smoke')
  audio.muted = true
  out.metadata = await new Promise((resolve) => {
    audio.onloadedmetadata = () => resolve({ duration: audio.duration })
    audio.onerror = () => resolve({ error: audio.error ? audio.error.code : 'unknown' })
    setTimeout(() => resolve({ timeout: true, networkState: audio.networkState }), 5000)
  })
  try {
    await audio.play()
    await new Promise((r) => setTimeout(r, 700))
    out.currentTime = audio.currentTime
    out.playing = !audio.paused && audio.currentTime > 0
    audio.currentTime = 2
    await new Promise((r) => setTimeout(r, 500))
    out.seekedTo = audio.currentTime
    audio.pause()
  } catch (error) {
    out.playError = String(error)
  }
  window.__result = out
})()
</script></body></html>`

/**
 * Loads an image URL in the real renderer, draws it and tries to read a pixel back.
 *
 * `loaded` and `readable` are deliberately separate: an image can display perfectly and still taint
 * the canvas (a cross-origin response without CORS headers), and only the caller knows whether the
 * pixels matter for what it is testing.
 */
async function sampleInRenderer(window: BrowserWindow, url: string): Promise<Record<string, unknown>> {
  const script = `(async () => {
    const image = new Image()
    image.src = ${JSON.stringify(url)}
    try { await image.decode() } catch (error) { return { loaded: false, error: String(error) } }
    const canvas = document.createElement('canvas')
    canvas.width = 8
    canvas.height = 8
    const context = canvas.getContext('2d')
    if (!context) return { loaded: true, readable: false, error: 'no 2d context' }
    context.drawImage(image, 0, 0, 8, 8)
    try {
      const data = context.getImageData(0, 0, 8, 8).data
      let ink = 0
      for (let index = 3; index < data.length; index += 4) if (data[index] > 8) ink += 1
      return { loaded: true, readable: true, ink, natural: [image.naturalWidth, image.naturalHeight] }
    } catch (error) {
      return { loaded: true, readable: false, error: String(error) }
    }
  })()`
  return (await window.webContents.executeJavaScript(script)) as Record<string, unknown>
}

async function main(): Promise<void> {
  const workDir = join(tmpdir(), `aurora-smoke-${Date.now()}`)
  const coversDir = join(workDir, 'covers')
  await mkdir(coversDir, { recursive: true })

  const wavPath = join(workDir, 'smoke.wav')
  const wav = makeWav(3)
  await writeFile(wavPath, wav)
  const pagePath = join(workDir, 'index.html')
  await writeFile(pagePath, page, 'utf8')

  configureCoversDirectory(coversDir)
  authorizeAudio('smoke', wavPath)
  registerMediaProtocol()

  // 1. full response
  const full = await net.fetch('aurora-media://audio/smoke')
  const fullBody = Buffer.from(await full.arrayBuffer())
  check('full status is 200', full.status === 200, full.status)
  check('full body matches file size', fullBody.length === wav.length, `${fullBody.length} vs ${wav.length}`)
  check('content-type is audio/wav', String(full.headers.get('content-type')).includes('audio/wav'), full.headers.get('content-type'))

  // 2. range response
  const partial = await net.fetch('aurora-media://audio/smoke', { headers: { Range: 'bytes=100-199' } })
  const partialBody = Buffer.from(await partial.arrayBuffer())
  check('range status is 206', partial.status === 206, partial.status)
  check('range content-range header', partial.headers.get('content-range') === `bytes 100-199/${wav.length}`, partial.headers.get('content-range'))
  check('range body has 100 bytes', partialBody.length === 100, partialBody.length)
  check('range bytes match source', partialBody.equals(wav.subarray(100, 200)), 'byte comparison')

  // 3. unauthorized + traversal protection
  const unauthorized = await net.fetch('aurora-media://audio/not-authorized')
  check('unauthorized id is rejected', unauthorized.status === 404, unauthorized.status)
  const traversal = await net.fetch('aurora-media://cover/..%2F..%2Fpackage.json')
  check('cover traversal is rejected', traversal.status === 404, traversal.status)
  const coverTraversal = await net.fetch('aurora-media://cover/%2e%2e%5Cpackage.json')
  check('cover backslash traversal is rejected', coverTraversal.status === 404, coverTraversal.status)

  // 4. real renderer playback
  const window = new BrowserWindow({ show: false, width: 640, height: 480 })
  await window.loadFile(pagePath)
  let rendererResult: Record<string, unknown> | null = null
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      rendererResult = (await window.webContents.executeJavaScript('window.__result')) as Record<string, unknown> | null
    } catch {
      rendererResult = null
    }
    if (rendererResult) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }

  const metadata = rendererResult?.metadata as { duration?: number; error?: unknown; timeout?: boolean } | undefined
  check('renderer loaded metadata', typeof metadata?.duration === 'number' && Math.abs((metadata?.duration ?? 0) - 3) < 0.25, metadata)
  check('renderer reported playback progress', rendererResult?.playing === true, rendererResult)
  check('renderer seeked to 2s', typeof rendererResult?.seekedTo === 'number' && Math.abs((rendererResult.seekedTo as number) - 2) < 0.6, rendererResult?.seekedTo)

  /*
   * 5. covers, end to end.
   *
   * Two claims are checked here, and neither is visible from reading the code:
   *
   *  - a cover the library indexed is served with its real bytes (the name is a sha1, so this also
   *    pins the pattern a file has to match to be reachable at all); and
   *  - a local cover **and** a relayed remote one can be drawn into a canvas and read back. The
   *    immersive page derives its palette and its subject-safe crop from those pixels, and a tainted
   *    canvas fails silently — you get a placeholder gradient that looks perfectly intentional.
   */
  const coverName = `${'a'.repeat(40)}.png`
  const coverBytes = glyphPng('note', 64)
  await writeFile(join(coversDir, coverName), coverBytes)
  const coverResponse = await net.fetch(`aurora-media://cover/${coverName}`)
  const coverBody = Buffer.from(await coverResponse.arrayBuffer())
  check(
    '封面协议: 索引后的封面按原字节 + image/* 返回',
    coverResponse.status === 200 && coverBody.equals(coverBytes) && String(coverResponse.headers.get('content-type')) === 'image/png',
    { status: coverResponse.status, type: coverResponse.headers.get('content-type'), bytes: coverBody.length },
  )

  const remoteServer = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'image/png' })
    response.end(coverBytes)
  })
  await new Promise<void>((resolve) => remoteServer.listen(0, '127.0.0.1', resolve))
  const remotePort = (remoteServer.address() as AddressInfo).port
  const relayedUrl = registerRemoteMedia(`http://127.0.0.1:${remotePort}/cover.png`, 'image', 'platform:wy')
  const relayed = await net.fetch(relayedUrl)
  check(
    '远程封面中继: 真实字节被转发（在线封面不再是渲染层的破图）',
    relayed.status === 200 && Buffer.from(await relayed.arrayBuffer()).equals(coverBytes),
    { status: relayed.status, type: relayed.headers.get('content-type') },
  )

  const localCover = await sampleInRenderer(window, `aurora-media://cover/${coverName}`)
  check(
    '本地封面: 渲染层能读回真实像素（主色提取与主体裁切可用）',
    localCover.readable === true && Number(localCover.ink) > 0,
    localCover,
  )
  const remoteCover = await sampleInRenderer(window, relayedUrl)
  check(
    '远程封面: 中继后仍能读回真实像素（在线歌曲也能取到主题色）',
    remoteCover.readable === true && Number(remoteCover.ink) > 0,
    remoteCover,
  )

  window.destroy()
  await new Promise<void>((resolve) => remoteServer.close(() => resolve()))

  /*
   * 6. the OS-facing icons.
   *
   * These exist because the tray and the Windows taskbar buttons need images, and Aurora ships no
   * image assets — they are drawn and PNG-encoded at runtime. So the things worth asserting are that
   * the bytes really are a PNG at the requested size, and that Electron can decode them (a
   * plausibly-shaped buffer that `nativeImage` refuses would only show up as a missing tray icon on
   * a user's machine).
   */
  const png = glyphPng('play', 16)
  const signature = png.subarray(0, 8).toString('hex')
  check(
    'glyph: 输出真的是 PNG（签名 + IHDR 尺寸）',
    signature === '89504e470d0a1a0a' && png.readUInt32BE(16) === 16 && png.readUInt32BE(20) === 16,
    { signature, width: png.readUInt32BE(16), height: png.readUInt32BE(20) },
  )

  const decoded = nativeImage.createFromBuffer(png)
  check(
    'glyph: Electron 能解码，尺寸正确且不是全透明',
    decoded.getSize().width === 16 && decoded.getSize().height === 16 && !decoded.isEmpty(),
    { size: decoded.getSize(), empty: decoded.isEmpty() },
  )

  // A glyph that renders nothing would still pass the size check, so count opaque pixels too.
  const opaque = (() => {
    const bitmap = decoded.toBitmap()
    let count = 0
    for (let index = 3; index < bitmap.length; index += 4) if (bitmap[index] > 40) count += 1
    return count
  })()
  check('glyph: 图形真的画出来了（不透明像素数量合理）', opaque > 30 && opaque < 220, `${opaque}/256`)

  const tray = trayImage(32)
  check(
    'glyph: 托盘图标为 32px 且可由 nativeImage 解码',
    tray.getSize().width === 32 && !tray.isEmpty(),
    tray.getSize(),
  )

  // Every transport glyph must draw something: a silently empty icon is the failure mode that is
  // hardest to notice on a taskbar.
  const glyphNames = ['play', 'pause', 'next', 'previous', 'note'] as const
  const blank = glyphNames.filter((name) => {
    const image = glyphImage(name, 16)
    const bitmap = image.toBitmap()
    let count = 0
    for (let index = 3; index < bitmap.length; index += 4) if (bitmap[index] > 40) count += 1
    return count < 20
  })
  check('glyph: 五个图标（播放/暂停/上下一首/音符）都画出了内容', blank.length === 0, blank)

  const failed = checks.filter((item) => !item.ok)
  for (const item of checks) {
    console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}  ${JSON.stringify(item.detail)}`)
  }
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
  app.exit(failed.length === 0 ? 0 : 1)
}

void app.whenReady().then(main)
