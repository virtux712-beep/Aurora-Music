/**
 * Smoke test for Aurora's theme system (`src/shared/theme.ts`, `src/renderer/src/theme/`).
 *
 * A theme is data that ends up inside a `<style>` element, so the parts worth testing are the parts
 * that decide what may enter one:
 *
 *  - **Part 1** — the validator: a theme whose colour value can close a declaration or open a block is
 *    rejected *with the offending field named*, while an honest theme (including one that only
 *    overrides two tokens) is accepted.
 *  - **Part 2** — token derivation, for every built-in skin in both modes: the full set is produced,
 *    surfaces stay distinguishable from the page, text keeps a real contrast ratio, and every emitted
 *    value is one the validator would accept — i.e. what the generator writes, the parser allows.
 *  - **Part 3** — CSS generation: the default skin emits nothing (it *is* the base stylesheet), each
 *    skin emits a dark and a light block under the right selectors, and no block is malformed.
 *  - **Part 4** — the native chrome: every skin hands main a strip colour that matches its own
 *    background and a symbol colour that actually contrasts with that strip.
 *  - **Part 5** — the user-theme path end to end: a file written to disk, parsed, validated and turned
 *    into CSS through the same code the built-ins use, plus the failure cases (bad id, duplicate id,
 *    injection attempt) each reported as a *specific* reason.
 *
 * Deterministic and offline: no network, no Electron, no window.
 *
 * Run with: npm run smoke:theme
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseThemeDefinition, type ThemeDefinition } from '../src/shared/theme'
import { BUILT_IN_SKIN_IDS } from '../src/shared/skinIds'
import { readFileSync } from 'node:fs'
import { BUILT_IN_SKINS, buildTokens, findBuiltInSkin, skinChrome } from '../src/renderer/src/theme/skins'
import {
  isHexColor,
  isLyricColorMode,
  LYRIC_COLOR_MODES,
  LYRIC_COLOR_OPTIONS,
  type LyricColorMode,
} from '../src/shared/lyricInk'
import {
  LEVELS,
  LEVEL_ORDER,
  applyEffects,
  AUTO_LEVEL_KEY,
  downgrade,
  LEVEL_KEY,
  levelSlot,
  planEffects,
  resolveStoredLevel,
  upgrade,
} from '../src/renderer/src/theme/effects'
import type { AnimationLevel } from '../src/shared/theme'
import { themeCss } from '../src/renderer/src/theme/apply'
import { luminance } from '../src/renderer/src/theme/palette'

const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
const check = (name: string, ok: boolean, detail?: unknown): void => {
  checks.push({ name, ok, detail: detail === undefined ? undefined : String(detail) })
}

/** Every token a skin *may* emit. Anything in a generated set must live in here. */
const ALLOWED_TOKENS = new Set([
  '--bg',
  '--bg-glow',
  '--ambient-a',
  '--ambient-b',
  '--panel',
  '--panel-soft',
  '--card',
  '--card-soft',
  '--line',
  '--line-strong',
  '--text',
  '--muted',
  '--faint',
  '--accent',
  '--accent-strong',
  '--accent-soft',
  '--accent-line',
  '--danger',
  '--success',
  '--warn',
  '--glass',
  '--glass-strong',
  '--glass-line',
  '--player-bg',
  '--shadow',
  '--shadow-soft',
])

