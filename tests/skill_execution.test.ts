// RED-first contract tests — skills as first-class, the EXECUTION contract
// (docs/skills-as-first-class.md, "Sandbox / isolation" open question, resolved to a
// Node --permission subprocess). The cage must be real enforcement, scaled by tier:
//   tier 0 — read-only (load code, read input); no write, no spawn, no net
//   tier 1 — + fs-write
//   tier 2 — + child_process
// Below the matrix: a runaway code half must be timed out (and SIGKILL-escalated past a
// SIGTERM trap); the timeout default comes from meta.timeout_ms; and a broken code half
// must fail with an error a skill author can act on.
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { existsSync, rmSync, statSync } from "node:fs";
import { executeSkill } from "../src/skill_subprocess.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const F = (slug: string) => join(REPO_ROOT, "tests/_skill_fixtures", slug);
const DENIED = /access|permission|restricted|denied|ERR_ACCESS_DENIED/i;

const sleep = (ms: number) =>
  new Promise<void>((res) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      /* busy-wait — vitest fake timers off; keeps the poll synchronous-simple */
    }
    res();
  });

describe("skill execution: the tier x capability matrix is real enforcement", () => {
  it("tier 0 DENIES fs-write", () => {
    const escapeFile = "/tmp/coltrane-skill-escape-should-not-exist.txt";
    rmSync(escapeFile, { force: true });
    const r = executeSkill(F("escape-probe"), {});
    expect(r.ok).toBe(false);
    expect(r.error ?? "").toMatch(DENIED);
    expect(existsSync(escapeFile)).toBe(false);
  });

  it("tier 0 DENIES child_process (same spawn code that tier 2 allows)", () => {
    const r = executeSkill(F("spawner-denied"), {});
    expect(r.ok).toBe(false);
    expect(r.error ?? "").toMatch(DENIED);
  });

  it("tier 2 ALLOWS child_process — the grant is what makes the capability available", () => {
    const r = executeSkill(F("spawner"), {});
    expect(r.ok, r.error).toBe(true);
    expect(r.output).toEqual({ child_stdout: "pong" });
  });
});

describe("skill execution: runaway + broken code halves are contained", () => {
  it("times a runaway code half out using meta.timeout_ms, not just the caller default", () => {
    // crasher declares timeout_ms:1500. We pass a LARGER explicit ceiling (4000) — the
    // executor must still stop at the meta budget, so the call returns well under 3s.
    const r = executeSkill(F("crasher"), {}, 4000);
    expect(r.ok).toBe(false);
    expect(r.duration_ms).toBeLessThan(3000);
  }, 8000);

  it("escalates to SIGKILL past a SIGTERM trap — the heartbeat stops after the executor returns", async () => {
    const marker = "/tmp/coltrane-sigterm-trap-heartbeat.txt";
    rmSync(marker, { force: true });
    const r = executeSkill(F("sigterm-trap"), { marker }, 1500);
    expect(r.ok).toBe(false);
    // the executor must KILL at the timeout, not block until the child self-exits — so
    // it returns near the 1500ms budget, not seconds later (plain spawnSync would block
    // on a SIGTERM-trapping child; only a SIGKILL escalation returns promptly).
    expect(r.duration_ms, "executor blocked on a SIGTERM-trapping child instead of escalating").toBeLessThan(2800);
    // and once it returns, the child is dead — the heartbeat must not advance
    await sleep(400);
    const t1 = existsSync(marker) ? statSync(marker).mtimeMs : 0;
    await sleep(700);
    const t2 = existsSync(marker) ? statSync(marker).mtimeMs : 0;
    expect(t2, "heartbeat still advancing => child survived the kill (no SIGKILL escalation)").toBe(t1);
  }, 12000);

  it("returns an actionable error when the code half has no run() export", () => {
    const r = executeSkill(F("broken-export"), {});
    expect(r.ok).toBe(false);
    expect(r.error ?? "").toMatch(/run\b|export|no .*function/i);
  });
});
