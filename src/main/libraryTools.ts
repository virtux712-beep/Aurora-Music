/**
 * Local-file administration: ID3 rewriting and format conversion.
 *
 * Both operations touch the user's real files, so the rules here are conservative:
 *
 *  - **Tag writing is MP3-only.** Prepending an ID3v2 header to a FLAC or an MP4 corrupts it, and
 *    the whole point of this feature is to leave a working music file behind. Non-MP3 files are
 *    rejected with a clear reason instead of being mangled.
 *  - **Writes are atomic at the filesystem level**: the tagged bytes go to a sibling `.tmp` file
 *    which then replaces the original. A crash mid-write cannot truncate the user's music.
 *  - **Conversion is opt-in and honest about its dependency.** Encoding audio needs an encoder;
 *    Aurora ships none. If `ffmpeg` is not on this machine (or `AURORA_FFMPEG_PATH` does not point
 *    at one), the call fails with `ffmpegMissing: true` and the UI says so — rather than pretending
 *    the feature exists.
 */

import { spawn } from 'node:child_process'
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, join, basename } from 'node:path'
import type { AudioTrack, ConvertFormat, ConvertResult, FfmpegStatus, TagWriteResult, TrackTagPatch } from '../shared/types'
import { writeId3v23, type AudioTags } from './id3'
import { importAudioFiles, listStoredTracks, notifyLibraryChanged, readCoverBytes, refreshFromFile } from './library'

const CONVERSION_TIMEOUT_MS = 10 * 60_000
const CONVERT_EXTENSIONS: Record<ConvertFormat, string> = {
  mp3: '.mp3',
  flac: '.flac',
  wav: '.wav',
  m4a: '.m4a',
  ogg: '.ogg',
}

/** Encoder settings per target: lossless targets are explicit so the output is reproducible. */
const CONVERT_CODEC_ARGS: Record<ConvertFormat, string[]> = {
  mp3: ['-codec:a', 'libmp3lame', '-q:a', '2'],
  flac: ['-codec:a', 'flac'],
  wav: ['-codec:a', 'pcm_s16le'],
  m4a: ['-codec:a', 'aac', '-b:a', '256k'],
  ogg: ['-codec:a', 'libvorbis', '-q:a', '6'],
}

let cachedFfmpeg: FfmpegStatus | null = null

function run(command: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // `shell: false` and an argument array: nothing here is interpolated into a command line, so a
    // file name containing spaces or quotes cannot turn into a second command.
    const child = spawn(command, args, { shell: false, windowsHide: true })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('操作超时'))
    }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

/** Locates an encoder once per session (`force` re-checks after the user installs one). */
export async function ffmpegStatus(force = false): Promise<FfmpegStatus> {
  if (cachedFfmpeg && !force) return cachedFfmpeg

  const fromEnv = process.env.AURORA_FFMPEG_PATH?.trim()
  if (fromEnv) {
    try {
      const info = await stat(fromEnv)
      if (info.isFile()) {
        const probe = await run(fromEnv, ['-version'], 15_000).catch(() => null)
        if (probe && probe.code === 0) {
          cachedFfmpeg = {
            available: true,
            path: fromEnv,
            version: probe.stdout.split('\n')[0]?.trim(),
            source: 'env',
          }
          return cachedFfmpeg
        }
      }
    } catch {
      // Fall through to the PATH lookup.
    }
  }

  const finder = process.platform === 'win32' ? 'where' : 'which'
  try {
    const found = await run(finder, ['ffmpeg'], 10_000)
    const first = found.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean)
    if (found.code === 0 && first) {
      const probe = await run(first, ['-version'], 15_000).catch(() => null)
      cachedFfmpeg = {
        available: probe?.code === 0,
        path: first,
        ...(probe?.stdout ? { version: probe.stdout.split('\n')[0]?.trim() } : {}),
        source: 'path',
      }
      return cachedFfmpeg
    }
  } catch {
    // `where`/`which` missing or nothing found: treated as "no encoder" below.
  }

  cachedFfmpeg = { available: false, source: 'none' }
  return cachedFfmpeg
}

/**
 * Rewrites one MP3's ID3v2 tag from user edits, keeping whatever artwork the library holds.
 *
 * Values are only written when the caller supplied them, so editing the artist from the UI cannot
 * blank out a title that was not part of the form.
 */