/** The same allowlist the validator uses — a generated value must be one the parser would accept. */
const SAFE_VALUE = /^[#a-z0-9(),.%\s/+-]+$/i

/** sRGB relative luminance contrast ratio, per WCAG. */
function contrast(a: string, b: string): number {
  const first = luminance(a)
  const second = luminance(b)
  const [high, low] = first > second ? [first, second] : [second, first]
  return (high + 0.05) / (low + 0.05)
}

/** `#rrggbb` → three channels. Returns null for anything else, so callers can report it honestly. */
function channels(color: string): [number, number, number] | null {
  const match = color.match(/^#([0-9a-f]{6})$/i)
  if (!match) return null
  const int = Number.parseInt(match[1] as string, 16)
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255]
}

/* ------------------------------------------------------------------ Part 1: the validator */

function part1(): void {
  const base = {
    id: 'unit-theme',
    name: '单元主题',
    dark: { '--bg': '#101018' },
    light: { '--bg': '#f6f6fb' },
  }

  const ok = parseThemeDefinition(base)
  check('合法主题被接受，并保留未声明的字段默认值', 'theme' in ok && ok.theme.effects.particles === 'none', 'theme' in ok ? JSON.stringify(ok.theme.effects) : ok.error)

  const onlyBg = parseThemeDefinition({ ...base, id: 'minimal', dark: { '--bg': '#000000' }, light: { '--bg': '#ffffff' } })
  check(
    '只覆盖一个变量的主题也能用（其余交给基础色板）',
    'theme' in onlyBg && Object.keys(onlyBg.theme.dark).length === 1,
    'theme' in onlyBg ? JSON.stringify(onlyBg.theme.dark) : onlyBg.error,
  )

  const injections = [
    { value: 'red; } body { display: none', label: '声明逃逸' },
    { value: 'url(evil.example.com)', label: '外链取值' },
    { value: '#fff /*', label: '注释未闭合' },
  ]
  for (const attempt of injections) {
    const result = parseThemeDefinition({ ...base, id: 'inject', dark: { '--bg': attempt.value } })
    check(
      `注入被拒绝并指出字段（${attempt.label}）`,
      'error' in result && result.error.includes('--bg'),
      'error' in result ? result.error : 'accepted',
    )
  }

  const badName = parseThemeDefinition({ ...base, id: 'bad name!' })
  check('非法 id 被拒绝', 'error' in badName && badName.error.includes('id'), 'error' in badName ? badName.error : 'accepted')

  const badVar = parseThemeDefinition({ ...base, id: 'bad-var', dark: { 'background': '#000' } })
  check(
    '非自定义属性名被拒绝（不是每个 CSS 名都能当 token）',
    'error' in badVar && badVar.error.includes('background'),
    'error' in badVar ? badVar.error : 'accepted',
  )

  const huge = parseThemeDefinition({
    ...base,
    id: 'huge',
    dark: Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`--t${index}`, '#000000'])),
  })
  check('变量数量上限生效（防止把主题当样式表用）', 'error' in huge && huge.error.includes('过多'), 'error' in huge ? huge.error : 'accepted')

  const longValue = parseThemeDefinition({ ...base, id: 'long', dark: { '--bg': `#${'a'.repeat(200)}` } })
  check('超长取值被拒绝', 'error' in longValue, 'error' in longValue ? longValue.error : 'accepted')

  const clamped = parseThemeDefinition({
    ...base,
    id: 'clamp',
    effects: { particles: 'stars', density: 99, speed: -5, driftSeconds: 1, glow: 9 },
  })
  check(
    '动效参数被钳制而不是直接信任（99 → 0.6，1 秒 → 8 秒）',
    'theme' in clamped && clamped.theme.effects.density === 0.6 && clamped.theme.effects.driftSeconds === 8 && clamped.theme.effects.glow === 0.5,
    'theme' in clamped ? JSON.stringify(clamped.theme.effects) : clamped.error,
  )
}

/* --------------------------------------------------------- Part 2: token derivation */

function part2(): void {
  const required = ['--bg', '--panel', '--card', '--text', '--muted', '--accent', '--glass', '--player-bg', '--ambient-a', '--ambient-b', '--shadow']
  const missing: string[] = []
  const unsafe: string[] = []
  const flat: string[] = []
  const lowContrast: string[] = []
  const unknownTokens: string[] = []

  for (const skin of BUILT_IN_SKINS) {
    for (const mode of ['dark', 'light'] as const) {
      const tokens = mode === 'dark' ? skin.dark : skin.light
      // The default skin declares nothing on purpose (base.css is that theme); every other skin must
      // be complete in both modes, or it would inherit half of somebody else's palette.
      if (skin.id === 'aurora') continue
      for (const name of required) {
        if (!tokens[name]) missing.push(`${skin.id}/${mode}:${name}`)
      }
      for (const [name, value] of Object.entries(tokens)) {
        if (!ALLOWED_TOKENS.has(name)) unknownTokens.push(`${skin.id}:${name}`)
        if (!SAFE_VALUE.test(value) || /undefined|null|NaN/.test(value)) unsafe.push(`${skin.id}:${name}=${value}`)
        flat.push(`${skin.id}/${mode}:${name}=${value}`)
      }
      const [bgR, bgG, bgB] = channels(tokens['--bg'] ?? '') ?? [0, 0, 0]
      const [cardR, cardG, cardB] = channels(tokens['--card'] ?? '') ?? [0, 0, 0]
      const separates = [bgR, bgG, bgB].some((channel, index) => Math.abs(channel - [cardR, cardG, cardB][index]!) >= 6)
      if (!separates) missing.push(`${skin.id}/${mode}:卡片与底色无法分层`)
      if (contrast(tokens['--text'] ?? '#000', tokens['--card'] ?? '#fff') < 4.5) {
        lowContrast.push(`${skin.id}/${mode}`)
      }
    }
  }

  check('六套内置主题都在列表里，且 id 与主进程共享的清单一致', BUILT_IN_SKINS.length === BUILT_IN_SKIN_IDS.length && BUILT_IN_SKINS.every((skin) => BUILT_IN_SKIN_IDS.includes(skin.id)), `${BUILT_IN_SKINS.length} skins`)
  check('每套主题的深色/浅色两套变量都齐（不缺关键 token）', missing.length === 0, missing.join(' '))
  check('生成的取值全部是可安全写入的 CSS（无 undefined / 非法字符）', unsafe.length === 0, unsafe.join(' '))
  check('只输出已知 token（不会偷偷定义无关变量）', unknownTokens.length === 0, unknownTokens.join(' '))
  // The "white on white" failure is exactly what makes a light theme look unfinished, so it is asserted
  // as a property of the palette rather than eyeballed.
  check('每套主题在两种模式下卡片都与页面底分层（浅色不做成白底白卡）', !missing.some((item) => item.includes('分层')), missing.filter((item) => item.includes('分层')).join(' '))
  check('正文字号下的文字对比度 ≥ 4.5:1（两种模式都算）', lowContrast.length === 0, lowContrast.join(' '))
  check('全部 token 值总量非零（不是空肤色板）', flat.length > 200, `${flat.length} values`)

  // The default skin is `base.css` itself, so it must declare *nothing*: an accidental `--bg: undefined`
  // here would blank the whole app rather than fall back to the stylesheet's own value.
  const aurora = findBuiltInSkin('aurora')
  check(
    '默认主题不声明任何 token（它就是基础样式表，不是一套覆盖）',
    Boolean(aurora) && Object.keys(aurora.dark).length === 0 && Object.keys(aurora.light).length === 0,
    JSON.stringify({ dark: Object.keys(aurora?.dark ?? {}).length, light: Object.keys(aurora?.light ?? {}).length }),
  )
  // And derivation itself must be honest about a palette it cannot use instead of emitting `undefined`.
  const derived = buildTokens({ bg: '', surface: '', surfaceAlt: '', text: '', muted: '', line: '', accent: '', accentAlt: '' }, 'dark')
  check(
    '空字符串的肤色板不会产出 undefined（派生器不写空值）',
    Object.values(derived).every((value) => typeof value === 'string' && value.length > 0 && !value.includes('undefined')),
    JSON.stringify(derived['--bg']),
  )
}

