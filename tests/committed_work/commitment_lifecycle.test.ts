// RED — the commitment lifecycle as a party-constrained STATE MACHINE, not a status enum.
//
// Covers contract INV5, INV6, INV7, INV8, INV9, INV10, INV11, INV12. The transition function
// `applyCommitmentOp` is an unbuilt seam that throws, so every behavioural assertion is RED because
// the enforcement is absent — the suite compiles clean (the state set, the party vocabulary and the
// transition signature are real symbols).
//
// The party constraints (INV6, INV7, INV12) are pinned as PROPERTIES over all live states rather than
// a hand-picked example: cancel-by-a-creditor and release-by-a-debtor must be refused for EVERY
// reachable live state, and cancel and release must never write the same value in ANY of them — the
// fast-check model-based method the grounding chose (a transition gated on party+state), so the
// contract's algebra is covered rather than one lucky path.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  applyCommitmentOp,
  COMMITMENT_STATES,
  LIVE_STATES,
  type CommitmentRecord,
  type CommitmentState,
} from "../../src/committed_work.js";
import { liveRecord } from "./_fixtures.js";

const liveState = fc.constantFrom(...[...LIVE_STATES]);

function recIn(state: CommitmentState): CommitmentRecord {
  return { state, debtor: "chair.builder", creditor: "org.house", log: [] };
}

describe("the lifecycle state set holds cancel and release apart (INV5)", () => {
  it("INV5 cancelled and released are DISTINCT members of the closed state set", () => {
    // The state SET carrying both is a necessary condition; the behavioural guarantee that the two
    // acts never collapse is INV12 below. This asserts the vocabulary can express the distinction.
    expect(COMMITMENT_STATES).toContain("cancelled");
    expect(COMMITMENT_STATES).toContain("released");
    // The real distinctness that matters: the value cancel writes is not the value release writes.
    // Read straight from the transition so the guarantee is behavioural, not a naming convention.
    const afterCancel = applyCommitmentOp(recIn("active"), { kind: "cancel", by: "debtor" });
    const afterRelease = applyCommitmentOp(recIn("active"), { kind: "release", by: "creditor" });
    expect(afterCancel.ok && afterRelease.ok).toBe(true);
    if (afterCancel.ok && afterRelease.ok) {
      expect(afterCancel.next.state).toBe("cancelled");
      expect(afterRelease.next.state).toBe("released");
      expect(afterCancel.next.state).not.toBe(afterRelease.next.state);
    }
  });
});

describe("party constraints — who may perform which act (INV6, INV7)", () => {
  it("INV6 cancel is DEBTOR-only: a creditor's cancel is refused in every live state", () => {
    fc.assert(
      fc.property(liveState, (state) => {
        const r = applyCommitmentOp(recIn(state), { kind: "cancel", by: "creditor" });
        expect(r.ok, `a creditor cancelled a commitment in state ${state}`).toBe(false);
      }),
    );
  });

  it("INV6 a DEBTOR's cancel is accepted", () => {
    const r = applyCommitmentOp(recIn("active"), { kind: "cancel", by: "debtor" });
    expect(r.ok).toBe(true);
  });

  it("INV7 release is CREDITOR-only: a debtor's release is refused in every live state", () => {
    fc.assert(
      fc.property(liveState, (state) => {
        const r = applyCommitmentOp(recIn(state), { kind: "release", by: "debtor" });
        expect(r.ok, `a debtor released a commitment in state ${state}`).toBe(false);
      }),
    );
  });

  it("INV7 a CREDITOR's release is accepted", () => {
    const r = applyCommitmentOp(recIn("active"), { kind: "release", by: "creditor" });
    expect(r.ok).toBe(true);
  });
});

describe("substitution keeps the commitment LIVE (INV8, INV9)", () => {
  it("INV8 delegate substitutes the debtor, stays live, and RECORDS the residual (not overwrite)", () => {
    const before = liveRecord("active");
    const r = applyCommitmentOp(before, { kind: "delegate", by: "debtor", substitute: "chair.deputy" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(LIVE_STATES.has(r.next.state), "a delegated commitment must stay live").toBe(true);
      expect(r.next.debtor, "the debtor was substituted").toBe("chair.deputy");
      // the original debtor's residual responsibility is APPENDED, never edited away
      const residual = r.next.log.find((e) => e.op === "delegate");
      expect(residual?.residual_debtor, "the original debtor is retained as residual").toBe(before.debtor);
      expect(r.next.log.length).toBeGreaterThan(before.log.length);
    }
  });

  it("INV9 assign substitutes the creditor and stays live", () => {
    const before = liveRecord("active");
    const r = applyCommitmentOp(before, { kind: "assign", by: "creditor", substitute: "org.successor" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(LIVE_STATES.has(r.next.state), "an assigned commitment must stay live").toBe(true);
      expect(r.next.creditor).toBe("org.successor");
    }
  });
});

describe("detach is automatic; discharge satisfies (INV10, INV11)", () => {
  it("INV10 detach fires conditional → active with NO party actor", () => {
    // Detach has no actor-invoked entry point: it carries no `by`. Given the antecedent holds, a
    // conditional commitment becomes active on its own.
    const r = applyCommitmentOp(recIn("conditional"), { kind: "detach" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.next.state).toBe("active");
  });

  it("INV10 detach invoked WITH a party actor is rejected — it is automatic, never performed", () => {
    const r = applyCommitmentOp(recIn("conditional"), { kind: "detach", by: "debtor" });
    expect(r.ok, "detach is automatic; a party may not perform it").toBe(false);
  });

  it("INV11 discharge by the debtor on an active commitment yields satisfied", () => {
    const r = applyCommitmentOp(recIn("active"), { kind: "discharge", by: "debtor" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.next.state).toBe("satisfied");
  });
});

describe("cancel and release never collapse into one value (INV12)", () => {
  it("INV12 for every live state, cancel(debtor) and release(creditor) write different states", () => {
    fc.assert(
      fc.property(liveState, (state) => {
        const c = applyCommitmentOp(recIn(state), { kind: "cancel", by: "debtor" });
        const rel = applyCommitmentOp(recIn(state), { kind: "release", by: "creditor" });
        // Both are legitimate acts by their respective parties; their RESULT states must differ, so
        // no single `cancelled` value could ever stand for both.
        if (c.ok && rel.ok) {
          expect(c.next.state).not.toBe(rel.next.state);
        }
      }),
    );
  });
});
