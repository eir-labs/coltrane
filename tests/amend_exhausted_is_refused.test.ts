// DS-7 — drafting:an-exhausted-ladder-is-refused (wiki spec.chancery.the-testable-charter.drafting-standard rev 3).
//
// "After the third failure the gig ends refused, naming the last verdict" was prose with no law, and a driven gig
// (5f7c2f45, DR-4) ended `completed` with its last change-verdict pass: false: the amend loop leaves the failing verdict
// standing and nothing maps an exhausted ladder to a terminal refusal. A standard that declares
// `refuse_when_unresolved: true` now ends refused when its amend rounds run out with a verdict still failing, or when a
// gate stops the loop, naming the verdict's chair. The failing verdict stays sealed. A standard that does not declare it
// keeps today's behaviour.
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import {
  composeStandard, runGig, createRegistry, createOutputStore, MemoryLedger,
  type AgentInvoker, type DomainType, type PhaseDef, type Chair,
} from "../src/index.js";
import { loadGenome } from "../src/loader.js";
import { testAgent } from "./_support/agents.js";
import { coreInvariantFields } from "./_support/specs.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const chair = (role: string, agent_slug: string, opts: Partial<Chair> = {}): Chair =>
  ({ role, agent_slug, depends_on: [], input_contract: [], output_contract: [], required_skills: [], ...opts });

function world() {
  const registry = createRegistry();
  registry.registerType({ slug: "plan-in", extends: "Plan", domain: "test", schema: { properties: { p: { type: "string" } } }, required_fields: [] } as DomainType);
  registry.registerType({ slug: "artifact", extends: "Artifact", domain: "test", schema: { properties: { a: { type: "string" } } }, required_fields: [] } as DomainType);
  registry.registerType({ slug: "verdict", extends: "Verdict", domain: "test", schema: { properties: { v: { type: "string" } } }, required_fields: [] } as DomainType);
  return { outputs: createOutputStore(registry), ledger: new MemoryLedger() };
}

const std = (refuse: boolean | undefined) => composeStandard({
  slug: "exhausted", domain: "test", max_examine_rounds: 2,
  ...(refuse === undefined ? {} : { refuse_when_unresolved: refuse }),
  agents: [
    testAgent({ slug: "planner", primitives: ["PLAN"], input_types: [], output_types: ["plan-in"], model_tier: "economy" }),
    testAgent({ slug: "maker", primitives: ["CREATE"], input_types: ["plan-in"], output_types: ["artifact"], model_tier: "economy" }),
    testAgent({ slug: "reviewer", primitives: ["VERIFY"], input_types: ["artifact"], output_types: ["verdict"], model_tier: "standard" }),
  ],
  phases: [
    { name: "plan", chairs: [chair("plan", "planner", { output_contract: ["plan-in"] })] },
    { name: "make", chairs: [chair("make", "maker", { depends_on: ["plan"], input_contract: ["plan-in"], output_contract: ["artifact"] })] },
    { name: "review", chairs: [chair("review", "reviewer", { depends_on: ["make"], input_contract: ["artifact"], output_contract: ["verdict"] })] },
  ] as PhaseDef[],
} as never);

function invoker(reviews: boolean[]): AgentInvoker {
  let looks = 0;
  return (ctx) => {
    if (ctx.agent.slug === "planner") return { ...coreInvariantFields("Plan"), p: "plan" };
    if (ctx.agent.slug === "maker") return { ...coreInvariantFields("Artifact"), a: "draft" };
    const ok = reviews[looks++] ?? true;
    return ok ? { ...coreInvariantFields("Verdict"), pass: true } : { ...coreInvariantFields("Verdict"), pass: false, checks: [{ method: "a plant is missing", target_ref: "law/x", result: "fails" }] };
  };
}

async function run(refuse: boolean | undefined, reviews: boolean[]) {
  const w = world();
  let err: unknown, res: Awaited<ReturnType<typeof runGig>> | undefined;
  try { res = await runGig(std(refuse), {}, { outputs: w.outputs, ledger: w.ledger, invoke: invoker(reviews) } as never); } catch (e) { err = e; }
  return { err, res, sealed: w.outputs };
}

describe("DS-7 — an exhausted amend ladder ends refused, naming the last verdict", () => {
  it("plant — three failing reviews (one round + two amends) with refuse_when_unresolved: the gig ends refused, naming the review chair", async () => {
    const { err, res } = await run(true, [false, false, false]);
    expect(res, "the gig ended completed with its last verdict failing: a green over nothing").toBeUndefined();
    expect(String((err as Error)?.message ?? err)).toMatch(/refused.*"review".*fail/s);
  });

  it("twin, must be ALLOWED — a pass that amends to green on round two ends completed", async () => {
    const { err, res } = await run(true, [false, true]);
    expect(err, String(err)).toBeUndefined();
    expect(res?.outputs.filter((o) => o.domain_type === "verdict").at(-1)!.data["pass"]).toBe(true);
  });

  it("control — a standard that does not declare refuse_when_unresolved keeps today's behaviour: completed, the failing verdict sealed", async () => {
    const { err, res } = await run(undefined, [false, false, false]);
    expect(err, String(err)).toBeUndefined();
    expect(res?.outputs.filter((o) => o.domain_type === "verdict").at(-1)!.data["pass"]).toBe(false);
  });

  it("chancery-red-drafting-v0 declares refuse_when_unresolved", () => {
    const g = loadGenome(ROOT);
    const s = g.standards.get("chancery-red-drafting-v0") ?? g.draft_standards.get("chancery-red-drafting-v0");
    expect((s as { refuse_when_unresolved?: boolean } | undefined)?.refuse_when_unresolved).toBe(true);
  });
});
