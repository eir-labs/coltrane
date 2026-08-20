// Grounding arrives as an INPUT — and judgment cannot be replaced by lookup.
//
// Two decoupled obligations, held apart on purpose (#424):
//   (1) GROUNDING-AS-INPUT — a change-context is a first-class record any of four interchangeable
//       producers (reader / compiler / prior standard / human) may seal, and the consuming
//       standard keys on the TYPE, never on who produced it. `assembleChangeContext` is the
//       compiler-plus-enricher producer: mechanical fields lifted from a compiled index, judgment
//       supplied by a reader. `consumerAcceptsGrounding` is the producer-agnostic acceptance —
//       it does not read `produced_by`. `freshnessGate` refuses a change-context whose index
//       revision has drifted from current source (a stale index seeding a change is worse than a
//       slow reader — fail closed).
//   (2) DO-NOT-COMPILE-AWAY-THE-CLAIMS — the mechanical fields may be compiled, but a change-context
//       is UNSATISFIABLE by a record whose claims are empty or merely restate the index. A reading
//       is a claim that points at a specific line and asserts something the index cannot hold;
//       `admitChangeContext` admits only a record that carries at least one. `snapshotMechanical`
//       is the golden-master surface: it strips the judgment fields, because judgment has no fixed
//       oracle — only the mechanical fields can be pinned.
//
// Everything here is pure: no I/O, no clock, no registry. The functions operate on plain records
// so the seam can be verified in isolation (consumer against a seeded change-context; each
// producer/guard against the shared type) without running a live agent.

import type { RepositoryIndex } from "./repo_index.js";

/** The judgment half a reader supplies — the noticing the compiler deliberately does not do. */
export type Judgment = {
  claims: unknown[];
  unknowns: string[];
  frame: string;
  confidence?: number;
};

/** A guard/acceptance result. `reason` is present only on refusal (exactOptionalPropertyTypes). */
export type GroundingResult = { ok: boolean; reason?: string };

/** A change-context claim, as carried in the `claims` array. */
type Claim = { claim?: unknown; locator?: unknown };

/**
 * A locator is LOAD-BEARING when it names a specific line (file:line) — evidence the mechanical
 * index cannot itself hold. A file-only locator merely points at a file the index already lists,
 * so it is derivable and does not, on its own, make a claim a reading. This is exactly the
 * distinction the two spec fixtures exercise (`src/runtime.ts` vs `src/runtime.ts:2072`).
 */
function isLoadBearing(claim: unknown): boolean {
  const locator = (claim as Claim | null)?.locator;
  return typeof locator === "string" && /:\d+/.test(locator);
}

/**
 * Assemble a change-context from a compiled index (mechanical fields) plus a reader's judgment
 * (the claims/unknowns/frame the compiler cannot produce). The result satisfies the shared
 * change-context type: every required field is populated and no undeclared field is added.
 */
export function assembleChangeContext(index: RepositoryIndex, judgment: Judgment): Record<string, unknown> {
  const relevant_files = index.boundary.map((path) => ({
    path,
    why: "within the compiled boundary of the reading",
    locator: path,
  }));
  const existing_tests = [...new Set(index.module_tests.map((m) => m.test))].sort();
  const entry_points = index.entry_points.map((e) => `${e.module}#${e.symbol}`);

  return {
    id: `change-context@${index.source_revision}`,
    input_refs: [`repo-index/${index.source_revision}`],
    // Judgment half — supplied by the reader, opaque to the compiler.
    frame: judgment.frame,
    claims: judgment.claims,
    unknowns: judgment.unknowns,
    ...(judgment.confidence !== undefined ? { confidence: judgment.confidence } : {}),
    // Mechanical half — lifted verbatim from the compiled index.
    boundary: index.boundary,
    entry_points,
    relevant_files,
    existing_tests,
    conventions_observed: index.conventions_observed,
    index_revision: index.source_revision,
  };
}

/**
 * Admit a change-context only when it carries a READING — at least one load-bearing claim (a
 * locator with a line, asserting something the index cannot hold). Empty claims, or claims that
 * merely restate the mechanical index (file-only locators), are refused: a judgment-free grounding
 * does not pass, and a load-bearing claim is not laundered by derivable ones alongside it.
 */
export function admitChangeContext(rec: Record<string, unknown>, index: RepositoryIndex): GroundingResult {
  void index; // the predicate keys on locator format alone (#424 tradeoff), not on index contents
  const claims = rec["claims"];
  if (!Array.isArray(claims) || claims.length === 0) {
    return { ok: false, reason: "a change-context with no claims is a judgment-free grounding" };
  }
  if (!claims.some(isLoadBearing)) {
    return {
      ok: false,
      reason: "every claim is derivable from the mechanical index — a lookup masquerading as a reading",
    };
  }
  return { ok: true };
}

/**
 * Refuse a change-context whose index revision has drifted from current source. Fail closed: a
 * missing or mismatched revision does not pass — a stale index seeding a change is worse than a
 * slow reader.
 */
export function freshnessGate(rec: Record<string, unknown>, currentRevision: string): GroundingResult {
  const rev = rec["index_revision"];
  if (typeof rev !== "string" || rev.length === 0) {
    return { ok: false, reason: "change-context carries no index_revision — cannot prove freshness" };
  }
  if (rev !== currentRevision) {
    return { ok: false, reason: `stale index: change-context built at ${rev}, current source is ${currentRevision}` };
  }
  return { ok: true };
}

/**
 * The golden-master surface: the MECHANICAL fields only. Judgment has no fixed oracle, so a
 * snapshot must never pin `claims` / `unknowns` / `frame` to a "correct" value. Stripping them
 * leaves exactly the fields a deterministic diff may hold to.
 */
export function snapshotMechanical(rec: Record<string, unknown>): Record<string, unknown> {
  const { claims, unknowns, frame, ...mechanical } = rec;
  void claims;
  void unknowns;
  void frame;
  return mechanical;
}

/**
 * The producer-agnostic acceptance. The consumer keys on the change-context TYPE — the presence of
 * a reading (claims) and its mechanical companions — and NEVER on who produced it. `produced_by`
 * is not read here, so the same record labelled by any producer is accepted identically.
 */
export function consumerAcceptsGrounding(rec: Record<string, unknown>): GroundingResult {
  const claims = rec["claims"];
  if (!Array.isArray(claims) || claims.length === 0) {
    return { ok: false, reason: "not a change-context: no claims" };
  }
  if (!Array.isArray(rec["relevant_files"])) {
    return { ok: false, reason: "not a change-context: no relevant_files" };
  }
  if (!Array.isArray(rec["unknowns"])) {
    return { ok: false, reason: "not a change-context: unknowns must be named, even if empty" };
  }
  return { ok: true };
}
