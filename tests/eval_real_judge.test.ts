// #74 — scoreEval was a presence stub: it returned 1.0 for ANY produced output,
// ignoring the eval slug entirely. A green eval_score meant nothing. This makes
// it a real (deterministic) judge: resolve the eval by slug, require its on_type
// was produced, and check the declared non_empty_fields actually hold.
import { describe, it, expect } from "vitest";
import { runGig, createRegistry, createOutputStore, MemoryLedger, type DomainType, type AgentInvoker } from "../src";
import type { Standard, Agent } from "../src";
import type { EvalRecord } from "../src/loader.js";

const summary: DomainType = {
  slug: "summary", extends: "Interpretation", domain: "demo",
  schema: { type: "object", properties: { gist: { type: "string" } } }, required_fields: [],
};
const writer: Agent = { slug: "writer", primitives: ["INTERPRET"], input_types: [], output_types: ["summary"], domain: "demo" };
const standard: Standard = {
  slug: "eval-judge-test", domain: "demo", agents: [writer],
  phases: [{ name: "interpret", chairs: [{ role: "interpret", agent_slug: "writer", depends_on: [], input_contract: [], output_contract: ["summary"], required_skills: [] }] }],
  eval_slugs: ["gist-present"],
};
const evals = new Map<string, EvalRecord>([
  ["gist-present", { slug: "gist-present", domain: "demo", on_type: "summary", non_empty_fields: ["gist"] }],
]);

function setup() {
  const registry = createRegistry();
  registry.registerType(summary);
  return { registry, outputs: createOutputStore(registry), ledger: new MemoryLedger() };
}

describe("#74 — scoreEval is a real judge", () => {
  it("scores 1.0 when the eval's on_type is produced with the required field non-empty", async () => {
    const { outputs, ledger } = setup();
    const invoke: AgentInvoker = () => ({ gist: "a tight summary" });
    const res = await runGig(standard, {}, { outputs, ledger, invoke, evals });
    expect(res.eval_scores["gist-present"]).toBe(1.0);
  });

  it("scores 0.0 when the required field is empty (stub wrongly returned 1.0)", async () => {
    const { outputs, ledger } = setup();
    const invoke: AgentInvoker = () => ({ gist: "" }); // schema-valid but fails the eval
    const res = await runGig(standard, {}, { outputs, ledger, invoke, evals });
    expect(res.eval_scores["gist-present"]).toBe(0.0);
  });

  it("scores 0.0 for an unresolvable eval slug (stub wrongly returned 1.0)", async () => {
    const { outputs, ledger } = setup();
    const invoke: AgentInvoker = () => ({ gist: "anything" });
    const ghostStandard: Standard = { ...standard, eval_slugs: ["no-such-eval"] };
    const res = await runGig(ghostStandard, {}, { outputs, ledger, invoke, evals });
    expect(res.eval_scores["no-such-eval"]).toBe(0.0);
  });
});
