/*
 * The user's themes folder.
 *
 * "更多主题" is only worth having if it actually leads somewhere, so this is a real loader rather than
 * a placeholder: a JSON file dropped into `<userData>/themes` becomes a selectable skin, and the same
 * validator the built-in skins' shape is defined by (`shared/theme.ts`) decides whether it is usable.
 *
 * Files are the unit of exchange on purpose — a folder the user can open in Explorer, copy a file
 * into, and see appear is the whole feature. Nothing here evaluates anything: a theme is parsed as
 * JSON and every colour value is checked against a character allowlist before the renderer puts it in
 * a stylesheet.
 */
import { app, dialog, shell } from 'electron'
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { parseThemeDefinition, type UserThemeRecord } from '../shared/theme'
import { BUILT_IN_SKIN_IDS } from '../shared/skinIds'

/** Readme written next to the themes, because the schema is the only thing a theme author needs. */
const README = `Aurora 主题目录
================

把主题 JSON 文件放进这个文件夹，然后在「设置 → 主题中心 → 更多主题」里点「刷新」，
它就会出现在主题列表里。

文件格式（保存为 UTF-8 的 .json）：

{
  "id": "my-theme",              // 唯一标识，小写字母、数字、-、_，不能与内置主题重名
  "name": "我的主题",             // 显示名称
  "tagline": "一句话定位",         // 可选
  "description": "更长的说明。",   // 可选
  "keywords": ["关键词"],          // 可选
  "swatch": ["#101018", "#8ea2ff", "#ffffff"],   // 预览色板，最多 3 个
  "preferredMode": "dark",        // dark 或 light：选中该主题时默认切到哪个明暗
  "dark":  { "--bg": "#070a16", "--accent": "#8ea2ff", ... },
  "light": { "--bg": "#eef1fb", "--accent": "#5c6fd6", ... },
  "effects": {
    "particles": "stars",         // stars | leaves | mist | rain | dust | none
    "density": 0.2,               // 每 10 万像素面积的粒子数（0.0 - 0.6）
    "speed": 6,                   // 粒子速度（0 - 60）
    "driftSeconds": 120,          // 背景流动周期（8 - 600 秒，越长越静）
    "glow": 0.2                   // 氛围光强度（0 - 0.5）
  }
}

可用变量（不必全部写，只写想改的即可）：

  --bg            页面背景
  --panel         侧边栏 / 面板
  --panel-soft    输入框、封面占位等凹区
  --card          卡片
  --card-soft     次级卡片
  --line / --line-strong          分隔线
  --text / --muted / --faint      文字三级
  --accent / --accent-strong / --accent-soft / --accent-line   强调色
  --ambient-a / --ambient-b       氛围渐变的两种颜色
  --glass / --glass-strong / --glass-line / --player-bg        毛玻璃与播放栏
  --shadow / --shadow-soft        阴影
  --danger / --success / --warn   状态色

注意：只接受颜色值（十六进制、rgb()、rgba()）。文件名随意，但 id 必须唯一。
`

/** A small working theme, so the folder is not empty and the format can be copied from something real. */
const EXAMPLE_ID = 'example-ink'
const EXAMPLE = {
  id: EXAMPLE_ID,
  name: '示例 · 淡墨',
  tagline: '一个可以直接改的示例主题',
  description: '放在主题目录里的示例。复制这个文件、改掉 id 和颜色，就是一个属于你自己的主题。',
  keywords: ['示例', '水墨', '浅色'],
  swatch: ['#f4f5f2', '#4a6f68', '#22302f'],
  preferredMode: 'light',
  dark: {
    '--bg': '#12181a',
    '--panel': '#1a2224',
    '--card': '#1a2224',
    '--text': '#eef3f2',
    '--muted': '#9bb0ac',
    '--accent': '#7fc7bd',
    '--accent-strong': '#6fb3a9',
    '--ambient-a': '#7fc7bd',
    '--ambient-b': '#8fa6b8',
  },
  light: {
    '--bg': '#f4f5f2',
    '--panel': '#ffffff',
    '--panel-soft': '#e8eae4',
    '--card': '#ffffff',
    '--line': 'rgba(34, 48, 47, 0.12)',
    '--line-strong': 'rgba(34, 48, 47, 0.22)',
    '--text': '#22302f',
    '--muted': '#5f7370',
    '--accent': '#4a6f68',
    '--accent-strong': '#3d5c56',
    '--accent-soft': 'rgba(74, 111, 104, 0.12)',
    '--ambient-a': '#7fc7bd',
    '--ambient-b': '#e0c3b0',
  },
  effects: { particles: 'mist', density: 0.08, speed: 8, driftSeconds: 80, glow: 0.12 },
}

