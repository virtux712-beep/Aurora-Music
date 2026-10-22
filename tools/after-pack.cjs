/**
 * Stamps Aurora's icon and version info into the packaged executable.
 *
 * Why this exists instead of the normal `win.signAndEditExecutable: true`:
 * electron-builder edits the exe with `rcedit`, which it unpacks from the `winCodeSign` archive.
 * That archive contains macOS dylibs stored as symbolic links, and creating symlinks on Windows
 * needs either admin rights or Developer Mode, so the unpack always reports two errors and
 * electron-builder treats the whole build as failed. With the option left off, the exe keeps
 * Electron's default icon, which is what shipped before.
 *
 * So the edit happens here instead: after electron-builder has produced the app directory (and
 * before the NSIS/portable targets are built from it), rcedit — already present in the
 * electron-builder cache, or extracted from the cached archive without the macOS folder — is run on
 * the exe. Everything stays reproducible: `node tools/make-icon.mjs` regenerates the icon, this hook
 * applies it, `node tools/check-icon.mjs` proves it landed.
 */
const { execFileSync } = require('node:child_process')
const { existsSync, mkdirSync, readdirSync, statSync } = require('node:fs')
const { join } = require('node:path')

const CACHE = join(process.env.LOCALAPPDATA || join(require('node:os').homedir(), 'AppData', 'Local'), 'electron-builder', 'Cache', 'winCodeSign')

/** Newest `rcedit-<arch>.exe` already unpacked in the electron-builder cache, if any. */
function cachedRcedit(arch) {
  if (!existsSync(CACHE)) return null
  const candidates = readdirSync(CACHE)
    .map((name) => join(CACHE, name, `rcedit-${arch}.exe`))
    .filter((path) => existsSync(path))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  return candidates[0] ?? null
}

/**
 * Falls back to pulling just rcedit out of a cached `winCodeSign` archive. Passing the two file
 * names explicitly keeps 7-Zip away from the `darwin` folder, which is the part that fails.
 */
function extractRcedit(arch, projectDir) {
  if (!existsSync(CACHE)) return null
  const archives = readdirSync(CACHE).filter((name) => name.endsWith('.7z'))
  if (archives.length === 0) return null
  const sevenZip = join(projectDir, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe')
  if (!existsSync(sevenZip)) return null

  const target = join(CACHE, 'rcedit-extracted')
  mkdirSync(target, { recursive: true })
  for (const archive of archives) {
    try {
      execFileSync(sevenZip, ['x', '-y', '-bd', join(CACHE, archive), `-o${target}`, 'rcedit-ia32.exe', 'rcedit-x64.exe'], {
        stdio: 'ignore',
      })
    } catch {
      continue // A partially written archive from an earlier failed run; try the next one.
    }
    const path = join(target, `rcedit-${arch}.exe`)
    if (existsSync(path)) return path
  }
  return null
}

/**
 * Exported both as `module.exports` and as `.default`: electron-builder resolves hooks through the
 * same loader it uses for ESM config files, and which of the two shapes it reads has changed between
 * versions. Providing both keeps this working either way.
 */
async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return

  const projectDir = context.packager.info.projectDir
  const { productFilename, productName, version, companyName } = context.packager.appInfo
  const exe = join(context.appOutDir, `${productFilename}.exe`)
  const icon = join(context.packager.info.buildResourcesDir, 'icon.ico')

  if (!existsSync(exe)) throw new Error(`after-pack: packaged executable not found at ${exe}`)
  if (!existsSync(icon)) throw new Error(`after-pack: icon not found at ${icon} — run "node tools/make-icon.mjs"`)

  // Electron's Arch enum: 0 = ia32, 1 = x64, 3 = arm64. Getting this backwards still "works"
  // (rcedit edits either bitness) but means shipping the wrong helper, so map it explicitly.
  const arch = { 0: 'ia32', 1: 'x64' }[context.arch] ?? 'x64'
  const rcedit = cachedRcedit(arch) ?? extractRcedit(arch, projectDir)
  if (!rcedit) {
    throw new Error(
      'after-pack: rcedit is unavailable. It normally lives in the electron-builder cache ' +
        `(${CACHE}) as part of the winCodeSign package; delete that folder and rebuild to re-download it.`,
    )
  }

  const args = [
    exe,
    '--set-icon', icon,
    '--set-version-string', 'ProductName', productName,
    '--set-version-string', 'FileDescription', productName,
    '--set-version-string', 'CompanyName', companyName || productName,
    '--set-version-string', 'InternalName', productFilename,
    '--set-version-string', 'OriginalFilename', `${productFilename}.exe`,
    '--set-file-version', version,
    '--set-product-version', version,
  ]
  execFileSync(rcedit, args, { stdio: 'inherit' })
  console.log(`  • icon + version info applied to ${productFilename}.exe (${arch})`)
}

module.exports = afterPack
module.exports.default = afterPack
