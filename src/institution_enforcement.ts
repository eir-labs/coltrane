// Institutional-law ENFORCEMENT — the seam that makes Coltrane's own laws machine-checkable
// at the moment of action, rather than prose that sounds binding.
//
// Coltrane's public position is that an institutional law is decidable when an action is
// attempted. Today institutions/coltrane.json ships three ADICO laws whose `check.predicate`
// is a real s-expression that NOTHING evaluates, and composeStandard verifies chair caps at
// dispatch while verifying no chair obligation at all. This module is the repair: a
// zero-dependency in-house s-expression evaluator with a fixed verdict codomain, and an
// admissibility check that refuses an institution document claiming more enforcement than it
// has.
//
// STUB STATUS (RED-first). The signatures below and the `Verdict` codomain are the fixed seam,
// authored now so the red-spec suite COMPILES (`tsc --noEmit` is clean). The bodies are
// deliberately NOT implemented and throw. The three suites —
//   tests/institution_law_evaluator.test.ts
//   tests/institution_admissibility.test.ts
//   tests/institution_additive_invariance.test.ts
// are RED because the enforcement here does not exist yet; that absence is the point, not a
// failure. The GREEN change fills these bodies and adds the additive obligation-tier field to
// NormPairSchema; it MUST NOT change this signature or codomain. See
// docs/specs/coltrane-enforces-its-laws.md.

/**
 * The closed verdict algebra — a strict superset of refuse/permit, grounded in XACML 3.0's
 * four-valued decision model:
 *  - PERMIT          the action is allowed (an allow atom, or a satisfied obligation).
 *  - DENY            the action is refused (a deny atom, or a breached obligation — the or_else fires).
 *  - NOT_APPLICABLE  the law does not govern this action (the guard of `(=> P Q)` is false).
 *  - UNDECIDED       well-formed, but the fact-only evaluator cannot reduce it (e.g. an operator
 *                    that needs a genome/collection/timestamp context not supplied). Never coerced
 *                    to PERMIT or DENY.
 *  - DEAD_NAME       a name declared in `check.inputs` is absent from the fact record. Fails closed,
 *                    the exact analogue of an unresolvable tool grant (runtime.ts's
 *                    resolveAgentGrants().unknown). Never PERMIT, never a DENY dressed as a decision.
 *
 * PERMIT/DENY/UNDECIDED is a deliberate strict subset of the edit-automata TERMINATE/SUPPRESS/INSERT
 * taxonomy (Ligatti, Bauer & Walker 2005): SUPPRESS and INSERT are a named future gap, extendable
 * behind this same interface.
 */
export type Verdict = "PERMIT" | "DENY" | "NOT_APPLICABLE" | "UNDECIDED" | "DEAD_NAME";

/** The five closed verdict values as data — for codomain-closure and exhaustiveness assertions. */
export const VERDICTS: readonly Verdict[] = [
  "PERMIT",
  "DENY",
  "NOT_APPLICABLE",
  "UNDECIDED",
  "DEAD_NAME",
];

/** The InstitutionalLawCheckSchema shape the evaluator consumes: a predicate + its typed inputs. */
export interface LawCheck {
  predicate: string;
  inputs: Record<string, string>;
}

/** A supplied fact record: each declared input name → its supplied value. */
export type FactRecord = Record<string, unknown>;

/**
 * Evaluate a law's `check` against a supplied fact record and return exactly one Verdict.
 *
 * The interface is the fixed seam: an SMT/solver backend (SMT-LIB2 is itself s-expression
 * many-sorted first-order logic) is reachable later behind this identical signature without
 * changing any caller — solve-vs-evaluate stays inside the box, provided the in-house evaluator
 * keeps "cannot decide" explicit (UNDECIDED) rather than defaulting.
 *
 * NOT IMPLEMENTED — throws. The red-spec fixes what it must do once it exists.
 */
export function evaluate(check: LawCheck, facts: FactRecord): Verdict {
  void check;
  void facts;
  throw new Error(
    "institution law evaluator not implemented — see docs/specs/coltrane-enforces-its-laws.md",
  );
}

/** One reason a document is inadmissible: which law or obligation, and why. */
export interface AdmissibilityOffender {
  kind: "law" | "obligation";
  /** A locator for the offending element (law aim / chair role + obligation aim). */
  ref: string;
  reason: string;
}

/** Collect-all / refuse-once: admitted, or the FULL list of offenders in a single result. */
export interface AdmissibilityResult {
  admitted: boolean;
  offenders: AdmissibilityOffender[];
}

/** The institution document admissibility consumes: the institution section plus its chairs. */
export interface InstitutionDocument {
  institution: unknown;
  chairs?: readonly unknown[];
}

/**
 * Refuse an institution document that claims more enforcement than it has. Per law: the predicate
 * parses; every free variable is declared in `check.inputs` and every declared input is referenced;
 * every operator is implemented; `or_else` is non-empty. Per chair obligation: it is verified OR
 * explicitly marked declared-tier — an unmarked unverified obligation is refused, so silence cannot
 * pass a norm off as a rule. Collects every offender and refuses once (collect-all / refuse-once,
 * mirroring runtime.ts's PreflightDispatchError sweep).
 *
 * This is an explicitly-invoked pure function; it is deliberately NOT wired into loadGenome, so
 * quartet.json (unmarked obligations, non-fact-decidable operators) still loads unchanged.
 *
 * NOT IMPLEMENTED — throws.
 */
export function checkInstitutionAdmissibility(doc: InstitutionDocument): AdmissibilityResult {
  void doc;
  throw new Error(
    "institution admissibility check not implemented — see docs/specs/coltrane-enforces-its-laws.md",
  );
}
