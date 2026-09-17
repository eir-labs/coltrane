// RED — contract-tool-wire-name-collision-v1. Two tools a seat cannot tell apart ON THE WIRE are a
// refusal, never an insertion-order winner. Spec: docs/specs/tool-wire-name-collision.red-spec.md.
//
// THE DEFECT (reading src/chat_completions_port.ts at HEAD): the port resolves a reply's function name
// back to its MCP name through
//     const byWireName = new Map(req.tools.map((t) => [encodeToolName(t.name), t.name]));   (~:214)
// `new Map(entries)` silently keeps the LAST duplicate key, so when two OFFERED tools encode to the
// same wire name the model is sent two identical function definitions, calls that name, and the port
// resolves it to whichever tool won the Map — the OTHER server's tool runs and everyone reads success.
// The fix the K6 witness asked for is a REFUSAL, one layer down and reachable, keyed on the offered
// SET (`new Set(listed.map(encodeToolName)).size === listed.length`), not on the digest separating two
// strings.
//
// THE ENFORCEMENT DOES NOT EXIST YET. `TurnLoopOptions` has no `wire_name`, `TurnStop` has no
// `tool_name_collision`, `COMPLETIONS_REFUSALS` does not list it, and the port builds its Map from a
// set it never checks. Every law below FAILS today on an assertion stating the contract's reason.
//
// TESTING METHOD — example-based (the obligations are specific behaviours: a specific colliding set
// refused, a specific distinct set allowed), at the three real seams the contract's outputs cross:
//   · runTurn directly, with a stub ModelPort + ToolSource and an injected `wire_name` that collapses
//     two DISTINCT names onto one — the exact shape of the contract (O1, I1, I2, F1).
//   · makeCompletionsInvoker with a fake fetch that must never be called — the typed refusal and the
//     no-model-call guarantee (O2).
//   · makeChatCompletionsPort directly, refusing a colliding `tools` request before it fetches (O3).
//
// WHY O2/O3 use two tools of the SAME MCP name: a DISTINCT-name collision under the real
// `encodeToolName` exists only at the third tier — two long names that share a 23-byte prefix AND
// collide on a 64-bit digest — which is infeasible to construct deterministically in a test (birthday
// bound ~2^32). Identical names are the hand-constructible instance of the SAME set-size violation the
// contract refuses (`new Set(encoded).size < length`), and they exercise the real `encodeToolName`
// (identity on a safe name). The runTurn laws exhibit the DISTINCT-name collapse directly, through the
// injected `wire_name` the contract adds for exactly that purpose.
import { describe, it, expect } from "vitest";
import {
  runTurn,
  type ModelPort,
  type ModelRequest,
  type ModelReply,
  type ToolDef,
  type ToolSource,
  type TurnLoopOptions,
  type TurnMessage,
} from "../src/turn_loop.js";
import { makeChatCompletionsPort, encodeToolName } from "../src/chat_completions_port.js";
import { TEST_BEHAVIOR } from "./_support/agents.js";
import type { Agent, AgentInvocationContext } from "../src";
import {
  loadCompletions,
  fakeCompletions,
  recordingTools,
  saysJson,
  type McpToolDef,
} from "./spec_completions_fixtures.js";

// `wire_name` is the option the contract ADDS to TurnLoopOptions (O1); it does not exist on the type
// yet, so the laws attach it through this local widening and runTurn reads it once the enforcement lands.
type WireOpts = TurnLoopOptions & { wire_name?: (name: string) => string };

// A stub model port that records every request and just answers, so a turn that reaches it stops
// `done` at round 1. The collision laws assert this port is NEVER called.
function stubPort(): { port: ModelPort; calls: ModelRequest[] } {
  const calls: ModelRequest[] = [];
  const port: ModelPort = async (req) => {
    calls.push(req);
    const reply: ModelReply = { model: "served-model", message: { content: "answer" } };
    return reply;
  };
  return { port, calls };
}

const listing = (defs: readonly ToolDef[]): ToolSource => ({
  list: async () => defs,
  call: async () => "ok",
});

// A wire-name encoding that COLLAPSES two distinct MCP names onto one wire name, and is the identity on
// everything else — the two-servers-one-wire-name collision, made deterministic.
const collapsing =
  (a: string, b: string, wire: string) =>
  (name: string): string =>
    name === a || name === b ? wire : name;

const td = (name: string): ToolDef => ({ name, inputSchema: { type: "object" } });
const USER: TurnMessage = { role: "user", content: "go" };

