// STALE-LOCK BREAK — a dead holder must not wedge the repo forever.
//
// The lock keys on pid liveness, never a wall-clock TTL (a TTL risks breaking a live-but-slow gig
// mid-run — the corruption this law exists to prevent). If the recorded holder pid is not alive
// (process.kill(pid, 0) throws ESRCH), the next dispatch BREAKS the lock and re-acquires it. The
// break is RECORDED observably — a log line naming the stale gig_id and pid — never silent, so a
// broken lock leaves a trail an operator can audit.
//
// The lock artifact's canonical path is derived from the genome root, so the primitive that owns
// acquisition must expose that path (`repoLockPath`) for a planted-stale-lock test to reach it.
//
// RED-first: no acquire/stale-break code exists and `fs_atomic` exposes no `repoLockPath`, so the
// planted dead-holder file is never read and no break is recorded.
import { describe, it, expect, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { dispatchTool } from "../src/server.js";
import * as fsAtomic from "../src/fs_atomic.js";
import { freshGenomeDir, depsFor, fastInvoke, pollSettled } from "./_support/repo_lock_fixtures.js";

describe("stale-lock break — a dead-pid lock is broken, the dispatch proceeds, and the break is recorded", () => {
  it("breaks a planted dead-holder lock, re-acquires, and records the break naming the stale gig + pid", async () => {
    const root = freshGenomeDir();

    // The primitive must expose the canonical lock path so a stale record can be planted at it.
    const repoLockPath = (fsAtomic as { repoLockPath?: (genomeDir: string) => string }).repoLockPath;
    expect(repoLockPath, "fs_atomic must expose repoLockPath(genomeDir) — the canonical repo-lock path").toBeTypeOf("function");
    const lockPath = repoLockPath!(root);
    expect(lockPath, "the lock artifact lives under .coltrane/").toMatch(/\.coltrane[\\/]repo-lock-.*\.json$/);

    // Plant a lock whose holder is provably dead. Max-int dwarfs every OS pid range, so
    // process.kill(stalePid, 0) throws ESRCH — the exact signal the primitive reads as "not alive".
    const stalePid = 2147483646;
    const staleGig = "dead-gig-00000000";
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ gig_id: staleGig, pid: stalePid, started_at: "2026-01-01T00:00:00.000Z", genome_dir: root }));

    // Capture the observable break record (the house pattern tees log lines to process.stderr).
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown): boolean => { lines.push(String(chunk)); return true; });
    const d = depsFor(root, fastInvoke);
    let r;
    try {
      r = await dispatchTool("gig_dispatch", { standard_slug: "lock-demo", input: {} }, d);
    } finally {
      spy.mockRestore();
    }

    expect(r.ok, "a lock whose holder pid is dead is stale — the dispatch breaks it and proceeds").toBe(true);
    const record = lines.join("");
    expect(record, "breaking a stale lock must be RECORDED — naming the stale gig — never silent").toContain(staleGig);
    expect(record, "…and the stale pid, so the break can be audited").toContain(String(stalePid));

    await pollSettled(d, (r.data as { gig_id: string }).gig_id);
  });
});
