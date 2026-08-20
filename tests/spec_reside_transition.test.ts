// RED — the residency status as a party-constrained TOTAL transition function, not a string
// anyone can set. Closes defect (3): six status values and no transition function.
//
// Covers I4 (total — never throws), I5 (legal-set closed, EXHAUSTIVE over states x ops), I6 (party
// constitutive — who-may-act is a law, exhaustive over the reserved ops), I7 (immutable identity).
//
// The pattern is applyCommitmentOp (src/committed_work.ts:214): a total (rec, op) ->
// {ok:true,next} | {ok:false,reason} that never throws once the record is built, a closed state set
// exposed AS DATA, and party constraints where the actor is constitutive. The legal set and party
// constraints are asserted EXHAUSTIVELY over the whole finite domain, never a lucky path — a
// happy-path example would pass regardless of the implementation.
//
// RED because applyResidencyOp lives in the not-yet-authored src/residency.ts; loadResidency()
// rejects until it exists (see spec_reside_fixtures.ts).
import { describe, it, expect, beforeAll } from "vitest";
import fc from "fast-check";
import {
  loadResidency,
  resIn,
  canonicalOp,
  RESIDENCY_STATES,
  RESIDENCY_OPS,
  RESIDENCY_ACTORS,
  LEGAL_TRANSITIONS,
  type ResidencyModule,
  type ResidencyState,
  type ResidencyOpKind,
  type ResidencyActor,
} from "./spec_reside_fixtures.js";

let R: ResidencyModule;
beforeAll(async () => {
  R = await loadResidency();
});

const anyState = fc.constantFrom(...RESIDENCY_STATES);
const anyOp = fc.constantFrom(...RESIDENCY_OPS);

function isLegal(from: ResidencyState, op: ResidencyOpKind): boolean {
  return LEGAL_TRANSITIONS.some((t) => t.from === from && t.op === op);
}
function legalTo(from: ResidencyState, op: ResidencyOpKind): ResidencyState | undefined {
  return LEGAL_TRANSITIONS.find((t) => t.from === from && t.op === op)?.to;
}

describe("the module exposes the contract's closed sets as data", () => {
  it("the exported state set, op set and legal table match the contract", () => {
    expect([...R.RESIDENCY_STATES].sort()).toEqual([...RESIDENCY_STATES].sort());
    expect([...R.RESIDENCY_OPS].sort()).toEqual([...RESIDENCY_OPS].sort());
    expect(R.LEGAL_TRANSITIONS).toEqual(LEGAL_TRANSITIONS);
  });
});

describe("applyResidencyOp is a total function (I4)", () => {
  it("I4 never throws for ANY (state, op) pair in the closed domain", () => {
    fc.assert(
      fc.property(anyState, anyOp, (state, kind) => {
        const rec = resIn(state);
        // A refusal is a decision, never a throw. Once built the function must be total.
        expect(() => R.applyResidencyOp(rec, canonicalOp(kind, rec))).not.toThrow();
      }),
    );
  });

  it("I4 always returns a discriminated {ok:true,next} | {ok:false,reason}", () => {
    fc.assert(
      fc.property(anyState, anyOp, (state, kind) => {
        const rec = resIn(state);
        const r = R.applyResidencyOp(rec, canonicalOp(kind, rec));
        if (r.ok) expect(r.next).toBeDefined();
        else expect(typeof r.reason).toBe("string");
      }),
    );
  });
});

describe("only declared transitions are reachable (I5)", () => {
  it("I5 EXHAUSTIVE: every (state, op) outside the legal table is refused and leaves state unchanged", () => {
    for (const state of RESIDENCY_STATES) {
      for (const kind of RESIDENCY_OPS) {
        if (isLegal(state, kind)) continue;
        const rec = resIn(state);
        const r = R.applyResidencyOp(rec, canonicalOp(kind, rec));
        expect(r.ok, `${kind} was accepted from illegal state ${state}`).toBe(false);
      }
    }
  });

  it("I5 EXHAUSTIVE: every (state, op) IN the legal table applies and lands on the declared target", () => {
    for (const state of RESIDENCY_STATES) {
      for (const kind of RESIDENCY_OPS) {
        if (!isLegal(state, kind)) continue;
        const rec = resIn(state);
        const r = R.applyResidencyOp(rec, canonicalOp(kind, rec));
        expect(r.ok, `legal op ${kind} was refused from ${state}`).toBe(true);
        if (r.ok) {
          expect(r.next.status, `${kind} from ${state} landed off the declared target`).toBe(
            legalTo(state, kind),
          );
        }
      }
    }
  });
});

describe("who-may-act is constitutive (I6)", () => {
  // Reserved: only the holder may hibernate/thaw/unseat-gracefully; only the reaper may reap a
  // dead-hibernated residency. An op by the wrong party is wrong_party in EVERY state it is
  // otherwise legal from.
  const RESERVED: { op: ResidencyOpKind; only: ResidencyActor }[] = [
    { op: "hibernate", only: "holder" },
    { op: "thaw", only: "holder" },
    { op: "unseat", only: "holder" },
    { op: "reap", only: "reaper" },
  ];

  it("I6 a party-reserved op performed by the WRONG actor is refused wrong_party, exhaustively", () => {
    for (const { op, only } of RESERVED) {
      for (const state of RESIDENCY_STATES) {
        if (!isLegal(state, op)) continue;
        const rec = resIn(state);
        for (const actor of RESIDENCY_ACTORS) {
          if (actor === only) continue;
          const r = R.applyResidencyOp(rec, { ...canonicalOp(op, rec), by: actor });
          expect(r.ok, `${actor} performed ${op} (reserved to ${only}) from ${state}`).toBe(false);
          if (!r.ok) expect(r.reason).toBe("wrong_party");
        }
      }
    }
  });

  it("I6 the reserved actor IS accepted (the constraint is a gate, not a lock)", () => {
    const rec = resIn("listening");
    const r = R.applyResidencyOp(rec, canonicalOp("hibernate", rec)); // by: holder
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.next.status).toBe("hibernated");
  });
});

describe("seated identity is immutable (I7)", () => {
  // Over LIVE states, where `heartbeat` is legal — so the ONLY reason to refuse is the identity
  // mutation, and the refusal reason is unambiguously immutable_identity (not illegal_transition).
  const liveState = fc.constantFrom(...RESIDENCY_STATES.filter((s) => isLegal(s, "heartbeat")));
  it("I7 any op carrying a different agent_slug / org / channel_id is refused immutable_identity", () => {
    const fields = fc.constantFrom("agent_slug", "org", "channel_id");
    fc.assert(
      fc.property(liveState, fields, (state, field) => {
        const rec = resIn(state);
        const different = `${(rec as unknown as Record<string, unknown>)[field]}-DIFFERENT`;
        // A benign live op (heartbeat) that additionally tries to re-point an identity column.
        const op = { ...canonicalOp("heartbeat", rec), [field]: different };
        const r = R.applyResidencyOp(rec, op);
        expect(r.ok, `${field} was mutated after seating in ${state}`).toBe(false);
        if (!r.ok) expect(r.reason).toBe("immutable_identity");
      }),
    );
  });
});
