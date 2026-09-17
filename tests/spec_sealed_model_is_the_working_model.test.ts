// RED — a sealed output names the model that did the chair's work.
//
// THE DEFECT. The per-chair stamp takes the FIRST key of the CLI's `modelUsage` breakdown
// (`chairModel ??= model` in runGig's usage sink). Claude Code spends a small background call on a
// fast model before the real work, and that model is listed first. So a chair that thought on Opus
// or Sonnet is sealed as the background model, with `model_reported: true` vouching for it.
//
// MEASURED on 2026-09-16. Gig c539c33b's judge (change-decision 5bd05a16) and sequencer (change-plan
// b411f1f6) are both sealed `model: "claude-haiku-4-5-20251001"`. The gig's own usage shows Haiku
// wrote 73 output tokens in total, against 99,682 for Sonnet and 29,145 for Opus. The chain names a
// model that did none of the work, and nothing downstream can tell.
import { describe, it, expect } from "vitest";
import {
  createRegistry,
  createOutputStore,
  MemoryLedger,
  runGig,
  type AgentInvoker,
  type DomainType,
  type Standard,
} from "../src/index.js";
import { testAgent } from "./_support/agents.js";

const note: DomainType = {
  slug: "judged-note",
  extends: "Signal",
  domain: "demo",
  schema: { properties: { t: { type: "string" } } },
  required_fields: ["t"],
};

const judge = testAgent({ slug: "judge", primitives: ["SENSE"], input_types: [], output_types: ["judged-note"], domain: "demo" });

const oneChair: Standard = {
  slug: "one-judgement",
  domain: "demo",
  agents: [judge],
  phases: [{ name: "judge", chairs: [{ role: "j", agent_slug: "judge", depends_on: [], input_contract: [], output_contract: ["judged-note"], required_skills: [] }] }],
} as Standard;

async function sealWith(modelUsage: Record<string, { inputTokens: number; outputTokens: number; costUSD: number }>) {
  const registry = createRegistry();
  registry.registerType(note);
  const invoke: AgentInvoker = (ctx) => {
    ctx.onEvent?.({
      type: "result",
      raw: {
        type: "result",
        total_cost_usd: Object.values(modelUsage).reduce((s, m) => s + m.costUSD, 0),
        usage: { input_tokens: 100, output_tokens: 100 },
        modelUsage,
      },
    });
    return { t: "judged", source: "fixture://demo/judged" };
  };
  const res = await runGig(oneChair, {}, { outputs: createOutputStore(registry), ledger: new MemoryLedger(), invoke });
  return res.outputs[0] as { model?: string } | undefined;
}

describe("a sealed output names the model that did the work", () => {
  it("LAW 1 — a background model listed first is not stamped over the model that wrote the output", async () => {
    // Key order as the CLI reports it: the background call first.
    const sealed = await sealWith({
      "claude-haiku-4-5-20251001": { inputTokens: 70_091, outputTokens: 73, costUSD: 0.0705 },
      "claude-opus-4-8": { inputTokens: 6, outputTokens: 29_145, costUSD: 1.6796 },
    });
    expect(sealed?.model, "the seal names the background model, not the one that did the work").toBe("claude-opus-4-8");
  });

  it("LAW 2 (control) — a chair served by one model is stamped with that model", async () => {
    // Green today. It is here so a fix that stops stamping, or stamps a constant, goes red.
    const sealed = await sealWith({ "claude-sonnet-4-6": { inputTokens: 500, outputTokens: 900, costUSD: 0.02 } });
    expect(sealed?.model).toBe("claude-sonnet-4-6");
  });
});
