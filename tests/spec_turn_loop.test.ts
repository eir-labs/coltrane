// RED — the shared turn loop. Spec: docs/specs/turn-loop.red-spec.md
//
// ONE LOOP, THREE CALLERS. Gig chairs (AgentInvoker), residents (the reside cortex seam) and
// `coltrane play` all want the same thing: a seat takes turns, a model thinks, tools run, and spend
// is counted. The loop the completions invoker carries inline today does all four badly in ways no
// law caught — it counted only the last round, offered every tool the source listed, lost its
// timeout whenever a gig signal existed, and parsed empty content when it ran out of rounds.
//
// WHY ACCOUNTING IS HERE FROM THE FIRST COMMIT. The operator's own 30-day census priced at API list
// rates: ~$18.6k, 77% of it cache reads, 346k tokens of context per call on average. A replacement
// harness saves money only by keeping contexts small and routing turns cheaply, and neither can be
// steered without context size and cost on every round. The same number is why the transcript is
// APPEND-ONLY: a rewritten prefix forfeits the cache.
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { TEST_BEHAVIOR } from "./_support/agents.js";
import {
  createRegistry,
  createOutputStore,
  MemoryLedger,
  runGig,
  type Agent,
  type AgentInvocationContext,
  type DomainType,
  type Standard,
} from "../src/index.js";
import {
  loadCompletions,
  fakeCompletions,
  recordingTools,
  type McpToolDef,
} from "./spec_completions_fixtures.js";
import {
  loadTurnLoop,
  loadChatPort,
  scriptedPort,
  hangingPort,
  user,
  answers,
  calls,
  type ModelReply,
  type TurnEvent,
  type TurnMessage,
  type TurnUsage,
} from "./spec_turn_loop_fixtures.js";

const SRC = new URL("../src/", import.meta.url).pathname;

