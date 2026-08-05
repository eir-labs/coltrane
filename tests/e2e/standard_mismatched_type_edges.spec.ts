// T-mismatched-type-edges e2e — adversarial unique-unknown: a standard whose
// phase-2 agent declares an input_type that NO upstream agent produces. Two
// surfaces under test:
//
//   1) src/composition.ts composeStandard — the wired check is in lines 114-128:
//      for every phase i > 0, each declared input_type must appear in the running
//      set of upstream output_types, else CompositionError. This test fingerprints
//      that gate AND probes its scope boundaries:
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
//      yields [] for the mismatched phase. The runtime USED to invoke the agent
//      with `inputs: []` and seal whatever came back. #245 closed most of that gap:
//      a chair whose bound agent declares input_types it cannot be given now fails
//      loud. The two runtime probes below were written as pre-authorized REDs — the
//      original header invited "any future strict input-edge runtime check" to trip
//      them. It has, PARTIALLY, and the split is recorded honestly:
//
//        * probe 5 (a DOWNSTREAM consumer whose upstream produces the wrong type)
//          now asserts REJECTION. Fully flipped.
//        * probe 2 (a phase-0 ENTRY chair with a non-empty gig payload) still asserts
//          the old behavior, because a runtime check cannot close it without breaking
//          `standards/patent-triage-v0.json`, which ships that exact shape. Its
//          empty-payload sibling IS closed and asserted alongside it. Closing the rest
//          is a definition fix (#156 typed gig inputs), not a runtime one.
//
// Honest about scope: this is a fingerprint of TODAY's composer + runtime, with
// the scope boundaries named in the assertions. The COMPOSITION gaps recorded here
// (phase-0 unguarded, empty-string slug short-circuit) are still open — they are
// composer-side, and the runtime check is what now stops most of them being
// user-visible.
//
// Pattern lifted from standard_with_cycle.spec.ts (sequential it() blocks,
// MemoryLedger + in-memory registry, no tempdir needed — pure
// composition+runtime calls).

