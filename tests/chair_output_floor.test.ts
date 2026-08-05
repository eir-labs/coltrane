// #243, enforcement half — the output_contract becomes a FLOOR, not just a selector.
//
// The recording half already landed: a chair that promises two types and seals one gets
// `missing_output_types` on its chair_complete event and a row in the gig manifest's
// `unfulfilled_outputs`. That made the shortfall visible. It did not make it fail.
//
// Why visible was not enough. `composeStandard` treats `output_contract` as a hard promise
// (it rejects an empty one) and validates downstream `input_contract` against it. The
// runtime guard was `written.length === 0`, not `written.length === output_specs.length`.
// The in-code justification — a downstream input_contract check fails loudly if a consumer
// actually needed the missing type — holds ONLY WHERE A CONSUMER EXISTS. For a TERMINAL
// chair (the gate phase, the one that emits the verdict) nothing consumes it, so the
// promise evaporates into `status: "complete"`. That is the whole defect: the one chair
// whose output the operator actually acts on is the one with no backstop.
//
// THE DESIGN DECISION (this is a reversal of a documented one, so it is stated plainly).
// The previous decision was "record, do not enforce", because conditional outputs are real
// and intentional — `standards/patent-triage-v0.json`'s judge promises
// ["triage-verdict", "provisional-draft"] and emits the draft only when the verdict is
// FILEABLE — and `Chair` had no way to say "this one may be absent". So enforcement would
// have broken a legitimate standard.
//
// The fix is to give it that way to say so, and then enforce. `optional_outputs` is
// DENY-BY-DEFAULT: a promised type is required unless the chair declares it optional. That
// direction is deliberate. Opt-in enforcement would leave every existing silent
// under-producer silent, which is the bug. Opt-out enforcement makes the conditional case
// state itself in the genome, where a reader and an auditor can both see it — a conditional
// output nobody declared is indistinguishable from a chair that simply failed to deliver.
import { describe, it, expect } from "vitest";
import { runGig, RuntimeError } from "../src/runtime.js";
import { composeStandard } from "../src/composition.js";
import { createRegistry, createOutputStore, MemoryLedger, type DomainType, type Agent, type Standard, type PhaseDef, type AgentInvoker } from "../src/index.js";
import { testAgent } from "./_support/agents.js";

const SIGNAL = { source: "fixture://demo" };
const JUDGMENT = { criteria: ["the fixture asserts one criterion"] };

const sigA: DomainType = { slug: "sig-a", extends: "Signal", domain: "demo", schema: { properties: { a: { type: "string" } } }, required_fields: ["a"] };
const judgB: DomainType = { slug: "judg-b", extends: "Judgment", domain: "demo", schema: { properties: { b: { type: "string" } } }, required_fields: ["b"] };

function store() {
  const registry = createRegistry();
  for (const t of [sigA, judgB]) registry.registerType(t);
  return { outputs: createOutputStore(registry), ledger: new MemoryLedger() };
}

const dual: Agent = testAgent({
  slug: "dual", primitives: ["SENSE", "JUDGE"], input_types: [],
  output_types: ["sig-a", "judg-b"], domain: "demo",
});

/** A single terminal chair promising both types. `optional` declares which may be absent. */
function standard(optional?: string[]): Standard {
  return {
    slug: "under-deliver", domain: "demo", agents: [dual],
    phases: [{
      name: "p",
      chairs: [{
        role: "r", agent_slug: "dual", depends_on: [], input_contract: [],
        output_contract: ["sig-a", "judg-b"], required_skills: [],
        ...(optional ? { optional_outputs: optional } : {}),
      }],
    }],
  };
}

/** Honours only half the promise — seals sig-a, never judg-b. */
const halfInvoker: AgentInvoker = () => ({ "sig-a": { a: "made it", ...SIGNAL } });

