// persona: eng mgr piloting — <5min from-fresh-clone to first sub-thread completion
// note: the "5-min ramp" test bakes in the time-to-first-value contract.
// if this is RED, the onboarding story is broken — the smallest possible fix is documented.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnClaudeSubthread, setupTempdirColtrane, type TempdirColtrane, assistantText, parseStreamJson } from "./_harness.js";

describe("sub_thread.eng_manager — <5min ramp", () => {
  let env: TempdirColtrane;
  let setupMs = 0;

  beforeAll(async () => {
    const t0 = Date.now();
    env = await setupTempdirColtrane();
    setupMs = Date.now() - t0;
  }, 300_000);

  afterAll(() => {
    env?.cleanup();
  });

  it("hard: from a fresh tempdir, install → build → start MCP → invoke one example sub-thread → complete <5min wall-time", async () => {
    const remainingBudgetMs = 300_000 - setupMs;
    const invokeStart = Date.now();
    const r = await spawnClaudeSubthread(
      [
        "-p",
        "list the available coltrane MCP tools by calling tool_registry_browse (or describe what's available)",
      ],
      { mcpConfigPath: env.mcpConfigPath, timeoutMs: remainingBudgetMs },
    );
    const invokeMs = Date.now() - invokeStart;
    const totalMs = setupMs + invokeMs;

    expect(totalMs).toBeLessThan(300_000);
    expect(r.exitCode, `stderr: ${r.stderr.slice(0, 400)}`).toBe(0);
  }, 360_000);

  it("hard: example completes without error (exit code 0)", async () => {
    const r = await spawnClaudeSubthread(
      ["-p", "respond with the literal word 'ready'"],
      { mcpConfigPath: env.mcpConfigPath, timeoutMs: 60_000 },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stderr).not.toMatch(/Error:|TypeError|Cannot find module/);
  }, 120_000);

  it("soft: output shape makes sense to a fresh reader (non-empty, non-stack-trace, structured)", async () => {
    const r = await spawnClaudeSubthread(
      ["-p", "say hello"],
      { mcpConfigPath: env.mcpConfigPath, timeoutMs: 60_000 },
    );
    expect(r.stdout.length).toBeGreaterThan(0);
    const events = parseStreamJson(r.stdout);
    const text = assistantText(events);
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toMatch(/^\s*at .+\..+\(/m); // not a stack trace
    expect(text.toLowerCase()).toMatch(/hello|hi|hey/);
  }, 120_000);
});
