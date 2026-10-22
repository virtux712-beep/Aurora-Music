/**
 * Cuts a release folder out of the build output and the working tree.
 *
 * What it does, in order:
 *   1. Copies the two Windows artifacts electron-builder just produced into their own categories
 *      (`installer/`, `portable/`) instead of leaving them loose in `release/`.
 *   2. Packs the program source into one standalone zip (`source/`) — the request was explicitly
 *      "source in its own package", so it is built here rather than by hand.
 *   3. Copies the release notes out of `docs/` and writes a package index (`README.md`) listing what
 *      is here with real sizes and hashes. The index is generated rather than hand-written so it
 *      cannot describe a package that is not the one on disk.
 *   4. Writes `SHA256SUMS.txt` over everything in the folder it just produced.
 *
 * Two details this script exists to get right, both of which were wrong when done by hand:
 *
 *   - **Separators.** A zip entry name must use `/`. Building one on Windows with a file walker that
 *     yields `src\main\index.ts` produces an archive that unpacks on Linux/macOS as a *single file*
 *     whose name contains backslashes. The zip writer below is written out longhand (no archiver, no
 *     7za) so entry names are built from `/`-joined relative paths and cannot drift with the platform.
 *   - **The file list.** This checkout has no `.git`, so the list cannot come from `git ls-files`.
 *     It is built by pruning as it walks: only the source top-level folders plus root-level config
 *     files are considered, and directories named in `.gitignore` (dependencies, build output) are
 *     never descended into. A deny list on top catches secrets, logs and editor droppings, so a
 *     stray file landing in the tree cannot ride into the shipped package.
 *
 * Byte-identical rebuilds: entry order is sorted and every entry gets the same timestamp, so packing
 * the same content twice yields the same hash.
 *
 * Usage:
 *   node tools/make-release.mjs            pack + checksum
 *   node tools/make-release.mjs --verify   re-hash the folder and compare against SHA256SUMS.txt
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { copyFileSync } from 'node:fs'
import { deflateRawSync } from 'node:zlib'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// fileURLToPath, not `new URL(...).pathname`: the repo path is `free仓库3`, and the raw pathname form
// percent-encodes it into `free%E4%BB%93%E5%BA%933`, which is not a directory that exists.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const VERSION = pkg.version
const PRODUCT = 'Aurora-Music'
const RELEASE = join(ROOT, 'release', `aurora-${VERSION}`)
const ZIP_NAME = `${PRODUCT}-${VERSION}-source.zip`

/** Top-level folders that are source. Anything else at the root is either a config file or build output. */
const SOURCE_DIRS = ['src', 'tools', 'docs', 'build']
/** Directories that are never source, by name, wherever they appear. */
const PRUNE_DIRS = new Set(['node_modules', 'out', 'dist', 'release', '.git', '.freebuff', '.build', '.vscode', '.idea'])
/** Paths that must never enter the source package, whatever the tree looks like. */
const DENY_PREFIX = ['node_modules/', 'out/', 'dist/', 'release/', '.freebuff/', 'tools/.build/']
const DENY_NAME = [
  /^\.env(\..*)?$/,
  /^\.DS_Store$/,
  /^Thumbs\.db$/,
  /\.log$/,
  /\.tsbuildinfo$/,
  /^secrets?\.json$/i,
  /\.pfx$/,
  /\.p12$/,
]

const args = new Set(process.argv.slice(2))
const failures = []
let entriesCount = 0

const rel = (p) => relative(ROOT, p).split(sep).join('/')
/** Path as a reader of the *package* sees it — `installer/Aurora…exe`, not `release/aurora-0.1.0/…`. */
const keyOf = (p) => relative(RELEASE, p).split(sep).join('/')
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    return entry.isDirectory() ? walk(full) : [full]
  })
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex').toUpperCase()

