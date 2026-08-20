// RED-first — a chair told to seal through a tool that is not in its spawn must be REFUSED before it
// runs, not discovered after it has spent a premium-tier budget failing.
//
// MEASURED ACROSS SIX GIGS, and the correlation is exact.
//
//   worktree   dist/src/server_entry.js   read-context sealed?
//   reach2     present                    YES  (80907ce5)
//   main       present                    YES  (486e0e6c)
//   required   MISSING                    NO   (6197b4ba, 8f4cda54, 496ed9f3)
//   denials    MISSING                    NO   (110c0076)
//
// `.mcp.json` names the engine server and points it at `dist/src/server_entry.js`. In a worktree that
// was never built, that server cannot start, so `mcp__coltrane__output_write` does not exist in the
// spawn. The chair calls it correctly and receives:
//
//     <tool_use_error>Error: No such tool available: mcp__coltrane__output_write</tool_use_error>
//
// AND THE ENGINE REPORTED SOMETHING ELSE ENTIRELY: "chair john sealed no output through its write
// boundary: no output_write call passed the write boundary for [change-context]". True, and useless.
// It describes the SYMPTOM — nothing got past the boundary — while the cause was that there was no
// boundary to get past. Four gigs died on this and the message pointed at the agent every time.
//
// THE PRECONDITION IS CHECKABLE BEFORE A TOKEN IS SPENT. The seal path builds the prompt that
// instructs the chair to call output_write, and it already knows whether the engine server config
// resolved — that is the same condition it uses to decide whether to grant the tool:
//
//     const engineServerCfg = (opts.mcpServerConfigs ?? {})[ENGINE_MCP_SERVER];
//     if (sealViaOutputWrite && engineServerCfg !== undefined) { …bridge + grant… }
//
// When that config is ABSENT and the spawn is REAL, the chair is being told to use a tool it cannot
// reach. That is a dead grant in the exact sense this repo already refuses elsewhere — "a grant that
// resolves to none is a dead name … so dispatch FAILS CLOSED instead of confabulating" — and the
// seal wire is the one place the rule was never applied. Absent must mean DECLINE.
//
// The test-invoker path must stay untouched: an injected `run` captures from a stream instead of
// spawning, so it needs no server and no grant, and every existing invoker law depends on that.
import { describe, it, expect } from "vitest";
import { makeClaudeInvoker } from "../src/claude_invoker.js";
import { defineAgent } from "../src/composition.js";
import type { AgentInvocationContext } from "../src/runtime.js";

const agent = () =>
  defineAgent({
    slug: "sealer",
    primitives: ["SENSE"],
    input_types: [],
    output_types: ["lineage-hit"],
    identity: "a chair asked to seal in band",
    method: "read, then seal through the write boundary",
    constraints: ["seal through output_write"],
    behavioral_primitives: ["explorer", "executor"],
    allowed_tools: ["Read"],
    max_tool_calls: 5,
  });

const ctx = (): AgentInvocationContext =>
  ({ agent: agent(), phase: "sense", gig_id: "g", inputs: [], gig_input: {},
     output_types: ["lineage-hit"] }) as AgentInvocationContext;

const sealed = JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "tool_use", id: "w1", name: "mcp__coltrane__output_write",
    input: { domain_type: "lineage-hit", data: { source: "https://example.com" } } }] },
});

describe("a chair that cannot reach its seal tool is refused before it spends", () => {
  it("W1 — a REAL spawn on the seal path with NO engine server config REFUSES, naming the cause", async () => {
    // No `run` injected → this would spawn a real child. The refusal must happen first, so this test
    // never launches anything.
    const invoke = makeClaudeInvoker({ model: "claude-sonnet-4-6", sealVia: "output_write" });
    await expect(invoke(ctx())).rejects.toThrow(/output_write|engine|seal/i);
  });

  it("W2 — the refusal says WHAT is missing, not that the chair failed to seal", async () => {
    // The measured failure blamed the agent for four gigs. The message must point at the wire.
    const invoke = makeClaudeInvoker({ model: "claude-sonnet-4-6", sealVia: "output_write" });
    let msg = "";
    try { await invoke(ctx()); } catch (e) { msg = e instanceof Error ? e.message : String(e); }
    expect(msg).toMatch(/mcp server|server config|not wired|unreachable|cannot reach/i);
    expect(msg, "must not read as the chair's fault").not.toMatch(/sealed no output/i);
  });

  // ── NON-VACUITY ───────────────────────────────────────────────────────────────────────────────
  it("W3 — an injected run (the test path) is UNTOUCHED: no server needed, no refusal", async () => {
    // Every existing invoker law depends on this path working without an engine server.
    const invoke = makeClaudeInvoker({ model: "claude-sonnet-4-6", sealVia: "output_write", run: () => sealed });
    const out = await invoke(ctx());
    expect(out).toHaveProperty("lineage-hit");
  });

  it("W4 — a real spawn WITH the engine config is not refused by this check", async () => {
    // Proves the gate keys on the missing config, not merely on 'is a real spawn'. `run` is injected
    // here so nothing launches; what matters is that supplying the config changes the outcome.
    const invoke = makeClaudeInvoker({
      model: "claude-sonnet-4-6", sealVia: "output_write",
      mcpServerConfigs: { coltrane: { command: "node", args: ["dist/src/server_entry.js"] } },
      run: () => sealed,
    });
    const out = await invoke(ctx());
    expect(out).toHaveProperty("lineage-hit");
  });

  it("W5 — a NON-seal invoker with no server config is unaffected", async () => {
    // The legacy text-seal path never needed output_write; this check must not reach it.
    const textOut = JSON.stringify({ type: "result", subtype: "success", is_error: false,
      result: JSON.stringify({ source: "https://example.com" }) });
    const invoke = makeClaudeInvoker({ model: "claude-sonnet-4-6", run: () => textOut });
    await expect(invoke(ctx())).resolves.toBeDefined();
  });
});
