// persona: research lab — deterministic replay + nested invocation lineage
// pre-reg: hardest set. requires coltrane to seal sub-thread lineage at resume.
// expected to be largely RED until coltrane wires a SubthreadRecorder.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import {
  setupTempdirColtrane,
  spawnClaudeSubthread,
  resumeSubthread,
  hashRecorderIgnoringTimestamps,
  type TempdirColtrane,
} from "./_harness.js";

describe("sub_thread.research_lab — deterministic replay + nested lineage", () => {
  let envA: TempdirColtrane;
  let envB: TempdirColtrane;

  beforeAll(async () => {
    envA = await setupTempdirColtrane();
    envB = await setupTempdirColtrane();
  }, 600_000);

  afterAll(() => {
    envA?.cleanup();
    envB?.cleanup();
  });

  async function runChain(env: TempdirColtrane, length: number): Promise<string[]> {
    const sessionIds: string[] = [];
    const first = await spawnClaudeSubthread(
      ["-p", "respond with 'step 1' and nothing else"],
      { mcpConfigPath: env.mcpConfigPath, timeoutMs: 60_000 },
    );
    if (!first.sessionId) return sessionIds;
    sessionIds.push(first.sessionId);
    let currentSid = first.sessionId;

    for (let i = 2; i <= length; i++) {
      const r = await resumeSubthread(
        currentSid,
        `respond with 'step ${i}' and nothing else`,
        { mcpConfigPath: env.mcpConfigPath, timeoutMs: 60_000 },
      );
      // resume preserves the same sid in Claude CLI
      currentSid = r.sessionId ?? currentSid;
      sessionIds.push(currentSid);
    }
    return sessionIds;
  }

  it("hard: --resume chain of length 5 produces identical hash-sealed record across runs", async () => {
    const chainA = await runChain(envA, 5);
    const hA = hashRecorderIgnoringTimestamps(envA.recorderPath);

    const chainB = await runChain(envB, 5);
    const hB = hashRecorderIgnoringTimestamps(envB.recorderPath);

    expect(chainA.length).toBe(5);
    expect(chainB.length).toBe(5);
    expect(hA).toBe(hB);
    expect(hA).not.toBe("EMPTY");
  }, 600_000);

  it("hard: nested invocation depth ≥3 (A→B→C) records full lineage with parent-child edges", async () => {
    // simulate nesting: parent prompt asks the model to spawn a child that spawns a grandchild
    // we can only test the lineage if coltrane records sub-thread parent_session_id on each turn.
    const parent = await spawnClaudeSubthread(
      ["-p", "invoke the coltrane tool 'standard_simulate' with mock input and return its output"],
      { mcpConfigPath: envA.mcpConfigPath, timeoutMs: 90_000 },
    );
    expect(parent.sessionId).not.toBeNull();

    // assert recorder log contains lineage edges (parent_session_id field)
    if (!existsSync(envA.recorderPath)) {
      expect.fail("recorder not wired — no lineage to verify");
    }
    const content = readFileSync(envA.recorderPath, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    let foundParentEdge = false;
    let depth = 0;
    const seenSessions = new Set<string>();
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        if (e.parent_session_id) {
          foundParentEdge = true;
          if (e.session_id) seenSessions.add(e.session_id);
          if (e.parent_session_id) seenSessions.add(e.parent_session_id);
        }
      } catch {
        /* skip */
      }
    }
    depth = seenSessions.size;

    expect(foundParentEdge, "no parent_session_id field in any recorder entry — lineage not sealed").toBe(true);
    expect(depth).toBeGreaterThanOrEqual(3);
  }, 240_000);

  it("soft: trace tree renderable (recorder output parseable into a tree shape)", async () => {
    await spawnClaudeSubthread(
      ["-p", "say one"],
      { mcpConfigPath: envA.mcpConfigPath, timeoutMs: 60_000 },
    );
    if (!existsSync(envA.recorderPath)) {
      expect.fail("recorder log missing");
    }
    const content = readFileSync(envA.recorderPath, "utf-8");
    const lines = content.split("\n").filter(Boolean);

    // try to build a tree by session_id → parent_session_id
    const byId = new Map<string, { id: string; parent: string | null }>();
    for (const line of lines) {
      try {
        const e = JSON.parse(line) as { session_id?: string; parent_session_id?: string };
        if (e.session_id) {
          byId.set(e.session_id, { id: e.session_id, parent: e.parent_session_id ?? null });
        }
      } catch {
        /* skip */
      }
    }
    expect(byId.size).toBeGreaterThan(0);
  }, 120_000);
});
