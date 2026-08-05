// #243 follow-on — the derived seal path was all-or-nothing for CONTRACT failures and not
// for SEAL failures.
//
// #243 moved the output_contract check ahead of the write loop, so a chair that promised two
// types and delivered one no longer sealed the one before throwing. But `write()` validates
// too — core agreement (#263), the registry schema, the substance floor (#227/#228) — and
// those gates still ran inside the loop. So a chair whose FIRST output was fine and whose
// SECOND was rejected had already flushed the first to `outputs/<gig_id>.jsonl`.
//
// Same failure by a different door: sealed records belonging to a gig that failed, which
// `output_query`, `output_trace` and `system_health.outputs` all surface, while the ledger
// has no row for the run that made them. Two audit surfaces disagreeing by construction is
// exactly what #243's write-ordering was meant to stop.
import { describe, it, expect } from "vitest";
import { runGig, RuntimeError } from "../src/runtime.js";
import {
  createRegistry,
  createOutputStore,
  MemoryLedger,
  type DomainType,
  type Agent,
  type Standard,
  type AgentInvoker,
} from "../src/index.js";
import { testAgent } from "./_support/agents.js";

const SIGNAL = { source: "fixture://demo" };
const JUDGMENT = { criteria: ["the fixture asserts one criterion"] };

const sigA: DomainType = {
  slug: "sig-a", extends: "Signal", domain: "demo",
  schema: { properties: { a: { type: "string" } } }, required_fields: ["a"],
};
const judgB: DomainType = {
  slug: "judg-b", extends: "Judgment", domain: "demo",
  schema: { properties: { b: { type: "string" } } }, required_fields: ["b"],
};

function store() {
  const registry = createRegistry();
  for (const t of [sigA, judgB]) registry.registerType(t);
  return { outputs: createOutputStore(registry), ledger: new MemoryLedger() };
}

const dual: Agent = testAgent({
  slug: "dual", primitives: ["SENSE", "JUDGE"], input_types: [],
  output_types: ["sig-a", "judg-b"], domain: "demo",
});

const standard: Standard = {
  slug: "two-out", domain: "demo", agents: [dual],
  phases: [{
    name: "p",
    chairs: [{
      role: "r", agent_slug: "dual", depends_on: [], input_contract: [],
      output_contract: ["sig-a", "judg-b"], required_skills: [],
    }],
  }],
};

describe("#243 follow-on — a seal rejection leaves nothing behind either", () => {
  // THE case. Both types ARRIVE, so the contract check passes and we reach the writes —
  // then the second is rejected by the substance floor. Before this fix, sig-a was already
  // durable at that point.
  it("seals nothing when a LATER output fails the substance floor", async () => {
    const { outputs, ledger } = store();
    const invoke: AgentInvoker = () => ({
      "sig-a": { a: "valid", ...SIGNAL },
      "judg-b": { b: "no criteria — Judgment floor unmet" },
    });
    await expect(runGig(standard, {}, { outputs, ledger, invoke })).rejects.toThrow(RuntimeError);
    expect(
      outputs.all().map((o) => o.domain_type),
      "sig-a passed every gate, but its chair did not — a record from a failed gig is an " +
        "orphan the ledger has no row for",
    ).toEqual([]);
  });

  it("seals nothing when a later output contradicts its declared core (#263)", async () => {
    const { outputs, ledger } = store();
    // judg-b is Judgment-cored; the agent's JUDGE primitive seals it as Judgment. Give it a
    // Verdict's substance instead and the floor for its real core is unmet.
    const invoke: AgentInvoker = () => ({
      "sig-a": { a: "valid", ...SIGNAL },
      "judg-b": { b: "x", checks: [{ method: "m", target_ref: "t", result: "pass" }] },
    });
    await expect(runGig(standard, {}, { outputs, ledger, invoke })).rejects.toThrow(RuntimeError);
    expect(outputs.all()).toEqual([]);
  });

  it("names the offending type and says nothing was written", async () => {
    const { outputs, ledger } = store();
    const invoke: AgentInvoker = () => ({
      "sig-a": { a: "valid", ...SIGNAL },
      "judg-b": { b: "floor unmet" },
    });
    let msg = "";
    try {
      await runGig(standard, {}, { outputs, ledger, invoke });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/judg-b/);
    expect(msg, "an operator must know the chair did not half-succeed").toMatch(/all-or-nothing/i);
  });

  // Positive control — this must not become "nothing ever seals".
  it("seals both when both are valid", async () => {
    const { outputs, ledger } = store();
    const invoke: AgentInvoker = () => ({
      "sig-a": { a: "valid", ...SIGNAL },
      "judg-b": { b: "valid", ...JUDGMENT },
    });
    const res = await runGig(standard, {}, { outputs, ledger, invoke });
    expect(res.status).toBe("complete");
    expect(outputs.all().map((o) => o.domain_type).sort()).toEqual(["judg-b", "sig-a"]);
  });
});
