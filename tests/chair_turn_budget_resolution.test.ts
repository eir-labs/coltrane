// RED-first — Item 1, the RESOLUTION half: the effective turn budget of a seated chair resolves in
// strict order — chair declaration beats the seated agent's max_tool_calls beats the engine default
// — and the resolved value becomes the spawn's --max-turns. Today the ONLY source is the agent
// record (claude_invoker.ts:957: maxToolCalls = min(depthCap, a.max_tool_calls ?? depthCap)); a
// chair-scoped budget is read nowhere.
//
// The chair's declared budget/reserve reach the invocation through AgentInvocationContext
// (runtime.ts:47-92), exactly as depth (#237) does: runtime threads chair.turn_budget onto the ctx,
// the invoker resolves it against a.max_tool_calls at the --max-turns site. These tests pin BOTH the
// per-invocation resolution (against a scripted spawn, in the pinned tests' own style) and the
// runtime threading (chair.turn_budget reaches the ctx an invoke sees).
//
// Covers INV2, INV3, INV4, INV5, INV6, INV7 and F4. RED because ctx.turn_budget / ctx.turn_reserve
// are ignored: the resolver reads only the agent record, so a chair cannot narrow, widen-guard, or
// zero-floor its own turn count today.
import { describe, it, expect } from "vitest";
import { makeClaudeInvoker, ChildExitError } from "../src/claude_invoker.js";
import { defineAgent } from "../src/composition.js";
import {
  runGig,
  createRegistry,
  createOutputStore,
  MemoryLedger,
  type AgentInvocationContext,
  type AgentInvoker,
  type DomainType,
  type Agent,
  type Standard,
} from "../src";
import { TEST_BEHAVIOR } from "./_support/agents.js";

// ── invoker-level substrate (mirrors tests/chair_turn_reserve.test.ts) ─────────────────────
const agent = (max?: number) =>
  defineAgent({
    slug: "budget-scout",
    primitives: ["SENSE"],
    input_types: [],
    output_types: ["lineage-hit"],
    identity: "a scout whose turn count is set by the chair it sits in",
    method: "sweep and seal each hit",
    constraints: ["seal before the budget runs out"],
    behavioral_primitives: ["explorer", "analyst"],
    allowed_tools: ["WebSearch"],
    ...(max !== undefined ? { max_tool_calls: max } : {}),
  });

const write = (id: string, source: string): string =>
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name: "mcp__coltrane__output_write", input: { domain_type: "lineage-hit", data: { source } } }] },
  });
const budgetStop = (...w: string[]): string =>
  [...w, JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true })].join("\n");