const TOOLS: McpToolDef[] = [
  { name: "mcp__s__read", description: "read a file", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
  { name: "mcp__s__write", inputSchema: { type: "object" } },
  { name: "mcp__web__fetch", inputSchema: { type: "object" } },
  { name: "mcp__admin__drop_table", inputSchema: { type: "object" } },
];

const u = (input_tokens: number, output_tokens: number, extra: TurnUsage = {}): TurnUsage => ({
  input_tokens,
  output_tokens,
  ...extra,
});

// ── the loop ─────────────────────────────────────────────────────────────────────────────────────

describe("LAW 1 — a plain answer ends the turn", () => {
  it("stops `done` with the text, and appends the assistant turn to the transcript", async () => {
    const L = await loadTurnLoop();
    const { port } = scriptedPort([answers("hello")]);
    const r = await L.runTurn([user("hi")], { port, model: "m-1", max_rounds: 4 });
    expect(r.stop).toBe("done");
    expect(r.text).toBe("hello");
    expect(r.messages).toHaveLength(2);
    expect(r.messages[1]).toMatchObject({ role: "assistant", content: "hello" });
  });
});

describe("LAW 2 — a tool call reaches the source and its result reaches the next round", () => {
  it("runs the call through the source, then sends the result back to the model", async () => {
    const L = await loadTurnLoop();
    const { port, requests } = scriptedPort([calls("mcp__s__read", { path: "a" }), answers("read it")]);
    const { source, called } = recordingTools(TOOLS, { mcp__s__read: { body: "contents-of-a" } });
    const r = await L.runTurn([user("go")], { port, model: "m-1", tools: source, allow: ["mcp__s__read"], max_rounds: 4 });

    expect(called).toEqual([{ name: "mcp__s__read", args: { path: "a" } }]);
    const toolMsg = requests[1]?.messages.find((m) => m.role === "tool");
    expect(toolMsg, "the second round never saw the tool result").toMatchObject({
      role: "tool",
      tool_call_id: "t1",
      name: "mcp__s__read",
    });
    expect((toolMsg as { content: string }).content).toContain("contents-of-a");
    expect(r.stop).toBe("done");
  });
});

describe("LAW 3 — usage is SUMMED across every round", () => {
  // THE DEFECT: the inline loop overwrote `reply` each round and reported only the last one — and
  // the earlier rounds are the cheap ones only in a world where context does not grow.
  it("three rounds report the sum of all three, and each round keeps its own record", async () => {
    const L = await loadTurnLoop();
    const { port } = scriptedPort([
      calls("mcp__s__read", {}, "a", u(100, 10)),
      calls("mcp__s__read", {}, "b", u(200, 20)),
      answers("ok", u(300, 30)),
    ]);
    const { source } = recordingTools(TOOLS);
    const r = await L.runTurn([user("go")], { port, model: "m-1", tools: source, allow: ["mcp__s__*"], max_rounds: 5 });

    expect(r.totals.rounds).toBe(3);
    expect(r.totals.input_tokens, "only some rounds were counted").toBe(600);
    expect(r.totals.output_tokens).toBe(60);
    expect(r.rounds.map((x) => x.usage?.input_tokens)).toEqual([100, 200, 300]);
  });
});

describe("LAW 4 — context size is reported per round, with its peak", () => {
  it("context = uncached input + cache read + cache write", async () => {
    const L = await loadTurnLoop();
    const { port } = scriptedPort([
      calls("mcp__s__read", {}, "a", u(50, 5, { cache_read_tokens: 900, cache_write_tokens: 50 })),
      answers("ok", u(10, 5, { cache_read_tokens: 1990, cache_write_tokens: 0 })),
    ]);
    const { source } = recordingTools(TOOLS);
    const r = await L.runTurn([user("go")], { port, model: "m-1", tools: source, allow: ["mcp__s__read"], max_rounds: 4 });

    expect(r.rounds.map((x) => x.context_tokens)).toEqual([1000, 2000]);
    expect(r.totals.peak_context_tokens).toBe(2000);
    expect(r.totals.cache_read_tokens).toBe(2890);
    expect(r.totals.cache_write_tokens).toBe(50);
  });
});

describe("LAW 5 — cost is priced from the deployment's table, by the model that SERVED the round", () => {
  it("prices every token class and sums the rounds", async () => {
    const L = await loadTurnLoop();
    const usage = u(200_000, 10_000, { cache_read_tokens: 800_000, cache_write_tokens: 0 });
    // The request names an alias; the transport says "m-1" served it. The chain prices what RAN.
    const { port } = scriptedPort([
      calls("mcp__s__read", {}, "a", usage, "m-1"),
      answers("ok", usage, "m-1"),
    ]);
    const { source } = recordingTools(TOOLS);
    const r = await L.runTurn([user("go")], {
      port,
      model: "some-alias",
      tools: source,
      allow: ["mcp__s__read"],
      max_rounds: 4,
      prices: { "m-1": { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 } },
    });
    // 0.2M × $5 + 0.01M × $25 + 0.8M × $0.50 = $1.65 per round
    expect(r.rounds[0]?.cost_usd).toBeCloseTo(1.65, 9);
    expect(r.totals.cost_usd).toBeCloseTo(3.3, 9);
    expect(r.totals.unpriced_rounds).toBe(0);
  });
});

describe("LAW 6 — spend that cannot be priced is UNPRICED, never $0", () => {
  it("a round served by a model with no price is counted unpriced and left out of the sum", async () => {
    const L = await loadTurnLoop();
    const { port } = scriptedPort([
      calls("mcp__s__read", {}, "a", u(1_000_000, 0), "m-1"),
      answers("ok", u(1_000_000, 0), "m-unknown"),
    ]);
    const { source } = recordingTools(TOOLS);
    const r = await L.runTurn([user("go")], {
      port, model: "m-1", tools: source, allow: ["mcp__s__read"], max_rounds: 4,
      prices: { "m-1": { input: 5, output: 25 } },
    });
    expect(r.rounds[1]?.cost_usd, "an unpriced model was priced anyway").toBeUndefined();
    expect(r.totals.unpriced_rounds).toBe(1);
    expect(r.totals.cost_usd).toBeCloseTo(5, 9);
  });

  it("a reported token class with no price makes the round unpriced, not priced at some other rate", async () => {
    const L = await loadTurnLoop();
    const { port } = scriptedPort([answers("ok", u(1000, 10, { cache_read_tokens: 50_000 }))]);
    const r = await L.runTurn([user("go")], {
      port, model: "m-1", max_rounds: 2,
      prices: { "m-1": { input: 5, output: 25 } }, // no cache_read price
    });
    expect(r.rounds[0]?.cost_usd, "cache reads were priced at a rate nobody supplied").toBeUndefined();
    expect(r.totals.unpriced_rounds).toBe(1);
  });
});

describe("LAW 7 — a round with no usage is UNREPORTED, not a zero-token round", () => {
  it("leaves usage, context and cost absent, and counts it", async () => {
    const L = await loadTurnLoop();
    const { port } = scriptedPort([answers("ok")]);
    const r = await L.runTurn([user("go")], {
      port, model: "m-1", max_rounds: 2, prices: { "m-1": { input: 5, output: 25 } },
    });
    expect(r.rounds[0]?.usage).toBeUndefined();
    expect(r.rounds[0]?.context_tokens, "no usage became a zero-token context").toBeUndefined();
    expect(r.rounds[0]?.cost_usd, "no usage became $0").toBeUndefined();
    expect(r.totals.unreported_rounds).toBe(1);
    expect(r.totals.unpriced_rounds).toBe(0);
  });
});

describe("LAW 8 — only allowed tools are offered", () => {
  it("offers the allowed subset (exact and `*` prefix), in the source's own order", async () => {
    const L = await loadTurnLoop();
    const { port, requests } = scriptedPort([answers("ok")]);
    const { source } = recordingTools(TOOLS);
    await L.runTurn([user("go")], { port, model: "m-1", tools: source, allow: ["mcp__web__*", "mcp__s__read"], max_rounds: 2 });
    expect(requests[0]?.tools.map((t) => t.name), "an unallowed tool was offered").toEqual([
      "mcp__s__read",
      "mcp__web__fetch",
    ]);
  });

  it("no allow list offers NO tools — absent means decline", async () => {
    const L = await loadTurnLoop();
    const { port, requests } = scriptedPort([answers("ok")]);
    const { source } = recordingTools(TOOLS);
    await L.runTurn([user("go")], { port, model: "m-1", tools: source, max_rounds: 2 });
    expect(requests[0]?.tools, "tools were offered with no allow list").toEqual([]);
  });

  it("the offered list is identical on every round, so the prefix stays cacheable", async () => {
    const L = await loadTurnLoop();
    const { port, requests } = scriptedPort([calls("mcp__s__read", {}), answers("ok")]);
    const { source } = recordingTools(TOOLS);
    await L.runTurn([user("go")], { port, model: "m-1", tools: source, allow: ["mcp__s__*", "mcp__web__*"], max_rounds: 3 });
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1]?.tools)).toBe(JSON.stringify(requests[0]?.tools));
  });
});

