// The local, file-backed gig queue — the third gig backing, the offline sibling of the two HTTP
// seams (postgrestQueueGig / rpcQueueGig, src/genome_store.ts:532,:493). It closes the asymmetry the
// SPEC (docs/specs/SPEC-local-queue-contract.md) names: the genome port already ships a LOCAL sibling
// (fileGenomeStore, src/genome_store.ts:77) so a genome can be READ from files, but the queue port
// had none — so an open-source user could run gigs in-process yet never enqueue. This module is that
// missing sibling: clone → build → enqueue → `coltrane work` in another terminal claims and runs it,
// with no Supabase, no service origin, no cdk_ key, no minting backend.
//
// MUTUAL EXCLUSION WITHOUT A DATABASE OR A LOCK. State is a directory-per-state layout under `root`
// (queued/, claimed/, parked/, done/, failed/, cancelled/), and every transition is a single POSIX
// rename(2), which is atomic within a filesystem. A claim renames queued/<id> → claimed/<id>: the
// winner's rename removes the source, and every loser's rename of the same source fails ENOENT — that
// is how a loser learns it lost (maildir new/→cur/, cr.yp.to; FSQ tmp/→queue/→done/). No lockfile
// (which would leave stale residue reintroducing the race), no in-process mutex (which cannot cross
// the server / `coltrane work` process boundary this queue exists to bridge), no SQLite (a forbidden
// dependency). node's own fs is sufficient, and the atomicity argument depends on staying on one FS.
//
// LEASE, not lock. A claim carries a lease {holder, renewed_at, expires_at} embedded in the moved
// file, so one atomic rename carries the claim AND its lease together — there is never a window where
// a claim exists without its lease. The holder renews with heartbeat (strictly advances the lease);
// a crashed holder's grip falls open by timeout, and reap() returns lapsed claims to queued while
// never touching a fresh one. A clock may be injected (opts.clock) so lease/reap laws are
// deterministic and fast; it defaults to Date.now().
//
// IDEMPOTENT EFFECT. Because a lapsed lease lets a second worker re-run a gig, the honest guarantee
// is at-least-once + idempotent-effect: complete() seals the output under content_sha (the same
// sha256Hex(canonJson(...)) primitive the rest of the codebase uses), a re-run with the SAME output
// re-seals rather than duplicating (duplicated:true), and a re-run that would seal a DIFFERENT output
// fails closed rather than forking.
//
// This module is NOT wired into any surface (deps.queueGig / deps.cancelGig) — shipping the module
// and its laws going green is a separate act from selecting it as a backing.
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { sha256Hex, canonJson } from "./canonical_form.js";

// ── The exported surface (mirrors tests/spec_local_queue_fixtures.ts, the authoritative source). ──

/** The lease a claimed gig carries — a continuing renewed fact (monotonic `renewed_at`), not a boot
 *  assertion. */
export interface LeaseState {
  holder: string;
  renewed_at: number;
  expires_at: number;
}

/** A claimed local gig — the sibling of worker.ts ClaimedGig, plus the local lease and, on a
 *  re-claim, the human seat's role-keyed verdicts. */
export interface ClaimedLocalGig {
  gig_id: string;
  standard_slug: string;
  standard_version: number | null;
  mode: string;
  input: Record<string, unknown>;
  acting_for: string;
  venue?: string | null;
  worker: string;
  lease: LeaseState;
  approvals?: Record<string, { verdict: Record<string, unknown>; approved_by?: string }> | null;
}

/** One row's observable state — how a reader tells a live claim from an abandoned one. */
export interface LocalGigView {
  gig_id: string;
  state: "queued" | "claimed" | "awaiting_approval" | "complete" | "failed" | "cancelled";
  holder?: string;
  lease?: LeaseState;
}

export interface LocalQueueOptions {
  leaseMs?: number;
  /** Injected clock for deterministic lease/reap laws. Defaults to Date.now(). */
  clock?: () => number;
}

