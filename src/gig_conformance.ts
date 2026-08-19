// §conformance — the gig-close CLASSIFIER. A pure, deterministic function over (the composed
// standard/chart, the sealed output set) that answers whether a run fits its own construction. No
// model call, no I/O, no store read — it becomes a FACT in the chain rather than an opinion about
// it, and it is unit-testable without ever running a gig.
//
// Two questions, FIT first:
//
//   FIT     — does the sealed set satisfy the construction? Every chair's declared `output_contract`
//             is satisfied by at least one sealed record of that type FROM THAT CHAIR (subtype-aware,
//             via the one owner of the predicate, `outputSatisfiesType`); nothing is sealed under a
//             type the chair never declared. Cardinality is NOT the question — a chair may seal many
//             records of one declared type (a scout gathering fifteen hits is conformant), so FIT
//             asks only "at least one", never a count. A type the genome marks `optional_outputs`
//             that sealed nothing is a conditional output (#243), not a gap.
//
//   TIMING  — does provenance respect the declared edges? Every current-gig sealed record's
//             `input_shas` should resolve to the outputs of the chairs its producer declared
//             `depends_on` (plus the examine-amend feedback edge and the gig input). `input_shas` is
//             ENGINE-stamped, not agent-claimed, so a record descending from something its contract
//             never gave it — a seat that read out of order, or consumed a sibling's work it was not
//             seated to see — falls straight out of the chain.
//
// This is a CLASSIFIER, not a gate (the change-request is explicit): its job is to ROUTE review —
// a clean run buys cheap review, an anomalous one buys expensive review — so the result NAMES what
// did not fit, not merely that something did not. It is attached to `GigResult.conformance` beside
// `run_fingerprint`, never folded INTO the fingerprint and never sealed as a Verdict inside the gig
// it grades (a run containing its own grade is self-referential).
//
// The four cases that must NOT produce false violations, and how each is handled here:
//   1. REUSE   — a chair skipped with `reason:"reuse"` whose output came from a PRIOR gig. FIT
//                counts a reuse SkippedChair's output_types as satisfying the contract, and TIMING
//                skips any record carrying `reused_from` or bearing a foreign gig_id: the source gig
//                validated its own chain at close.
//   2. PARKED  — `status:"awaiting_approval"` short-circuits to INCOMPLETE before any FIT/TIMING
//                runs, so a legitimately-absent human-chair output is never a FIT violation.
//                INCOMPLETE and VIOLATED are different verdicts and must not collapse.
//   3. AMEND   — the examine-amend loop seals several records from one chair (not surplus, because
//                cardinality is not the question) and feeds the failing verdict back into the maker
//                (authorized because the verify chair `depends_on` the maker — a declared edge read
//                in reverse for feedback).
//   4. FAILED  — a run that died mid-phase lacks outputs by definition. Any status that is neither
//                `complete` nor `awaiting_approval` is DESCRIBED as FAILED, not condemned: no FIT or
//                TIMING violation is manufactured from its missing outputs.
import type { Standard, Chair } from "./composition.js";
import type { OutputRecord } from "./outputs.js";
import type { SkippedChair } from "./runtime.js";
import { outputSatisfiesType } from "./runtime.js";

/** A chair promised a type and sealed no record of it (and the genome did not mark it optional). */
export interface FitViolation {
  /** The chair's role — the standard's chair identity. */
  chair_slug: string;
  declared_type: string;
}

/** A record was sealed under a type the producing chair never declared in its output_contract. */
export interface FitSurplus {
  chair_slug: string;
  sealed_type: string;
}

/**
 * A current-gig record's `input_shas` carried a hash belonging to a chair its producer did not
 * declare `depends_on` (nor the reverse feedback edge, nor itself). Names BOTH ends — the sealing
 * chair and the source chair the sha resolves to — because the classifier routes review, and a
 * reviewer needs WHO read WHOSE work out of order.
 */
export interface TimingViolation {
  record_id: string;
  sealing_chair_slug: string;
  unauthorized_sha: string;
  /** The chair whose sealed record carries `unauthorized_sha`. Present whenever the sha resolves to
   *  an in-gig record — which, by construction, it always does when a violation is reported (an
   *  unresolvable sha is a seed or store-miss and is skipped, never flagged). */
  unauthorized_source_chair_slug?: string;
}