describe("LAW 9 — a call to a tool that was never offered does not reach the source", () => {
  it("answers the model with an error naming the tool, and the source is never called", async () => {
    const L = await loadTurnLoop();
    const { port, requests } = scriptedPort([calls("mcp__admin__drop_table", { table: "users" }), answers("ok")]);
    const { source, called } = recordingTools(TOOLS);
    const r = await L.runTurn([user("go")], { port, model: "m-1", tools: source, allow: ["mcp__s__read"], max_rounds: 3 });

    expect(called, "an unoffered tool reached the source").toEqual([]);
    const toolMsg = requests[1]?.messages.find((m) => m.role === "tool") as
      | { is_error?: boolean; content: string }
      | undefined;
    expect(toolMsg?.is_error).toBe(true);
    expect(toolMsg?.content).toContain("mcp__admin__drop_table");
    expect(r.stop).toBe("done");
  });
});

describe("LAW 10 — running out of rounds is a typed stop that leaves a resumable transcript", () => {
  it("stops `round_limit` after exactly max_rounds calls, with every tool call answered", async () => {
    const L = await loadTurnLoop();
    const { port, requests } = scriptedPort((_req, i) => calls("mcp__s__read", {}, `t${i}`));
    const { source, called } = recordingTools(TOOLS);
    const r = await L.runTurn([user("go")], { port, model: "m-1", tools: source, allow: ["mcp__s__read"], max_rounds: 3 });

    expect(r.stop).toBe("round_limit");
    expect(requests, "the loop did not stop at max_rounds").toHaveLength(3);
    expect(called).toHaveLength(3);
    // A transcript ending on an unanswered tool call is not a valid continuation on any wire.
    const lastAssistant = [...r.messages].reverse().find((m) => m.role === "assistant") as
      | { tool_calls?: { id: string }[] }
      | undefined;
    const answered = new Set(r.messages.filter((m) => m.role === "tool").map((m) => (m as { tool_call_id: string }).tool_call_id));
    for (const c of lastAssistant?.tool_calls ?? []) {
      expect(answered.has(c.id), `tool call ${c.id} was left unanswered`).toBe(true);
    }
  });
});

