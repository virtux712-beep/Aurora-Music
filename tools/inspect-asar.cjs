/** Prints a summary of what the packaged app.asar contains. Run: node tools/inspect-asar.cjs */
const asar = require('@electron/asar')

const archive = 'release/win-unpacked/resources/app.asar'
const entries = asar.listPackage(archive).map((entry) => entry.replace(/\\/g, '/').replace(/^\//, ''))

const count = (prefix) => entries.filter((entry) => entry.startsWith(prefix)).length
const topLevelPackages = new Set(
  entries.filter((entry) => entry.startsWith('node_modules/')).map((entry) => entry.split('/')[1]),
)

console.log('asar 总条目:', entries.length)
console.log('package.json:', count('package.json'))
console.log('out/main:', entries.filter((entry) => entry.startsWith('out/main')).join(', '))
console.log('out/preload:', entries.filter((entry) => entry.startsWith('out/preload')).join(', '))
console.log('out/renderer/index.html:', count('out/renderer/index.html'))
console.log('out/renderer/assets:', count('out/renderer/assets'), '个懒加载 chunk')
console.log('生产依赖包数:', topLevelPackages.size)
console.log('含 music-metadata:', count('node_modules/music-metadata') > 0)
console.log('包含意外内容(源码/tools/out smoke):', entries.filter((e) => e.startsWith('src/') || e.startsWith('tools/') || e.startsWith('out/smoke')).length)
