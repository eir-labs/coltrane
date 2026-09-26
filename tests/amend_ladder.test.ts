// THE AMEND LADDER — what a string of failed verdicts means for the maker, decided from the verdicts.
//
// The rule (agreed with the operator 2026-09-22, after the re-verify carriage landed so a failed verdict
// is no longer the verifier re-judging blind):
//   - a re-verify that fails on DIFFERENT findings than the verdict before it: the maker moves up one
//     rung of COLTRANE_TIER_LADDER for the next amend round. It is making the verifier look at new
//     things and still not landing — more capability is the bet.
//   - a re-verify that fails on the SAME findings as the verdict before it: stop amending. The objection
//     is not moving; it is a finding for the conductor or a person (a missing fact, a mis-tiered clause,
//     an operator the evaluator lacks), and paying a better model to meet it again buys nothing.
//     `amend_stalled` names the objection.
// "Findings" are the verdict's `checks` as (method, target_ref) pairs. The core Verdict REQUIRES a
// non-empty `checks` with a `method` on each, so every sealed verdict has findings to compare — there is
// no "unreadable" case to design for (a first draft had one; its law could not fail, and it went).
// Opt-in: with no ladder, the loop is exactly what it was.
import { describe, it, expect } from "vitest";
import {
  composeStandard, runGig, createRegistry, createOutputStore, MemoryLedger,
  type AgentInvoker, type DomainType, type PhaseDef, type Chair, type GigProgressEvent,
} from "../src/index.js";
import { assembleRunDeps } from "../src/run_deps.js";
import { testAgent } from "./_support/agents.js";
import { coreInvariantFields } from "./_support/specs.js";

const chair = (role: string, agent_slug: string, opts: Partial<Chair> = {}): Chair =>
  ({ role, agent_slug, depends_on: [], input_contract: [], output_contract: [], required_skills: [], ...opts });

function world() {
  const registry = createRegistry();
  for (const [s, e, f] of [["plan-in", "Plan", "p"], ["artifact", "Artifact", "a"], ["verdict", "Verdict", "v"]] as const) {
    registry.registerType({ slug: s, extends: e, domain: "test", schema: { properties: { [f]: { type: "string" }, items: { type: "array" } } }, required_fields: [] } as DomainType);
  }
  return { registry, outputs: createOutputStore(registry), ledger: new MemoryLedger() };
}

const std = (rounds: number, makerTier: "economy" | "standard" | "premium" = "economy", fan = false) => composeStandard({
  slug: "amend-ladder", domain: "test", max_examine_rounds: rounds,
  agents: [
    testAgent({ slug: "planner", primitives: ["PLAN"], input_types: [], output_types: ["plan-in"], model_tier: "economy" }),
    testAgent({ slug: "maker", primitives: ["CREATE"], input_types: ["plan-in"], output_types: ["artifact"], model_tier: makerTier }),
    testAgent({ slug: "verifier", primitives: ["VERIFY"], input_types: ["artifact"], output_types: ["verdict"], model_tier: "standard" }),
  ],
  phases: [
    { name: "plan", chairs: [chair("plan", "planner", { output_contract: ["plan-in"] })] },
    { name: "make", chairs: [chair("make", "maker", { depends_on: ["plan"], input_contract: ["plan-in"], output_contract: ["artifact"], ...(fan ? { fan_out: { over: { type: "plan-in", path: "items", key: "k" } } } : {}) })] },
    { name: "check", chairs: [chair("check", "verifier", { depends_on: ["make"], input_contract: ["artifact"], output_contract: ["verdict"] })] },
  ] as PhaseDef[],
});

type Checks = Array<{ method: string; target_ref?: string; result?: string }>;

/** The verifier fails with `verdicts[i]` on its i-th look and passes once they run out. */
function band(verdicts: Checks[]) {
  const makerTiers: string[] = [];
  const makerResume: boolean[] = [];
  let looks = 0;
  const invoke: AgentInvoker = (ctx) => {
    if (ctx.agent.slug === "planner") return { ...coreInvariantFields("Plan"), p: "plan", items: [{ k: "x" }, { k: "y" }] };
    if (ctx.agent.slug === "maker") {
      makerTiers.push(String(ctx.agent.model_tier));
      makerResume.push(ctx.resume === true);
      return { ...coreInvariantFields("Artifact"), a: `draft ${makerTiers.length}` };
    }
    const v = verdicts[looks++];
    if (v === undefined) return { ...coreInvariantFields("Verdict"), pass: true };
    return { ...coreInvariantFields("Verdict"), pass: false, checks: v.map((c) => ({ result: "fails", ...c })) };
  };
  return { invoke, makerTiers, makerResume, looks: () => looks };
}

async function run(verdicts: Checks[], opts: { rounds?: number; ladder?: string[]; makerTier?: "economy" | "standard" | "premium"; fan?: boolean } = {}) {
  const w = world();
  const b = band(verdicts);
  const events: GigProgressEvent[] = [];
  const res = await runGig(std(opts.rounds ?? 3, opts.makerTier, opts.fan ?? false), {}, {
    outputs: w.outputs, ledger: w.ledger, invoke: b.invoke,
    ...(opts.ladder ? { tier_ladder: opts.ladder } : {}),
    onProgress: (e: GigProgressEvent) => events.push(e),
  } as never);
  const ev = (t: string) => events.filter((e) => e.type === t) as Array<GigProgressEvent & Record<string, unknown>>;
  return { res, b, ev, w };
}