describe("LAW 11 — the per-call timeout fires even when the caller supplies a signal", () => {
  // THE DEFECT: `signal: ctx.signal ?? controller.signal`. runGig threads a signal into every
  // invocation, so in every real run the timeout controller was never wired to anything.
  it("stops `timeout` while the caller's signal never fires", async () => {
    const L = await loadTurnLoop();
    const caller = new AbortController();
    const r = await L.runTurn([user("go")], {
      port: hangingPort(1500), model: "m-1", max_rounds: 2, timeout_ms: 30, signal: caller.signal,
    });
    expect(r.stop, "the timeout never fired — the caller's signal replaced it").toBe("timeout");
  });
});

describe("LAW 12 — a caller abort is `aborted`, not a transport failure", () => {
  it("stops `aborted` when the caller's signal fires first", async () => {
    const L = await loadTurnLoop();
    const caller = new AbortController();
    setTimeout(() => caller.abort(), 20);
    const r = await L.runTurn([user("go")], {
      port: hangingPort(1500), model: "m-1", max_rounds: 2, timeout_ms: 1000, signal: caller.signal,
    });
    expect(r.stop).toBe("aborted");
  });
});

describe("LAW 13 — a transport failure is a typed stop, never a throw", () => {
  it("a throwing port stops `transport_failed` and carries the reason", async () => {
    const L = await loadTurnLoop();
    const port = async (): Promise<ModelReply> => {
      throw new Error("completions 502: bad gateway");
    };
    let threw: unknown = null;
    let r: Awaited<ReturnType<typeof L.runTurn>> | undefined;
    try {
      r = await L.runTurn([user("go")], { port, model: "m-1", max_rounds: 2 });
    } catch (e) {
      threw = e;
    }
    expect(threw, "runTurn threw instead of stopping").toBe(null);
    expect(r?.stop).toBe("transport_failed");
    expect(r?.error).toContain("502");
  });
});

describe("LAW 14 — events fire live, before the next model call", () => {
  it("emits tool_use → tool_result → round_end per round, and round_end carries the record", async () => {
    const L = await loadTurnLoop();
    const events: TurnEvent[] = [];
    const seenAtCall: number[] = [];
    const { port } = scriptedPort((_req, i) => {
      seenAtCall.push(events.length);
      return i === 0 ? calls("mcp__s__read", { path: "a" }, "t1", u(100, 10)) : answers("ok", u(150, 5));
    });
    const { source } = recordingTools(TOOLS);
    await L.runTurn([user("go")], {
      port, model: "m-1", tools: source, allow: ["mcp__s__read"], max_rounds: 3, onEvent: (e) => events.push(e),
    });

    expect(events.map((e) => e.type)).toEqual(["tool_use", "tool_result", "round_end", "round_end"]);
    expect(seenAtCall[1], "round 1's events were not emitted before round 2 began").toBe(3);
    const firstEnd = events[2] as Extract<TurnEvent, { type: "round_end" }>;
    expect(firstEnd.record.usage?.input_tokens).toBe(100);
    expect(firstEnd.record.context_tokens).toBe(100);
  });
});

