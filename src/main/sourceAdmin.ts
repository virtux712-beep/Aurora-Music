import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { BrowserWindow, dialog } from 'electron'
import type {
  SourceCheckAllResult,
  SourceCheckSummary,
  SourceCheckVerdict,
  SourceDescriptor,
  SourcePendingHost,
  SourceSelfCheckResult,
  SourceSelfCheckStep,
} from '../shared/types'
import type { SourceImportResult } from '../shared/sourceImport'
import { MAX_SCRIPT_BYTES, detectRuntimeKindForText } from '../shared/scriptSource'
import { validateCustomSourceRaw } from './customSources/store'
import { grantCustomHosts } from './customSources/store'
import { isScriptSource, grantScriptHosts, probeScriptImport, suggestedHostsFromText } from './scriptSources/store'
import { describeSources, getEntry, resolveStream, searchOne } from './sources'
import { listEntries, type SourceEntry } from './sources/registry'
import { repairRefusedHosts } from './sources/autoRepair'
import { readErrorLog } from './sources/log'
import { allSecrets } from './secretStore'
import { getSettings } from './settings'
import { readPendingHosts } from './sources/permissions'

/**
 * Source administration: *installing* a source and *granting* it network access.
 *
 * Two rules shape this file, and both come from what Aurora is: a host for user-supplied sources.
 *
 *  1. **Detection is about format, never approval.** A file is a script, a declarative manifest, or
 *     unrecognised. There is no branch that rejects a source for declaring an unknown platform, an
 *     unknown host, or an unknown provider — those are just metadata the UI renders.
 *  2. **Installing and reaching the network are separate.** A source installs, registers and runs
 *     with zero granted hosts; the first request to any host is refused by the permission layer and
 *     recorded as *pending*, and `grantSourceHosts` turns a pending host into a granted one.
 */

/**
 * The largest file Aurora will consider importing.
 *
 * Deliberately the *same* number the script host enforces (`MAX_SCRIPT_BYTES`). It used to be 1MB
 * here while the runtime accepted 2MB, which meant a file between the two limits was rejected by the
 * detector as "too large" and reported as an *unrecognised format* — the one outcome the user could
 * not act on, for a source the runtime would have run happily.
 */
const MAX_IMPORT_BYTES = MAX_SCRIPT_BYTES

function looksLikeJsonObject(text: string): boolean {
  const trimmed = text.trimStart()
  return trimmed.startsWith('{') || trimmed.startsWith('[')
}

/**
 * What the bytes are, asked *before* what source format they are.
 *
 * A file named `.js` is not evidence that it holds JavaScript, and the two ways people actually hit
 * that both arrive with a plausible name: an Office document someone renamed (the OOXML container is
 * a ZIP, so it starts with `PK\x03\x04`), and a download that stopped halfway (the same `PK`, cut
 * short). `D:\洛雪音乐\…\未测试\野草音源.js` is the first case — a Word file with a `.js` name.
 *
 * Both used to fall through to the script probe, which ran them, failed to parse them, and reported a
 * sandbox-level "script failed to execute … check the renderer console" — a sentence that names
 * neither cause and points at a console a packaged-app user does not have. Naming the container is
 * one check, and it turns a dead end into the next step (re-download, or unzip it).
 *
 * Returns `null` when the text is plausibly source, so nothing about normal imports changes.
 */
function describeNonTextPayload(text: string): string | null {
  if (text.startsWith('PK\u0003\u0004')) {
    return 'ZIP 压缩包（Office 文档 .docx/.xlsx/.pptx 与 .zip 都是这个开头）'
  }
  if (text.includes('\u0000')) return '二进制文件（含 NUL 字节）'
  const unreadable = (text.match(/\uFFFD/g) ?? []).length
  if (unreadable > 0 && unreadable / text.length > 0.02) return '二进制文件（按文本解码后大量字节无法解释）'
  return null
}

/**
 * Runs the detector on text that is already in memory (a file we just read, or a paste).
 * Returns the recognised kind plus whatever the runtime was able to learn by *running* the source.
 */
