// T-cycle e2e — adversarial unique-unknown: a standard whose agents form a CYCLE
// (A consumes B's output, B consumes A's output). Two surfaces under test:
//
//   1) src/composition.ts composeStandard — should REJECT cycles with CompositionError
//      (composition.ts ships an A↔B 2-hop pairwise check; this test fingerprints the
//      detector and also probes a 3-cycle A→B→C→A which the 2-hop check does NOT catch).
//
//   2) src/runtime.ts runGig — must NEVER infinite-loop on a cycle-shaped standard.
//      runtime walks phases linearly (one pass over standard.phases), so terminating
//      is structural — but we assert it via a hard wall-clock budget AND an invocation
//      counter, so a future loop-style scheduler would trip this test.
//
// Honest about scope: this test is a fingerprint of TODAY's composer behavior. The 3-hop
// cycle case (A→B→C→A) where composition lets it through is itself the adversarial signal —
// we record both outcomes (rejected | accepted) so the test passes regardless, but logs the
// gap. That is the apoha: name what the detector does NOT cover.
//
// Pattern lifted from coltrane_lifecycle.spec.ts (sequential it() blocks, shared tempdir
// is unnecessary here — these are pure composition+runtime calls, no genome on disk).

import { describe, expect, it } from "vitest";

import {
  CompositionError,
  MemoryLedger,
  composeStandard,
  createOutputStore,
  createRegistry,
  defineAgent,
  runGig,
  type Agent,
  type AgentInvoker,
  type Standard,
} from "../../src/index.js";

// ────────────────────────────────────────────────────────────────────────────
// Test fixture: register two domain types, define two agents whose I/O wires
// cycle (A: B-out → A-out; B: A-out → B-out). composeStandard is the gate.
// ────────────────────────────────────────────────────────────────────────────

function buildCyclicAgents(): { a: Agent; b: Agent } {
  // A: INTERPRET, consumes "b-out", produces "a-out"
  const a = defineAgent({
    slug: "A",
    primitives: ["INTERPRET"],
    input_types: ["b-out"],
    output_types: ["a-out"],
    domain: "demo",
  });
  // B: INTERPRET, consumes "a-out", produces "b-out"  ← closes the cycle
  const b = defineAgent({
    slug: "B",
    primitives: ["INTERPRET"],
    input_types: ["a-out"],
    output_types: ["b-out"],
    domain: "demo",
  });
  return { a, b };
}

