// RED — the chain must name the model that ACTUALLY ran, and record what the chair cost.
//
// THE DEFECT. runtime.ts stamps every sealed output with `resolveModel(agent.model_tier, …)`, and
// resolveModel (claude_invoker.ts:23-38) is a hardcoded Claude map — called REGARDLESS of which
// invoker executed the chair. So a gig run through any non-Claude invoker seals records stamped
// `claude-haiku-4-5`. The intent was right and is written on the function itself: "EXPORTED
// because the runtime must stamp the same answer onto the sealed output that the invoker used to
// spawn. Two functions computing this separately is the two-gates-one-concern shape…". The map
// being Claude-only is what silently breaks that promise for every other port.
//
// It matters beyond tidiness: λ — the cost term the VOI conductor prices acquisition with — is
// read off these records. A stamp that names the wrong model makes every economy-vs-standard
// comparison compare nothing, and the arithmetic downstream would be sound and false.
//
// AND THE COST FIELDS ARE DEAD. OutputRecord.cost_usd / tokens_used / duration_ms exist in the
// schema and runGig's write path never populates them, so per-chair spend is recorded nowhere.
import { describe, it, expect } from "vitest";
import { TEST_BEHAVIOR } from "./_support/agents.js";
import {
  runGig,
  createRegistry,
  createOutputStore,
  MemoryLedger,
  type DomainType,
  type Agent,
  type Standard,
  type AgentInvoker,
} from "../src";

const probe: DomainType = {
  slug: "stamp-probe",
  extends: "Signal",
  domain: "research",
  schema: { properties: { v: { type: "number" }, source: { type: "string" } } },
  required_fields: ["v", "source"],
};

const prober: Agent = {
  ...TEST_BEHAVIOR,
  slug: "stamp-prober",
  primitives: ["SENSE"],
  input_types: [],
  output_types: ["stamp-probe"],
  domain: "research",
  model_tier: "economy",
};

const standard: Standard = {
  slug: "stamp-walk",
  domain: "research",
  agents: [prober],
  phases: [
    {
      name: "probe",
      chairs: [
        {
          role: "probe",
          agent_slug: "stamp-prober",
          depends_on: [],
          input_contract: [],
          output_contract: ["stamp-probe"],
          required_skills: [],
        },
      ],
    },
  ],
};

/** An invoker that reports, the way a real transport does, which model actually served it. */
function invokerReporting(model: string, usage?: Record<string, unknown>): AgentInvoker {
  return (ctx) => {
    ctx.onEvent?.({
      type: "result",
      raw: {
        usage: { input_tokens: 120, output_tokens: 40 },
        total_cost_usd: 0.00031,
        modelUsage: { [model]: { inputTokens: 120, outputTokens: 40, costUSD: 0.00031 } },
        ...(usage ?? {}),
      },
    });
    return { v: 1, source: "test://stamp/1" };
  };
}

async function runWith(invoke: AgentInvoker) {
  const registry = createRegistry();
  registry.registerType(probe);
  return runGig(standard, {}, {
    outputs: createOutputStore(registry),
    ledger: new MemoryLedger(),
    invoke,
  });
}

describe("LAW 5 — the sealed record names the model that actually ran", () => {
  it("a non-Claude model reported by the invoker is what gets stamped", async () => {
    const res = await runWith(invokerReporting("cheap-model-1"));
    expect(res.outputs).toHaveLength(1);
    const stamped = String((res.outputs[0] as unknown as { model?: string }).model ?? "");
    // The sabotage this law exists for: today this is `claude-haiku-4-5`, because the runtime
    // asks a Claude-only map instead of the transport that served the call.
    expect(stamped, "the chain stamped a model the run never used").toBe("cheap-model-1");
    expect(stamped).not.toMatch(/^claude-/);
  });

  it("with nothing reported, the stamp falls back to the tier resolution — and says so", async () => {
    // The fallback must still exist (a chair may run on a transport that reports no model), but
    // it must not masquerade as a measurement.
    const silent: AgentInvoker = () => ({ v: 2, source: "test://stamp/2" });
    const res = await runWith(silent);
    const rec = res.outputs[0] as unknown as { model?: string; model_reported?: boolean };
    expect(rec.model, "the fallback resolution disappeared").toBeTruthy();
    expect(rec.model_reported, "a fallback stamp claimed to be a report").not.toBe(true);
  });
});

describe("LAW 6 — usage is whole, and never fabricated", () => {
  it("tokens AND modelUsage fold into the gig's usage", async () => {
    const res = await runWith(invokerReporting("cheap-model-1"));
    expect(res.usage?.input_tokens).toBe(120);
    expect(res.usage?.output_tokens).toBe(40);
    expect(res.usage?.by_model?.["cheap-model-1"]).toBeTruthy();
  });

  it("a transport that reports nothing yields undefined, never 0 (#235)", async () => {
    const silent: AgentInvoker = () => ({ v: 3, source: "test://stamp/3" });
    const res = await runWith(silent);
    expect(res.usage?.total_cost_usd, "silence was folded as a measured zero").toBeUndefined();
  });
});

describe("LAW 7 — per-chair cost lands on the sealed record", () => {
  it("cost_usd and tokens_used are populated, not left dead in the schema", async () => {
    const res = await runWith(invokerReporting("cheap-model-1"));
    const rec = res.outputs[0] as unknown as { cost_usd?: number; tokens_used?: number };
    // These fields have existed all along and nothing has ever written them. λ needs them:
    // "which chair shape is affordable at which tier" is unanswerable from gig-level totals.
    expect(rec.cost_usd, "per-chair cost is still recorded nowhere").toBeCloseTo(0.00031, 6);
    expect(rec.tokens_used, "per-chair tokens are still recorded nowhere").toBe(160);
  });
});
