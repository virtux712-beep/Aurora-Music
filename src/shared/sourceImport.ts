/**
 * The **Source Detector** contract.
 *
 * "Install a source" means one thing to the user: hand Aurora a file. What that file *is* gets
 * decided here, and the answer is always one of:
 *
 *   - a JavaScript source (`defineAuroraSource({...})` or the LX `globalThis.lx` protocol),
 *   - a declarative JSON manifest (URLs + field mappings), or
 *   - an unrecognised file — reported as exactly that.
 *
 * Note what is *not* an outcome: "this is not an approved host / platform / provider". Detection is
 * about format, never about permission. Whether a source may be installed depends on whether the
 * runtime can load it, and whether it may reach a host is decided later, per request, by the
 * permission layer.
 */
export type DetectedSourceKind = 'script' | 'declarative' | 'unknown'

export interface SourceImportResult {
  ok: boolean
  kind: DetectedSourceKind
  /** File name (or a synthetic label when the text was pasted). */
  fileName: string
  /** A short human summary of what was recognised, shown as the import result. */
  summary: string
  /** Problems that stop an install. Format/contract problems only — never policy. */
  errors: string[]
  /**
   * Reasons to be careful, not reasons to refuse.
   *
   * A script that loads and runs but has not declared its capabilities yet lands here: it installs
   * (installing and running are separate stages — the manager can re-probe it later), and the UI says
   * so out loud rather than hiding it.
   */
  warnings?: string[]
  /** Original text, returned so the UI can save/export it unchanged. */
  text?: string
  /** For a script: what a no-permission probe run declared (`null` when the probe failed). */
  script?: {
    runtime: 'aurora' | 'lx'
    id: string
    name: string
    version: string
    description: string
    author: string
    homepage: string
    actions: string[]
    platforms: { id: string; name: string; icon?: string }[]
    qualities: string[]
    canSearch: boolean
    /** Hosts the script mentioned in its own text. Offered as suggested grants, never enforced. */
    suggestedHosts: string[]
    logs: string[]
    errors: string[]
  }
  /** For a declarative manifest: the manifest as pretty JSON, ready for the editor or a direct save. */
  manifestJson?: string
}