describe("standard with cycle (adversarial unique-unknown)", () => {
  // ──────────────────────────────────────────────────────────────────────────
  // 1) Composer SHOULD reject a 2-agent cycle A↔B at composeStandard time.
  // ──────────────────────────────────────────────────────────────────────────
  it("composeStandard rejects a 2-agent cycle (A↔B) with CompositionError", () => {
    const { a, b } = buildCyclicAgents();

    expect(() =>
      composeStandard({
        slug: "cyclic-2",
        domain: "demo",
        agents: [a, b],
        phases: [
          { name: "phaseA", agent: "A" },
          { name: "phaseB", agent: "B" },
        ],
      }),
    ).toThrowError(CompositionError);

    // Fingerprint the error message so a future composer that loses the cycle check
    // (silent regression) goes RED rather than silently green.
    try {
      composeStandard({
        slug: "cyclic-2-msg",
        domain: "demo",
        agents: [a, b],
        phases: [
          { name: "phaseA", agent: "A" },
          { name: "phaseB", agent: "B" },
        ],
      });
      // unreachable
      expect.fail("expected CompositionError but composeStandard returned");
    } catch (e) {
      expect(e).toBeInstanceOf(CompositionError);
      expect((e as Error).message).toMatch(/cycle/i);
      // names both endpoints of the cycle in the message
      expect((e as Error).message).toMatch(/A/);
      expect((e as Error).message).toMatch(/B/);
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 2) The composer's 2-hop pairwise detector does NOT catch a 3-agent cycle
  //    A→B→C→A. We probe it honestly: if rejected, great. If accepted, we record
  //    the gap by exercising runGig against the accepted standard and proving it
  //    terminates anyway (linear phase walk). Either outcome is informative.
  // ──────────────────────────────────────────────────────────────────────────
  it("composeStandard 3-agent cycle (A→B→C→A): rejection OR runtime-safe acceptance, no infinite loop", async () => {
    const a = defineAgent({
      slug: "A3",
      primitives: ["INTERPRET"],
      input_types: ["c-out"], // consumes C
      output_types: ["a3-out"],
      domain: "demo",
    });
    const b = defineAgent({
      slug: "B3",
      primitives: ["INTERPRET"],
      input_types: ["a3-out"], // consumes A
      output_types: ["b3-out"],
      domain: "demo",
    });
    const c = defineAgent({
      slug: "C3",
      primitives: ["INTERPRET"],
      input_types: ["b3-out"], // consumes B   (cycle: A→B→C→A)
      output_types: ["c-out"],
      domain: "demo",
    });

    let composed: Standard | null = null;
    let composeErr: Error | null = null;
    try {
      composed = composeStandard({
        slug: "cyclic-3",
        domain: "demo",
        agents: [a, b, c],
        phases: [
          { name: "phaseA", agent: "A3" },
          { name: "phaseB", agent: "B3" },
          { name: "phaseC", agent: "C3" },
        ],
      });
    } catch (e) {
      composeErr = e as Error;
    }

    if (composeErr) {
      // Strong outcome: composer catches the 3-cycle too.
      expect(composeErr).toBeInstanceOf(CompositionError);
      expect(composeErr.message).toMatch(/cycle/i);
      return;
    }

    // Honest gap: composer accepted the 3-cycle (2-hop pairwise check misses A→B→C→A).
    // This is a known apoha of today's detector. We now verify the runtime does not
    // infinite-loop on the accepted-but-cyclic standard.
    expect(composed).not.toBeNull();

    // Type fixtures the runtime store needs to validate writes. Each type has a
    // distinct required field so registry's reuse enforcement (score >= 80) does
    // not block the second registration.
    const registry = createRegistry();
    const typeFields: Record<string, string> = { "a3-out": "va", "b3-out": "vb", "c-out": "vc" };
    for (const [slug, field] of Object.entries(typeFields)) {
      registry.registerType({
        slug,
        extends: "Interpretation",
        domain: "demo",
        schema: { type: "object", properties: { [field]: { type: "string" } } },
        required_fields: [field],
      });
    }
    const outputs = createOutputStore(registry);
    const ledger = new MemoryLedger();

    // Track invocation count so an out-of-control loop trips a clean assertion
    // rather than a vitest test-timeout.
    let invocations = 0;
    const MAX = 50; // standard has 3 phases; anything beyond this is pathological
    const invoke: AgentInvoker = ({ agent }) => {
      invocations += 1;
      if (invocations > MAX) {
        throw new Error(`runGig exceeded ${MAX} invocations on cyclic standard (agent=${agent.slug})`);
      }
      // Each agent's output_type has its own required field.
      const outType = agent.output_types[0]!;
      const field = typeFields[outType]!;
      return { [field]: `value-from-${agent.slug}` };
    };

    const start = Date.now();
    const result = await runGig(composed!, { source: "stdin" }, {
      outputs,
      ledger,
      invoke,
      model_version: "cycle-test",
    });
    const elapsedMs = Date.now() - start;

    // Termination guarantees:
    expect(result.status).toBe("complete");
    expect(invocations).toBe(3); // exactly one call per declared phase, no re-entry
    expect(elapsedMs).toBeLessThan(10_000); // hard wall clock — 10s is generous
    expect(result.outputs.length).toBe(3);
    expect(result.outputs.map((o) => o.domain_type).sort()).toEqual(["a3-out", "b3-out", "c-out"]);
  }, 30_000);

  // ──────────────────────────────────────────────────────────────────────────
  // 3) Self-cycle (A consumes own output). Composer's pairwise check needs to
  //    handle the same-agent edge case. Either reject OR runtime-safe accept.
  // ──────────────────────────────────────────────────────────────────────────
  it("composeStandard self-cycle (A consumes own output): rejection OR runtime termination", async () => {
    const a = defineAgent({
      slug: "Aself",
      primitives: ["INTERPRET"],
      input_types: ["aself-out"], // consumes own output type
      output_types: ["aself-out"],
      domain: "demo",
    });

    let composed: Standard | null = null;
    let composeErr: Error | null = null;
    try {
      composed = composeStandard({
        slug: "self-cycle",
        domain: "demo",
        agents: [a],
        phases: [{ name: "phaseA", agent: "Aself" }],
      });
    } catch (e) {
      composeErr = e as Error;
    }

    if (composeErr) {
      expect(composeErr).toBeInstanceOf(CompositionError);
      return;
    }

    // Composer accepted — runtime must still terminate on a 1-phase walk.
    const registry = createRegistry();
    registry.registerType({
      slug: "aself-out",
      extends: "Interpretation",
      domain: "demo",
      schema: { type: "object", properties: { v: { type: "string" } } },
      required_fields: ["v"],
    });
    const outputs = createOutputStore(registry);
    const ledger = new MemoryLedger();

    let invocations = 0;
    const invoke: AgentInvoker = () => {
      invocations += 1;
      if (invocations > 10) throw new Error("self-cycle runtime looped");
      return { v: "self" };
    };

    const start = Date.now();
    const result = await runGig(composed!, {}, { outputs, ledger, invoke, model_version: "cycle-test" });
    const elapsedMs = Date.now() - start;

    expect(result.status).toBe("complete");
    expect(invocations).toBe(1);
    expect(elapsedMs).toBeLessThan(5_000);
  }, 15_000);
});