// ── O1 — runTurn stops tool_name_collision BEFORE any model call, naming both and the wire name ──────
describe("O1 — an offered set whose wire names collide stops the turn tool_name_collision before any model call", () => {
  it("O1 — two offered tools that map to one wire name stop tool_name_collision before any model call, naming both MCP names and the shared wire name", async () => {
    const { port, calls } = stubPort();
    const opts: WireOpts = {
      port,
      model: "m",
      tools: listing([td("mcp__a__foo"), td("mcp__b__foo")]),
      allow: ["mcp__a__foo", "mcp__b__foo"],
      max_rounds: 3,
      wire_name: collapsing("mcp__a__foo", "mcp__b__foo", "collidewire"),
    };
    const res = await runTurn([USER], opts);
    expect(
      res.stop as string,
      "both offered tools collapse to one wire name — the turn must stop tool_name_collision, never send the model two identical function definitions it cannot invert",
    ).toBe("tool_name_collision");
    expect(calls.length, "the collision is caught BEFORE any model call — the port is never reached").toBe(0);
    expect(String(res.error ?? ""), "the error names the first colliding MCP tool").toContain("mcp__a__foo");
    expect(String(res.error ?? ""), "the error names the second colliding MCP tool").toContain("mcp__b__foo");
    expect(String(res.error ?? ""), "the error names the wire name they collapsed onto").toContain("collidewire");
  });
});

// ── I1 — a distinct set is unaffected; the refusal fires only on a real wire-name collision ──────────
describe("I1 — a distinct tool set is unaffected", () => {
  it("I1 — a distinct three-tool set with wire_name runs and offers all three, while a genuine wire-name collision on the same path is still refused", async () => {
    // CONTROL — three distinct names, distinct wire names (identity): the turn runs, all three offered.
    const { port, calls } = stubPort();
    const res = await runTurn([USER], {
      port,
      model: "m",
      tools: listing([td("mcp__a__x"), td("mcp__a__y"), td("mcp__a__z")]),
      allow: ["mcp__a__*"],
      max_rounds: 3,
      wire_name: (n: string) => n,
    } as WireOpts);
    expect(res.stop as string, "a distinct set must never be refused for a collision").not.toBe("tool_name_collision");
    expect(calls.length, "a distinct set reaches the model exactly as today").toBe(1);
    expect(
      calls[0]?.tools.map((t) => t.name).sort(),
      "all three distinct tools are offered, unchanged",
    ).toEqual(["mcp__a__x", "mcp__a__y", "mcp__a__z"]);

    // RED — the SAME wire_name path MUST refuse a real collision; a distinct-set control that never
    // checks is vacuous. Two distinct names collapsing to one wire name is a refusal.
    const { port: port2, calls: calls2 } = stubPort();
    const res2 = await runTurn([USER], {
      port: port2,
      model: "m",
      tools: listing([td("mcp__a__x"), td("mcp__b__x")]),
      allow: ["mcp__a__x", "mcp__b__x"],
      max_rounds: 3,
      wire_name: collapsing("mcp__a__x", "mcp__b__x", "collidewire"),
    } as WireOpts);
    expect(
      res2.stop as string,
      "a genuine wire-name collision is refused — the distinct-set control is not achieved by never checking",
    ).toBe("tool_name_collision");
    expect(calls2.length, "the colliding set makes no model call").toBe(0);
  });
});

// ── I2 — only the OFFERED set matters ───────────────────────────────────────────────────────────────
describe("I2 — only the offered set matters", () => {
  it("I2 — a wire collision with only one tool inside the allow list runs normally; both inside the allow list is refused", async () => {
    const both = listing([td("mcp__a__x"), td("mcp__b__x")]);
    const wn = collapsing("mcp__a__x", "mcp__b__x", "collidewire");

    // CONTROL — the two tools collide on the wire, but only ONE is inside the allow list, so the OFFERED
    // set holds no collision and the turn runs.
    const { port, calls } = stubPort();
    const res = await runTurn([USER], {
      port,
      model: "m",
      tools: both,
      allow: ["mcp__a__x"],
      max_rounds: 3,
      wire_name: wn,
    } as WireOpts);
    expect(
      res.stop as string,
      "a collision between an offered tool and a NON-offered one is not a collision",
    ).not.toBe("tool_name_collision");
    expect(calls.length, "an offered set of one runs normally").toBe(1);
    expect(calls[0]?.tools.map((t) => t.name), "only the allowed tool is offered").toEqual(["mcp__a__x"]);

    // RED — put BOTH colliding tools inside the allow list: now the OFFERED set collides and the turn
    // must refuse. Today no check runs over the offered set, so it does not.
    const { port: port2, calls: calls2 } = stubPort();
    const res2 = await runTurn([USER], {
      port: port2,
      model: "m",
      tools: both,
      allow: ["mcp__a__x", "mcp__b__x"],
      max_rounds: 3,
      wire_name: wn,
    } as WireOpts);
    expect(
      res2.stop as string,
      "with both colliding tools offered, the turn must stop tool_name_collision — the check is over the OFFERED set",
    ).toBe("tool_name_collision");
    expect(calls2.length, "the colliding offered set makes no model call").toBe(0);
  });
});