/* ----------------------------------------------------------- Part 3: CSS generation */

function part3(): void {
  const css = themeCss(BUILT_IN_SKINS)
  check(
    '默认主题不生成任何规则（它就是基础样式表）',
    !css.includes('data-skin="aurora"'),
    css.includes('data-skin="aurora"') ? 'found aurora block' : 'no aurora rules',
  )
  const starDark = `:root[data-skin="star-dream"] {`
  const starLight = `:root[data-skin="star-dream"][data-theme="light"] {`
  check('每套主题都生成深色与浅色两个选择器块', css.includes(starDark) && css.includes(starLight), `${css.split('{').length - 1} blocks`)
  check(
    '浅色块用属性叠加而不是另一个皮肤 id（明暗与主题是两个轴）',
    css.includes('[data-skin="star-dream"][data-theme="light"]'),
    'selector ok',
  )

  // A malformed block would silently eat every rule after it, so brace balance is asserted per block.
  const blocks = css.split('/* ')
  const unbalanced = blocks.filter((block) => {
    if (block.trim().length === 0) return false
    return (block.match(/\{/g) ?? []).length !== 1 || (block.match(/\}/g) ?? []).length !== 1
  })
  check('每个规则块的花括号都是配对的（一处坏块会吃掉后面所有规则）', unbalanced.length === 0, unbalanced.map((item) => item.slice(0, 40)).join(' | '))

  const sky = findBuiltInSkin('ocean-morning')
  check('按 id 能查到皮肤，未知 id 返回 undefined（调用方据此回退）', Boolean(sky) && findBuiltInSkin('nope') === undefined, sky?.name ?? 'missing')
  check(
    '卡片预览色取自皮肤自己的 token（首页底色 / 强调 / 正文）',
    Boolean(sky && sky.light['--bg'] && sky.light['--accent'] && sky.light['--text']),
    sky ? JSON.stringify([sky.light['--bg'], sky.light['--accent'], sky.light['--text']]) : 'missing',
  )
}

/* ------------------------------------------------------------- Part 4: native chrome */

function part4(): void {
  const mismatched: string[] = []
  const illegible: string[] = []
  for (const skin of BUILT_IN_SKINS) {
    if (skin.id === 'aurora') continue
    for (const mode of ['dark', 'light'] as const) {
      const chrome = skinChrome(skin, mode)
      const tokens = mode === 'dark' ? skin.dark : skin.light
      if (!chrome) {
        mismatched.push(`${skin.id}/${mode}:no chrome`)
        continue
      }
      if (chrome.color !== tokens['--bg']) mismatched.push(`${skin.id}/${mode}:${chrome.color} != ${tokens['--bg']}`)
      // The window buttons are drawn *by the OS* on the strip: a symbol colour that blends into it is
      // an unusable window, not a cosmetic issue.
      if (contrast(chrome.symbolColor, chrome.color) < 3) illegible.push(`${skin.id}/${mode}:${chrome.symbolColor} on ${chrome.color}`)
    }
  }
  check('每套主题都把原生标题栏颜色对齐自己的 --bg（窗口顶部不再留一条黑边）', mismatched.length === 0, mismatched.join(' '))
  check('窗口按钮符号色与标题栏底色对比度 ≥ 3:1（否则按钮看不见）', illegible.length === 0, illegible.join(' '))
  const auroraChrome = skinChrome(findBuiltInSkin('aurora') as ThemeDefinition, 'light')
  check('默认主题不声明 chrome，交给主进程的默认值（返回 null）', auroraChrome === null, JSON.stringify(auroraChrome))
}

/* ------------------------------------------- Part 6: the effect engine (theme → moving space) */

/**
 * Recipe name → the CSS attribute selector that must implement it.
 *
 * This is the check that stops the engine from *claiming* an effect: every recipe a built-in theme can
 * select has to be written somewhere in the renderer's stylesheets. A `data-bg="nebula"` with no rule
 * behind it is exactly the "UI 显示支持但实际不可运行" failure, and it is invisible in review because the
 * attribute is set correctly.
 */
