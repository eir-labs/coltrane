// Tuning: on first boot, a Steve reads CLAUDE.md, scans the user's
// project, pairs the resulting shape with its primitive seed, and seals
// the result as a single JSONL line in its audit stream.
//
// Three responsibilities, all in this file:
//
//   1. scanProject(rootPath) — best-effort, honest-gaps read of the
//      project. Each signal that fails returns `null` instead of crashing.
//
//   2. proposeTaskPairings(projectShape, primitiveSeed) — pure function
//      that emits 2-4 task-TYPES this Steve would gravitate toward, given
//      which primitive dominates its seed. Same inputs → same outputs.
//
//   3. tune(...) — orchestration. Scans, loads the seed, produces the
//      pairings, computes content hashes + a seal hash, appends the seal
//      to audit.jsonl, returns the seal.
//
// Identity, in this module, is the residue of which functions keep
// showing up across tunings — never a role-name or a claim.

import { createHash } from "node:crypto";
import { appendFile, readFile, readdir, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import type { PrimitiveSeed } from "./scaffold.js";
import type {
  TuningSeal,
  ProjectShape,
  TaskPairing,
} from "./tuning_types.js";

const execFileAsync = promisify(execFile);

// --------------------------------------------------------------------
// scanProject
// --------------------------------------------------------------------

const CLAUDE_MD_SUMMARY_MAX = 400;
const RECENT_COMMITS_COUNT = 30;
const RECENT_PR_COUNT = 10;

async function readClaudeMdSummary(rootPath: string): Promise<string | null> {
  try {
    const raw = await readFile(join(rootPath, "CLAUDE.md"), "utf8");
    const paragraphs = raw
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0 && !p.startsWith("#"));
    const first = paragraphs[0];
    if (!first) return null;
    const collapsed = first.replace(/\s+/g, " ").trim();
    if (collapsed.length <= CLAUDE_MD_SUMMARY_MAX) return collapsed;
    return collapsed.slice(0, CLAUDE_MD_SUMMARY_MAX - 1) + "…";
  } catch {
    return null;
  }
}

