// ════════════════════════════════════════════════════════════════════════════════════════════
// PENDING IMPLEMENTATION — the spec_local_queue_*.test.ts band is committed RED on purpose. See
// docs/specs/SPEC-local-queue-contract.md. A failure in any spec_local_queue_* file is a feature
// not yet built (`src/local_queue.ts` does not exist); a failure in any file NOT named spec_* is a
// regression. Do not weaken these laws to make CI green; implement them.
// ════════════════════════════════════════════════════════════════════════════════════════════
//
// SHARED FIXTURE for the local file-backed gig queue — the third gig backing (subsystem-contract
// O1–O11 / I1–I19 / F1–F10). It carries the MODULE SURFACE the laws import, a throwing-Proxy loader
// that keeps the red at the assertion, a fresh-tmpdir helper (real rename(2), zero credentials,
// fully offline), and the fast-check arbitraries the property/model laws share.
//
// WHY THE LOADER IS SHAPED THIS WAY. `src/local_queue.ts` is not authored yet. Two hazards, both
// observed in-repo and both avoided here:
//   1. tsc compiles tests/** (tsconfig include) and `npm run build` runs before the suite
//      (tests/_support/build_once.ts). A STATIC import of an absent src module fails the shared
//      build and takes EVERY band down — nobody can then tell a pending spec from a regression. So
//      the specifier lives in a runtime-URL variable; tsc cannot resolve it and stays clean, and the
//      module is loaded at runtime. (This is the technique in tests/spec_worker_environment.test.ts.)
//   2. A top-level `beforeAll` that awaits the dynamic import makes the REJECTION fail COLLECTION —
//      vitest then marks every law `skipped`, a green-looking state for laws that never ran. So each
//      law loads the module INSIDE its own body, and on a failed import `loadLocalQueue()` returns a
//      throwing Proxy (below) rather than rejecting: the red then lands on the law's own asserting
//      line, naming the absent module, instead of on collection.
import fc from "fast-check";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── The module surface the laws specify. `src/local_queue.ts` must export exactly these. ─────────

/** The lease a claimed gig carries — a continuing renewed fact (monotonic `renewed_at`), not a
 *  boot assertion. Mirrors the reside lease law (PR #447, spec/residency-contract) and SQS's
 *  visibility-timeout ("record the monotonic time of last renewal; treat uncertain renewal as
 *  loss"). CAVEAT: the reside spec files are off this branch and could not be opened; the shape
 *  here is grounded in the brief's paraphrase + src/worker.ts:196-266 reapWorkerState (the opened
 *  analogue: mtime as the liveness proxy, keeps fresh, drops presumed-abandoned). */
export interface LeaseState {
  holder: string;
  renewed_at: number;
  expires_at: number;
}

/** A claimed local gig — the sibling of worker.ts ClaimedGig (src/worker.ts:97-123). The same
 *  semantic fields the hosted claim carries, plus the local lease and, on a re-claim, the human
 *  seat's role-keyed verdicts (matching approvalWiring's shape). */
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

/** The local queue port — the file-backed sibling of the enqueue seam (deps.queueGig,
 *  src/server.ts:3062) and the claim path (claimNextGig, src/worker.ts:364). Every verb is offline
 *  and needs no credential. A `clock` may be injected so lease/reap laws are deterministic and fast
 *  (no sleeping); it defaults to Date.now(). */
