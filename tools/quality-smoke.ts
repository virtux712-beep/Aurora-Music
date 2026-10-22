/**
 * Smoke test for Aurora's quality model (`src/shared/quality.ts`).
 *
 * Quality is the one part of the UI where a wrong guess is invisible: a badge that says 无损 for a 128k
 * stream still renders, still looks plausible, and only the listener notices. So this suite is written
 * around the three places a guess could hide:
 *
 *  - **Part 1** — the tiers themselves: four of them, ranks strictly ordered (every comparison elsewhere
 *    depends on that), and each tier's own spec matching what the product promises.
 *  - **Part 2** — token classification, including the traps: `192k` is a lossy kbps in every vocabulary
 *    this app speaks and must not read as 192 kHz; `flac24bit` in all its spellings is hi-res; an invented
 *    token is *unknown* rather than mapped to something convenient.
 *  - **Part 3** — local files, where the facts come from the container instead: an untagged FLAC is
 *    lossless but not hi-res, and an untagged MP3 gets no tier at all (128 vs 320 is a real difference and
 *    the file does not claim either).
 *  - **Part 4** — the badge: best tier wins, the tooltip lists every recognised option, and nothing is
 *    invented when there is nothing to read.
 *  - **Part 5** — choosing a token for a preference: never silently above it, exact tier when possible,
 *    nothing sent when the source declared nothing, and an honest `exceeded` flag when it has to go up.
 *  - **Part 6** — the picker rows, plus the live platform vocabulary: every quality the five built-in
 *    platforms actually declare has to classify, because a token without a tier is a song Aurora cannot
 *    describe. That check reads the real platform module, so a new token there fails here.
 *
 * Deterministic and offline: no network, no Electron, no window.
 *
 * Run with: npm run smoke:quality
 */
import {
  DEFAULT_QUALITY,
  QUALITY_TIERS,
  QUALITY_TIER_IDS,
  chooseQuality,
  bestTierOf,
  qualityBadge,
  qualityOptions,
  qualityTier,
  tierOfFacts,
  tierOfToken,
  type QualityTierId,
} from '../src/shared/quality'
import { PLATFORMS } from '../src/main/musicSdk'

const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
const check = (name: string, ok: boolean, detail?: unknown): void => {
  checks.push({ name, ok, detail: detail === undefined ? undefined : String(detail) })
}

/* ---------------------------------------------------------------- Part 1: the tiers */

function part1(): void {
  check('四档齐全，顺序为 臻享无损 → 高清无损 → 极致音质 → 流畅播放', QUALITY_TIER_IDS.join('>') === 'ultra>lossless>high>smooth', QUALITY_TIER_IDS.join('>'))
  const ranks = QUALITY_TIERS.map((tier) => tier.rank)
  check(
    '档位 rank 严格递减（所有比较都建立在它上面）',
    ranks.every((rank, index) => index === 0 || rank < ranks[index - 1]),
    ranks.join('>'),
  )
  check(
    '每一档都有产品名、英文名、参数、说明与适合人群',
    QUALITY_TIERS.every(
      (tier) =>
        tier.name.length > 0 &&
        tier.english.length > 0 &&
        tier.description.length > 0 &&
        tier.audience.length > 0 &&
        tier.spec.formats.length > 0,
    ),
    QUALITY_TIERS.map((tier) => tier.name).join('/'),
  )
  const expectedBadges = ['🎧 ✨ Hi-Res', '💎 Lossless', '🎵 Recommended', '⚡ Smooth']
  const actualBadges = QUALITY_TIERS.map((tier) => `${tier.badge.icon} ${tier.badge.label}`)
  check(
    '徽章文案与约定的产品标识一致（🎧✨ Hi-Res / 💎 Lossless / 🎵 Recommended / ⚡ Smooth）',
    actualBadges.join(' · ') === expectedBadges.join(' · '),
    actualBadges.join(' · '),
  )
  check(
    '两档无损的容器/位深/采样率正是产品承诺的那组数',
    qualityTier('ultra').spec.bitDepth === 24 &&
      qualityTier('ultra').spec.sampleRate === 96000 &&
      qualityTier('lossless').spec.bitDepth === 16 &&
      qualityTier('lossless').spec.sampleRate === 44100,
    `${qualityTier('ultra').spec.bitDepth}bit/${qualityTier('ultra').spec.sampleRate} vs ${qualityTier('lossless').spec.bitDepth}bit/${qualityTier('lossless').spec.sampleRate}`,
  )
  check('默认偏好是 高清无损（不默认拉 24/96 母带）', DEFAULT_QUALITY === 'lossless', DEFAULT_QUALITY)
  check('未知 id 退回默认档而不是抛错', qualityTier('nope' as QualityTierId).id === DEFAULT_QUALITY, qualityTier('nope' as QualityTierId).id)
}

