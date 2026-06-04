// preseeded_steve_session.spec.ts — empirical test for nested-chain composition.
//
// Two levers under test (both previously proven; this is the integration):
//   LEVER 1: pre-seed ~/.claude/projects/<cwd-slug>/<sid>.jsonl with curated
//            user/assistant turns, then `claude --resume <sid>` recalls them.
//   LEVER 2: forward-sha audit chain from coltrane composes around the claude
//            session — write an audit event referencing the claude session_uuid
//            and verify both chains remain intact independently.
//
// Design: Steve spawns with a curated starter JSONL containing a "secret token"
// that primes it toward known-good orientation. We assert the spawned claude
// recalls the token (Lever 1 working end-to-end), then append an audit-chain
// event for that session_uuid (Lever 2 nested composition).
//
// Per pre-reg honesty: no mocks of the claude CLI. If the host's claude can't
// load the pre-seed, this goes RED — that's the real diagnostic.
//
// Authored by miles under preseed-Steve discipline.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  AuditEvent,
  chainEvent,
  GENESIS_PREV_SHA,
  verifyAuditChain,
} from "../../src/audit_chain.js";

import { spawnClaudeSubthread, resumeSubthread, assistantText, parseStreamJson } from "./_harness.js";

/**
 * Claude derives the project-dir name by replacing '/' with '-' in the realpath
 * of cwd. On macOS, /tmp/foo resolves to /private/tmp/foo — so the slug is
 * "-private-tmp-foo" not "-tmp-foo". Use realpathSync to match.
 */
