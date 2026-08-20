# SPEC — the local, file-backed gig queue (the third backing)

**Status:** PENDING IMPLEMENTATION. The `tests/spec_local_queue_*.test.ts` band is committed RED on
purpose — every law asserts against `src/local_queue.ts`, which does not exist yet. A failure in a
`spec_local_queue_*` file is a feature not yet built; a failure in any file NOT named `spec_*` is a
regression. Do not weaken these laws to make CI green; implement the module they specify.

**Branch:** `spec/local-queue-contract`. **Upstream:** grounding-dossier
`grounding-local-queue-contract`, subsystem-contract `subsystem-contract-local-queue`.

---

## The asymmetry this closes

Coltrane has two ways to run a gig and neither is "enqueue a job at a running local thing":

- **LOCAL** — `gig_dispatch` spawns in-process, same process, no queue, no walking away.
- **HOSTED** — `gig_dispatch` queues to Supabase via `deps.queueGig` and `coltrane work` drains it.

The repo already ships this pattern half-built, and the half it ships is the **read** path. The
genome port has a LOCAL sibling: `fileGenomeStore(root)` (`src/genome_store.ts:77`) reads/writes
genome files, alongside `postgrestGenomeStore(ctx)` and the agent-token backing. The **queue** port
has no such sibling — its only backings are `postgrestQueueGig` (member JWT,
`src/genome_store.ts:532`) and `rpcQueueGig` (agent token, `:493`), both HTTP. `deps.queueGig` is an
optional seam on `ToolSurfaceDeps` (`src/server.ts:3062`); when absent, hosted `gig_dispatch` refuses
with the typed `hosted_unsupported` message at `src/server.ts:3215`. The claim side is welded to HTTP
too: `claimNextGig` (`src/worker.ts:364`) speaks `coltrane_drain_claim` / `coltrane_mcp_claim` over
`fetch`, with no backing to select.

So: a genome can be read from files; a gig cannot be queued to files. This spec adds the file
sibling for BOTH ends — enqueue and claim — selected by which environment is present, exactly as the
genome store selects between files and PostgREST. **A local run must not be a different code path
with different meaning, or the two front doors disagree about what a gig is.**

The outcome to reach: `clone → npm run build → enqueue a gig → in another terminal a worker claims
and runs it → outputs seal to the local store`. Zero cloud, zero credentials, the SAME gig semantics
as hosted.

---

## The module to build: `src/local_queue.ts`

The tests import this surface (see `tests/spec_local_queue_fixtures.ts` for the authoritative
declarations). Backing selected by environment presence; needs NONE of the drain's five variables.

| Export | Obligation | Mechanism / callsite |
| --- | --- | --- |
| `openLocalQueue(root, opts?)` | O3, O5, O6, O8 | The full port: `enqueue`, `claim`, `heartbeat`, `reap`, `park`, `approve`, `cancel`, `complete`, `list`. Directory-per-state under `root`, atomic `rename(2)` transitions. |
| `fileQueueGig(root)` | O1 | The enqueue seam that plugs into `deps.queueGig` (`server.ts:3062`) — byte-compatible with `postgrestQueueGig`, returns `{gig_id, status:'queued'}`. |
| `fileCancelGig(root)` | O10 | The cancel seam for `deps.cancelGig` (`server.ts:3073`) — sibling of `postgrestCancelGig`, returns `{gig_id, status:'cancelled'}`. |
| `selectQueueBacking(env)` | O2 | The SINGLE selector: `file` when `COLTRANE_QUEUE_DIR` is present and the drain env is not; `hosted` for the drain env; `conflict` when both; `none` otherwise. Reads none of the five drain vars. |
| `LOCAL_QUEUE_DIR_VAR`, `DRAIN_VARS` | O2, O11 | The env var that selects local, and the five drain vars the local path must never touch (`drain_preflight.ts:55-61`). |

### The claim mechanism — exactly one winner, no lock, no database

POSIX `rename(2)` is atomic within a filesystem. A directory-per-state design
(`queued/ → claimed/<worker>/`) gives mutual exclusion with no database: the winner's rename removes
the source, and every loser's rename of the same source fails `ENOENT` — that is how a loser learns
it lost. This is maildir's `new/ → cur/` rename-as-claim (cr.yp.to) and FSQ's `tmp/ → queue/ → done/`
verbatim. The spec pins the **invariant** (two workers, one row, exactly one claim succeeds, the
other gets nothing — I4/I5/I6), never the directory layout. A loser returns the **null sentinel**
`claimNextGig` returns for "nothing to claim" (I5/F3), never a thrown error.

### The lease — mirrors the reside law, does not restate it

The lease/heartbeat/reaper invariants MIRROR the reside lease law (PR #447,
`spec/residency-contract`: `tests/spec_reside_lease.test.ts`, `tests/spec_reside_liveness.test.ts`),
because two subsystems that disagree about what a lease means IS the defect.

