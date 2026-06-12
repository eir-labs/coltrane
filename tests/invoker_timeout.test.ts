// RED-first — the invoker seam must bound each chair's wall-clock.
//
// The failure this closes (observed live, 2026-06-12): a gig_dispatch sat in-flight for
// 8077s with zero child spawns. Separately, a tool-granted child (WebSearch) has no
// turn bound and execFileSync had no timeout — so one wedged child would wedge the
// whole synchronous server. The cage's economy half: every spawn carries a hard
// wall-clock timeout and dies by SIGKILL (a SIGTERM-trapping child can't survive),
// failing THAT CHAIR instead of the server.
import { describe, it, expect } from "vitest";
import { makeClaudeInvoker, DEFAULT_CHAIR_TIMEOUT_MS } from "../src/claude_invoker.js";
import { testAgent } from "./_support/agents.js";

function ctxFor() {
  return {
    agent: testAgent({ slug: "timed", primitives: ["INTERPRET"], output_types: ["Interpretation"] }),
    phase: "interpret",
    inputs: [],
    gig_input: { q: "x" },
  };
}

describe("the invoker bounds each chair's wall-clock", () => {
  it("passes a hard timeout + SIGKILL to the spawn by default", async () => {
    let seen: { timeout?: number; killSignal?: string } | undefined;
    const invoke = makeClaudeInvoker({
      run: (_bin, _args, spawn) => {
        seen = spawn;
        return JSON.stringify({ value: "ok" });
      },
    });
    await invoke(ctxFor());
    expect(seen, "spawn options were not passed to the run seam").toBeDefined();
    expect(seen!.timeout).toBe(DEFAULT_CHAIR_TIMEOUT_MS);
    expect(seen!.killSignal).toBe("SIGKILL");
  });

  it("honors a per-deployment timeout override", async () => {
    let seen: { timeout?: number } | undefined;
    const invoke = makeClaudeInvoker({
      timeout_ms: 120_000,
      run: (_bin, _args, spawn) => {
        seen = spawn;
        return JSON.stringify({ value: "ok" });
      },
    });
    await invoke(ctxFor());
    expect(seen!.timeout).toBe(120_000);
  });

  it("the default is minutes-scale: long enough for a tool-using chair, far below a wedge", () => {
    expect(DEFAULT_CHAIR_TIMEOUT_MS).toBeGreaterThanOrEqual(5 * 60_000);
    expect(DEFAULT_CHAIR_TIMEOUT_MS).toBeLessThanOrEqual(20 * 60_000);
  });
});
