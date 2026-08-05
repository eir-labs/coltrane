// #253 — a skill chair cannot be aborted, because it blocks the event loop.
//
// `executeSkill` runs the skill's code half with `spawnSync` (src/skill_subprocess.ts:80).
// spawnSync blocks the thread until the child exits or its timeout fires, and the abort
// chain the runtime built in #249/#250 is cooperative: `checkpoint()` reads
// `deps.signal.aborted` between phases and batches, and the invoker kills its child on the
// signal. Neither can run while the loop is blocked — the ABORT EVENT ITSELF cannot even be
// delivered until the skill returns.
//
// So `gig_abort` on a skill chair is a promise the engine cannot keep for up to the skill's
// timeout (default 120s, and a skill may declare its own). That is the same shape as #249:
// a control the operator reaches for that reports success and does nothing. The difference
// is that #249 was a missing kill, and this is a missing *opportunity* to kill.
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeSkillAsync } from "../src/skill_subprocess.js";

/** A skill whose code half sleeps far longer than the test is willing to wait. */
function slowSkill(sleepMs: number): string {
  const dir = mkdtempSync(join(tmpdir(), "slow-skill-"));
  mkdirSync(join(dir, "fixtures"), { recursive: true });
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify({ slug: "slow", version: 1, permission: { tier: 0 }, timeout_ms: 120_000 }),
  );
  writeFileSync(
    join(dir, "skill.mjs"),
    `export default async function () {
       await new Promise((r) => setTimeout(r, ${sleepMs}));
       return { finished: true };
     }\n`,
  );
  return dir;
}

describe("#253 — a skill chair is interruptible", () => {
  // THE case. Without an async path this cannot even be expressed: the assertion below
  // would not run until the skill finished, so the test would pass by outlasting it.
  it("returns promptly when the signal aborts mid-skill, rather than blocking to completion", async () => {
    const dir = slowSkill(10_000);
    try {
      const ac = new AbortController();
      const started = Date.now();
      setTimeout(() => ac.abort(new Error("operator pressed stop")), 150);

      const res = await executeSkillAsync(dir, {}, 30_000, { signal: ac.signal });
      const elapsed = Date.now() - started;

      expect(res.ok, "an aborted skill did not succeed").toBe(false);
      expect(
        elapsed,
        "the call must return on the abort, not on the skill's own timeout — this is the " +
          "whole defect: spawnSync cannot be interrupted, so 'stop' waited out the skill",
      ).toBeLessThan(5_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("says it was aborted, rather than reporting a generic failure", async () => {
    const dir = slowSkill(10_000);
    try {
      const ac = new AbortController();
      setTimeout(() => ac.abort(new Error("operator pressed stop")), 150);
      const res = await executeSkillAsync(dir, {}, 30_000, { signal: ac.signal });
      expect(res.ok).toBe(false);
      expect(
        String(res.error),
        "an operator reading the log must be able to tell a cancellation from a crash",
      ).toMatch(/abort/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The event loop is the point. If the implementation still blocks, nothing else can run
  // while the skill does — including the timer that delivers the abort.
  it("does not block the event loop while the skill runs", async () => {
    const dir = slowSkill(1_500);
    try {
      let ticked = false;
      setTimeout(() => (ticked = true), 200);
      await executeSkillAsync(dir, {}, 30_000);
      expect(
        ticked,
        "a timer scheduled before the skill must have fired during it — if it did not, the " +
          "loop was blocked and no abort could have been delivered either",
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Positive control: aborting must not become "everything fails".
  it("runs a skill to completion when nothing aborts it", async () => {
    const dir = slowSkill(50);
    try {
      const res = await executeSkillAsync(dir, {}, 30_000, { signal: new AbortController().signal });
      expect(res.ok).toBe(true);
      expect((res.output as { finished?: boolean })?.finished).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A signal already aborted before the call must not spawn anything at all — the cheapest
  // possible honouring of a cancellation.
  it("does not start the subprocess when the signal is already aborted", async () => {
    const dir = slowSkill(10_000);
    try {
      const ac = new AbortController();
      ac.abort(new Error("already stopped"));
      const started = Date.now();
      const res = await executeSkillAsync(dir, {}, 30_000, { signal: ac.signal });
      expect(res.ok).toBe(false);
      expect(Date.now() - started, "nothing should have been spawned").toBeLessThan(1_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
