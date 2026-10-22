/**
 * Verifies that Electron can dynamically import an ESM module living inside an .asar archive.
 *
 * This matters because the packaged main process loads music-metadata parser chunks with
 * `import()`. If asar + ESM dynamic import is unsupported in this Electron version, metadata
 * parsing would silently degrade to filename-only metadata in production builds.
 *
 * Run with: npx electron tools/asar-esm-check.mjs
 */
import { app } from 'electron'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import asar from '@electron/asar'

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'aurora-asar-'))
  const sourceDir = join(root, 'src')
  const archive = join(root, 'app.asar')
  await mkdir(sourceDir, { recursive: true })
  await writeFile(join(sourceDir, 'esm-sample.mjs'), "export const value = 'asar-esm-ok'\n", 'utf8')
  await asar.createPackage(sourceDir, archive)

  const checks = []
  try {
    const module = await import(pathToFileURL(join(archive, 'esm-sample.mjs')).href)
    checks.push({ name: 'asar 内 ESM 动态 import', ok: module.value === 'asar-esm-ok', detail: module.value })
  } catch (error) {
    checks.push({ name: 'asar 内 ESM 动态 import', ok: false, detail: String(error) })
  }

  // The real dependency the packaged app relies on.
  try {
    const musicMetadata = await import('music-metadata')
    checks.push({
      name: 'music-metadata 可加载',
      ok: typeof musicMetadata.parseFile === 'function',
      detail: typeof musicMetadata.parseFile,
    })
  } catch (error) {
    checks.push({ name: 'music-metadata 可加载', ok: false, detail: String(error) })
  }

  for (const check of checks) console.log(`${check.ok ? 'PASS' : 'FAIL'}  ${check.name}  ${check.detail}`)
  // Temp cleanup is best effort; a Windows ENOTEMPTY race must not fail the test.
  try {
    await rm(root, { recursive: true, force: true, maxRetries: 3 })
  } catch {
    // ignore
  }
  app.exit(checks.every((check) => check.ok) ? 0 : 1)
}

app.whenReady().then(main).catch((error) => {
  console.log(`FAIL  测试执行异常  ${String(error)}`)
  app.exit(1)
})