describe("LAW 15 — the transcript is append-only", () => {
  // Cache reads were 77% of the census bill, and a cache is a prefix match: one changed byte in an
  // earlier turn re-bills everything after it. Preserved-thinking models reject edited history.
  it("a continuation re-sends earlier turns byte-identical, keeps `raw`, and never mutates the caller's array", async () => {
    const L = await loadTurnLoop();
    const raw = { opaque: [1, 2, 3], signature: "zz" };
    const { port, requests } = scriptedPort((_req, i) =>
      i === 0 ? { model: "m-1", message: { content: "first", raw }, stop: "end" } : answers("second"),
    );

    const turn1 = await L.runTurn([user("one")], { port, model: "m-1", max_rounds: 2 });
    const sent1 = JSON.stringify(turn1.messages);
    const history: TurnMessage[] = [...turn1.messages, user("two")];
    const turn2 = await L.runTurn(history, { port, model: "m-1", max_rounds: 2 });

    expect(history, "runTurn mutated the caller's array").toHaveLength(3);
    expect(
      JSON.stringify(requests[1]?.messages.slice(0, turn1.messages.length)),
      "an earlier turn was rewritten on the wire",
    ).toBe(sent1);
    expect((requests[1]?.messages[1] as { raw?: unknown }).raw, "the port's opaque state was dropped").toEqual(raw);
    expect(turn2.messages.slice(0, history.length)).toEqual(history);
  });
});

// ── the chat-completions port ───────────────────────────────────────────────────────────────────

describe("LAW 16 — the port reports cached prompt tokens as cache reads", () => {
  it("splits prompt_tokens into uncached input and cache_read, and names the served model", async () => {
    const P = await loadChatPort();
    const { fn } = fakeCompletions([
      {
        choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
        model: "served-1",
        usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 800 } },
      },
    ]);
    const port = P.makeChatCompletionsPort({ baseUrl: "https://endpoint.test/v1", apiKey: "k", fetchFn: fn });
    const reply = await port({ model: "m", messages: [user("x")], tools: [], signal: new AbortController().signal });
    expect(reply.usage).toEqual({ input_tokens: 200, cache_read_tokens: 800, output_tokens: 50 });
    expect(reply.model).toBe("served-1");
    expect(reply.message.content).toBe("hi");
  });
});

describe("LAW 17 — the port speaks the wire faithfully", () => {
  it("round-trips tool calls, tool results and tool names through the wire's name rules", async () => {
    const P = await loadChatPort();
    const C = await loadCompletions();
    const odd = "mcp__a.b__c-d"; // not wire-safe: must be encoded out and decoded back
    const wire = C.encodeToolName(odd);
    const { fn, calls: sent } = fakeCompletions([
      {
        choices: [{
          message: { role: "assistant", content: null, tool_calls: [{ id: "c2", type: "function", function: { name: wire, arguments: '{"q":2}' } }] },
          finish_reason: "tool_calls",
        }],
        model: "served-1",
      },
    ]);
    const port = P.makeChatCompletionsPort({ baseUrl: "https://endpoint.test/v1", apiKey: "k", fetchFn: fn });
    const reply = await port({
      model: "m",
      messages: [
        user("x"),
        { role: "assistant", content: null, tool_calls: [{ id: "c1", name: odd, args: { q: 1 } }] },
        { role: "tool", tool_call_id: "c1", name: odd, content: "r" },
      ],
      tools: [{ name: odd, inputSchema: { type: "object" } }],
      signal: new AbortController().signal,
    });

    const body = sent[0]!.body as {
      model: string;
      messages: { tool_calls?: { function: { name: string; arguments: string } }[] }[];
      tools: { function: { name: string } }[];
    };
    expect(sent[0]!.url).toBe("https://endpoint.test/v1/chat/completions");
    expect(body.model).toBe("m");
    expect(body.tools[0]?.function.name).toBe(wire);
    expect(body.messages[1]?.tool_calls?.[0]?.function.name).toBe(wire);
    expect(JSON.parse(body.messages[1]?.tool_calls?.[0]?.function.arguments ?? "null")).toEqual({ q: 1 });
    expect(body.messages[2]).toMatchObject({ role: "tool", tool_call_id: "c1", content: "r" });
    expect(reply.message.tool_calls, "the reply's tool call did not decode to the MCP name").toEqual([
      { id: "c2", name: odd, args: { q: 2 } },
    ]);
  });

  it("a non-2xx reply throws with its status, for the loop to type", async () => {
    const P = await loadChatPort();
    const { fn } = fakeCompletions([{ error: "upstream down" }], 502);
    const port = P.makeChatCompletionsPort({ baseUrl: "https://endpoint.test/v1", apiKey: "k", fetchFn: fn });
    await expect(port({ model: "m", messages: [user("x")], tools: [], signal: new AbortController().signal })).rejects.toThrow(/502/);
  });
});