/* ------------------------------------------------- Part 2: token classification */

function part2(): void {
  const table: Array<[string, QualityTierId]> = [
    ['flac24bit', 'ultra'],
    ['flac_24bit', 'ultra'],
    ['FLAC-24BIT', 'ultra'],
    ['flac 24 bit', 'ultra'],
    ['flac32bit', 'ultra'],
    ['hires', 'ultra'],
    ['hi-res', 'ultra'],
    ['master', 'ultra'],
    ['dsd', 'ultra'],
    ['flac', 'lossless'],
    ['ape', 'lossless'],
    ['wav', 'lossless'],
    ['alac', 'lossless'],
    ['aiff', 'lossless'],
    ['320k', 'high'],
    ['256k', 'high'],
    ['192k', 'high'],
    ['aac256', 'high'],
    ['128k', 'smooth'],
    ['96k', 'smooth'],
    ['64k', 'smooth'],
    ['aac128', 'smooth'],
  ]
  const wrong = table.filter(([token, tier]) => tierOfToken(token) !== tier)
  check('代币分类表全对（含大小写、空格、下划线的归一化）', wrong.length === 0, wrong.map(([token, tier]) => `${token}→${tierOfToken(token) ?? 'null'}(期望${tier})`).join(' '))

  /*
   * The trap this model exists to avoid: in the LX platform vocabulary `192k` is 192 kbps MP3. Reading it
   * as a sample rate would badge a lossy stream as 臻享无损 — the most flattering possible lie.
   */
  check('`192k` 被读成码率而不是采样率（192kbps ≠ 192kHz）', tierOfToken('192k') === 'high' && tierOfToken('192k') !== 'ultra', `192k → ${tierOfToken('192k')}`)
  check(
    '写法不标准的码率也能按数值归类（233k→流畅、400k→极致），而不是整条漏掉',
    tierOfToken('233k') === 'smooth' && tierOfToken('400k') === 'high' && tierOfToken('400kbps') === 'high',
    `233k→${tierOfToken('233k')} 400k→${tierOfToken('400k')} 400kbps→${tierOfToken('400kbps')}`,
  )
  check('未知代币归类为 null 而不是猜一个档', tierOfToken('vip-only') === null && tierOfToken('') === null && tierOfToken(undefined) === null, `${tierOfToken('vip-only')}/${tierOfToken('')}/${tierOfToken(undefined)}`)
  check('“最好的一档”取最高，而不是列表里第一个', bestTierOf(['128k', 'flac']) === 'lossless' && bestTierOf(['flac', 'flac24bit']) === 'ultra', `${bestTierOf(['128k', 'flac'])}/${bestTierOf(['flac', 'flac24bit'])}`)
  check('全部未识别时返回 null（宁可不显示徽章）', bestTierOf(['vip-only', 'x']) === null, String(bestTierOf(['vip-only', 'x'])))
}

/* ------------------------------------------------------- Part 3: local-file facts */

