// Types for the tuning mechanism.
//
// On first boot, each Steve scans the user's project and pairs the
// resulting shape with its primitive seed. The output is a deterministic,
// auditable seal stored as a single JSONL line in the Steve's audit
// stream.
//
// Identifiers are neutral. No methodology vocabulary in shipped code.

/** A conservative read of the user's project. Any individual signal may
 * be `null` — scanning is best-effort and honest about gaps. */
export interface ProjectShape {
  /** A handful of free-form hints about what the project is about,
   * derived from CLAUDE.md headings + package.json description + recent
   * commit subjects. Never invented; only echoed. */
  domain_hints: readonly string[] | null;
  /** Subjects of the last 30 git commits, oldest first. null if the
   * project is not a git repo or git is unavailable. */
  recent_activity: readonly string[] | null;
  /** Frequency map of file extensions found at the root and one level
   * deep (e.g. {".ts": 42, ".md": 7}). null if scanning failed. */
  file_types: Readonly<Record<string, number>> | null;
  /** Names (no versions) of declared dependencies + devDependencies. null
   * if package.json is missing or unparseable. */
  package_dependencies: readonly string[] | null;
  /** First non-empty paragraph of CLAUDE.md (whitespace-collapsed,
   * truncated to ~400 chars). null if no CLAUDE.md. */
  claude_md_summary: string | null;
  /** Titles of the last ~10 PRs surfaced via `gh pr list`. null if gh is
   * missing, unauthenticated, or the call fails. */
  recent_pr_titles: readonly string[] | null;
}

/** A proposed task-type this Steve would gravitate toward, paired with
 * the primitives engaged. The pairing is a TYPE, not a concrete to-do —
 * concrete tasks emerge from the Slack conversation. */
export interface TaskPairing {
  task_type: string;
  rationale: string;
  primitives_engaged: readonly string[];
  example_signals_to_watch_for: readonly string[];
}

/** The deterministic sealed record of one Steve's tuning. Written as
 * a single line of `audit.jsonl` so the boot history is replayable. */
export interface TuningSeal {
  /** Schema/format marker for the audit entry. */
  kind: "tuning";
  /** ISO-8601 UTC. */
  at: string;
  steve_uuid: string;
  /** Content hash of the project shape (sha256, hex). Lets later events
   * detect whether the project has changed since tuning. */
  project_shape_hash: string;
  /** Content hash of the primitive seed (sha256, hex). */
  seed_hash: string;
  /** The proposed task pairings, in the order produced. */
  pairings: readonly TaskPairing[];
  /** Names of signals that were unavailable for this tuning (e.g.
   * "recent_pr_titles", "recent_activity"). Honest gap-tracking. */
  unavailable_signals: readonly string[];
  /** The seal hash — sha256 over (steve_uuid + project_shape_hash +
   * seed_hash + pairings). Returned as the public identifier of the
   * tuning event. */
  seal_hash: string;
}