export async function writeTrackTags(patch: TrackTagPatch): Promise<TagWriteResult> {
  const entry = listStoredTracks().find((track) => track.id === patch.id)
  if (!entry) return { ok: false, error: '找不到这条本地曲目' }
  if (extname(entry.filePath).toLowerCase() !== '.mp3') {
    return { ok: false, error: '标签写入目前只支持 MP3（其他格式会被写坏，所以不做）' }
  }

  let original: Buffer
  try {
    original = await readFile(entry.filePath)
  } catch {
    return { ok: false, error: '读取文件失败，文件可能已被移动或删除' }
  }

  const tags: AudioTags = {
    title: (patch.title ?? entry.title).trim(),
    artist: (patch.artist ?? entry.artist).trim(),
    album: (patch.album ?? entry.album).trim(),
  }
  const cover = await readCoverBytes(patch.id)
  if (cover) tags.cover = { mime: cover.mime, data: cover.data }

  const updated = writeId3v23(original, tags)
  if (updated === original) return { ok: false, error: '没有可写入的内容' }

  // Sibling temp file + rename: the original is never partially overwritten.
  const temporary = join(dirname(entry.filePath), `.${basename(entry.filePath)}.aurora-tmp`)
  try {
    await writeFile(temporary, updated)
    await rename(temporary, entry.filePath)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    return { ok: false, error: error instanceof Error ? error.message : '写入标签失败' }
  }

  const track = await refreshFromFile(patch.id)
  notifyLibraryChanged()
  return { ok: true, ...(track ? { track } : {}) }
}

/**
 * Transcodes one local file next to itself and imports the result.
 *
 * The source file is left untouched: conversion is a "give me another format" action, never a
 * destructive one, and the produced file arrives in the library through the normal import path
 * (so tags, duration and artwork are read exactly as they would be for any other file).
 */
export async function convertTrack(id: string, format: ConvertFormat): Promise<ConvertResult> {
  const entry = listStoredTracks().find((track) => track.id === id)
  if (!entry) return { ok: false, error: '找不到这条本地曲目' }
  if (!(format in CONVERT_EXTENSIONS)) return { ok: false, error: '不支持的目标格式' }

  const encoder = await ffmpegStatus()
  if (!encoder.available || !encoder.path) {
    return {
      ok: false,
      ffmpegMissing: true,
      error: '本机没有检测到 ffmpeg，无法转换格式（设置 AURORA_FFMPEG_PATH 或把 ffmpeg 加入 PATH 后重试）',
    }
  }

  const extension = CONVERT_EXTENSIONS[format]
  if (extname(entry.filePath).toLowerCase() === extension) {
    return { ok: false, error: `源文件已经是 ${format.toUpperCase()}，无需转换` }
  }
  const target = join(dirname(entry.filePath), `${basename(entry.filePath, extname(entry.filePath))} (转换)${extension}`)

  let result: { code: number; stderr: string }
  try {
    result = await run(
      encoder.path,
      ['-hide_banner', '-nostdin', '-y', '-i', entry.filePath, '-vn', ...CONVERT_CODEC_ARGS[format], target],
      CONVERSION_TIMEOUT_MS,
    )
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '调用 ffmpeg 失败' }
  }

  if (result.code !== 0) {
    await rm(target, { force: true }).catch(() => undefined)
    const tail = result.stderr.trim().split('\n').slice(-3).join(' ').trim()
    return { ok: false, error: tail || `ffmpeg 退出码 ${result.code}` }
  }

  const imported = await importAudioFiles([target])
  notifyLibraryChanged()
  const track: AudioTrack | undefined = imported.added[0]
  if (!track) return { ok: false, filePath: target, error: '文件已生成，但未能加入音乐库' }
  return { ok: true, filePath: target, track }
}

/** Removes one temp file a crashed tag write may have left behind (best effort, never throws). */
async function cleanupTagTemp(filePath: string): Promise<void> {
  const temporary = join(dirname(filePath), `.${basename(filePath)}.aurora-tmp`)
  await rm(temporary, { force: true }).catch(() => undefined)
}

/**
 * Sweeps the `.<name>.aurora-tmp` siblings a crashed tag write can leave next to the user's music.
 *
 * `writeTrackTags` writes that sibling and renames it over the original; a crash in between leaves it
 * behind forever, so every launch (after the library is loaded) clears the ones it can name. Called
 * from `main/index.ts` rather than from `library.ts` because the dependency only runs one way:
 * libraryTools already imports library, so library must not import back.
 */
export async function sweepTagTemps(): Promise<void> {
  const tracks = listStoredTracks()
  let cursor = 0
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (cursor < tracks.length) {
        const track = tracks[cursor++]
        if (track) await cleanupTagTemp(track.filePath)
      }
    }),
  )
}