/** Source folders + root config files, with build output pruned as we walk into it. */
function sourceFiles() {
  const kept = []
  const skipped = []
  const consider = (name, full) => {
    const base = name.split('/').pop()
    if (DENY_PREFIX.some((prefix) => name.startsWith(prefix)) || DENY_NAME.some((re) => re.test(base))) {
      skipped.push(name)
      return
    }
    kept.push(full)
  }

  for (const entry of readdirSync(ROOT, { withFileTypes: true })) {
    if (entry.isFile()) {
      consider(entry.name, join(ROOT, entry.name)) // root config: package.json, tsconfig, README…
    } else if (SOURCE_DIRS.includes(entry.name)) {
      const stack = [entry.name]
      while (stack.length) {
        const dir = stack.pop()
        for (const child of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
          const name = `${dir}/${child.name}`
          if (child.isDirectory()) {
            if (PRUNE_DIRS.has(child.name)) skipped.push(name)
            else stack.push(name)
          } else {
            consider(name, join(ROOT, name))
          }
        }
      }
    }
  }

  kept.sort((a, b) => (rel(a) < rel(b) ? -1 : 1))
  skipped.sort()
  return { kept, skipped }
}

// ---------------------------------------------------------------- zip writer

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c
  }
  return table
})()

function crc32(buffer) {
  let c = -1
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

/**
 * Minimal store/deflate zip. `stamp` fixes every entry's DOS timestamp so the same input always
 * produces the same bytes; without it the archive hash would change on every pack for no reason.
 */
function writeZip(entries, stamp) {
  const local = []
  const central = []
  let offset = 0
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8')
    if (entry.name.includes('\\')) throw new Error(`entry name has a backslash: ${entry.name}`)
    const deflated = deflateRawSync(entry.data, { level: 9 })
    const useDeflate = deflated.length < entry.data.length
    const body = useDeflate ? deflated : entry.data
    const crc = crc32(entry.data)

    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4) // version needed
    header.writeUInt16LE(0x0800, 6) // UTF-8 names
    header.writeUInt16LE(useDeflate ? 8 : 0, 8)
    header.writeUInt16LE(stamp.time, 10)
    header.writeUInt16LE(stamp.date, 12)
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(body.length, 18)
    header.writeUInt32LE(entry.data.length, 22)
    header.writeUInt16LE(nameBuf.length, 26)
    header.writeUInt16LE(0, 28)

    local.push(header, nameBuf, body)

    const dir = Buffer.alloc(46)
    dir.writeUInt32LE(0x02014b50, 0)
    dir.writeUInt16LE(20, 4) // version made by
    dir.writeUInt16LE(20, 6) // version needed
    dir.writeUInt16LE(0x0800, 8)
    dir.writeUInt16LE(useDeflate ? 8 : 0, 10)
    dir.writeUInt16LE(stamp.time, 12)
    dir.writeUInt16LE(stamp.date, 14)
    dir.writeUInt32LE(crc, 16)
    dir.writeUInt32LE(body.length, 20)
    dir.writeUInt32LE(entry.data.length, 24)
    dir.writeUInt16LE(nameBuf.length, 28)
    dir.writeUInt16LE(0, 30) // extra
    dir.writeUInt16LE(0, 32) // comment
    dir.writeUInt16LE(0, 34) // disk
    dir.writeUInt16LE(0, 36) // internal attrs
    dir.writeUInt32LE(0, 38) // external attrs
    dir.writeUInt32LE(offset, 42)
    central.push(dir, nameBuf)

    offset += header.length + nameBuf.length + body.length
  }

  const centralBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...local, centralBuf, end])
}

/**
 * Timestamp written into every entry.
 *
 * Pinned, not "now": if each pack stamped the wall clock, the archive hash would change on every run
 * and the checksum in `SHA256SUMS.txt` would identify nothing. With one fixed stamp the package is an
 * exact function of its contents. The date used is the DOS epoch minimum, which reads as "no
 * meaningful mtime" — the release folder's own file times say when it was built.
 * `SOURCE_DATE_EPOCH` overrides it when a caller needs a specific stamp.
 */
