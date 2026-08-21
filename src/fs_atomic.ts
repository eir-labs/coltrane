/**
 * Atomic file replacement — write to a unique temp path, then rename over the destination.
 *
 * rename(2) is atomic within a filesystem, so a concurrent reader sees the OLD bytes or the NEW
 * bytes and never a mixture. A bare `writeFileSync` gives no such guarantee: interrupted partway
 * (crash, SIGKILL, ENOSPC) it leaves a truncated file where a valid one used to be.
 *
 * This exists as a shared primitive because both callers that need it are load-bearing and were
 * getting different answers:
 *
 *   - the checkpoint store (reuse.ts) already did this, with the reasoning written down: "a torn
 *     checkpoint would be read as damage and refuse a resume that was, in fact, resumable".
 *   - the GENOME writer (genome_writer.ts) did not, and it is the more consequential of the two.
 *     `sealDefinition` records a definition's identity in the ledger BEFORE writing the file
 *     (#218), deliberately, because the reverse order manufactures a definition with no recorded
 *     identity. That ordering is only safe if the write itself either happens or does not. A torn
 *     genome write leaves the ledger asserting a definition at a content hash whose bytes on disk
 *     hash to something else — the engine's core provenance claim, broken silently.
 *
 * Two implementations of one concern, one of them documented and one of them absent, is the same
 * shape as the two identity gates that disagreed in the resume work.
 */
import { mkdirSync, writeFileSync, renameSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";

export function writeFileAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  // randomUUID, not pid: two containers sharing a mounted volume routinely both have low pids,
  // and a colliding temp name lets one process's torn write get renamed over the real file.
  const tmp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, file);
}

// ── SINGLE-FLIGHT: the per-repo dispatch lock (change c1d0c2e0) ──────────────────────────────────
//
// Nothing else stops two host-seat gigs from being dispatched against the same working tree. Each
// derives its sealed change-set from `git diff` of a tree the other is mutating, so two concurrent
// runs corrupt each other's change-set SILENTLY — the worst failure a clearing mechanism can have,
// because a participant cannot even observe that clearing failed. So a dispatch against a working
// tree claims an EXCLUSIVE per-repo lock BEFORE any chair runs, and a second dispatch against a
// held tree is REFUSED (never queued, never waited on) with a structured error naming the holder.
//
// The atomic claim is `open(dest, O_CREAT|O_EXCL)` — Node's `writeFileSync(..., { flag: "wx" })` —
// NOT a bare write-then-rename. rename(2) is atomic but OVERWRITES its destination, so it could not
// detect an existing holder; the exclusive-create flag is the one primitive that fails closed
// (EEXIST) exactly when the tree is already claimed. Staleness is decided by PID LIVENESS, never a
// wall-clock TTL: a TTL risks breaking a live-but-slow gig mid-run, which is the corruption this
// lock exists to prevent. A dead holder's lock is broken, the break RECORDED to stderr (never
// silent), and re-acquired.

/** The lock record — names WHO holds the tree, so a refusal can say who to wait on or abort. */
export interface RepoLockRecord {
  gig_id: string;
  pid: number;
  started_at: string;
  genome_dir: string;
}

/** The outcome of a claim: the tree, or the live holder that refused it. */
export type RepoLockAcquire =
  | { ok: true; record: RepoLockRecord; reacquired: boolean }
  | { ok: false; held_by: RepoLockRecord };

/**
 * The canonical lock path for a genome root: `<genomeDir>/.coltrane/repo-lock-<hex>.json`, where
 * `<hex>` is a stable SHA-256 digest of the ABSOLUTE genome_dir truncated to 16 hex chars. The
 * digest keeps the filename slash/space-free and bounded while the full path is preserved inside
 * the record. `.coltrane/` is gitignored (beside the ledger and the mirror), so the artifact is a
 * runtime lock, never committed.
 */
export function repoLockPath(genomeDir: string): string {
  const abs = resolve(genomeDir);
  const hex = createHash("sha256").update(abs).digest("hex").slice(0, 16);
  return join(abs, ".coltrane", `repo-lock-${hex}.json`);
}