async function readDomainHints(
  rootPath: string,
  claudeMdSummary: string | null,
  packageDescription: string | null,
  recentActivity: readonly string[] | null,
): Promise<readonly string[] | null> {
  const hints: string[] = [];
  // CLAUDE.md headings: pull the first 3 h2 lines if present.
  try {
    const raw = await readFile(join(rootPath, "CLAUDE.md"), "utf8");
    const h2 = raw
      .split("\n")
      .filter((l) => /^##\s+\S/.test(l))
      .slice(0, 3)
      .map((l) => l.replace(/^##\s+/, "").trim());
    hints.push(...h2);
  } catch {
    // no CLAUDE.md — fine
  }
  if (packageDescription) hints.push(packageDescription);
  if (claudeMdSummary) {
    // first sentence of the summary
    const firstSentence = claudeMdSummary.split(/[.!?]\s/)[0];
    if (firstSentence) hints.push(firstSentence.trim());
  }
  if (recentActivity && recentActivity.length > 0) {
    // include the most recent commit subject as a hint
    const last = recentActivity[recentActivity.length - 1];
    if (last) hints.push(last);
  }
  // dedupe, preserve order, cap at 6
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const h of hints) {
    if (seen.has(h)) continue;
    seen.add(h);
    deduped.push(h);
    if (deduped.length >= 6) break;
  }
  return deduped.length > 0 ? deduped : null;
}

async function readPackageJson(
  rootPath: string,
): Promise<{ description: string | null; dependencies: readonly string[] | null }> {
  try {
    const raw = await readFile(join(rootPath, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const deps = {
      ...(parsed["dependencies"] as Record<string, string> | undefined),
      ...(parsed["devDependencies"] as Record<string, string> | undefined),
    };
    const names = Object.keys(deps).sort();
    const description = typeof parsed["description"] === "string" ? (parsed["description"] as string) : null;
    return {
      description,
      dependencies: names.length > 0 ? names : null,
    };
  } catch {
    return { description: null, dependencies: null };
  }
}

async function readRecentCommits(
  rootPath: string,
): Promise<readonly string[] | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", rootPath, "log", `-n`, String(RECENT_COMMITS_COUNT), "--pretty=format:%s", "--reverse"],
      { maxBuffer: 1024 * 1024 },
    );
    const lines = stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    return lines.length > 0 ? lines : null;
  } catch {
    return null;
  }
}

async function readFileTypes(
  rootPath: string,
): Promise<Readonly<Record<string, number>> | null> {
  try {
    const counts: Record<string, number> = {};
    const incr = (name: string) => {
      const dot = name.lastIndexOf(".");
      if (dot <= 0) return;
      const ext = name.slice(dot).toLowerCase();
      counts[ext] = (counts[ext] ?? 0) + 1;
    };
    const rootEntries = await readdir(rootPath, { withFileTypes: true });
    for (const ent of rootEntries) {
      if (ent.name.startsWith(".")) continue;
      if (ent.name === "node_modules" || ent.name === "dist") continue;
      const full = join(rootPath, ent.name);
      if (ent.isFile()) {
        incr(ent.name);
      } else if (ent.isDirectory()) {
        try {
          const sub = await readdir(full, { withFileTypes: true });
          for (const s of sub) {
            if (s.isFile()) incr(s.name);
          }
        } catch {
          // ignore unreadable subdir
        }
      }
    }
    return Object.keys(counts).length > 0 ? counts : null;
  } catch {
    return null;
  }
}

async function readRecentPrTitles(
  rootPath: string,
): Promise<readonly string[] | null> {
  // gh CLI is best-effort. Missing gh / unauthenticated / network failure
  // → null. Never blow up the tuning.
  try {
    const { stdout } = await execFileAsync(
      "gh",
      [
        "pr",
        "list",
        "--limit",
        String(RECENT_PR_COUNT),
        "--state",
        "all",
        "--json",
        "title",
        "-q",
        ".[].title",
      ],
      { cwd: rootPath, maxBuffer: 1024 * 1024, timeout: 5000 },
    );
    const titles = stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    return titles.length > 0 ? titles : null;
  } catch {
    return null;
  }
}

/** Best-effort, honest-gaps read of the project. Every individual signal
 * is `null` when unavailable; this function never throws. */
export async function scanProject(rootPath: string): Promise<ProjectShape> {
  // Validate rootPath up front — if it isn't a directory, return an
  // all-null shape rather than throwing.
  try {
    const s = await stat(rootPath);
    if (!s.isDirectory()) {
      return {
        domain_hints: null,
        recent_activity: null,
        file_types: null,
        package_dependencies: null,
        claude_md_summary: null,
        recent_pr_titles: null,
      };
    }
  } catch {
    return {
      domain_hints: null,
      recent_activity: null,
      file_types: null,
      package_dependencies: null,
      claude_md_summary: null,
      recent_pr_titles: null,
    };
  }

  const [claudeMdSummary, pkg, recentActivity, fileTypes, prTitles] = await Promise.all([
    readClaudeMdSummary(rootPath),
    readPackageJson(rootPath),
    readRecentCommits(rootPath),
    readFileTypes(rootPath),
    readRecentPrTitles(rootPath),
  ]);

  const domainHints = await readDomainHints(
    rootPath,
    claudeMdSummary,
    pkg.description,
    recentActivity,
  );

  return {
    domain_hints: domainHints,
    recent_activity: recentActivity,
    file_types: fileTypes,
    package_dependencies: pkg.dependencies,
    claude_md_summary: claudeMdSummary,
    recent_pr_titles: prTitles,
  };
}

// --------------------------------------------------------------------
// proposeTaskPairings (PURE)
// --------------------------------------------------------------------

type PrimitiveName = keyof PrimitiveSeed;

/** Pick the dominant primitive — the one with the strictly-highest
 * weight. Ties resolve by a fixed alphabetical order so the function
 * stays deterministic across runs. */
function dominantPrimitive(seed: PrimitiveSeed): PrimitiveName | null {
  const entries = (Object.entries(seed) as ReadonlyArray<[PrimitiveName, number]>)
    .slice()
    .sort((a, b) => {
      if (a[1] !== b[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    });
  const [top, second] = entries;
  if (!top) return null;
  if (second && top[1] === second[1]) return null;
  return top[0];
}

/** Variance of the seed weights — used to detect a "balanced" seed where
 * no primitive dominates. */
function seedVariance(seed: PrimitiveSeed): number {
  const values = Object.values(seed);
  const n = values.length;
  if (n === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  return values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / n;
}

interface PairingTemplate {
  task_type: string;
  rationale: string;
  primitives_engaged: readonly string[];
  example_signals_to_watch_for: readonly string[];
}

const TEMPLATES_BY_PRIMITIVE: Readonly<Record<PrimitiveName, readonly PairingTemplate[]>> = {
  sense: [
    {
      task_type: "scan_for_new_signals",
      rationale: "lane tilts toward intake; surface what the user hasn't named yet",
      primitives_engaged: ["sense", "interpret"],
      example_signals_to_watch_for: ["unfamiliar file types", "new commit subjects", "fresh dependency names"],
    },
    {
      task_type: "summarize_recent_activity",
      rationale: "lane tilts toward intake; restate the project's shape back at the user",
      primitives_engaged: ["sense", "interpret"],
      example_signals_to_watch_for: ["recent_activity changes", "domain hint drift"],
    },
  ],
  interpret: [
    {
      task_type: "translate_between_terms",
      rationale: "lane tilts toward interpretation; bridge vocabulary across files",
      primitives_engaged: ["interpret", "sense"],
      example_signals_to_watch_for: ["mismatched identifiers", "renamed types", "doc drift"],
    },
    {
      task_type: "annotate_unclear_passages",
      rationale: "lane tilts toward interpretation; mark ambiguity before judgement",
      primitives_engaged: ["interpret", "reflect"],
      example_signals_to_watch_for: ["TODO/FIXME", "questions in comments"],
    },
  ],
  judge: [
    {
      task_type: "review_pending_changes",
      rationale: "lane tilts toward judgement; pass/fail the current diff",
      primitives_engaged: ["judge", "verify"],
      example_signals_to_watch_for: ["open PRs", "uncommitted changes", "failing tests"],
    },
    {
      task_type: "rank_competing_options",
      rationale: "lane tilts toward judgement; pick between alternatives the user surfaces",
      primitives_engaged: ["judge", "interpret"],
      example_signals_to_watch_for: ["comparison threads", "A-vs-B questions"],
    },
  ],
  plan: [
    {
      task_type: "compose_next_steps",
      rationale: "lane tilts toward planning; sequence the work the user is choosing between",
      primitives_engaged: ["plan", "create"],
      example_signals_to_watch_for: ["unsequenced backlog", "blocked dependencies", "stale milestones"],
    },
    {
      task_type: "scope_the_next_increment",
      rationale: "lane tilts toward planning; carve a small enough next step",
      primitives_engaged: ["plan", "judge"],
      example_signals_to_watch_for: ["over-large issues", "estimate misses"],
    },
  ],
  create: [
    {
      task_type: "draft_new_artifact",
      rationale: "lane tilts toward production; first-pass the artifact the user names",
      primitives_engaged: ["create", "plan"],
      example_signals_to_watch_for: ["empty file paths", "stub functions", "missing tests"],
    },
    {
      task_type: "fill_gap_with_concrete_example",
      rationale: "lane tilts toward production; turn a sketch into something runnable",
      primitives_engaged: ["create", "interpret"],
      example_signals_to_watch_for: ["docs without examples", "types without instances"],
    },
  ],
  verify: [
    {
      task_type: "run_existing_checks",
      rationale: "lane tilts toward verification; observe the current state honestly",
      primitives_engaged: ["verify", "sense"],
      example_signals_to_watch_for: ["test command in package.json", "CI config", "lint config"],
    },
    {
      task_type: "compare_claim_to_evidence",
      rationale: "lane tilts toward verification; confirm what was asserted",
      primitives_engaged: ["verify", "judge"],
      example_signals_to_watch_for: ["claims in PR titles", "commit messages stating outcomes"],
    },
  ],
  reflect: [
    {
      task_type: "summarize_recent_arc",
      rationale: "lane tilts toward reflection; restate the longer-arc of work",
      primitives_engaged: ["reflect", "interpret"],
      example_signals_to_watch_for: ["commit-history themes", "PR-title clusters"],
    },
    {
      task_type: "name_pattern_across_sessions",
      rationale: "lane tilts toward reflection; surface the residue of repeated functions",
      primitives_engaged: ["reflect", "sense"],
      example_signals_to_watch_for: ["recurring file edits", "repeated kinds of question"],
    },
  ],
};

const BALANCED_TEMPLATES: readonly PairingTemplate[] = [
  {
    task_type: "route_incoming_request",
    rationale: "seed is balanced; dispatch to whichever primitive the request invites",
    primitives_engaged: ["sense", "interpret", "judge"],
    example_signals_to_watch_for: ["explicit asks", "open questions", "named handoffs"],
  },
  {
    task_type: "hold_the_thread",
    rationale: "seed is balanced; track conversation state so other Steves can specialize",
    primitives_engaged: ["sense", "reflect"],
    example_signals_to_watch_for: ["thread_ts continuity", "user re-pings", "topic resumption"],
  },
];

/** Pure: given a project shape and a primitive seed, propose 2-4 task
 * TYPES this Steve gravitates toward. Same inputs → same outputs. */
export function proposeTaskPairings(
  projectShape: ProjectShape,
  primitiveSeed: PrimitiveSeed,
): TaskPairing[] {
  // Balanced-seed heuristic: when the weights have low variance OR no
  // strict winner, fall back to routing-flavor pairings.
  const variance = seedVariance(primitiveSeed);
  const dominant = dominantPrimitive(primitiveSeed);
  const isBalanced = dominant === null || variance < 0.005;

  const base: readonly PairingTemplate[] = isBalanced
    ? BALANCED_TEMPLATES
    : (TEMPLATES_BY_PRIMITIVE[dominant] ?? BALANCED_TEMPLATES);

  // Light project-shape filter: if the project clearly has tests but no
  // CI signal in recent activity, prepend a verify-tinged pairing for
  // verify-dominant; if domain_hints is empty, prepend a scan-tinged one
  // for sense-dominant. These are SHAPE-driven, not noise.
  const pairings: PairingTemplate[] = base.slice();

  if (!isBalanced && dominant && projectShape.domain_hints === null && dominant !== "sense") {
    pairings.unshift({
      task_type: "scan_for_initial_orientation",
      rationale: "project shape is sparse; orient before specializing",
      primitives_engaged: ["sense", dominant],
      example_signals_to_watch_for: ["user's first descriptor of the work", "any added context"],
    });
  }

  // Cap at 4 (and always at least 2; templates already guarantee >=2).
  const capped = pairings.slice(0, 4);
  // Return as plain TaskPairing[] (drop the template alias).
  return capped.map((t) => ({
    task_type: t.task_type,
    rationale: t.rationale,
    primitives_engaged: [...t.primitives_engaged],
    example_signals_to_watch_for: [...t.example_signals_to_watch_for],
  }));
}

// --------------------------------------------------------------------
// tune
// --------------------------------------------------------------------

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Stable JSON: sort object keys recursively so content hashes are
 * invariant to property-insertion order. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k]))
      .join(",") +
    "}"
  );
}