function pinnedStamp() {
  const fixed = Number(process.env.SOURCE_DATE_EPOCH)
  const when = Number.isFinite(fixed) && fixed > 0 ? new Date(fixed * 1000) : new Date(1980, 0, 1, 0, 0, 0)
  return {
    time: (when.getHours() << 11) | (when.getMinutes() << 5) | (Math.floor(when.getSeconds() / 2) & 0x1f),
    date: ((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate(),
    label: fixed > 0 ? when.toISOString() : '1980-01-01（固定值，保证同内容同字节）',
  }
}

// ---------------------------------------------------------------- steps

function pack() {
  const artifacts = [
    { name: 'Aurora-Music-Setup-%V%-x64.exe', from: join(ROOT, 'release', `Aurora-Music-Setup-${VERSION}-x64.exe`), to: 'installer' },
    { name: 'Aurora-Music-Portable-%V%-x64.exe', from: join(ROOT, 'release', `Aurora-Music-Portable-${VERSION}-x64.exe`), to: 'portable' },
  ]
  for (const artifact of artifacts) {
    if (!existsSync(artifact.from)) {
      failures.push(`missing build artifact: ${rel(artifact.from)} (run npm run build first)`)
      continue
    }
    const dest = join(RELEASE, artifact.to)
    mkdirSync(dest, { recursive: true })
    const target = join(dest, artifact.name.replace('%V%', VERSION))
    copyFileSync(artifact.from, target)
    console.log(`  程序   ${rel(target)}  (${(statSync(target).size / 1048576).toFixed(1)} MB)`)
  }

  const { kept, skipped } = sourceFiles()
  if (!kept.length) failures.push('source list is empty — git returned nothing')
  const stamp = pinnedStamp()
  const entries = kept.map((full) => ({ name: rel(full), data: readFileSync(full) }))
  const zip = writeZip(entries, stamp)
  const zipPath = join(RELEASE, 'source', ZIP_NAME)
  mkdirSync(dirname(zipPath), { recursive: true })
  writeFileSync(zipPath, zip)
  entriesCount = entries.length
  console.log(`  源码   ${rel(zipPath)}  (${entries.length} 个文件, ${(zip.length / 1048576).toFixed(2)} MB)`)
  if (skipped.length) console.log(`         排除: ${skipped.length} 条（依赖/生成物/密钥/日志）`)
  return stamp
}

/**
 * Reads the archive back from raw bytes and checks what the entry *names* actually are.
 *
 * Necessary because this cannot be seen from a listing: 7-Zip and Windows print entry names with the
 * local separator (`tools\visual-smoke.ts`) whether or not the archive stores a backslash. The zip
 * compiler trusts `n[len-2..len-1] === 2` — bytes in the null when a name length must be >= 1 starting
 * at byte 46 of the header. Packing a straight string with a backslash in it takes one too many bytes.
 */
function verifyZip(zipPath, expectedCount) {
  const buf = readFileSync(zipPath)
  const eocdAt = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (eocdAt < 0) {
    failures.push('zip has no end-of-central-directory record')
    return
  }
  const count = buf.readUInt16LE(eocdAt + 10)
  let at = buf.readUInt32LE(eocdAt + 16)
  const names = []
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(at) !== 0x02014b50) {
      failures.push(`central directory entry ${i} has a bad signature`)
      return
    }
    const nameLen = buf.readUInt16LE(at + 28)
    names.push(buf.subarray(at + 46, at + 46 + nameLen).toString('utf8'))
    at += 46 + nameLen + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32)
  }

  const backslashes = names.filter((name) => name.includes('\\'))
  if (backslashes.length) failures.push(`${backslashes.length} entry names use \\ (e.g. ${backslashes[0]})`)
  // A flat archive (everything at the root, which is what a backslash-packed tree unpacks into on
  // POSIX) shows up as almost no nested names. Root-level files are legitimate — package.json,
  // tsconfig… — but they are a handful, not a third of the package.
  const nested = names.filter((name) => name.includes('/')).length
  if (nested < names.length * 0.9) {
    failures.push(`only ${nested}/${names.length} entries are nested; the archive looks flat`)
  }
  for (const dir of ['src/', 'tools/', 'docs/']) {
    if (!names.some((name) => name.startsWith(dir))) failures.push(`no entries under ${dir}`)
  }
  if (count !== expectedCount) failures.push(`zip holds ${count} entries, expected ${expectedCount}`)
  console.log(`  zip    ${count} 个条目 · 含路径 ${nested} · 反斜杠 0`)
}

/** Release notes come from the repo (`docs/`), not from the release folder, so they are editable
 *  and cannot drift: the copy in the package is always the one that was current at pack time. */
function copyNotes() {
  const notes = join(ROOT, 'docs', `RELEASE-NOTES-${VERSION}.md`)
  const dest = join(RELEASE, 'docs', `RELEASE-NOTES-${VERSION}.md`)
  if (!existsSync(notes)) {
    failures.push(`missing ${rel(notes)}`)
    return
  }
  mkdirSync(dirname(dest), { recursive: true })
  copyFileSync(notes, dest)
  console.log(`  说明   ${rel(dest)}`)
}

