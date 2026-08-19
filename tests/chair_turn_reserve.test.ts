// RED-first — a chair that hits its turn budget is GRANTED a bounded reserve and told about it,
// instead of being killed mid-reach.
//
// The behaviour this replaces: --max-turns is a hard CLI bound with no callback, so a chair learns
// its budget only by dying at it. An observed sweep burned 20 turns, was cut off reaching for one
// more fetch, and never got to write the sweep-boundary record that says what it did NOT reach. The
// engine kept the sealed writes (see chair_budget_stop_keeps_sealed_writes) but the sweep was still
// truncated silently, and the only workaround was hand-writing the budget into the prompt — which
// works once and rots immediately.
//
// Why a CONTINUATION rather than an in-band signal: the obvious design is for the engine's own MCP
// surface to report position on each output_write return. It cannot. A scout's tools are WebSearch
// and WebFetch — HOST tools — and the child's coltrane server never sees them, so it would count
// only its own engine calls and undercount turns badly. The PARENT sees every turn in the
// stream-json, so the parent is the only party that can know position, and its only channel back
// into a running child is a new invocation.
//
// The grant is deliberately ONE extension, never a loop: an unbounded "just a bit more" is not a
// budget. The reserve is also capped per chair, so a greedy chair can exhaust a shared pool but can
// never draw more than its own declared share.
import { describe, it, expect } from "vitest";
import { makeClaudeInvoker, ChildExitError } from "../src/claude_invoker.js";
import { defineAgent } from "../src/composition.js";
import type { AgentInvocationContext } from "../src/runtime.js";

const agent = () =>
  defineAgent({
    slug: "budget-scout",
    primitives: ["SENSE"],
    input_types: [],
    output_types: ["lineage-hit"],
    identity: "a scout with a turn budget",
    method: "sweep and seal each hit",
    constraints: ["seal before the budget runs out"],
    behavioral_primitives: ["explorer", "analyst"],
    allowed_tools: ["WebSearch"],
    max_tool_calls: 20,
  });

const write = (id: string, source: string): string =>
  JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "tool_use", id, name: "mcp__coltrane__output_write", input: { domain_type: "lineage-hit", data: { source } } }],
    },
  });

const budgetStop = (...writes: string[]): string =>
  [...writes, JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true })].join("\n");

const cleanRun = (...writes: string[]): string =>
  [...writes, JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" })].join("\n");

const ctx = (): AgentInvocationContext =>
  ({ agent: agent(), phase: "identify", gig_id: "g1", inputs: [], gig_input: {}, output_types: ["lineage-hit"] }) as AgentInvocationContext;

/** Records every prompt+args the invoker spawns, and replies with a scripted stdout per call. */
const scripted = (replies: Array<{ stdout: string; exit1: boolean }>) => {
  const calls: Array<{ args: string[]; prompt: string }> = [];
  const run = (_bin: string, args: string[]) => {
    const i = calls.length;
    calls.push({ args, prompt: args.join(" ") });
    const r = replies[Math.min(i, replies.length - 1)]!;
    if (r.exit1) throw new ChildExitError("claude exited 1: ", r.stdout);
    return r.stdout;
  };
  return { calls, run };
};

describe("a chair that hits its turn budget is granted a bounded reserve", () => {
  it("re-invokes ONCE with the reserve and merges what both passes sealed", async () => {
    const s = scripted([
      { stdout: budgetStop(write("w1", "Grossi et al.")), exit1: true },
      { stdout: cleanRun(write("w2", "sweep-boundary: did not reach Raz")), exit1: false },
    ]);
    const out = (await makeClaudeInvoker({
      model: "claude-sonnet-4-6", sealVia: "output_write", turn_reserve: 5, run: s.run,
    })(ctx())) as Record<string, Array<Record<string, unknown>>>;

    expect(s.calls.length, "the chair was killed at its budget instead of being granted a reserve").toBe(2);
    // The seal path keeps every accepted write per type, so BOTH passes' writes survive the merge.
    expect(out["lineage-hit"]!.map((r) => r["source"])).toEqual(["Grossi et al.", "sweep-boundary: did not reach Raz"]);
  });

  it("spawns the continuation with ONLY the reserve as its turn cap", async () => {
    const s = scripted([
      { stdout: budgetStop(write("w1", "a")), exit1: true },
      { stdout: cleanRun(write("w2", "b")), exit1: false },
    ]);
    await makeClaudeInvoker({ model: "claude-sonnet-4-6", sealVia: "output_write", turn_reserve: 5, run: s.run })(ctx());

    const first = s.calls[0]!.args;
    const second = s.calls[1]!.args;
    expect(first[first.indexOf("--max-turns") + 1], "the first pass should hold the chair's declared budget").toBe("20");
    expect(second[second.indexOf("--max-turns") + 1], "the reserve must be the extension, not a second full budget").toBe("5");
  });

  it("TELLS the agent it is in reserve, how much is left, and what it already sealed", async () => {
    const s = scripted([
      { stdout: budgetStop(write("w1", "Grossi et al.")), exit1: true },
      { stdout: cleanRun(write("w2", "b")), exit1: false },
    ]);
    await makeClaudeInvoker({ model: "claude-sonnet-4-6", sealVia: "output_write", turn_reserve: 5, run: s.run })(ctx());

    const p = s.calls[1]!.prompt;
    expect(p, "the continuation must say a reserve was granted").toMatch(/reserve/i);
    expect(p, "the continuation must state the remaining turn count").toMatch(/5/);
    expect(p, "the continuation must say what already sealed, or the agent redoes it").toMatch(/lineage-hit/);
    expect(p, "the continuation must say this is the last extension").toMatch(/last|final|no further|not be extended/i);
  });

  it("grants the reserve ONCE — a second budget stop is a real failure, not another extension", async () => {
    const s = scripted([
      { stdout: budgetStop(write("w1", "a")), exit1: true },
      { stdout: budgetStop(write("w2", "b")), exit1: true },
    ]);
    const out = (await makeClaudeInvoker({
      model: "claude-sonnet-4-6", sealVia: "output_write", turn_reserve: 5, run: s.run,
    })(ctx())) as Record<string, Array<Record<string, unknown>>>;

    expect(s.calls.length, "an unbounded 'just a bit more' is not a budget").toBe(2);
    // The work still survives — the reserve pass's writes passed the boundary like any other, and
    // the seal path keeps every accepted record, so both passes' writes are present.
    expect(out["lineage-hit"]!.map((r) => r["source"])).toEqual(["a", "b"]);
  });

  it("with NO reserve configured, behaves exactly as before — keep the writes, no continuation", async () => {
    const s = scripted([{ stdout: budgetStop(write("w1", "a")), exit1: true }]);
    const out = (await makeClaudeInvoker({
      model: "claude-sonnet-4-6", sealVia: "output_write", run: s.run,
    })(ctx())) as Record<string, Array<Record<string, unknown>>>;

    expect(s.calls.length, "a reserve nobody granted must not be spent").toBe(1);
    expect(out["lineage-hit"]!.map((r) => r["source"])).toEqual(["a"]);
  });
});