import { describe, expect, it } from "vitest";
import { TEST_BEHAVIOR } from "../_support/agents.js";

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
    const producer = defineAgent({ ...TEST_BEHAVIOR,
      slug: "ProducerX",
      primitives: ["INTERPRET"],
      input_types: [], // phase 0, reads gig_input
      output_types: ["phase1-x-out"],
      domain: "demo",
    });
    // Phase 2 agent: declares INCOMPATIBLE input "phase2-y-in" — nobody produces it.
    const consumer = defineAgent({ ...TEST_BEHAVIOR,
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
          { name: "phase1", chairs: [{ role: "phase1", agent_slug: "ProducerX", depends_on: [], input_contract: [], output_contract: ["phase1-x-out"], required_skills: [] }] },
          { name: "phase2", chairs: [{ role: "phase2", agent_slug: "ConsumerY", depends_on: [], input_contract: [], output_contract: ["phase2-out"], required_skills: [] }] },
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
          { name: "phase1", chairs: [{ role: "phase1", agent_slug: "ProducerX", depends_on: [], input_contract: [], output_contract: ["phase1-x-out"], required_skills: [] }] },
          { name: "phase2", chairs: [{ role: "phase2", agent_slug: "ConsumerY", depends_on: [], input_contract: [], output_contract: ["phase2-out"], required_skills: [] }] },
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
  it("APOHA: phase-0 with declared input_types that no one produces is SILENTLY ACCEPTED, and a SEEDED entry chair still runs on empty inputs (#245 — the half a runtime check cannot close)", async () => {
    const orphan = defineAgent({ ...TEST_BEHAVIOR,
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
        phases: [{ name: "phase0", chairs: [{ role: "phase0", agent_slug: "OrphanPhase0", depends_on: [], input_contract: [], output_contract: ["orphan-out"], required_skills: [] }] }],
      });
    } catch (e) {
      composeErr = e as Error;
    }

    // Fingerprint of the gap: composition does NOT reject (phase 0 is unguarded).
    // If a future composer closes this gap, this assertion flips and we move
    // the orphan declaration into the "rejected" bucket.
    expect(composeErr).toBeNull();

    // Runtime probe. #245 added a floor for chairs handed nothing they declared they consume,
    // and it deliberately EXEMPTS a phase-0 entry chair with a non-empty gig payload — see
    // src/runtime.ts. The reason is concrete, not caution: `standards/patent-triage-v0.json`
    // ships exactly this shape. Its `cleave` chair binds `diamond-cutter`, which declares
    // `input_types: ["invention-spec"]`, and the gig seeds it with an UNTYPED
    // `{description: "…"}` payload. The runtime sees the same three facts here as it does
    // there — declared type, nothing upstream, some payload — so any check that rejects this
    // orphan also makes the repo's own shipped standard undispatchable.
    //
    // This therefore stays a fingerprint rather than becoming a rejection. Closing it is a
    // DEFINITION fix: the standard must declare `input_types` (#156) so the entry-chair seed is
    // typed, at which point the floor discriminates. The empty-payload variant below IS closed,
    // because there nothing could have supplied the type by any route.
    const composed = composeStandard({
      slug: "phase0-mismatch-run",
      domain: "demo",
      agents: [orphan],
      phases: [{ name: "phase0", chairs: [{ role: "phase0", agent_slug: "OrphanPhase0", depends_on: [], input_contract: [], output_contract: ["orphan-out"], required_skills: [] }] }],
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

    // Bug-bash assertion (STILL OPEN, by the reasoning above): a SEEDED phase-0 chair runs with
    // EMPTY inputs despite the agent declaring it consumes "nobody-makes-this".
    expect(result.status).toBe("complete");
    expect(observedInputsLength).toBe(0);
    expect(result.outputs.length).toBe(1);
    expect(result.outputs[0]!.domain_type).toBe("orphan-out");

    // FLIPPED (#245): the same chair with NO gig payload at all IS now refused. Nothing could
    // have supplied `nobody-makes-this` by any route, so invoking the agent means inventing an
    // answer — and the runtime names the type it could not supply instead.
    const outputs2 = createOutputStore(registry);
    let secondInvokeInputs = -1;
    await expect(
      runGig(composed, {}, {
        outputs: outputs2, ledger, model_version: "type-edge-test",
        invoke: ({ inputs }) => { secondInvokeInputs = inputs.length; return { v: "would-have-been-invented" }; },
      }),
    ).rejects.toThrow(/nobody-makes-this/);
    expect(secondInvokeInputs, "the agent must not be invoked at all").toBe(-1);
    expect(outputs2.all().length, "nothing hallucinated is sealed").toBe(0);
  }, 15_000);

  // ──────────────────────────────────────────────────────────────────────────
  // 3) APOHA — empty-string input_type slug. The composition check uses
  //    `if (it && !upstreamOutputs.has(it))` which short-circuits on falsy slugs.
  //    composition ACCEPTS phases whose input_types is [""].
  // ──────────────────────────────────────────────────────────────────────────
  it("APOHA: empty-string input_type slug is SILENTLY ACCEPTED by composeStandard's short-circuit", () => {
    const producer = defineAgent({ ...TEST_BEHAVIOR,
      slug: "ProducerE",
      primitives: ["INTERPRET"],
      input_types: [],
      output_types: ["e-out"],
      domain: "demo",
    });
    const sneaky = defineAgent({ ...TEST_BEHAVIOR,
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
          { name: "phase1", chairs: [{ role: "phase1", agent_slug: "ProducerE", depends_on: [], input_contract: [], output_contract: ["e-out"], required_skills: [] }] },
          { name: "phase2", chairs: [{ role: "phase2", agent_slug: "SneakyEmpty", depends_on: [], input_contract: [], output_contract: ["sneaky-out"], required_skills: [] }] },
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
    const a = defineAgent({ ...TEST_BEHAVIOR,
      slug: "Pa",
      primitives: ["INTERPRET"],
      input_types: [],
      output_types: ["good-input"],
      domain: "demo",
    });
    const b = defineAgent({ ...TEST_BEHAVIOR,
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
          { name: "p1", chairs: [{ role: "p1", agent_slug: "Pa", depends_on: [], input_contract: [], output_contract: ["good-input"], required_skills: [] }] },
          { name: "p2", chairs: [{ role: "p2", agent_slug: "Pb", depends_on: [], input_contract: [], output_contract: ["b-out"], required_skills: [] }] },
        ],
      }),
    ).toThrowError(/bogus-input/);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 5) APOHA — runtime garbage-through. If a mismatched-edge standard is built
  //    via direct struct (bypassing composeStandard), the runtime used to run it
  //    without diagnosing the empty-inputs case: silent garbage propagation, and
  //    the strongest bug-bash finding in this file. #245 closed it — the runtime
  //    now has a defense, and this pre-authorized RED trips to assert it.
  // ──────────────────────────────────────────────────────────────────────────
  it("APOHA: runtime REJECTS a broken standard whose consumer can never be given its declared input (#245)", async () => {
    const producer = defineAgent({ ...TEST_BEHAVIOR,
      slug: "RtProducer",
      primitives: ["INTERPRET"],
      input_types: [],
      output_types: ["rt-x"],
      domain: "demo",
    });
    const consumer = defineAgent({ ...TEST_BEHAVIOR,
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
        { name: "p1", chairs: [{ role: "p1", agent_slug: "RtProducer", depends_on: [], input_contract: [], output_contract: ["rt-x"], required_skills: [] }] },
        { name: "p2", chairs: [{ role: "p2", agent_slug: "RtConsumer", depends_on: [], input_contract: [], output_contract: ["rt-final"], required_skills: [] }] },
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

    // FLIPPED (#245): phase 2's agent declares it consumes `rt-y`; upstream only ever makes
    // `rt-x`. The runtime names the type it cannot supply instead of invoking on [].
    await expect(
      runGig(brokenStandard, {}, { outputs, ledger, invoke, model_version: "rt-bypass" }),
    ).rejects.toThrow(/rt-y/);

    // p1 legitimately ran (it declares no inputs); p2 never reached the model.
    expect(observedInputLengths, "only the entry chair is invoked").toEqual([0]);
    expect(outputs.all().length, "p1's output exists; p2 sealed nothing").toBe(1);
  }, 15_000);
});
