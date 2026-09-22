// A seat's resolved reasoning effort reaches the wire as OpenRouter's `reasoning.effort`.
//
// Why it matters: reasoning models (DeepSeek v4, measured 22 Sep) spend their reasoning INSIDE
// max_tokens — at a low ceiling the whole budget went to reasoning and `content` came back null. The
// effort is resolved per seat (dispatch > agent > tier default) and carried to the turn loop, which
// dropped it: nothing reached the request. The engine's levels map onto the provider's scale
// (low | medium | high); the two above `high` saturate at `high`, never an unknown value the
// provider would reject.
import { describe, it, expect } from "vitest";
import { makeCompletionsInvoker } from "../src/completions_invoker.js";
import { createRegistry } from "../src/index.js";
import { testAgent } from "./_support/agents.js";

function wire() {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchFn = (async (_u: unknown, init?: { body?: unknown }) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const reply = { model: "m", choices: [{ message: { role: "assistant", content: JSON.stringify({ claim: "c", source: "s" }) }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
    return { ok: true, status: 200, json: async () => reply, text: async () => "" };
  }) as unknown as typeof fetch;
  return { bodies, fetchFn };
}

const registry = createRegistry();
registry.registerType({ slug: "note", extends: "Signal", domain: "demo", schema: { properties: { claim: { type: "string" } } }, required_fields: ["claim"] } as never);
const agent = testAgent({ slug: "seat", primitives: ["SENSE"], input_types: [], output_types: ["note"], domain: "demo", model_tier: "standard" });

async function send(effort?: string) {
  const w = wire();
  const invoke = makeCompletionsInvoker({ baseUrl: "https://x.test/v1", apiKey: "k", registry, tierMap: { standard: "m" }, fetchFn: w.fetchFn });
  await invoke({ agent, phase: "p", role: "s", gig_id: "g", inputs: [], gig_input: {}, output_types: ["note"], ...(effort ? { effort } : {}) } as never);
  return w.bodies[0]!;
}

describe("reasoning effort reaches the wire", () => {
  it("E1 — each engine level maps onto the provider's scale", async () => {
    expect((await send("low"))["reasoning"]).toEqual({ effort: "low" });
    expect((await send("medium"))["reasoning"]).toEqual({ effort: "medium" });
    expect((await send("high"))["reasoning"]).toEqual({ effort: "high" });
    expect((await send("xhigh"))["reasoning"]).toEqual({ effort: "high" });
    expect((await send("max"))["reasoning"]).toEqual({ effort: "high" });
  });

  it("E2 — no resolved effort, no reasoning field: the provider's own default stands", async () => {
    expect("reasoning" in (await send())).toBe(false);
  });
});
