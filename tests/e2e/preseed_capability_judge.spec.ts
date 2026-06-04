// preseed_capability_judge.spec.ts — EMPIRICAL capability test for pre-seeded Steve.
//
// What this test is asking, precisely:
//   Does pre-seeding a Steve's transcript with curated turns about coltrane's
//   forward-sha audit-chain pattern actually CHANGE WHAT IT CAN DO on a
//   judgeable task — not merely change which vocabulary it uses?
//
// Subhuti's prior result (preseed_vocab_judge): seeded Steves parrot our
// vocabulary, cold Steves don't. That proves PRIMING is real. It does not
// prove CAPABILITY transfer. Eugene's pushback is correct: vocab presence is
// table-stakes; the question is whether the seeded Steve can solve a problem
// the cold one cannot.
//
// Design (3 cold × 3 seeded, judge arm graded 0/1):
//
//   TASK:  Given a 5-event audit chain where event 3's sha_seal is wrong
//          (computed sha_seal does not match the stored sha_seal), identify
//          the tampered event and explain via sha_seal mismatch.
//
//   COLD:    `claude -p <task>` in a fresh cwd with no pre-seed jsonl.
//
//   SEEDED:  Pre-place a JSONL with curated turns teaching the forward-sha
//            pattern (prev_sha == predecessor.sha_seal; sha_seal = sha256 of
//            canonical-JSON with sha_seal field empty). Then `claude --resume
//            <sid> -p <task>`.
//
//   JUDGE:   Separate `claude -p` invocation given (task, answer) and asked
//            "did this answer correctly identify event 3 as the tampered one
//            AND explain via sha_seal mismatch?" → returns "YES" or "NO".
//
//   N = 3 trials per arm, independent JSONLs, independent sids, independent
//   judges. Report hit-rate per arm.
//
// Honesty contract:
//   - No mocks of the claude CLI; real subprocesses, full token roundtrips.
//   - If cold matches seeded, we publish that — priming-only, no capability
//     gain. The result is the diagnostic, not a quota to hit.
//   - The judge is itself an LLM and can be wrong; we expose the judge's raw
//     reply alongside the binary verdict so a reader can re-grade by eye.
//
// Authored by miles under capability-judge discipline.

import { describe, expect, it } from "vitest";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";

import { spawnClaudeSubthread, resumeSubthread, assistantText, parseStreamJson } from "./_harness.js";

// ──────────────────────────────────────────────────────────────────────────
// JSONL turn builders (same shape as preseeded_steve_session.spec.ts).
// ──────────────────────────────────────────────────────────────────────────

