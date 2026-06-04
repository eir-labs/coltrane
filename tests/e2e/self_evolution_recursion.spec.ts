// U6 — self-evolution recursion probe.
//
// Question: if an agent evolves ITSELF in a loop (50+ iterations, each iteration
// mutating a creative-space field), does coltrane's `agent_evolve` API halt
// cleanly per call, or does it recurse / leak / blow stack?
//
// Pre-reg: NO `it.skip`, NO stubs — the test drives the real `dispatchTool`
// surface (same path MCP-over-stdio routes to). The test IS the receipt: green
// → version monotonically increases, every call returns cleanly under budget.
// Red → either a call throws/stalls, OR new_version stops monotonically rising
// (the PR #78 bug Eugene flagged — agent_evolve returned new_version=1 forever).
//
// Time-budget: 30s wall-clock for the whole 50-iter loop. Exceeds → RED timeout.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTempdirColtrane, type TempdirColtrane } from "./_harness.js";
import { dispatchTool, bootstrapServerDeps, type ServerDeps } from "../../src/index.js";

describe("U6 — self-evolution recursion (agent_evolve in a loop)", () => {
  let env: TempdirColtrane;
  let deps: ServerDeps;

  beforeAll(async () => {
    env = await setupTempdirColtrane();
    deps = bootstrapServerDeps(env.tempDir);
  }, 300_000);

  afterAll(() => {
    env?.cleanup();
  });

  it("agent_evolve(X) called 50 times in a loop halts cleanly, monotonically bumps version", async () => {
    const ITERATIONS = 50;
    const BUDGET_MS = 30_000;

    // Agent X — minimal creative-space profile so each iteration touches `identity`
    // (a creative-field), keeping the change classifier in "creative" space (no
    // approval gate, so evolve returns a materialized profile every call).
    let current = {
      slug: "u6-self-evolver",
      version: 1,
      status: "active" as const,
      parent_version: null,
      primitives: ["JUDGE"] as const,
      input_types: [] as const,
      output_types: [] as const,
      domain: "u6",
      identity: "iter 0",
      method: "evolve-self",
      constraints: [] as const,
      depth_profile: "standard" as const,
      permissions: {
        allowed_tools: [] as const,
        disallowed_tools: [] as const,
        model_tier: "standard" as const,
        max_tool_calls: 5,
        max_token_budget: 1000,
        can_write_outputs: false,
        can_trigger_standards: false,
      },
    };

    const start = Date.now();
    let iterationsCompleted = 0;
    let lastVersion = current.version;
    const versionTrace: number[] = [current.version];
    let monotonicBreak: { iter: number; prev: number; got: number } | null = null;

    for (let i = 1; i <= ITERATIONS; i++) {
      if (Date.now() - start > BUDGET_MS) {
        throw new Error(
          `U6 RED: timeout — exceeded ${BUDGET_MS}ms budget at iter ${i}/${ITERATIONS}. ` +
          `Possible infinite loop / recursion in agent_evolve.`,
        );
      }
      const next = { ...current, version: current.version + 1, identity: `iter ${i}` };
      const res = await dispatchTool(
        "agent_evolve",
        { base: current, next, new_version: current.version + 1 },
        deps,
      );
      expect(res.ok, `iter ${i} agent_evolve failed: ${res.error}`).toBe(true);
      const data = res.data as { space: string; new_version: number; evolved_profile: typeof current | null };
      expect(data.space).toBe("creative");
      expect(data.evolved_profile, `iter ${i} evolved_profile null`).not.toBeNull();

      const reportedVersion = data.new_version;
      if (reportedVersion <= lastVersion) {
        // First break only — keep going to confirm the loop still HALTS cleanly,
        // we just don't get monotonic versions.
        if (!monotonicBreak) {
          monotonicBreak = { iter: i, prev: lastVersion, got: reportedVersion };
        }
      }
      versionTrace.push(reportedVersion);
      lastVersion = reportedVersion;
      // Advance the chain: feed the evolved profile back in — true self-evolution.
      current = data.evolved_profile!;
      iterationsCompleted = i;
    }

    const duration = Date.now() - start;
    const finalVersion = lastVersion;
    // Receipt — emitted regardless of green/red so the test itself is the artifact.
    // eslint-disable-next-line no-console
    console.log(
      `\n─── self_evolution_recursion receipt ─── ` +
      `iterations_completed=${iterationsCompleted} ` +
      `final_version=${finalVersion} ` +
      `duration_ms=${duration} ` +
      `monotonic=${monotonicBreak === null} ` +
      (monotonicBreak ? `break_at_iter=${monotonicBreak.iter} prev=${monotonicBreak.prev} got=${monotonicBreak.got} ` : "") +
      `version_trace_head=[${versionTrace.slice(0, 5).join(",")}] ` +
      `version_trace_tail=[${versionTrace.slice(-5).join(",")}]`,
    );

    // Halting contract: all 50 iters completed under budget.
    expect(iterationsCompleted).toBe(ITERATIONS);
    expect(duration).toBeLessThan(BUDGET_MS);

    // Monotonic-version contract: the PR #78 finding predicts this fails (new_version
    // pinned at 1). The test treats that as DIAGNOSED-not-skipped: if it breaks, the
    // receipt above carries the break point and we still assert it for visibility.
    expect(monotonicBreak, `monotonic version-bump broken: ${JSON.stringify(monotonicBreak)}`).toBeNull();
    expect(finalVersion).toBe(ITERATIONS + 1); // started at 1, evolved 50 times
  }, 60_000);
});