export async function detectSourceText(text: string, fileName = 'pasted.txt'): Promise<SourceImportResult> {
  const base: Pick<SourceImportResult, 'fileName'> = { fileName }

  if (!text.trim()) {
    return { ok: false, kind: 'unknown', ...base, summary: '文件是空的', errors: ['内容为空'] }
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_IMPORT_BYTES) {
    return { ok: false, kind: 'unknown', ...base, summary: '文件过大', errors: [`上限 ${MAX_IMPORT_BYTES / 1024}KB`] }
  }

  const nonText = describeNonTextPayload(text)
  if (nonText) {
    return {
      ok: false,
      kind: 'unknown',
      ...base,
      summary: `这个文件不是脚本文本：它是 ${nonText}`,
      errors: [
        '常见成因：把 .docx / .zip 之类的文件改名成了 .js、下载没有完成（文件被截断）、或从网盘拿到的是预览文件而不是源文件本身',
      ],
      warnings: [],
      text,
    }
  }

  if (looksLikeJsonObject(text)) {
    const validation = validateCustomSourceRaw(text)
    const manifest = validation.manifest
    return {
      ok: validation.ok,
      kind: 'declarative',
      ...base,
      summary: validation.ok
        ? `声明式 API 音源「${manifest?.name ?? ''}」（${manifest?.id ?? ''}）`
        : '看起来是声明式清单，但校验没有通过',
      errors: validation.errors,
      warnings: [],
      text,
      manifestJson: manifest ? JSON.stringify(manifest, null, 2) : undefined,
    }
  }

  // Not JSON: try it as a JavaScript source, which means actually running it once — with no
  // permissions — to read what it declares.
  const hintedRuntime = detectRuntimeKindForText(text)
  const probe = await probeScriptImport({ sourceText: text, fileName, runtime: hintedRuntime })
  const declaration = probe.declaration
  const actions = declaration?.actions ?? []
  // What the runtime *observed* beats the text hint: a source that announced itself through
  // `lx.EVENT_NAMES.inited` is a 洛雪 source however opaque its minified text is.
  const runtime = declaration?.runtime ?? hintedRuntime

  /*
   * The only blocking outcome is "the runtime could not execute it".
   *
   * "Loaded, but declared nothing" is *not* that outcome: published sources are routinely minified,
   * obfuscated, or slow to announce themselves, and the probe is one observation of one run. So the
   * file is recognised as a script source and offered for install with the observation attached as a
   * warning — the source manager re-probes it on demand (`reload`), and a source nobody can re-probe
   * is strictly less useful than one that is installed and visibly not-yet-ready.
   *
   * A file that is not JavaScript at all is still reported as an unknown *format* — that is the one
   * thing that must never be described as a permission or approval problem.
   */
  const looksLikeJavaScript =
    /(=>|\bfunction\b|\bglobalThis\b|defineAuroraSource|\bvar\b|\blet\b|\bconst\b|\bthrow\b|\breturn\b|\bnew\b|\bawait\b|\bclass\b|\bimport\b|\bexport\b)/.test(
      text,
    )
  if (!probe.ok) {
    if (probe.declaration) {
      return {
        ok: false,
        kind: 'script',
        ...base,
        summary: '识别为 JavaScript 音源，但加载失败（脚本执行时抛错）',
        errors: probe.errors,
        warnings: [],
        text,
      }
    }
    return looksLikeJavaScript
      ? {
          ok: false,
          kind: 'script',
          ...base,
          summary: '识别为 JavaScript 音源，但运行时无法执行它',
          errors: probe.errors,
          warnings: [],
          text,
        }
      : {
          ok: false,
          kind: 'unknown',
          ...base,
          summary: '未知 Source 格式：既不是声明式清单，也没有导出 Aurora 脚本契约或洛雪协议',
          errors: probe.errors,
          warnings: [],
          text,
        }
  }

  const recognised = actions.length > 0
  return {
    ok: true,
    kind: 'script',
    ...base,
    summary: recognised
      ? `${runtime === 'lx' ? '洛雪风格' : 'Aurora'} 脚本音源「${declaration?.name || fileName}」：${actions.length} 项能力`
      : `脚本音源「${declaration?.name || fileName}」已加载，暂未声明能力：可以先安装，再用「重新加载」重新探测`,
    errors: [],
    warnings: probe.warnings,
    text,
    script: {
      runtime,
      id: probe.manifest?.id ?? '',
      name: declaration?.name || probe.manifest?.name || fileName,
      version: declaration?.version || probe.manifest?.version || '',
      description: declaration?.description ?? '',
      author: declaration?.author ?? '',
      homepage: declaration?.homepage ?? '',
      actions,
      platforms: declaration?.platforms ?? [],
      qualities: declaration?.qualities ?? [],
      canSearch: declaration?.canSearch ?? false,
      // Suggested grants: what the script's own text mentions. Never enforced, never a precondition.
      suggestedHosts: suggestedHostsFromText(text),
      logs: declaration?.logs ?? [],
      errors: declaration?.errors ?? [],
    },
  }
}