/**
 * The classification. A discriminated union on `verdict`:
 *   CLEAN       — the sealed set satisfies FIT and provenance respects the declared edges.
 *   INCOMPLETE  — the gig is parked awaiting a human approval; FIT/TIMING deliberately not run.
 *   FAILED      — the run ended in a status that lacks outputs by definition; described, not graded.
 *   VIOLATED    — one or more FIT and/or TIMING breaches. A run with both kinds is a SINGLE VIOLATED
 *                 with both arrays populated (fit_surplus rides alongside fit_violations).
 */
export type GigConformanceResult =
  | { verdict: "CLEAN" }
  | { verdict: "INCOMPLETE"; awaiting_status: string }
  | { verdict: "FAILED"; description: string }
  | {
      verdict: "VIOLATED";
      fit_violations: FitViolation[];
      fit_surplus: FitSurplus[];
      timing_violations: TimingViolation[];
    };

/**
 * Classify a sealed gig run against its construction. PURE — same inputs, same result; no store,
 * no invoker, no network.
 *
 * @param standard  the composed standard (the chart) this run performed
 * @param produced  the settled sealed output set (produced[] as runGig finalizes it — derived,
 *                  reused-and-re-sealed, resume-restored and every amend round included)
 * @param skipped   the SkippedChair rows (resume + reuse), so a contract satisfied only by a prior
 *                  gig's reused output is not read as missing
 * @param status    the run's terminal status. `"complete"` runs FIT+TIMING; `"awaiting_approval"`
 *                  short-circuits to INCOMPLETE; anything else is FAILED
 * @param gigId     this gig's id — the boundary that tells an in-gig derived record from a seeded or
 *                  reused-by-reference cross-gig record (whose source gig owns its own timing)
 */