// ── F1 — no wire_name supplied: the collision check does not run ─────────────────────────────────────
describe("F1 — a caller that supplies no wire_name is unchanged", () => {
  it("F1 — no wire_name means no collision check and the turn behaves exactly as today; supplying wire_name is what turns the check on", async () => {
    const both = listing([td("mcp__a__x"), td("mcp__b__x")]);

    // CONTROL — a colliding set, but NO wire_name: the loop cannot know two tools share a wire name, so
    // it runs exactly as today (a transport that does not rename tools).
    const { port, calls } = stubPort();
    const res = await runTurn([USER], {
      port,
      model: "m",
      tools: both,
      allow: ["mcp__a__x", "mcp__b__x"],
      max_rounds: 3,
    });
    expect(res.stop as string, "with no wire_name there is no collision check — the turn runs as today").not.toBe(
      "tool_name_collision",
    );
    expect(calls.length, "a wire_name-less caller still calls the model").toBe(1);
    expect(calls[0]?.tools.length, "both tools are offered exactly as today").toBe(2);

    // RED — the SAME colliding set WITH wire_name supplied is refused, proving the check is GATED on
    // wire_name (F1 is the off-switch, not the absence of the feature).
    const { port: port2, calls: calls2 } = stubPort();
    const res2 = await runTurn([USER], {
      port: port2,
      model: "m",
      tools: both,
      allow: ["mcp__a__x", "mcp__b__x"],
      max_rounds: 3,
      wire_name: collapsing("mcp__a__x", "mcp__b__x", "collidewire"),
    } as WireOpts);
    expect(
      res2.stop as string,
      "supplying wire_name turns the collision check on — the same set is now refused",
    ).toBe("tool_name_collision");
    expect(calls2.length, "the colliding set makes no model call once wire_name is supplied").toBe(0);
  });
});

// ── O2 — the completions invoker surfaces the collision as a typed refusal, and never fetches ────────
describe("O2 — the completions invoker surfaces the collision as the typed refusal tool_name_collision", () => {
  it("O2 — makeCompletionsInvoker refuses tool_name_collision naming the tool, seals nothing, and never calls the model", async () => {
    const C = await loadCompletions();
    // tool_name_collision must be a MEMBER of COMPLETIONS_REFUSALS — the runtime's typed-refusal read
    // depends on that set, so a stop it does not list is a refusal the runtime cannot name.
    expect(
      C.COMPLETIONS_REFUSALS as readonly string[],
      "tool_name_collision must be a typed completions refusal",
    ).toContain("tool_name_collision");

    // Two OFFERED tools with the SAME MCP name encode to the same wire name (encodeToolName is the
    // identity on a safe name) — a real collision under the invoker's own encoding, not an injected one.
    const dup: McpToolDef = { name: "mcp__coltrane__output_query", inputSchema: { type: "object" } };
    const { source } = recordingTools([dup, dup]);
    const { fn, calls } = fakeCompletions([saysJson({ claim: "c", source: "s" })]);
    const agent = {
      ...TEST_BEHAVIOR,
      slug: "dup-tool-user",
      primitives: ["SENSE"],
      input_types: [],
      output_types: ["research-note"],
      domain: "research",
      model_tier: "economy",
      allowed_tools: ["mcp__coltrane__output_query"],
    } as Agent;
    const invoke = C.makeCompletionsInvoker({
      baseUrl: "https://endpoint.test/v1",
      apiKey: "k",
      tierMap: { economy: "cheap-model-1" },
      fetchFn: fn,
      tools: source,
    });
    const res = (await invoke({ agent, phase: "gather", inputs: [], gig_input: {} } as AgentInvocationContext)) as Record<
      string,
      unknown
    >;
    expect(res["refusal"], "two tools that collide on the wire are a refusal, not an insertion-order winner").toBe(
      "tool_name_collision",
    );
    expect(String(res["message"] ?? ""), "the refusal names the colliding tool").toContain(
      "mcp__coltrane__output_query",
    );
    expect(calls.length, "the collision is caught BEFORE any model call — the fake fetch must never run").toBe(0);
  });
});

// ── O3 — the port refuses a colliding tools request before it fetches, naming both ──────────────────
describe("O3 — makeChatCompletionsPort refuses a colliding tools request before it fetches", () => {
  it("O3 — a request whose tools encode to the same wire name is refused before the fetch, naming the wire name they collapsed onto", async () => {
    let fetched = false;
    const fetchFn = (async () => {
      fetched = true;
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: "hi" }, finish_reason: "stop" }] }),
        text: async () => "",
      };
    }) as unknown as typeof fetch;
    const port = makeChatCompletionsPort({ baseUrl: "https://endpoint.test/v1", apiKey: "k", fetchFn });

    const name = "mcp__coltrane__output_query";
    const req: ModelRequest = {
      model: "m",
      messages: [USER],
      tools: [td(name), td(name)], // two tools, one wire name — the Map at ~:214 keeps only the last
      signal: new AbortController().signal,
    };

    let threw = false;
    let message = "";
    try {
      await port(req);
    } catch (e) {
      threw = true;
      message = e instanceof Error ? e.message : String(e);
    }
    expect(threw, "the port must refuse a colliding tools request rather than build a reverse map it cannot invert").toBe(
      true,
    );
    expect(fetched, "the refusal is BEFORE the fetch — a colliding request never reaches the wire").toBe(false);
    expect(message, "the refusal names the wire name the tools collapsed onto").toContain(encodeToolName(name));
  });
});
