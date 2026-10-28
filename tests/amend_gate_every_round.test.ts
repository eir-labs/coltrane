// THE GATE ON EVERY ROUND — Vör's HOLD on #596 at 81300e3: "the amend loop skips the scope gate".
//
// A verify chair (the reviewer) may depend on a GATE as well as on the maker: a chair that judges the
// maker's artifact before the reviewer does (chancery-red-drafting-v0: draft → scope → review, the scope
// chair a skill). The amend loop re-ran only the maker and the reviewer, so a round-two artifact was never
// gated: an amended diff that left the scope landed one round after round one's diff was checked.
//
// The cure (Vör): "the scope gate runs on every round's diff, before the reviewer, not only on round one."
// So an amend round re-runs every chair the reviewer depends on that judges what was just amended (a gate),
// after the makers and before the reviewer. A gate that fails stops the loop there: the reviewer never sees
// the gated artifact, the reviewer's last failing verdict stands, and `amend_gated` names the gate.
import { describe, it, expect } from "vitest";
import {
  composeStandard, runGig, createRegistry, createOutputStore, MemoryLedger,
  type AgentInvoker, type DomainType, type PhaseDef, type Chair, type GigProgressEvent,
} from "../src/index.js";
import { testAgent } from "./_support/agents.js";
import { coreInvariantFields } from "./_support/specs.js";

const chair = (role: string, agent_slug: string, opts: Partial<Chair> = {}): Chair =>
  ({ role, agent_slug, depends_on: [], input_contract: [], output_contract: [], required_skills: [], ...opts });

function world() {
  const registry = createRegistry();
  registry.registerType({ slug: "plan-in", extends: "Plan", domain: "test", schema: { properties: { p: { type: "string" } } }, required_fields: [] } as DomainType);
  registry.registerType({ slug: "artifact", extends: "Artifact", domain: "test", schema: { properties: { a: { type: "string" } } }, required_fields: [] } as DomainType);
  registry.registerType({ slug: "verdict", extends: "Verdict", domain: "test", schema: { properties: { v: { type: "string" } } }, required_fields: [] } as DomainType);
  registry.registerType({ slug: "gate-verdict", extends: "Verdict", domain: "test-gate", schema: { properties: { scope_files: { type: "array" }, refused_ids: { type: "array" }, baseline_commit: { type: "string" } } }, required_fields: ["refused_ids"] } as DomainType);
  return { registry, outputs: createOutputStore(registry), ledger: new MemoryLedger() };
}

const std = (rounds: number) => composeStandard({
  slug: "gate-every-round", domain: "test", max_examine_rounds: rounds,
  agents: [
    testAgent({ slug: "planner", primitives: ["PLAN"], input_types: [], output_types: ["plan-in"], model_tier: "economy" }),
    testAgent({ slug: "maker", primitives: ["CREATE"], input_types: ["plan-in"], output_types: ["artifact"], model_tier: "economy" }),
    testAgent({ slug: "gatekeeper", primitives: ["VERIFY"], input_types: ["artifact"], output_types: ["gate-verdict"], model_tier: "economy" }),
    testAgent({ slug: "reviewer", primitives: ["VERIFY"], input_types: ["artifact", "gate-verdict"], output_types: ["verdict"], model_tier: "standard" }),
  ],
  phases: [
    { name: "plan", chairs: [chair("plan", "planner", { output_contract: ["plan-in"] })] },
    { name: "make", chairs: [chair("make", "maker", { depends_on: ["plan"], input_contract: ["plan-in"], output_contract: ["artifact"] })] },
    { name: "gate", chairs: [chair("gate", "gatekeeper", { depends_on: ["make"], input_contract: ["artifact"], output_contract: ["gate-verdict"] })] },
    { name: "review", chairs: [chair("review", "reviewer", { depends_on: ["make", "gate"], input_contract: ["artifact", "gate-verdict"], output_contract: ["verdict"] })] },
  ] as PhaseDef[],
});

const FAIL = (method: string) => ({ pass: false, checks: [{ method, target_ref: "law/x", result: "fails" }] });