const cleanRun = (...w: string[]): string =>
  [...w, JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" })].join("\n");

/** A ctx carrying the chair-scoped turn fields (not on the interface yet — the runtime threads them). */
const ctx = (over: Record<string, unknown> = {}): AgentInvocationContext =>
  ({ agent: agent(over["agentMax"] as number | undefined), phase: "identify", gig_id: "g1", inputs: [], gig_input: {}, output_types: ["lineage-hit"], ...over }) as AgentInvocationContext;

const scripted = (replies: Array<{ stdout: string; exit1: boolean }>) => {
  const calls: Array<{ args: string[] }> = [];
  const run = (_bin: string, args: string[]) => {
    const i = calls.length;
    calls.push({ args });
    const r = replies[Math.min(i, replies.length - 1)]!;
    if (r.exit1) throw new ChildExitError("claude exited 1: ", r.stdout);
    return r.stdout;
  };
  return { calls, run };
};
const maxTurns = (args: string[]): string | undefined => {
  const i = args.indexOf("--max-turns");
  return i < 0 ? undefined : args[i + 1];
};

describe("the chair's turn budget resolves chair > agent > engine default", () => {
  it("is one decision table: chair wins, absent falls through, 0 is a hard floor, depth still tightens", async () => {
    // Each row spawns a clean run and reads the FIRST invocation's --max-turns.
    const runRow = async (over: Record<string, unknown>): Promise<string | undefined> => {
      const s = scripted([{ stdout: cleanRun(write("w1", "a")), exit1: false }]);
      await makeClaudeInvoker({ model: "claude-sonnet-4-6", sealVia: "output_write", run: s.run })(ctx(over));
      return maxTurns(s.calls[0]!.args);
    };

    // INV2 — chair beats agent: chair=7 declared, agent=20 → 7.
    expect(await runRow({ turn_budget: 7, agentMax: 20 }), "chair budget must beat the agent's max_tool_calls").toBe("7");
    // INV3 — chair absent → agent tier: agent=20 → 20.
    expect(await runRow({ agentMax: 20 }), "with no chair budget the agent's max_tool_calls stands").toBe("20");
    // INV4 — chair AND agent absent → engine default (today: no explicit --max-turns, the CLI default).
    expect(await runRow({}), "with neither declared the engine default stands (no chair/agent override)").toBeUndefined();
    // INV5 — 0 is distinct from absent: chair=0, agent=20 → 0, NOT a fall-through to 20.
    expect(await runRow({ turn_budget: 0, agentMax: 20 }), "turn_budget 0 is a deliberate hard floor, not absent").toBe("0"); // F4
    // INV7 — tighten-never-widen: chair(50) overrides agent(5), then a skim depth cap (8) clamps it.
    expect(
      await runRow({ turn_budget: 50, agentMax: 5, depth: "skim" }),
      "chair beats agent (50 over 5) but a shallow depth cap still tightens to 8 — never widens past it",
    ).toBe("8");
  });

  it("INV6 — a chair reserve with NO chair budget: budget falls through to the agent, reserve still applies", async () => {
    // budget absent → first pass holds the agent's 20; reserve=5 declared on the chair → the ONE
    // continuation is spawned with 5 as its whole --max-turns. Today ctx.turn_reserve is ignored and
    // the invoker-level opts.turn_reserve is unset, so no continuation is spawned at all.
    const s = scripted([
      { stdout: budgetStop(write("w1", "a")), exit1: true },
      { stdout: cleanRun(write("w2", "b")), exit1: false },
    ]);
    await makeClaudeInvoker({ model: "claude-sonnet-4-6", sealVia: "output_write", run: s.run })(
      ctx({ agentMax: 20, turn_reserve: 5 }),
    );
    expect(s.calls.length, "the chair-declared reserve was never granted — the chair was killed at its budget").toBe(2);
    expect(maxTurns(s.calls[0]!.args), "the first pass holds the fallen-through agent budget").toBe("20");
    expect(maxTurns(s.calls[1]!.args), "the continuation must be the chair's declared reserve, not a second full budget").toBe("5");
  });
});

// ── runtime threading: chair.turn_budget must REACH the ctx an invoke sees ──────────────────
const hit: DomainType = { slug: "lineage-hit", extends: "Signal", domain: "eirtests", schema: { properties: { source: { type: "string" } } }, required_fields: ["source"] };
const scout: Agent = { ...TEST_BEHAVIOR, slug: "scout", primitives: ["SENSE"], input_types: [], output_types: ["lineage-hit"], domain: "eirtests", max_tool_calls: 20 };

describe("the runtime threads the seated chair's turn budget onto the invocation", () => {
  it("INV2 threading — chair.turn_budget reaches ctx.turn_budget, overriding the agent's max_tool_calls", async () => {
    let seenBudget: unknown;
    let seenReserve: unknown;
    const invoke: AgentInvoker = (c) => {
      seenBudget = (c as unknown as Record<string, unknown>)["turn_budget"];
      seenReserve = (c as unknown as Record<string, unknown>)["turn_reserve"];
      return { source: "https://example.com" };
    };
    const standard: Standard = {
      slug: "sweep", domain: "eirtests", agents: [scout],
      phases: [{ name: "sense", chairs: [
        // The chair declares its own budget/reserve — the office's decision, over the player's 20.
        { role: "sense", agent_slug: "scout", depends_on: [], input_contract: [], output_contract: ["lineage-hit"], required_skills: [], turn_budget: 7, turn_reserve: 5 } as unknown as Standard["phases"][number]["chairs"][number],
      ] }],
    };
    const registry = createRegistry();
    registry.registerType(hit);
    await runGig(standard, {}, { outputs: createOutputStore(registry), ledger: new MemoryLedger(), invoke });
    expect(seenBudget, "the chair's turn_budget never reached the invocation — it is authored but unthreaded").toBe(7);
    expect(seenReserve, "the chair's turn_reserve never reached the invocation").toBe(5);
  });
});
