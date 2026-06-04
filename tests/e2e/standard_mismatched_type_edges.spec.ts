// T-mismatched-type-edges e2e — adversarial unique-unknown: a standard whose
// phase-2 agent declares an input_type that NO upstream agent produces. Two
// surfaces under test:
//
//   1) src/composition.ts composeStandard — the wired check is in lines 114-128:
//      for every phase i > 0, each declared input_type must appear in the running
//      set of upstream output_types, else CompositionError. This test fingerprints
//      that gate AND probes its apoha:
//
//        a) edge-mismatch at phase 2 → must reject (the positive contract)
//        b) phase-0 mismatch (declared inputs that nobody produces, AND no upstream
//           exists) → SILENTLY ACCEPTED today because the loop gates on `i > 0`.
//           That is a structural assumption: phase 0 reads from gig_input, not
//           upstream. We record the gap rather than asserting reject; the runtime
//           probe below proves the user-visible cost.
//        c) empty-string input_type ("") → SILENTLY ACCEPTED today because the
//           short-circuit `if (it && !upstreamOutputs.has(it))` skips falsy slugs.
//
//   2) src/runtime.ts runGig — if composition lets a mismatched-edge standard
//      through (whether by gap-a, gap-b, or because composition was bypassed),
//      runGig walks phases linearly and the upstream filter
//
//          const inputs = produced.filter((o) => agent.input_types.includes(o.domain_type));
//
//      yields [] for the mismatched phase. Today the runtime does NOT fail loud
//      on empty inputs — it invokes the agent with `inputs: []` and writes whatever
//      data comes back. We assert that observed behavior so any future "strict
//      input-edge runtime check" addition trips this test for the right reason.
//
// Honest about scope: this is a fingerprint of TODAY's composer + runtime, with
// the apohas named in the assertions. The gaps recorded here are the bug-bash
// findings — when they get closed, the test gets flipped to assert rejection.
//
// Pattern lifted from standard_with_cycle.spec.ts (sequential it() blocks,
// MemoryLedger + in-memory registry, no tempdir needed — pure
// composition+runtime calls).

import { describe, expect, it } from "vitest";

import {
  CompositionError,
  MemoryLedger,
  composeStandard,
  createOutputStore,
  createRegistry,
  defineAgent,
  runGig,
  type AgentInvoker,
} from "../../src/index.js";

// ────────────────────────────────────────────────────────────────────────────
// 1) Phase-2 mismatch: phase 1 outputs X, phase 2 declares input Y (no producer).
//    This is the POSITIVE contract — composeStandard must REJECT.
// ────────────────────────────────────────────────────────────────────────────

