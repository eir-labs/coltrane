# RED spec — no captured spend is lost (contract-spend-survives-v1)

**Criteria.** Captured dollars are recorded WHEN CAPTURED, not when the gig happens to finish.
`usage` and `prior_usage` stay two true numbers, kept apart (#235/#236).

**Why now.** Measured 2026-09-17 on the coltrane play harness: 23 gigs dispatched, the ledger
recorded $121.01 across the 15 that completed; the 7 that died (chair timeout, memory-guard kill,
looping attester, refused seal) spent real money the ledger never saw. In `src/runtime.ts` the
gig row (kind `"gig"`) is appended only on the success path (`src/runtime.ts:3428-3447`); the
`catch` attaches partial usage to the thrown error but writes no local row; a SIGKILLed dispatcher
never reaches the `catch`; `coltrane dispatch` prints `dispatch failed: …` with no spend; a resumed
gig's checkpoint carries `prior_usage`, reported under `resumed_from` but never written to the row.

**Laws.** `tests/spec_spend_survives_kill_failure_resume.test.ts`. Run:
`npx vitest run tests/spec_spend_survives_kill_failure_resume.test.ts` — 8 assertions, all RED
today. Testing method: example-based through `runGig` with a real `MemoryLedger` (and the `dispatch`
command's own output path for O3); property-based (`fast-check`, already a devDependency) for I1.

## Obligations → mechanism, callsite, law

- **O1 — a `chair_spend` row per settled chair, before the next chair.**
  Mechanism: the per-chair usage sink (`makeUsageSink`, `src/runtime.ts:1326-1406`) already folds
  each chair's settled `result` event; on chair settle, `runGig` must `deps.ledger.append` a row
  `{kind:"chair_spend", gig_id, role, phase, round, usage}` before the next chair is invoked —
  instead of folding into the single gig-wide `usage` written once at `src/runtime.ts:3428-3447`.
  `round` is 1 on a first run, `n` on amend round `n`. A reserve continuation's spend rides in its
  chair's row or its own row, never dropped.
  Law: `O1 — every settled chair leaves a durable chair_spend row`.

- **O2 — a failed gig writes no gig row, but its `chair_spend` rows are in the ledger.**
  Mechanism: because O1 appends per chair, a failure at chair `n` leaves rows for chairs `1..n-1`
  already durable. The `catch` (`src/runtime.ts:3510-3541`) keeps attaching partial usage to the
  error (kept — a synchronous caller and a SIGKILL survivor read different channels) and still
  writes no gig row (absence stays the un-sealed signal). Their captured cost sums to the partial
  usage on the error.
  Law: `O2 — a failed gig writes no gig row, yet its chair_spend rows survive`.

- **O3 — `coltrane dispatch` reports a failed gig's spend.**
  Mechanism: the dispatch failure branch (`src/cli.ts:500`) must render the captured total in
  dollars and the number of chair invocations that settled; when nothing was captured it says spend
  was not captured, never `$0.00` (#235). The `ToolResult` for a failed `wait` dispatch carries the
  partial accounting the CLI renders.
  Laws: `O3 — names the captured total …` and `O3 — when nothing was captured it SAYS so …`.

- **O4 — a resumed gig's row carries `prior_usage`.**
  Mechanism: the checkpoint already banks `prior_usage` (`src/runtime.ts:1914-1925`) and the resume
  reports it on `GigResult.resumed_from` (`src/runtime.ts:1874-1880`); the gig-row append
  (`src/runtime.ts:3428-3447`) must additionally carry `prior_usage` beside its own `usage`, never
  folded in.
  Law: `O4 — a resumed gig's gig row carries prior_usage beside its own usage`.

## Invariants → law

- **I1** — for a completed gig, the captured cost of its `chair_spend` rows sums to the gig row's
  `usage.total_cost_usd`. Property-based over arbitrary triples of settled costs.
  Law: `I1 — chair_spend rows reconcile to the gig row's usage.total_cost_usd`.
- **I2** — durability: a chair's spend row exists before the next chair is invoked, so a process
  killed during a later chair leaves every earlier chair's spend behind.
  Law: `I2 — durability: the row exists before the next chair is invoked`.

## Failure modes → law

- **F1** — a chair invocation that reports no usage payload records `captured:false` and carries no
  cost field; never a `$0` row, and contributes nothing to O2's or I1's sums.
  Law: `F1 — an unattributed chair seals captured:false, never a $0 row`.

## Notes for the implementer (out of this spec's scope: `src/**`)

- The new `"chair_spend"` kind must be seated in `LedgerEntryKind` and `validateEntry`
  (`src/ledger.ts:47,296-329`), which today admit only `{gig, genome_mutation, governance}`. No
  existing law suite refuses a fourth kind — `tests/ledger_schema.test.ts` enumerates the three but
  asserts none is rejected exhaustively — so none needs rewriting; the union widening is a pure
  addition. The controls `tests/gig_failure_accounting`, `runtime_accounting_integrity`,
  `ledger_durability`, `phase_resume_and_reuse`, `resume_reuse_dispatch` and `ledger_schema` all
  stay green against these laws.