describe("#243 — an undeclared missing output fails the run", () => {
  // THE case, and specifically at a TERMINAL chair, where nothing downstream can catch it.
  it("a terminal chair that silently drops a promised type does not complete", async () => {
    const { outputs, ledger } = store();
    await expect(
      runGig(standard(), {}, { outputs, ledger, invoke: halfInvoker }),
    ).rejects.toThrow(RuntimeError);
  });

  it("the error names the chair and the type it owed", async () => {
    const { outputs, ledger } = store();
    let msg = "";
    try {
      await runGig(standard(), {}, { outputs, ledger, invoke: halfInvoker });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/judg-b/);
    expect(msg, "name the chair, or an operator cannot find it in a multi-chair phase").toMatch(/"r"/);
    expect(msg, "say how to legitimise it, or the only discoverable fix is to delete the promise").toMatch(/optional_outputs/);
  });

  // The conditional case that made blanket enforcement wrong — now legal BECAUSE DECLARED.
  it("a declared-optional type may be absent, and the run completes", async () => {
    const { outputs, ledger } = store();
    const res = await runGig(standard(["judg-b"]), {}, { outputs, ledger, invoke: halfInvoker });
    expect(res.status).toBe("complete");
    expect(res.outputs.map((o) => o.domain_type)).toEqual(["sig-a"]);
  });

  // Visibility must SURVIVE the change. Legitimising a shortfall is not the same as hiding
  // it: a declared-optional type that did not arrive is still a fact about this run, and
  // dropping it from the manifest to make the green test greener would trade one silence
  // for another.
  it("a declared-optional absence is still recorded in the manifest", async () => {
    const { outputs, ledger } = store();
    const res = await runGig(standard(["judg-b"]), {}, { outputs, ledger, invoke: halfInvoker });
    expect(
      (res as unknown as Record<string, unknown>)["unfulfilled_outputs"],
      "optional means 'allowed to be absent', not 'not worth mentioning'",
    ).toEqual([{ role: "r", phase: "p", missing: ["judg-b"] }]);
  });

  // Positive control — a chair that delivers everything must be untouched.
  it("a chair that delivers its whole contract completes with no shortfall", async () => {
    const { outputs, ledger } = store();
    const full: AgentInvoker = () => ({ "sig-a": { a: "x", ...SIGNAL }, "judg-b": { b: "y", ...JUDGMENT } });
    const res = await runGig(standard(), {}, { outputs, ledger, invoke: full });
    expect(res.status).toBe("complete");
    expect((res as unknown as Record<string, unknown>)["unfulfilled_outputs"]).toBeUndefined();
  });

  // The pre-existing `written.length === 0` guard must keep its own error. Producing
  // NOTHING is a different failure from producing SOME, and collapsing them would lose
  // the distinction between "the invoker returned junk" and "one type was dropped".
  it("a chair that produces nothing still fails with the no-recognized-output error", async () => {
    const { outputs, ledger } = store();
    let msg = "";
    try {
      await runGig(standard(), {}, { outputs, ledger, invoke: () => ({}) });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/produced no recognized output/);
  });
});

// ── Round 2. Adversarial review found the floor correct where it fired, and three places
// where it did not fire, could not be expressed, or fired too late. ────────────────────────
describe("#243 — a failed chair leaves nothing sealed", () => {
  // The floor check originally ran AFTER the write loop, so a chair delivering part of its
  // contract sealed those records, persisted them, and only then threw. The gig failed with
  // no ledger row while its partial outputs survived — visible to output_query, output_trace
  // and system_health.outputs. That is a NEW failure class the old `written.length === 0`
  // guard could not create, because it had nothing to orphan.
  it("seals no output at all when a required type is missing", async () => {
    const { outputs, ledger } = store();
    await expect(runGig(standard(), {}, { outputs, ledger, invoke: halfInvoker })).rejects.toThrow(RuntimeError);
    expect(
      outputs.all().map((o) => o.domain_type),
      "sig-a arrived and was valid — but its chair did not satisfy the contract, so it must not " +
        "persist. A sealed record with no ledger row is an orphan the audit surfaces disagree about.",
    ).toEqual([]);
  });

  it("writes nothing when the failure is a later slice's shape, not the contract", async () => {
    const { outputs, ledger } = store();
    const bad: AgentInvoker = () => ({ "sig-a": { a: "ok", ...SIGNAL }, "judg-b": "not-an-object" });
    await expect(runGig(standard(), {}, { outputs, ledger, invoke: bad })).rejects.toThrow(/must be a JSON object/);
    expect(outputs.all(), "every throwing check runs before the first write, not among them").toEqual([]);
  });
});