/** Reads one file and runs the detector on it. */
export async function detectSourceFile(filePath: string): Promise<SourceImportResult> {
  let text: string
  try {
    text = await readFile(filePath, 'utf8')
  } catch (error) {
    return {
      ok: false,
      kind: 'unknown',
      fileName: basename(filePath),
      summary: '无法读取文件',
      errors: [error instanceof Error ? error.message : '读取失败'],
    }
  }
  return detectSourceText(text, basename(filePath))
}

/** File picker → detector. Returns a cancelled result when the user closes the dialog. */
export async function importSourceFromFile(window: BrowserWindow | null): Promise<SourceImportResult> {
  const selection = window
    ? await dialog.showOpenDialog(window, {
        title: '安装音源',
        properties: ['openFile'],
        filters: [
          { name: '音源文件', extensions: ['js', 'json', 'cjs', 'mjs', 'txt'] },
          { name: '全部文件', extensions: ['*'] },
        ],
      })
    : await dialog.showOpenDialog({
        title: '安装音源',
        properties: ['openFile'],
        filters: [
          { name: '音源文件', extensions: ['js', 'json', 'cjs', 'mjs', 'txt'] },
          { name: '全部文件', extensions: ['*'] },
        ],
      })

  if (selection.canceled || selection.filePaths.length === 0) {
    return { ok: false, kind: 'unknown', fileName: '', summary: '已取消', errors: [] }
  }
  return detectSourceFile(selection.filePaths[0])
}

/**
 * Grants hosts for *any* source kind, by dispatching to the provider that owns that entry.
 * Returns fresh descriptors so the caller (and the UI) sees the new state immediately.
 */
export async function grantSourceHosts(
  id: string,
  hosts: string[],
): Promise<{ ok: boolean; errors: string[]; sources: SourceDescriptor[] }> {
  const entry = getEntry(id)
  const descriptors = (): SourceDescriptor[] => describeSources(getSettings(), allSecrets())
  if (!entry) return { ok: false, errors: ['没有找到这个音源'], sources: descriptors() }

  const result = isScriptSource(id) ? await grantScriptHosts(id, hosts) : await grantCustomHosts(id, hosts)
  return { ok: result.ok, errors: result.errors, sources: descriptors() }
}

/** The hosts the runtime has refused for a source, newest first. */
export function pendingHostsFor(id?: string): SourcePendingHost[] {
  return readPendingHosts(id)
}

/**
 * Runs a source through the questions that decide whether it can actually play something.
 *
 * The point is to answer "为什么这个音源不能用" in the source's own page, instead of leaving the user
 * to infer it from a failed search somewhere else. Each step is the *real* operation (a real search, a
 * real resolve), never a simulation, and its result is the real error code.
 *
 * With `repair` the two things the program is allowed to fix by itself are fixed in place: refused
 * hosts are granted (through the same durable, revocable path the automatic repair uses) and every
 * failing step is retried once. Nothing else is retried: a wrong API key or a dead host must stay a
 * failure, or the check would only be reporting that it tried.
 */