function implementedRecipes(css: string): Set<string> {
  const found = new Set<string>()
  const pattern = /\[data-(bg|pulse|lyric|immersive|particles)=['"]([a-z-]+)['"]\]/g
  for (const match of css.matchAll(pattern)) found.add(`${match[1]}=${match[2]}`)
  return found
}

function part6(): void {
  const css = readFileSync(join(process.cwd(), 'src/renderer/src/styles/app.css'), 'utf8')
  const implemented = implementedRecipes(css)

  /* 1. Every recipe reachable from a built-in theme has a real rule. */
  const missing: string[] = []
  for (const skin of BUILT_IN_SKINS) {
    const wanted = [
      `bg=${skin.effects.background}`,
      `pulse=${skin.effects.pulse}`,
      `lyric=${skin.effects.lyrics}`,
      `immersive=${skin.effects.immersive}`,
    ]
    for (const key of wanted) {
      // `plain` is the base look — it is allowed to be the *absence* of a recipe.
      if (key.endsWith('=plain')) continue
      if (!implemented.has(key)) missing.push(`${skin.id}:${key}`)
    }
  }
  check('每套内置主题声明的动效配方都有真实 CSS 实现（不是只写了 data 属性）', missing.length === 0, missing.join(' '))

  /* 2. Every declared recipe in the vocabulary is implemented, so a user theme cannot name a ghost. */
  const vocabulary: string[] = []
  for (const kind of ['nebula', 'paper', 'tide', 'wash', 'sunset']) vocabulary.push(`bg=${kind}`)
  for (const kind of ['halo', 'copper', 'droplet', 'sun']) vocabulary.push(`pulse=${kind}`)
  for (const kind of ['focus', 'page', 'ripple', 'ink', 'subtitle']) vocabulary.push(`lyric=${kind}`)
  for (const kind of ['nebula', 'window', 'water', 'ink', 'film']) vocabulary.push(`immersive=${kind}`)
  const ghosts = vocabulary.filter((key) => !implemented.has(key))
  check('主题可选的每一种配方都在样式表里有实现（用户主题不能选到空配方）', ghosts.length === 0, ghosts.join(' ') || `${vocabulary.length} recipes`)

  /*
   * Every room recipe must be *slowed down* by `--fx-speed`, which is what turns "paused" into "the space
   * calmed down" instead of "the space is broken". A recipe that animates at a fixed duration keeps
   * moving at full speed with no music, and no test of the attribute would ever notice.
   */
  const speedless = ['nebula', 'window', 'water', 'ink', 'film'].filter((kind) => {
    const rule = new RegExp(`\\[data-immersive='${kind}'\\][^}]*var\\(--fx-speed\\)`)
    return !rule.test(css)
  })
  check('每一种房间动画都把播放/暂停的减速变量乘进自己的时长（暂停时空间会静下来）', speedless.length === 0, speedless.join(' ') || '5 rooms')

  /* The artwork is the one part of the room the user is actually looking at, so every space has to treat it. */
  const untreated = ['nebula', 'window', 'water', 'ink', 'film'].filter(
    (kind) => !new RegExp(`\\[data-immersive='${kind}'\\][^{]*\\.artwork`).test(css),
  )
  check('每一种空间都给沉浸页的封面换一轮照明（不是只有背景在变）', untreated.length === 0, untreated.join(' ') || '5 rooms')

  /*
   * The two remaining couplings are *moments* (a skip, a volume move) rather than states, so they are
   * triggered from the store and painted by attribute selectors. Both halves are checked here: the signal is
   * gated by the level's `heavy` budget, and the sweep/volume rules every space needs really exist.
   */
  const sweeps = ['nebula', 'window', 'water', 'ink', 'film'].filter(
    (kind) => !new RegExp(`\\[data-scene='switch'\\]\\[data-immersive='${kind}'\\]`).test(css),
  )
  check('每一种空间在换歌时都扫过自己的一层光幕', sweeps.length === 0, sweeps.join(' ') || '5 rooms')
  check('换歌转场的时长与 store 里 data-scene 的存活时间对上（不会动画没播完属性就没了）', /fx-scene-veil 1\.1s/.test(css), '1.1s')
  check(
    '音量反馈是双向的（调大调小给不同的反应，而不是同一个动画）',
    /fx-volume-up/.test(css) && /fx-volume-down/.test(css) && /\[data-volume='up'\]/.test(css) && /\[data-volume='down'\]/.test(css),
    'up/down both present',
  )
  check(
    '音量反馈的两个属性都有 CSS 读者（拖动位置与本次幅度都不是白写的）',
    /var\(--volume-level/.test(css) && /var\(--volume-delta/.test(css),
    'read',
  )
  check(
    '两个“瞬间”的联动都由档位的 heavy 预算把门（关闭/节能时不触发）',
    LEVELS.off.heavy === false && LEVELS.saver.heavy === false && LEVELS.standard.heavy === true && LEVELS.immersive.heavy === true,
    LEVEL_ORDER.map((level) => `${level}:${LEVELS[level].heavy}`).join(' '),
  )

  /* 3. The plan carries the theme's recipe and its numbers. */
  const star = findBuiltInSkin('star-dream') as ThemeDefinition
  const tokens = { '--accent': '#8ea2ff', '--accent-strong': '#8ea2ff', '--ambient-b': '#b58bff' }
  const standard = planEffects(star, 'standard', tokens)
  check('标准档：计划带上主题自己的背景配方与节奏', standard.dataset.bg === star.effects.background && standard.vars['--bg-art-drift'] === `${star.effects.driftSeconds}s`, `${standard.dataset.bg} drift=${standard.vars['--bg-art-drift']}`)
  check('标准档：沉浸配方、粒子配方与播放按钮光晕都来自主题', standard.dataset.immersive === star.effects.immersive && standard.dataset.pulse === star.effects.pulse && standard.ambient.particles === star.effects.particles, `${standard.dataset.immersive}/${standard.dataset.pulse}/${standard.ambient.particles}`)
  /*
   * The plan may only write custom properties something reads.
   *
   * This is the cheap guard against a "knob" that looks like a feature but drives nothing — the failure
   * mode is silent: the value appears in the DOM, the setting changes, and no pixel does.
   */
  const unread = Object.keys(standard.vars).filter((name) => !css.includes(`var(${name}`))
  check('计划写出的每个自定义属性都至少被一条 CSS 规则读取（没有只写不读的旋钮）', unread.length === 0, unread.join(' ') || `${Object.keys(standard.vars).length} vars`)
  check('装饰性的高强度变量已不存在（强度由 --ambient-glow 单独管）', !('--bg-art-strength' in standard.vars) && !('--pulse-accent-alt' in standard.vars), Object.keys(standard.vars).join(','))

  /* 4. `off` means off — not "fewer things", but nothing that moves and nothing that reacts. */
  const off = planEffects(star, 'off', tokens)
  check('关闭档：粒子归零且不发散', off.dataset.bg === 'plain' && off.ambient.particles === 'none' && off.ambient.density === 0, `${off.dataset.bg}/${off.ambient.particles}/${off.ambient.density}`)
  check('关闭档：光晕与歌词都不写数值，完全交给基础样式的默认值', off.dataset.pulse === 'plain' && off.dataset.lyric === 'plain' && !('--pulse-strength' in off.vars) && !('--lyric-duration' in off.vars), Object.keys(off.vars).join(',') || 'bg only')
  check('基础样式确实给了默认值（否则"不写"等于光环挂在 1 上）', /var\(--pulse-strength,\s*0\)/.test(css) && /var\(--pulse-react,\s*0\)/.test(css), 'fallbacks present')

  /* 5. The ladder actually slopes: 沉浸 > 标准 > 节能 > 关闭, on both particles and coupling. */
  const ladder = LEVEL_ORDER.map((level) => ({ level, plan: planEffects(star, level, tokens) }))
  const density = ladder.map((item) => item.plan.ambient.density)
  const coupling = ladder.map((item) => item.plan.ambient.react)
  const strictlyRising = (values: number[]): boolean => values.every((value, index) => index === 0 || value > values[index - 1])
  const nonDecreasing = (values: number[]): boolean => values.every((value, index) => index === 0 || value >= values[index - 1])
  check('四档的粒子密度严格递增（关闭 < 节能 < 标准 < 沉浸）', strictlyRising(density), density.map((n) => n.toFixed(2)).join('<'))
  /*
   * The particle field's coupling slopes with the density it still draws (节能 keeps a field, so it keeps
   * some breathing room), while 关闭 has nothing at all — and a theme that declares `reactive: 0` stays
   * flat at every level rather than acquiring motion it never asked for.
   */
  const flatTheme = { ...star, effects: { ...star.effects, reactive: 0 } }
  const flat = LEVEL_ORDER.map((level) => planEffects(flatTheme, level, tokens).ambient.react)
  check('音乐联动随档位单调上升，且在“关闭”档一定是 0', nonDecreasing(coupling) && coupling[0] === 0 && strictlyRising(coupling), coupling.map((n) => n.toFixed(2)).join('<'))
  check('主题声明 reactive: 0 时，四档都不会凭空产生联动', flat.every((value) => value === 0), flat.join(','))
  check('播放按钮的联动预算同样只在有配方的档位存在', Number(ladder[2].plan.vars['--pulse-react']) > 0 && Number(ladder[3].plan.vars['--pulse-react']) > Number(ladder[2].plan.vars['--pulse-react']) && !('--pulse-react' in ladder[1].plan.vars), ladder.map((item) => item.plan.vars['--pulse-react'] ?? '-').join('<'))
  check('“沉浸”档确实比“标准”档更密、联动更强（而不是同一个预算换了个名字）', LEVELS.immersive.particles > LEVELS.standard.particles && LEVELS.immersive.react > LEVELS.standard.react, `${LEVELS.immersive.particles} vs ${LEVELS.standard.particles}`)

  /* 6. The automatic fallback must never reach 关闭 — a slow second is not "turn my theme off". */
  const chain: AnimationLevel[] = []
  let walk: AnimationLevel = 'immersive'
  for (let i = 0; i < 6; i += 1) {
    walk = downgrade(walk)
    chain.push(walk)
  }
  check('自动降级最多退到“节能”，永远不会退成“关闭”', chain[chain.length - 1] === 'saver' && !chain.includes('off'), chain.join('→'))
  check('自动降级每一步都真的更低（不会原地打转）', LEVELS[downgrade('immersive')].particles < LEVELS.immersive.particles && LEVELS[downgrade('standard')].particles < LEVELS.standard.particles, `${downgrade('immersive')}/${downgrade('standard')}`)

  /*
   * 7. Stale custom properties are removed, not overwritten.
   *
   * Switching 沉浸 → 关闭 leaves `--pulse-strength: 0` if the writer only ever *sets*: the halo is off,
   * but the variable is still there claiming a recipe exists, and any rule that reads it without the
   * level in the selector keeps running. The stub is the whole DOM surface this function uses.
   */
  const properties = new Map<string, string>()
  const stub = {
    dataset: {} as Record<string, string>,
    style: {
      setProperty: (name: string, value: string) => properties.set(name, value),
      removeProperty: (name: string) => properties.delete(name),
    },
  } as unknown as HTMLElement
  const heavy = planEffects(star, 'immersive', tokens)
  const light = planEffects(star, 'saver', tokens)
  const applied = applyEffects(stub, heavy, new Set<string>())
  const before = properties.size
  applyEffects(stub, light, applied)
  check('沉浸 → 节能真的会移走光环与歌词变量（不是留成 0 假装关了）', before > properties.size && !properties.has('--pulse-accent') && !properties.has('--lyric-duration'), `immersive=${before} saver=${properties.size} (${[...properties.keys()].join(',')})`)
  check('降档后仍然留下的属性都是新档位自己要用的（不会原地复活上一档）', [...properties.keys()].every((name) => name in light.vars), [...properties.keys()].join(','))

  /* 8. Playback coupling is a separate axis from density: a quiet theme may still breathe with the music. */
  const still = { ...star, effects: { ...star.effects, reactive: 0 } }
  check('主题声明 reactive=0 时，任何档位都不会产生音乐联动', planEffects(still, 'immersive', tokens).ambient.react === 0, String(planEffects(still, 'immersive', tokens).ambient.react))

  /*
   * 9. 负载看护层的上下限在这里只验一条：它是双向的。
   *
   * 帧耗时的测量与判定已搬到 `renderer/visual/budget.ts`，那里有自己的一整套检查（`npm run smoke:visual`）；
   * 这一条只固定“阶梯本身有天花板和地板”这件与主题系统直接相关的事。
   */
  check(
    '自动调档是双向的：降档有地板，升档不会越用户选择的档位',
    downgrade('saver') === 'saver' &&
      downgrade('immersive') === 'standard' &&
      upgrade('saver', 'standard') === 'standard' &&
      upgrade('standard', 'standard') === 'standard' &&
      upgrade('saver', 'immersive') === 'standard',
    'bounded both ways',
  )
}

/* ---------------------------------------------------- Part 5: the user theme pipeline */

async function part5(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'aurora-theme-'))
  try {
    const file = join(directory, 'my-theme.json')
    const definition = {
      id: 'my-theme',
      name: '我的主题',
      tagline: '来自主题目录',
      preferredMode: 'light',
      swatch: ['#f2efe8', '#3f7d6f', '#22302f'],
      dark: { '--bg': '#0f1512', '--accent': '#6fc3a8' },
      light: { '--bg': '#f2efe8', '--accent': '#3f7d6f', '--text': '#22302f' },
      effects: { particles: 'mist', density: 0.1, speed: 8, driftSeconds: 70, glow: 0.15 },
    }
    await writeFile(file, JSON.stringify(definition), 'utf8')

    // Exactly the main process's path: read the file, parse, validate.
    const raw = JSON.parse(await (await import('node:fs/promises')).readFile(file, 'utf8')) as unknown
    const parsed = parseThemeDefinition(raw)
    check('主题目录里的文件能通过同一套校验', 'theme' in parsed, 'error' in parsed ? parsed.error : 'ok')

    if ('theme' in parsed) {
      const user = parsed.theme
      const css = themeCss([...BUILT_IN_SKINS, user])
      check(
        '用户主题进了同一份生成的样式表，并且自带深浅两套',
        css.includes(':root[data-skin="my-theme"] {') && css.includes(':root[data-skin="my-theme"][data-theme="light"] {'),
        `accent hit: ${(css.match(/--accent: #6fc3a8/g) ?? []).length}`,
      )
      check(
        '用户主题的取值原样出现在 CSS 里（没有被丢弃或改写成默认色）',
        css.includes('#6fc3a8') && css.includes('#3f7d6f'),
        'colours present',
      )
      check(
        '用户主题的动效参数生效（粒子类型 / 密度进入运行时）',
        user.effects.particles === 'mist' && user.effects.density === 0.1,
        JSON.stringify(user.effects),
      )
      const prefer = findBuiltInSkin(user.id) === undefined
      check('用户主题 id 与内置主题不冲突（该判断在主进程用于拒绝重名）', prefer, user.id)
    }

    const duplicate = parseThemeDefinition({ ...definition, id: 'star-dream' })
    check(
      '重名判定交给主进程的清单（解析本身不报错，冲突在列表层报出）',
      'theme' in duplicate && BUILT_IN_SKIN_IDS.includes(duplicate.theme.id),
      'theme' in duplicate ? duplicate.theme.id : duplicate.error,
    )

    const broken = parseThemeDefinition({ ...definition, id: 'broken', dark: { '--bg': 'not a colour?' } })
    check(
      '坏文件被拒绝时带出具体原因（而不是"无效的主题文件"）',
      'error' in broken && broken.error.includes('--bg'),
      'error' in broken ? broken.error : 'accepted',
    )
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3 })
  }
}

