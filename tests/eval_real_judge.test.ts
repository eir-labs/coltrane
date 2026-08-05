// #74 — scoreEval was a presence stub: it returned 1.0 for ANY produced output,
// ignoring the eval slug entirely. A green eval_score meant nothing. This makes
// it a real (deterministic) judge: resolve the eval by slug, require its on_type
// was produced, and check the declared non_empty_fields actually hold.
import { describe, it, expect } from "vitest";
import { TEST_BEHAVIOR } from "./_support/agents.js";
import { runGig, createRegistry, createOutputStore, MemoryLedger, type DomainType, type AgentInvoker } from "../src";
import type { Standard, Agent } from "../src";
import type { EvalRecord } from "../src/loader.js";

const summary: DomainType = {
  slug: "summary", extends: "Interpretation", domain: "demo",
  schema: { type: "object", properties: { gist: { type: "string" } } }, required_fields: [],
};
const writer: Agent = { ...TEST_BEHAVIOR, slug: "writer", primitives: ["INTERPRET"], input_types: [], output_types: ["summary"], domain: "demo" };
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
    const invoke: AgentInvoker = () => ({ gist: "a tight summary", claims: ["the note is about X"] });
    const res = await runGig(standard, {}, { outputs, ledger, invoke, evals });
    expect(res.eval_scores["gist-present"]).toBe(1.0);
  });

  it("scores 0.0 when the required field is empty (stub wrongly returned 1.0)", async () => {
    const { outputs, ledger } = setup();
    const invoke: AgentInvoker = () => ({ gist: "", claims: ["the note is about X"] }); // schema-valid but fails the eval
    const res = await runGig(standard, {}, { outputs, ledger, invoke, evals });
    expect(res.eval_scores["gist-present"]).toBe(0.0);
  });

  // REWRITTEN for #246. The original assertion — "scores 0.0 for an unresolvable eval slug" —
  // pinned the CONFLATION as correct: a typo'd/dangling slug produced a score byte-identical
  // to a real eval that ran and failed, and that fake 0.0 was then baked into run_fingerprint
  // as though a contract had been evaluated and found wanting. 0.0 is still the back-compat
  // score (callers key off presence), but it is no longer the ONLY thing recorded: the slug is
  // named in `unresolved_evals`, and the fingerprint no longer collides with a real judgement.
  it("names an unresolvable eval slug instead of silently scoring it as a failure (#246)", async () => {
    const { outputs, ledger } = setup();
    const invoke: AgentInvoker = () => ({ gist: "anything", claims: ["the note is about X"] });
    const ghostStandard: Standard = { ...standard, eval_slugs: ["no-such-eval"] };
    const res = await runGig(ghostStandard, {}, { outputs, ledger, invoke, evals });

    // back-compat: the declared slug still appears, still at 0.0 (can't attest an undefined contract)
    expect(res.eval_scores["no-such-eval"]).toBe(0.0);
    // the fix: "0.0" alone is not an answer — the run says WHY it is 0.0
    expect(
      (res as unknown as { unresolved_evals?: string[] }).unresolved_evals,
      "a dangling eval slug is a definition error, not a judgement",
    ).toEqual(["no-such-eval"]);
  });

  it("a genuinely-failing eval reports nothing unresolved (#246 — the two are distinguishable)", async () => {
    const { outputs, ledger } = setup();
    const res = await runGig(standard, {}, { outputs, ledger, invoke: () => ({ gist: "", claims: ["the note is about X"] }), evals });
    expect(res.eval_scores["gist-present"]).toBe(0.0);
    expect(
      (res as unknown as { unresolved_evals?: string[] }).unresolved_evals,
      "this eval WAS evaluated — it just did not hold",
    ).toBeUndefined();
  });
});
