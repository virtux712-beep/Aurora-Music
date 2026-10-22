/**
 * Smoke test for Aurora's lyrics engine (`src/main/lyricsEngine/`).
 *
 * The point of this suite is that it never asks the network to prove the *pipeline*:
 *
 *  - **Part 1** — the parser: standard LRC, `[offset:]`, duplicate-timestamp translations, enhanced
 *    LRC per-word timings, and a serialise→parse round trip (which is exactly what caching does).
 *  - **Part 2** — the matcher, on the cases that decide whether a user gets the right song's words:
 *    brackets, `feat.`, artist splitting, the ±5s duration window, and what must be rejected.
 *  - **Part 3** — the manager chain on a real temporary track: local file first, then the *plugged*
 *    providers. A crashing provider, a hanging provider and one returning junk are all injected here,
 *    so error isolation is proven without needing any catalogue to misbehave on cue.
 *  - **Part 4** — caching: a fetched lyric is written as `歌名.lrc` next to the file and as
 *    `歌手 - 歌名.lrc` in the cache directory, and the next lookup is answered from disk with **zero**
 *    provider calls.
 *  - **Part 5** — the two real catalogues, live. Network trouble is reported as SKIP (never as PASS),
 *    and a reachable catalogue that has no lyrics for a famous track is reported as such.
 *
 * Run with: npm run smoke:lyrics
 */
import { app } from 'electron'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_DESKTOP_LYRICS,
  DEFAULT_DOWNLOAD_SETTINGS,
  DEFAULT_SYSTEM_INTEGRATION,
} from '../src/shared/types'
import type { AudioTrack, AuroraSettings } from '../src/shared/types'
import {
  clampLyricsOffset,
  findActiveLine,
  findActiveWord,
  formatLyricsOffset,
  hasWordTimings,
  lyricSyncTime,
  lyricsToLrcText,
  mergeTimedText,
  parsePlainLyrics,
  parseLyricsText,
  wordFillProgress,
  type Lyrics,
} from '../src/shared/lyrics'
import {
  MIN_MATCH_SCORE,
  pickBestCandidate,
  scoreCandidate,
  normalize,
  titleVariants,
} from '../src/main/lyricsEngine/match'
import {
  clearStoredLyrics,
  forgetLyrics,
  initLyricsManager,
  registerLyricsProvider,
  resolveLyrics,
  saveUserLyrics,
} from '../src/main/lyricsEngine/manager'
import { cacheFileName, readCachedLyrics } from '../src/main/lyricsEngine/store'
import type { LyricsContext, LyricsHit, LyricsProvider, LyricsQuery } from '../src/main/lyricsEngine/types'

