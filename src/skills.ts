// Skills-as-first-class — the API surface (docs/skills-as-first-class.md).
//
// Execution + the fixture/determinism runner are IMPLEMENTED in skill_subprocess.ts.
// The rest of the contract — package loading + code_hash, code-first/model-residual
// resolution, the per-resolution telemetry record, determinism_ratio computed from
// those records, the evolution gate, and composition — is declared here as typed
// stubs so the RED contract suite typechecks and fails honestly on assertions (not on
// missing imports). Each stub throws NotImplemented; the build fills them in green.
import { readFileSync, existsSync, mkdtempSync, mkdirSync, copyFileSync, readdirSync, rmSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  type SkillMeta,
  type SkillFixture,
  type ExecuteResult,
  readSkillMeta,
  executeSkill,
  loadFixtures,
  runSkillFixtures,
} from "./skill_subprocess.js";

export {
  executeSkill,
  runSkillFixtures,
  loadFixtures,
  readSkillMeta,
  tierFlags,
  type SkillMeta,
  type SkillFixture,
  type ExecuteResult,
  type FixtureReport,
  type FixtureResult,
} from "./skill_subprocess.js";

class NotImplemented extends Error {
  constructor(what: string) {
    super(`not implemented: ${what}`);
    this.name = "NotImplemented";
  }
}

// Typed errors at the skill layer (mirror the genome carve: hard-fail where there's no
// recoverable order, soft-fail-with-named-error where a definition is just broken).
export class SkillLoadError extends Error {}
export class SkillCompositionCycleError extends Error {}

// Declare the hash format so implementations match.
export const CODE_HASH_ALGO = "sha256";
export function hashSkillCode(codePath: string): string {
  return `${CODE_HASH_ALGO}:${createHash(CODE_HASH_ALGO).update(readFileSync(codePath)).digest("hex")}`;
}

// ── Package loading + identity ────────────────────────────────────────────────
export interface SkillPackage {
  dir: string;
  meta: SkillMeta & {
    code_hash?: string;
    composable_with?: readonly string[];
    input_schema?: Record<string, unknown>;
    output_schema?: Record<string, unknown>;
  };
  codeHash: string | null; // computed sha256 of skill.mjs; null when there's no code half
  fixtures: SkillFixture[];
  mdPath: string | null;   // dual-artifact reasoning half (skill.md), if present
}
/** Load a skill package: meta + code (content-hashed) + fixtures + the reasoning half.
 *  A malformed package (unreadable/sluggless meta, bad fixture shape) raises SkillLoadError;
 *  an ABSENT code half is allowed (codeHash null) — that degrades to pure reasoning at run. */