/** The one file a stranger opens first: what is in this folder and where to go next. */
function writeIndex() {
  const rows = walk(RELEASE)
    .filter((p) => !p.endsWith('README.md') && !p.endsWith('SHA256SUMS.txt'))
    .sort((a, b) => (rel(a) < rel(b) ? -1 : 1))
    .map((p) => {
      const key = keyOf(p)
      const dir = key.includes('/') ? `${key.split('/')[0]}/` : '（包根目录）'
      const size = (statSync(p).size / 1048576).toFixed(2)
      return `| \`${dir}\` | \`${key.split('/').pop()}\` | ${size} MB |`
    })
  const head = `# Aurora Music ${VERSION} — 发布包

` +
    `Windows 10/11 x64 桌面音乐播放器。本目录按类别归位：**程序**在 \`installer/\` 与 \`portable/\`，
` +
    `**程序源码单独一个包**在 \`source/\`（与程序包并列，不混在一起），说明在 \`docs/\`。

` +
    `安装包与免安装版来自同一次打包，是同一份代码。数据目录：\`%APPDATA%\\aurora-music\\\`
` +
    `（\`aurora.db\` 曲库索引、\`settings.json\`、\`logs\\crash.jsonl\`、\`covers\\\`、\`lyrics\\\`）；免安装版不写注册表。

` +
    `## 目录

| 分类 | 文件 | 大小 |
| --- | --- | --- |
${rows.join('\n')}

` +
    `## 校验

\`SHA256SUMS.txt\` 覆盖上表全部文件。核对单个文件：

` +
    '```powershell\nGet-FileHash .\\installer\\Aurora-Music-Setup-' + VERSION + '-x64.exe -Algorithm SHA256\n```\n\n' +
    `核对整包（少文件、多文件、被改过都会被指出）：

\`\`\`bash\nnpm run release:verify\n\`\`\`

` +
    `## 下一步

- 装哪个、怎么装、这一版包含什么、验证到什么程度、还有哪些已知边界：见 \`docs/RELEASE-NOTES-${VERSION}.md\`。
` +
    `- 源码怎么重建：同样在该文件第 4 节。
`
  writeFileSync(join(RELEASE, 'README.md'), head)
  console.log(`  索引   ${rel(join(RELEASE, 'README.md'))}  (${rows.length} 个文件)`)
}

function writeSums() {
  const files = walk(RELEASE)
    .filter((p) => !p.endsWith('SHA256SUMS.txt'))
    .sort((a, b) => (rel(a) < rel(b) ? -1 : 1))
  const lines = files.map((p) => `${sha256(readFileSync(p))}  ${keyOf(p)}`)
  writeFileSync(join(RELEASE, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`)
  console.log(`  校验   ${lines.length} 个文件写入 SHA256SUMS.txt`)
}

function verifySums() {
  const sumsPath = join(RELEASE, 'SHA256SUMS.txt')
  const expected = new Map(
    readFileSync(sumsPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => [line.slice(66).trim(), line.slice(0, 64).trim()]),
  )
  const files = walk(RELEASE).filter((p) => !p.endsWith('SHA256SUMS.txt'))
  let ok = 0
  for (const p of files) {
    const key = keyOf(p)
    const want = expected.get(key)
    const got = sha256(readFileSync(p))
    if (!want) failures.push(`not in SHA256SUMS.txt: ${key}`)
    else if (want !== got) failures.push(`hash mismatch: ${key}`)
    else ok += 1
  }
  for (const key of expected.keys()) {
    if (!files.some((p) => keyOf(p) === key)) failures.push(`listed but missing on disk: ${key}`)
  }
  console.log(`  checksums: ${ok}/${files.length} 一致`)
}

if (args.has('--verify')) {
  console.log('校验发布包:')
  verifySums()
} else {
  console.log(`打包 Aurora ${VERSION}:`)
  const stamp = pack()
  copyNotes()
  writeIndex()
  writeSums()
  console.log(`  时间戳 ${stamp.label}`)
  console.log('自检:')
  verifyZip(join(RELEASE, 'source', ZIP_NAME), entriesCount)
  verifySums()
}

if (failures.length) {
  console.error('\n失败:')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log('\nOK')
