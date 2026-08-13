// THE BINDING MIDDLE PLACE — committed work as a first-class genome object.
//
// STATUS: RED-SPEC SEAM. Every symbol below is a STUB whose body throws, authored exactly as
// src/institution_enforcement.ts was before its bodies were filled. The signatures, the closed
// state set, the party vocabulary and the Result codomains are the FIXED SEAM the red spec pins;
// the GREEN change fills the bodies WITHOUT touching them. The suite therefore COMPILES (tsc is
// clean), so every red assertion fails because the ENFORCEMENT is absent (a throw / an unbuilt
// schema), never because a file fails to typecheck.
//
// The sealed lineage-record `lineage-record-committed-future-work-eb1f7b05` located the omission:
// Coltrane implements the INTENTION (NorthstarSchema) and the SETTLED ACTUAL (GigLedgerEntry) and
// the ACCEPTANCE primitive (InstitutionalLawCheckSchema), and omits the BINDING MIDDLE PLACE — the
// commitment that carries amount + accountable party + period + acceptance. In GASB terms we hold
// the appropriation ceiling (ChartBudgetEnvelope) and the expenditure (GigLedgerEntry) and omit the
// encumbrance. A Booking IS that encumbrance leg; this file is the shape it will take.
//
// REUSE, NOT INVENTION. `acceptance` is exactly `LawCheck` ({predicate, inputs}) and is decided by
// the SAME `evaluate()` from institution_enforcement — no second predicate form is minted. Tour
// admissibility returns the SAME `AdmissibilityResult` shape as checkInstitutionAdmissibility — the
// third application of that one bar. The variance reads the SAME ledger chain (GigUsage.total_cost_usd)
// the rest of the engine settles against.

import { z } from "zod";
import type { AdmissibilityResult, LawCheck } from "./institution_enforcement.js";
import type { GigLedgerEntry } from "./ledger.js";

// ── The committed-work objects (TS shape; the strict Zod schemas below are the runtime gate) ─────

/** One draw against declared capacity. A draw is UNIT-TAGGED — a booking draws a VECTOR of these,
 *  never a scalar, and over-commitment is checked per unit with NO exchange rate anywhere. */
export interface Draw {
  resource_slug: string;
  unit: string;
  quantity: number;
}

/** Capacity as its OWN class, separate from commitment. A holding of some `unit` by a `holder`
 *  (an organization slug), for a `period`, that either may or may not be lent across organizations.
 *  `unit` is a free string treated as OPAQUE and NON-CONVERTIBLE — the precedent is BudgetState.unit
 *  ("append-units", "NOT dollars, and nothing converts between the two"). */
export interface Resource {
  slug: string;
  holder: string;
  quantity: number;
  unit: string;
  period: string;
  transferable: boolean;
}

/** One commitment within a Tour: the binding middle place, carrying the four load-bearing fields the
 *  lineage-record named plus its acceptance condition, its draws and its lifecycle. `amount` is
 *  OPTIONAL — Coltrane's own tour genuinely has commitments with no price ("ship the evaluator" is a
 *  real commitment with a real acceptance condition and no money numerator). */
export interface Booking {
  slug: string;
  aim: string;
  amount?: number;
  period: string;
  /** The accountable OFFICE: an InstitutionalChair id (the office, not its incumbent). This is the
   *  DEBTOR of the commitment. */
  accountable_office: string;
  /** Reuses InstitutionalLawCheckSchema verbatim — decided by the same evaluate(). */
  acceptance: LawCheck;
  /** The vector of draws over declared resources. */
  draws: Draw[];
  /** The north stars this commitment serves (may be empty — that is a queryable fact, not an error). */
  served_northstars: string[];
  /** Whether the acceptance is a checkable rule or a stated norm. Reuses NormPairSchema's vocabulary
   *  — never a parallel tier enum. An UNMARKED, UNEVALUABLE commitment is refused. */
  tier?: "declared" | "enforced";
  /** The live lifecycle record — a party-constrained state machine, not a status field. */
  lifecycle: CommitmentRecord;
  /** In-repo join to the gigs that settled against this booking. NEVER an off-repo id. */
  settled_gig_ids?: string[];
  /** For a STAGED booking: the antecedent that must hold before it binds. Reuses LawCheck so there is
   *  ONE predicate form. Detach fires automatically when this holds (conditional → active). */
  antecedent?: LawCheck;
}

/** The institution-visible aggregation. It REFERENCES an institution (the constraint whose laws
 *  govern it) and an organization (the accountable player) — it does NOT live inside InstitutionSchema,
 *  because institution, organization and committed work are three distinct things. All cross-refs are
 *  slugs, so the class depends on no other object at the type level. */
export interface Tour {
  slug: string;
  institution_slug: string;
  org_slug: string;
  /** The accountable office, an InstitutionalChair id — the VenueSchema.responsible_chair shape. */
  responsible_chair: string;
  period: string;
  northstar_slugs: string[];
  bookings: Booking[];
}

