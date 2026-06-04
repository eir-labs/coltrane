// e2e: "stop prompting from scratch every session" — the README's load-bearing
// claim, expressed as a real-Claude two-session test.
//
// Background. coltrane's pitch is that you don't re-explain prior context to a
// fresh Claude session. The mechanism: outputs persisted to disk (PR #98 →
// outputs-persist-jsonl on miles' branch), readable through the `output_query`
// MCP tool. A new session, attached to the same coltrane MCP server pointed at
// the same outputs dir, should answer questions about prior gigs by querying
// the persisted outputs — NOT by being re-told what happened.
//
// Pre-reg shape (RED / GREEN):
//   1. Session A: claude writes a typed output via mcp__coltrane__output_write
//      (the same persistence path gig_dispatch flows through), an output lands
//      in the jsonl-persisted store.
//   2. Session A closes. Process gone, in-memory Map gone. Only disk survives.
//   3. Session B: fresh `claude -p` invocation (NEW session_id, no resume),
//      pointed at the SAME COLTRANE_OUTPUTS_DIR. User asks "what was the last
//      gig and its output?". Claude must answer by calling output_query and
//      reporting what it finds — not by being re-told.
//
// Counter-claim (the bug this guards): session B's claude has no memory of
// session A; if outputs don't persist to disk, output_query returns an empty
// list, and claude either (a) admits it can't tell, or (b) hallucinates. Both
// fail the test.
//
// This test depends on the outputs-persist-jsonl wiring (`createOutputStore`
// with `persistDir`, `defaultOutputsPersistDir` → COLTRANE_OUTPUTS_DIR). It is
// branch-gated until PR #98 merges to main.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  setupTempdirColtrane,
  spawnClaudeSubthread,
  parseStreamJson,
  assistantText,
  type TempdirColtrane,
} from "./_harness.js";

const SKIP_PERMS = "--dangerously-skip-permissions";

// Patch the harness's mcp-config to inject COLTRANE_OUTPUTS_DIR into the MCP
// server's env, so both sessions' MCP server children read/write the same
// on-disk outputs store. The per-spawn config writer in _harness.ts merges on
// TOP of this base env, so this survives across spawns.
function injectOutputsDirIntoMcpConfig(env: TempdirColtrane, outputsDir: string): void {
  const raw = JSON.parse(readFileSync(env.mcpConfigPath, "utf-8")) as {
    mcpServers: Record<string, { env?: Record<string, string> } & Record<string, unknown>>;
  };
  for (const def of Object.values(raw.mcpServers)) {
    def.env = { ...(def.env ?? {}), COLTRANE_OUTPUTS_DIR: outputsDir };
  }
  writeFileSync(env.mcpConfigPath, JSON.stringify(raw, null, 2));
}

interface DispatchToolCall {
  name: string;
  input: Record<string, unknown>;
}

function coltraneToolUses(stdout: string): DispatchToolCall[] {
  const events = parseStreamJson(stdout);
  const calls: DispatchToolCall[] = [];
  for (const ev of events) {
    if (ev.type !== "assistant") continue;
    const msg = ev.message as
      | { content?: Array<{ type?: string; name?: string; input?: Record<string, unknown> }> }
      | undefined;
    if (!msg?.content) continue;
    for (const block of msg.content) {
      if (block.type === "tool_use" && typeof block.name === "string" && block.name.startsWith("mcp__coltrane__")) {
        calls.push({ name: block.name, input: block.input ?? {} });
      }
    }
  }
  return calls;
}

