// Shared SYNTHETIC fixtures for the committed-work (Tour / Booking / Resource) red spec.
//
// No real customer, partner, product or person names anywhere — every slug here is invented. The
// funded fixtures carry SYNTHETIC dollar amounts precisely so the money path is fully exercised (a
// fork could run a funded tour on day one); what the shipped worked example omits is fake numbers,
// not the mechanism.
import type {
  Booking,
  CommitmentRecord,
  CommitmentState,
  Draw,
  Resource,
  Tour,
} from "../../src/committed_work.js";
import type { LawCheck } from "../../src/institution_enforcement.js";
import type { GigLedgerEntry } from "../../src/ledger.js";

/** An acceptance that REDUCES over its declared inputs — an evaluable, enforced-tier commitment. */
export function evaluableAcceptance(): LawCheck {
  return { predicate: '(=> (= milestone "shipped") allow)', inputs: { milestone: "milestone-state" } };
}

/** An acceptance whose predicate references an input it never declares — it cannot evaluate, so a
 *  booking carrying it must be marked declared-tier or be refused. */
export function unevaluableAcceptance(): LawCheck {
  return { predicate: '(=> (= mystery "x") allow)', inputs: {} };
}

export function liveRecord(state: CommitmentState = "active"): CommitmentRecord {
  return { state, debtor: "chair.builder", creditor: "org.house", log: [] };
}

export function draw(over: Partial<Draw> = {}): Draw {
  return { resource_slug: "res.compute-seat", unit: "max-seat-hours", quantity: 1, ...over };
}

/** A transferable house-held resource in a synthetic unit. */
export function resource(over: Partial<Resource> = {}): Resource {
  return {
    slug: "res.compute-seat",
    holder: "org.house",
    quantity: 100,
    unit: "max-seat-hours",
    period: "2026-Q3",
    transferable: true,
    ...over,
  };
}

/** A well-formed booking: evaluable acceptance, one draw, serves one north star, live. */
export function booking(over: Partial<Booking> = {}): Booking {
  return {
    slug: "bk.ship-evaluator",
    aim: "ship the acceptance evaluator",
    period: "2026-Q3",
    accountable_office: "chair.builder",
    acceptance: evaluableAcceptance(),
    tier: "enforced",
    draws: [draw()],
    served_northstars: ["ns.enforce-the-laws"],
    lifecycle: liveRecord(),
    ...over,
  };
}

/** A well-formed tour aggregating the given bookings (defaults to one). */
export function tour(over: Partial<Tour> = {}): Tour {
  return {
    slug: "tour.coltrane-roadmap",
    institution_slug: "coltrane",
    org_slug: "org.house",
    responsible_chair: "chair.governor",
    period: "2026-Q3",
    northstar_slugs: ["ns.enforce-the-laws"],
    bookings: [booking()],
    ...over,
  };
}

/** A settled gig ledger row carrying real (synthetic) model spend, for variance reads. */
export function gigRow(gig_id: string, cost_usd: number): GigLedgerEntry {
  return {
    schema_version: 2,
    entry_id: `entry.${gig_id}`,
    kind: "gig",
    output_hashes: [],
    started_at: "2026-07-01T00:00:00.000Z",
    finished_at: "2026-07-01T01:00:00.000Z",
    gig_id,
    standard_slug: "spec-drafting-v1",
    genome_hash: "sha256:" + "0".repeat(64),
    run_fingerprint: "fp." + gig_id,
    usage: {
      input_tokens: 1000,
      output_tokens: 500,
      total_cost_usd: cost_usd,
      by_model: {},
    },
  };
}