/* ------------------------------------ Part 7: the lyric ink (a mode → what actually gets painted) */

/**
 * The ink picker is a two-sided contract: the store decides *which* mode is active, `app.css` decides what
 * that mode looks like. Both halves have a silent failure mode worth catching offline — a mode the store
 * accepts but no stylesheet implements paints nothing, and a stored value that is not a colour is an
 * injection into an inline custom property.
 */
function part7(): void {
  const css = readFileSync(join(process.cwd(), 'src/renderer/src/styles/app.css'), 'utf8')

  /* 1. Every mode the picker offers has a recipe, and no recipe is left behind by the picker. */
  const declared = new Set<string>(LYRIC_COLOR_MODES)
  const implemented = new Set([...css.matchAll(/:root\[data-lyric-color='([a-z]+)'\]/g)].map((match) => match[1]))
  const missing = [...declared].filter((mode) => mode !== 'auto' && !implemented.has(mode))
  check(
    '每种歌词颜色模式都有真实 CSS 配方（选中的档真的会改变被画出来的颜色）',
    missing.length === 0,
    missing.join(' ') || `${implemented.size} recipes`,
  )
  const ghosts = [...implemented].filter((mode) => !declared.has(mode))
  check('样式表里没有选项表以外的颜色模式（不会出现选了却不知道是什么的档）', ghosts.length === 0, ghosts.join(' ') || 'none')

  /* 2. `auto` is the base block, and it has to stand on its own rather than lean on another mode. */
  // Sliced at the first *selector*, not the first mention: the block above it explains the tokens, and
  // an explanation is not a declaration.
  const base = css.slice(0, css.indexOf(":root[data-lyric-color"))
  const tokens = ['--lyric-plain', '--lyric-active', '--lyric-done', '--lyric-glow']
  check(
    '默认（自动）档自带完整的四枚记号，不依赖其他档位兜底',
    tokens.every((token) => base.includes(`${token}:`)),
    tokens.filter((token) => !base.includes(`${token}:`)).join(' ') || `${tokens.length} tokens`,
  )
  check(
    '四枚歌词记号都有真实的读者（写出来就一定会画到屏幕上）',
    tokens.every((token) => new RegExp(`var\\(${token}`).test(css)),
    tokens.filter((token) => !new RegExp(`var\\(${token}`).test(css)).join(' ') || 'all read',
  )

  /* 3. The two whitelists. The colour one is what stands between a stored preference and a stylesheet. */
  const validColors = ['#fff', '#FFFFFF', '#12ab34', '#0aF']
  const invalidColors = ['red', '#ffff', '', '#', 'rgb(1,2,3)', '#fff; background: url(x)', 'url(x)', null, 42, {}]
  check('合法的三位/六位十六进制颜色被接受（含大小写）', validColors.every(isHexColor), validColors.join(' '))
  check(
    '非十六进制的一律拒绝（颜色选择器不能变成样式注入的入口）',
    invalidColors.every((value) => !isHexColor(value)),
    JSON.stringify(invalidColors),
  )
  check(
    '模式白名单只放行这五个（存档里的任意字符串不会被当成模式）',
    LYRIC_COLOR_MODES.every(isLyricColorMode) && !isLyricColorMode('rainbow') && !isLyricColorMode('') && !isLyricColorMode(undefined),
    LYRIC_COLOR_MODES.join(' '),
  )
  check(
    '选项表与模式白名单一一对应，每项都有标签与说明',
    LYRIC_COLOR_OPTIONS.length === LYRIC_COLOR_MODES.length &&
      LYRIC_COLOR_OPTIONS.every(
        (option) => LYRIC_COLOR_MODES.includes(option.mode as LyricColorMode) && option.label.length > 0 && option.hint.length > 0,
      ),
    LYRIC_COLOR_OPTIONS.map((option) => `${option.mode}:${option.label}`).join(' '),
  )

  /* 4. The playback states are distinct in the stylesheet, not just in the component's class list. */
  const states = ['past', 'future'].filter((state) => !new RegExp(`\\.lyric-line\\.${state}\\.`).test(css))
  check('已唱 / 未唱的歌词各有自己的规则（不是所有非当前行同一个灰）', states.length === 0, states.join(' ') || 'past+future')
  check(
    '当前行与逐字高亮都用用户选的颜色，而不是写死的白色',
    /\.lyric-line\.active\s*\{[^}]*color:\s*var\(--lyric-active/.test(css) &&
      /\.lyric-word\.word-active\s*\{[^}]*var\(--lyric-active\)/.test(css),
    'both tokenised',
  )

  /* 5. The two additive improvements this round made to the page itself. */
  check(
    '封面主色被注册为可插值属性（换歌时环境色是渐变，不是跳变）',
    /@property --amb-accent\s*\{\s*syntax:\s*'<color>'/.test(css) && /--amb-accent 900ms/.test(css),
    'registered + transitioned',
  )
  check(
    '视图切换器的选中态由封面主色染色（不再是一个白块）',
    /\.lp-viewswitch\s+button\.active\s*\{[^}]*color-mix\(in srgb, var\(--amb-accent/.test(css),
    'accent-tinted',
  )
  check(
    '唱盘不再由 CSS 自己旋转（因此才能有加速与滑停）',
    !/animation:\s*vinyl-spin/.test(css) && /will-change:\s*transform/.test(css),
    'driven by the component',
  )
}

/*
 * Part 8 — the animation level's storage rule.
 *
 * This is the one that cost a real install its effects: the automatic fallback used to be written into
 * the same slot as the user's own choice, so a slow session silently became the preference and the next
 * launch had nothing to restore. The rule is now pure and testable, and these checks are the reason it
 * cannot quietly regress.
 */
function part8(): void {
  /* 1. One slot each, and they are not the same slot. */
  check(
    '用户的选择与自动降档写在两个不同的槽里',
    LEVEL_KEY !== AUTO_LEVEL_KEY && levelSlot(false) === LEVEL_KEY && levelSlot(true) === AUTO_LEVEL_KEY,
    `${LEVEL_KEY} / ${AUTO_LEVEL_KEY}`,
  )

  /* 2. An automatic value may only lower the choice, never raise or replace it. */
  check(
    '自动降档只相对用户档位向下作用',
    resolveStoredLevel('immersive', 'standard').level === 'standard' &&
      resolveStoredLevel('immersive', 'standard').fromAuto === true &&
      resolveStoredLevel('saver', 'immersive').level === 'saver' &&
      resolveStoredLevel('saver', 'immersive').fromAuto === false,
    'lowers only',
  )

  /* 3. A leftover automatic value equal to the choice is not "an automatic downgrade". */
  check(
    '与选择相同的自动档位不标记为自动降档',
    resolveStoredLevel('standard', 'standard').fromAuto === false,
    'no false positive',
  )

  /* 4. Junk in storage is not a level: it falls back to the documented default. */
  check(
    '存储里的脏值不会变成一个档位',
    resolveStoredLevel('bogus', 'nonsense', false).level === 'standard' &&
      resolveStoredLevel(null, undefined, false).level === 'standard',
    'standard',
  )

  /* 5. The previous build's on/off switch still migrates instead of being dropped. */
  check(
    '旧版动效开关仍然迁移（关闭→关闭档）',
    resolveStoredLevel(null, null, true).level === 'off' && resolveStoredLevel(null, null, false).level === 'standard',
    'migrated',
  )

  /* 6. The watchdog's automatic floor is not "no effects at all". */
  // The ladder's own bottom is `off`, so "never reaches 关闭" means: from every level *above* it, one
  // step down still leaves effects running, and 关闭 is only ever what the user asked for.
  check(
    '自动降档的地板是「节能」，不会自己掉到「关闭」',
    LEVEL_ORDER.filter((level) => level !== 'off').every((level) => downgrade(level) !== 'off') &&
      downgrade('immersive') === 'standard' &&
      downgrade('standard') === 'saver' &&
      downgrade('saver') === 'saver',
    'floor = saver',
  )

  /*
   * 7. The session value is consumed at launch. This is a source-level assertion on purpose: the store
   * is DOM code, and what matters here is the *shape* of the rule — read, then clear — which a browser
   * test would only reach through timing luck.
   */
  const store = readFileSync(join(process.cwd(), 'src/renderer/src/stores/ui.ts'), 'utf8')
  check(
    '启动时读取并立即清除会话降档（不跨会话存活）',
    /localStorage\.removeItem\(AUTO_LEVEL_KEY\)\s*\n?\s*animationLevel\.value = resolved\.level/.test(store),
    'consumed',
  )
  check(
    '负载看护写的是会话槽，用户手动切换才写选择槽',
    /levelSlot\(Boolean\(options\.automatic\)\)/.test(store) &&
      // 手动切换会把会话值清掉（缩进与换行会变，所以只看两件事的先后，不锁定一行）。
      /if \(!options\.automatic\)[\s\S]{0,120}?localStorage\.removeItem\(AUTO_LEVEL_KEY\)/.test(store) &&
      // 负载看护的自动调档走的是同一个槽位规则，而不是另一套写法。
      /localStorage\.setItem\(levelSlot\(true\), next\)/.test(store),
    'slots respected',
  )

  /*
   * 8. 启动宽限已搬进纯策略，这里就不再按源码字符串看了。
   *
   * 旧版这里断言的是 energy.ts 里的一个常量，而帧耗时测量已经不属于那个模块；现在“启动多少毫秒内不判案”是
   * `visual/budget.ts` 的 `GUARD.warmupMs`，由 `npm run smoke:visual` 用假时钟直接验证行为（而不是验证字符串）。
   */
}

async function main(): Promise<void> {
  part1()
  part2()
  part3()
  part4()
  part6()
  part7()
  part8()
  await part5()

  const failed = checks.filter((item) => !item.ok)
  for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.detail ? `  ${item.detail}` : ''}`)
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
  process.exitCode = failed.length === 0 ? 0 : 1
}

void main().catch((error) => {
  console.log(`FAIL  测试执行异常  ${String(error)}`)
  process.exitCode = 1
})