export async function selfCheckSource(
  id: string,
  options: { repair?: boolean; keyword?: string } = {},
): Promise<SourceSelfCheckResult> {
  const keyword = (options.keyword ?? '周杰伦').slice(0, 60)
  const settings = getSettings()
  const secrets = allSecrets()
  const entry = getEntry(id)
  const steps: SourceSelfCheckStep[] = []
  const repaired: string[] = []

  /** What every step hands back: the conclusion, the reason, and whether it applied at all. */
  type StepOutcome = {
    ok: boolean
    message: string
    code?: SourceSelfCheckStep['code']
    skipped?: boolean
    track?: Awaited<ReturnType<typeof searchOne>>['tracks'][number]
  }

  const measure = async (
    key: SourceSelfCheckStep['key'],
    label: string,
    run: () => Promise<{ ok: boolean; message: string; code?: SourceSelfCheckStep['code']; skipped?: boolean }>,
  ): Promise<{ ok: boolean; code?: SourceSelfCheckStep['code']; message: string; skipped?: boolean }> => {
    const started = Date.now()
    const result = await run()
    steps.push({
      key,
      label,
      ok: result.ok,
      message: result.message,
      ms: Date.now() - started,
      ...(result.code ? { code: result.code } : {}),
      ...(result.skipped ? { skipped: true } : {}),
    })
    return result
  }

  const descriptorOf = (): SourceDescriptor | undefined =>
    describeSources(settings, secrets).find((item) => item.id === id)

  await measure('installed', '已安装', async () =>
    entry
      ? { ok: true, message: `${entry.kind === 'script' ? '脚本音源' : entry.kind === 'declarative' ? '声明式音源' : '内置音源'} · ${entry.version}` }
      : { ok: false, message: '注册表里没有这个音源（可能已被删除）' },
  )
  if (!entry) {
    return {
      id,
      name: id,
      ok: false,
      at: Date.now(),
      keyword,
      steps,
      repaired,
      pendingHosts: [],
      errors: readErrorLog(id),
    }
  }

  const descriptor = descriptorOf()
  await measure('registered', '已注册到运行时', async () =>
    descriptor
      ? { ok: true, message: `状态：${descriptor.status}` }
      : { ok: false, message: '运行时里没有这个音源：脚本可能加载失败或被停用后移除' },
  )
  await measure('enabled', '已启用', async () =>
    descriptor?.enabled
      ? { ok: true, message: '参与搜索与播放解析' }
      : { ok: false, message: '已在音源列表里被停用' },
  )
  await measure('configured', '配置完整', async () =>
    !descriptor?.requiresConfig || descriptor.configured
      ? { ok: true, message: descriptor?.requiresConfig ? '所需参数已填写' : '无需配置' }
      : { ok: false, code: 'NEEDS_CONFIG', message: '这个音源需要填写配置才能工作' },
  )

  /*
   * 搜索与取地址是这次自检里唯一会真正走网络的步骤。失败原因原样带回：未授权是可修的，超时、
   * 无返回、配置不对各自对应不同的处置，把它们归并成“不可用”就失去了这个页面存在的意义。
   */
  const probe = async (): Promise<StepOutcome> => {
    const outcome = await searchOne(id, keyword, { pageSize: 5 }, settings, secrets)
    if (!outcome.ok) return { ok: false, message: outcome.error?.message ?? '搜索失败', ...(outcome.error?.code ? { code: outcome.error.code } : {}) }
    if (outcome.tracks.length === 0) return { ok: true, message: `搜索「${keyword}」返回 0 条（音源可用，但这个词它没有结果）` }
    return { ok: true, message: `搜索「${keyword}」返回 ${outcome.tracks.length} 条`, track: outcome.tracks[0] }
  }

  const streamOf = async (track?: Awaited<ReturnType<typeof searchOne>>['tracks'][number]): Promise<StepOutcome> => {
    if (!descriptor?.capabilities.stream) return { ok: true, message: '该音源不提供播放解析（只做搜索/歌单）' }
    /*
     * 搜索没返回结果时这一步“没跑”，而不是“跑失败”。把它报成失败，会把一个只是碰巧没有该关键词
     * 结果的健康音源说成不可用——自检的第一职责是别误导人。
     */
    if (!track) return { ok: true, skipped: true, message: '搜索没有返回结果，取地址未执行（换个关键词再试）' }
    try {
      const resolved = await resolveStream(id, track.sourceTrackId ?? track.id, settings, secrets, { track })
      return resolved?.url
        ? { ok: true, message: `解析成功：${resolved.url.slice(0, 48)}${resolved.url.length > 48 ? '…' : ''}` }
        : { ok: false, message: '音源没有返回可播放地址' }
    } catch (error) {
      const info = toCheckFailure(error)
      return { ok: false, message: info.message, ...(info.code ? { code: info.code } : {}) }
    }
  }

  let search: StepOutcome = await probe()
  await measure('search', '搜索', async () => search)
  /*
   * 取地址那一步**总是**出现在报告里（搜索没成功时它自己会说“未执行”）：步骤清单在两次运行之间
   * 保持一致，比“这次少了一行”更好读，也让“跳过的步骤不算失败”这条规则有地方可依。
   */
  let stream: StepOutcome = await streamOf(search.track)
  await measure('stream', '取播放地址', async () => stream)

  /*
   * 只在“被拒”这一种失败上修复，而且**必须把搜索也算进来**：零授权安装时，第一个被拒的请求就是
   * 搜索本身——把修复挂在“搜索成功之后”等于永远不修（这正是第一版自检的 bug，被这轮用例拓出来）。
   */
  const refused = [search, stream].some((step) => step?.code === 'PERMISSION')
  /*
   * The repair can be *refused* rather than merely unnecessary — 安全模式 does not grant hosts
   * automatically, and this button is one of the two places that used to do it anyway. The refusal is
   * carried out to the report (`repairBlocked`), because an empty `repaired` list reads as "all good"
   * while the source is in fact still refused and waiting for a manual grant.
   */
  let repairBlocked = ''
  if (options.repair && refused) {
    const result = await repairRefusedHosts(id)
    repaired.push(...result.granted)
    if (result.blocked) repairBlocked = result.blocked
    if (result.granted.length > 0) {
      search = await probe()
      stream = await streamOf(search.track)
      // 重试的结果覆盖上一次的结论：同一件事只该在页面上出现一次。
      const apply = (key: 'search' | 'stream', outcome: StepOutcome, suffix = ''): void => {
        const step = steps.find((item) => item.key === key)
        if (!step) {
          steps.push({ key, label: key === 'search' ? '搜索' : '取播放地址', ok: outcome.ok, message: outcome.message + suffix, ms: 0, ...(outcome.code ? { code: outcome.code } : {}) })
          return
        }
        step.ok = outcome.ok
        step.message = outcome.message + suffix
        if (outcome.code) step.code = outcome.code
        else delete step.code
        if (outcome.skipped) step.skipped = true
        else delete step.skipped
      }
      apply('search', search, ` · 自动允许 ${result.granted.join('、')} 后重试`)
      apply('stream', stream)
      /*
       * 重试成功后重新读一次运行时状态：修复前那一步读到的常常是“error”（因为刚刚被拒过），真修好了
       * 却还挂着旧结论，用户会以为自检没生效。
       */
      const refreshed = descriptorOf()
      if (refreshed) {
        const step = steps.find((item) => item.key === 'registered')
        if (step) step.message = `状态：${refreshed.status}`
      }
    }
  }

  const pendingHosts = readPendingHosts(id).map((item) => item.host)
  await measure('hosts', '联网授权', async () =>
    pendingHosts.length === 0
      ? { ok: true, message: `${(descriptor?.allowedHosts ?? entry.allowedHosts).length} 台主机已授权` }
      : { ok: false, code: 'PERMISSION', message: `${pendingHosts.length} 台主机等待授权：${pendingHosts.join('、')}` },
  )

  return {
    id,
    name: descriptor?.name ?? entry.name,
    // 跳过的步骤既不算通过也不算失败：它只是这次没被问到。
    ok: steps.every((step) => step.ok || step.skipped),
    at: Date.now(),
    keyword,
    steps,
    repaired,
    ...(repairBlocked ? { repairBlocked } : {}),
    pendingHosts: readPendingHosts(id).map((item) => item.host),
    errors: readErrorLog(id),
  }
}

