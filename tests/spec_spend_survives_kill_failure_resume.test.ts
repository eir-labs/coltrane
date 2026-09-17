// RED — contract-spend-survives-v1: no captured spend is lost.
//
// In src/runtime.ts per-chair `result`-event spend is folded into ONE gig-wide `usage` object and
// written ONCE, in the gig row, on the SUCCESS path only (src/runtime.ts:3428-3447). A gig killed
// on a later chair loses the ones that already settled; a failed gig attaches partial usage to the
// thrown error but writes no ledger row; a resumed gig's row never carries what earlier attempts
// spent. These laws demand a durable `chair_spend` row per settled chair, failure-path recovery,
// the CLI spend line, and `prior_usage` on the resumed gig row — none of which exist yet.
//
// testing_method: example-based through runGig with a real MemoryLedger (+ the dispatch command's
// own output path for O3); property-based (fast-check) for I1. See docs/specs/spend-survives.red-spec.md.
// runGig emits no chair_spend row today, so the laws fail on ABSENCE, not on a validator rejection.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  createRegistry, createOutputStore, MemoryLedger, composeStandard,
  type AgentInvoker, type AgentInvocationContext, type DomainType, type Chair, type Standard,
} from "../src/index.js";
import { runGig } from "../src/runtime.js";
import { createMemoryCheckpointStore } from "../src/reuse.js";
import { runCli, type CliIO } from "../src/cli.js";
import type { ServerDeps } from "../src/server.js";
import { testAgent } from "./_support/agents.js";

// A three-phase linear chain, one chair per phase.
const note: DomainType = { slug: "note", extends: "Signal", domain: "spend", schema: { properties: { t: { type: "string" } } }, required_fields: ["t"] };
const read: DomainType = { slug: "read", extends: "Interpretation", domain: "spend", schema: { properties: { summary: { type: "string" } } }, required_fields: ["summary"] };
const call: DomainType = { slug: "call", extends: "Verdict", domain: "spend", schema: { properties: { v: { type: "string" } } }, required_fields: ["v"] };

function registerTypes(registry: ReturnType<typeof createRegistry>): void {
  registry.registerType(note); registry.registerType(read); registry.registerType(call);
}

function threeChair(): Standard {
  return composeStandard({
    slug: "spend-chain", domain: "spend",
    agents: [
      testAgent({ slug: "a0", primitives: ["SENSE"], input_types: [], output_types: ["note"], domain: "spend" }),
      testAgent({ slug: "a1", primitives: ["INTERPRET"], input_types: ["note"], output_types: ["read"], domain: "spend" }),
      testAgent({ slug: "a2", primitives: ["VERIFY"], input_types: ["read"], output_types: ["call"], domain: "spend" }),
    ],
    phases: [
      { name: "p0", chairs: [{ role: "r0", agent_slug: "a0", depends_on: [], input_contract: [], output_contract: ["note"], required_skills: [] } as Chair] },
      { name: "p1", chairs: [{ role: "r1", agent_slug: "a1", depends_on: ["r0"], input_contract: ["note"], output_contract: ["read"], required_skills: [] } as Chair] },
      { name: "p2", chairs: [{ role: "r2", agent_slug: "a2", depends_on: ["r1"], input_contract: ["read"], output_contract: ["call"], required_skills: [] } as Chair] },
    ],
  });
}

// Core-valid output per agent (Signal names its source; Interpretation carries claims; Verdict, checks).
function outFor(slug: string): Record<string, unknown> {
  if (slug === "a0") return { t: "x", source: "fixture://spend/a0" };
  if (slug === "a1") return { summary: "y", claims: ["read the note"] };
  return { v: "go", checks: [{ method: "one check", result: "pass" }] };
}

// A settled `result` event, exactly as the invokers emit it.
function settle(ctx: AgentInvocationContext, c: number): void {
  ctx.onEvent?.({ type: "result", raw: {
    type: "result", total_cost_usd: c, usage: { input_tokens: 100, output_tokens: 20 },
    modelUsage: { "claude-opus-4-8": { inputTokens: 100, outputTokens: 20, costUSD: c } },
  } });
}

const spender = (costs: Record<string, number>): AgentInvoker => (ctx) => {
  settle(ctx, costs[ctx.agent.slug] ?? 0); return outFor(ctx.agent.slug);
};

type Row = Record<string, unknown>;
const rows = (l: MemoryLedger): Row[] => l.query({}) as unknown as Row[];
const chairSpend = (l: MemoryLedger): Row[] => rows(l).filter((r) => r["kind"] === "chair_spend");
const gigRows = (l: MemoryLedger): Row[] => rows(l).filter((r) => r["kind"] === "gig");
const cost = (r: Row): number => (r["usage"] as { total_cost_usd?: number } | undefined)?.total_cost_usd ?? 0;
const sumChairs = (l: MemoryLedger): number => chairSpend(l).reduce((n, r) => n + cost(r), 0);