const LADDER = ["economy", "standard", "premium"];
const A = { method: "moral rights drafted as a covenant", target_ref: "clause/moral" };
const B = { method: "arts 27/28 specially mentioned", target_ref: "clause/mention" };
const C = { method: "consideration stated with a due date", target_ref: "clause/consideration" };

describe("the amend ladder", () => {
  it("L1 — a re-verify failing on DIFFERENT findings seats the maker one rung up for the next round, and the record names the tier that made it", async () => {
    const { res, b, ev } = await run([[A], [B]], { ladder: LADDER });
    // round 1 (economy) → amend 1 (economy, same tier: one failure is not a pattern) → verdict [B] ≠ [A]
    // → amend 2 climbs to standard → passes.
    expect(b.makerTiers).toEqual(["economy", "economy", "standard"]);
    const climbs = ev("amend_escalated");
    expect(climbs.length).toBe(1);
    expect(climbs[0]).toMatchObject({ role: "make", from_tier: "economy", to_tier: "standard" });
    const art = res.outputs.filter((o) => o.domain_type === "artifact").at(-1)!;
    expect(art.model_tier, "the sealed artifact names the tier that produced it").toBe("standard");
    expect(res.outputs.filter((o) => o.domain_type === "verdict").at(-1)!.data["pass"]).toBe(true);
  });

  it("L2 — a re-verify failing on the SAME findings stops the loop with rounds left, naming the objection; nothing climbs", async () => {
    const { b, ev } = await run([[A, B], [B, A], [A, B]], { ladder: LADDER, rounds: 3 });
    expect(b.makerTiers, "no round after the stall, and no climb").toEqual(["economy", "economy"]);
    expect(b.looks(), "the verifier is not asked again after the stall").toBe(2);
    const stall = ev("amend_stalled");
    expect(stall.length).toBe(1);
    expect(JSON.stringify(stall[0]!["repeated"])).toContain("moral rights drafted as a covenant");
    expect(ev("amend_escalated").length).toBe(0);
  });

  it("L3 — findings that keep changing climb one rung per round, and stop climbing at the top", async () => {
    const { b } = await run([[A], [B], [C], [A]], { ladder: LADDER, rounds: 4 });
    expect(b.makerTiers).toEqual(["economy", "economy", "standard", "premium", "premium"]);
  });

  it("L4 — the same objection landing on a DIFFERENT target is a different finding: it climbs, it does not stall", async () => {
    const { b, ev } = await run([[{ method: "uses a waiver", target_ref: "clause/moral" }], [{ method: "uses a waiver", target_ref: "clause/sublicence" }]], { ladder: LADDER });
    expect(b.makerTiers).toEqual(["economy", "economy", "standard"]);
    expect(ev("amend_stalled").length).toBe(0);
  });

  it("L5 — a maker starts from its own tier: a standard maker's next rung is premium", async () => {
    const { b } = await run([[A], [B]], { ladder: LADDER, makerTier: "standard" });
    expect(b.makerTiers).toEqual(["standard", "standard", "premium"]);
  });

  it("L8 — a maker seated on a new rung starts COLD; a maker on its own rung resumes its conversation", async () => {
    const { b } = await run([[A], [B]], { ladder: LADDER });
    // round 1 opens; amend 1 (same rung) resumes; amend 2 (climbed) is a different player — cold.
    expect(b.makerResume).toEqual([false, true, false]);
  });

  it("L9 — a fanned-out maker climbs INSTANCE BY INSTANCE: every seat of the template moves up together", async () => {
    const { b } = await run([[A], [B]], { ladder: LADDER, fan: true });
    // two instances × (round 1, amend 1 on economy, amend 2 on standard)
    expect(b.makerTiers).toEqual(["economy", "economy", "economy", "economy", "standard", "standard"]);
    expect(b.makerResume, "a climbed instance is a new player too — cold").toEqual([false, false, true, true, false, false]);
  });

  it("L6 (control) — with no ladder the loop is what it was: same findings do not stop it, different ones do not climb", async () => {
    const same = await run([[A], [A], [A]], { rounds: 3 });
    expect(same.b.makerTiers).toEqual(["economy", "economy", "economy", "economy"]);
    const diff = await run([[A], [B]], { rounds: 3 });
    expect(diff.b.makerTiers).toEqual(["economy", "economy", "economy"]);
  });

  it("L7 — the shared RunDeps assembler reads the ladder from the environment, so every door gets it", () => {
    const w = world();
    const saved = { ...process.env };
    try {
      process.env["COLTRANE_TIER_LADDER"] = "economy,premium";
      delete process.env["COLTRANE_COMPLETIONS_URL"];
      const d = assembleRunDeps({ outputs: w.outputs, ledger: w.ledger, invoke: () => ({}) } as never);
      expect(d.tier_ladder).toEqual(["economy", "premium"]);
      // On the completions port a rung with no model mapped is dropped, never climbed into.
      process.env["COLTRANE_COMPLETIONS_URL"] = "https://x.test/v1";
      process.env["COLTRANE_TIER_ECONOMY"] = "m-eco";
      delete process.env["COLTRANE_TIER_PREMIUM"];
      const d2 = assembleRunDeps({ outputs: w.outputs, ledger: w.ledger, invoke: () => ({}) } as never);
      expect(d2.tier_ladder).toEqual(["economy"]);
      delete process.env["COLTRANE_TIER_LADDER"];
      expect(assembleRunDeps({ outputs: w.outputs, ledger: w.ledger, invoke: () => ({}) } as never).tier_ladder).toBeUndefined();
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });
});
