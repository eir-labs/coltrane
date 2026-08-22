# Single-flight is law — the per-repo dispatch lock (RED spec)

Change `c1d0c2e0`. This is the falsifiable half of the change: it turns each obligation of the
single-flight contract into a **mechanism at a real dispatch callsite, verified by a RED test**. The
suite lives in `tests/repo_lock_*.test.ts` and is **committed failing on purpose** — every assertion
is red because the enforcement (an exclusive per-repo dispatch lock) does not exist yet. Authoring
the lock to the surface below turns the suite green.

## The defect

Today nothing stops two host-seat gigs from being dispatched against the same working tree. Each
derives its sealed change-set from `git diff` of a tree the other is mutating, so two concurrent
runs **corrupt each other's change-set silently**. Corruption is the worst failure mode for a
clearing mechanism: a participant cannot even observe that clearing failed. john's grep across
`src/*.ts` found no mutex keyed to the genome root — the enforcement gap is real.

## The contract

An exclusive **per-repo dispatch lock**, keyed on `deps.genome_dir` (the resolved genome root — the
local on-disk working tree), claimed **atomically**, whose record names the **holding gig_id, pid,
and started_at**. A second local dispatch against an already-held tree is **REFUSED immediately**
with a structured `{ ok: false, error }` naming the holder — never queued, never waited on, never
proceeding. The lock **releases on every terminal outcome** (complete, failed, aborted) and is
**RETAINED through `awaiting_approval`** (a parked gig holds uncommitted work in the tree). A lock
whose recorded pid is not alive is **broken, recorded observably, and re-acquired**.

The lock activates only when `deps.genome_dir` is present: a hosted/bare dispatch (no local genome
root — the drain worker's fresh-tmpdir-per-gig path) carries no tree to lock and is unaffected by
construction. This is why the whole existing suite, which dispatches with `genome_dir` unset, stays
green.

## The enforcement seam — `src/fs_atomic.ts`

`fs_atomic.ts` is the codebase's home for `rename(2)`-based atomic filesystem primitives; the lock
belongs beside `writeFileAtomic`. The module must gain:

| Symbol | Shape | Pins |
| --- | --- | --- |
| `repoLockPath(genomeDir)` | `string` — `<genomeDir>/.coltrane/repo-lock-<hex>.json`, where `<hex>` is a stable SHA-256 digest of the absolute `genomeDir` truncated to 16 hex chars | artifact placement; the stale-break test plants at this path |
| `acquireRepoLock(genomeDir, { gigId, pid, startedAt })` | writes the record to a unique tmp path then `rename(2)`s it into the canonical slot (the `local_queue.ts` idiom); on an existing destination reads it and tests `process.kill(pid, 0)` — ESRCH ⇒ break-record-unlink-retry, alive ⇒ return a refusal carrying `held_by` | atomicity, refusal shape, stale break |
| `releaseRepoLock(genomeDir, gigId)` | unlinks the canonical slot only when the recorded `gig_id` matches (never steals another holder's lock) | terminal release |

Staleness is decided by **pid liveness**, never a wall-clock TTL: a TTL risks breaking a live-but-slow
gig mid-run — the exact corruption this law prevents. The break is recorded as a **`process.stderr`
log line** (the house pattern — `gig_tracker.ts` `gigEventLogLine` tees run milestones to stderr)
naming the stale `gig_id`, the stale `pid`, and the reason.

## The obligations, each at a callsite

Acquisition belongs in the **dispatch handler**, just before `runGig`/`runChart` is spawned and
before `assembleRunDeps` commits (`assembleRunDeps` builds deps and cannot express a refusal — a
refused acquisition must propagate `{ ok: false }` before deps are assembled). Release belongs in the
`.finally()` on the run promise, gated on `state.status`.

| # | Obligation | Mechanism · callsite | RED test |
| --- | --- | --- | --- |
| INV-ACQUIRE-ATOMIC | Acquisition is atomic — exactly one racing caller wins, no TOCTOU gap | `acquireRepoLock` write-tmp-then-`rename(2)` · `src/fs_atomic.ts` | `repo_lock_single_flight.test.ts` — refuses the second dispatch |
| INV-REFUSAL-NAMES-HOLDER | A held tree refuses the second dispatch with a structured error naming the holding gig | refusal returns `{ ok:false, error }` naming `held_by.gig_id` · `server.ts` async path (~1244) | `repo_lock_single_flight.test.ts` — names the holding gig |
| INV-ENTRY-POINTS | The lock is acquired at every local dispatch entry point before any chair runs; the refused gig never runs a chair | acquire before `runGig` spawn · `server.ts` async (~1244) + sync (~1195) paths; CLI (`cli.ts:404`) funnels through `dispatchTool` | `repo_lock_single_flight.test.ts` — never runs its chair |
| INV-PER-REPO | The lock is per genome root, not global — a different root proceeds | key on `repoLockPath(deps.genome_dir)` · `src/fs_atomic.ts` | `repo_lock_single_flight.test.ts` — per-repo, not global |
| INV-RELEASE-TERMINAL | The lock releases on complete, failed, and aborted | `releaseRepoLock` in `.finally()`, gated `status ∈ {complete,failed,aborted}` · `server.ts:~1335` | `repo_lock_single_flight.test.ts` — every terminal outcome frees it |
| INV-PARK-RETAINS | A parked gig (`awaiting_approval`) retains the tree; the holder's own resume re-enters | the status gate EXCLUDES `awaiting_approval`; `acquireRepoLock` admits re-acquisition by the same `gig_id` (resume) · `server.ts:~1335`, `fs_atomic.ts` | `repo_lock_park_retention.test.ts` |
| INV-STALE-BREAK | A dead-pid lock is broken, re-acquired, and the break recorded observably | `process.kill(pid,0)` ESRCH ⇒ log-record + unlink + retry · `src/fs_atomic.ts` | `repo_lock_stale_break.test.ts` |
| INV-CHART-SINGLE-LOCK | A chart holds ONE lock for its whole lifetime, never per-movement | acquire once before movement 1 (holder = chart gig_id), release when the chart promise settles · `server.ts` `runChart` path (~1080–1163) | `repo_lock_chart.test.ts` |
| INV-ARTIFACT-UNDER-COLTRANE | Lock artifacts live under `.coltrane/` (gitignored) and are cleaned up on terminal | `repoLockPath` roots at `<genomeDir>/.coltrane/`; `.gitignore` already excludes `.coltrane/` · `src/fs_atomic.ts` | `repo_lock_artifact.test.ts` |

## Why these tests are not tautologies

Every law drives the **real** entry point — `dispatchTool("gig_dispatch", …)` (and the chart target
through it) — with two independent `ServerDeps` that share a `genome_dir` but hold their own
in-memory stores, standing for two processes contending for one tree. Each RED assertion fails today
for the contract reason: the second dispatch returns `ok:true` and mints a gig where the contract
demands `ok:false` naming the holder (INV-ACQUIRE/REFUSAL/ENTRY/PER-REPO/RELEASE/PARK/CHART); no
`repo-lock-*.json` is written under `.coltrane/` (INV-ARTIFACT); and `fs_atomic` exposes no
`repoLockPath` (INV-STALE-BREAK). Observed RED run: `4 failed / 4` + `3 failed / 3` across the five
files, each on the named assertion.

## Non-goals honoured

This gig produces the RED suite and this spec only; it does not implement the lock. Per the change
plan it does not touch `src/gig_song.ts` (upstream reading found it unrelated to dispatch/locking).
Queueing/waiting, distributed/hosted locking, the nomos seed, and venue isolation are out of scope.