/**
 * Runs the self-check over **every enabled source**, and turns the step reports into categories.
 *
 * Why this is not just a `for` loop in the UI: the single check takes seconds (a real search, a real
 * resolve, two timeouts), so a batch has to be bounded and it has to keep going after a failure — the
 * whole point is the one source that broke, and stopping at the first one is how that stays invisible.
 * Concurrency is 2: enough that a list of ten finishes in a reasonable time, low enough that a slow
 * connection is not asked to carry ten parallel searches (the previous 「检查全部」 ran sequentially for
 * the same reason).
 *
 * Verdicts are decided here rather than in the renderer, because the renderer would have to re-derive
 * them from step text — and a category that disagrees with the detail page it links to is worse than no
 * category at all.
 */
export async function selfCheckAllSources(
  options: { keyword?: string; repair?: boolean; concurrency?: number } = {},
): Promise<SourceCheckAllResult> {
  const keyword = (options.keyword ?? '周杰伦').slice(0, 60)
  const settings = getSettings()
  const enabled = listEntries().filter((entry) => settings.enabledSources[entry.id] !== false)
  /*
   * A source that is enabled in settings but absent from the runtime is *reported*, not silently
   * dropped: "脚本加载失败" is exactly the kind of thing a user cannot see any other way, and it looks
   * identical to "the source is fine but slow" until something says otherwise.
   */
  const runtime = new Map(describeSources(settings, allSecrets()).map((source) => [source.id, source]))

  const summaries: SourceCheckSummary[] = new Array(enabled.length)
  const limit = Math.min(Math.max(1, options.concurrency ?? 2), 4)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, enabled.length) }, async () => {
    while (cursor < enabled.length) {
      const index = cursor++
      const entry = enabled[index]!
      const started = Date.now()
      try {
        const report = await selfCheckSource(entry.id, { keyword, repair: options.repair === true })
        summaries[index] = classifyCheck(entry, runtime.get(entry.id), report, Date.now() - started)
      } catch (error) {
        // A thrown check is still an answer: the source is broken in a way its own steps could not
        // report (its code threw outside the step wrappers), and it must not take the batch down.
        const info = toCheckFailure(error)
        summaries[index] = {
          id: entry.id,
          name: entry.name,
          kind: entry.kind === 'declarative' ? 'declarative' : 'script',
          verdict: info.code === 'TIMEOUT' ? 'timeout' : 'error',
          detail: info.message,
          ...(info.code ? { code: info.code } : {}),
          pendingHosts: [],
          repaired: [],
          ms: Date.now() - started,
        }
      }
    }
  })
  await Promise.all(runners)

  const counts: Record<SourceCheckVerdict, number> = {
    ok: 0,
    unauthorized: 0,
    timeout: 0,
    empty: 0,
    unconfigured: 0,
    inactive: 0,
    error: 0,
  }
  for (const summary of summaries) counts[summary.verdict] += 1

  return {
    at: Date.now(),
    keyword,
    checked: summaries.length,
    skipped: listEntries().length - enabled.length,
    counts,
    headline: checkHeadline(counts, summaries.length),
    sources: summaries,
  }
}