describe("e2e: no prompting from scratch — session B answers from persisted outputs (#98)", () => {
  let env: TempdirColtrane;
  let outputsDir: string;

  beforeAll(async () => {
    env = await setupTempdirColtrane();
    // Dedicated outputs dir shared across both sessions. Distinct from the
    // tempdir genome root so the test asserts on outputs-persist plumbing
    // rather than incidental genome co-location.
    outputsDir = mkdtempSync(join(tmpdir(), "coltrane-no-scratch-outputs-"));
    injectOutputsDirIntoMcpConfig(env, outputsDir);
  }, 600_000);

  afterAll(() => {
    try { rmSync(outputsDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    env?.cleanup();
  });

  it("session A writes an output via real claude; session B reads it back without being re-told", async () => {
    // ---------- SESSION A: real claude writes a typed output ----------
    //
    // We use output_write (not gig_dispatch) so the spec doesn't require a
    // particular standard to exist in the tempdir genome; the persistence
    // mechanism — which is what's under test — is the same code path either
    // way (createOutputStore + persistDir → jsonl append).
    const a = await spawnClaudeSubthread(
      [
        "-p",
        [
          "I'm using the coltrane MCP. Call mcp__coltrane__output_write EXACTLY ONCE with:",
          "core_type='Signal',",
          "domain_type='raw-note',",
          "domain='eirtests',",
          "gig_id='gig-no-prompting-from-scratch-A',",
          "agent_slug='scout',",
          "primitive='SENSE',",
          "data={ \"body\": \"the-cold-trial-message\" }.",
          "Then reply with the single word 'done'. Do not explain anything.",
        ].join(" "),
        SKIP_PERMS,
      ],
      { mcpConfigPath: env.mcpConfigPath, cwd: env.tempDir, timeoutMs: 240_000 },
    );

    expect(a.exitCode, `session A claude stderr:\n${a.stderr.slice(0, 800)}`).toBe(0);
    expect(a.sessionId, "session A claude did not emit a session_id").not.toBeNull();

    const wrote = coltraneToolUses(a.stdout).find((c) => c.name === "mcp__coltrane__output_write");
    expect(wrote, "session A claude did not call output_write").toBeDefined();
    expect(wrote!.input["gig_id"]).toBe("gig-no-prompting-from-scratch-A");

    // The write MUST have landed on disk under COLTRANE_OUTPUTS_DIR — this is
    // the kill condition the README's claim hangs on. If the file isn't here,
    // outputs are still in-memory-only and session B will read empty.
    const gigFile = join(outputsDir, "outputs", "gig-no-prompting-from-scratch-A.jsonl");
    expect(
      existsSync(gigFile),
      `outputs file did not land at ${gigFile} after session A — persist wiring is dark`,
    ).toBe(true);
    const lines = readFileSync(gigFile, "utf-8").trim().split("\n").filter(Boolean);
    expect(lines.length, "expected 1 jsonl row from session A's write").toBe(1);

    // ---------- SESSION B: brand-new claude session (no --resume) ----------
    //
    // No shared context, no shared session_id. Session B knows NOTHING about
    // session A's conversation. The only carrier between them is the persisted
    // outputs dir, reached through the coltrane MCP's output_query tool.
    const b = await spawnClaudeSubthread(
      [
        "-p",
        [
          "I just opened a brand new session in this coltrane repo.",
          "I don't remember the last gig I ran. Use the coltrane MCP tool",
          "mcp__coltrane__output_query (filter by domain_type='raw-note') to find it,",
          "then tell me the gig_id and the body of the output's data field.",
          "Just call the tool, then report what you found in one sentence.",
        ].join(" "),
        SKIP_PERMS,
      ],
      { mcpConfigPath: env.mcpConfigPath, cwd: env.tempDir, timeoutMs: 240_000 },
    );

    expect(b.exitCode, `session B claude stderr:\n${b.stderr.slice(0, 800)}`).toBe(0);
    expect(b.sessionId, "session B claude did not emit a session_id").not.toBeNull();
    // Different process, different session — proves we're not riding session A's memory.
    expect(b.sessionId).not.toBe(a.sessionId);

    const queried = coltraneToolUses(b.stdout).find((c) => c.name === "mcp__coltrane__output_query");
    expect(queried, "session B claude did not call output_query").toBeDefined();

    // The load-bearing assertion: claude's final answer in session B reports
    // the gig_id + body content from session A, with NO conversational priming.
    const reply = assistantText(parseStreamJson(b.stdout)).toLowerCase();
    expect(
      reply,
      `session B reply should reference session A's gig id; got:\n${reply}`,
    ).toMatch(/gig-no-prompting-from-scratch-a/);
    expect(
      reply,
      `session B reply should report the persisted body content; got:\n${reply}`,
    ).toMatch(/the-cold-trial-message/);
  }, 600_000);
});
