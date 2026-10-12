/*
 * Assemble the Capacitor web root (www/) from a built desktop renderer:
 *
 *   node scripts/prepare-www.mjs <rendererDistDir> <seedsDir>
 *
 * - copies the renderer build into www/
 * - generates www/aurora-seeds.js from the seed JSON files (desktop defaults
 *   captured from the real app: settings + platform descriptors + app info)
 * - bundles are expected at www-build/aurora-shim.js (npm run build:shim) and
 *   copied to www/aurora-shim.js
 * - injects both scripts into index.html ahead of the app bundle, so
 *   window.aurora exists before the renderer boots.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const [, , rendererDistArg, seedsDirArg] = process.argv
if (!rendererDistArg || !seedsDirArg) {
  console.error('usage: node scripts/prepare-www.mjs <rendererDistDir> <seedsDir>')
  process.exit(1)
}
const rendererDist = resolve(rendererDistArg)
const seedsDir = resolve(seedsDirArg)
const shellRoot = resolve(new URL('..', import.meta.url).pathname)
const www = join(shellRoot, 'www')

if (!existsSync(join(rendererDist, 'index.html'))) {
  console.error(`renderer build not found at ${rendererDist} (no index.html)`)
  process.exit(1)
}
const shimBundle = join(shellRoot, 'www-build', 'aurora-shim.js')
if (!existsSync(shimBundle)) {
  console.error('shim bundle missing — run `npm run build:shim` first')
  process.exit(1)
}

rmSync(www, { recursive: true, force: true })
mkdirSync(www, { recursive: true })
cpSync(rendererDist, www, { recursive: true })
cpSync(shimBundle, join(www, 'aurora-shim.js'))

const readSeed = (name) => {
  const p = join(seedsDir, name)
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : undefined
}
const seeds = {
  settings: readSeed('settings.json'),
  platforms: readSeed('platforms.json'),
  appInfo: readSeed('appInfo.json'),
}
writeFileSync(join(www, 'aurora-seeds.js'), `window.__AURORA_SEEDS__ = ${JSON.stringify(seeds)};\n`)

const indexPath = join(www, 'index.html')
let html = readFileSync(indexPath, 'utf8')
const injection = '<script src="./aurora-seeds.js"></script><script src="./aurora-shim.js"></script>'
if (html.includes('aurora-shim.js')) {
  console.log('index.html already injected, skipping')
} else if (html.includes('</head>')) {
  html = html.replace('</head>', `${injection}</head>`)
  writeFileSync(indexPath, html)
  console.log('injected shim scripts into index.html')
} else {
  console.error('index.html has no </head> to inject into')
  process.exit(1)
}
console.log(`www/ assembled from ${rendererDist}`)