describe("O1 — every settled chair leaves a durable chair_spend row", () => {
  it("one row per settled chair, carrying role/phase/round/its own usage", async () => {
    const registry = createRegistry(); registerTypes(registry);
    const ledger = new MemoryLedger();
    await runGig(threeChair(), {}, { outputs: createOutputStore(registry), ledger, invoke: spender({ a0: 0.10, a1: 0.20, a2: 0.30 }), model_version: "m" });

    const rs = chairSpend(ledger);
    expect(rs.length, "no chair_spend rows — per-chair spend folds into one gig row and dies with a later kill").toBe(3);
    const byRole = new Map(rs.map((r) => [r["role"], r]));
    for (const [role, dollars] of [["r0", 0.10], ["r1", 0.20], ["r2", 0.30]] as const) {
      const row = byRole.get(role);
      expect(row, `no chair_spend row for role ${role}`).toBeDefined();
      expect(row!["gig_id"], "the row names its gig").toBeTruthy();
      expect(row!["phase"], "the row records its phase").toBeTruthy();
      expect(row!["round"], "a first run is round 1").toBe(1);
      expect(cost(row!), `role ${role} carries its OWN settled cost`).toBeCloseTo(dollars, 6);
    }
  });
});

describe("I2 — durability: the row exists before the next chair is invoked", () => {
  it("the second chair's invoker reads the ledger and finds the first chair's row", async () => {
    const registry = createRegistry(); registerTypes(registry);
    const ledger = new MemoryLedger();
    let sawFirstRow = false;
    const invoke: AgentInvoker = (ctx) => {
      settle(ctx, 0.15);
      if (ctx.agent.slug === "a1") sawFirstRow = chairSpend(ledger).some((r) => r["role"] === "r0");
      return outFor(ctx.agent.slug);
    };
    await runGig(threeChair(), {}, { outputs: createOutputStore(registry), ledger, invoke, model_version: "m" });
    expect(sawFirstRow, "r0's row was absent when r1 ran — a kill during r1 loses r0's captured spend").toBe(true);
  });
});

describe("I1 — chair_spend rows reconcile to the gig row's usage.total_cost_usd", () => {
  const dollars = () => fc.integer({ min: 0, max: 1000 }).map((n) => n / 100);
  it("for ANY three settled costs, the chair_spend rows sum to the gig row's total", async () => {
    await fc.assert(
      fc.asyncProperty(fc.tuple(dollars(), dollars(), dollars()), async ([c0, c1, c2]) => {
        const registry = createRegistry(); registerTypes(registry);
        const ledger = new MemoryLedger();
        await runGig(threeChair(), {}, { outputs: createOutputStore(registry), ledger, invoke: spender({ a0: c0, a1: c1, a2: c2 }), model_version: "m" });
        const gig = gigRows(ledger)[0];
        expect(gig, "the completed gig sealed its gig row").toBeDefined();
        const gigTotal = (gig!["usage"] as { total_cost_usd?: number } | undefined)?.total_cost_usd ?? 0;
        expect(chairSpend(ledger).length, "no chair_spend rows — the gig row's usage is the only record, so nothing sums to it").toBe(3);
        expect(sumChairs(ledger), "captured chair_spend must reconcile to the gig's settled total").toBeCloseTo(gigTotal, 6);
      }),
      { numRuns: 12 },
    );
  });
});

describe("O2 — a failed gig writes no gig row, yet its chair_spend rows survive", () => {
  it("the surviving rows sum to the partial usage the thrown error carries", async () => {
    const registry = createRegistry(); registerTypes(registry);
    const ledger = new MemoryLedger();
    const invoke: AgentInvoker = (ctx) => {
      if (ctx.agent.slug === "a0") { settle(ctx, 0.42); return outFor("a0"); }
      throw new Error("the scout hung and the phase died");
    };
    let err: unknown;
    try { await runGig(threeChair(), {}, { outputs: createOutputStore(registry), ledger, invoke, model_version: "m" }); }
    catch (e) { err = e; }

    expect(err, "the gig must fail").toBeInstanceOf(Error);
    expect(gigRows(ledger).length, "absence-of-gig-row stays the un-sealed signal (#236)").toBe(0);
    expect(chairSpend(ledger).length, "the completed chair's spend must be a DURABLE row, not only a value riding on the error a SIGKILL never sees").toBe(1);
    const partial = (err as Row)["usage"] as { total_cost_usd?: number } | undefined;
    expect(partial?.total_cost_usd, "the error still carries the partial usage").toBeCloseTo(0.42, 6);
    expect(sumChairs(ledger), "the chair_spend rows must sum to that partial usage").toBeCloseTo(0.42, 6);
  });
});

