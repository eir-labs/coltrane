// RED — the seat's first action is measured, and its context has a ceiling.
//
// Slice 3 of the seat-briefing plan. The target is "a seat's first useful action within 1-2 minutes,
// in tens of thousands of tokens", and today nothing can go red against it: chair_complete carries
// only duration_ms, and the turn loop measures context_tokens every round and enforces nothing.
// Measured by hand instead, three times this week: drafting seats reached their first write after
// 6.9 and 12.0 minutes with context climbing from 27k to ~300k tokens (gigs 6ed46423, 2ba9b00d).
// A target nobody records is a slogan. These laws make it a field and a stop.
import { describe, it, expect } from "vitest";
import { testAgent } from "./_support/agents.js";
import { coreInvariantFields } from "./_support/specs.js";
import { createRegistry, createOutputStore, MemoryLedger, runGig, type Standard, type AgentInvoker, type GigProgressEvent } from "../src";
import { loadTurnLoop, scriptedPort, user, answers, calls } from "./spec_turn_loop_fixtures.js";
import { recordingTools, type McpToolDef } from "./spec_completions_fixtures.js";

const TOOLS: McpToolDef[] = [{ name: "mcp__s__read", inputSchema: { type: "object" } }];

describe("the turn loop stops at a context ceiling", () => {
  const script = () => scriptedPort([
    calls("mcp__s__read", { path: "a" }, "t1", { input_tokens: 800, output_tokens: 10 }),
    calls("mcp__s__read", { path: "b" }, "t2", { input_tokens: 1200, output_tokens: 10 }),
    answers("done reading", { input_tokens: 1300, output_tokens: 10 }),
  ]);

  it("the round whose context crosses max_context_tokens ends the turn with stop `context_limit`, and no further model call is made", async () => {
    const L = await loadTurnLoop();
    const { port, requests } = script();
    const { source } = recordingTools(TOOLS);
    const r = await L.runTurn([user("go")], {
      port, model: "m-1", tools: source, allow: ["mcp__s__read"], max_rounds: 8, max_context_tokens: 1000,
    } as never);
    expect(r.stop, "the loop measured a context over its ceiling and kept calling the model").toBe("context_limit");
    expect(requests, "a model call was made after the ceiling was crossed").toHaveLength(2);
  });

  it("control — with no ceiling the same script runs to `done`", async () => {
    // Green today. A fix that stops every turn at some default ceiling goes red.
    const L = await loadTurnLoop();
    const { port, requests } = script();
    const { source } = recordingTools(TOOLS);
    const r = await L.runTurn([user("go")], { port, model: "m-1", tools: source, allow: ["mcp__s__read"], max_rounds: 8 });
    expect(r.stop).toBe("done");
    expect(requests).toHaveLength(3);
  });
});

describe("chair_complete records the seat's first write", () => {
  const seat = testAgent({ slug: "writer", primitives: ["SENSE"], input_types: [], output_types: ["note"], domain: "demo" });
  const standard = {
    slug: "metrics", domain: "demo", agents: [seat],
    phases: [{ name: "p", chairs: [{ role: "w", agent_slug: "writer", depends_on: [], input_contract: [], output_contract: ["note"], required_skills: [] }] }],
  } as unknown as Standard;

  async function run(invoke: AgentInvoker) {
    const registry = createRegistry();
    registry.registerType({ slug: "note", extends: "Signal", domain: "demo", schema: { properties: { value: { type: "string" } } }, required_fields: [] } as never);
    const events: GigProgressEvent[] = [];
    await runGig(standard, {}, { outputs: createOutputStore(registry), ledger: new MemoryLedger(), invoke, onProgress: (e: GigProgressEvent) => events.push(e) } as never);
    return events.find((e) => e.type === "chair_complete") as (GigProgressEvent & Record<string, unknown>) | undefined;
  }

  const usage = (input: number, cache_read: number) => ({ type: "assistant", raw: { type: "assistant", message: { usage: { input_tokens: input, cache_read_input_tokens: cache_read, cache_creation_input_tokens: 0, output_tokens: 5 } } } });

  it("first_write_ms is the time from chair start to the first Write/Edit, and context_tokens_at_first_write is the context the seat carried then", async () => {
    const done = await run(async (ctx) => {
      ctx.onEvent?.(usage(1_000, 26_000));
      ctx.onEvent?.({ type: "tool_use", tool: "Read" });
      await new Promise((r) => setTimeout(r, 60));
      ctx.onEvent?.(usage(2_000, 38_000));
      ctx.onEvent?.({ type: "tool_use", tool: "Write" });
      await new Promise((r) => setTimeout(r, 30));
      ctx.onEvent?.(usage(3_000, 90_000));
      ctx.onEvent?.({ type: "tool_use", tool: "Edit" });
      return { ...coreInvariantFields("Signal"), value: "written" };
    });
    expect(done, "no chair_complete was emitted").toBeDefined();
    expect(typeof done!["first_write_ms"], "chair_complete does not record when the seat first wrote anything").toBe("number");
    expect(done!["first_write_ms"] as number).toBeGreaterThanOrEqual(55);
    expect(done!["first_write_ms"] as number, "first_write_ms must be the FIRST write, not the last").toBeLessThan(done!.duration_ms as number);
    expect(done!["context_tokens_at_first_write"], "the context at first write is input + cache_read + cache_creation of the last usage before it").toBe(40_000);
  });

  it("a seat that never writes records first_write_ms as null, never an absent field or a stand-in 0", async () => {
    const done = await run(async (ctx) => {
      ctx.onEvent?.(usage(1_000, 5_000));
      ctx.onEvent?.({ type: "tool_use", tool: "Read" });
      return { ...coreInvariantFields("Signal"), value: "read only" };
    });
    expect(done && "first_write_ms" in done, "a seat that never wrote is indistinguishable from a chair nobody measured").toBe(true);
    expect(done!["first_write_ms"]).toBeNull();
    expect(done!["context_tokens_at_first_write"]).toBeNull();
  });
});