> **CAVEAT.** The reside spec files are on `spec/residency-contract` and are NOT on this branch — they
> could not be opened this run (confirmed: no `tests/spec_reside_*` present here). The invariant names
> below rest on the brief's paraphrase of the reside law plus two OPENED sources:
> `src/worker.ts:196-266` `reapWorkerState` (mtime as the liveness proxy; keeps fresh / load-bearing
> state; drops presumed-abandoned; best-effort, never throws) and Amazon SQS's visibility-timeout
> ("a lease is not a lock"; "record the monotonic time of last renewal"; "treat uncertain renewal as
> loss"; "a crashed grip falls open by timeout"). **Before the implementing gig restates any lease
> invariant, reconcile it against the actual reside assertions** so the two subsystems cannot drift.

- A live claim carries a lease with a monotonic `renewed_at`/`expires_at` (I7, one holder).
- The holder renews by `heartbeat`, which strictly advances the lease and keeps the reaper off it
  (I8). An uncertain/failed renewal is treated as **loss**, never as still-held (F5).
- A lapsed lease ALWAYS becomes claimable again (I9); a crashed holder's grip falls open on its own.
- The reaper returns lapsed claims to `queued` and NEVER touches a fresh one (I10).
- Liveness is a **continuing** renewed fact, not a boot assertion: a once-successful claim does not
  immunize a holder that stops heartbeating (I11).

### Re-claim with verdicts, and idempotent effect

A gig that parks at a human chair must be re-claimable with its verdicts, matching the drain's
`park → approve → re-claim` path (`worker.ts` `parkGig` `:446`, `ClaimedGig.approvals` `:116`,
`approvalWiring`). The local queue has **no cloud sink** — the file root IS both store and sink — so
the local `park` writes role-keyed verdicts where the local re-claim reads them (I12), and park
clears the lease so the reaper never mistakes a parked gig for an abandoned claim (I13). Fail closed
on approval integrity: a parked-but-unapproved gig is not claimable, and an empty verdict is refused
(F6).

Because lease-timeout reclaim yields **at-least-once**, the honest guarantee is at-least-once +
idempotent-effect, not true exactly-once (linearizability framing: one atomic claim-point per
`rename`, I19). A re-run re-seals the SAME output (content_sha dedup, `worker.ts` lineage) rather than
duplicating (I14); a re-run that would seal a DIFFERENT output for the same gig fails closed rather
than forking (F9).

At-least-once **permits** a second run; it does not require one. A gig that completes SUCCESSFULLY is
terminal — `complete()` moves the row into `done/` and `fail()` moves it into `failed/`, so neither is
reachable by `reap()` and neither is handed to another worker (T1–T3, T6). This is not a weakening of
the guarantee: every gig still runs at least once, and the case at-least-once exists for — a worker
that sealed and died before the row could be moved — still leaves the row in `claimed/` carrying its
`content_sha`, is still reaped, still re-run, and still dedups (I14).

The distinction is what it costs to be wrong. Re-running finished work is not free the way a
duplicate seal is: it spends real inference and repeats real side effects (a second pull request) to
rediscover an output already recorded. The dedup protects the LEDGER; only a terminal state protects
the WORK. `done/` and `failed/` were declared states with no transition into them until T1–T7.

---

## Refusals — typed and fail-closed

Every error condition refuses in the shape `gig_dispatch` already uses; nothing degrades to a silent
fallback (in-process spawn, hosted path, dropped gig, missing verdict).

| Code | Condition | Refusal |
| --- | --- | --- |
| F1 | Local env present, root unwritable | Refuse; never report success for an unpersisted gig, never fall back. |
| F2 | Local AND hosted env both present | `conflict` — refuse, do not silently pick. |
| F3 | Claim loses the rename race (`ENOENT`) | Return the null sentinel, not a thrown error. |
| F4 | Crash mid-enqueue (partial tmp file) | A claim never serves a partial row; only atomically-committed rows are claimable. |
| F5 | Heartbeat renewal fails/uncertain | Treat as loss of the lease. |
| F6 | Parked gig re-claimed with missing/empty verdicts | Refuse to resume past the human chair. |
| F7 | Claim targets a gig with a fresh lease | Get nothing (null); not a steal. |
| F8 | Local backing reaches for a drain credential | Contract violation — the local path reads none of the five drain vars. |
| F9 | Non-idempotent re-run (divergent output) | Refuse rather than duplicate/fork outputs. |
| F10 | Malformed/unrunnable payload | Refuse at enqueue; persist no row. |

---

## Verification method

Every law is a REAL running assertion against a real OS tmpdir with real `rename(2)`, fully offline
(needs none of the five drain variables, so `suite_reaches_no_remote` stays green), red today because
`src/local_queue.ts` is absent. The band is red **at the assertion, not at collection**: the module
specifier lives in a runtime-URL variable (tsc cannot resolve it, so the shared build stays clean),
and `loadLocalQueue()` returns a throwing Proxy on the absent import so each law fails on its own
asserting line naming the module — never a `beforeAll` reject that skips the file.

- **Property-based** (`fast-check` `fc.asyncProperty`) for universal properties: return-shape
  indistinguishability, round-trip identity, unique enqueue names, content_sha determinism.
- **Real concurrency** (`Promise.all` of N real claims on one row) for exactly-one-winner — `rename(2)`
  atomicity is the actual thing under test.
- **Model-based** (random command sequences against a reference lease state machine with an injected
  clock — the `lifecycle.model.test.ts` pattern) for one-holder and reaper-spares-the-living over the
  whole transition space.

Test files: `tests/spec_local_queue_enqueue.test.ts`, `tests/spec_local_queue_claim.test.ts`,
`tests/spec_local_queue_lease.test.ts`, `tests/spec_local_queue_reclaim.test.ts`, with shared
fixtures in `tests/spec_local_queue_fixtures.ts`.

---

## Non-goals

Do NOT implement the queue in this gig (this is the contract + RED suite only). Do NOT modify
`src/worker.ts`, `src/cli.ts`, `src/genome_store.ts`, or `src/server.ts`. Do NOT change the hosted
path or the drain's five-variable contract. A local queue needs no credential or minting story — that
is the point.
