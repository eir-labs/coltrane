import { createHash } from "node:crypto";

export const CANONICAL_FORM_VERSION = "1.1";

const EXCLUDED_FIELDS = new Set(["content_hash", "materialized_at", "last_seen"]);

export function canonJson(value: unknown): string {
  return JSON.stringify(stripAndSortKeys(value));
}

/**
 * Canonical form for a STRUCTURAL hash: `canonJson`, plus every object key whose value states
 * NOTHING is dropped before hashing — `undefined`, `null`, `[]`, `{}`.
 *
 * WHY THIS EXISTS. 0.6.6 added `optional_outputs` and `preferred_skills` to `ChairSchema` with
 * `.default([])`. No standard's structure changed — same phases, same chairs, same type flow — but
 * every standard loaded through the schema now carried two materialized empty arrays, those arrays
 * entered `canonJson`, and `genomeHash` MOVED for the whole genome. The reproducibility key shifted
 * under runs that were byte-identical pipelines, and resume was refused for a drift that did not
 * exist. A structural hash must be insensitive to a default that says nothing, or every future
 * `.default([])` repeats it.
 *
 * WHAT IS NOT DROPPED, deliberately:
 *   - `0`, `""`, `false` are VALUES, not absences. Dropping them would blind the hash to a real
 *     difference — the inverse failure of the one this closes.
 *   - array MEMBERS. An array is ordered structure; removing a null member would re-index its
 *     neighbours and change what the remaining members mean. Members are canonicalized in place;
 *     only object KEYS are dropped.
 *
 * Use this for identity over a SHAPE (the phase graph, the movement DAG). Keep `canonJson` for
 * content — an output's `data` may legitimately carry an empty array as a fact about the world.
 */
export function canonStructuralJson(value: unknown): string {
  return JSON.stringify(stripStructural(value));
}

function isEmptyValue(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as Record<string, unknown>).length === 0;
  return false;
}

function stripStructural(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripStructural);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      if (EXCLUDED_FIELDS.has(k)) continue;
      const inner = stripStructural((value as Record<string, unknown>)[k]);
      // Emptiness is judged AFTER the recursion, so `{a: {b: []}}` collapses the whole way down
      // rather than leaving a husk that still shifts the bytes.
      if (isEmptyValue(inner)) continue;
      sorted[k] = inner;
    }
    return sorted;
  }
  return value;
}

export function canonText(value: string): string {
  const lf = value.replace(/\r\n/g, "\n");
  return lf.replace(/\n+$/, "") + "\n";
}

function stripAndSortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripAndSortKeys);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      if (EXCLUDED_FIELDS.has(k)) continue;
      sorted[k] = stripAndSortKeys((value as Record<string, unknown>)[k]);
    }
    return sorted;
  }
  return value;
}

export function sha256Hex(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function fileHashJson(value: unknown): string {
  return sha256Hex(canonJson(value));
}

export function fileHashText(text: string): string {
  return sha256Hex(canonText(text));
}

export interface FileEntry {
  relpath: string;
  hash: string;
}

export function definitionHash(files: readonly FileEntry[]): string {
  const sorted = [...files].sort((a, b) => (a.relpath < b.relpath ? -1 : a.relpath > b.relpath ? 1 : 0));
  const manifest = JSON.stringify(sorted.map((f) => [f.relpath, f.hash]));
  return sha256Hex(manifest);
}

/**
 * Content-address an output for the run_fingerprint. Folds the *semantic* fields
 * (type identity + producing agent/phase + data) and deliberately EXCLUDES
 * run-instance noise — `id`, `gig_id`, `created_at`, `input_refs` are all fresh
 * UUIDs/timestamps per run. Hashing those made two byte-identical runs produce
 * different fingerprints, so an honest replay never matched and was
 * indistinguishable from a tamper. With this, identical content → identical hash
 * (replay reproduces), different content → different hash (tamper is caught).
 */
export function outputContentHash(rec: {
  core_type: string;
  domain_type: string;
  domain_type_version: number;
  domain: string;
  primitive: string;
  phase?: string | undefined;
  agent_slug: string;
  data: unknown;
}): string {
  return sha256Hex(
    canonJson({
      core_type: rec.core_type,
      domain_type: rec.domain_type,
      domain_type_version: rec.domain_type_version,
      domain: rec.domain,
      primitive: rec.primitive,
      phase: rec.phase,
      agent_slug: rec.agent_slug,
      data: rec.data,
    }),
  );
}

export interface RunFingerprintInput {
  genome_hash: string;
  model_version: string;
  canonical_form_version: string;
  eval_scores: Readonly<Record<string, number>>;
  output_hashes: readonly string[];
  /**
   * #246 — eval slugs that resolved to NO eval definition. An unresolvable slug scores 0.0 for
   * back-compat, which is byte-identical to an eval that ran and genuinely failed; without this
   * term a typo would bake into the reproducibility key as though a real contract had been
   * evaluated and found wanting. Contributes a line ONLY when non-empty, so every fingerprint
   * over a fully-resolved run stays byte-identical to what it was before this field existed.
   */
  unresolved_evals?: readonly string[];
}

export function runFingerprint(input: RunFingerprintInput): string {
  const scoreLines = Object.keys(input.eval_scores)
    .sort()
    .map((k) => `${k}:${input.eval_scores[k]}`);
  const outputLines = [...input.output_hashes].sort();
  const lines = [
    `genome_hash:${input.genome_hash}`,
    `model_version:${input.model_version}`,
    `canonical_form_version:${input.canonical_form_version}`,
    `eval_scores:${scoreLines.join(",")}`,
    `output_hashes:${outputLines.join(",")}`,
  ];
  if (input.unresolved_evals?.length) {
    lines.push(`unresolved_evals:${[...input.unresolved_evals].sort().join(",")}`);
  }
  return sha256Hex(lines.join("\n") + "\n");
}

export type DependencyClass = "type" | "agent" | "standard" | "skill" | "eval";

export interface DirectDependency {
  class: DependencyClass;
  slug: string;
  effective_hash: string;
}

export const EMPTY_DEPENDENCY_HASH =
  "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";

export function dependencyHash(deps: readonly DirectDependency[]): string {
  const sorted = [...deps]
    .map((d) => [d.class, d.slug, d.effective_hash] as const)
    .sort((a, b) => {
      if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
      if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
      return 0;
    });
  return sha256Hex(JSON.stringify(sorted));
}

export function effectiveHash(content_hash: string, dependency_hash: string): string {
  return sha256Hex(`${CANONICAL_FORM_VERSION}|${content_hash}|${dependency_hash}`);
}