describe("#243 — an all-optional chair may legitimately seal nothing", () => {
  // `written.length === 0` fired ABOVE the floor check, so a chair whose every promised type
  // was optional still died on "produced no recognized output" — which made optional_outputs
  // a no-op for exactly the shape that needs it most. patent-triage-v1's `draft` chair is
  // single-output and its intent reads "Only on a FILEABLE verdict … On any other verdict,
  // nothing." Declaring it optional has to actually work.
  it("completes when every promised type is optional and none arrived", async () => {
    const { outputs, ledger } = store();
    const res = await runGig(standard(["sig-a", "judg-b"]), {}, { outputs, ledger, invoke: () => ({}) });
    expect(res.status).toBe("complete");
    expect(res.outputs).toEqual([]);
  });

  it("still fails when NOTHING arrived and something was required", async () => {
    const { outputs, ledger } = store();
    await expect(
      runGig(standard(["judg-b"]), {}, { outputs, ledger, invoke: () => ({}) }),
    ).rejects.toThrow(/produced no recognized output/);
  });
});

describe("#243 — a skill-backed chair cannot promise what it structurally cannot seal", () => {
  // `prepareChair` takes `output_contract[0]` and discards the rest, and the floor is computed
  // over the one spec it built — so entries 2..N could never be reported missing and the throw
  // could never fire. The floor was silently inoperative for this whole chair kind.
  it("rejects a multi-output skill chair at compose time", () => {
    expect(() =>
      composeStandard({
        slug: "skillmulti", domain: "demo", agents: [dual],
        phases: [{
          name: "p",
          chairs: [{
            role: "r", agent_slug: "", skill_slug: "some-skill", depends_on: [], input_contract: [],
            output_contract: ["sig-a", "judg-b"], required_skills: [],
          }],
        } as unknown as PhaseDef],
      }),
    ).toThrow(/seals exactly one/);
  });

  it("still accepts a single-output skill chair", () => {
    expect(() =>
      composeStandard({
        slug: "skillone", domain: "demo", agents: [dual],
        phases: [{
          name: "p",
          chairs: [{
            role: "r", agent_slug: "", skill_slug: "some-skill", depends_on: [], input_contract: [],
            output_contract: ["sig-a"], required_skills: [],
          }],
        } as unknown as PhaseDef],
      }),
    ).not.toThrow();
  });
});

describe("#243 — optional_outputs is validated at compose time", () => {
  // A typo here silently WIDENS the floor — the exact class of bug this whole change
  // exists to close. It has to be caught where the genome is authored, not at 3am in a run.
  it("rejects an optional_outputs entry that is not in the output_contract", () => {
    expect(() =>
      composeStandard({
        slug: "typo", domain: "demo", agents: [dual],
        phases: [{
          name: "p",
          chairs: [{
            role: "r", agent_slug: "dual", depends_on: [], input_contract: [],
            output_contract: ["sig-a", "judg-b"], required_skills: [],
            optional_outputs: ["judg-typo"],
          }],
        } as unknown as PhaseDef],
      }),
    ).toThrow(/judg-typo/);
  });

  it("accepts an optional_outputs entry that IS in the output_contract", () => {
    expect(() =>
      composeStandard({
        slug: "ok", domain: "demo", agents: [dual],
        phases: [{
          name: "p",
          chairs: [{
            role: "r", agent_slug: "dual", depends_on: [], input_contract: [],
            output_contract: ["sig-a", "judg-b"], required_skills: [],
            optional_outputs: ["judg-b"],
          }],
        } as unknown as PhaseDef],
      }),
    ).not.toThrow();
  });
});