/**
 * The category, and the sentence that goes with it.
 *
 * Order matters and is not arbitrary: "not loaded at all" explains everything downstream, and a pending
 * host explains a refusal that would otherwise read as a timeout. Both are checked before the error codes
 * so the row says the most actionable true thing about the source rather than the last thing that happened.
 */
function classifyCheck(
  entry: SourceEntry,
  descriptor: SourceDescriptor | undefined,
  report: SourceSelfCheckResult,
  ms: number,
): SourceCheckSummary {
  const kind: SourceCheckSummary['kind'] = entry.kind === 'declarative' ? 'declarative' : 'script'
  const base = {
    id: entry.id,
    name: report.name || entry.name,
    kind,
    pendingHosts: report.pendingHosts,
    repaired: report.repaired,
    ms,
  }
  const stepOf = (key: SourceSelfCheckStep['key']) => report.steps.find((step) => step.key === key)
  const failing = report.steps.find((step) => !step.ok && !step.skipped)

  if (!descriptor) {
    return {
      ...base,
      verdict: 'inactive',
      detail: '已启用，但运行时里没有它：脚本可能在加载时出错，重新加载或看下面的错误历史',
      step: 'registered',
    }
  }
  if (report.pendingHosts.length > 0) {
    return {
      ...base,
      verdict: 'unauthorized',
      detail: `需要访问 ${report.pendingHosts.join('、')}，尚未授权`,
      step: 'hosts',
      code: 'PERMISSION',
    }
  }
  if (failing?.code === 'PERMISSION') {
    return { ...base, verdict: 'unauthorized', detail: failing.message, step: failing.key, code: 'PERMISSION' }
  }
  if (failing?.code === 'NEEDS_CONFIG') {
    return { ...base, verdict: 'unconfigured', detail: failing.message, step: failing.key, code: 'NEEDS_CONFIG' }
  }
  if (failing?.code === 'TIMEOUT') {
    return { ...base, verdict: 'timeout', detail: failing.message, step: failing.key, code: 'TIMEOUT' }
  }
  if (failing) {
    return {
      ...base,
      verdict: 'error',
      detail: failing.message,
      step: failing.key,
      ...(failing.code ? { code: failing.code } : {}),
    }
  }
  /*
   * "Answered with nothing" is its own verdict on purpose. A zero-result search is not a broken source,
   * and lumping it in with the failures is how a healthy source gets "fixed" until it stops working.
   */
  const search = stepOf('search')
  if (search?.ok && /返回 0 条/.test(search.message)) {
    return { ...base, verdict: 'empty', detail: `搜索「${report.keyword}」没有结果：音源正常，换个关键词再试`, step: 'search' }
  }
  const stream = stepOf('stream')
  const detail = stream?.skipped
    ? `搜索可用；取播放地址未执行（${stream.message}）`
    : '搜索与取播放地址都正常'
  return { ...base, verdict: 'ok', detail, step: 'stream' }
}

/** One sentence for the header/toast: only the categories that actually occurred, in severity order. */
function checkHeadline(counts: Record<SourceCheckVerdict, number>, total: number): string {
  if (total === 0) return '没有已启用的音源可检查（先在下面的列表里启用一个）'
  const parts: string[] = []
  const named: Array<[SourceCheckVerdict, string]> = [
    ['ok', '正常'],
    ['empty', '正常但这个词没结果'],
    ['unauthorized', '待授权'],
    ['timeout', '超时'],
    ['unconfigured', '待配置'],
    ['inactive', '未加载'],
    ['error', '出错'],
  ]
  for (const [verdict, label] of named) if (counts[verdict] > 0) parts.push(`${counts[verdict]} 个${label}`)
  return `${total} 个已启用音源：${parts.join(' · ')}`
}

/** Keeps the self-check's failure reporting identical to the rest of the source layer. */
function toCheckFailure(error: unknown): { message: string; code?: SourceSelfCheckStep['code'] } {
  const info = error instanceof Error ? { message: error.message } : { message: String(error) }
  const code = (error as { code?: SourceSelfCheckStep['code'] } | null)?.code
  return code ? { message: info.message, code } : info
}