describe("LAW 18 — the loop and the port name no vendor and read no environment", () => {
  it("both files are provider-neutral", () => {
    for (const file of ["turn_loop.ts", "chat_completions_port.ts"]) {
      const path = join(SRC, file);
      expect(existsSync(path), `src/${file} does not exist yet`).toBe(true);
      const text = readFileSync(path, "utf8");
      expect(text, `src/${file} reads the environment; config belongs in opts`).not.toMatch(/process\.env\[/);
      for (const name of ["openrouter", "openai.com", "anthropic", "bifrost", "deepseek", "claude-"]) {
        expect(text.toLowerCase(), `src/${file} names the provider "${name}"`).not.toContain(name);
      }
    }
  });
});

// ── the last inch: the invoker runs on the loop, and the loop's numbers reach the gig ────────────

const note: DomainType = {
  slug: "research-note",
  extends: "Signal",
  domain: "research",
  schema: { properties: { claim: { type: "string" }, source: { type: "string" } } },
  required_fields: ["claim", "source"],
};

const researcher: Agent = {
  ...TEST_BEHAVIOR,
  slug: "researcher",
  primitives: ["SENSE"],
  input_types: [],
  output_types: ["research-note"],
  domain: "research",
  model_tier: "economy",
  allowed_tools: ["mcp__coltrane__output_query"],
};

const ENGINE_TOOLS: McpToolDef[] = [
  { name: "mcp__coltrane__output_query", inputSchema: { type: "object" } },
  { name: "mcp__coltrane__agent_define", inputSchema: { type: "object" } },
];

const wireUsage = (prompt_tokens: number, completion_tokens: number) => ({ prompt_tokens, completion_tokens });
const toolTurn = (name: string, id: string, usage?: Record<string, unknown>) => ({
  choices: [{
    message: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: "{}" } }] },
    finish_reason: "tool_calls",
  }],
  model: "test-model-x",
  ...(usage ? { usage } : {}),
});
const jsonTurn = (obj: unknown, usage?: Record<string, unknown>) => ({
  choices: [{ message: { role: "assistant", content: JSON.stringify(obj) }, finish_reason: "stop" }],
  model: "test-model-x",
  ...(usage ? { usage } : {}),
});

function ctxFor(agent: Agent, over: Partial<AgentInvocationContext> = {}): AgentInvocationContext {
  return { agent, phase: "gather", inputs: [], gig_input: { goal: "find one claim" }, ...over };
}

function oneChair(agent: Agent): Standard {
  return {
    slug: "one", domain: "research", agents: [agent],
    phases: [{ name: "gather", chairs: [{ role: "r", agent_slug: agent.slug, depends_on: [], input_contract: [], output_contract: ["research-note"], required_skills: [] }] }],
  } as Standard;
}

async function threeRoundGig(prices?: Record<string, { input: number; output: number }>) {
  const C = await loadCompletions();
  const registry = createRegistry();
  registry.registerType(note);
  const { fn } = fakeCompletions([
    toolTurn("mcp__coltrane__output_query", "a", wireUsage(100, 10)),
    toolTurn("mcp__coltrane__output_query", "b", wireUsage(200, 20)),
    jsonTurn({ claim: "c", source: "sealed://g" }, wireUsage(300, 30)),
  ]);
  const { source } = recordingTools(ENGINE_TOOLS);
  return runGig(oneChair(researcher), {}, {
    outputs: createOutputStore(registry),
    ledger: new MemoryLedger(),
    invoke: C.makeCompletionsInvoker({
      baseUrl: "https://endpoint.test/v1", apiKey: "k", registry,
      tierMap: { economy: "cheap-model-1" }, fetchFn: fn, tools: source,
      ...(prices ? { prices } : {}),
    }),
  });
}

describe("LAW 19 — a chair's tokens from EVERY round reach GigResult.usage", () => {
  it("a three-round chair settles the sum, not the last round", async () => {
    const res = await threeRoundGig();
    expect(res.outputs).toHaveLength(1);
    expect(res.usage?.input_tokens, "the gig settled only part of the chair's rounds").toBe(600);
    expect(res.usage?.output_tokens).toBe(60);
  });
});