export interface LocalQueue {
  /** Persist a queued gig row; return {gig_id, status:'queued'} — byte-indistinguishable from
   *  postgrestQueueGig/rpcQueueGig (genome_store.ts:525,:568). */
  enqueue(args: Record<string, unknown>): Promise<{ gig_id: string; status: "queued" }>;
  /** Atomically claim the oldest runnable gig for `worker`; null when there is nothing to claim
   *  or a concurrent race was lost (the same empty sentinel claimNextGig returns). NEVER throws for
   *  a lost race. */
  claim(worker: string): Promise<ClaimedLocalGig | null>;
  /** Renew the holder's lease. True iff the caller still holds it; a renewal against a lost/lapsed
   *  lease returns false (treated as loss, never as still-held). */
  heartbeat(worker: string, gig_id: string): Promise<boolean>;
  /** Return every lapsed-lease claim to queued; never touch a fresh (heartbeated) claim, a parked
   *  gig, or a terminal one. Best-effort, never throws (mirrors reapWorkerState). */
  reap(): { requeued: string[]; kept: number; errors: string[] };
  /** Park the holder's gig at a human chair: awaiting_approval, lease released. */
  park(worker: string, gig_id: string): Promise<boolean>;
  /** Record a human verdict on a parked gig, keyed by chair role and by who approved. */
  approve(gig_id: string, role: string, verdict: Record<string, unknown>, approved_by?: string): Promise<boolean>;
  /** Cancel a QUEUED gig so it is never claimed; {gig_id, status:'cancelled'} (sibling of
   *  postgrestCancelGig, genome_store.ts:599). */
  cancel(args: Record<string, unknown>): Promise<{ gig_id: string; status: "cancelled" }>;
  /** Seal the gig's output to the local store. Idempotent by content_sha: a re-run (after a lapsed
   *  lease let a second worker take the gig) re-seals the SAME output rather than duplicating —
   *  `duplicated:true` on the second identical seal. */
  complete(worker: string, gig_id: string, output: Record<string, unknown>): Promise<{ content_sha: string; duplicated: boolean }>;
  /** Observe the store — a reader must be able to distinguish a live claim from an abandoned one
   *  (O5) and see which rows are queued/claimed/parked/terminal. Read-only; touches no lease. */
  list(): LocalGigView[];
  readonly leaseMs: number;
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

/** Which backing owns the queue, decided by which environment is present — the SINGLE selector
 *  that the enqueue seam and the claim path both consult (subsystem-contract O2/I16). */
export type QueueBackingChoice =
  | { backing: "file"; root: string }
  | { backing: "hosted" }
  | { backing: "none"; why: string }
  | { backing: "conflict"; why: string };

export interface LocalQueueModule {
  openLocalQueue(root: string, opts?: LocalQueueOptions): LocalQueue;
  /** The deps.queueGig-shaped enqueue seam — byte-compatible with postgrestQueueGig. */
  fileQueueGig(root: string): (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** The deps.cancelGig-shaped seam. */
  fileCancelGig(root: string): (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** Single-sourced backing selection by environment presence. Reads NONE of the five drain vars. */
  selectQueueBacking(env: Record<string, string | undefined>): QueueBackingChoice;
  /** The env var whose presence selects the local backing. */
  LOCAL_QUEUE_DIR_VAR: string;
  /** The five drain variables the local path must NEVER read (drain_preflight.ts:55-61). */
  DRAIN_VARS: readonly string[];
}

// ── The runtime-URL loader + throwing Proxy. ─────────────────────────────────────────────────────

/** Held in a variable so tsc cannot resolve it (see the file header). */
const LOCAL_QUEUE_MODULE = "../src/local_queue.js";

/** A Proxy that answers `then`/symbol/inspection probes truthfully (so `await` and vitest's own
 *  reflection never HANG or mis-key on it) but throws a message NAMING the absent module for any
 *  real property access or call — so the red lands on the law's asserting line, not on collection. */
function throwingProxy(reason: string): LocalQueueModule {
  const boom = (): never => {
    throw new Error(`${LOCAL_QUEUE_MODULE} is not implemented yet — ${reason}`);
  };
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop) {
      // Let a promise-unwrap or a symbol probe pass through as "not a thenable, nothing here",
      // otherwise `await loadLocalQueue()` would hang and the law would never assert.
      if (prop === "then" || typeof prop === "symbol") return undefined;
      return boom();
    },
    apply: boom,
    construct: boom,
  };
  return new Proxy({}, handler) as unknown as LocalQueueModule;
}

/** Load the module, or return a throwing Proxy naming it. Awaitable, never hangs, never rejects —
 *  so each law fails where it asserts. */
export async function loadLocalQueue(): Promise<LocalQueueModule> {
  try {
    return (await import(LOCAL_QUEUE_MODULE)) as unknown as LocalQueueModule;
  } catch (e) {
    return throwingProxy(e instanceof Error ? e.message : String(e));
  }
}

// ── Offline tmpdir. Real rename(2), zero credentials — the subsystem is offline by construction. ──

const roots: string[] = [];

/** A fresh OS tmpdir the laws run their real filesystem operations in. */
export function freshRoot(): string {
  const root = fs.mkdtempSync(join(tmpdir(), "coltrane-lq-"));
  roots.push(root);
  return root;
}

/** Best-effort cleanup for a test file's afterAll. */
export function cleanupRoots(): void {
  for (const r of roots.splice(0)) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      /* a leaked tmpdir is not a test failure */
    }
  }
}

// ── Shared arbitraries. A well-formed gig payload is the shape gig_dispatch hands the queue seam. ─

/** The semantic fields a worker needs to run — the same keys postgrestQueueGig reads
 *  (genome_store.ts:543-556): standard_slug, mode, input, acting_for, venue. */
export const gigPayloadArb: fc.Arbitrary<Record<string, unknown>> = fc.record({
  standard_slug: fc.constantFrom("draft-red-spec", "review-changes", "grounding"),
  mode: fc.constantFrom("live", "dry"),
  input: fc.dictionary(
    fc.constantFrom("subsystem", "target", "question", "n"),
    fc.oneof(fc.string(), fc.integer(), fc.boolean()),
  ),
  acting_for: fc.constantFrom("steve-1", "steve-2", "quartet"),
  venue: fc.option(fc.constantFrom("empty-room-v1", "quartet"), { nil: null }),
});

/** The semantic fields the round-trip law (I3) must find preserved across enqueue→claim. */
export const SEMANTIC_FIELDS = ["standard_slug", "mode", "input", "acting_for", "venue"] as const;
