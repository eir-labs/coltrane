// RED-first — a chair that COMPLETES its run without getting anything past the in-band write
// boundary gets ONE corrective continuation, instead of failing the phase outright.
//
// FOUND BY RUNNING A REAL GIG, NOT BY READING CODE. software-change-pr-v1, gig b4017c13: the
// implementation phases did their work, then the last phase died with
//
//   chair "change-verifier" sealed no output through its write boundary:
//   no output_write call passed the write boundary for [change-verdict]
//
// The chair's final tool call was `Write` — it treated its output as a document to hand back rather
// than a tool call to make, so it never reached the validator that would have told it so. The whole
// gig aborted at the last phase, discarding every earlier phase's work.
//
// WHY THIS IS THE INTERESTING FAILURE, and not simply "the agent got it wrong". The engine already
// HAS a repair loop, and it is good: output_write "runs the full seal predicate and returns its
// verdict in-band, so the agent self-corrects within its own single run" (claude_invoker.ts:124), and
// "a rejection returns in-band and the agent fixes `data` and calls again" (:224). A chair that calls
// output_write with a stray key gets bounced and fixes it, unattended.
//
// But that loop only protects the output_write PATH. A chair that yields its answer some other way —
// as final text, as a file, or by stopping mid-thought — never enters the loop at all. It lands here,
// at a bare throw, where there is no in-band frame left to correct in. So the failure mode the repair
// loop exists to handle is exactly the one it cannot see: the agent that didn't know to knock.
//
// The asymmetry is the defect. Getting the payload WRONG is recoverable; getting the CHANNEL wrong
// is fatal. That is backwards — a wrong channel is the cheaper mistake to fix, because the work is
// already done and sitting in the agent's context. One continuation turn, in the SAME session, is
// enough for it to make the call it should have made.
//
// The mechanism is not new: the reserve grant (claude_invoker.ts:1241-1266) already continues a
// stopped chair once, tells it where it stands, and says plainly that nothing follows. This gives the
// same treatment to a different cause. Bounded to ONE — a chair that ignores a direct instruction to
// seal will not be argued into it, and an unbounded loop bills for the argument.
//
// The BUDGET-STOPPED path is deliberately untouched: that chair didn't use the wrong channel, it ran
// out of room, and the reserve grant is its remedy. Repairing it here would double-continue it.
import { describe, it, expect } from "vitest";
import { makeClaudeInvoker, ChildExitError } from "../src/claude_invoker.js";
import { defineAgent } from "../src/composition.js";
import type { AgentInvocationContext } from "../src/runtime.js";

const agent = () =>
  defineAgent({
    slug: "change-verifier",
    primitives: ["VERIFY"],
    input_types: [],
    output_types: ["change-verdict"],
    identity: "a verifier that hands its answer back as a document",
    method: "verify the change and seal a verdict",
    constraints: ["seal through the write boundary"],
    behavioral_primitives: ["analyst", "critic"],
    allowed_tools: ["Bash", "Write"],
    max_tool_calls: 8,
  });

/** A sealed verdict — the call that passes the boundary. */
const sealed = (id: string, verdict: string): string =>
  JSON.stringify({
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          id,
          name: "mcp__coltrane__output_write",
          input: { domain_type: "change-verdict", data: { verdict, rationale: "the laws are green" } },
        },
      ],
    },
  });

/** The real failure: the chair wrote a FILE and finished cleanly. Nothing crossed the boundary. */
const wroteAFileInstead = (): string =>
  [
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: "/tmp/verdict.md" } }] },
    }),
    JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 2 }),
  ].join("\n");

const ok = (): string => [sealed("w1", "pass"), JSON.stringify({ type: "result", subtype: "success", is_error: false })].join("\n");

/** Records every prompt the invoker spawned with, so the laws can read what the repair actually said. */
function recordingInvoker(streams: string[]) {
  const prompts: string[] = [];
  const inv = makeClaudeInvoker({
    model: "claude-sonnet-4-6",
    sealVia: "output_write",
    run: (_bin, args) => {
      // The prompt is the positional that follows `-p` (withPrompt, claude_invoker.ts:604) — read
      // it exactly, not by joining every arg, or a tool-name list could satisfy these assertions.
      prompts.push(args[args.indexOf("-p") + 1] ?? "");
      const next = streams[Math.min(prompts.length - 1, streams.length - 1)]!;
      return next;
    },
  });
  return { inv, prompts };
}