function part3(): void {
  check('无标签的 FLAC 是无损，但不会被夸成 Hi-Res', tierOfFacts({ format: 'FLAC' }) === 'lossless', String(tierOfFacts({ format: 'FLAC' })))
  check('FLAC 24bit/96kHz 是 Hi-Res', tierOfFacts({ format: 'FLAC', bitsPerSample: 24, sampleRate: 96000 }) === 'ultra', String(tierOfFacts({ format: 'FLAC', bitsPerSample: 24, sampleRate: 96000 })))
  check('FLAC 16bit/44.1kHz 是无损（CD 规格不是 Hi-Res）', tierOfFacts({ format: 'FLAC', bitsPerSample: 16, sampleRate: 44100 }) === 'lossless', String(tierOfFacts({ format: 'FLAC', bitsPerSample: 16, sampleRate: 44100 })))
  check('WAV 24bit/192kHz 是 Hi-Res', tierOfFacts({ format: 'WAV', bitsPerSample: 24, sampleRate: 192000 }) === 'ultra', String(tierOfFacts({ format: 'WAV', bitsPerSample: 24, sampleRate: 192000 })))
  check('MP3 320kbps 是极致音质、128kbps 是流畅播放', tierOfFacts({ format: 'MP3', bitrate: 320000 }) === 'high' && tierOfFacts({ format: 'MP3', bitrate: 128000 }) === 'smooth', `${tierOfFacts({ format: 'MP3', bitrate: 320000 })}/${tierOfFacts({ format: 'MP3', bitrate: 128000 })}`)
  check('有损但没标签 → 不给档位（128 与 320 是两个产品，文件没说）', tierOfFacts({ format: 'MP3' }) === null && tierOfFacts({ format: 'AAC' }) === null, `${tierOfFacts({ format: 'MP3' })}/${tierOfFacts({ format: 'AAC' })}`)
  check('连容器都读不到时返回 null', tierOfFacts({}) === null && tierOfFacts({ format: '' }) === null, String(tierOfFacts({})))
}

/* ------------------------------------------------------------------ Part 4: badge */

function part4(): void {
  const online = qualityBadge({ origin: 'online', qualities: ['128k', 'flac24bit'] })
  check('在线曲目取最高档作徽章，并带上图标与文案', online?.tier === 'ultra' && online?.text === '🎧 ✨ Hi-Res', `${online?.tier}/${online?.text}`)
  check('徽章 tooltip 把每个可用音质都翻译成了档位名', Boolean(online?.title.includes('flac24bit（臻享无损）') && online?.title.includes('128k（流畅播放）')), online?.title)
  const local = qualityBadge({ origin: 'local', format: 'FLAC', bitsPerSample: 24, sampleRate: 96000, bitrate: 2300000 })
  check('本地文件用容器事实给出同一种徽章，并在 tooltip 写出真实数字', local?.tier === 'ultra' && Boolean(local?.title.includes('24bit / 96.0kHz')) && Boolean(local?.title.includes('2300kbps')), local?.title)
  check('没得可读时不显示徽章（编一个 320K 就是撒谎）', qualityBadge({ origin: 'online', qualities: [] }) === null && qualityBadge({ origin: 'local', format: 'MP3' }) === null, 'null')
  check('档位名与 tone 一致，UI 才能按档上色', QUALITY_TIERS.every((tier) => qualityTier(tier.id).badge.tone === tier.id), QUALITY_TIERS.map((tier) => tier.badge.tone).join(','))
}

/* ------------------------------------------------------- Part 5: choosing a token */

