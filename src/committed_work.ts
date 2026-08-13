// THE BINDING MIDDLE PLACE — committed work as a first-class genome object.
//
// STATUS: IMPLEMENTED. The bodies are filled and the suite is green; `checkTourAdmissibility` is
// invoked on the load path rather than left a pure function. This header previously read
// "RED-SPEC SEAM. Every symbol below is a STUB whose body throws" and stayed that way through the
// GREEN change — a status line describing a state the file had left, which is the same defect this
// layer exists to refuse one level down. Corrected rather than deleted, because how it happened is
// worth keeping: the seam was authored first, deliberately, so the suite would COMPILE and every
// red assertion would fail on ABSENT ENFORCEMENT (a throw) rather than on a type error. That
// technique was right and is why the signatures, the closed state set, the party vocabulary and the
// Result codomains survived the implementation untouched.
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

import type { AdmissibilityResult, AdmissibilityOffender, LawCheck } from "./institution_enforcement.js";
import { lawCheckIsEvaluable } from "./institution_enforcement.js";
import type { GigLedgerEntry } from "./ledger.js";
import { DrawSchema, ResourceSchema, BookingSchema, TourSchema } from "./genome_schema.js";

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
 *  ("append-units", "NOT dollars, and nothing converts between the two").
 *
 *  `period` IS THE DISCRETIZATION, and that is the load-bearing reason it is REQUIRED rather than
 *  optional. A Resource is not a running balance; it is *this much, over this window*. Capacity is
 *  derived once at declaration and stored as a commitment for that window — so a capacity that is
 *  continuous underneath (a decaying rate, a regenerating credit) is sampled at declaration and the
 *  decay governs the NEXT period's declaration, never a live read inside this one. That is what
 *  makes this a budget, and it is consistent with a layer whose whole subject is committed work:
 *  a commitment is a stored fact even when computed from something continuous.
 *
 *  Two things break the moment `period` becomes optional, so do not make it so for the convenience
 *  of a one-off holding (give that a window and be done):
 *    1. a periodless Resource is a RUNNING BALANCE, and `quantity` stops meaning a declared
 *       commitment and starts meaning a live level;
 *    2. a live level is an ORACLE. `can_cover(X)` asked repeatedly binary-searches the exact
 *       balance, which is precisely what a banded, quantized projection exists to prevent. Your own
 *       holdings you know exactly and no oracle exists; the leak appears only across an institution
 *       wall — and that is why the band belongs on the exchange contract that crosses the wall,
 *       never on this shape, which is quantity-typed to its holder by design. */