/** The local queue port — every verb is offline and needs no credential. */
export interface LocalQueue {
  enqueue(args: Record<string, unknown>): Promise<{ gig_id: string; status: "queued" }>;
  claim(worker: string): Promise<ClaimedLocalGig | null>;
  heartbeat(worker: string, gig_id: string): Promise<boolean>;
  reap(): { requeued: string[]; kept: number; errors: string[] };
  park(worker: string, gig_id: string): Promise<boolean>;
  approve(gig_id: string, role: string, verdict: Record<string, unknown>, approved_by?: string): Promise<boolean>;
  cancel(args: Record<string, unknown>): Promise<{ gig_id: string; status: "cancelled" }>;
  complete(worker: string, gig_id: string, output: Record<string, unknown>): Promise<{ content_sha: string; duplicated: boolean }>;
  list(): LocalGigView[];
  readonly leaseMs: number;
}

/** Which backing owns the queue, decided by which environment is present. */
export type QueueBackingChoice =
  | { backing: "file"; root: string }
  | { backing: "hosted" }
  | { backing: "none"; why: string }
  | { backing: "conflict"; why: string };

export interface LocalQueueModule {
  openLocalQueue(root: string, opts?: LocalQueueOptions): LocalQueue;
  fileQueueGig(root: string): (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  fileCancelGig(root: string): (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  selectQueueBacking(env: Record<string, string | undefined>): QueueBackingChoice;
  LOCAL_QUEUE_DIR_VAR: string;
  DRAIN_VARS: readonly string[];
}

// ── The env-presence contract. ────────────────────────────────────────────────────────────────────

/** The env var whose presence selects the local backing. */
export const LOCAL_QUEUE_DIR_VAR = "COLTRANE_QUEUE_DIR";

/** The drain's five-variable contract (drain_preflight.ts:55-61), kept SORTED. The local path must
 *  never read a VALUE of any of these; selectQueueBacking only ever inspects key PRESENCE. */
export const DRAIN_VARS: readonly string[] = [
  "COLTRANE_DRAIN_KEY",
  "COLTRANE_DRAIN_URL",
  "COLTRANE_INSTANCE",
  "COLTRANE_STORE_ANON",
  "COLTRANE_STORE_URL",
];

/**
 * The single backing selector — file when the local dir is present, hosted for the drain env,
 * conflict when both, none otherwise. It reads the VALUE of exactly one variable, LOCAL_QUEUE_DIR_VAR
 * (not a drain var), and detects hosted presence by KEY PRESENCE via Object.keys — never by reading a
 * drain variable's value. That distinction is load-bearing for F8: the test passes an env Proxy whose
 * `get` trap throws on any drain-var read, so hosted detection must go through `ownKeys` (Object.keys
 * does not trip the `get` trap), letting a local-present env resolve to `file` without touching one of
 * the five. Values of the drain vars are never needed — their mere presence is the whole signal.
 */
export function selectQueueBacking(env: Record<string, string | undefined>): QueueBackingChoice {
  const localRaw = env[LOCAL_QUEUE_DIR_VAR];
  const localPresent = typeof localRaw === "string" && localRaw.length > 0;
  const keys = Object.keys(env);
  const hostedPresent = DRAIN_VARS.some((v) => keys.includes(v));

  if (localPresent && hostedPresent) {
    return {
      backing: "conflict",
      why: `both ${LOCAL_QUEUE_DIR_VAR} and the hosted drain environment are set — refusing to guess which backing owns the gig`,
    };
  }
  if (localPresent) return { backing: "file", root: localRaw };
  if (hostedPresent) return { backing: "hosted" };
  return {
    backing: "none",
    why: `no queue backing configured — set ${LOCAL_QUEUE_DIR_VAR} for a local file queue, or the drain environment for the hosted queue`,
  };
}

// ── Internal persistence shape. Extra fields (enqueued_at, content_sha, output) travel with the file
//    through every rename; the typed views (ClaimedLocalGig / LocalGigView) project a subset. ───────

interface StoredGig {
  gig_id: string;
  standard_slug: string;
  standard_version: number | null;
  mode: string;
  input: Record<string, unknown>;
  acting_for: string;
  venue: string | null;
  enqueued_at: number;
  worker?: string;
  lease?: LeaseState;
  approvals?: Record<string, { verdict: Record<string, unknown>; approved_by?: string }>;
  content_sha?: string;
  output?: Record<string, unknown>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const DEFAULT_LEASE_MS = 30_000;

export function openLocalQueue(root: string, opts?: LocalQueueOptions): LocalQueue {
  const leaseMs = opts?.leaseMs ?? DEFAULT_LEASE_MS;
  const clock = opts?.clock ?? Date.now;

  const queuedDir = join(root, "queued");
  const claimedDir = join(root, "claimed");
  const parkedDir = join(root, "parked");
  const doneDir = join(root, "done");
  const failedDir = join(root, "failed");
  const cancelledDir = join(root, "cancelled");
  const tmpDir = join(root, "tmp");

  const dirsByState: ReadonlyArray<readonly [string, LocalGigView["state"]]> = [
    [queuedDir, "queued"],
    [claimedDir, "claimed"],
    [parkedDir, "awaiting_approval"],
    [doneDir, "complete"],
    [failedDir, "failed"],
    [cancelledDir, "cancelled"],
  ];

  // A tmp+rename atomic write: a reader of the destination sees either the OLD bytes or the whole NEW
  // bytes, never a mixture. tmp lives in a dedicated dir so a claim's readdir of queued/ never lists a
  // half-written temp file (F4).
  async function atomicWrite(dir: string, name: string, obj: StoredGig): Promise<void> {
    await fsp.mkdir(tmpDir, { recursive: true });
    const tmp = join(tmpDir, `${randomUUID()}.tmp`);
    await fsp.writeFile(tmp, JSON.stringify(obj), "utf8");
    await fsp.mkdir(dir, { recursive: true });
    await fsp.rename(tmp, join(dir, name));
  }

  async function readGig(path: string): Promise<StoredGig | null> {
    try {
      return JSON.parse(await fsp.readFile(path, "utf8")) as StoredGig;
    } catch {
      return null;
    }
  }

  function isEnoent(e: unknown): boolean {
    return typeof e === "object" && e !== null && (e as { code?: string }).code === "ENOENT";
  }

  async function enqueue(args: Record<string, unknown>): Promise<{ gig_id: string; status: "queued" }> {
    // F10 — a payload with no standard to run is unrunnable. Refuse at enqueue and persist nothing,
    // rather than enqueue a row that can only fail on a drain thirty minutes later.
    const slug = args["standard_slug"];
    if (typeof slug !== "string" || slug.length === 0) {
      throw new Error("enqueue requires a non-empty standard_slug — nothing to run");
    }
    const gig_id = randomUUID();
    const now = clock();
    const record: StoredGig = {
      gig_id,
      standard_slug: slug,
      standard_version: typeof args["standard_version"] === "number" ? (args["standard_version"] as number) : null,
      mode: typeof args["mode"] === "string" ? (args["mode"] as string) : "live",
      input: isRecord(args["input"]) ? args["input"] : {},
      acting_for: typeof args["acting_for"] === "string" ? (args["acting_for"] as string) : "",
      venue: typeof args["venue"] === "string" ? (args["venue"] as string) : null,
      enqueued_at: now,
    };
    // F1/F4 — write then rename over queued/<gig_id>. If the root cannot be persisted to (mkdir/rename
    // fails, e.g. ENOTDIR under a regular file), this throws and NO success is reported.
    await atomicWrite(queuedDir, gig_id, record);
    return { gig_id, status: "queued" };
  }

  async function claim(worker: string): Promise<ClaimedLocalGig | null> {
    let candidates: string[];
    try {
      candidates = (await fsp.readdir(queuedDir)).sort();
    } catch {
      return null; // no queued/ dir yet ⇒ nothing to claim
    }
    await fsp.mkdir(claimedDir, { recursive: true });
    for (const id of candidates) {
      const src = join(queuedDir, id);
      const dst = join(claimedDir, id);
      try {
        // The arbiter. Exactly one concurrent claimer's rename of a given source succeeds; every other
        // gets ENOENT (I4/I5/F3) and moves on to the next candidate (I19). A live gig is not in
        // queued/ at all, so it is never a candidate here (F7).
        await fsp.rename(src, dst);
      } catch {
        // A lost rename race (ENOENT) is how a loser learns it lost; any other per-row fault is
        // likewise "could not take this row". Either way, move to the next candidate — a lost row is
        // the null sentinel, never a thrown claim (I5/F3).
        continue;
      }
      const record = await readGig(dst);
      if (record === null) continue;
      const now = clock();
      const lease: LeaseState = { holder: worker, renewed_at: now, expires_at: now + leaseMs };
      record.worker = worker;
      record.lease = lease;
      // Persist the lease alongside the claim (idempotent overwrite of a file only this claimer owns).
      await atomicWrite(claimedDir, id, record);
      const claimed: ClaimedLocalGig = {
        gig_id: record.gig_id,
        standard_slug: record.standard_slug,
        standard_version: record.standard_version,
        mode: record.mode,
        input: record.input,
        acting_for: record.acting_for,
        venue: record.venue,
        worker,
        lease,
        approvals: record.approvals ?? null,
      };
      return claimed;
    }
    return null;
  }

  async function heartbeat(worker: string, gig_id: string): Promise<boolean> {
    const path = join(claimedDir, gig_id);
    const record = await readGig(path);
    // F5 — the caller must still HOLD the claim. A heartbeat against a lease that was lost (the gig
    // lapsed and someone else took it) or that no longer exists is a loss, never a false "still held".
    if (record === null || record.lease === undefined || record.lease.holder !== worker) return false;
    const now = clock();
    record.lease = { holder: worker, renewed_at: now, expires_at: now + leaseMs };
    record.worker = worker;
    await atomicWrite(claimedDir, gig_id, record);
    return true;
  }

  function reap(): { requeued: string[]; kept: number; errors: string[] } {
    // SYNCHRONOUS and best-effort (mirrors worker.ts reapWorkerState): a single unreadable claim never
    // aborts the sweep. Only claimed/ is scanned, so a parked or terminal gig is structurally out of
    // reach (I13) rather than guarded by a per-file predicate a future edit could forget.
    const requeued: string[] = [];
    const errors: string[] = [];
    let kept = 0;
    const now = clock();
    let entries: string[];
    try {
      entries = fs.readdirSync(claimedDir);
    } catch {
      return { requeued, kept, errors };
    }
    for (const id of entries) {
      const path = join(claimedDir, id);
      try {
        const record = JSON.parse(fs.readFileSync(path, "utf8")) as StoredGig;
        const expires = record.lease?.expires_at;
        if (typeof expires === "number" && expires <= now) {
          // Lapsed (I9/I10/I11) — return it to queued for the next worker. The rename is atomic; the
          // stale lease left in the file is inert (list() reports no lease for a queued row, and the
          // next claim overwrites it).
          fs.mkdirSync(queuedDir, { recursive: true });
          fs.renameSync(path, join(queuedDir, id));
          requeued.push(id);
        } else {
          kept++; // fresh (I8/I10) — never touched
        }
      } catch (e) {
        errors.push(`${id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return { requeued, kept, errors };
  }

  async function park(worker: string, gig_id: string): Promise<boolean> {
    const src = join(claimedDir, gig_id);
    const record = await readGig(src);
    if (record === null || record.lease?.holder !== worker) return false;
    // Move claimed/ → parked/ first (one atomic rename), THEN clear the lease. The gig is never in two
    // places, and the reaper (which scans only claimed/) can never mistake it for an abandoned claim
    // (I13). awaiting_approval is not a live claim.
    await fsp.mkdir(parkedDir, { recursive: true });
    await fsp.rename(src, join(parkedDir, gig_id));
    delete record.lease;
    delete record.worker;
    await atomicWrite(parkedDir, gig_id, record);
    return true;
  }

  async function approve(
    gig_id: string,
    role: string,
    verdict: Record<string, unknown>,
    approved_by?: string,
  ): Promise<boolean> {
    // F6 — an empty verdict is not an approval. Fail closed rather than resume past the human chair on
    // a verdict that says nothing.
    if (!isRecord(verdict) || Object.keys(verdict).length === 0) {
      throw new Error("an empty verdict is not an approval — refusing to resume past the human chair");
    }
    const src = join(parkedDir, gig_id);
    const record = await readGig(src);
    if (record === null) return false;
    const entry: { verdict: Record<string, unknown>; approved_by?: string } =
      approved_by !== undefined ? { verdict, approved_by } : { verdict };
    const approvals: Record<string, { verdict: Record<string, unknown>; approved_by?: string }> = {
      ...(record.approvals ?? {}),
    };
    approvals[role] = entry;
    record.approvals = approvals;
    // Seal the verdict into the parked row, THEN move parked/ → queued/ in one atomic rename, so the
    // re-claimable row appears in queued/ already carrying its verdicts (I12).
    await atomicWrite(parkedDir, gig_id, record);
    await fsp.mkdir(queuedDir, { recursive: true });
    await fsp.rename(join(parkedDir, gig_id), join(queuedDir, gig_id));
    return true;
  }

  async function cancel(args: Record<string, unknown>): Promise<{ gig_id: string; status: "cancelled" }> {
    const gig_id = typeof args["gig_id"] === "string" ? (args["gig_id"] as string) : String(args["gig_id"] ?? "");
    // Sibling of postgrestCancelGig: cancels a QUEUED row so it can never be claimed (I18). Moving it
    // out of queued/ is the whole mechanism — a cancelled gig is simply no longer a claim candidate.
    try {
      await fsp.mkdir(cancelledDir, { recursive: true });
      await fsp.rename(join(queuedDir, gig_id), join(cancelledDir, gig_id));
    } catch (e) {
      if (!isEnoent(e)) throw e; // not-queued (already gone) is idempotent; a real IO fault is not
    }
    return { gig_id, status: "cancelled" };
  }

  async function locate(gig_id: string): Promise<{ dir: string; path: string } | null> {
    for (const [dir] of dirsByState) {
      const path = join(dir, gig_id);
      try {
        await fsp.access(path);
        return { dir, path };
      } catch {
        /* not in this state dir */
      }
    }
    return null;
  }

  async function complete(
    worker: string,
    gig_id: string,
    output: Record<string, unknown>,
  ): Promise<{ content_sha: string; duplicated: boolean }> {
    const loc = await locate(gig_id);
    if (loc === null) throw new Error(`cannot complete unknown gig ${gig_id}`);
    const record = await readGig(loc.path);
    if (record === null) throw new Error(`cannot complete unreadable gig ${gig_id}`);
    // content_sha is a pure function of the output via the codebase's own canonical hash, so two
    // separate completions of identical output hash identically by construction (I14).
    const content_sha = sha256Hex(canonJson(output));
    if (record.content_sha !== undefined) {
      // I14 — a re-run (after a lapsed lease let a second worker take the gig) re-seals the SAME output
      // rather than duplicating. F9 — a DIFFERENT output for the same gig fails closed, never forks.
      if (record.content_sha === content_sha) return { content_sha, duplicated: true };
      throw new Error(`gig ${gig_id} already sealed a different output — refusing to fork the result`);
    }
    // Record the seal in place. The gig stays where it is (typically still claimed): a lapsed lease can
    // then let a second worker re-run it, and that re-run dedups against this recorded content_sha.
    record.content_sha = content_sha;
    record.output = output;
    await atomicWrite(loc.dir, gig_id, record);
    return { content_sha, duplicated: false };
  }

  function list(): LocalGigView[] {
    const views: LocalGigView[] = [];
    for (const [dir, state] of dirsByState) {
      let entries: string[];
      try {
        entries = fs.readdirSync(dir);
      } catch {
        continue; // dir not created yet
      }
      for (const id of entries) {
        if (state === "claimed") {
          try {
            const record = JSON.parse(fs.readFileSync(join(dir, id), "utf8")) as StoredGig;
            if (record.lease && typeof record.lease.holder === "string") {
              views.push({ gig_id: id, state, holder: record.lease.holder, lease: record.lease });
              continue;
            }
          } catch {
            /* fall through to the lease-less view */
          }
          views.push({ gig_id: id, state });
        } else {
          views.push({ gig_id: id, state });
        }
      }
    }
    return views;
  }

  return { enqueue, claim, heartbeat, reap, park, approve, cancel, complete, list, leaseMs };
}

/** The deps.queueGig-shaped enqueue seam — byte-compatible with postgrestQueueGig / rpcQueueGig
 *  ({gig_id, status:'queued'}), so a caller cannot tell which backing answered (I1). */
export function fileQueueGig(root: string): (args: Record<string, unknown>) => Promise<Record<string, unknown>> {
  const q = openLocalQueue(root);
  return (args) => q.enqueue(args);
}

/** The deps.cancelGig-shaped seam — sibling of postgrestCancelGig ({gig_id, status:'cancelled'})
 *  (I18). */
export function fileCancelGig(root: string): (args: Record<string, unknown>) => Promise<Record<string, unknown>> {
  const q = openLocalQueue(root);
  return (args) => q.cancel(args);
}
