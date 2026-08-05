// #174 — a chair's output_contract must be the SELECTOR for what it seals, not just a check.
// #172 keyed sealing on agent.output_types, so any chair bound to a multi-output agent sealed
// the agent's ENTIRE output set regardless of the subset it promised — multi-capability agents
// over-produced off-role outputs at every seat. A chair that promises one type must seal exactly
// that one; a chair that promises both still seals both. (composeStandard requires a non-empty
// output_contract, so the "no contract → all agent outputs" fallback is the legacy hand-rolled
// path, asserted last via a Standard literal.)
import { describe, it, expect } from "vitest";
import { composeStandard, runGig, createRegistry, createOutputStore, MemoryLedger, type PhaseDef, type AgentInvoker, type DomainType, type Standard } from "../src";
import { testAgent } from "./_support/agents.js";

function setup() {
  const registry = createRegistry();
  const types: Record<string, DomainType> = {
    "type-a": { slug: "type-a", extends: "Signal", domain: "demo", schema: { properties: { alpha: { type: "string" } } }, required_fields: [] },
    "type-b": { slug: "type-b", extends: "Judgment", domain: "demo", schema: { properties: { beta: { type: "number" }, verdict: { type: "string" } } }, required_fields: [] },
  };
  for (const t of Object.values(types)) registry.registerType(t);
  return { outputs: createOutputStore(registry), ledger: new MemoryLedger() };
}
// the invoker returns a blob keyed by EVERY agent output type (the over-eager shape) — proving
// the runtime, not the invoker, is what narrows to the promised subset. Each value matches its
// own type's schema.
const dataFor = (t: string): Record<string, unknown> =>
  t === "type-a"
    ? { alpha: t, source: "fixture://demo/type-a" }
    : { beta: 1, verdict: t, criteria: ["fixture: the value is well-formed"] };
const invokeAll: AgentInvoker = (ctx) => Object.fromEntries(ctx.agent.output_types.map((t) => [t, dataFor(t)]));

describe("#174 — output_contract selects which of a multi-output agent's types a chair seals", () => {
  const dual = testAgent({ slug: "dual", primitives: ["SENSE", "JUDGE"], input_types: [], output_types: ["type-a", "type-b"] });

  it("a chair promising ONE type seals only that type (not the agent's whole set)", async () => {
    const std = composeStandard({
      slug: "sel-one", domain: "demo", agents: [dual],
      phases: [{ name: "p", chairs: [{ role: "r", agent_slug: "dual", depends_on: [], input_contract: [], output_contract: ["type-a"], required_skills: [] }] } as PhaseDef],
    });
    const { outputs, ledger } = setup();
    const r = await runGig(std, {}, { outputs, ledger, invoke: invokeAll });
    expect(r.outputs.map((o) => o.domain_type).sort()).toEqual(["type-a"]);
  });

  it("a chair promising BOTH types still seals both", async () => {
    const std = composeStandard({
      slug: "sel-both", domain: "demo", agents: [dual],
      phases: [{ name: "p", chairs: [{ role: "r", agent_slug: "dual", depends_on: [], input_contract: [], output_contract: ["type-a", "type-b"], required_skills: [] }] } as PhaseDef],
    });
    const { outputs, ledger } = setup();
    const r = await runGig(std, {}, { outputs, ledger, invoke: invokeAll });
    expect(r.outputs.map((o) => o.domain_type).sort()).toEqual(["type-a", "type-b"]);
  });

  it("the invocation context tells the model the chair's promised types (prompt selects too)", async () => {
    const std = composeStandard({
      slug: "sel-ctx", domain: "demo", agents: [dual],
      phases: [{ name: "p", chairs: [{ role: "r", agent_slug: "dual", depends_on: [], input_contract: [], output_contract: ["type-b"], required_skills: [] }] } as PhaseDef],
    });
    const { outputs, ledger } = setup();
    let seen: readonly string[] | undefined;
    const invoke: AgentInvoker = (ctx) => {
      seen = ctx.output_types;
      return { beta: 2, verdict: "b", criteria: ["fixture: the value is well-formed"] };
    };
    const r = await runGig(std, {}, { outputs, ledger, invoke });
    expect(seen, "ctx.output_types must carry the chair's promised subset").toEqual(["type-b"]);
    expect(r.outputs.map((o) => o.domain_type)).toEqual(["type-b"]);
  });

  it("legacy: a hand-rolled chair with an empty output_contract falls back to all agent outputs", async () => {
    // bypass composeStandard (which requires a non-empty contract) to exercise the fallback path
    const literal: Standard = {
      slug: "sel-legacy", domain: "demo", agents: [dual],
      phases: [{ name: "p", chairs: [{ role: "r", agent_slug: "dual", depends_on: [], input_contract: [], output_contract: [], required_skills: [] }] }],
      eval_slugs: [],
    } as unknown as Standard;
    const { outputs, ledger } = setup();
    const r = await runGig(literal, {}, { outputs, ledger, invoke: invokeAll });
    expect(r.outputs.map((o) => o.domain_type).sort()).toEqual(["type-a", "type-b"]);
  });
});
