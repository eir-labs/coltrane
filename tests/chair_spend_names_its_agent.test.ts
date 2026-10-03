// RED — a chair_spend row names the AGENT that spent, not only the role that spent.
//
// Why this is a defect and not a missing nicety. `chair_spend` records `role`, `phase` and `round`
// (src/ledger.ts:174-195) and no agent identity. A role is a position in a STANDARD, and a standard
// is editable: rename a role, re-seat a chair onto a different agent, or delete the standard, and
// every chair_spend row ever written for it becomes unattributable. The spend is still in the
// ledger; WHO spent it is gone, recoverable only by guessing at a standard that no longer says what
// it said when the row was written.
//
// Measured on this machine's own run ledger (~/eir/coltrane/.coltrane/ledger.jsonl) before writing
// this file: 250 chair_spend rows across 200 gigs, of which 126 — more than half — cannot be
// resolved to an agent by joining role against the current standards/, because the roles they name
// no longer exist there. The question "which of these agents has ever actually run?" is not
// answerable from the ledger today, which is the question that decides which agents are real.
//
// The engine already HAS the answer at the write site: `agent.slug` is in scope at
// src/runtime.ts:3667 (used nine lines later, at :3688). It simply is not recorded.
//
// This is the engine's own stated discipline applied to its own accounting: a sealed record must
// not depend on something outside it that can move. Same argument as the git-invocation pin —
// a claim that moves with its surroundings is not a claim.
//
// testing_method: example-based through runGig with a real MemoryLedger (the harness shape of
// tests/spec_spend_survives_kill_failure_resume.test.ts), plus a validator law and a law that
// holds attribution across the exact mutation that breaks it today.
import { describe, it, expect } from "vitest";
import {
  createRegistry, createOutputStore, MemoryLedger, composeStandard,
  type AgentInvoker, type AgentInvocationContext, type DomainType, type Chair, type Standard,
} from "../src/index.js";
import { runGig } from "../src/runtime.js";
import { validateEntry } from "../src/ledger.js";
import { testAgent } from "./_support/agents.js";

const note: DomainType = { slug: "sa-note", extends: "Signal", domain: "spend-attr", schema: { properties: { t: { type: "string" } } }, required_fields: ["t"] };
const read: DomainType = { slug: "sa-read", extends: "Interpretation", domain: "spend-attr", schema: { properties: { summary: { type: "string" } } }, required_fields: ["summary"] };

function registerTypes(r: ReturnType<typeof createRegistry>): void { r.registerType(note); r.registerType(read); }

/** Two chairs, each seated on a DIFFERENT agent, so role→agent is a real mapping and not identity. */
function twoChair(roles: readonly [string, string] = ["survey", "judge"]): Standard {
  return composeStandard({
    slug: "spend-attr-chain", domain: "spend-attr",
    agents: [
      testAgent({ slug: "sa-sensor", primitives: ["SENSE"], input_types: [], output_types: ["sa-note"], domain: "spend-attr" }),
      testAgent({ slug: "sa-reader", primitives: ["INTERPRET"], input_types: ["sa-note"], output_types: ["sa-read"], domain: "spend-attr" }),
    ],
    phases: [
      { name: "p0", chairs: [{ role: roles[0], agent_slug: "sa-sensor", depends_on: [], input_contract: [], output_contract: ["sa-note"], required_skills: [] } as Chair] },
      { name: "p1", chairs: [{ role: roles[1], agent_slug: "sa-reader", depends_on: [roles[0]], input_contract: ["sa-note"], output_contract: ["sa-read"], required_skills: [] } as Chair] },
    ],
  });
}

function outFor(slug: string): Record<string, unknown> {
  return slug === "sa-sensor"
    ? { t: "x", source: "fixture://spend-attr/sensor" }
    : { summary: "y", claims: ["read the note"] };
}

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
const chairSpend = (l: MemoryLedger): Row[] =>
  (l.query({}) as unknown as Row[]).filter((r) => r["kind"] === "chair_spend");

async function runTwo(ledger: MemoryLedger, roles?: readonly [string, string]): Promise<void> {
  const registry = createRegistry(); registerTypes(registry);
  await runGig(twoChair(roles), {}, {
    outputs: createOutputStore(registry), ledger,
    invoke: spender({ "sa-sensor": 0.11, "sa-reader": 0.22 }), model_version: "m",
  });
}

