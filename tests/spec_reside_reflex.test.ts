// RED — the reflex listener acks with NO model on the path, within a DETERMINISTIC budget.
// Closes defect (5): the 250ms reflex budget has no stated measurement conditions, so a wall-clock
// assertion passes on a laptop and fails on a loaded Fly machine. The buildable law is the
// structural pair the grounding chose (deterministic simulation testing — TigerBeetle VOPR /
// FoundationDB): (a) the reflex path invokes the model-invoker ZERO times, and (b) under an injected
// clock it completes within N simulated ticks — machine-independent and reproducible.
//
// Covers I10 (reflex path invokes the model zero times) and I11 (reflex path bounded by N injected
// ticks, no wall-clock).
//
// RED because reflexAck / REFLEX_BUDGET_TICKS live in the not-yet-authored src/residency.ts.
import { describe, it, expect, beforeAll, vi } from "vitest";
import fc from "fast-check";
import { loadResidency, type ResidencyModule, type InboundMessage, type SimClock } from "./spec_reside_fixtures.js";

let R: ResidencyModule;
beforeAll(async () => {
  R = await loadResidency();
});

// A deterministic, injected clock: no Date.now, no wall-clock — time only moves when the code under
// test asks it to. This is what makes the budget law reproducible by seed on any machine.
function simClock(): SimClock {
  let t = 0;
  return { now: () => t, tick: (n = 1) => { t += n; } };
}

const messageArb: fc.Arbitrary<InboundMessage> = fc.record({
  id: fc.uuid(),
  text: fc.string(),
  at: fc.integer({ min: 0, max: 1_000_000 }),
});

describe("the reflex path invokes NO model (I10)", () => {
  it("I10 acking any inbound message calls the model-invoker exactly zero times", () => {
    fc.assert(
      fc.property(messageArb, (msg) => {
        const invoke = vi.fn();
        R.reflexAck(msg, { invoke, clock: simClock() });
        expect(invoke, "a model was invoked on the reflex path").toHaveBeenCalledTimes(0);
      }),
    );
  });

  it("I10 the ack still happens even when an invoker is present (dumb by design)", () => {
    const invoke = vi.fn(() => { throw new Error("the reflex must never reach a model"); });
    const r = R.reflexAck({ id: "m1", text: "hello", at: 0 }, { invoke, clock: simClock() });
    expect(r.acked).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(0);
  });
});

describe("the reflex path is bounded by a deterministic budget, not a wall clock (I11)", () => {
  it("I11 completes within REFLEX_BUDGET_TICKS simulated ticks, for any message", () => {
    fc.assert(
      fc.property(messageArb, (msg) => {
        const r = R.reflexAck(msg, { invoke: vi.fn(), clock: simClock() });
        // Machine-independent: the assertion is over SIMULATED ticks the code advanced, so it holds
        // identically on a laptop and a loaded Fly machine — no flaky real-millisecond number.
        expect(r.elapsed_ticks, "the reflex overran its deterministic budget").toBeLessThanOrEqual(
          R.REFLEX_BUDGET_TICKS,
        );
      }),
    );
  });

  it("I11 the budget is a stated finite number, not an unmeasured wall-clock 250ms", () => {
    expect(Number.isFinite(R.REFLEX_BUDGET_TICKS)).toBe(true);
    expect(R.REFLEX_BUDGET_TICKS).toBeGreaterThan(0);
  });
});
