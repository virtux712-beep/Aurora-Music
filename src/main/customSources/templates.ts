import type { CustomSourceManifest, CustomSourceTemplate } from '../../shared/customSource'

/**
 * Ready-to-load custom-source templates.
 *
 * These are *not* installed by default — they are starting points the user can load into the editor
 * and read, edit or reject. Every one of them targets a real, publicly documented API that Aurora is
 * allowed to access:
 *
 *  - Internet Archive — `advancedsearch.php` (search) + `metadata/{id}` (file list) + `download/`
 *    (the audio itself) + `services/img/` (cover). No API key, documented for programmatic use.
 *    `licenseurl:*` keeps only items that actually declare a licence,
 *    `-access-restricted-item:true` drops items that cannot be streamed, and
 *    `format:("VBR MP3")` keeps only items that really have a playable MP3 derivative —
 *    without it the first hit can be an item that only ships a torrent and a playlist.
 *
 * Spotify/Apple/QQ/网易云 之类的平台接口一律不在这里：Aurora 不抓取受版权保护或有访问控制的目录。
 */

const SEARCH_QUERY =
  'mediatype:(audio) AND licenseurl:* AND -access-restricted-item:true AND format:("VBR MP3") AND ({query})'

/** Preferred playable derivatives, most compatible first (the first match in the file list wins). */
const PLAYABLE_FORMATS = ['VBR MP3', '128Kbps MP3', '64Kbps MP3', 'MP3', 'Ogg Vorbis', 'Flac']

/** Internet Archive's metadata response describes every file; only one of them is the MP3 to play. */
const ARCHIVE_SEARCH = {
  url: 'https://archive.org/advancedsearch.php',
  query: {
    q: SEARCH_QUERY,
    rows: '{limit}',
    page: '{page}',
    output: 'json',
  },
  resultsPath: 'response.docs',
} as const

/**
 * `rows` is clamped to 1..100 by the adapter, `{page}` maps to Archive's own pagination, and each
 * search hit is one *item* (an album or an episode collection) whose first MP3 derivative is played —
 * that is how Archive exposes audio, so the template says so instead of pretending otherwise.
 */
function archiveManifest(partial: {
  id: string
  name: string
  icon: string
  description: string
  query?: string
  license?: string
}): CustomSourceManifest {
  return {
    apiVersion: '1',
    id: partial.id,
    name: partial.name,
    version: '1.0.0',
    author: 'Aurora',
    icon: partial.icon,
    description: partial.description,
    homepage: 'https://archive.org/',
    license: partial.license ?? '逐条目标注（Creative Commons / 公有领域）',
    capabilities: { search: true, stream: true },
    permissions: ['network'],
    allowedHosts: ['archive.org'],
    search: {
      ...ARCHIVE_SEARCH,
      query: {
        ...ARCHIVE_SEARCH.query,
        q: partial.query ?? SEARCH_QUERY,
      },
      fields: {
        id: 'identifier',
        title: 'title',
        artist: 'creator',
        // Archive has a cover service keyed by item id — a URL template instead of a JSON path.
        cover: 'https://archive.org/services/img/{id}',
        license: 'licenseurl',
        year: 'year',
        homepage: 'https://archive.org/details/{id}',
      },
    },
    stream: {
      url: 'https://archive.org/metadata/{id}',
      select: {
        list: 'files',
        match: { field: 'format', equals: PLAYABLE_FORMATS },
        url: 'name',
      },
      // The selected value is a bare file name, so it has to be composed into the download URL.
      urlTemplate: 'https://archive.org/download/{id}/{value}',
    },
  }
}

export const BUILTIN_TEMPLATES: CustomSourceManifest[] = [
  archiveManifest({
    id: 'internet-archive',
    name: 'Internet Archive',
    icon: '🏛',
    description:
      'Internet Archive 的开放授权音频目录（音乐 / 有声书 / 播客），只包含声明了许可证且未被限制访问的条目；每条结果播放该条目下的第一段 MP3 派生文件。',
  }),
  archiveManifest({
    id: 'internet-archive-netlabels',
    name: 'Internet Archive · 独立厂牌',
    icon: '🎛',
    description:
      'Internet Archive 的 netlabels 合集：以 Creative Commons 授权的独立厂牌专辑与单曲为主（搜索关键词会与合集条件组合），每条结果播放该专辑的第一段 MP3 派生文件。',
    query: 'collection:(netlabels) AND mediatype:(audio) AND format:("VBR MP3") AND ({query})',
    license: 'Creative Commons（逐条目 licenseurl 标注）',
  }),
]

/** Templates as editor-ready payloads (pretty JSON the user can read and adapt). */
export function listBuiltinTemplates(): CustomSourceTemplate[] {
  return BUILTIN_TEMPLATES.map((manifest) => ({
    id: manifest.id,
    name: manifest.name,
    description: manifest.description ?? '',
    json: JSON.stringify(manifest, null, 2),
  }))
}