export function loadSkillPackage(dir: string): SkillPackage {
  let meta: SkillPackage["meta"];
  try {
    meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf-8")) as SkillPackage["meta"];
  } catch (e) {
    throw new SkillLoadError(`skill package ${dir}: cannot read meta.json — ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!meta || typeof meta.slug !== "string" || meta.slug.trim() === "") {
    throw new SkillLoadError(`skill package ${dir}: meta.json is missing a slug`);
  }
  const codePath = join(dir, "skill.mjs");
  const codeHash = existsSync(codePath) ? hashSkillCode(codePath) : null;
  const mdPath = existsSync(join(dir, "skill.md")) ? join(dir, "skill.md") : null;
  const fixtures = loadFixtures(dir);
  for (const fx of fixtures) {
    if (typeof fx.id !== "string" || fx.id.trim() === "" || fx.input === undefined) {
      throw new SkillLoadError(`skill package ${meta.slug}: a fixture has an invalid shape (each needs a non-empty id and an input)`);
    }
  }
  return { dir, meta, codeHash, fixtures, mdPath };
}

// ── Code-first / model-residual resolution (Phase 2) ──────────────────────────
export type FieldOrigin = "code" | "model";
export interface ResolutionResult {
  output: Record<string, unknown>;
  resolved: Record<string, unknown>;   // what skill.mjs produced
  residual: string[];                  // output_schema fields the code did NOT resolve
  field_origins: Record<string, FieldOrigin>;
  // Set when the code half could not be trusted/run (hash mismatch, throw, missing,
  // invalid output) and the skill degraded to pure-reasoning. Never silent — the reason
  // is surfaced here and logged. Absent on a clean code-first resolution.
  degraded?: { reason: string };
}
export type ResidualInvoker = (ctx: {
  unresolved: readonly string[];
  resolved: Record<string, unknown>;
  md: string;
}) => Record<string, unknown> | Promise<Record<string, unknown>>;
/** Options for resolution + chain recording. `chainDir` isolates the durable chain so
 *  tests (and consumers) can point it at a scratch location instead of ambient state. */
export interface SkillChainOpts {
  chainDir?: string;
}
function pick(o: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const r: Record<string, unknown> = {};
  for (const k of keys) if (k in o) r[k] = o[k];
  return r;
}

// Warn once (not per-call) when resolutions run with no chainDir: every such call records
// NO SkillChainEvent, so determinism_ratio never accumulates. The absence is a real gap, not
// a no-op — surface it once so it's visible without spamming a tight resolve loop.
let warnedNoChainDir = false;

/** Run code first, compute the residual, let the model fill only the gap, tag origins.
 *  When `opts.chainDir` is set, append a SkillChainEvent recording this resolution. */
export async function resolveSkill(
  dir: string,
  input: unknown,
  invoke: ResidualInvoker,
  opts?: SkillChainOpts,
): Promise<ResolutionResult> {
  if (!opts?.chainDir && !warnedNoChainDir) {
    warnedNoChainDir = true;
    console.warn("[skills] resolveSkill running without chainDir — no SkillChainEvent recorded; determinism_ratio will not accumulate.");
  }
  const pkg = loadSkillPackage(dir);
  // schema fields bound what code/model may resolve. No schema → the code's own keys are
  // the shape (nothing is "unresolved"), so the model is never asked.
  const props = pkg.meta.output_schema?.properties as Record<string, unknown> | undefined;
  const schemaFields: string[] | null = props ? Object.keys(props) : null;

  // 1. code first — unless the code can't be trusted/run (graceful degradation, never throws)
  let resolved: Record<string, unknown> = {};
  let degraded: { reason: string } | undefined;
  let duration_ms = 0;
  if (pkg.codeHash === null) {
    degraded = { reason: "no code half — resolving via pure reasoning" };
  } else if (typeof pkg.meta.code_hash === "string" && pkg.meta.code_hash !== pkg.codeHash) {
    degraded = { reason: `code_hash mismatch — declared ${pkg.meta.code_hash}, on disk ${pkg.codeHash}; unverified code not run` };
  } else {
    const r = executeSkill(dir, input);
    duration_ms = r.duration_ms;
    if (!r.ok) {
      degraded = { reason: `code half threw / produced no output: ${r.error}` };
    } else {
      const out = (r.output && typeof r.output === "object" ? r.output : {}) as Record<string, unknown>;
      // typing guarantee: code can only resolve fields that exist in the output schema
      resolved = schemaFields ? pick(out, schemaFields) : out;
    }
  }

  // 2. residual = schema − what the code resolved (subset of the schema, always)
  const resolvedKeys = Object.keys(resolved);
  const residual = schemaFields ? schemaFields.filter((f) => !resolvedKeys.includes(f)) : [];

  // 3. the model fills ONLY the residual; resolved fields are verified context it can't override
  let modelFields: Record<string, unknown> = {};
  if (residual.length > 0) {
    const md = pkg.mdPath ? readFileSync(pkg.mdPath, "utf-8") : "";
    const m = await invoke({ unresolved: residual, resolved, md });
    modelFields = pick(m ?? {}, residual);
  }

  // 4. union + origins
  const output = { ...resolved, ...modelFields };
  const field_origins: Record<string, FieldOrigin> = {};
  for (const k of Object.keys(resolved)) field_origins[k] = "code";
  for (const k of Object.keys(modelFields)) field_origins[k] = "model";

  if (opts?.chainDir) {
    appendSkillChainEvent(opts.chainDir, {
      slug: pkg.meta.slug,
      version: pkg.meta.version,
      code_hash: pkg.codeHash ?? "",
      tier: pkg.meta.permission?.tier ?? 0,
      duration_ms,
      permission_violations: [],
      field_origins,
      ...(degraded ? { degraded_reason: degraded.reason } : {}),
    });
  }

  return { output, resolved, residual, field_origins, ...(degraded ? { degraded } : {}) };
}

function appendSkillChainEvent(chainDir: string, ev: SkillChainEvent): void {
  mkdirSync(chainDir, { recursive: true });
  appendFileSync(join(chainDir, `${ev.slug}.jsonl`), JSON.stringify(ev) + "\n");
}

// ── Resolution telemetry — the recorded field-origin log determinism reads from ──
// A plain append log of what each resolution did: which fields the code resolved vs the
// model, how long it took, any permission denials. determinism_ratio is the rolling
// average over these records.
export interface SkillChainEvent {
  slug: string;
  version: number;
  code_hash: string;
  tier: number;
  duration_ms: number;
  // v2 hook — Node `--permission` denials are silent today, so this is written `[]` until a
  // capture path lands. Kept in the shape now so the event format doesn't change when it does.
  permission_violations: string[];
  field_origins: Record<string, FieldOrigin>;
  // Why a resolution fell back to pure reasoning (no code half / hash mismatch / code threw),
  // recorded ON the event so an audit-replay of "why did this skill degrade across N runs"
  // reads from the chain, not just the live ResolutionResult. Absent = resolved cleanly.
  degraded_reason?: string;
}
/** Read the recorded resolution events for a skill+version — the log determinism reads from. */
export function skillChainEvents(slug: string, version?: number, opts?: SkillChainOpts): SkillChainEvent[] {
  const dir = opts?.chainDir;
  if (!dir) return []; // ambient store (from sealed records) is a Phase-3 open question
  const path = join(dir, `${slug}.jsonl`);
  if (!existsSync(path)) return [];
  const events = readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as SkillChainEvent);
  return version === undefined ? events : events.filter((e) => e.version === version);
}

// ── determinism_ratio — computed from the recorded log, not declared ──
export interface DeterminismReport {
  slug: string;
  version: number;
  ratio: number;       // fraction of output fields resolved by code, rolling avg
  window: number;      // number of recent chain events aggregated
  samples: number;     // events actually found
}
export function computeDeterminismRatio(
  slug: string,
  version: number,
  opts?: SkillChainOpts & { window?: number },
): DeterminismReport {
  const window = opts?.window ?? 100;
  const events = skillChainEvents(slug, version, opts).slice(-window);
  // each event's code-resolved fraction; the ratio is the rolling average across the window
  const fractions = events.map((e) => {
    const origins = Object.values(e.field_origins);
    return origins.length ? origins.filter((o) => o === "code").length / origins.length : 0;
  });
  const ratio = fractions.length ? fractions.reduce((a, b) => a + b, 0) / fractions.length : 0;
  return { slug, version, ratio, window, samples: events.length };
}

// ── Evolution gate (test 3 extension) ─────────────────────────────────────────
export interface EvolutionVerdict {
  accepted: boolean;
  failing_fixtures: string[]; // fixtures the candidate regressed (empty when accepted)
}
/** Run a candidate skill.mjs against the package's fixtures; accept iff none regress. The
 *  fixtures are the evolution gate: an "improvement" that breaks any committed contract is
 *  rejected, and the broken fixtures are named. */
export function evolveSkill(dir: string, candidateCodePath: string): EvolutionVerdict {
  const tmp = mkdtempSync(join(tmpdir(), "coltrane-evolve-"));
  try {
    copyFileSync(join(dir, "meta.json"), join(tmp, "meta.json"));
    const fxSrc = join(dir, "fixtures");
    if (existsSync(fxSrc)) {
      mkdirSync(join(tmp, "fixtures"), { recursive: true });
      for (const f of readdirSync(fxSrc)) copyFileSync(join(fxSrc, f), join(tmp, "fixtures", f));
    }
    copyFileSync(candidateCodePath, join(tmp, "skill.mjs"));
    const report = runSkillFixtures(tmp);
    const failing_fixtures = report.results.filter((r) => !r.passed).map((r) => r.id);
    return { accepted: failing_fixtures.length === 0, failing_fixtures };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ── Composition (test 8) ──────────────────────────────────────────────────────
export interface CompositionResult {
  order: string[];          // execution order resolved from composable_with deps
  merged_residual: string[]; // fields no skill's code resolved
}
/** Compose multiple skills for one chair: validate composable_with, order by deps,
 *  detect cycles (SkillCompositionCycleError), merge the residual. */
export function composeSkills(dirs: readonly string[]): CompositionResult {
  const pkgs = dirs.map((d) => loadSkillPackage(d));
  const slugs = pkgs.map((p) => p.meta.slug);
  const fields = (p: SkillPackage, half: "input_schema" | "output_schema"): string[] =>
    Object.keys((p.meta[half]?.properties ?? {}) as Record<string, unknown>);

  // 1. composable_with: every pair must be declared composable by at least one side
  for (let i = 0; i < pkgs.length; i++) {
    for (let j = i + 1; j < pkgs.length; j++) {
      const a = pkgs[i]!, b = pkgs[j]!;
      const ok = (a.meta.composable_with ?? []).includes(b.meta.slug) || (b.meta.composable_with ?? []).includes(a.meta.slug);
      if (!ok) throw new SkillLoadError(`skills "${a.meta.slug}" and "${b.meta.slug}" are not composable_with each other`);
    }
  }

  // 2. shared output fields must declare identical types
  const seen = new Map<string, { type: unknown; owner: string }>();
  for (const p of pkgs) {
    const props = (p.meta.output_schema?.properties ?? {}) as Record<string, { type?: unknown }>;
    for (const [f, def] of Object.entries(props)) {
      const prev = seen.get(f);
      if (prev && JSON.stringify(prev.type) !== JSON.stringify(def?.type)) {
        throw new SkillLoadError(`type conflict on shared output field "${f}": "${prev.owner}" declares ${JSON.stringify(prev.type)}, "${p.meta.slug}" declares ${JSON.stringify(def?.type)}`);
      }
      if (!prev) seen.set(f, { type: def?.type, owner: p.meta.slug });
    }
  }

  // 3. dependency edges: B depends on A if B's input references a field A outputs
  const outputs = new Map(pkgs.map((p) => [p.meta.slug, new Set(fields(p, "output_schema"))]));
  const deps = new Map<string, Set<string>>(slugs.map((s) => [s, new Set<string>()]));
  for (const p of pkgs) {
    for (const other of pkgs) {
      if (other.meta.slug === p.meta.slug) continue;
      const outs = outputs.get(other.meta.slug)!;
      if (fields(p, "input_schema").some((f) => outs.has(f))) deps.get(p.meta.slug)!.add(other.meta.slug);
    }
  }

  // 4. topological order (deterministic, independent of input order); cycle → cycle error.
  // The error names the FULL cycle path (A → B → C → A), not just the node we re-entered —
  // a one-node message can't be regression-tested for the right cycle, and a multi-node
  // cycle is undebuggable without its path. The in-progress (color-1) stack IS the path.
  const order: string[] = [];
  const state = new Map<string, 0 | 1 | 2>();
  const visit = (s: string, path: string[]): void => {
    const st = state.get(s) ?? 0;
    if (st === 2) return;
    if (st === 1) {
      const from = path.indexOf(s);
      const cycle = [...path.slice(from), s].join(" → ");
      throw new SkillCompositionCycleError(`skill composition cycle: ${cycle}`);
    }
    state.set(s, 1);
    for (const d of [...deps.get(s)!].sort()) visit(d, [...path, s]);
    state.set(s, 2);
    order.push(s);
  };
  for (const s of [...slugs].sort()) visit(s, []);

  // 5. merged residual: fields no skill's code resolves (a pure-reasoning skill resolves none)
  const merged = new Set<string>();
  for (const p of pkgs) if (p.codeHash === null) for (const f of fields(p, "output_schema")) merged.add(f);

  return { order, merged_residual: [...merged] };
}

// Re-export to keep the type checker honest about unused-import in stubs.
void (readSkillMeta as unknown);
void (executeSkill as unknown);
export type { ExecuteResult as _ExecuteResult };
