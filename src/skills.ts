// Skills-as-first-class — the API surface (docs/skills-as-first-class.md).
//
// Execution + the fixture/determinism runner are IMPLEMENTED in skill_subprocess.ts.
// The rest of the contract — package loading + code_hash, code-first/model-residual
// resolution, the per-resolution telemetry record, determinism_ratio computed from
// those records, the evolution gate, and composition — is declared here as typed
// stubs so the RED contract suite typechecks and fails honestly on assertions (not on
// missing imports). Each stub throws NotImplemented; the build fills them in green.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  type SkillMeta,
  type SkillFixture,
  type ExecuteResult,
  readSkillMeta,
  executeSkill,
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
/** Load a skill package: meta + code (hash-verified) + fixtures + the reasoning half. */
export function loadSkillPackage(_dir: string): SkillPackage {
  throw new NotImplemented("loadSkillPackage");
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
/** Run code first, compute the residual, let the model fill only the gap, tag origins.
 *  When `opts.chainDir` is set, append a SkillChainEvent recording this resolution. */
export function resolveSkill(
  _dir: string,
  _input: unknown,
  _invoke: ResidualInvoker,
  _opts?: SkillChainOpts,
): Promise<ResolutionResult> {
  throw new NotImplemented("resolveSkill");
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
  permission_violations: string[];
  field_origins: Record<string, FieldOrigin>;
}
/** Read the recorded resolution events for a skill+version — the log determinism reads from. */
export function skillChainEvents(_slug: string, _version?: number, _opts?: SkillChainOpts): SkillChainEvent[] {
  throw new NotImplemented("skillChainEvents");
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
  _slug: string,
  _version: number,
  _opts?: SkillChainOpts & { window?: number },
): DeterminismReport {
  throw new NotImplemented("computeDeterminismRatio");
}

// ── Evolution gate (test 3 extension) ─────────────────────────────────────────
export interface EvolutionVerdict {
  accepted: boolean;
  failing_fixtures: string[]; // fixtures the candidate regressed (empty when accepted)
}
/** Run a candidate skill.mjs against the package's fixtures; accept iff none regress. */
export function evolveSkill(_dir: string, _candidateCodePath: string): EvolutionVerdict {
  throw new NotImplemented("evolveSkill");
}

// ── Composition (test 8) ──────────────────────────────────────────────────────
export interface CompositionResult {
  order: string[];          // execution order resolved from composable_with deps
  merged_residual: string[]; // fields no skill's code resolved
}
/** Compose multiple skills for one chair: validate composable_with, order by deps,
 *  detect cycles (SkillCompositionCycleError), merge the residual. */
export function composeSkills(_dirs: readonly string[]): CompositionResult {
  throw new NotImplemented("composeSkills");
}

// Re-export to keep the type checker honest about unused-import in stubs.
void (readSkillMeta as unknown);
void (executeSkill as unknown);
export type { ExecuteResult as _ExecuteResult };
