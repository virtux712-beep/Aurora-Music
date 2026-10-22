/**
 * Proves that a built Windows executable really carries Aurora's icon, by reading the PE resource
 * directory instead of trusting `build succeeded`.
 *
 * electron-builder writes icons through rcedit, which lives in a cache it unpacks from a 7z. On this
 * machine that unpack always reports errors (the archive's macOS dylibs are symbolic links and
 * creating links needs admin rights), so "the build printed no error" is not evidence the icon made
 * it into the exe. This checks the bytes.
 *
 *   node tools/check-icon.mjs [exe ...]
 *
 * With no arguments it inspects the three shipped artifacts. Exits non-zero when any of them is
 * missing the icon, *or when the icon it carries is not the one in `build/icon.ico`* — the second
 * check is what catches a packaging step that was skipped after the art changed, so it can gate a
 * release.
 */
import { readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

const DEFAULT_TARGETS = [
  join('release', 'win-unpacked', 'Aurora Music.exe'),
  'release/Aurora-Music-Portable-0.1.0-x64.exe',
  'release/Aurora-Music-Setup-0.1.0-x64.exe',
]

const RT_ICON = 3
const RT_GROUP_ICON = 14
const RT_VERSION = 16

/** Reads a PE image: sections (to map RVA → file offset) and the resource directory. */
function readPe(buffer) {
  if (buffer.readUInt16LE(0) !== 0x5a4d) throw new Error('not a PE file (no MZ signature)')
  const peOffset = buffer.readUInt32LE(0x3c)
  if (buffer.toString('ascii', peOffset, peOffset + 4) !== 'PE\u0000\u0000') throw new Error('no PE signature')

  const numberOfSections = buffer.readUInt16LE(peOffset + 6)
  const sizeOfOptionalHeader = buffer.readUInt16LE(peOffset + 20)
  const optionalOffset = peOffset + 24
  const magic = buffer.readUInt16LE(optionalOffset)
  const is64 = magic === 0x20b
  if (!is64 && magic !== 0x10b) throw new Error(`unknown optional header magic 0x${magic.toString(16)}`)
  // Data directories sit after the fixed part of the optional header, which differs between PE32/PE32+.
  const dataDirectoryOffset = optionalOffset + (is64 ? 112 : 96)

  const sections = []
  const sectionOffset = optionalOffset + sizeOfOptionalHeader
  for (let index = 0; index < numberOfSections; index += 1) {
    const at = sectionOffset + index * 40
    sections.push({
      name: buffer.toString('ascii', at, at + 8).replace(/\u0000+$/, ''),
      virtualSize: buffer.readUInt32LE(at + 8),
      virtualAddress: buffer.readUInt32LE(at + 12),
      rawSize: buffer.readUInt32LE(at + 16),
      rawPointer: buffer.readUInt32LE(at + 20),
    })
  }

  const resourceRva = buffer.readUInt32LE(dataDirectoryOffset + 2 * 8)
  const resourceSize = buffer.readUInt32LE(dataDirectoryOffset + 2 * 8 + 4)
  if (resourceRva === 0) return { sections, resourceBase: 0, resourceSize: 0 }
  return { sections, resourceBase: rvaToOffset(sections, resourceRva), resourceSize }
}

function rvaToOffset(sections, rva) {
  for (const section of sections) {
    const span = Math.max(section.virtualSize, section.rawSize)
    if (rva >= section.virtualAddress && rva < section.virtualAddress + span) {
      return section.rawPointer + (rva - section.virtualAddress)
    }
  }
  throw new Error(`rva 0x${rva.toString(16)} is not inside any section`)
}

/** Walks one level of IMAGE_RESOURCE_DIRECTORY. */
function readDirectory(buffer, base, offset) {
  const at = base + offset
  const named = buffer.readUInt16LE(at + 12)
  const ids = buffer.readUInt16LE(at + 14)
  const entries = []
  for (let index = 0; index < named + ids; index += 1) {
    const entryAt = at + 16 + index * 8
    const nameOrId = buffer.readUInt32LE(entryAt)
    const dataOrSub = buffer.readUInt32LE(entryAt + 4)
    entries.push({
      id: nameOrId & 0x80000000 ? null : nameOrId, // high bit set means the name is a string
      isDirectory: Boolean(dataOrSub & 0x80000000),
      offset: dataOrSub & 0x7fffffff,
    })
  }
  return entries
}

/** Returns every resource of `type`, as `{ id, bytes }` (the leaf data chunk). */
function readResources(buffer, pe, type) {
  if (!pe.resourceBase) return []
  const found = []
  for (const typeEntry of readDirectory(buffer, pe.resourceBase, 0)) {
    if (typeEntry.id !== type || !typeEntry.isDirectory) continue
    for (const nameEntry of readDirectory(buffer, pe.resourceBase, typeEntry.offset)) {
      if (!nameEntry.isDirectory) continue
      for (const langEntry of readDirectory(buffer, pe.resourceBase, nameEntry.offset)) {
        if (langEntry.isDirectory) continue
        // Third level points at IMAGE_RESOURCE_DATA_ENTRY: { RVA, size, codepage, reserved }.
        const entryAt = pe.resourceBase + langEntry.offset
        const dataRva = buffer.readUInt32LE(entryAt)
        const size = buffer.readUInt32LE(entryAt + 4)
        const start = rvaToOffset(pe.sections, dataRva)
        found.push({ id: nameEntry.id, bytes: buffer.subarray(start, start + size) })
      }
    }
  }
  return found
}

/** Numbers in a GRPICONDIR: 0 means 256, matching the icon format's per-entry convention. */
function groupIconSizes(group) {
  const count = group.readUInt16LE(4)
  const sizes = []
  for (let index = 0; index < count; index += 1) {
    const at = 6 + index * 14
    sizes.push({ width: group[at] || 256, height: group[at + 1] || 256, bits: group.readUInt16LE(at + 6) })
  }
  return sizes
}

/** True when any UTF-16LE string in `data` contains `needle`. */
function hasUtf16(data, needle) {
  return data.includes(Buffer.from(needle, 'utf16le'))
}

/**
 * The frames of `build/icon.ico`, as `{ size, bytes }`.
 *
 * Used to answer the question "is the icon in this exe the icon I just generated?" rather than the
 * much weaker "does this exe have *an* icon?". Both are stored as uncompressed DIBs, so an exact
 * byte match is a valid comparison and needs no re-encoding.
 */
function readIcoFrames(path) {
  const buffer = readFileSync(path)
  if (buffer.readUInt16LE(0) !== 0 || buffer.readUInt16LE(2) !== 1) return []
  const count = buffer.readUInt16LE(4)
  const frames = []
  for (let index = 0; index < count; index += 1) {
    const at = 6 + index * 16
    const size = buffer[at] || 256
    const length = buffer.readUInt32LE(at + 8)
    const offset = buffer.readUInt32LE(at + 12)
    frames.push({ size, bytes: buffer.subarray(offset, offset + length) })
  }
  return frames
}

const referenceIcon = join('build', 'icon.ico')
let referenceFrames = []
try {
  referenceFrames = readIcoFrames(referenceIcon)
} catch {
  console.log(`\nnote: ${referenceIcon} not readable, skipping the byte-for-byte comparison`)
}

let failures = 0
const targets = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_TARGETS

for (const target of targets) {
  const label = basename(target)
  try {
    statSync(target)
  } catch {
    console.log(`\n${label}\n  MISSING  ${target}`)
    failures += 1
    continue
  }

  const buffer = readFileSync(target)
  const pe = readPe(buffer)
  const icons = readResources(buffer, pe, RT_ICON)
  const groups = readResources(buffer, pe, RT_GROUP_ICON)
  const versions = readResources(buffer, pe, RT_VERSION)

  const sizes = groups.flatMap((group) => groupIconSizes(group.bytes))
  const hasLarge = sizes.some((entry) => entry.width >= 256)
  const productNamed = versions.length > 0 && hasUtf16(versions[0].bytes, 'Aurora Music')
  // Every reference frame has to appear inside the exe, byte for byte. A stale build is the failure
  // this catches: the icon file is regenerated in the repo, the packaging step is skipped, and the
  // shipped exe keeps yesterday's art with nobody the wiser.
  const embedded = icons.map((icon) => icon.bytes)
  const matched = referenceFrames.filter((frame) => embedded.some((bytes) => bytes.equals(frame.bytes)))
  const iconIsCurrent = referenceFrames.length > 0 && matched.length === referenceFrames.length

  console.log(`\n${label}  (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`)
  console.log(`  RT_GROUP_ICON  ${groups.length} group(s), ${icons.length} RT_ICON image(s)`)
  console.log(`  icon sizes     ${sizes.length ? [...new Set(sizes.map((s) => s.width))].join(' / ') : 'none'}`)
  console.log(`  256px entry    ${hasLarge ? 'yes' : 'NO - Windows will upscale the taskbar icon'}`)
  console.log(`  version info   ${versions.length ? (productNamed ? 'ProductName = "Aurora Music"' : 'present, ProductName missing') : 'absent'}`)
  if (referenceFrames.length > 0) {
    const stale = referenceFrames.filter((frame) => !matched.includes(frame))
    console.log(
      `  matches ${referenceIcon}  ${
        iconIsCurrent
          ? `yes — all ${referenceFrames.length} frames byte-identical`
          : `NO - ${stale.length} frame(s) differ: ${stale.map((frame) => frame.size + 'px').join(' / ')}`
      }`,
    )
  }

  if (!groups.length || !icons.length || !hasLarge || !productNamed || !iconIsCurrent) failures += 1
}

console.log(
  failures === 0
    ? '\nRESULT: PASS - every target carries the icon and version info.'
    : `\nRESULT: FAIL - ${failures} target(s) are missing the icon or version info.`,
)
process.exit(failures === 0 ? 0 : 1)
