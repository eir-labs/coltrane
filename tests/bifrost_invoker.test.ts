// The Bifrost model port — prompt parity with the Claude invoker, correct wire
// shape to /v1/generate, tolerant parse of the reply body, tier passthrough,
// and cost surfaced as a stream-json-shaped result event so GigResult.usage
// folds Bifrost spend with no runtime changes.
import { describe, it, expect } from "vitest";
import { TEST_BEHAVIOR } from "./_support/agents.js";
import {
  makeBifrostInvoker,
  createRegistry,
  runGig,
  createOutputStore,
  MemoryLedger,
  type DomainType,
  type AgentInvocationContext,
  type AgentStreamEvent,
} from "../src";
import type { Standard, Agent } from "../src";

const probe: DomainType = {
  slug: "axis-probe",
  extends: "Signal",
  domain: "etude",
  schema: { properties: { axis: { type: "string" }, value: { type: "number" } } },
  required_fields: ["axis", "value"],
};

const prober: Agent = { ...TEST_BEHAVIOR,
  slug: "axis-prober", primitives: ["SENSE"], input_types: [], output_types: ["axis-probe"],
  domain: "etude", model_tier: "economy",
};

function ctxFor(agent: Agent): AgentInvocationContext {
  return { agent, phase: "probe", inputs: [], gig_input: { goal: "probe the axis" } };
}

// Injected transport capturing the request and returning a canned Bifrost reply.
function fakeFetch(reply: unknown, status = 200) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fn = (async (url: unknown, init?: { body?: unknown }) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => reply,
      text: async () => JSON.stringify(reply),
    };
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("makeBifrostInvoker", () => {
  it("POSTs the canonical wire shape and parses a string body into the typed blob", async () => {
    const registry = createRegistry();
    registry.registerType(probe);
    const { fn, calls } = fakeFetch({ kind: "text", body: 'Here you go:\n{"axis":"north","value":0.7}' });
    const invoke = makeBifrostInvoker({ url: "https://bifrost.test/", deviceToken: "t".repeat(64), registry, fetchFn: fn, tierMap: { economy: "flash" } });

    const out = await invoke(ctxFor(prober));
    expect(out).toEqual({ axis: "north", value: 0.7 });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://bifrost.test/v1/generate"); // trailing slash normalized
    const body = calls[0]!.body;
    expect(body["device_token"]).toBe("t".repeat(64));
    const messages = body["messages"] as Array<{ role: string; content: string }>;
    expect(messages[0]!.role).toBe("user");
    // prompt parity: the 5-layer stack + the registered schema rendered into the Task layer
    expect(messages[0]!.content).toContain("# Disposition");
    expect(messages[0]!.content).toContain('Produce exactly one "axis-probe"');
    expect(messages[0]!.content).toContain('"axis"');
    const context = body["context"] as Record<string, unknown>;
    expect(context["override_tier"]).toBe("flash"); // economy mapped through tierMap
    expect(body["budget"]).toMatchObject({ tokens: 700 });
  });

  it("omits override_tier when the tier is unmapped (Bifrost default routing)", async () => {
    const { fn, calls } = fakeFetch({ body: '{"axis":"a","value":0.1}' });
    const invoke = makeBifrostInvoker({ url: "https://bifrost.test", deviceToken: "x", fetchFn: fn });
    await invoke(ctxFor(prober));
    const context = calls[0]!.body["context"] as Record<string, unknown>;
    expect("override_tier" in context).toBe(false);
  });

  it("tolerates an object body and surfaces cost as a result event", async () => {
    const { fn } = fakeFetch({ body: { axis: "b", value: 0.4 }, cost: { usd: 0.0123 } });
    const events: AgentStreamEvent[] = [];
    const invoke = makeBifrostInvoker({ url: "https://bifrost.test", deviceToken: "x", fetchFn: fn });
    const out = await invoke({ ...ctxFor(prober), onEvent: (ev) => events.push(ev) });
    expect(out).toEqual({ axis: "b", value: 0.4 });
    const result = events.find((e) => e.type === "result");
    expect((result?.raw as Record<string, unknown>)["total_cost_usd"]).toBe(0.0123);
  });

  it("throws with status + body slice on a non-2xx reply", async () => {
    const { fn } = fakeFetch({ error: "budget exceeded" }, 402);
    const invoke = makeBifrostInvoker({ url: "https://bifrost.test", deviceToken: "x", fetchFn: fn });
    await expect(invoke(ctxFor(prober))).rejects.toThrow(/\/v1\/generate 402/);
  });

  it("runs end-to-end under runGig: output sealed, Bifrost usd folded into GigResult.usage", async () => {
    const registry = createRegistry();
    registry.registerType(probe);
    const { fn } = fakeFetch({ body: '{"axis":"north","value":0.7}', cost: 0.002 });
    const standard: Standard = {
      slug: "one-probe", domain: "etude", agents: [prober],
      phases: [{ name: "probe", chairs: [{ role: "p", agent_slug: "axis-prober", depends_on: [], input_contract: [], output_contract: ["axis-probe"], required_skills: [] }] }],
    };
    const res = await runGig(standard, {}, {
      outputs: createOutputStore(registry),
      ledger: new MemoryLedger(),
      invoke: makeBifrostInvoker({ url: "https://bifrost.test", deviceToken: "x", registry, fetchFn: fn }),
    });
    expect(res.outputs).toHaveLength(1);
    expect(res.outputs[0]!.data).toEqual({ axis: "north", value: 0.7 });
    expect(res.usage?.total_cost_usd).toBeCloseTo(0.002);
  });

  // ── #235 — the synthesized result event must not fabricate what Bifrost never said ────────
  it("#235 — does NOT fold hardcoded zero token counts into settled usage", async () => {
    const { fn } = fakeFetch({ body: '{"axis":"b","value":0.4}', cost: { usd: 0.0123 } });
    const events: AgentStreamEvent[] = [];
    const invoke = makeBifrostInvoker({ url: "https://bifrost.test", deviceToken: "x", fetchFn: fn });
    await invoke({ ...ctxFor(prober), onEvent: (ev) => events.push(ev) });
    const raw = events.find((e) => e.type === "result")?.raw as Record<string, unknown>;
    expect(raw["total_cost_usd"], "the cost Bifrost DID report is still forwarded").toBe(0.0123);
    // THE DEFECT: `usage: { input_tokens: 0, output_tokens: 0 }` was hardcoded, so every
    // Bifrost invocation asserted "zero tokens" as fact into the field documented as settled
    // spend. Bifrost's /v1/generate reply carries no token counts — the honest value is absent.
    expect(raw["usage"], "Bifrost reports no token counts — none may be invented").toBeUndefined();
  });

  it("#235 — a reply with no cost at all reports NOTHING, not $0.00", async () => {
    const { fn } = fakeFetch({ body: '{"axis":"b","value":0.4}' }); // no `cost` key
    const events: AgentStreamEvent[] = [];
    const invoke = makeBifrostInvoker({ url: "https://bifrost.test", deviceToken: "x", fetchFn: fn });
    await invoke({ ...ctxFor(prober), onEvent: (ev) => events.push(ev) });
    const raw = events.find((e) => e.type === "result")?.raw as Record<string, unknown> | undefined;
    // `usd` fell back to 0 and sawUsage flipped anyway — "$0.00 spent" asserted where
    // "not reported" is the truth.
    expect(raw?.["total_cost_usd"], "an absent cost is unknown, not zero").toBeUndefined();
  });
});
