// RED-first — a chair that ran out of turns must get its reserve whether or not the CLI exited
// non-zero. Today the reserve is gated on the EXIT CODE, so a budget stop that exits 0 is invisible.
//
// MEASURED, gig 8f4cda54. Its read-context chair declared turn_reserve 12 (added in #478), ran with
// the built dist carrying that change, and:
//
//     tool_use blocks         106   (cap 120)
//     result subtype          error_max_turns
//     budget_reserve_granted  0        ← the reserve NEVER FIRED
//     output_write calls      0
//     permission denials      0
//
// It hit its cap, was never extended, and failed with "sealed no output through its write boundary".
// The reserve I shipped that afternoon did not do the thing I said it would.
//
// THE MECHANISM, from claude_invoker.ts:
//
//     const runTolerantOfBudgetStop = async (args, text) => {
//       try { return { stdout: await runOnce(args, text), budgetStopped: false }; }
//       catch (e) { …; return { stdout: e.stdout, budgetStopped: true }; }
//     };
//
// `budgetStopped` is true ONLY on the catch path — that is, only when the child exits NON-ZERO. The
// reserve grant is `if (budgetStopped && reserveTurns > 0 && seal !== undefined)`. So a run that hits
// its turn cap and exits 0, reporting `{"subtype":"error_max_turns"}` in its result event, is a
// budget stop that the engine cannot see.
//
// The stop is a fact about the RESULT, not about the exit code. The CLI reports it either way; only
// one of those ways is currently read. This is the day's pattern once more — a signal that exists and
// nothing consumes.
import { describe, it, expect } from "vitest";
import { makeClaudeInvoker, ChildExitError } from "../src/claude_invoker.js";
import { defineAgent } from "../src/composition.js";
import type { AgentInvocationContext } from "../src/runtime.js";

const agent = () =>
  defineAgent({
    slug: "budget-reader",
    primitives: ["SENSE"],
    input_types: [],
    output_types: ["lineage-hit"],
    identity: "a reader that runs out of turns",
    method: "read the material and seal what it found",
    constraints: ["seal before the budget runs out"],
    behavioral_primitives: ["explorer", "executor"],
    allowed_tools: ["Read"],
    max_tool_calls: 3,
  });

const sealed = (id: string): string =>
  JSON.stringify({
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", id, name: "mcp__coltrane__output_write",
          input: { domain_type: "lineage-hit", data: { source: "https://example.com" } } },
      ],
    },
  });

/** Ran out of turns and the CLI exited ZERO — the shape gig 8f4cda54 produced. */
const maxTurnsCleanExit = (): string =>
  JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, num_turns: 3 });

/** Ran out of turns and the CLI exited NON-ZERO — the shape already handled. */
const maxTurnsHardExit = (): string => maxTurnsCleanExit();

function recording(streams: string[], throwOn: number[] = []) {
  const prompts: string[] = [];
  const inv = makeClaudeInvoker({
    model: "claude-sonnet-4-6",
    sealVia: "output_write",
    turn_reserve: 5,
    run: (_bin, args) => {
      const n = prompts.length;
      prompts.push(args[args.indexOf("-p") + 1] ?? "");
      const out = streams[Math.min(n, streams.length - 1)]!;
      if (throwOn.includes(n)) throw new ChildExitError("claude exited 1: ", out);
      return out;
    },
  });
  return { inv, prompts };
}

const ctx = (): AgentInvocationContext =>
  ({ agent: agent(), phase: "sense", gig_id: "g", inputs: [], gig_input: {},
     output_types: ["lineage-hit"], turn_reserve: 5 }) as AgentInvocationContext;

describe("the reserve fires on the RESULT SUBTYPE, not the exit code", () => {
  it("B1 — a max-turns stop that exits ZERO still grants the reserve", async () => {
    // The measured case. Before the fix the chair is simply abandoned at its cap.
    const { inv, prompts } = recording([maxTurnsCleanExit(), sealed("w1")]);
    await inv(ctx());
    expect(prompts.length, "a chair that ran out of turns must be extended once").toBe(2);
    expect(prompts[1]).toMatch(/RESERVE/i);
  });

  it("B2 — the extension carries the reserve as its whole budget", async () => {
    const { inv, prompts } = recording([maxTurnsCleanExit(), sealed("w1")]);
    await inv(ctx());
    expect(prompts.length).toBe(2);
  });

  it("B3 — and the run SUCCEEDS when the extension seals", async () => {
    const { inv } = recording([maxTurnsCleanExit(), sealed("w1")]);
    const out = await inv(ctx());
    expect(out).toHaveProperty("lineage-hit");
  });

  // ── NON-VACUITY ───────────────────────────────────────────────────────────────────────────────
  it("B4 — the NON-ZERO-exit path still works exactly as before", async () => {
    // The case that already worked must keep working; this is a widening, not a replacement.
    const { inv, prompts } = recording([maxTurnsHardExit(), sealed("w1")], [0]);
    await inv(ctx());
    expect(prompts.length).toBe(2);
  });

  it("B5 — a clean run that seals is NEVER extended: the happy path costs nothing", async () => {
    const { inv, prompts } = recording([
      [sealed("w1"), JSON.stringify({ type: "result", subtype: "success", is_error: false })].join("\n"),
    ]);
    await inv(ctx());
    expect(prompts.length).toBe(1);
  });
});