describe("LAW 20 — priced spend reaches GigResult.usage", () => {
  it("the deployment's price table becomes the gig's settled dollars", async () => {
    const res = await threeRoundGig({ "test-model-x": { input: 1, output: 2 } });
    // (600 × $1 + 60 × $2) / 1M
    expect(res.usage?.total_cost_usd, "the price table never reached the gig").toBeCloseTo(0.00072, 9);
  });
});

describe("LAW 21 — the invoker offers only the chair's grants", () => {
  it("an ungranted tool is not offered, and the model's call to it never reaches the surface", async () => {
    const C = await loadCompletions();
    const { fn, calls: sent } = fakeCompletions([
      toolTurn("mcp__coltrane__agent_define", "x"),
      jsonTurn({ claim: "c", source: "s" }),
    ]);
    const { source, called } = recordingTools(ENGINE_TOOLS);
    await C.makeCompletionsInvoker({
      baseUrl: "https://endpoint.test/v1", apiKey: "k", tierMap: { economy: "cheap-model-1" }, fetchFn: fn, tools: source,
    })(ctxFor(researcher));

    const offered = ((sent[0]?.body["tools"] ?? []) as { function: { name: string } }[]).map((t) => t.function.name);
    expect(offered, "a tool outside the chair's grants was offered").toEqual(["mcp__coltrane__output_query"]);
    expect(called.map((c) => c.name), "an ungranted tool reached the surface").toEqual([]);
  });

  it("a bare in-house grant offers the engine server's tool of that name", async () => {
    const C = await loadCompletions();
    const { fn, calls: sent } = fakeCompletions([jsonTurn({ claim: "c", source: "s" })]);
    const { source } = recordingTools(ENGINE_TOOLS);
    await C.makeCompletionsInvoker({
      baseUrl: "https://endpoint.test/v1", apiKey: "k", tierMap: { economy: "cheap-model-1" }, fetchFn: fn, tools: source,
    })(ctxFor({ ...researcher, allowed_tools: ["output_query"] }));

    const offered = ((sent[0]?.body["tools"] ?? []) as { function: { name: string } }[]).map((t) => t.function.name);
    expect(offered).toEqual(["mcp__coltrane__output_query"]);
  });
});

describe("LAW 22 — the venue narrows what the chair can use", () => {
  it("a granted tool the room does not equip is not offered", async () => {
    const C = await loadCompletions();
    const { fn, calls: sent } = fakeCompletions([jsonTurn({ claim: "c", source: "s" })]);
    const { source } = recordingTools(ENGINE_TOOLS);
    const both: Agent = { ...researcher, allowed_tools: ["mcp__coltrane__output_query", "mcp__coltrane__agent_define"] };
    const room = { equipment: { tools: ["mcp__coltrane__agent_define"] } } as unknown as NonNullable<AgentInvocationContext["venue"]>;
    await C.makeCompletionsInvoker({
      baseUrl: "https://endpoint.test/v1", apiKey: "k", tierMap: { economy: "cheap-model-1" }, fetchFn: fn, tools: source,
    })(ctxFor(both, { venue: room }));

    const offered = ((sent[0]?.body["tools"] ?? []) as { function: { name: string } }[]).map((t) => t.function.name);
    expect(offered, "the room's ceiling was not applied").toEqual(["mcp__coltrane__agent_define"]);
  });
});

describe("LAW 23 — the invoker honours the chair's turn budget", () => {
  it("stops after turn_budget model calls with a typed `round_limit` refusal", async () => {
    const C = await loadCompletions();
    const { fn, calls: sent } = fakeCompletions([toolTurn("mcp__coltrane__output_query", "loop")]);
    const { source } = recordingTools(ENGINE_TOOLS);
    let threw: unknown = null;
    let res: Record<string, unknown> = {};
    try {
      res = (await C.makeCompletionsInvoker({
        baseUrl: "https://endpoint.test/v1", apiKey: "k", tierMap: { economy: "cheap-model-1" }, fetchFn: fn, tools: source,
      })(ctxFor(researcher, { turn_budget: 2 }))) as Record<string, unknown>;
    } catch (e) {
      threw = e;
    }
    expect(threw, "running out of turns threw instead of refusing").toBe(null);
    expect(sent, "the chair's turn budget was ignored").toHaveLength(2);
    expect(res["ok"]).toBe(false);
    expect(res["refusal"]).toBe("round_limit");
  });
});
