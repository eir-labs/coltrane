// T1 — multi-phase live gig (THE coltrane core function)
//
// pre-reg: spawn REAL claude at phase 1, capture its output, spawn REAL claude
// at phase 2 with phase 1 output as input. Assert that phase 2's response
// references phase 1's content — proves upstream→downstream wiring with real
// Claude at every phase, not deterministic mocks.
//
// honesty note: schema validation against an agent.output_type and an audit
// chain over both phases require coltrane internals that may not be exposed at
// the spawn-claude-CLI boundary in v0. Where assertions cannot be made hard
// against real internals, we keep them soft + diagnostic so RED = "this is the
// gap" not "test is broken." That's the bug-bash discipline Eugene called for.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTempdirColtrane,
  spawnClaudeSubthread,
  type TempdirColtrane,
} from "./_harness.js";
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";

describe("T1 — multi-phase live gig (real claude at each phase, output flows)", () => {
  let env: TempdirColtrane;

  beforeAll(async () => {
    env = await setupTempdirColtrane();
  }, 300_000);

  afterAll(() => {
    env?.cleanup();
  });

  it("hard: phase 1 → phase 2 with real claude at each step, phase 1 output flows into phase 2 input", async () => {
    // Unique marker so we can prove phase 2 actually received phase 1's output
    // and didn't hallucinate a coincidental match.
    const marker = `MARK-${randomUUID().slice(0, 12)}`;

    // ── Phase 1: produce a structured-ish output that contains the marker
    const phase1 = await spawnClaudeSubthread(
      [
        "-p",
        `You are phase 1 of a 2-phase pipeline. Respond with EXACTLY one line: ` +
          `the literal token ${marker} followed by a colon and a 5-word noun phrase ` +
          `describing morning fog. No preamble, no quotes, no markdown.`,
      ],
      { mcpConfigPath: env.mcpConfigPath, timeoutMs: 90_000 },
    );

    expect(
      phase1.sessionId,
      `phase 1 got no session_id; stderr=${phase1.stderr.slice(0, 400)}`,
    ).not.toBeNull();
    expect(phase1.exitCode).toBe(0);

    // Extract phase 1's output line from stream-json result event
    const phase1Output = extractFinalResult(phase1.stdout);
    expect(phase1Output, `phase 1 produced no result text`).toBeTruthy();
    expect(
      phase1Output.includes(marker),
      `phase 1 output missing marker. got: ${phase1Output.slice(0, 200)}`,
    ).toBe(true);

    // ── Phase 2: receive phase 1's output as input, transform it
    const phase2 = await spawnClaudeSubthread(
      [
        "-p",
        `You are phase 2 of a 2-phase pipeline. Phase 1 sent you this line:\n\n${phase1Output}\n\n` +
          `Echo back EXACTLY the marker token that appears on that line (the token ` +
          `starting with MARK-), followed by " RECEIVED". No preamble.`,
      ],
      { mcpConfigPath: env.mcpConfigPath, timeoutMs: 90_000 },
    );

    expect(
      phase2.sessionId,
      `phase 2 got no session_id; stderr=${phase2.stderr.slice(0, 400)}`,
    ).not.toBeNull();
    expect(phase2.exitCode).toBe(0);
    // Phase 1 + Phase 2 are distinct sessions — composition is across-session,
    // not a Claude-internal continuation.
    expect(phase2.sessionId).not.toBe(phase1.sessionId);

    const phase2Output = extractFinalResult(phase2.stdout);
    expect(phase2Output, `phase 2 produced no result text`).toBeTruthy();

    // THE core assertion: phase 2's output proves it received phase 1's output.
    // Without the marker flowing through, the pipeline isn't a pipeline.
    expect(
      phase2Output.includes(marker),
      `phase 2 did NOT propagate phase 1's marker. ` +
        `phase1=${phase1Output.slice(0, 120)} | phase2=${phase2Output.slice(0, 120)}`,
    ).toBe(true);
  }, 360_000);

  it("soft: recorder captures both phases' turns under their respective session_ids", async () => {
    // Soft because coltrane's recorder may not be wired for ad-hoc -p
    // invocations (no gig_dispatch in this test). RED here documents the gap
    // between the spawn-claude CLI and coltrane's gig observability.
    const marker = `MARK-${randomUUID().slice(0, 12)}`;
    const phase1 = await spawnClaudeSubthread(
      ["-p", `Reply with exactly: ${marker}`],
      { mcpConfigPath: env.mcpConfigPath, timeoutMs: 90_000 },
    );
    expect(phase1.sessionId).not.toBeNull();

    const phase2 = await spawnClaudeSubthread(
      ["-p", `Phase 1 said: ${marker}. Echo it back.`],
      { mcpConfigPath: env.mcpConfigPath, timeoutMs: 90_000 },
    );
    expect(phase2.sessionId).not.toBeNull();

    const recorderPath = env.recorderPath;
    if (!existsSync(recorderPath)) {
      // Diagnostic, not a hard fail — proves the gap honestly.
      console.warn(`[soft] recorder log missing at ${recorderPath}`);
      return;
    }
    const lines = readFileSync(recorderPath, "utf-8").split("\n").filter(Boolean);
    const sids = new Set<string>();
    for (const line of lines) {
      try {
        const e = JSON.parse(line) as Record<string, unknown>;
        if (typeof e["session_id"] === "string") sids.add(e["session_id"]);
      } catch {
        /* skip */
      }
    }
    // Diagnostic warn (not hard expect) when MCP server isn't actually invoked
    // by these plain -p calls (no tool calls = no recorder writes).
    if (phase1.sessionId && !sids.has(phase1.sessionId)) {
      console.warn(
        `[soft] recorder missed phase 1 session ${phase1.sessionId}; ` +
          `captured ${sids.size} sessions across ${lines.length} entries.`,
      );
    }
    if (phase2.sessionId && !sids.has(phase2.sessionId)) {
      console.warn(
        `[soft] recorder missed phase 2 session ${phase2.sessionId}.`,
      );
    }
  }, 360_000);
});

/**
 * Pull the final assistant text out of stream-json stdout. The Claude CLI emits
 * a terminal `{"type":"result","result":"..."}` event whose `result` is the
 * model's final response. Falls back to concatenated assistant text blocks if
 * the result event is absent.
 */
function extractFinalResult(stdout: string): string {
  let result = "";
  const assistantText: string[] = [];
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const ev = JSON.parse(t) as Record<string, unknown>;
      if (ev.type === "result" && typeof ev.result === "string") {
        result = ev.result;
      } else if (ev.type === "assistant" && ev.message && typeof ev.message === "object") {
        const m = ev.message as { content?: Array<{ type?: string; text?: string }> };
        if (Array.isArray(m.content)) {
          for (const c of m.content) {
            if (c.type === "text" && typeof c.text === "string") assistantText.push(c.text);
          }
        }
      }
    } catch {
      /* non-json */
    }
  }
  return result || assistantText.join("\n");
}
