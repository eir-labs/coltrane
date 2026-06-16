// #195 + #196 — the runtime captures what the model actually spent, and the provenance hashes a
// sealed record carries are REAL (not agent-fabricated placeholders). Both were "shape present,
// computation missing": the result event's usage was forwarded-then-dropped, and agents emitted
// `*_sha` placeholders they couldn't compute. Verified on the real runGig path (stubbed invoker
// standing in for the model, emitting the same stream-json `result` event the CLI produces).
import { describe, it, expect } from "vitest";
import {
  createRegistry, createOutputStore, MemoryLedger, composeStandard, runGig,
  sha256Hex, canonJson,
  type AgentInvoker, type DomainType, type PhaseDef, type Chair, type Standard,
} from "../src/index.js";
import { testAgent } from "./_support/agents.js";

function harness(invoke: AgentInvoker, standard: Standard) {
  const registry = createRegistry();
  const note: DomainType = { slug: "note", extends: "Signal", domain: "demo", schema: { properties: { t: { type: "string" } } }, required_fields: ["t"] };
  const linked: DomainType = { slug: "linked", extends: "Interpretation", domain: "demo", schema: { properties: { summary: { type: "string" }, note_sha: { type: "string" }, input_sha: { type: "string" } } }, required_fields: [] };
  registry.registerType(note);
  registry.registerType(linked);
  const ledger = new MemoryLedger();
  return { deps: { registry, outputs: createOutputStore(registry), ledger, invoke, model_version: "test-1" }, ledger };
}

// ── #195 — settled model spend is captured from the result event and persisted ──────────────────
describe("runGig captures + persists actual model usage (#195)", () => {
  const std = (): Standard => composeStandard({
    slug: "usage-demo", domain: "demo",
    agents: [testAgent({ slug: "solo", primitives: ["SENSE"], input_types: [], output_types: ["note"], domain: "demo" })],
    phases: [{ name: "sense", chairs: [{ role: "s", agent_slug: "solo", depends_on: [], input_contract: [], output_contract: ["note"], required_skills: [] } as Chair] }],
  });

  it("folds usage from the stream-json result event into the ledger entry + GigResult", async () => {
    const invoke: AgentInvoker = (ctx) => {
      // the exact shape the claude CLI's stream-json `result` event carries (forwarded as raw)
      ctx.onEvent?.({ type: "result", text: "{}", raw: {
        type: "result", total_cost_usd: 0.042,
        usage: { input_tokens: 1200, output_tokens: 350 },
        modelUsage: { "claude-opus-4-8": { inputTokens: 1200, outputTokens: 350, costUSD: 0.042 } },
      } });
      return { t: "hi" };
    };
    const { deps, ledger } = harness(invoke, std());
    const r = await runGig(std(), {}, deps as never);

    // on the GigResult
    expect(r.usage, "GigResult must carry settled usage").toBeTruthy();
    expect(r.usage!.input_tokens).toBe(1200);
    expect(r.usage!.output_tokens).toBe(350);
    expect(r.usage!.total_cost_usd).toBeCloseTo(0.042, 6);
    expect(r.usage!.by_model["claude-opus-4-8"]?.cost_usd).toBeCloseTo(0.042, 6);

    // persisted on the ledger entry, queryable by gig_id
    const entry = ledger.query({ gig_id: r.gig_id })[0];
    expect(entry?.usage?.output_tokens, "ledger entry must persist usage").toBe(350);
    expect(entry?.usage?.total_cost_usd).toBeCloseTo(0.042, 6);
  });

  it("omits usage when no model ran (no result event)", async () => {
    const { deps } = harness(() => ({ t: "hi" }), std());
    const r = await runGig(std(), {}, deps as never);
    expect(r.usage, "no model invocation → no settled usage").toBeUndefined();
  });
});

// ── #196 — placeholder provenance SHAs are replaced by the REAL content hashes at seal ──────────
describe("runGig stamps real provenance hashes (#196)", () => {
  const std = (): Standard => composeStandard({
    slug: "prov-demo", domain: "demo",
    agents: [
      testAgent({ slug: "producer", primitives: ["SENSE"], input_types: [], output_types: ["note"], domain: "demo" }),
      testAgent({ slug: "linker", primitives: ["INTERPRET"], input_types: ["note"], output_types: ["linked"], domain: "demo" }),
    ],
    phases: [
      { name: "sense", chairs: [{ role: "p", agent_slug: "producer", depends_on: [], input_contract: [], output_contract: ["note"], required_skills: [] }] },
      { name: "interpret", chairs: [{ role: "l", agent_slug: "linker", depends_on: ["p"], input_contract: ["note"], output_contract: ["linked"], required_skills: [] }] },
    ] as PhaseDef[],
  });

  it("replaces agent-fabricated *_sha placeholders with the real input/gig content_sha, and stamps input_shas", async () => {
    const gigInput = { seed: "the disclosure bytes" };
    const invoke: AgentInvoker = (ctx) => {
      if (ctx.agent.slug === "producer") return { t: "raw note" };
      // the linker fabricates placeholder hashes it can't compute — exactly the #196 failure
      return {
        summary: "linked",
        note_sha: "sha256:PLACEHOLDER-note-deadbeef",
        input_sha: "sha256:UNCOMPUTED-PLACEHOLDER-input-disclosure",
      };
    };
    const { deps } = harness(invoke, std());
    const r = await runGig(std(), gigInput, deps as never);

    const note = r.outputs.find((o) => o.domain_type === "note")!;
    const linked = r.outputs.find((o) => o.domain_type === "linked")!;

    // the engine stamped the REAL predecessor hash chain (no agent hashing)
    expect(linked.input_shas, "input_shas must pin the consumed note's content_sha").toEqual([note.content_sha]);

    // the fabricated placeholders are gone — replaced by real content hashes
    const data = linked.data as Record<string, string>;
    expect(data["note_sha"], "note_sha must resolve to the upstream note's content_sha").toBe(note.content_sha);
    expect(data["input_sha"], "input_sha must resolve to the gig input's hash").toBe(sha256Hex(canonJson(gigInput)));
    expect(JSON.stringify(linked.data)).not.toMatch(/PLACEHOLDER/);
  });
});
