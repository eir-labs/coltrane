// RED-first — a chair that runs out of TOOL BUDGET must keep the writes that already passed the
// in-band boundary. Found by running a real gig, not by reading code.
//
// What happened: lineage-scout-external (max_tool_calls: 20) swept, made NINE successful
// output_write calls, and was cut off on turn 21. The CLI reported subtype "error_max_turns" and
// exited 1; spawnStreaming rejected on the exit code, so the invoker threw before
// captureOutputWrites ever ran, and all nine validated payloads were discarded. $2.36 spent, zero
// sealed. The chair's output_contract was ["lineage-hit"] and it had nine of them — so the run had
// in fact satisfied its contract and was reported as a failure.
//
// Why a budget stop is NOT the same as an error, which is the whole argument:
//   - An API error / non-completing run leaves TEXT that is partial reasoning. Sealing it would be
//     sealing a half-thought. That must keep failing, and does.
//   - A budget stop leaves WRITES that each passed the engine's own write boundary — adjudicated
//     against the full seal predicate (checkWritable, validate-mode) at the moment they were made.
//     They are not partial reasoning. They are validated payloads whose only defect is that the
//     agent was stopped before it could make more.
//
// All-or-nothing is right for a chair that FAILS VALIDATION: a half-sealed contract is worse than
// none. It is wrong for a chair that ran out of budget, where the effect is to destroy work already
// adjudicated as good and bill for it.
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
    identity: "a scout that runs out of turns",
    method: "sweep the literature and seal each hit",
    constraints: ["seal before the budget runs out"],
    behavioral_primitives: ["explorer", "analyst"],
    allowed_tools: ["WebSearch"],
    max_tool_calls: 3,
  });

const write = (id: string, source: string): string =>
  JSON.stringify({
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          id,
          name: "mcp__coltrane__output_write",
          input: { domain_type: "lineage-hit", data: { source, claim: "regimentation vs enforcement" } },
        },
      ],
    },
  });

/** Two output_write calls PASSED, then the run died on the turn cap. */
const budgetStoppedStream = (): string =>
  [
    write("w1", "Grossi, Aldewereld & Dignum"),
    write("w2", "Schneider 2000"),
    JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, stop_reason: "tool_use", num_turns: 4 }),
  ].join("\n");

/** Same shape, but the run died of an API error — its output is partial reasoning, not payloads. */
const apiErrorStream = (): string =>
  [write("w1", "half a thought"), JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true })].join("\n");

const invokeWith = (stdout: string) =>
  makeClaudeInvoker({
    model: "claude-sonnet-4-6",
    sealVia: "output_write",
    run: () => {
      throw new ChildExitError(`claude exited 1: `, stdout);
    },
  });

const ctx = (): AgentInvocationContext =>
  ({
    agent: agent(),
    phase: "identify",
    gig_id: "gig-budget-stop",
    inputs: [],
    gig_input: {},
    output_types: ["lineage-hit"],
  }) as AgentInvocationContext;

describe("a chair stopped by its TOOL BUDGET keeps what already passed the write boundary", () => {
  it("returns the sealed writes instead of throwing them away", async () => {
    const out = await invokeWith(budgetStoppedStream())(ctx());
    expect(
      out?.["lineage-hit"],
      "the budget stop destroyed writes that had already been adjudicated as valid — the work is " +
        "gone and the spend is not",
    ).toBeTruthy();
  });

  it("keeps the LAST passing write per type, same as a clean run", async () => {
    const out = (await invokeWith(budgetStoppedStream())(ctx())) as Record<string, Record<string, unknown>>;
    expect(out["lineage-hit"]!["source"]).toBe("Schneider 2000");
  });

  it("STILL fails when the budget stop sealed nothing — an empty stop is a real failure", async () => {
    const empty = JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true });
    await expect(
      invokeWith(empty)(ctx()),
      "a chair that burned its budget without landing a single write produced nothing, and must " +
        "say so rather than seal an empty blob",
    ).rejects.toThrow();
  });

  it("does NOT extend the same mercy to a non-budget error — that output IS partial reasoning", async () => {
    await expect(
      invokeWith(apiErrorStream())(ctx()),
      "an API-errored run's payload is a half-thought; recovering writes from it would seal " +
        "exactly the partial reasoning the error subtype exists to catch",
    ).rejects.toThrow();
  });
});