describe("P1 — a chair_spend row names the agent that spent", () => {
  it("every row carries the seated agent's slug", async () => {
    const ledger = new MemoryLedger();
    await runTwo(ledger);
    const rs = chairSpend(ledger);
    expect(rs.length, "two settled chairs, two rows").toBe(2);
    for (const r of rs) {
      expect(r["agent_slug"], `chair_spend row for role "${String(r["role"])}" records no agent_slug`).toBeTypeOf("string");
      expect(String(r["agent_slug"]).length, "agent_slug must not be empty").toBeGreaterThan(0);
    }
  });

  it("the slug recorded is the agent actually seated in that chair, not the role", async () => {
    const ledger = new MemoryLedger();
    await runTwo(ledger);
    const byRole = new Map(chairSpend(ledger).map((r) => [String(r["role"]), r]));
    expect(byRole.get("survey")?.["agent_slug"], "the survey chair was seated on sa-sensor").toBe("sa-sensor");
    expect(byRole.get("judge")?.["agent_slug"], "the judge chair was seated on sa-reader").toBe("sa-reader");
  });
});

describe("P2 — attribution survives the standard it ran under changing", () => {
  it("spend is attributable per AGENT from the rows alone, with no standard consulted", async () => {
    const ledger = new MemoryLedger();
    await runTwo(ledger);
    // THE WHOLE POINT: join on nothing but the row. This is what 126 of the 250 real rows on this
    // machine cannot do, because their roles no longer resolve against any standard on disk.
    const perAgent = new Map<string, number>();
    for (const r of chairSpend(ledger)) {
      const slug = String(r["agent_slug"] ?? "");
      const c = (r["usage"] as { total_cost_usd?: number } | undefined)?.total_cost_usd ?? 0;
      perAgent.set(slug, (perAgent.get(slug) ?? 0) + c);
    }
    expect(perAgent.get("sa-sensor"), "sa-sensor's own spend, attributed from the row").toBeCloseTo(0.11, 6);
    expect(perAgent.get("sa-reader"), "sa-reader's own spend, attributed from the row").toBeCloseTo(0.22, 6);
    expect(perAgent.has(""), "no row may be unattributed").toBe(false);
  });

  it("renaming every role leaves per-agent attribution unchanged — the row does not depend on the standard", async () => {
    const a = new MemoryLedger(); await runTwo(a, ["survey", "judge"]);
    const b = new MemoryLedger(); await runTwo(b, ["read-the-thing", "call-it"]);
    const fold = (l: MemoryLedger): Record<string, number> => {
      const m: Record<string, number> = {};
      for (const r of chairSpend(l)) {
        const s = String(r["agent_slug"] ?? "");
        m[s] = (m[s] ?? 0) + ((r["usage"] as { total_cost_usd?: number } | undefined)?.total_cost_usd ?? 0);
      }
      return m;
    };
    const fa = fold(a), fb = fold(b);
    expect(Object.keys(fb).sort(), "the same two agents ran, whatever the roles were called").toEqual(["sa-reader", "sa-sensor"]);
    expect(fb["sa-sensor"]).toBeCloseTo(fa["sa-sensor"] ?? -1, 6);
    expect(fb["sa-reader"]).toBeCloseTo(fa["sa-reader"] ?? -1, 6);
  });
});

describe("P3 — the validator demands it, so a hand-rolled row cannot omit it", () => {
  const base = {
    kind: "chair_spend" as const, schema_version: 1,
    entry_id: "chair_spend:g:r:1:x", gig_id: "g", role: "r", phase: "p", round: 1,
    captured: false, output_hashes: [] as string[],
    started_at: new Date().toISOString(), finished_at: new Date().toISOString(),
  };

  it("a chair_spend row with no agent_slug is REFUSED, naming the field", () => {
    expect(() => validateEntry({ ...base } as never)).toThrow(/agent_slug/);
  });

  it("an empty-string agent_slug is refused too — absent must not be spellable as present", () => {
    expect(() => validateEntry({ ...base, agent_slug: "" } as never)).toThrow(/agent_slug/);
  });

  it("a row carrying a real agent_slug is accepted", () => {
    expect(() => validateEntry({ ...base, agent_slug: "sa-sensor" } as never)).not.toThrow();
  });
});