/** gate(n) is the gate's answer on the n-th draft (1-based); reviews[i] the reviewer's i-th answer (pass once they run out). */
function band(gate: (draft: number) => boolean | "silent" | "throw", reviews: boolean[]) {
  const order: string[] = [];
  let drafts = 0, looks = 0;
  const invoke: AgentInvoker = (ctx) => {
    if (ctx.agent.slug === "planner") return { ...coreInvariantFields("Plan"), p: "plan" };
    order.push(ctx.agent.slug);
    if (ctx.agent.slug === "maker") { drafts++; return { ...coreInvariantFields("Artifact"), a: `draft ${drafts}` }; }
    if (ctx.agent.slug === "gatekeeper") {
      const g = gate(drafts);
      if (g === "throw") throw new Error(`the gate crashed on draft ${drafts}`);
      if (g === "silent") return { ...coreInvariantFields("Verdict"), scope_files: [], refused_ids: [] }; // a Verdict with no pass
      return g
        ? { ...coreInvariantFields("Verdict"), pass: true, scope_files: ["crossing/laws.sx"], refused_ids: [] }
        : { ...coreInvariantFields("Verdict"), ...FAIL(`draft ${drafts} writes an unscoped law`), refused_ids: ["law/x"] };
    }
    const ok = reviews[looks++];
    return ok === false ? { ...coreInvariantFields("Verdict"), ...FAIL("the reviewer's finding") } : { ...coreInvariantFields("Verdict"), pass: true };
  };
  return { invoke, order, looks: () => looks };
}

async function run(gate: (draft: number) => boolean | "silent" | "throw", reviews: boolean[], rounds = 3) {
  const w = world();
  const b = band(gate, reviews);
  const events: GigProgressEvent[] = [];
  let err: unknown;
  const res = await runGig(std(rounds), {}, {
    outputs: w.outputs, ledger: w.ledger, invoke: b.invoke,
    onProgress: (e: GigProgressEvent) => events.push(e),
  } as never).catch((e: unknown) => { err = e; return undefined as never; });
  const ev = (t: string) => events.filter((e) => e.type === t) as Array<GigProgressEvent & Record<string, unknown>>;
  return { res, b, ev, err };
}

describe("the gate runs on every amend round, before the reviewer", () => {
  it("G1 — an amend round re-runs the gate on the amended artifact, after the maker and before the reviewer", async () => {
    const { b } = await run(() => true, [false]);
    expect(b.order).toEqual(["maker", "gatekeeper", "reviewer", "maker", "gatekeeper", "reviewer"]);
  });

  it("G2 (Vör's plant) — round one in scope, the reviewer fails it, the amended artifact fails the gate: refused by the gate, the reviewer never sees it", async () => {
    const { res, b, ev } = await run((d) => d === 1, [false], 3);
    expect(b.order, "no reviewer after the gate refuses, and no further round").toEqual(["maker", "gatekeeper", "reviewer", "maker", "gatekeeper"]);
    expect(b.looks()).toBe(1);
    const gated = ev("amend_gated");
    expect(gated.length).toBe(1);
    expect(gated[0], "the round named is the round the gate ran in: the first amend is round 2").toMatchObject({ phase: "review", role: "review", gate: "gate", round: 2 });
    expect(JSON.stringify(gated[0]!["checks"])).toContain("draft 2 writes an unscoped law");
    const last = res.outputs.filter((o) => o.domain_type === "verdict").at(-1)!;
    expect(last.data["pass"], "the reviewer's failing verdict stands: the gig does not pass").toBe(false);
    const gv = res.outputs.filter((o) => o.domain_type === "gate-verdict").at(-1)!;
    expect(gv.data["pass"], "the gate's refusal of the amended artifact is sealed").toBe(false);
  });

  it("G3 — a gate that passes every round leaves the loop as it was: it amends to green", async () => {
    const { res, b } = await run(() => true, [false, false]);
    expect(b.looks()).toBe(3);
    expect(res.outputs.filter((o) => o.domain_type === "verdict").at(-1)!.data["pass"]).toBe(true);
  });

  it("G5 (Vör's plant, fce898d) — a gate that seals a Verdict with NO pass on the amended artifact stops the loop: silence is not a yes", async () => {
    const { res, b, ev } = await run((d) => (d === 1 ? true : "silent"), [false], 3);
    expect(b.order, "the reviewer is not seated after a silent gate").toEqual(["maker", "gatekeeper", "reviewer", "maker", "gatekeeper"]);
    expect(ev("amend_gated").length).toBe(1);
    expect(res!.outputs.filter((o) => o.domain_type === "verdict").at(-1)!.data["pass"], "the gig does not pass").toBe(false);
  });

  it("G6 — a gate whose chair throws on the amended artifact fails the gig closed: the reviewer is not seated, no pass", async () => {
    const { b, err } = await run((d) => (d === 1 ? true : "throw"), [false], 3);
    expect(b.order.filter((x) => x === "reviewer").length, "no second reviewer seat").toBe(1);
    expect(err, "the crash surfaces as a failed gig, never a pass").toBeDefined();
  });
});