const ctx = (): AgentInvocationContext =>
  ({
    agent: agent(),
    phase: "verify-change",
    gig_id: "gig-seal-repair",
    inputs: [],
    gig_input: {},
    output_types: ["change-verdict"],
  }) as AgentInvocationContext;

describe("a chair that sealed NOTHING gets one corrective continuation", () => {
  it("S1 — a first pass that seals nothing is continued, not failed: the chair runs a second time", async () => {
    const { inv, prompts } = recordingInvoker([wroteAFileInstead(), ok()]);
    await inv(ctx());
    expect(prompts.length).toBe(2);
  });

  it("S2 — the continuation names the unsealed types and the channel it must use", async () => {
    const { inv, prompts } = recordingInvoker([wroteAFileInstead(), ok()]);
    await inv(ctx());
    const repair = prompts[1]!;
    // It must say WHAT is missing and HOW to deliver it — a repair that only says "you failed"
    // leaves the agent to guess the channel again, which is the mistake being corrected.
    expect(repair).toContain("change-verdict");
    expect(repair).toMatch(/output_write/);
  });

  it("S3 — when the continuation seals, the chair SUCCEEDS and returns the payload", async () => {
    const { inv } = recordingInvoker([wroteAFileInstead(), ok()]);
    const out = await inv(ctx());
    expect(out).toHaveProperty("change-verdict");
    const rows = (out as Record<string, unknown[]>)["change-verdict"]!;
    expect(rows.length).toBe(1);
    expect((rows[0] as { verdict: string }).verdict).toBe("pass");
  });

  it("S4 — bounded to ONE: a chair that ignores the correction still fails, after exactly two runs", async () => {
    const { inv, prompts } = recordingInvoker([wroteAFileInstead(), wroteAFileInstead()]);
    await expect(inv(ctx())).rejects.toThrow(/sealed no output through its write boundary/);
    expect(prompts.length).toBe(2); // never a third — the argument is not billed for twice
  });

  it("S5 — a chair that seals on its FIRST pass is never continued: the happy path costs nothing", async () => {
    const { inv, prompts } = recordingInvoker([ok()]);
    const out = await inv(ctx());
    expect(prompts.length).toBe(1);
    expect(out).toHaveProperty("change-verdict");
  });

  it("S6 — a BUDGET-stopped chair is left to the reserve grant, not repaired here", async () => {
    // Ran out of room rather than using the wrong channel. Its remedy is the reserve; repairing it
    // here would continue it twice for one stop. With no reserve declared it fails as it always has.
    const stopped = [
      JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, num_turns: 9 }),
    ].join("\n");
    const prompts: string[] = [];
    const inv = makeClaudeInvoker({
      model: "claude-sonnet-4-6",
      sealVia: "output_write",
      run: (_bin, args) => {
        prompts.push(args[args.indexOf("-p") + 1] ?? "");
        throw new ChildExitError("claude exited 1: ", stopped);
      },
    });
    await expect(inv(ctx())).rejects.toThrow();
    expect(prompts.length).toBe(1);
  });

  it("S7 — a chair that KNOCKED and was refused is NOT repaired: the governor's principle stands", async () => {
    // THE LINE THIS WHOLE CHANGE TURNS ON. This chair called output_write, the engine adjudicated it
    // and returned the rejection in-band, and the chair gave up anyway. It already had its
    // correction, in the frame designed to deliver it. Re-prompting it is the bounded repair loop
    // the governor rejected TWICE (tests/output_write_boundary.test.ts header) — and that rejection
    // is right: an agent that ignores an in-band verdict will ignore a re-prompt of the same verdict.
    //
    // So the repair is not "retry when the seal is empty". It is "engage the loop for the chair that
    // never entered it". An attempted-and-refused chair is out of scope BY CONSTRUCTION, not by a
    // prose caveat someone could later drop.
    const knockedAndRefused = [
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "tu_bad", name: "mcp__coltrane__output_write",
          input: { domain_type: "change-verdict", data: {} } }] },
      }),
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "tu_bad", is_error: true, content: "rejected" }] },
      }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false }),
    ].join("\n");
    const { inv, prompts } = recordingInvoker([knockedAndRefused, ok()]);
    await expect(inv(ctx())).rejects.toThrow(/sealed no output through its write boundary/);
    expect(prompts.length).toBe(1); // never continued — the in-band loop already had its turn
  });
});
