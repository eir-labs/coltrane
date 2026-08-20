// RED-first — a seat that was BLOCKED must say so, in the failure and to the operator.
//
// THE GAP. `grep -rn 'permission_denied' src/` returned NOTHING. The spawned child emits a system
// event with subtype "permission_denied" on every refused tool call — the invoker's stream parser
// already walks those very lines — and no code in this engine counts one, reports one, or acts on
// one. They exist only in the raw chair log on disk.
//
// WHAT THAT COST, measured across one day of real runs: 275 Bash, 36 Write and 9 Edit denials, none
// of which surfaced anywhere an operator would look. Gig 486e0e6c's draft-laws chair was refused six
// Bash calls — including `git -C <path> add -A` WHILE HOLDING Bash(git add:*), because the -C flag
// breaks the grant's prefix match — then spent its remaining budget reasoning about the refusals and
// died having written no law. Throughout, gig_monitor reported it RUNNING. The only way anyone
// learned why was grepping a JSONL by hand.
//
// AND THE FAILURE MESSAGE POINTED AT THE AGENT. "chair X sealed no output through its write boundary"
// is true and useless: it names the symptom while the cause was that the seat could not run the
// commands its own plan required. A chair that produced nothing because it had nothing to say and a
// chair that produced nothing because it was refused every tool it reached for are COMPLETELY
// DIFFERENT FAILURES, and only one of them is the agent's fault. Today they are indistinguishable.
//
// The event shape below is taken VERBATIM from gig 486e0e6c's log, not invented — the field that
// carries the reason varies (`message` vs `decision_reason`), and a fixture that guessed one shape
// would pass while the real one was dropped.
import { describe, it, expect } from "vitest";
import { makeClaudeInvoker, ChildExitError } from "../src/claude_invoker.js";
import { defineAgent } from "../src/composition.js";
import type { AgentInvocationContext, AgentStreamEvent } from "../src/runtime.js";

const agent = () =>
  defineAgent({
    slug: "blocked-seat",
    primitives: ["CREATE"],
    input_types: [],
    output_types: ["lineage-hit"],
    identity: "a seat that gets refused",
    method: "stage the work and seal it",
    constraints: ["seal through the write boundary"],
    behavioral_primitives: ["executor", "critic"],
    allowed_tools: ["Bash(git add:*)"],
    max_tool_calls: 8,
  });

/** VERBATIM from gig 486e0e6c — the compound-command refusal, reason in `message`. */
const deniedCompound = JSON.stringify({
  type: "system",
  subtype: "permission_denied",
  tool_name: "Bash",
  decision_reason_type: "subcommandResults",
  message:
    "This Bash command contains multiple operations. The following parts require approval: " +
    "git -C /repo add -A, git -C /repo status --short",
});

/** The other shape seen in the same corpus — reason in `decision_reason`, no `message`. */
const deniedOther = JSON.stringify({
  type: "system",
  subtype: "permission_denied",
  tool_name: "Bash",
  decision_reason_type: "other",
  decision_reason: "Contains expansion",
});

const sealed = JSON.stringify({
  type: "assistant",
  message: {
    content: [
      { type: "tool_use", id: "w1", name: "mcp__coltrane__output_write",
        input: { domain_type: "lineage-hit", data: { source: "https://example.com" } } },
    ],
  },
});

const done = JSON.stringify({ type: "result", subtype: "success", is_error: false });

function run(stream: string) {
  const events: AgentStreamEvent[] = [];
  const inv = makeClaudeInvoker({
    model: "claude-sonnet-4-6",
    sealVia: "output_write",
    mcpServerConfigs: { coltrane: { command: "node", args: ["dist/src/server_entry.js"] } },
    run: () => stream,
  });
  const ctx = {
    agent: agent(), phase: "create", gig_id: "g", inputs: [], gig_input: {},
    output_types: ["lineage-hit"],
    onEvent: (e: AgentStreamEvent) => events.push(e),
  } as unknown as AgentInvocationContext;
  return { inv, ctx, events };
}

describe("a seat that was denied says so", () => {
  it("D1 — a permission denial is emitted as a first-class event, not left in the log", async () => {
    const { inv, ctx, events } = run([deniedCompound, sealed, done].join("\n"));
    await inv(ctx);
    const denials = events.filter((e) => String(e.type).includes("denied") || String(e.type).includes("denial"));
    expect(denials.length, "the child reported a refusal and the engine emitted nothing").toBeGreaterThan(0);
  });

  it("D2 — the event names the TOOL and carries the reason", async () => {
    const { inv, ctx, events } = run([deniedCompound, sealed, done].join("\n"));
    await inv(ctx);
    const blob = JSON.stringify(events);
    expect(blob).toContain("Bash");
    expect(blob).toMatch(/multiple operations|require approval/);
  });

  it("D3 — a denial carrying `decision_reason` instead of `message` is not dropped", async () => {
    // Both shapes occur in the real corpus. A fixture that handled one would look green while the
    // other vanished — which is how a partial parse passes for coverage.
    const { inv, ctx, events } = run([deniedOther, sealed, done].join("\n"));
    await inv(ctx);
    expect(JSON.stringify(events)).toMatch(/Contains expansion/);
  });

  it("D4 — a chair that sealed NOTHING and was denied names the denials in its failure", async () => {
    // The sharpest one. "sealed no output through its write boundary" is true and useless when the
    // seat was refused every tool it reached for. Those are different failures and only one is the
    // agent's fault.
    const { inv, ctx } = run([deniedCompound, deniedOther, done].join("\n"));
    let msg = "";
    try { await inv(ctx); } catch (e) { msg = e instanceof Error ? e.message : String(e); }
    expect(msg, "the failure must not read as the agent having nothing to say").toMatch(/denied|refus|permission/i);
    // It must name WHAT was refused, not merely that something was — the reason is the actionable
    // half, and it is what distinguishes "the grant forbids this" from "you phrased it wrong".
    expect(msg).toMatch(/multiple operations|require approval|Contains expansion/);
    expect(msg).toMatch(/Bash/);
    // And a count. NOT 2: this chair never attempted output_write, so the seal repair gives it one
    // corrective turn (#467), the second spawn is refused the same way, and FOUR real denials occur
    // across the two passes. The engine reports what happened, not what the fixture assumed.
    expect(msg).toMatch(/DENIED 4 tool call/);
  });

  // ── NON-VACUITY ───────────────────────────────────────────────────────────────────────────────
  it("D5 — a clean run emits NO denial event and its failure text is unchanged", async () => {
    // Without this, an implementation that emitted a denial unconditionally would pass D1-D4 and cry
    // wolf on every run, which teaches an operator to skip the one that matters.
    const { inv, ctx, events } = run([sealed, done].join("\n"));
    await inv(ctx);
    expect(JSON.stringify(events)).not.toMatch(/permission|denied/i);
  });

  it("D6 — a chair that sealed nothing WITHOUT being denied still fails the old way", async () => {
    // The existing message is correct when the seat simply produced nothing; this change must not
    // blur that case into the blocked one.
    const { inv, ctx } = run([done].join("\n"));
    let msg = "";
    try { await inv(ctx); } catch (e) { msg = e instanceof Error ? e.message : String(e); }
    expect(msg).toMatch(/sealed no output/i);
    expect(msg).not.toMatch(/denied|permission/i);
  });
});
