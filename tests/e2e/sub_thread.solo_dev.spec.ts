// persona: solo CC dev running 3+ concurrent sub-thread agents
// pre-reg: many RED. failures document where coltrane-oss's sub-thread invocation
// surface is incomplete vs. claude CLI's `claude -p` / `--resume` shape.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTempdirColtrane,
  spawnClaudeSubthread,
  resumeSubthread,
  assertRecorderCapturedTurn,
  type TempdirColtrane,
} from "./_harness.js";

describe("sub_thread.solo_dev — 3+ concurrent agents", () => {
  let env: TempdirColtrane;

  beforeAll(async () => {
    env = await setupTempdirColtrane();
  }, 300_000);

  afterAll(() => {
    env?.cleanup();
  });

  it("hard: parent fires 3 children in parallel; each returns a session_id; recorder captures all 3", async () => {
    const prompts = [
      "list the available coltrane MCP tools and reply with their slugs only",
      "describe the type_resolve tool in one sentence",
      "describe the gig_dispatch tool in one sentence",
    ];

    const results = await Promise.all(
      prompts.map((p) =>
        spawnClaudeSubthread(["-p", p], {
          mcpConfigPath: env.mcpConfigPath,
          timeoutMs: 90_000,
        }),
      ),
    );

    // hard assertion 1 — all 3 returned a session_id
    for (const r of results) {
      expect(r.sessionId, `child stderr: ${r.stderr.slice(0, 500)}`).not.toBeNull();
    }

    // hard assertion 2 — recorder captured all 3 turns
    for (const r of results) {
      if (!r.sessionId) continue;
      const entry = assertRecorderCapturedTurn(env.tempDir, r.sessionId, 0);
      expect(entry).toBeDefined();
    }
  }, 300_000);

  it("hard: each child --resumes once with follow-up; second-turn output is coherent", async () => {
    const first = await spawnClaudeSubthread(
      ["-p", "respond with the word 'one' and nothing else"],
      { mcpConfigPath: env.mcpConfigPath, timeoutMs: 60_000 },
    );
    expect(first.sessionId, `first stderr: ${first.stderr.slice(0, 500)}`).not.toBeNull();
    if (!first.sessionId) return; // typescript narrowing

    const followUp = await resumeSubthread(
      first.sessionId,
      "now respond with the word 'two' and nothing else",
      { mcpConfigPath: env.mcpConfigPath, timeoutMs: 60_000 },
    );
    expect(followUp.exitCode).toBe(0);
    expect(followUp.stdout.length).toBeGreaterThan(0);
    // not blank, not a stack trace
    expect(followUp.stderr).not.toMatch(/Error:|TypeError:|Cannot/);
  }, 240_000);

  it("soft: timing budget <30s total for 3-parallel; outputs distinct (no bleed)", async () => {
    const prompts = ["say A", "say B", "say C"];
    const start = Date.now();
    const results = await Promise.all(
      prompts.map((p) =>
        spawnClaudeSubthread(["-p", p], {
          mcpConfigPath: env.mcpConfigPath,
          timeoutMs: 30_000,
        }),
      ),
    );
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(30_000);

    // outputs distinct (each result's stdout differs from the others)
    const stdouts = results.map((r) => r.stdout);
    const unique = new Set(stdouts);
    expect(unique.size).toBe(stdouts.length);
  }, 60_000);
});