describe("standard with mismatched type-edges (adversarial unique-unknown)", () => {
  it("composeStandard rejects phase-2 input with no upstream producer (X→ , Y in)", () => {
    // Phase 1 agent: produces "phase1-x-out"
    const producer = defineAgent({
      slug: "ProducerX",
      primitives: ["INTERPRET"],
      input_types: [], // phase 0, reads gig_input
      output_types: ["phase1-x-out"],
      domain: "demo",
    });
    // Phase 2 agent: declares INCOMPATIBLE input "phase2-y-in" — nobody produces it.
    const consumer = defineAgent({
      slug: "ConsumerY",
      primitives: ["INTERPRET"],
      input_types: ["phase2-y-in"], // upstream produces "phase1-x-out" — mismatch
      output_types: ["phase2-out"],
      domain: "demo",
    });

    expect(() =>
      composeStandard({
        slug: "broken-pipeline",
        domain: "demo",
        agents: [producer, consumer],
        phases: [
          { name: "phase1", agent: "ProducerX" },
          { name: "phase2", agent: "ConsumerY" },
        ],
      }),
    ).toThrowError(CompositionError);

    // Fingerprint the error message: it should name the missing input AND the phase,
    // so a future composer that loses the check goes RED rather than silently green.
    try {
      composeStandard({
        slug: "broken-pipeline-msg",
        domain: "demo",
        agents: [producer, consumer],
        phases: [
          { name: "phase1", agent: "ProducerX" },
          { name: "phase2", agent: "ConsumerY" },
        ],
      });
      expect.fail("expected CompositionError but composeStandard returned");
    } catch (e) {
      expect(e).toBeInstanceOf(CompositionError);
      const msg = (e as Error).message;
      // Must identify the missing input type AND mention the offending phase.
      expect(msg).toMatch(/phase2-y-in/);
      expect(msg).toMatch(/phase2/);
      // Spec language: "not produced upstream"
      expect(msg.toLowerCase()).toMatch(/upstream|not produced|missing/);
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 2) APOHA — Phase 0 mismatch. composition.ts gates the check on `i > 0`,
  //    so phase 0 can declare any input_types and composition will not catch
  //    it (the assumption is "phase 0 reads gig_input"). This test pins the
  //    current behavior: composition ACCEPTS, then proves the runtime cost.
  //
  //    Bug-bash finding: there is no surface that verifies phase-0 input_types
  //    against gig_input shape. Garbage in, garbage through.
  // ──────────────────────────────────────────────────────────────────────────
  it("APOHA: phase-0 with declared input_types that no one produces is SILENTLY ACCEPTED + runtime runs with empty inputs", async () => {
    const orphan = defineAgent({
      slug: "OrphanPhase0",
      primitives: ["INTERPRET"],
      input_types: ["nobody-makes-this"], // phase 0, declared but no upstream/gig surface validates it
      output_types: ["orphan-out"],
      domain: "demo",
    });

    let composeErr: Error | null = null;
    try {
      composeStandard({
        slug: "phase0-mismatch",
        domain: "demo",
        agents: [orphan],
        phases: [{ name: "phase0", agent: "OrphanPhase0" }],
      });
    } catch (e) {
      composeErr = e as Error;
    }

    // Fingerprint of the gap: composition does NOT reject (phase 0 is unguarded).
    // If a future composer closes this gap, this assertion flips and we move
    // the orphan declaration into the "rejected" bucket.
    expect(composeErr).toBeNull();

    // Runtime probe: runGig invokes the orphan with inputs=[] (no upstream, no
    // gig_input → input_type matching). This is the user-visible cost of the gap.
    const composed = composeStandard({
      slug: "phase0-mismatch-run",
      domain: "demo",
      agents: [orphan],
      phases: [{ name: "phase0", agent: "OrphanPhase0" }],
    });

    const registry = createRegistry();
    registry.registerType({
      slug: "orphan-out",
      extends: "Interpretation",
      domain: "demo",
      schema: { type: "object", properties: { v: { type: "string" } } },
      required_fields: ["v"],
    });
    const outputs = createOutputStore(registry);
    const ledger = new MemoryLedger();

    let observedInputsLength = -1;
    const invoke: AgentInvoker = ({ inputs }) => {
      observedInputsLength = inputs.length;
      return { v: "garbage-because-no-real-inputs" };
    };

    const result = await runGig(composed, { unrelated: "payload" }, {
      outputs,
      ledger,
      invoke,
      model_version: "type-edge-test",
    });

    // Bug-bash assertion: runtime ran with EMPTY inputs despite the agent declaring
    // it consumes "nobody-makes-this". No error, no warning, status=complete.
    expect(result.status).toBe("complete");
    expect(observedInputsLength).toBe(0);
    expect(result.outputs.length).toBe(1);
    expect(result.outputs[0]!.domain_type).toBe("orphan-out");
  }, 15_000);

  // ──────────────────────────────────────────────────────────────────────────
  // 3) APOHA — empty-string input_type slug. The composition check uses
  //    `if (it && !upstreamOutputs.has(it))` which short-circuits on falsy slugs.
  //    composition ACCEPTS phases whose input_types is [""].
  // ──────────────────────────────────────────────────────────────────────────
  it("APOHA: empty-string input_type slug is SILENTLY ACCEPTED by composeStandard's short-circuit", () => {
    const producer = defineAgent({
      slug: "ProducerE",
      primitives: ["INTERPRET"],
      input_types: [],
      output_types: ["e-out"],
      domain: "demo",
    });
    const sneaky = defineAgent({
      slug: "SneakyEmpty",
      primitives: ["INTERPRET"],
      input_types: [""], // falsy slug — short-circuit hides this from the check
      output_types: ["sneaky-out"],
      domain: "demo",
    });

    let composed: ReturnType<typeof composeStandard> | null = null;
    let composeErr: Error | null = null;
    try {
      composed = composeStandard({
        slug: "empty-input",
        domain: "demo",
        agents: [producer, sneaky],
        phases: [
          { name: "phase1", agent: "ProducerE" },
          { name: "phase2", agent: "SneakyEmpty" },
        ],
      });
    } catch (e) {
      composeErr = e as Error;
    }

    // Pin the gap: composition accepts "" as a phase-2 input_type today.
    expect(composeErr).toBeNull();
    expect(composed).not.toBeNull();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 4) Multi-input partial-mismatch: phase 2 declares TWO inputs, only one is
  //    upstream-produced. composeStandard must reject on the unmatched one.
  // ──────────────────────────────────────────────────────────────────────────
  it("composeStandard rejects multi-input phase when ONE input has no producer (partial mismatch)", () => {
    const a = defineAgent({
      slug: "Pa",
      primitives: ["INTERPRET"],
      input_types: [],
      output_types: ["good-input"],
      domain: "demo",
    });
    const b = defineAgent({
      slug: "Pb",
      primitives: ["INTERPRET"],
      input_types: ["good-input", "bogus-input"], // bogus is unproduced upstream
      output_types: ["b-out"],
      domain: "demo",
    });

    expect(() =>
      composeStandard({
        slug: "partial-mismatch",
        domain: "demo",
        agents: [a, b],
        phases: [
          { name: "p1", agent: "Pa" },
          { name: "p2", agent: "Pb" },
        ],
      }),
    ).toThrowError(/bogus-input/);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 5) APOHA — runtime garbage-through. If a mismatched-edge standard is built
  //    via direct struct (bypassing composeStandard), runtime runs without
  //    diagnosing the empty-inputs case. Today: silent garbage propagation.
  //    This is the strongest bug-bash finding — the runtime has zero defense.
  // ──────────────────────────────────────────────────────────────────────────
  it("APOHA: runtime runs broken standard with empty inputs + no warning when composition is bypassed", async () => {
    const producer = defineAgent({
      slug: "RtProducer",
      primitives: ["INTERPRET"],
      input_types: [],
      output_types: ["rt-x"],
      domain: "demo",
    });
    const consumer = defineAgent({
      slug: "RtConsumer",
      primitives: ["INTERPRET"],
      input_types: ["rt-y"], // mismatch — upstream produces rt-x, consumer wants rt-y
      output_types: ["rt-final"],
      domain: "demo",
    });

    // Bypass composeStandard — construct the Standard struct directly. This is
    // the "what if the gate is wrong / what if someone hand-rolls a standard"
    // scenario the runtime would face in adversarial input.
    const brokenStandard = {
      slug: "rt-bypass-broken",
      domain: "demo",
      agents: [producer, consumer] as const,
      phases: [
        { name: "p1", agent: "RtProducer" },
        { name: "p2", agent: "RtConsumer" },
      ] as const,
    };

    // Registry has a reuse-enforcement gate: two types with same extends+domain+
    // required_fields score >= 80 and the second registration throws. We give each
    // type a distinct required_fields shape so both can register cleanly.
    const registry = createRegistry();
    registry.registerType({
      slug: "rt-x",
      extends: "Interpretation",
      domain: "demo",
      schema: { type: "object", properties: { v: { type: "string" } } },
      required_fields: ["v"],
    });
    registry.registerType({
      slug: "rt-final",
      extends: "Interpretation",
      domain: "demo",
      schema: {
        type: "object",
        properties: { v: { type: "string" }, w: { type: "string" }, z: { type: "string" } },
      },
      required_fields: ["v", "w", "z"],
    });
    const outputs = createOutputStore(registry);
    const ledger = new MemoryLedger();

    const observedInputLengths: number[] = [];
    const invoke: AgentInvoker = ({ agent, inputs }) => {
      observedInputLengths.push(inputs.length);
      // each agent returns data matching its declared output's required_fields
      if (agent.slug === "RtProducer") return { v: "p1" };
      return { v: "p2", w: "garbage-because-no-real-inputs", z: "still-no-warning" };
    };

    const result = await runGig(brokenStandard, {}, {
      outputs,
      ledger,
      invoke,
      model_version: "rt-bypass",
    });

    // Bug-bash assertion: phase 2 RAN with empty inputs (the type-edge mismatch
    // was invisible to runtime). Final status is "complete" — no loud failure.
    expect(result.status).toBe("complete");
    expect(observedInputLengths).toEqual([0, 0]); // p1: nothing upstream; p2: mismatch → []
    expect(result.outputs.length).toBe(2);
  }, 15_000);
});