function unavailableSignalsFor(shape: ProjectShape): string[] {
  const out: string[] = [];
  if (shape.domain_hints === null) out.push("domain_hints");
  if (shape.recent_activity === null) out.push("recent_activity");
  if (shape.file_types === null) out.push("file_types");
  if (shape.package_dependencies === null) out.push("package_dependencies");
  if (shape.claude_md_summary === null) out.push("claude_md_summary");
  if (shape.recent_pr_titles === null) out.push("recent_pr_titles");
  return out;
}

/** Orchestrate: scan project → load seed → propose pairings → write a
 * sealed tuning event to audit.jsonl → return the seal. */
export async function tune(
  uuid: string,
  seedPath: string,
  rootPath: string,
  auditPath: string,
  options?: { now?: () => Date; audit_sink?: (line: string) => Promise<void> },
): Promise<TuningSeal> {
  const seedRaw = await readFile(seedPath, "utf8");
  const seedDoc = JSON.parse(seedRaw) as { primitive_seed: PrimitiveSeed };
  const primitiveSeed = seedDoc.primitive_seed;

  const projectShape = await scanProject(rootPath);
  const pairings = proposeTaskPairings(projectShape, primitiveSeed);

  const projectShapeHash = sha256Hex(stableStringify(projectShape));
  const seedHash = sha256Hex(stableStringify(primitiveSeed));
  const sealHash = sha256Hex(
    stableStringify({
      steve_uuid: uuid,
      project_shape_hash: projectShapeHash,
      seed_hash: seedHash,
      pairings,
    }),
  );

  const at = (options?.now ?? (() => new Date()))().toISOString();

  const seal: TuningSeal = {
    kind: "tuning",
    at,
    steve_uuid: uuid,
    project_shape_hash: projectShapeHash,
    seed_hash: seedHash,
    pairings,
    unavailable_signals: unavailableSignalsFor(projectShape),
    seal_hash: sealHash,
  };

  const line = JSON.stringify(seal) + "\n";
  if (options?.audit_sink) {
    await options.audit_sink(line);
  } else {
    await appendFile(auditPath, line, "utf8");
  }
  return seal;
}