// ── The party-constrained lifecycle — a real state machine, NOT a status enum ────────────────────
//
// The Singh/Yolum/Telang social-commitment algebra: a commitment C(debtor, creditor, antecedent,
// consequent). The PARTY CONSTRAINTS are the load-bearing part — cancel is DEBTOR-only, release is
// CREDITOR-only, and the two are DIFFERENT acts by DIFFERENT parties that must never collapse into
// one value.

/** The two parties to a commitment. The debtor owes the consequent; the creditor holds the claim. */
export type CommitmentParty = "debtor" | "creditor";

/** The closed lifecycle state set. `cancelled` (debtor's act) and `released` (creditor's act) are
 *  DISTINCT members — the whole point of a state machine over a status field. */
export type CommitmentState =
  | "conditional"
  | "active"
  | "pending"
  | "satisfied"
  | "violated"
  | "expired"
  | "cancelled"
  | "released";

/** The closed state set as data — for codomain-closure and distinctness assertions. */
export const COMMITMENT_STATES: readonly CommitmentState[] = [
  "conditional",
  "active",
  "pending",
  "satisfied",
  "violated",
  "expired",
  "cancelled",
  "released",
];

/** The states in which a commitment is still LIVE — delegate and assign must keep the commitment in
 *  this set, and an undispatched booking is one whose state is still live with no settled gig. */
export const LIVE_STATES: ReadonlySet<CommitmentState> = new Set<CommitmentState>([
  "conditional",
  "active",
  "pending",
]);

export type CommitmentOpKind =
  | "create"
  | "detach"
  | "discharge"
  | "cancel"
  | "release"
  | "delegate"
  | "assign";

/** An operation on a commitment: what act, by which party, and (for delegate/assign) the substitute. */
export interface CommitmentOp {
  kind: CommitmentOpKind;
  /** Who is performing the act. `detach` is AUTOMATIC and carries no party actor. */
  by?: CommitmentParty;
  /** delegate substitutes the debtor; assign substitutes the creditor. */
  substitute?: string;
}

/** One recorded operation — an append-only log entry, so Delegate's residual responsibility is
 *  RECORDED rather than overwritten by an in-place edit. */
export interface CommitmentOpEntry {
  op: CommitmentOpKind;
  by?: CommitmentParty;
  /** For a delegate: the debtor that was substituted OUT and retains residual responsibility. */
  residual_debtor?: string;
}

/** The live commitment record: its current state, its two parties, and its operation log. */
export interface CommitmentRecord {
  state: CommitmentState;
  /** The accountable office that owes the work. */
  debtor: string;
  /** The party the promise is made to (the institution/organization). */
  creditor: string;
  log: CommitmentOpEntry[];
}

/** A transition either succeeds with the next record, or is REFUSED with a stated reason (a party
 *  performing an act reserved to the other party; an operation illegal in the current state). A
 *  refusal is a decision, never a throw — a throw here is the unbuilt seam, distinguishable in test. */
export type CommitmentTransition =
  | { ok: true; next: CommitmentRecord }
  | { ok: false; reason: string };

/**
 * Apply one lifecycle operation under its party constraint. THE FIXED SEAM:
 *  - cancel  → DEBTOR ONLY; a creditor's cancel is refused.
 *  - release → CREDITOR ONLY; a debtor's release is refused.
 *  - delegate→ substitutes the debtor, keeps the commitment LIVE, appends the residual debtor.
 *  - assign  → substitutes the creditor, keeps the commitment LIVE.
 *  - detach  → AUTOMATIC (no party); conditional → active once the antecedent holds.
 *  - discharge → the debtor delivers the consequent; active → satisfied.
 * STUB: throws until implemented.
 */
export function applyCommitmentOp(_rec: CommitmentRecord, _op: CommitmentOp): CommitmentTransition {
  throw new Error(
    "applyCommitmentOp: the party-constrained commitment lifecycle is an unbuilt seam — " +
      "cancel(debtor-only), release(creditor-only), delegate/assign(stay-live), detach(automatic)",
  );
}

// ── Capacity / draws — per-unit over-commitment with NO conversion, ever ──────────────────────────

/** A per-unit tally of a set of draws — the vector the over-commitment check sums over. STUB. */
export function tallyDrawsPerUnit(_draws: readonly Draw[]): Map<string, number> {
  throw new Error("tallyDrawsPerUnit: per-unit draw accounting is an unbuilt seam");
}

/**
 * Check every booking's draws in a tour against the declared resources, PER UNIT, with no exchange
 * rate anywhere. Returns the SAME AdmissibilityResult shape. Refusals:
 *  - a draw naming an undeclared resource → DEAD_NAME;
 *  - a draw in a unit the holder does not hold → dead unit (no conversion to a held unit);
 *  - the sum of draws in a unit exceeding the holder's declared quantity → over-committed;
 *  - a draw on a NON-TRANSFERABLE holding held by an org other than the tour's accountable org.
 * STUB: throws until implemented.
 */
