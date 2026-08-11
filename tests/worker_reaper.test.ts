// The worker state root gets a bounded reaper.
//
// The runtime drops a checkpoint on SUCCESS, but a FAILED / awaiting-approval / abandoned gig
// leaves its `checkpoints/<gig>.json` (+ the `outputs/` and `refs/` rows it names) behind
// forever — an unbounded disk leak. `reapWorkerState` drops what is old enough to be presumed
// abandoned, by MTIME, and never touches fresh (load-bearing) state.
//
// The assertions are real side effects: files gone from disk / files still on disk — never a
// bare return-value parse.

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  reapWorkerState, workOnce, DEFAULT_WORKER_STATE_TTL_DAYS, workerStateTtlDays,
  type WorkerContext, type WorkOnceDeps,
} from "../src/worker.js";

function seedRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "coltrane-reaper-"));
  for (const d of ["checkpoints", "outputs", "refs"]) mkdirSync(join(root, d), { recursive: true });
  return root;
}

/** Write a file and stamp its mtime to `ageDays` in the past. */
function seedFile(root: string, sub: string, name: string, ageDays: number): string {
  const file = join(root, sub, name);
  writeFileSync(file, "{}\n");
  const when = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
  utimesSync(file, when, when);
  return file;
}

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) { try { rmSync(r, { recursive: true, force: true }); } catch { /* ignore */ } } });
function freshRoot(): string { const r = seedRoot(); roots.push(r); return r; }

describe("reapWorkerState — bounded, mtime-gated, load-bearing-safe", () => {
  it("drops an OLD checkpoint and its sibling rows, KEEPS a fresh checkpoint and its rows", () => {
    const root = freshRoot();
    // Old, abandoned gig — checkpoint + siblings, all 30 days old (TTL default is 7).
    const oldCp = seedFile(root, "checkpoints", "gig-old.json", 30);
    const oldOut = seedFile(root, "outputs", "gig-old.jsonl", 30);
    const oldRef = seedFile(root, "refs", "gig-old.jsonl", 30);
    // Fresh, load-bearing gig (e.g. parked yesterday) — checkpoint + siblings, 1 day old.
    const freshCp = seedFile(root, "checkpoints", "gig-fresh.json", 1);
    const freshOut = seedFile(root, "outputs", "gig-fresh.jsonl", 1);

    const res = reapWorkerState(root);

    expect(existsSync(oldCp), "old checkpoint reaped").toBe(false);
    expect(existsSync(oldOut), "old checkpoint's output row reaped").toBe(false);
    expect(existsSync(oldRef), "old checkpoint's refs row reaped").toBe(false);
    expect(existsSync(freshCp), "fresh checkpoint kept — it is load-bearing for an approved resume").toBe(true);
    expect(existsSync(freshOut), "fresh checkpoint's outputs kept").toBe(true);
    expect(res.checkpoints_removed).toEqual(["gig-old"]);
    expect(res.kept, "one fresh checkpoint inspected and kept").toBe(1);
  });

  it("KEEPS a fresh checkpoint's outputs even when the output file itself looks old (restore-only resume)", () => {
    const root = freshRoot();
    const freshCp = seedFile(root, "checkpoints", "gig-p.json", 1);   // re-touched on resume
    const oldButOwnedOut = seedFile(root, "outputs", "gig-p.jsonl", 40); // rows never re-appended
    reapWorkerState(root);
    expect(existsSync(freshCp)).toBe(true);
    expect(existsSync(oldButOwnedOut), "a live checkpoint's rows are protected regardless of their own age").toBe(true);
  });

  it("sweeps an ORPHAN output row (no checkpoint — a completed gig's leftover) once it is old", () => {
    const root = freshRoot();
    const orphanOld = seedFile(root, "outputs", "gig-done.jsonl", 20); // success dropped the checkpoint
    const orphanFresh = seedFile(root, "outputs", "gig-recent.jsonl", 1);
    const res = reapWorkerState(root);
    expect(existsSync(orphanOld), "old orphan output row swept — the other half of the leak").toBe(false);
    expect(existsSync(orphanFresh), "recent orphan kept").toBe(true);
    expect(res.orphans_removed).toEqual(["gig-done"]);
  });

  it("honors the ttlDays override", () => {
    const root = freshRoot();
    const cp = seedFile(root, "checkpoints", "gig-x.json", 3);
    reapWorkerState(root, { ttlDays: 1 }); // 3 days old > 1 day TTL → reap
    expect(existsSync(cp)).toBe(false);
  });

  it("never throws when the state root is malformed (best-effort swallow, errors recorded)", () => {
    const root = mkdtempSync(join(tmpdir(), "coltrane-reaper-bad-"));
    roots.push(root);
    // `checkpoints` is a FILE, not a directory — readdir will error inside the reaper.
    writeFileSync(join(root, "checkpoints"), "not a dir");
    let res!: ReturnType<typeof reapWorkerState>;
    expect(() => { res = reapWorkerState(root); }, "the reaper must not throw").not.toThrow();
    expect(res.errors.length, "the failure is recorded, not swallowed silently").toBeGreaterThan(0);
  });

  it("TTL comes from COLTRANE_WORKER_STATE_TTL_DAYS, defaulting to the documented default", () => {
    const prev = process.env["COLTRANE_WORKER_STATE_TTL_DAYS"];
    try {
      delete process.env["COLTRANE_WORKER_STATE_TTL_DAYS"];
      expect(workerStateTtlDays()).toBe(DEFAULT_WORKER_STATE_TTL_DAYS);
      process.env["COLTRANE_WORKER_STATE_TTL_DAYS"] = "2";
      expect(workerStateTtlDays()).toBe(2);
    } finally {
      if (prev === undefined) delete process.env["COLTRANE_WORKER_STATE_TTL_DAYS"];
      else process.env["COLTRANE_WORKER_STATE_TTL_DAYS"] = prev;
    }
  });
});

describe("workOnce — a reap failure never fails the claim (wrap-safety)", () => {
  it("swallows a broken-state-root reap and still returns cleanly", async () => {
    // Point the worker state root at a path whose `checkpoints` is a FILE, so the pre-claim reap
    // hits an internal error. The claim RPC is stubbed to return no work, so workOnce returns
    // {claimed:false} — and that it returns at all is the assertion: the reap did not throw out.
    const badRoot = mkdtempSync(join(tmpdir(), "coltrane-reaper-workonce-"));
    roots.push(badRoot);
    writeFileSync(join(badRoot, "checkpoints"), "not a dir");
    const prevRoot = process.env["COLTRANE_WORKER_CHECKPOINTS"];
    const prevFetch = globalThis.fetch;
    process.env["COLTRANE_WORKER_CHECKPOINTS"] = badRoot;
    // Stub the claim RPC → "no runnable gig".
    globalThis.fetch = (async () =>
      ({ ok: true, status: 200, text: async () => "null" }) as unknown as Response) as typeof fetch;
    try {
      const ctx: WorkerContext = { baseUrl: "http://stub.invalid", anonKey: "anon", agentToken: "ctk_stub" };
      const deps: WorkOnceDeps = { makeInvoke: () => () => ({}) };
      const res = await workOnce(ctx, deps);
      expect(res).toEqual({ claimed: false });
    } finally {
      globalThis.fetch = prevFetch;
      if (prevRoot === undefined) delete process.env["COLTRANE_WORKER_CHECKPOINTS"];
      else process.env["COLTRANE_WORKER_CHECKPOINTS"] = prevRoot;
    }
  });
});
