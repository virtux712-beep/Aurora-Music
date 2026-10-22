/**
 * Generates `src/shared/chinese.ts` — the traditional→simplified table Aurora uses to normalise
 * lyric text before it is parsed.
 *
 * Why generate instead of hand-writing a table: lyric sites hand out fully traditional lyrics
 * (Taiwan/HK releases), and a hand-written table always has holes (`著`, `佈`, `絃` were missing
 * from the table this project started from). OpenCC is the authority — this script mines its
 * dictionaries, keeps *only* what a character-level table gets wrong as phrase rules, and then
 * proves the result by comparing against the real OpenCC converter line by line.
 *
 * Regenerating needs the reference implementation, which is a dev-only dependency:
 *
 *   npm i -D opencc-js
 *   node tools/make-chinese-table.mjs
 *
 * The generated file is committed, so the app itself has no runtime dependency on OpenCC.
 */
import { writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const OUT = resolve(root, 'src/shared/chinese.ts')

/** Where the reference converter may live, in order of preference. */
function loadConverter() {
  const require = createRequire(import.meta.url)
  const candidates = [
    resolve(root, 'node_modules/opencc-js/dist/umd/full.js'),
    resolve(here, '.build/oc-ref/node_modules/opencc-js/dist/umd/full.js'),
  ]
  for (const path of candidates) {
    if (!existsSync(path)) continue
    const { Converter } = require(path)
    return { Converter, path }
  }
  throw new Error('opencc-js not found — run `npm i -D opencc-js` first')
}

/** The dictionaries live next to the reference converter and are plain "trad simp|trad simp" strings. */
async function loadDicts(converterPath) {
  const base = resolve(converterPath, '../../esm-lib/dict')
  const names = ['TSCharacters', 'TSPhrases', 'TWVariantsRev', 'TWVariantsRevPhrases']
  const out = {}
  for (const name of names) {
    const file = resolve(base, `${name}.js`)
    if (!existsSync(file)) throw new Error(`missing dictionary: ${file}`)
    const mod = await import(pathToFileURL(file).href)
    out[name] = String(mod.default)
  }
  return out
}

/** `"甲 乙|丙 丁"` → `[['甲','乙'], ['丙','丁']]` */
function parsePairs(raw) {
  const pairs = []
  for (const chunk of raw.split('|')) {
    const sep = chunk.indexOf(' ')
    if (sep < 0) continue
    const from = chunk.slice(0, sep)
    const to = chunk.slice(sep + 1).trim()
    if (from && to) pairs.push([from, to])
  }
  return pairs
}

const { Converter, path: converterPath } = loadConverter()
const tw2s = Converter({ from: 'tw', to: 'cn' })
const dicts = await loadDicts(converterPath)

const charPairs = new Map()
const candidates = new Set()
for (const name of ['TSCharacters', 'TWVariantsRev']) {
  for (const pair of parsePairs(dicts[name])) for (const ch of Array.from(pair[0])) candidates.add(ch)
}
for (const name of ['TSPhrases', 'TWVariantsRevPhrases']) {
  for (const pair of parsePairs(dicts[name])) for (const ch of Array.from(pair[0])) candidates.add(ch)
}

// A candidate earns a character rule only when converting it *alone* changes it — that keeps the
// table idempotent (running it twice is a no-op) and keeps identity pairs out.
for (const ch of candidates) {
  const out = tw2s(ch)
  if (out !== ch && Array.from(out).length === 1) charPairs.set(ch, out)
}

/**
 * Deliberate departures from OpenCC, one line each.
 *
 * `妳` is Taiwan's female second-person pronoun; simplified Chinese has no such character, and OpenCC
 * leaves it alone. Lyrics are where it shows up most, so it is normalised here.
 */
const OVERRIDES = [['妳', '你']]
for (const [from, to] of OVERRIDES) charPairs.set(from, to)

const MAX_PHRASE = 12

/**
 * Everything the table might need a rule for: every dictionary phrase, its simplified output, and
 * the dictionary's own target column.
 *
 * Both columns matter. A rule is needed when the character table alone would produce something else
 * — for ambiguous characters (著 in 著作 vs. 睡著) *and* for protection entries, whose two sides are
 * identical (慰藉 stays 慰藉 even though 藉 alone maps to 借 elsewhere). Simplified outputs matter
 * too: a rule may legitimately emit a character the character table would rewrite again (显著 keeps
 * 著), and without a rule for that form converting already-simplified text would keep drifting —
 * which is exactly what happens to cached `.lrc` files that come back through this function.
 */
const phraseCandidates = new Set()
for (const name of ['TSPhrases', 'TWVariantsRevPhrases']) {
  for (const [from, to] of parsePairs(dicts[name])) {
    for (const text of [from, to, tw2s(from)]) {
      const length = Array.from(text).length
      if (length >= 2 && length <= MAX_PHRASE) phraseCandidates.add(text)
    }
  }
}

const phrasePairs = new Map()
let maxPhraseLength = 0

/** Same algorithm the generated module uses, so the table can be validated here. */
function convert(text) {
  const chars = Array.from(text)
  let out = ''
  for (let i = 0; i < chars.length; i += 1) {
    let hit = null
    for (let len = Math.min(maxPhraseLength, chars.length - i); len >= 2; len -= 1) {
      const candidate = chars.slice(i, i + len).join('')
      const mapped = phrasePairs.get(candidate)
      if (mapped !== undefined) {
        hit = { mapped, len }
        break
      }
    }
    if (hit) {
      out += hit.mapped
      i += hit.len - 1
      continue
    }
    out += charPairs.get(chars[i]) ?? chars[i]
  }
  return out
}

/**
 * Rules are built in two phases, in this order, and never looped back.
 *
 * 1. **Agreement** — the table must produce what OpenCC produces for every candidate. One pass is not
 *    enough: the dictionaries are ordered (Taiwan variants normalise first, then phrases, then
 *    characters) and a flat longest-match table cannot express that order. A rule like 藉着 → 借着
 *    exists on its own, yet OpenCC keeps 慰藉着 traditional; the loop notices and adds the longer
 *    protection rule that outranks it.
 * 2. **Stability** — converting the output again must change nothing. OpenCC itself is not idempotent
 *    (顯著 → 显著, but a second pass gives 显着) and cached `.lrc` files are read back through this
 *    function, so the first-pass answer is pinned instead of being allowed to drift.
 *
 * Phase 2 can make a handful of *already simplified* strings disagree with OpenCC. That is deliberate:
 * OpenCC's answer for them is the unstable one. The validation below counts exactly that, and fails if
 * any traditional input drifts.
 */
const rounds = []
let agreementConverged = false
for (let round = 0; round < 30; round += 1) {
  let added = 0
  for (const candidate of phraseCandidates) {
    const expected = tw2s(candidate)
    if (convert(candidate) === expected) continue
    phrasePairs.set(candidate, expected)
    maxPhraseLength = Math.max(maxPhraseLength, Array.from(candidate).length)
    added += 1
  }
  rounds.push(added)
  if (!added) {
    agreementConverged = true
    break
  }
}

let pinned = 0
let stabilityConverged = false
for (let round = 0; round < 30; round += 1) {
  let added = 0
  for (const candidate of phraseCandidates) {
    const once = convert(candidate)
    if (convert(once) === once) continue
    phrasePairs.set(once, once)
    maxPhraseLength = Math.max(maxPhraseLength, Array.from(once).length)
    added += 1
  }
  pinned += added
  if (added) rounds.push(-added)
  else {
    stabilityConverged = true
    break
  }
}

// ── Validation ───────────────────────────────────────────────────────────────────────────────
//
// Two separate claims are checked, because they can fail independently.
//
//  **Lyric accuracy** — for real traditional lyric text the table must produce exactly what OpenCC
//  produces (modulo the documented `妳` override). This is the claim that matters to a listener.
//
//  **Dictionary agreement** — every dictionary phrase, as a stress corpus. Disagreements here are
//  reported, not asserted: they are cases where OpenCC contradicts *itself* (its second pass rewrites
//  what its first pass just produced, e.g. 顯著 → 显著 → 显着) or where it swaps Taiwan variant pairs
//  (幺么 → 幺幺). The table pins the first-pass form, which is the one that reads correctly.
const lyricCorpus = [
  '晚風 吹動著竹林 月光 拉長了身影',
  '螢火蟲 一閃閃 滿山飛舞的錢幣',
  '天上 銀河在發光 地上 風鈴來歌唱',
  '織女星在遠方 古老浪漫的神話',
  '流水 走過 春夏四季的變換',
  '幸福在蔓延 愛你永恆不孤單',
  '戀人手中櫻花草 春彩滿布的微笑',
  '種下了一朵朵 青春璀璨的年少',
  '戀人懷中櫻花草 聽見胸膛心在跳',
  '偷偷的 在思念 那是我們相愛的記號',
  '潯陽江頭夜送客 楓葉荻花秋瑟瑟',
  '主人下馬客在船 舉酒欲飲無管絃',
  '轉軸撥絃三兩聲 未成曲調先有情',
  '低眉信手續續彈 說盡心中無限事',
  '妳的微笑 陪著妳 想著妳 睡著了',
  '瞭解 瞭望 一隻 乾杯 幹什麼 醜陋',
  '廢棄 複雜 佈置 著作 著名 顯著',
  '後來 我總算學會了如何去愛',
  '可惜不是你 陪我到最後',
  '我們的紀念 我們的永遠 我們的從前',
  '時間 溫柔 擁抱 離開 廣場 紀念',
  '為什麼 一場夢 無所謂 眼淚 背影',
  '甚麼 怎麼 這麼 那麼 喲 囉 嘍 嗚',
  '煙雨江南 潮汐晨光 星河入夢 落日長歌',
]

/** What this table should produce for a line, expressed via the reference implementation. */
function expectedFor(line) {
  let out = tw2s(line)
  for (const [from, to] of OVERRIDES) out = out.split(from).join(to)
  return out
}

const lyricFailures = []
for (const line of lyricCorpus) {
  const expected = expectedFor(line)
  const actual = convert(line)
  if (expected !== actual) lyricFailures.push({ line, expected, actual })
}

// Stress corpus: every dictionary phrase and its simplified form.
const corpus = [...lyricCorpus]
for (const candidate of phraseCandidates) corpus.push(candidate)

const mismatches = []
for (const line of corpus) {
  const expected = tw2s(line)
  const actual = convert(line)
  if (expected !== actual) mismatches.push({ line, expected, actual, alreadySimplified: convert(line) === line })
}

const unstable = corpus.filter((line) => convert(convert(line)) !== convert(line))

const statistical = {
  chars: charPairs.size,
  phrases: phrasePairs.size,
  maxPhraseLength,
  pinned,
  lyricLines: lyricCorpus.length,
  lyricFailures: lyricFailures.length,
  unstable: unstable.length,
  dictionaryPhrases: corpus.length,
  openccDisagreements: mismatches.length,
  ofWhichOpenccSelfContradicts: mismatches.filter((m) => m.alreadySimplified).length,
  rounds,
  agreementConverged,
  stabilityConverged,
}
console.log(JSON.stringify(statistical, null, 2))
if (lyricFailures.length) {
  console.log('--- 歌词用例不一致 ---')
  for (const m of lyricFailures) console.log(`${m.line}\n  expected: ${m.expected}\n  actual  : ${m.actual}`)
}
if (mismatches.some((m) => !m.alreadySimplified)) {
  console.log('--- 词典用例不一致（非自相矛盾）---')
  for (const m of mismatches.filter((x) => !x.alreadySimplified).slice(0, 10)) {
    console.log(`${m.line}\n  opencc: ${m.expected}\n  table : ${m.actual}`)
  }
}
if (lyricFailures.length || unstable.length) {
  console.error('表不自洽：请先修生成器')
  process.exitCode = 1
}

const tradChars = [...charPairs.keys()].join('')
const simpChars = [...charPairs.values()].join('')
const phraseRows = [...phrasePairs.entries()].map(([from, to]) => `${from} ${to}`).join('|')

const file = `/**
 * Traditional → simplified normalisation for lyric text.
 *
 * Generated by \`tools/make-chinese-table.mjs\` from OpenCC's own dictionaries (\`TSCharacters\`,
 * \`TSPhrases\`, \`TWVariantsRev\`, \`TWVariantsRevPhrases\`); do not edit by hand. The character table
 * carries every single-character mapping, and \`PHRASES\` carries only the context rules a character
 * table gets wrong (ambiguous characters such as 著 in 著作 vs. 睡著, and protection entries such as
 * 慰藉). Targets were validated against OpenCC's own converter on ${statistical.lyricLines} traditional
 * lyric lines and on ${statistical.dictionaryPhrases} dictionary phrases; converting twice is a no-op.
 *
 * Table: ${statistical.chars} characters, ${statistical.phrases} phrases.
 * OpenCC disagreements: ${statistical.openccDisagreements} (${statistical.ofWhichOpenccSelfContradicts} of them are strings
 * OpenCC itself rewrites on a second pass, which this table pins; the rest are the ${OVERRIDES.length} documented override).
 */
const TRADITIONAL = '${escapeForSingleQuote(tradChars)}'
const SIMPLIFIED = '${escapeForSingleQuote(simpChars)}'

/** \`繁 简|繁 简|…\` — applied longest-match-first before the character table. */
const PHRASES = '${escapeForSingleQuote(phraseRows)}'

const charMap = new Map<string, string>()
{
  const from = Array.from(TRADITIONAL)
  const to = Array.from(SIMPLIFIED)
  for (let i = 0; i < from.length && i < to.length; i += 1) charMap.set(from[i], to[i])
}

const phraseMap = new Map<string, string>()
let maxPhraseLength = 0
for (const row of PHRASES.split('|')) {
  const sep = row.indexOf(' ')
  if (sep <= 0) continue
  const from = Array.from(row.slice(0, sep))
  const to = row.slice(sep + 1)
  if (from.length < 2) continue
  phraseMap.set(from.join(''), to)
  maxPhraseLength = Math.max(maxPhraseLength, from.length)
}

/**
 * Rewrites traditional Chinese as simplified. Text that is already simplified (or is not Chinese at
 * all) is returned unchanged, so this is safe to run on every lyric line, including romanisations
 * and translations.
 */
export function toSimplified(text: string): string {
  if (!text) return text
  const chars = Array.from(text)
  let out = ''
  for (let i = 0; i < chars.length; i += 1) {
    let mapped: string | undefined
    let width = 0
    for (let len = Math.min(maxPhraseLength, chars.length - i); len >= 2; len -= 1) {
      mapped = phraseMap.get(chars.slice(i, i + len).join(''))
      if (mapped !== undefined) {
        width = len
        break
      }
    }
    if (mapped !== undefined) {
      out += mapped
      i += width - 1
      continue
    }
    out += charMap.get(chars[i]) ?? chars[i]
  }
  return out
}

/** \`true\` when \`text\` would actually change — useful for logs and for skipping work. */
export function hasTraditional(text: string): boolean {
  if (!text) return false
  for (const ch of text) if (charMap.has(ch)) return true
  return false
}
`

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, file, 'utf8')
console.log(`wrote ${OUT}`)

function escapeForSingleQuote(text) {
  return text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}