describe("F1 — an unattributed chair seals captured:false, never a $0 row", () => {
  it("the no-usage row carries captured:false and no cost, and adds nothing to the sum", async () => {
    const registry = createRegistry(); registerTypes(registry);
    const ledger = new MemoryLedger();
    const invoke: AgentInvoker = (ctx) => { // a0 reports nothing; a1/a2 settle $0.20/$0.30.
      if (ctx.agent.slug === "a1") settle(ctx, 0.20);
      if (ctx.agent.slug === "a2") settle(ctx, 0.30);
      return outFor(ctx.agent.slug);
    };
    await runGig(threeChair(), {}, { outputs: createOutputStore(registry), ledger, invoke, model_version: "m" });

    const r0 = chairSpend(ledger).find((r) => r["role"] === "r0");
    expect(r0, "a chair that reported no usage still gets a row — its spend is UNKNOWN, not absent").toBeDefined();
    expect(r0!["captured"], "an unattributed chair records captured:false").toBe(false);
    const carriesCost = !!r0!["usage"] && typeof (r0!["usage"] as { total_cost_usd?: unknown }).total_cost_usd === "number";
    expect(carriesCost, "an uncaptured chair carries no cost field — never a $0 row").toBe(false);
    expect(sumChairs(ledger), "the two chairs that reported sum to $0.50; the uncaptured one adds nothing").toBeCloseTo(0.50, 6);
  });
});

describe("O4 — a resumed gig's gig row carries prior_usage beside its own usage", () => {
  it("prior_usage holds what the killed attempt spent, never folded into this run's usage", async () => {
    const registry = createRegistry(); registerTypes(registry);
    const outputs = createOutputStore(registry);
    const ledger = new MemoryLedger();
    const checkpoints = createMemoryCheckpointStore();
    const GID = "spend-resume-gig";

    // Attempt 1: r0 settles $0.42 and seals; r1 dies. The checkpoint banks r0 and its prior_usage.
    const die: AgentInvoker = (ctx) => {
      if (ctx.agent.slug === "a0") { settle(ctx, 0.42); return outFor("a0"); }
      throw new Error("gate died");
    };
    await expect(runGig(threeChair(), {}, { outputs, ledger, invoke: die, checkpoints, gig_id: GID, model_version: "m" })).rejects.toThrow();
    expect(gigRows(ledger).length, "the failed attempt seals no gig row").toBe(0);

    // Attempt 2: resume; r1 and r2 settle $0.10 each and complete.
    const finish: AgentInvoker = (ctx) => { settle(ctx, 0.10); return outFor(ctx.agent.slug); };
    await runGig(threeChair(), {}, { outputs, ledger, invoke: finish, checkpoints, resume_from: GID, model_version: "m" });

    const gig = gigRows(ledger).find((r) => r["gig_id"] === GID);
    expect(gig, "the completed resume seals a gig row for the same gig id").toBeDefined();
    const prior = gig!["prior_usage"] as { total_cost_usd?: number } | undefined;
    expect(prior, "the gig row must carry prior_usage from the checkpoint — today it lives only on GigResult.resumed_from").toBeDefined();
    expect(prior!.total_cost_usd, "prior_usage is the $0.42 the killed attempt captured").toBeCloseTo(0.42, 6);
    expect(cost(gig!), "this run's OWN usage is its two chairs' $0.20 — prior NOT folded in (#235/#236)").toBeCloseTo(0.20, 6);
  });
});

describe("O3 — the dispatch command reports a failed gig's captured spend", () => {
  function cliDeps(invoke: AgentInvoker): ServerDeps {
    const registry = createRegistry(); registerTypes(registry);
    const std = threeChair();
    return { registry, outputs: createOutputStore(registry), ledger: new MemoryLedger(), standards: new Map([[std.slug, std]]), invoke, gig_runs: new Map() };
  }
  function cliIo(deps: ServerDeps): { io: CliIO; stderr: () => string } {
    const errBuf: string[] = [];
    return { io: { out: () => {}, err: (s: string) => errBuf.push(s), deps } as CliIO, stderr: () => errBuf.join("") };
  }

  it("names the captured total in dollars and how many chair invocations settled", async () => {
    const invoke: AgentInvoker = (ctx) => {
      if (ctx.agent.slug === "a0") { settle(ctx, 0.42); return outFor("a0"); }
      throw new Error("gate died");
    };
    const { io, stderr } = cliIo(cliDeps(invoke));
    expect(await runCli(["dispatch", "spend-chain", "--wait"], io), "a failed dispatch exits 1").toBe(1);
    const out = stderr();
    expect(out, "the failure output must report the captured total in dollars ($0.42) — today it prints only the error").toMatch(/\$0\.42/);
    expect(out, "and how many chair invocations settled (1)").toMatch(/1\s+(chair|invocation)/i);
  });

  it("when nothing was captured it SAYS spend was not captured, never $0.00", async () => {
    const invoke: AgentInvoker = () => { throw new Error("died before reporting"); };
    const { io, stderr } = cliIo(cliDeps(invoke));
    expect(await runCli(["dispatch", "spend-chain", "--wait"], io)).toBe(1);
    const out = stderr();
    expect(out.toLowerCase(), "with no captured spend the failure output must say so explicitly").toMatch(/spend.*(not|un)\s*captur|not captured/);
    expect(out, "an uncaptured failure must never be reported as $0.00 (the #235 lie)").not.toMatch(/\$0\.00/);
  });
});