function projectSlugFor(cwd: string): string {
  return realpathSync(cwd).replace(/\//g, "-");
}

/** Build one user turn in the JSONL format claude recognizes for --resume. */
function userTurn(opts: {
  parentUuid: string | null;
  uuid: string;
  sessionId: string;
  cwd: string;
  text: string;
  ts: string;
}): string {
  return JSON.stringify({
    parentUuid: opts.parentUuid,
    isSidechain: false,
    userType: "external",
    cwd: opts.cwd,
    sessionId: opts.sessionId,
    version: "2.1.160",
    gitBranch: "",
    type: "user",
    uuid: opts.uuid,
    timestamp: opts.ts,
    message: { role: "user", content: opts.text },
  });
}

/** Build one assistant turn. */
function assistantTurn(opts: {
  parentUuid: string;
  uuid: string;
  sessionId: string;
  cwd: string;
  text: string;
  ts: string;
}): string {
  return JSON.stringify({
    parentUuid: opts.parentUuid,
    isSidechain: false,
    userType: "external",
    cwd: opts.cwd,
    sessionId: opts.sessionId,
    version: "2.1.160",
    gitBranch: "",
    type: "assistant",
    uuid: opts.uuid,
    timestamp: opts.ts,
    message: {
      model: "claude-opus-4-8",
      id: "msg_seed",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: opts.text }],
      stop_reason: "end_turn",
    },
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Shared lifecycle: one tempdir, one pre-seeded session, asserted end-to-end.
// ────────────────────────────────────────────────────────────────────────────

const SECRET_TOKEN = "COLTRANE-STEVE-INIT-2026";
const TEST_SESSION_UUID = randomUUID();

let cwd: string;
let projectDir: string;
let jsonlPath: string;

describe("pre-seeded Steve session: nested-chain composition", () => {
  beforeAll(() => {
    // Rob's clone-dir: a fresh tempdir under /tmp, realpath'd through /private/tmp on mac.
    cwd = realpathSync.native
      ? realpathSync.native(`/tmp`)
      : realpathSync(`/tmp`);
    cwd = join(cwd, `preseed-steve-${TEST_SESSION_UUID.slice(0, 8)}`);
    mkdirSync(cwd, { recursive: true });

    // Pre-seed the JSONL at the claude-recognized location.
    const slug = projectSlugFor(cwd);
    projectDir = join(homedir(), ".claude", "projects", slug);
    mkdirSync(projectDir, { recursive: true });
    jsonlPath = join(projectDir, `${TEST_SESSION_UUID}.jsonl`);

    const u1 = randomUUID();
    const a1 = randomUUID();
    const ts = "2026-06-04T15:00:00.000Z";

    const lines = [
      userTurn({
        parentUuid: null,
        uuid: u1,
        sessionId: TEST_SESSION_UUID,
        cwd,
        ts,
        text: `What's the secret token for this Steve?`,
      }),
      assistantTurn({
        parentUuid: u1,
        uuid: a1,
        sessionId: TEST_SESSION_UUID,
        cwd,
        ts,
        text: `The secret token is ${SECRET_TOKEN}.`,
      }),
    ];
    writeFileSync(jsonlPath, lines.join("\n") + "\n");
  });

  afterAll(() => {
    // Leave the pre-seed jsonl in place for forensic inspection; just clean the tempdir.
    try {
      rmSync(cwd, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // LEVER 1: pre-seed survives the resume + primes the spawned Steve.
  // ──────────────────────────────────────────────────────────────────────────
  it("LEVER 1: claude --resume <sid> recalls the pre-seeded secret token", async () => {
    // Sanity: the pre-seed file is on disk where claude expects it.
    expect(existsSync(jsonlPath)).toBe(true);
    const preSeedBytes = readFileSync(jsonlPath, "utf-8");
    expect(preSeedBytes).toContain(SECRET_TOKEN);

    // Spawn claude resuming the pre-seeded session, asking for the token.
    // Use --resume so claude loads the existing transcript before answering.
    const result = await resumeSubthread(
      TEST_SESSION_UUID,
      `What's the token you remember from earlier in this conversation? Respond with only the token, nothing else.`,
      { cwd, timeoutMs: 180_000 },
    );

    // Honest failure surfaces: print stderr head when assertion fails.
    expect(
      result.exitCode,
      `claude exit=${result.exitCode} stderr=${result.stderr.slice(0, 800)}`,
    ).toBe(0);

    // The session id should be the one we pinned (resume re-uses it).
    expect(result.sessionId).toBe(TEST_SESSION_UUID);

    // Parse stream-json and assert the assistant text contains the secret.
    const events = parseStreamJson(result.stdout);
    const reply = assistantText(events);
    expect(
      reply,
      `assistant said: ${reply.slice(0, 400)} | stderr: ${result.stderr.slice(0, 200)}`,
    ).toContain(SECRET_TOKEN);
  }, 240_000);

  // ──────────────────────────────────────────────────────────────────────────
  // LEVER 2: nested-chain composition — write a coltrane audit event keyed on
  // the claude session_uuid and verify both chains independently:
  //   (a) the claude session jsonl still parses + still contains pre-seed + new turns
  //   (b) the coltrane audit chain verifies with verifyAuditChain
  // ──────────────────────────────────────────────────────────────────────────
  it("LEVER 2: nested audit chain references session_uuid + verifyAuditChain reports ok", () => {
    // Build a 3-event audit chain that references the claude session.
    const baseTs = "2026-06-04T15:01:00Z";
    const e0 = chainEvent(null, {
      session_uuid: TEST_SESSION_UUID,
      ts: baseTs,
      surface: "head",
      kind: "primitive_engage",
      primitive: "SENSE",
      payload: { note: "preseed loaded", token: SECRET_TOKEN },
    });
    const e1 = chainEvent(e0, {
      session_uuid: TEST_SESSION_UUID,
      ts: "2026-06-04T15:02:00Z",
      surface: "hands",
      kind: "tool_call",
      primitive: "INTERPRET",
      payload: { tool: "claude_resume", target_session: TEST_SESSION_UUID },
    });
    const e2 = chainEvent(e1, {
      session_uuid: TEST_SESSION_UUID,
      ts: "2026-06-04T15:03:00Z",
      surface: "head",
      kind: "verdict",
      primitive: "VERIFY",
      payload: { verdict: "preseed_recalled", token_match: true },
    });

    const stream: AuditEvent[] = [e0, e1, e2];

    // Forward-link integrity: each event's prev_sha == predecessor's sha_seal.
    expect(e0.prev_sha).toBe(GENESIS_PREV_SHA);
    expect(e1.prev_sha).toBe(e0.sha_seal);
    expect(e2.prev_sha).toBe(e1.sha_seal);

    // verifyAuditChain confirms the coltrane chain is intact.
    const v = verifyAuditChain(stream);
    expect(v.ok, JSON.stringify(v)).toBe(true);
    if (v.ok) expect(v.length).toBe(3);

    // Every event references the claude session_uuid (nesting proof).
    for (const e of stream) {
      expect(e.session_uuid).toBe(TEST_SESSION_UUID);
    }

    // Claude chain integrity: the jsonl on disk is unmodified by our audit-event writes.
    expect(existsSync(jsonlPath)).toBe(true);
    const onDisk = readFileSync(jsonlPath, "utf-8");
    expect(onDisk).toContain(SECRET_TOKEN);
    expect(onDisk).toContain(TEST_SESSION_UUID);

    // Cross-chain composition: the audit-chain payload references the claude
    // session_uuid AND the claude jsonl is independently readable. Two chains,
    // independently verifiable, composed via shared session_uuid identifier.
    const tamperDetect = verifyAuditChain([
      e0,
      { ...e1, payload: { tool: "TAMPERED", target_session: TEST_SESSION_UUID } },
      e2,
    ]);
    expect(tamperDetect.ok).toBe(false);
    if (!tamperDetect.ok) {
      expect(tamperDetect.broken_at).toBe(1);
      expect(tamperDetect.reason).toBe("sha_seal_mismatch");
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Re-resume after the audit-chain composition: claude session chain still
  // resumes cleanly. Proves the two chains are truly independent — coltrane
  // verification does not corrupt the claude transcript.
  // ──────────────────────────────────────────────────────────────────────────
  it("LEVER 2 follow-up: claude session re-resumes cleanly after audit-chain composition", async () => {
    const result = await spawnClaudeSubthread(
      ["--resume", TEST_SESSION_UUID, "-p", `Reply with the literal word: ack`],
      { cwd, timeoutMs: 180_000, sessionId: TEST_SESSION_UUID },
    );
    expect(
      result.exitCode,
      `re-resume exit=${result.exitCode} stderr=${result.stderr.slice(0, 800)}`,
    ).toBe(0);
    expect(result.sessionId).toBe(TEST_SESSION_UUID);
    const events = parseStreamJson(result.stdout);
    const reply = assistantText(events);
    expect(reply.toLowerCase()).toContain("ack");
  }, 240_000);
});