function projectSlugFor(cwd: string): string {
  return realpathSync(cwd).replace(/\//g, "-");
}

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

/**
 * Curated teaching turns for the SEEDED arm. We teach the forward-sha pattern
 * with the SAME mechanics the task will exercise — but on a DIFFERENT example
 * (a 3-event toy chain), so success on the 5-event task is real reasoning,
 * not pattern-matching the seed verbatim.
 */
function buildSeedTurns(sessionId: string, cwd: string): string[] {
  const u1 = randomUUID();
  const a1 = randomUUID();
  const u2 = randomUUID();
  const a2 = randomUUID();
  const ts = "2026-06-04T15:00:00.000Z";

  const teach1 = `Coltrane uses a forward-sha audit chain. Each event has two integrity fields:
  - sha_seal: sha256 of the event's canonical JSON with the sha_seal field set to empty string.
  - prev_sha: the sha_seal of the IMMEDIATELY PRECEDING event in the stream.
The genesis event (index 0) has prev_sha = sha256("GENESIS"). Any silent edit to a past
event's body invalidates its sha_seal (recomputed seal will not match stored seal) AND
breaks every prev_sha downstream of it.`;

  const teach2 = `To detect tampering: walk the stream in order. For each event, recompute its
sha_seal from its canonical body (with sha_seal field emptied) and compare to the stored
sha_seal. ALSO verify prev_sha equals the previous event's sha_seal. The FIRST event whose
recomputed seal != stored seal is the tampered one; report it by index. Example: in a 3-event
chain [A,B,C], if B's payload was silently edited after sealing, then recompute(B).sha_seal
will not equal B.sha_seal — B is the tampered event. Explain it as: "event B's stored
sha_seal does not match its recomputed sha_seal, indicating its body was modified after
sealing."`;

  return [
    userTurn({ parentUuid: null, uuid: u1, sessionId, cwd, ts, text: `How does coltrane's audit chain detect tampering?` }),
    assistantTurn({ parentUuid: u1, uuid: a1, sessionId, cwd, ts, text: teach1 }),
    userTurn({ parentUuid: a1, uuid: u2, sessionId, cwd, ts, text: `If I hand you a chain of events and one is tampered, how do I find it and explain why?` }),
    assistantTurn({ parentUuid: u2, uuid: a2, sessionId, cwd, ts, text: teach2 }),
  ];
}

// ──────────────────────────────────────────────────────────────────────────
// The task: a 5-event chain where event 3 (1-indexed) has a wrong sha_seal.
//
// We DO NOT actually need cryptographically-correct seals for the other 4
// events — what matters for grading is that the prompt clearly shows event 3
// as the one whose stored sha_seal does not match what sha256 of its body
// would produce. We compute one real sha256 demo on a known string so the
// model has a verifiable anchor, then state the chain as data.
// ──────────────────────────────────────────────────────────────────────────

function buildTaskPrompt(): string {
  // Real sha256 of "GENESIS" so the model can verify our genesis anchor.
  const genesis = createHash("sha256").update("GENESIS").digest("hex");
  // Stable, plausible-looking seals (truncated for readability). The KEY
  // property: event 3's stored sha_seal does not match what its body would
  // hash to — the prompt asserts that mismatch as observable ground truth.
  return `You are auditing a 5-event chain from coltrane's forward-sha audit log.

Each event has fields: index, body, prev_sha, sha_seal (stored).
The chain uses forward-sha linking: prev_sha of event N = sha_seal of event N-1.
Event 1 has prev_sha = sha256("GENESIS") = ${genesis}.
sha_seal of an event is sha256 of its canonical JSON with sha_seal field emptied.

I ran the verifier and computed each event's sha_seal from its body. Here is the
result. Use it to identify which event was tampered with and explain why.

  event 1: body={"action":"create","gig":"g_alpha"}     stored_sha_seal=aaa1...  recomputed_sha_seal=aaa1...  prev_sha=${genesis.slice(0, 8)}...  -> MATCH
  event 2: body={"action":"engage","primitive":"SENSE"} stored_sha_seal=bbb2...  recomputed_sha_seal=bbb2...  prev_sha=aaa1...                       -> MATCH
  event 3: body={"action":"verdict","verdict":"PASS"}   stored_sha_seal=ccc3...  recomputed_sha_seal=zzz9...  prev_sha=bbb2...                       -> MISMATCH
  event 4: body={"action":"engage","primitive":"PLAN"}  stored_sha_seal=ddd4...  recomputed_sha_seal=ddd4...  prev_sha=ccc3...                       -> MATCH
  event 5: body={"action":"close","gig":"g_alpha"}      stored_sha_seal=eee5...  recomputed_sha_seal=eee5...  prev_sha=ddd4...                       -> MATCH

QUESTION: Which event was tampered with, and why? Be specific: name the event
by its index and explain the mechanism in one or two sentences.`;
}

// ──────────────────────────────────────────────────────────────────────────
// Judge: a separate claude -p invocation that grades 0/1.
// ──────────────────────────────────────────────────────────────────────────

interface JudgeVerdict {
  binary: 0 | 1;
  raw_reply: string;
  reasoning: string;
}

async function judgeAnswer(taskPrompt: string, answer: string, cwd: string): Promise<JudgeVerdict> {
  const judgePrompt = `You are grading a single answer to an audit-chain forensics task.

The task that was asked:
"""
${taskPrompt}
"""

The candidate's answer:
"""
${answer}
"""

Grade YES iff BOTH of these hold:
  (a) the answer identifies EVENT 3 as the tampered event (by index 3, not by content);
  (b) the answer's explanation invokes sha_seal mismatch (stored vs recomputed seal not matching).

Respond with EXACTLY this format on two lines:
VERDICT: YES
REASON: <one sentence>

or

VERDICT: NO
REASON: <one sentence>

Do not include anything else.`;

  const result = await spawnClaudeSubthread(["-p", judgePrompt], { cwd, timeoutMs: 180_000 });
  const events = parseStreamJson(result.stdout);
  const raw = assistantText(events).trim();
  const verdictLine = raw.split("\n").find((l) => /^VERDICT:/i.test(l)) ?? "";
  const reasonLine = raw.split("\n").find((l) => /^REASON:/i.test(l)) ?? "";
  const isYes = /VERDICT:\s*YES/i.test(verdictLine);
  return {
    binary: isYes ? 1 : 0,
    raw_reply: raw,
    reasoning: reasonLine.replace(/^REASON:\s*/i, "").trim(),
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Arm runners.
// ──────────────────────────────────────────────────────────────────────────

interface TrialResult {
  arm: "cold" | "seeded";
  trial_idx: number;
  session_id: string;
  answer: string;
  judge: JudgeVerdict;
  duration_ms: number;
  claude_exit: number | null;
}

async function runColdTrial(trialIdx: number): Promise<TrialResult> {
  const sid = randomUUID();
  const cwd = realpathSync("/tmp");
  const trialCwd = join(cwd, `preseed-cap-cold-${sid.slice(0, 8)}`);
  mkdirSync(trialCwd, { recursive: true });
  const taskPrompt = buildTaskPrompt();
  const t0 = Date.now();
  try {
    const result = await spawnClaudeSubthread(["-p", taskPrompt], {
      cwd: trialCwd,
      timeoutMs: 240_000,
      sessionId: sid,
    });
    const answer = assistantText(parseStreamJson(result.stdout)).trim();
    const judge = await judgeAnswer(taskPrompt, answer, trialCwd);
    return {
      arm: "cold",
      trial_idx: trialIdx,
      session_id: sid,
      answer,
      judge,
      duration_ms: Date.now() - t0,
      claude_exit: result.exitCode,
    };
  } finally {
    try {
      rmSync(trialCwd, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

async function runSeededTrial(trialIdx: number): Promise<TrialResult> {
  const sid = randomUUID();
  const cwd = realpathSync("/tmp");
  const trialCwd = join(cwd, `preseed-cap-seeded-${sid.slice(0, 8)}`);
  mkdirSync(trialCwd, { recursive: true });

  // Pre-place the JSONL at the claude-recognized location.
  const slug = projectSlugFor(trialCwd);
  const projectDir = join(homedir(), ".claude", "projects", slug);
  mkdirSync(projectDir, { recursive: true });
  const jsonlPath = join(projectDir, `${sid}.jsonl`);
  const lines = buildSeedTurns(sid, trialCwd);
  writeFileSync(jsonlPath, lines.join("\n") + "\n");

  const taskPrompt = buildTaskPrompt();
  const t0 = Date.now();
  try {
    const result = await resumeSubthread(sid, taskPrompt, {
      cwd: trialCwd,
      timeoutMs: 240_000,
    });
    const answer = assistantText(parseStreamJson(result.stdout)).trim();
    const judge = await judgeAnswer(taskPrompt, answer, trialCwd);
    return {
      arm: "seeded",
      trial_idx: trialIdx,
      session_id: sid,
      answer,
      judge,
      duration_ms: Date.now() - t0,
      claude_exit: result.exitCode,
    };
  } finally {
    try {
      rmSync(trialCwd, { recursive: true, force: true });
      // leave the preseed jsonl for forensics (small, named by sid)
    } catch {
      /* best-effort */
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// The capability-judge test.
// ──────────────────────────────────────────────────────────────────────────

const N_PER_ARM = 3;

describe("pre-seeded Steve: CAPABILITY judge (not vocab parroting)", () => {
  it(`N=${N_PER_ARM} cold trials + N=${N_PER_ARM} seeded trials, judge grades 0/1, hit-rate per arm`, async () => {
    const cold: TrialResult[] = [];
    const seeded: TrialResult[] = [];

    for (let i = 0; i < N_PER_ARM; i++) {
      // eslint-disable-next-line no-await-in-loop
      cold.push(await runColdTrial(i));
    }
    for (let i = 0; i < N_PER_ARM; i++) {
      // eslint-disable-next-line no-await-in-loop
      seeded.push(await runSeededTrial(i));
    }

    const coldHits = cold.reduce((s, r) => s + r.judge.binary, 0);
    const seededHits = seeded.reduce((s, r) => s + r.judge.binary, 0);

    // Emit the full empirical record to stdout for inclusion in the PR body.
    // We deliberately do NOT hide trial-level detail — Eugene reads it.
    const summary = {
      n_per_arm: N_PER_ARM,
      cold_hit_rate: `${coldHits}/${N_PER_ARM}`,
      seeded_hit_rate: `${seededHits}/${N_PER_ARM}`,
      cold: cold.map((r) => ({
        trial: r.trial_idx,
        verdict: r.judge.binary,
        reason: r.judge.reasoning,
        answer_head: r.answer.slice(0, 280),
        duration_ms: r.duration_ms,
        claude_exit: r.claude_exit,
      })),
      seeded: seeded.map((r) => ({
        trial: r.trial_idx,
        verdict: r.judge.binary,
        reason: r.judge.reasoning,
        answer_head: r.answer.slice(0, 280),
        duration_ms: r.duration_ms,
        claude_exit: r.claude_exit,
      })),
    };
    // eslint-disable-next-line no-console
    console.log("\n=== CAPABILITY JUDGE RESULTS ===\n" + JSON.stringify(summary, null, 2) + "\n=== END ===\n");

    // Sanity gates only — we do NOT assert seeded > cold here. The empirical
    // hit-rates are the deliverable; whether they support the capability
    // claim is a question for the report, not a test pass/fail.
    expect(cold.length).toBe(N_PER_ARM);
    expect(seeded.length).toBe(N_PER_ARM);
    for (const r of [...cold, ...seeded]) {
      expect(r.claude_exit, `claude exit nonzero for arm=${r.arm} trial=${r.trial_idx}`).toBe(0);
      expect(r.answer.length).toBeGreaterThan(0);
    }
  }, 1_800_000); // 30 min budget for 6 task runs + 6 judge runs
});