export interface Resource {
  slug: string;
  holder: string;
  quantity: number;
  unit: string;
  /** REQUIRED. See the note above: this field is the discretization, not a label. */
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
export function applyCommitmentOp(rec: CommitmentRecord, op: CommitmentOp): CommitmentTransition {
  const refuse = (reason: string): CommitmentTransition => ({ ok: false, reason });
  const withLog = (patch: Partial<CommitmentRecord>, entry: CommitmentOpEntry): CommitmentTransition => ({
    ok: true,
    next: { ...rec, ...patch, log: [...rec.log, entry] },
  });
  // A substitution keeps the commitment LIVE: if it is already in a live state it stays there,
  // otherwise it is brought back to `active` (the substitute now owes/holds a live commitment).
  const stayLive = (): CommitmentState => (LIVE_STATES.has(rec.state) ? rec.state : "active");

  switch (op.kind) {
    case "cancel":
      // DEBTOR-only. A creditor's cancel is refused in every state.
      if (op.by !== "debtor") return refuse("cancel is the debtor's act; a creditor may not cancel");
      return withLog({ state: "cancelled" }, { op: "cancel", by: op.by });

    case "release":
      // CREDITOR-only. A debtor's release is refused in every state.
      if (op.by !== "creditor") return refuse("release is the creditor's act; a debtor may not release");
      return withLog({ state: "released" }, { op: "release", by: op.by });

    case "delegate": {
      // The debtor substitutes a new debtor and stays live; the ORIGINAL debtor is APPENDED as the
      // residual (recorded, never overwritten).
      if (op.by !== "debtor") return refuse("delegate substitutes the debtor and is the debtor's act");
      if (!op.substitute) return refuse("delegate needs a substitute debtor");
      return withLog(
        { debtor: op.substitute, state: stayLive() },
        { op: "delegate", by: op.by, residual_debtor: rec.debtor },
      );
    }

    case "assign": {
      // The creditor substitutes a new creditor and stays live.
      if (op.by !== "creditor") return refuse("assign substitutes the creditor and is the creditor's act");
      if (!op.substitute) return refuse("assign needs a substitute creditor");
      return withLog({ creditor: op.substitute, state: stayLive() }, { op: "assign", by: op.by });
    }

    case "detach":
      // AUTOMATIC — no party performs it. Given the antecedent holds, conditional → active.
      if (op.by !== undefined) return refuse("detach is automatic; no party may perform it");
      if (rec.state !== "conditional") {
        return refuse(`detach applies only to a conditional commitment, not ${rec.state}`);
      }
      return withLog({ state: "active" }, { op: "detach" });

    case "discharge":
      // The debtor delivers the consequent: active → satisfied.
      if (op.by !== "debtor") return refuse("discharge is the debtor delivering the consequent");
      if (rec.state !== "active") return refuse(`discharge applies to an active commitment, not ${rec.state}`);
      return withLog({ state: "satisfied" }, { op: "discharge", by: op.by });

    case "create":
      // Records the commitment's creation without changing its state. `by` is optional on create
      // (a commitment may be recorded without naming an actor), so it is omitted when absent rather
      // than written as an explicit `undefined` — the log entry never carries a hollow party field.
      return withLog({}, op.by === undefined ? { op: "create" } : { op: "create", by: op.by });

    default: {
      // Exhaustiveness: the CommitmentOpKind set is closed, so this is unreachable at runtime and a
      // compile error if a new kind is added without a case.
      const _never: never = op.kind;
      return refuse(`unknown commitment op ${String(_never)}`);
    }
  }
}

// ── Capacity / draws — per-unit over-commitment with NO conversion, ever ──────────────────────────

/** A per-unit tally of a set of draws — the vector the over-commitment check sums over. Units are
 *  OPAQUE and NON-CONVERTIBLE, so each distinct unit is its own bucket; nothing offsets across them. */
export function tallyDrawsPerUnit(draws: readonly Draw[]): Map<string, number> {
  const tally = new Map<string, number>();
  for (const d of draws) tally.set(d.unit, (tally.get(d.unit) ?? 0) + d.quantity);
  return tally;
}

/** The per-(resource, unit) join key. A draw is bound to a resource by slug AND to a unit; the two
 *  together are the axis over-commitment is summed on — never a cross-unit total. ` ` cannot
 *  appear in a slug or unit, so the composite key is unambiguous. */
function drawKey(resource_slug: string, unit: string): string {
  return `${resource_slug} ${unit}`;
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
export function checkTourCapacity(tour: Tour, resources: readonly Resource[]): AdmissibilityResult {
  const offenders: AdmissibilityOffender[] = [];
  const add = (ref: string, reason: string): void => {
    offenders.push({ kind: "law", ref, reason });
  };

  // Resources indexed by slug. A resource holds exactly ONE unit; a draw naming that slug in a
  // different unit does not draw a held unit (there is no conversion to the held one).
  const bySlug = new Map<string, Resource>();
  for (const r of resources) bySlug.set(r.slug, r);

  // Sum every draw across all bookings, bucketed by (resource_slug, unit) so no unit offsets another.
  const drawn = new Map<string, { resource_slug: string; unit: string; total: number }>();
  for (const b of tour.bookings) {
    for (const d of b.draws) {
      const key = drawKey(d.resource_slug, d.unit);
      const cur = drawn.get(key);
      if (cur) cur.total += d.quantity;
      else drawn.set(key, { resource_slug: d.resource_slug, unit: d.unit, total: d.quantity });
    }
  }

  for (const { resource_slug, unit, total } of drawn.values()) {
    const r = bySlug.get(resource_slug);
    // A draw against a resource the genome does not declare — a dead name, failing closed.
    if (!r) {
      add(resource_slug, `draw names undeclared resource "${resource_slug}" (dead name)`);
      continue;
    }
    // A NON-TRANSFERABLE holding of an org other than the tour's accountable org is unreachable —
    // checked before unit/quantity so a locked holding is refused for the right reason.
    if (r.holder !== tour.org_slug && !r.transferable) {
      add(resource_slug, `non-transferable holding of "${r.holder}" is unreachable by org "${tour.org_slug}"`);
      continue;
    }
    // A draw in a unit the holder does not hold — no conversion from the held unit to this one.
    if (r.unit !== unit) {
      add(resource_slug, `draw in unit "${unit}" but resource "${resource_slug}" holds "${r.unit}" — no conversion`);
      continue;
    }
    // Per-unit over-commitment: the sum of draws in this unit exceeds the declared quantity.
    if (total > r.quantity) {
      add(resource_slug, `over-committed: ${total} "${unit}" drawn against ${r.quantity} held`);
    }
  }

  return { admitted: offenders.length === 0, offenders };
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
export function checkTourAdmissibility(doc: TourDocument): AdmissibilityResult {
  const offenders: AdmissibilityOffender[] = [];
  const add = (ref: string, reason: string): void => {
    offenders.push({ kind: "law", ref, reason });
  };

  // (1) The tour must be a well-formed Tour — STRICT. An ill-formed tour (unknown key, missing
  //     field, a smuggled THIRD key on an acceptance) is a refusal, never a throw: the checker is
  //     TOTAL, so a shapeless document returns a value.
  const tourParse = TourSchema.safeParse(doc.tour);
  if (!tourParse.success) {
    for (const issue of tourParse.error.issues) {
      add("tour", `${issue.path.join(".") || "(root)"}: ${issue.message}`);
    }
    return { admitted: false, offenders };
  }
  const tour = tourParse.data as unknown as Tour;

  // (2) Resources the draws name — each validated, an invalid one recorded and dropped.
  const resources: Resource[] = [];
  (doc.resources ?? []).forEach((raw, i) => {
    const rp = ResourceSchema.safeParse(raw);
    if (!rp.success) {
      add(`resource[${i}]`, rp.error.issues.map((x) => x.message).join("; "));
      return;
    }
    resources.push(rp.data as unknown as Resource);
  });

  // (3) The chairs the tour resolves against, indexed by id. A responsible_chair or an
  //     accountable_office the genome cannot resolve is a dead name, failing closed.
  const chairIds = new Set<string>();
  for (const c of doc.chairs ?? []) {
    const rec = c as Record<string, unknown>;
    if (typeof rec.id === "string") chairIds.add(rec.id);
  }
  if (!chairIds.has(tour.responsible_chair)) {
    add("tour", `responsible_chair "${tour.responsible_chair}" resolves to no chair`);
  }

  // (4) Institution slug resolution — if an institution is supplied it must be the one the tour names.
  const inst = doc.institution as Record<string, unknown> | undefined;
  if (inst && typeof inst.slug === "string" && inst.slug !== tour.institution_slug) {
    add("tour", `institution_slug "${tour.institution_slug}" does not resolve to institution "${String(inst.slug)}"`);
  }

  // (5) Per booking: the accountable office resolves; the acceptance is evaluable OR the booking is
  //     explicitly declared-tier (an UNMARKED, unevaluable commitment is refused — silence must not
  //     pass a stated intention off as a checkable commitment); every served north star is one the
  //     tour actually declares.
  const declaredNorthstars = new Set(tour.northstar_slugs);
  for (const b of tour.bookings) {
    if (!chairIds.has(b.accountable_office)) {
      add(b.slug, `accountable_office "${b.accountable_office}" resolves to no chair`);
    }
    if (b.tier !== "declared" && !lawCheckIsEvaluable(b.acceptance)) {
      add(b.slug, "acceptance references an input it never declares and the booking is not marked declared-tier");
    }
    for (const ns of b.served_northstars) {
      if (!declaredNorthstars.has(ns)) {
        add(b.slug, `serves north star "${ns}" the tour does not declare`);
      }
    }
  }

  // (6) Capacity — per-unit over-commitment, dead-name and cross-org-transfer refusals, no conversion.
  offenders.push(...checkTourCapacity(tour, resources).offenders);

  return { admitted: offenders.length === 0, offenders };
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
 * Compute a booking's variance by READING the booking → gig → spend chain (never assembling it
 * by hand): for each gig id the booking settled against, read its ledger entry's usage.total_cost_usd
 * and sum.
 */
export function computeVariance(booking: Booking, ledger: readonly GigLedgerEntry[]): Variance {
  const ids = booking.settled_gig_ids ?? [];
  const own = new Set(ids);
  // Sum usage.total_cost_usd over ONLY the gigs this booking settled against, reading each row from
  // the supplied ledger — never assembling the number by hand, never looking off-repo. A row with no
  // usage payload contributes nothing (its spend is unknown, not zero-by-assertion).
  let settled = 0;
  for (const entry of ledger) {
    if (own.has(entry.gig_id) && entry.usage) settled += entry.usage.total_cost_usd;
  }
  // `amount` absence is "no numerator" — an honest null, NOT zero and NOT a throw.
  const hasNumerator = booking.amount !== undefined;
  const committed = hasNumerator ? booking.amount! : null;
  const variance = hasNumerator ? booking.amount! - settled : null;
  return {
    booking_slug: booking.slug,
    committed,
    settled,
    variance,
    has_numerator: hasNumerator,
    settled_gig_ids: ids,
  };
}

// ── The two visibilities, and the two reports — set differences over data the objects already carry ─

/** Unpromised work: gig ids that no booking settled against. Allowed, but VISIBLE — a set difference
 *  of all gig ids minus every id any booking promised. */
export function unpromisedGigs(
  allGigIds: readonly string[],
  bookings: readonly Booking[],
): string[] {
  const promised = new Set<string>();
  for (const b of bookings) for (const id of b.settled_gig_ids ?? []) promised.add(id);
  return allGigIds.filter((id) => !promised.has(id));
}

/** Undispatched bookings: still-live commitments that settled against no gig — VISIBLE, not dropped.
 *  A booking already discharged/cancelled/released is not "undispatched", so the query keeps only the
 *  ones whose lifecycle is still live AND that carry no settled gig. */
export function undispatchedBookings(bookings: readonly Booking[]): Booking[] {
  return bookings.filter(
    (b) => LIVE_STATES.has(b.lifecycle.state) && (b.settled_gig_ids ?? []).length === 0,
  );
}

/** Report A: north stars a tour names but no booking serves — directions nobody is funding. */
export function northstarsWithNoBooking(tour: Tour): string[] {
  const served = new Set<string>();
  for (const b of tour.bookings) for (const ns of b.served_northstars) served.add(ns);
  return tour.northstar_slugs.filter((ns) => !served.has(ns));
}

/** Report B: bookings serving no north star — spend with no stated direction. */
export function bookingsServingNoNorthstar(tour: Tour): Booking[] {
  return tour.bookings.filter((b) => b.served_northstars.length === 0);
}

// ── The strict Zod schemas — the runtime gate. Promoted into the single Zod source in
//    src/genome_schema.ts (per CLAUDE.md) and RE-EXPORTED here, so the tests import them from this
//    file unchanged while the shape lives in exactly one place. ───────────────────────────────────

export { DrawSchema, ResourceSchema, BookingSchema, TourSchema };