function part5(): void {
  const list = ['128k', '320k', 'flac', 'flac24bit']
  const forLossless = chooseQuality(list, 'lossless')
  check('偏好“高清无损”时取 flac（该档及以下最好的一档）', forLossless.quality === 'flac' && forLossless.tier === 'lossless' && forLossless.exceeded === false, JSON.stringify(forLossless))
  const forSmooth = chooseQuality(list, 'smooth')
  check('偏好“流畅播放”时只取 128k —— 绝不因为音源有母带就偷偷给母带', forSmooth.quality === '128k' && forSmooth.exceeded === false, JSON.stringify(forSmooth))
  const forUltra = chooseQuality(list, 'ultra')
  check('偏好“臻享无损”时有母带就给母带', forUltra.quality === 'flac24bit' && forUltra.tier === 'ultra', JSON.stringify(forUltra))
  /*
   * `exceeded` is the honest half: the source had nothing at or below 流畅播放, so the *lowest* thing it does
   * have is taken (320k, not the flac it could have grabbed) and the caller is told. Losing the preference
   * silently is the failure this flag exists to make impossible.
   */
  const overBudget = chooseQuality(['320k', 'flac'], 'smooth')
  check(
    '音源给不起这一档时取其最低的一档，并如实标记 exceeded',
    overBudget.quality === '320k' && overBudget.tier === 'high' && overBudget.exceeded === true && overBudget.reason.includes('退而取其最低档'),
    JSON.stringify(overBudget),
  )
  check(
    '在预算内的那些代币里取最好的一档，不会因为存在更低的就退太多',
    chooseQuality(['128k', '320k'], 'lossless').quality === '320k' && chooseQuality(['128k', '320k'], 'lossless').exceeded === false,
    JSON.stringify(chooseQuality(['128k', '320k'], 'lossless')),
  )
  const nothing = chooseQuality([], 'lossless')
  check('音源没声明音质时不发任何代币（发一个它没宣布过的值只会解析失败）', nothing.quality === undefined && nothing.tier === null && nothing.reason.length > 0, JSON.stringify(nothing))
  const junk = chooseQuality(['vip-only', 'weird'], 'lossless')
  check('全是未知代币时同样不发（未知不等于可播）', junk.quality === undefined, JSON.stringify(junk))
  const partial = chooseQuality(['128k', 'vip-only'], 'high')
  check('部分未知代币不影响可用那些的判定', partial.quality === '128k' && partial.tier === 'smooth' && partial.exceeded === false, JSON.stringify(partial))
  check('同一输入永远给同一答案（下载与播放不会因此不一致）', JSON.stringify(chooseQuality(list, 'high')) === JSON.stringify(chooseQuality(list, 'high')), chooseQuality(list, 'high').quality ?? 'none')
}

/* -------------------------------------------------------- Part 6: picker + platform vocabulary */

function part6(): void {
  const options = qualityOptions(['128k', 'flac'], 'lossless')
  check('选择器永远给出四行（不可用也列出来，让用户知道为什么）', options.length === 4 && options.map((row) => row.tier.id).join('>') === 'ultra>lossless>high>smooth', options.map((row) => `${row.tier.id}:${row.available}`).join(' '))
  check('可用性与代币归类一致', options.find((row) => row.tier.id === 'lossless')?.tokens.join() === 'flac' && options.find((row) => row.tier.id === 'smooth')?.tokens.join() === '128k' && options.find((row) => row.tier.id === 'ultra')?.available === false, JSON.stringify(options.map((row) => [row.tier.id, row.tokens])))
  check('选中态跟着偏好走', options.filter((row) => row.selected).map((row) => row.tier.id).join() === 'lossless', options.filter((row) => row.selected).map((row) => row.tier.id).join())

  /*
   * The live vocabulary: whatever the built-in platforms announce has to classify, or those songs would show
   * no quality at all. Read from the real platform module, so adding a token there fails this check rather
   * than silently producing unbadgeable songs.
   */
  const declared = new Set(PLATFORMS.flatMap((platform) => platform.qualities))
  const unknown = [...declared].filter((token) => tierOfToken(token) === null)
  check('五个内置平台实际声明的每个音质代币都能归类', unknown.length === 0, unknown.join(' ') || `${declared.size} tokens: ${[...declared].join(',')}`)
  check(
    '每个平台至少覆盖“流畅 → 臻享”里的两档（否则选择器里那几档永远是空的）',
    PLATFORMS.every((platform) => new Set(platform.qualities.map((token) => tierOfToken(token))).size >= 2),
    PLATFORMS.map((platform) => `${platform.id}:${platform.qualities.length}`).join(' '),
  )
}

function main(): void {
  part1()
  part2()
  part3()
  part4()
  part5()
  part6()
  const failed = checks.filter((item) => !item.ok)
  for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.detail ? `  ${item.detail}` : ''}`)
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
  process.exitCode = failed.length === 0 ? 0 : 1
}

main()