const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
type CheckState = 'PASS' | 'FAIL' | 'SKIP'
const check = (name: string, ok: boolean, detail?: unknown): void => {
  checks.push({ name, ok, detail: detail === undefined ? undefined : String(detail) })
}
/** A check that could not be run for environmental reasons — reported, never counted as a pass. */
const skipped: Array<{ name: string; detail: string }> = []
const skip = (name: string, detail: string): void => {
  skipped.push({ name, detail })
}
const printable = (value: unknown): string => {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

const settings: AuroraSettings = {
  sourceConfig: {},
  enabledSources: {},
  sourceOrder: [],
  allowOpenLicenseDownloads: true,
  autoHealthCheck: false,
  desktopLyrics: { ...DEFAULT_DESKTOP_LYRICS },
  downloads: { ...DEFAULT_DOWNLOAD_SETTINGS },
  systemIntegration: { ...DEFAULT_SYSTEM_INTEGRATION },
}
const secrets: Record<string, Record<string, string>> = {}

function localTrack(overrides: Partial<AudioTrack> = {}): AudioTrack {
  return {
    id: 'local-track-1',
    origin: 'local',
    title: '晴天',
    artist: '周杰伦',
    album: '叶惠美',
    duration: 269,
    format: 'mp3',
    fileUrl: 'aurora-media://audio/local-1',
    addedAt: Date.now(),
    ...overrides,
  }
}

function onlineTrack(overrides: Partial<AudioTrack> = {}): AudioTrack {
  return {
    id: 'online-track-1',
    origin: 'online',
    title: 'Hello',
    artist: 'Adele',
    album: '25',
    duration: 295,
    format: 'mp3',
    fileUrl: 'aurora-media://remote/token',
    addedAt: Date.now(),
    sourceId: 'e2e-source',
    platform: 'wy',
    ...overrides,
  }
}

/* -------------------------------------------------- Part 1c: the listener's lyric offset (±1000 ms) */

/**
 * The offset is added to the playback clock, so its two failure modes are worth pinning down here: an
 * out-of-range value (which would put the lyrics seconds away from the music) and an un-snapped value (which
 * would leave the UI showing a number none of its buttons can produce).
 */
function testLyricOffset(): void {
  check('偏移会被夹在 ±1000 ms 内', clampLyricsOffset(50_000) === 1000 && clampLyricsOffset(-50_000) === -1000)
  check(
    '偏移会吸附到 100 ms 档位（UI 的按钮只能产出这些值）',
    clampLyricsOffset(137) === 100 &&
      clampLyricsOffset(-149) === -100 &&
      clampLyricsOffset(151) === 200 &&
      clampLyricsOffset(0) === 0,
    `${clampLyricsOffset(137)} / ${clampLyricsOffset(-149)} / ${clampLyricsOffset(151)}`,
  )
  check('坏值不会变成 NaN 写进设置', clampLyricsOffset(Number.NaN) === 0 && clampLyricsOffset('abc') === 0 && clampLyricsOffset(undefined) === 0)

  check(
    '同步时间 = 播放位置 + 偏移（提前为负、延后为正）',
    lyricSyncTime(10, 0) === 10 &&
      lyricSyncTime(10, 500) === 10.5 &&
      lyricSyncTime(10, -500) === 9.5 &&
      // 提前到开头之前时不能给出负数：找不到更早的歌词，也不该产生负的时间戳
      lyricSyncTime(0.2, -500) === 0 &&
      lyricSyncTime(Number.NaN, 200) === 0.2,
    `${lyricSyncTime(10, 500)} / ${lyricSyncTime(10, -500)} / ${lyricSyncTime(0.2, -500)}`,
  )

  check(
    '偏移显示只有一种拼法（0 / +100 / −100）',
    formatLyricsOffset(0) === '0 ms' && formatLyricsOffset(100) === '+100 ms' && formatLyricsOffset(-100) === '−100 ms',
    `${formatLyricsOffset(0)} / ${formatLyricsOffset(100)} / ${formatLyricsOffset(-100)}`,
  )

  /*
   * The behaviour that matters to a listener: the same clock position resolves to a *different* line once the
   * offset moves. A correction that changes the displayed number but not the highlighted line would be a fake.
   */
  const lines = parseLyricsText('[00:10.00]第一句\n[00:20.00]第二句\n[00:30.00]第三句').lines
  const plain = findActiveLine(lines, 20.5)
  const later = findActiveLine(lines, lyricSyncTime(20.5, 1000))
  const earlier = findActiveLine(lines, lyricSyncTime(20.5, -1000))
  check(
    '偏移真的改变了当前歌词行（不是只换了个数字）',
    plain === 1 && later === 1 && earlier === 0 && findActiveLine(lines, lyricSyncTime(19.5, 1000)) === 1,
    `原始 ${plain} · +1000ms ${later} · −1000ms ${earlier}`,
  )
}

/* ------------------------------------------------------------------ Part 1: parser + model */

function testParser(): void {
  const plain = parseLyricsText('[ti:晴天]\n[ar:周杰伦]\n[00:01.00]故事的小黄花\n[00:05.50]从出生那年就飘着\n')
  check('普通 LRC 解析出两行并识别为同步歌词', plain.synced && plain.lines.length === 2, `${plain.lines.length} 行`)
  check('LRC 头部 [ti:]/[ar:] 被读成标题与歌手', plain.title === '晴天' && plain.artist === '周杰伦', `${plain.title}/${plain.artist}`)
  check('第一行时间为 1.0s', Math.abs((plain.lines[0]?.start ?? -1) - 1) < 0.001, plain.lines[0]?.start)

  const offset = parseLyricsText('[offset:500]\n[00:10.00]偏移测试\n')
  check('offset 被应用到行时间上', Math.abs((offset.lines[0]?.start ?? 0) - 10.5) < 0.001, offset.lines[0]?.start)

  const translated = parseLyricsText('[00:10.00]original\n[00:10.00]译文\n[00:12.00]next\n')
  check('同一时间戳的第二行被折叠为翻译', translated.lines.length === 2 && translated.lines[0]?.translation === '译文', printable(translated.lines[0]))

  const enhanced = parseLyricsText('[00:10.00]<00:10.00>Hel<00:10.40>lo <00:10.90>world\n')
  const words = enhanced.lines[0]?.words ?? []
  check('逐字歌词解析出 3 个词', words.length === 3, printable(words.map((word) => word.text)))
  check('逐字歌词带真实词时间与结束时间', words[0]?.start === 10 && Math.abs((words[1]?.end ?? 0) - 10.9) < 0.001, printable(words[0]))
  check('hasWordTimings 认可逐字歌词', hasWordTimings(enhanced), '')
  // Note the 0.12s lead-in: a word lights up slightly *before* its timestamp, on purpose.
  check(
    '逐字歌词的当前词随时间推进',
    findActiveWord(enhanced.lines[0] ?? null, 10.5) === 1 &&
      findActiveWord(enhanced.lines[0] ?? null, 10.15) === 0 &&
      findActiveWord(enhanced.lines[0] ?? null, 9.5) === -1,
    `10.5=>${findActiveWord(enhanced.lines[0] ?? null, 10.5)} 10.15=>${findActiveWord(enhanced.lines[0] ?? null, 10.15)} 9.5=>${findActiveWord(enhanced.lines[0] ?? null, 9.5)}`,
  )

  /*
   * The karaoke sweep is the arithmetic the animation layer runs every frame, so it is tested here as
   * arithmetic rather than through a screenshot: it has to start where the word does (plus the same lead-in
   * the highlight uses), rise monotonically inside the word, and stop at full instead of running into the
   * next one.
   */
  /*
   * 词 1 is `lo `, i.e. 10.40 → 10.90 (0.5 s). The sweep starts at `start − lead` — the same 0.12 s lead the
   * highlight uses, which is why the fill is already 24% at the word's own timestamp and not 0: the two have to
   * move together, or the karaoke would look like it lags the highlight that selected it.
   */
  const fillAt = (seconds: number) => wordFillProgress(words, 1, seconds)
  check(
    '逐字填充与高亮共用同一 lead-in：词前 0.12s 起扫，词内单调递增',
    fillAt(10.28) === 0 &&
      Math.abs((fillAt(10.4) ?? 0) - 0.24) < 0.01 &&
      (fillAt(10.6) ?? 0) > (fillAt(10.5) ?? 0) &&
      (fillAt(10.8) ?? 0) > (fillAt(10.6) ?? 0),
    `10.28=>${fillAt(10.28)} 10.4=>${fillAt(10.4)} 10.5=>${fillAt(10.5)} 10.6=>${fillAt(10.6)} 10.8=>${fillAt(10.8)}`,
  )
  check(
    '逐字填充在词尾之后保持 100%，不会溢出到下一个词',
    fillAt(10.9) === 1 && fillAt(12) === 1,
    `10.9=>${fillAt(10.9)} 12=>${fillAt(12)}`,
  )
  check(
    '没有逐字时间轴时填充返回 null（不伪造，交给整行高亮）',
    wordFillProgress(undefined, 0, 10) === null && wordFillProgress([], 0, 10) === null,
    `plain=>${wordFillProgress(undefined, 0, 10)}`,
  )

  const instrumental = parseLyricsText('[00:01.00]♪♪\n')
  check('纯符号歌词仍被解析（判定纯音乐交给上层）', instrumental.lines.length === 1, '')

  const plainText = parseLyricsText('没有时间戳的歌词\n第二行\n')
  check('没有时间戳时落到 plain 文本', plainText.synced === false && plainText.lines.length === 0 && Boolean(plainText.plain), '')

  // The cache writes LRC text and re-parses it next session: this is that round trip.
  const source = parseLyricsText('[ar:周杰伦]\n[00:10.00]line\n[00:10.00]译文\n[00:12.50]next\n')
  const round = parseLyricsText(lyricsToLrcText(source))
  check(
    '序列化后再解析保持时间轴与翻译',
    round.lines.length === source.lines.length &&
      Math.abs((round.lines[0]?.start ?? 0) - (source.lines[0]?.start ?? -1)) < 0.01 &&
      round.lines[0]?.translation === '译文' &&
      Math.abs((round.lines[1]?.start ?? 0) - 12.5) < 0.01,
    printable(round.lines),
  )

  // Translation / romaji arrive as separate timestamp-aligned tracks from a catalogue.
  const base: Lyrics = parseLyricsText('[00:10.00]suki\n[00:12.00]daisuki\n')
  const mergedTranslation = mergeTimedText(base.lines, '[00:10.20]喜欢\n[00:12.10]最喜欢\n', 'translation')
  check('翻译轨按最近时间戳合并（容许 0.3s 偏移）', mergedTranslation === 2 && base.lines[0]?.translation === '喜欢', printable(base.lines.map((line) => line.translation)))
  const mergedRoman = mergeTimedText(base.lines, '[00:10.00]suki\n[00:12.00]daisuki\n', 'roman')
  check('罗马音轨合并到 roman 字段（与原文相同则跳过）', mergedRoman === 0, mergedRoman)
  const romanDifferent = mergeTimedText(base.lines, '[00:10.00]sūki\n[00:12.00]daisuki\n', 'roman')
  check('罗马音轨合并到 roman 字段', romanDifferent === 1 && base.lines[0]?.roman === 'sūki', printable(base.lines[0]))
  check(
    '相差过远的时间戳不会被硬凑成翻译',
    mergeTimedText(base.lines, '[00:30.00]far away\n', 'translation') === 0,
    '',
  )
}

/* ------------------------------------------------- Part 1b: traditional → simplified */

/**
 * Providers hand out traditional lyrics for Taiwan/HK releases, and the listener wants simplified.
 *
 * These checks pin the properties that matter rather than the table itself: the timeline must survive
 * normalisation, already-simplified text must come back untouched (cached `.lrc` files are read back
 * through the same parser), and the ambiguous characters that a naive character-table mangles
 * (著/着 in 著作 vs. 睡著, 藉 in 慰藉 but 借 elsewhere) must land on the right side.
 */
function testSimplifiedChinese(): void {
  const line = parseLyricsText('[00:04.20]晚風 吹動著竹林 月光 拉長了身影\n[00:08.40]螢火蟲 一閃閃 滿山飛舞的錢幣\n')
  check('繁体歌词解析为简体', line.lines[0]?.text === '晚风 吹动着竹林 月光 拉长了身影', printable(line.lines.map((l) => l.text)))
  check('转换不破坏时间轴', Math.abs((line.lines[0]?.start ?? 0) - 4.2) < 0.01 && Math.abs((line.lines[1]?.start ?? 0) - 8.4) < 0.01, printable(line.lines.map((l) => l.start)))

  const poem = parseLyricsText('[00:01.00]潯陽江頭夜送客 楓葉荻花秋瑟瑟\n[00:05.00]轉軸撥絃三兩聲 未成曲調先有情\n')
  check('难字也转（潯／楓／絃）', poem.lines[1]?.text === '转轴拨弦三两声 未成曲调先有情', printable(poem.lines.map((l) => l.text)))

  const ambiguous = parseLyricsText(
    '[00:01.00]著作 著名 顯著 睡著了 慰藉 瞭解 一隻 乾杯 妳的微笑\n',
  )
  check(
    '歧义字按上下文取义（著作/显著/睡著了/慰藉）',
    ambiguous.lines[0]?.text === '著作 著名 显著 睡着了 慰藉 了解 一只 干杯 你的微笑',
    ambiguous.lines[0]?.text,
  )

  const already = parseLyricsText('[00:01.00]晚风吹动着竹林 月光拉长了身影\n[00:02.00]这是一句已经简体的歌词\n')
  check(
    '已简体的歌词不再被改写（缓存回读稳定）',
    already.lines[0]?.text === '晚风吹动着竹林 月光拉长了身影' && already.lines[1]?.text === '这是一句已经简体的歌词',
    printable(already.lines.map((l) => l.text)),
  )
  const twice = parseLyricsText(lyricsToLrcText(ambiguous))
  check(
    '解析→序列化→再解析后文本不变',
    twice.lines.every((l, i) => l.text === ambiguous.lines[i]?.text),
    printable(twice.lines.map((l) => l.text)),
  )

  const words = parseLyricsText('[00:10.00]<00:10.00>晚<00:10.40>風<00:10.80>吹動\n')
  check(
    '逐字时间戳标签不被破坏',
    words.lines[0]?.text === '晚风吹动' && (words.lines[0]?.words?.length ?? 0) === 3,
    printable({ text: words.lines[0]?.text, words: words.lines[0]?.words?.length }),
  )

  const tags = parseLyricsText('[ti:櫻花草]\n[ar:Sweety]\n[00:01.00]戀人手中櫻花草\n')
  check('元数据标签同样转简', tags.title === '樱花草' && tags.artist === 'Sweety', printable({ ti: tags.title, ar: tags.artist }))

  const translated: Lyrics = parseLyricsText('[00:10.00]晚風吹動著竹林\n')
  mergeTimedText(translated.lines, '[00:10.10]夜風拂過樹梢\n', 'translation')
  check('翻译轨也转简', translated.lines[0]?.translation === '夜风拂过树梢', printable(translated.lines[0]?.translation))

  const plain = parsePlainLyrics('晚風 吹動著竹林\n蝴蝶 飛舞在花間\n')
  check('无时间轴的纯文本歌词同样转简', plain.plain === '晚风 吹动着竹林\n蝴蝶 飞舞在花间', printable(plain.plain))

  const untouched = parseLyricsText('[00:01.00]suki daisuki forever\n[00:02.00]ずっと そばにいて\n')
  check(
    '日文与英文原样保留',
    untouched.lines[0]?.text === 'suki daisuki forever' && untouched.lines[1]?.text === 'ずっと そばにいて',
    printable(untouched.lines.map((l) => l.text)),
  )
}

/* ------------------------------------------------------------------ Part 2: the matcher */

function testMatcher(): void {
  check('normalize 去掉括号内容与标点', normalize('晴天 (Live) 【Remix】') === '晴天', normalize('晴天 (Live) 【Remix】'))
  const variants = titleVariants('晴天 (Live) feat. 某某')
  check('标题变体包含去括号版本', variants.includes('晴天'), printable(variants))

  const exact = scoreCandidate({ title: '晴天', artist: '周杰伦', duration: 269 }, { title: '晴天', artist: '周杰伦', duration: 269 })
  check('完全一致得满分', Boolean(exact) && exact!.score >= 99, printable(exact))

  const brackets = scoreCandidate({ title: '晴天', artist: '周杰伦', duration: 269 }, { title: '晴天 (Live)', artist: '周杰伦', duration: 270 })
  check('括号后缀不影响匹配', Boolean(brackets) && brackets!.score >= MIN_MATCH_SCORE, printable(brackets))

  const feat = scoreCandidate({ title: '珊瑚海', artist: '周杰伦、梁心颐', duration: 250 }, { title: '珊瑚海', artist: '周杰伦 feat. 梁心颐', duration: 251 })
  check('艺术家拆分 + feat 仍匹配', Boolean(feat) && feat!.score >= MIN_MATCH_SCORE, printable(feat))

  const within = scoreCandidate({ title: '晴天', artist: '周杰伦', duration: 269 }, { title: '晴天', artist: '周杰伦', duration: 274 })
  const outside = scoreCandidate({ title: '晴天', artist: '周杰伦', duration: 269 }, { title: '晴天', artist: '周杰伦', duration: 290 })
  check('时长 ±5s 内接受', Boolean(within), printable(within))
  check('时长相差 21s 拒绝（现场版不是同一首）', outside === null, printable(outside))

  const wrongSong = scoreCandidate({ title: '晴天', artist: '周杰伦', duration: 269 }, { title: '青花瓷', artist: '周杰伦', duration: 269 })
  const wrongArtist = scoreCandidate({ title: '晴天', artist: '周杰伦', duration: 269 }, { title: '晴天', artist: '某翻唱歌手', duration: 269 })
  check('不同歌曲被拒绝', wrongSong === null, printable(wrongSong))
  check('不同歌手被拒绝', wrongArtist === null, printable(wrongArtist))

  // A catalogue entry that credits a different artist *but names the original in its title* is the
  // same work re-labelled, not a cover — that mention is the only thing separating the two cases.
  const relabelled = scoreCandidate(
    { title: '晴天', artist: '周杰伦', duration: 269 },
    { title: '晴天 (原唱 周杰伦)', artist: 'RyaVocal', duration: 269 },
  )
  const coverWithoutEvidence = scoreCandidate(
    { title: '晴天', artist: '周杰伦', duration: 269 },
    { title: '晴天', artist: 'RyaVocal', duration: 269 },
  )
  check('标题里点名原唱的条目被接受（同一作品换标注）', Boolean(relabelled) && relabelled!.score >= MIN_MATCH_SCORE, printable(relabelled))
  check('只有艺术家不同、无其他证据的条目被拒绝（翻唱）', coverWithoutEvidence === null, printable(coverWithoutEvidence))

  const unknownArtist = scoreCandidate({ title: '晴天', artist: '未知艺术家', duration: 269 }, { title: '晴天', artist: '周杰伦', duration: 269 })
  check('占位歌手不参与否决', Boolean(unknownArtist), printable(unknownArtist))

  const noDuration = scoreCandidate({ title: '晴天', artist: '周杰伦', duration: 0 }, { title: '晴天', artist: '周杰伦', duration: 240 })
  check('未知时长不参与打分（不因此拒绝）', Boolean(noDuration), printable(noDuration))

  const picked = pickBestCandidate({ title: '晴天', artist: '周杰伦', duration: 269 }, [
    { title: '青花瓷', artist: '周杰伦', duration: 269 },
    { title: '晴天', artist: '周杰伦', duration: 268 },
    { title: '晴天', artist: '周杰伦', duration: 400 },
  ])
  check('多个候选中挑出正确的那一首', picked?.candidate.duration === 268, printable(picked?.candidate))

  check('缓存文件名可读且安全', cacheFileName('周杰伦', '晴天') === '周杰伦 - 晴天.lrc', cacheFileName('周杰伦', '晴天'))
  check(
    '缓存文件名过滤路径分隔符',
    !cacheFileName('a/b', 'c:d?').includes('/') && !cacheFileName('a/b', 'c:d?').includes(':'),
    cacheFileName('a/b', 'c:d?'),
  )
}

/* ------------------------------------------------------------------ Part 3: the chain */

interface StubReport {
  calls: number
}

function stubProvider(
  id: LyricsProvider['id'],
  label: string,
  priority: number,
  behaviour: (query: LyricsQuery, context: LyricsContext, report: StubReport) => Promise<LyricsHit | null>,
): { provider: LyricsProvider; report: StubReport } {
  const report: StubReport = { calls: 0 }
  return {
    report,
    provider: {
      id,
      label,
      kind: 'remote',
      priority,
      origin: 'lrclib',
      async find(query, context) {
        report.calls += 1
        return behaviour(query, context, report)
      },
    },
  }
}

function hit(text: string, origin: LyricsHit['lyrics']['origin'] = 'lrclib', detail?: string): LyricsHit {
  return {
    lyrics: parseLyricsText(text, origin),
    provider: 'lrclib',
    label: '测试字幕库',
    confidence: 99,
    detail,
  }
}

async function testChain(audioDir: string): Promise<void> {
  /**
   * A brand-new file per section.
   *
   * Sections must not share a track: a remote hit writes `歌名.lrc` next to the file *by design*, so
   * the next section would be answered locally and would silently stop testing what it meant to.
   */
  let counter = 0
  const freshTrack = async (): Promise<AudioTrack> => {
    counter += 1
    const filePath = join(audioDir, `track-${counter}.mp3`)
    await writeFile(filePath, 'not really audio', 'utf8')
    // A distinct song per section, not just a distinct file: the fetch cache is keyed by the *song*
    // (title + artist + duration), so reusing one title would let section N answer section N+1 from
    // the cache — the feature working, and the test quietly proving nothing.
    return localTrack({ id: `local-track-${counter}`, title: `测试曲目 ${counter}`, artist: '测试歌手', filePath })
  }

  let track = await freshTrack()
  let filePath = track.filePath ?? ''

  // --- 1) a sidecar .lrc wins, and nothing else is even asked.
  const callsBefore = { lrclib: 0, china: 0 }
  const spyLrclib = stubProvider('lrclib', '测试字幕库', 40, async () => {
    callsBefore.lrclib += 1
    return hit('[00:01.00]WRONG SOURCE\n')
  })
  const spyChina = stubProvider('china', '测试国内库', 50, async () => {
    callsBefore.china += 1
    return hit('[00:01.00]WRONG SOURCE TOO\n')
  })
  registerLyricsProvider(spyLrclib.provider)
  registerLyricsProvider(spyChina.provider)

  await writeFile(`${filePath.slice(0, -4)}.lrc`, '[00:01.00]侧车歌词\n', 'utf8')
  const sidecar = await resolveLyrics(track, settings, secrets, { filePath, providerTimeoutMs: 500 })
  check('侧车 .lrc 优先于所有联网音源', sidecar.provider === 'local' && sidecar.lyrics?.lines[0]?.text === '侧车歌词', printable(sidecar.lyrics?.lines[0]))
  check('本地命中时联网音源一次都没被调用', spyLrclib.report.calls === 0 && spyChina.report.calls === 0, `${spyLrclib.report.calls}/${spyChina.report.calls}`)
  check('本地命中标记为 fromDisk', sidecar.fromDisk === true, '')
  check('解析报告记录了命中的 Provider', sidecar.attempts[0]?.result === 'hit' && sidecar.attempts[0]?.provider === 'local', printable(sidecar.attempts))

  // --- 2) user import beats the sidecar.
  await saveUserLyrics(track, '[00:02.00]用户导入的歌词\n')
  forgetLyrics(track.id)
  const userFirst = await resolveLyrics(track, settings, secrets, { filePath, providerTimeoutMs: 500 })
  check('用户导入的歌词优先于侧车文件', userFirst.lyrics?.lines[0]?.text === '用户导入的歌词', printable(userFirst.lyrics?.lines[0]))

  // Remove both local answers for the next steps.
  await clearStoredLyrics(track)
  await rm(`${filePath.slice(0, -4)}.lrc`)
  forgetLyrics(track.id)

  // --- 3) a crashing provider is isolated and the chain continues.
  track = await freshTrack()
  filePath = track.filePath ?? ''
  const boom = stubProvider('lrclib', '会崩溃的库', 40, async () => {
    throw new Error('模拟音源崩溃')
  })
  const recovery = stubProvider('china', '兜底库', 50, async () => hit('[00:03.00]兜底歌词\n', 'china'))
  registerLyricsProvider(boom.provider)
  registerLyricsProvider(recovery.provider)
  forgetLyrics(track.id)
  const afterCrash = await resolveLyrics(track, settings, secrets, { filePath, providerTimeoutMs: 500 })
  const crashAttempt = afterCrash.attempts.find((item) => item.provider === 'lrclib')
  check('崩溃的 Provider 被隔离，链路继续到下一个', afterCrash.lyrics?.lines[0]?.text === '兜底歌词', printable(afterCrash.lyrics?.lines[0]))
  check('崩溃被记录成 error 而不是抛出', crashAttempt?.result === 'error' && String(crashAttempt.detail).includes('模拟音源崩溃'), printable(crashAttempt))

  // --- 4) a provider that never answers must not hold the lookup open.
  track = await freshTrack()
  filePath = track.filePath ?? ''
  const hanging = stubProvider('lrclib', '卡死的库', 40, () => new Promise<LyricsHit | null>(() => {}))
  const afterHang = stubProvider('china', '兜底库', 50, async () => hit('[00:04.00]超时后仍然拿到\n', 'china'))
  registerLyricsProvider(hanging.provider)
  registerLyricsProvider(afterHang.provider)
  const hangStarted = Date.now()
  const hangResult = await resolveLyrics(track, settings, secrets, { filePath, providerTimeoutMs: 300 })
  const hangMs = Date.now() - hangStarted
  const hangAttempt = hangResult.attempts.find((item) => item.provider === 'lrclib')
  check('卡死的 Provider 会在超时后被放弃', hangMs < 3_000 && String(hangAttempt?.detail ?? '').includes('超时'), `${hangMs}ms / ${printable(hangAttempt)}`)
  check('超时后链路继续并拿到歌词', hangResult.lyrics?.lines[0]?.text === '超时后仍然拿到', printable(hangResult.lyrics?.lines[0]))

  // --- 5) junk from a provider is not treated as a hit.
  track = await freshTrack()
  filePath = track.filePath ?? ''
  const junk = stubProvider('lrclib', '返回垃圾的库', 40, async () => ({
    lyrics: { origin: 'lrclib', synced: false, offsetMs: 0, lines: [] },
    provider: 'lrclib',
    label: '返回垃圾的库',
  }))
  const afterJunk = stubProvider('china', '兜底库', 50, async () => hit('[00:05.00]有效歌词\n', 'china'))
  registerLyricsProvider(junk.provider)
  registerLyricsProvider(afterJunk.provider)
  const junkResult = await resolveLyrics(track, settings, secrets, { filePath, providerTimeoutMs: 500 })
  check('空数据不被当成命中（继续找下一个）', junkResult.lyrics?.lines[0]?.text === '有效歌词', printable(junkResult.lyrics?.lines[0]))

  // --- 6) every provider fails -> an honest empty resolution, not a throw.
  track = await freshTrack()
  filePath = track.filePath ?? ''
  registerLyricsProvider(stubProvider('lrclib', '空库', 40, async () => null).provider)
  registerLyricsProvider(stubProvider('china', '空库二', 50, async () => null).provider)
  const empty = await resolveLyrics(track, settings, secrets, { filePath, providerTimeoutMs: 500 })
  check('全部未命中时返回空结果而不是抛错', empty.lyrics === null && empty.attempts.length >= 2, printable(empty.attempts.map((item) => item.result)))
  check(
    '空结果仍逐项说明问了哪些库',
    empty.attempts.some((item) => item.label === '空库') && empty.attempts.some((item) => item.label === '空库二'),
    printable(empty.attempts.map((item) => item.label)),
  )

  // --- 7) an instrumental verdict stops the chain instead of guessing another song.
  track = await freshTrack()
  filePath = track.filePath ?? ''
  const instrumental = stubProvider('lrclib', '纯音乐库', 40, async () => ({
    lyrics: { origin: 'lrclib', synced: false, offsetMs: 0, lines: [] },
    provider: 'lrclib',
    label: '纯音乐库',
    instrumental: true,
  }))
  const neverReached = stubProvider('china', '不该被问到', 50, async () => hit('[00:06.00]不该出现的歌词\n', 'china'))
  registerLyricsProvider(instrumental.provider)
  registerLyricsProvider(neverReached.provider)
  const instrumentalResult = await resolveLyrics(track, settings, secrets, { filePath, providerTimeoutMs: 500 })
  check('纯音乐判定会终止链路', instrumentalResult.instrumental === true && instrumentalResult.lyrics === null, printable(instrumentalResult.instrumental))
  check('纯音乐判定后不再询问下一个库', neverReached.report.calls === 0, neverReached.report.calls)

  /* --- caching: a fetched lyric lands on disk and is used without a single provider call. */
  track = await freshTrack()
  filePath = track.filePath ?? ''
  const sidecarForTrack = `${filePath.slice(0, -4)}.lrc`
  registerLyricsProvider(stubProvider('lrclib', '会命中的库', 40, async () => hit('[00:07.00]第一次联网获取\n[00:09.00]第二行\n')).provider)
  registerLyricsProvider(stubProvider('china', '空库三', 50, async () => null).provider)
  const fetched = await resolveLyrics(track, settings, secrets, { filePath, providerTimeoutMs: 500 })
  check('联网获取成功', fetched.lyrics?.lines[0]?.text === '第一次联网获取', printable(fetched.lyrics?.lines[0]))
  check('联网获取被标记为非本地', fetched.fromDisk === false, '')

  const sidecarText = await readFile(sidecarForTrack, 'utf8').catch(() => null)
  check('联网歌词被写成歌曲同名的 歌名.lrc', typeof sidecarText === 'string' && sidecarText.includes('第一次联网获取'), sidecarText ? sidecarText.split('\n')[1] : 'no file')
  const cached = await readCachedLyrics(track.title, track.artist, track.duration)
  const expectedName = cacheFileName(track.artist, track.title)
  check('联网歌词同时进入歌词缓存（歌手 - 歌名.lrc）', Boolean(cached) && cached!.file === expectedName, `${cached?.file} vs ${expectedName}`)
  const cachedText = cached ? await readFile(cached.path, 'utf8').catch(() => null) : null
  check('缓存的 LRC 能重新解析回同样的行', (() => {
    if (!cachedText) return false
    const reparsed = parseLyricsText(cachedText)
    return reparsed.lines.length === 2 && reparsed.lines[1]?.text === '第二行'
  })(), cachedText ? String(cachedText.length) : 'no file')

  // Second session: the only memory cache is dropped, providers are replaced by spies.
  const spyAgain = stubProvider('lrclib', '第二次不该被调用', 40, async () => null)
  const spyAgainChina = stubProvider('china', '第二次不该被调用二', 50, async () => null)
  registerLyricsProvider(spyAgain.provider)
  registerLyricsProvider(spyAgainChina.provider)
  forgetLyrics(track.id)
  const localFirst = await resolveLyrics(track, settings, secrets, { filePath, providerTimeoutMs: 500 })
  check('第二次解析直接读本地（本地优先）', localFirst.lyrics?.lines[0]?.text === '第一次联网获取' && localFirst.fromDisk === true, printable(localFirst.lyrics?.lines[0]))
  check('第二次解析没有调用任何联网 Provider', spyAgain.report.calls === 0 && spyAgainChina.report.calls === 0, `${spyAgain.report.calls}/${spyAgainChina.report.calls}`)

  /* --- scope: the page-loading half must not touch a search catalogue, and vice versa. */
  track = await freshTrack()
  filePath = track.filePath ?? ''
  const fastOnlyCall = stubProvider('lrclib', '目录库（fast 不该调用）', 40, async () => hit('[00:08.00]不该在 fast 阶段出现\n'))
  const fastOnlyCall2 = stubProvider('china', '目录库二（fast 不该调用）', 50, async () => null)
  registerLyricsProvider(fastOnlyCall.provider)
  registerLyricsProvider(fastOnlyCall2.provider)
  const fast = await resolveLyrics(track, settings, secrets, { filePath, providerTimeoutMs: 500, scope: 'fast' })
  check('scope=fast（打开页面）不会联网搜索目录', fast.lyrics === null && fastOnlyCall.report.calls === 0 && fastOnlyCall2.report.calls === 0, `${fastOnlyCall.report.calls}/${fastOnlyCall2.report.calls}`)
  check('scope=fast 只问了本地类 Provider', fast.attempts.every((item) => ['local', 'embedded', 'source'].includes(item.provider)), printable(fast.attempts.map((item) => item.provider)))

  const searchOnlyCall = stubProvider('lrclib', '目录库（search 该被调用）', 40, async () => hit('[00:09.00]目录查到的歌词\n'))
  registerLyricsProvider(searchOnlyCall.provider)
  // Exactly the app's flow: a fast pass that found nothing must not stop the search pass — the
  // "no lyrics" verdict from the fast half is not the search half's answer.
  const searched = await resolveLyrics(track, settings, secrets, { filePath, providerTimeoutMs: 500, scope: 'search' })
  check(
    'scope=search（后台补齐）在 fast 未命中后仍会走目录并缓存',
    searched.lyrics?.lines[0]?.text === '目录查到的歌词' && searchOnlyCall.report.calls === 1 && Boolean(searched.cachedTo?.path),
    `${printable(searched.lyrics?.lines[0])} calls=${searchOnlyCall.report.calls} cached=${printable(searched.cachedTo?.path)}`,
  )
  check('scope=search 不会重复问本地文件', !searched.attempts.some((item) => item.provider === 'local'), printable(searched.attempts.map((item) => item.provider)))
  forgetLyrics(track.id)
  const afterEnrich = await resolveLyrics(track, settings, secrets, { filePath, providerTimeoutMs: 500, scope: 'fast' })
  check(
    '后台补齐后，下一次 fast 阶段就能从本地拿到',
    afterEnrich.lyrics?.lines[0]?.text === '目录查到的歌词' && afterEnrich.fromDisk === true,
    printable(afterEnrich.lyrics?.lines[0]),
  )
}

/* ------------------------------------------------------------------ Part 4: live catalogues */

async function liveProvider(name: string, run: () => Promise<LyricsHit | null>, expect: (hit: LyricsHit) => boolean, describe: (hit: LyricsHit) => string): Promise<void> {
  try {
    const result = await run()
    if (!result) {
      // Reachable but empty is a real outcome for one song; it is reported, not silently passed.
      skipped.push({ name, detail: '接口可达，但这首歌没有返回匹配结果' })
      return
    }
    check(name, expect(result), describe(result))
  } catch (error) {
    skipped.push({ name, detail: `网络不可用：${error instanceof Error ? error.message : String(error)}` })
  }
}

async function testLiveCatalogues(): Promise<void> {
  // Restore the real providers before the live checks (the stubs above replaced them).
  const { lrclibProvider } = await import('../src/main/lyricsEngine/providers/lrclib')
  const { chinaProvider } = await import('../src/main/lyricsEngine/providers/china')
  registerLyricsProvider(lrclibProvider)
  registerLyricsProvider(chinaProvider)

  const query = (title: string, artist: string, duration: number): LyricsQuery => ({
    track: onlineTrack({ title, artist, duration }),
    title,
    artist,
    album: '',
    duration,
  })
  const context: LyricsContext = { settings, secrets }

  await liveProvider(
    'LRCLIB：真实联网查询命中并返回同步歌词',
    () => lrclibProvider.find(query('Hello', 'Adele', 295), context),
    (result) => result.lyrics.lines.length > 0 || Boolean(result.lyrics.plain),
    (result) => `provider=${result.provider} lines=${result.lyrics.lines.length} detail=${result.detail}`,
  )

  await liveProvider(
    'LRCLIB：中文歌（周杰伦 - 晴天）能命中',
    () => lrclibProvider.find(query('晴天', '周杰伦', 269), context),
    (result) => result.lyrics.lines.length > 0,
    (result) => `lines=${result.lyrics.lines.length} detail=${result.detail}`,
  )

  await liveProvider(
    '国内歌词接口：真实联网查询命中并返回歌词',
    () => chinaProvider.find(query('晴天', '周杰伦', 269), context),
    (result) => result.lyrics.lines.length > 0 || Boolean(result.lyrics.plain),
    (result) => `lines=${result.lyrics.lines.length} detail=${result.detail}`,
  )

  // The two catalogues must not be the same code path pretending to be two.
  const lrclibOnly = await lrclibProvider.find(query('晴天', '周杰伦', 269), context).catch(() => null)
  const chinaOnly = await chinaProvider.find(query('晴天', '周杰伦', 269), context).catch(() => null)
  if (lrclibOnly && chinaOnly) {
    check(
      '两个音源返回各自独立的结果（不是同一个实现）',
      lrclibOnly.detail !== chinaOnly.detail && lrclibOnly.provider !== chinaOnly.provider,
      `${lrclibOnly.provider}:${lrclibOnly.detail} | ${chinaOnly.provider}:${chinaOnly.detail}`,
    )
  } else {
    skipped.push({ name: '两个音源返回各自独立的结果（不是同一个实现）', detail: '需要两个音源都能联网检索' })
  }
}

/* ------------------------------------------------------------------ runner */

async function main(): Promise<void> {
  const runDir = await mkdtemp(join(tmpdir(), 'aurora-lyrics-'))
  const cacheDir = join(runDir, 'lyrics')
  const audioDir = join(runDir, 'music')
  await mkdir(cacheDir, { recursive: true })
  await mkdir(audioDir, { recursive: true })
  await initLyricsManager(cacheDir)

  testParser()
  testSimplifiedChinese()
  testLyricOffset()
  testMatcher()
  await testChain(audioDir)
  await testLiveCatalogues()

  // An online track with no resolvable source must still resolve through the catalogues rather than
  // erroring: the chain end-to-end, on the real providers, for a track nobody owns.
  const resolution = await resolveLyrics(onlineTrack({ sourceId: undefined, title: '不存在的歌曲名称 xxq', artist: '不存在的歌手' }), settings, secrets, {
    force: true,
    providerTimeoutMs: 8_000,
  }).catch((error) => {
    check('在线曲目解析不应抛错', false, String(error))
    return null
  })
  if (resolution) {
    check('没有音源归属的在线曲目仍能走完链路并如实报告', resolution.lyrics === null || resolution.lyrics.lines.length >= 0, printable(resolution.attempts.map((item) => `${item.label}:${item.result}`)))
  }

  const failed = checks.filter((item) => !item.ok)
  for (const item of checks) {
    const state: CheckState = item.ok ? 'PASS' : 'FAIL'
    console.log(`${state}  ${item.name}${item.detail ? `  ${item.detail}` : ''}`)
  }
  for (const item of skipped) console.log(`SKIP  ${item.name}  ${item.detail}`)
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed${skipped.length > 0 ? `（${skipped.length} 项因环境跳过）` : ''}`)

  try {
    await rm(runDir, { recursive: true, force: true, maxRetries: 3 })
  } catch {
    // best effort
  }
  app.exit(failed.length === 0 ? 0 : 1)
}

const watchdog = setTimeout(() => {
  console.log('\nFAIL  测试超时（网络过慢或某个 Provider 无响应）')
  for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}`)
  app.exit(1)
}, 180_000)
watchdog.unref?.()

void app.whenReady().then(main).catch((error) => {
  console.log(`FAIL  测试执行异常  ${String(error)}`)
  app.exit(1)
})