export function checkTourCapacity(_tour: Tour, _resources: readonly Resource[]): AdmissibilityResult {
  throw new Error("checkTourCapacity: per-unit, no-conversion over-commitment is an unbuilt seam");
}

// ── Admissibility — the same bar a third time ─────────────────────────────────────────────────────

/** The document tour-admissibility consumes: the tour, the resources its draws name, and the genome
 *  slugs it resolves against (institution / chairs / northstars). */
export interface TourDocument {
  tour: unknown;
  resources?: readonly unknown[];
  institution?: unknown;
  chairs?: readonly unknown[];
  northstars?: readonly unknown[];
}

/**
 * Refuse a tour document that claims more than it holds — the same shape as
 * checkInstitutionAdmissibility, pure and explicitly-invoked, NOT wired into loadGenome. Collect-all,
 * refuse-once. Refusals:
 *  - a booking whose acceptance does not evaluate over its declared inputs AND is not marked
 *    declared-tier (an unmarked, unevaluable commitment — silence must not pass for a commitment);
 *  - a draw against a resource the genome does not declare (a dead name, failing closed);
 *  - a cross-org draw on a non-transferable holding;
 *  - a per-unit over-commitment;
 *  - any institution / chair / northstar / resource slug the genome cannot resolve.
 * STUB: throws until implemented.
 */
export function checkTourAdmissibility(_doc: TourDocument): AdmissibilityResult {
  throw new Error(
    "checkTourAdmissibility: the third application of the admissibility bar is an unbuilt seam",
  );
}

// ── Variance — the missing NUMERATOR, read FROM the chain ─────────────────────────────────────────

/** Promised-versus-delivered for one booking. `committed` is the booking's amount (null when the
 *  booking carries none — that is "no numerator", NOT a second tier). `settled` is read FROM the
 *  ledger chain (sum of GigUsage.total_cost_usd over the booking's settled gigs). */
export interface Variance {
  booking_slug: string;
  committed: number | null;
  settled: number;
  /** committed - settled, or null when the booking carries no amount. */
  variance: number | null;
  has_numerator: boolean;
  settled_gig_ids: readonly string[];
}

/**
 * Compute a booking's variance by READING the booking → gig → settlement chain (never assembling it
 * by hand): for each gig id the booking settled against, read its ledger entry's usage.total_cost_usd
 * and sum. STUB: throws until implemented.
 */
export function computeVariance(_booking: Booking, _ledger: readonly GigLedgerEntry[]): Variance {
  throw new Error("computeVariance: the booking→gig→settlement variance reader is an unbuilt seam");
}

// ── The two visibilities, and the two reports — set differences over data the objects already carry ─

/** Unpromised work: gig ids that no booking settled against. Allowed, but VISIBLE. STUB. */
export function unpromisedGigs(
  _allGigIds: readonly string[],
  _bookings: readonly Booking[],
): string[] {
  throw new Error("unpromisedGigs: the unpromised-work visibility query is an unbuilt seam");
}

/** Undispatched bookings: still-live commitments that settled against no gig. VISIBLE, not dropped. STUB. */
export function undispatchedBookings(_bookings: readonly Booking[]): Booking[] {
  throw new Error("undispatchedBookings: the unfulfilled-commitment query is an unbuilt seam");
}

/** Report A: north stars a tour names but no booking serves — directions nobody is funding. STUB. */
export function northstarsWithNoBooking(_tour: Tour): string[] {
  throw new Error("northstarsWithNoBooking: report A (unfunded directions) is an unbuilt seam");
}

/** Report B: bookings serving no north star — spend with no stated direction. STUB. */
export function bookingsServingNoNorthstar(_tour: Tour): Booking[] {
  throw new Error("bookingsServingNoNorthstar: report B (undirected spend) is an unbuilt seam");
}

// ── The strict Zod schemas — the runtime gate (the GREEN change promotes these into the single Zod
//    source in src/genome_schema.ts and re-exports them here). Authored as UNBUILT stubs: `.parse`
//    of even a valid fixture throws, so the shape invariants are RED because the object does not
//    exist yet — not because of a type error. ─────────────────────────────────────────────────────

function unbuiltSchema<T>(name: string): z.ZodType<T> {
  const detonate = (): never => {
    throw new Error(
      `${name} is an unbuilt seam — the binding middle place object is not implemented yet`,
    );
  };
  return {
    parse: detonate,
    safeParse: detonate,
  } as unknown as z.ZodType<T>;
}

export const DrawSchema = unbuiltSchema<Draw>("DrawSchema");
export const ResourceSchema = unbuiltSchema<Resource>("ResourceSchema");
export const BookingSchema = unbuiltSchema<Booking>("BookingSchema");
export const TourSchema = unbuiltSchema<Tour>("TourSchema");