function isCode(e: unknown, code: string): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === code;
}

/** A holder pid is alive iff `process.kill(pid, 0)` does not throw ESRCH. EPERM means the process
 *  exists but is not ours to signal — still alive. Any other error is treated conservatively as
 *  alive so a transient fault never breaks a lock that might still be live. */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (isCode(e, "ESRCH")) return false;
    return true;
  }
}

function readLockRecord(path: string): RepoLockRecord | undefined {
  try {
    const rec = JSON.parse(readFileSync(path, "utf8")) as RepoLockRecord;
    if (rec && typeof rec.gig_id === "string" && typeof rec.pid === "number") return rec;
    return undefined;
  } catch {
    return undefined; // ENOENT (raced away) or a torn/unparsable file — treat as no readable holder
  }
}

/** Record a broken stale lock to stderr — never silent, so an operator can audit which dead gig's
 *  grip was released and reclaimed. Shaped as a one-line JSON event like the gig milestone log. */
function recordStaleBreak(dest: string, held: RepoLockRecord | undefined): void {
  const line = JSON.stringify({
    t: new Date().toISOString(),
    ev: "repo_lock_stale_break",
    stale_gig_id: held?.gig_id ?? "(unreadable)",
    stale_pid: held?.pid ?? null,
    reason: "holder pid not alive",
    lock: dest,
  });
  try {
    process.stderr.write(line + "\n");
  } catch {
    /* best-effort — the break still happens; only its record is lost */
  }
}

/**
 * Claim the per-repo lock for `genomeDir`, keyed on the resolved genome root.
 *
 * Atomic and exclusive via O_EXCL. On an existing destination:
 *   - the SAME gig_id (a parked gig's own resume) re-acquires the tree it already holds;
 *   - a LIVE holder refuses the claim, carrying `held_by`;
 *   - a DEAD holder (or a torn file) is broken — recorded, unlinked — and the claim retried.
 */
export function acquireRepoLock(
  genomeDir: string,
  holder: { gigId: string; pid: number; startedAt: string },
): RepoLockAcquire {
  const dest = repoLockPath(genomeDir);
  mkdirSync(dirname(dest), { recursive: true });
  const record: RepoLockRecord = {
    gig_id: holder.gigId,
    pid: holder.pid,
    started_at: holder.startedAt,
    genome_dir: resolve(genomeDir),
  };
  const payload = JSON.stringify(record);
  // A small retry budget: each stale break unlinks and loops to re-create. More than one iteration
  // is only reached under an active race (another process re-took the freed slot), which the next
  // read resolves — never an unbounded spin.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(dest, payload, { encoding: "utf8", flag: "wx" });
      return { ok: true, record, reacquired: false };
    } catch (e) {
      if (!isCode(e, "EEXIST")) throw e;
    }
    const held = readLockRecord(dest);
    if (held && held.gig_id === holder.gigId) return { ok: true, record: held, reacquired: true };
    if (held && pidAlive(held.pid)) return { ok: false, held_by: held };
    // Dead holder or torn file — break it (recorded) and retry the exclusive create.
    recordStaleBreak(dest, held);
    try {
      unlinkSync(dest);
    } catch (e) {
      if (!isCode(e, "ENOENT")) throw e;
    }
  }
  // Exhausted the budget: another process keeps re-taking the freed slot. Refuse with the best
  // holder we can read rather than clobber a live claim.
  const held = readLockRecord(dest);
  if (held && held.gig_id === holder.gigId) return { ok: true, record: held, reacquired: true };
  return { ok: false, held_by: held ?? record };
}

/**
 * Release the per-repo lock — but ONLY when the recorded holder is `gigId`. A release that finds a
 * different holder never steals it (that lock belongs to another run). Returns whether a lock this
 * gig held was actually removed.
 */
export function releaseRepoLock(genomeDir: string, gigId: string): boolean {
  const dest = repoLockPath(genomeDir);
  const held = readLockRecord(dest);
  if (!held || held.gig_id !== gigId) return false;
  try {
    unlinkSync(dest);
    return true;
  } catch (e) {
    if (isCode(e, "ENOENT")) return false;
    throw e;
  }
}