export function themesDirectory(): string {
  return join(app.getPath('userData'), 'themes')
}

/** The folder and its readme, created on demand. Returns the directory either way. */
export async function ensureThemesDirectory(): Promise<string> {
  const directory = themesDirectory()
  await mkdir(directory, { recursive: true })
  const readme = join(directory, 'README.txt')
  try {
    await readFile(readme, 'utf8')
  } catch {
    await writeFile(readme, README, 'utf8')
  }
  const example = join(directory, '示例主题.json')
  try {
    await readFile(example, 'utf8')
  } catch {
    await writeFile(example, `${JSON.stringify(EXAMPLE, null, 2)}\n`, 'utf8')
  }
  return directory
}

/** Every `*.json` in the folder, parsed and validated. Bad files are reported, never skipped silently. */
export async function listUserThemes(): Promise<UserThemeRecord[]> {
  const directory = await ensureThemesDirectory()
  let files: string[] = []
  try {
    files = (await readdir(directory)).filter((name) => name.toLowerCase().endsWith('.json')).sort()
  } catch {
    return []
  }
  const records: UserThemeRecord[] = []
  for (const name of files) {
    const file = join(directory, name)
    try {
      const raw = await readFile(file, 'utf8')
      const parsed = parseThemeDefinition(JSON.parse(raw) as unknown)
      if ('error' in parsed) {
        records.push({ id: name.replace(/\.json$/i, ''), name, file, ok: false, error: parsed.error })
        continue
      }
      if (BUILT_IN_SKIN_IDS.includes(parsed.theme.id)) {
        records.push({
          id: parsed.theme.id,
          name: parsed.theme.name,
          file,
          ok: false,
          error: `id「${parsed.theme.id}」与内置主题重名，请改成别的 id`,
        })
        continue
      }
      records.push({ id: parsed.theme.id, name: parsed.theme.name, file, ok: true, theme: parsed.theme })
    } catch (error) {
      records.push({
        id: name.replace(/\.json$/i, ''),
        name,
        file,
        ok: false,
        error: `无法解析：${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }
  return records
}

/**
 * Copies a chosen file into the themes folder.
 *
 * Validation happens *before* the copy, so a file the app cannot use never lands in the folder where
 * it would sit as a permanently broken entry in the list.
 */
export async function importUserTheme(sourcePath: string): Promise<UserThemeRecord> {
  const directory = await ensureThemesDirectory()
  const fileName = basename(sourcePath)
  const fallback = { id: fileName, name: fileName, file: sourcePath, ok: false }
  let parsed: ReturnType<typeof parseThemeDefinition>
  try {
    parsed = parseThemeDefinition(JSON.parse(await readFile(sourcePath, 'utf8')) as unknown)
  } catch (error) {
    return { ...fallback, error: `无法读取文件：${error instanceof Error ? error.message : String(error)}` }
  }
  if ('error' in parsed) return { ...fallback, error: parsed.error }
  if (BUILT_IN_SKIN_IDS.includes(parsed.theme.id)) {
    return { ...fallback, id: parsed.theme.id, name: parsed.theme.name, error: `id「${parsed.theme.id}」与内置主题重名` }
  }
  const target = join(directory, `${parsed.theme.id}.json`)
  await copyFile(sourcePath, target)
  return { id: parsed.theme.id, name: parsed.theme.name, file: target, ok: true, theme: parsed.theme }
}

/** Deletes the file backing a user theme. Built-ins have no file and can never be removed this way. */
export async function removeUserTheme(id: string): Promise<boolean> {
  if (BUILT_IN_SKIN_IDS.includes(id)) return false
  const records = await listUserThemes()
  const record = records.find((item) => item.id === id)
  if (!record) return false
  // Only ever inside the themes directory: an `id` that resolved elsewhere must not delete that file.
  if (!record.file.startsWith(themesDirectory())) return false
  await rm(record.file, { force: true })
  return true
}

/** Opens the folder in Explorer, so "import a theme" is a thing the user can actually do. */
export async function revealThemesDirectory(): Promise<string> {
  const directory = await ensureThemesDirectory()
  await shell.openPath(directory)
  return directory
}

/** The file picker behind 导入主题文件. */
export async function pickThemeFile(window: Electron.BrowserWindow | null): Promise<string | null> {
  if (!window) return null
  const result = await dialog.showOpenDialog(window, {
    title: '导入主题文件',
    properties: ['openFile'],
    filters: [
      { name: 'Aurora 主题', extensions: ['json'] },
      { name: '全部文件', extensions: ['*'] },
    ],
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0] ?? null
}

/** Re-exported so `ipc.ts` does not need to know where theme records come from. */
export { EXAMPLE_ID }
