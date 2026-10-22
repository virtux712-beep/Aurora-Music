/**
 * The **source access policy** — the two access decisions that are not per-source.
 *
 * Almost everything about a source is per-source: its hosts, its config, whether it is enabled. Two
 * things are not, and both are needed *inside the request path itself* (`sources/permissions.ts` for
 * script sources, `sources/http.ts` for declarative ones) — two places that do not carry a settings
 * object, because one of them is called from the sandbox bridge and the other from the manifest
 * adapter. Reading the same pair of booleans in four call sites is how a policy quietly diverges, so
 * it is installed once, from `main/settings.ts`, and read here.
 *
 * What lives here is a decision, not a cache: two booleans copied out of settings by the one module
 * that owns settings. Nothing in this file may read a file, and nothing may write one.
 */

export interface SourceAccessPolicy {
  /**
   * 安全模式 (safe mode) for platform access.
   *
   * On, two things change: an un-granted host is **never** granted automatically, and a cleartext
   * `http:` API request is refused. Off by default — most Chinese music aggregators publish `http://`
   * endpoints, so refusing cleartext is a real restriction rather than a free win, and a player that
   * silently stops resolving half its sources is a worse product than one that says what it is doing.
   */
  safeMode: boolean
  /** The user's own switch for granting a just-refused host automatically (see `autoGrantSourceHosts`). */
  autoGrantHosts: boolean
}

const DEFAULT_POLICY: SourceAccessPolicy = { safeMode: false, autoGrantHosts: true }

let policy: SourceAccessPolicy = { ...DEFAULT_POLICY }

/** Installs the policy. Called on settings load and on every settings change; partial patches keep the rest. */
export function setSourceAccessPolicy(next: Partial<SourceAccessPolicy>): void {
  policy = {
    safeMode: typeof next.safeMode === 'boolean' ? next.safeMode : policy.safeMode,
    autoGrantHosts: typeof next.autoGrantHosts === 'boolean' ? next.autoGrantHosts : policy.autoGrantHosts,
  }
}

export function sourceAccessPolicy(): SourceAccessPolicy {
  return { ...policy }
}

/** Only for tests: back to the shipped defaults. */
export function resetSourceAccessPolicy(): void {
  policy = { ...DEFAULT_POLICY }
}

/**
 * Whether an un-granted host may be granted automatically and the request retried.
 *
 * 安全模式 wins over the user's own toggle rather than being a third, independent switch: the two
 * would otherwise be able to disagree, and "safe mode is on but hosts are still being auto-granted"
 * is precisely the state safe mode exists to prevent. Turning safe mode off restores whatever the
 * user chose for `autoGrantSourceHosts`.
 */
export function hostAutoGrantAllowed(): boolean {
  return policy.autoGrantHosts && !policy.safeMode
}

/**
 * 安全模式's one hard rule for API traffic: no cleartext.
 *
 * Returns the sentence to refuse with, or `null` to proceed. Deliberately narrow: this covers the
 * **API/JSON** requests a source makes (search, metadata, a resolved address), not the audio bytes
 * themselves. Those go through the media relay against the same host allowlist, are never parsed as
 * data, and are published as `http://` by most aggregators' CDNs — refusing them would not raise the
 * bar, it would just make playback fail in a way that looks like a bug in the source.
 *
 * The sentence does **not** name the source. Every caller already prefixes its own errors with the
 * source's name (`fetchJson` labels its requests, both `authorize*` paths lead with `sourceName`), so
 * naming it here too printed it twice — "E2E 解析音源：E2E 解析音源：安全模式已开启…", which is the
 * kind of doubled text that makes a user assume the message is broken. The one caller with no name of
 * its own (the install probe) prefixes a label at the call site instead.
 *
 * The scheme is taken from the parsed URL, so an uppercase `HTTP://` or a URL with userinfo cannot
 * slip past a string prefix test.
 */
export function insecureRequestReason(url: string): string | null {
  if (!policy.safeMode) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    // Not a URL at all: the caller's own validation reports that, with a better message.
    return null
  }
  if (parsed.protocol !== 'http:') return null
  return `安全模式已开启，拒绝明文 http 请求 ${parsed.host}（设置 → 音源管理 可关闭安全模式，或让音源改用 https）`
}