export function checkGigConformance(
  standard: Standard,
  produced: readonly OutputRecord[],
  skipped: readonly SkippedChair[],
  status: string,
  gigId: string,
): GigConformanceResult {
  // ── Status routing FIRST — before any FIT/TIMING analysis ──────────────────────────────────
  // A parked gig legitimately lacks its human chair's output; a failed gig lacks outputs by
  // definition. Neither is a nonconformance, and running FIT over either would manufacture one.
  if (status === "awaiting_approval") {
    return { verdict: "INCOMPLETE", awaiting_status: status };
  }
  if (status !== "complete") {
    return { verdict: "FAILED", description: `gig ended in status "${status}" — a run that did not complete lacks outputs by definition; conformance describes that, it does not condemn it` };
  }

  const chairs: Chair[] = standard.phases.flatMap((p) => [...p.chairs]);
  const chairByRole = new Map<string, Chair>(chairs.map((c) => [c.role, c]));

  // Records THIS chair actually sealed, keyed by producing role. Reuse re-seals into this gig and
  // resume restores into it, so both already appear here under their chair's role.
  const recordsByRole = new Map<string, OutputRecord[]>();
  for (const r of produced) {
    if (r.from_role === undefined) continue; // legacy hand-rolled write with no chair attribution
    const list = recordsByRole.get(r.from_role);
    if (list) list.push(r);
    else recordsByRole.set(r.from_role, [r]);
  }

  // Reuse SkippedChairs, keyed by role: a declared type satisfied ONLY by a prior gig's reused
  // output (the "referenced, not re-sealed" shape) is conformant, not missing. Resume rows also
  // appear in produced[] under their role, so this is the reuse-by-reference safety net.
  const reuseTypesByRole = new Map<string, Set<string>>();
  for (const sk of skipped) {
    if (sk.reason !== "reuse") continue;
    const set = reuseTypesByRole.get(sk.role) ?? new Set<string>();
    for (const t of sk.output_types) set.add(t);
    reuseTypesByRole.set(sk.role, set);
  }

  // ── FIT ────────────────────────────────────────────────────────────────────────────────────
  const fit_violations: FitViolation[] = [];
  const fit_surplus: FitSurplus[] = [];

  for (const c of chairs) {
    const optional = new Set<string>(c.optional_outputs ?? []);
    const sealed = recordsByRole.get(c.role) ?? [];
    const reused = reuseTypesByRole.get(c.role);
    for (const declared of c.output_contract) {
      // Cardinality is not the question — "at least one" record of the declared type, subtype-aware.
      const satisfiedByRecord = sealed.some((r) => outputSatisfiesType(r, declared));
      // A reuse SkippedChair names its covered types as plain strings (no record to run the
      // polymorphic predicate over), so an exact-name match is the honest check there.
      const satisfiedByReuse = reused?.has(declared) === true;
      if (satisfiedByRecord || satisfiedByReuse) continue;
      // A genome-declared optional (#243) that sealed nothing is a conditional output, not a gap —
      // that shortfall is `GigResult.unfulfilled_outputs`' concern, a different question from FIT.
      if (optional.has(declared)) continue;
      fit_violations.push({ chair_slug: c.role, declared_type: declared });
    }
  }

  // Surplus: a record sealed under a type its chair never declared. Scanned over records the chair
  // actually sealed (attributable via from_role) — a foreign record with no matching chair is not
  // this standard's to grade.
  for (const c of chairs) {
    const contract = c.output_contract;
    for (const r of recordsByRole.get(c.role) ?? []) {
      const matchesSomeDeclared = contract.some((declared) => outputSatisfiesType(r, declared));
      if (!matchesSomeDeclared) {
        fit_surplus.push({ chair_slug: c.role, sealed_type: r.domain_type });
      }
    }
  }

  // ── TIMING ───────────────────────────────────────────────────────────────────────────────────
  // Reverse-dependency index: for each chair, the chairs that declared depends_on IT. The
  // examine-amend loop feeds a verify chair's verdict back into the maker it judged, and the verify
  // chair `depends_on` the maker — so a maker consuming that verdict is respecting a DECLARED edge,
  // read in reverse for feedback. Authorizing both directions of a declared edge is what keeps the
  // check from crying wolf on every amend round.
  const reverseDeps = new Map<string, Set<string>>();
  for (const c of chairs) {
    for (const dep of c.depends_on) {
      const set = reverseDeps.get(dep) ?? new Set<string>();
      set.add(c.role);
      reverseDeps.set(dep, set);
    }
  }

  // sha → the in-gig chair that sealed a record with that content_sha. Attribution for a flagged
  // sha, and the resolvability test: a sha NOT in this map belongs to a seed / reused-by-reference
  // / store-miss record and is unresolvable here — the check stays silent rather than guess.
  const shaToRole = new Map<string, string>();
  for (const r of produced) {
    if (r.gig_id !== gigId) continue; // only in-gig sealed records attribute a chair here
    if (r.from_role === undefined) continue;
    if (!shaToRole.has(r.content_sha)) shaToRole.set(r.content_sha, r.from_role);
  }

  const timing_violations: TimingViolation[] = [];
  for (const r of produced) {
    // A reused/seeded record's provenance was validated by its SOURCE gig at that gig's close —
    // its shas resolve into that gig, not this one. Skip on either signal: a foreign gig_id, or the
    // reused_from annotation the reuse re-seal stamps.
    if (r.gig_id !== gigId) continue;
    if (r.reused_from) continue;
    if (r.from_role === undefined) continue;
    const producer = chairByRole.get(r.from_role);
    if (!producer) continue; // record from a role not in this standard — not ours to time

    // Authorized producers of this record's inputs: the declared upstream (depends_on), the reverse
    // feedback edge (chairs that depend_on this producer — the examine-amend case), and the producer
    // itself (iterative self-consumption).
    const authorized = new Set<string>([producer.role, ...producer.depends_on]);
    for (const rev of reverseDeps.get(producer.role) ?? []) authorized.add(rev);

    for (const sha of r.input_shas) {
      if (sha === "") continue; // engine stamped "" for an input it could not resolve — a store-miss, not a breach
      const source = shaToRole.get(sha);
      if (source === undefined) continue; // resolves to no in-gig record — a seed / cross-gig input, unresolvable here
      if (authorized.has(source)) continue; // respects a declared edge (forward, reverse, or self)
      timing_violations.push({
        record_id: r.id,
        sealing_chair_slug: r.from_role,
        unauthorized_sha: sha,
        unauthorized_source_chair_slug: source,
      });
    }
  }

  if (fit_violations.length === 0 && fit_surplus.length === 0 && timing_violations.length === 0) {
    return { verdict: "CLEAN" };
  }
  return { verdict: "VIOLATED", fit_violations, fit_surplus, timing_violations };
}
