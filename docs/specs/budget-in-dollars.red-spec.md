# Budget means US dollars

**Status:** RED spec. Laws written across `tests/spec_budget_*.test.ts` and the rewritten append-unit
suites; enforcement not built yet. Operator decision 2026-09-16: *budget means US dollars, enforced
against settled spend at batch boundaries.* Amendment 2026-09-17 (O6, I9): *a turn pool is passed
without a money budget, via `RunDeps.turn_pool`* — second law batch, migrating the five remaining
append-unit suites (below, "Migration DONE").

| field | value |
|---|---|
| `scope` | `src/runtime.ts` (`BudgetInput`, `BudgetState`, the gate, `BudgetExhausted`); `src/server.ts` `gig_dispatch` budget argument + `budget_exhausted` reply; `src/cli.ts` `--budget`; `src/run_deps.ts` `drainBudget`; `src/worker_env.ts` the drain env doc; `src/mcp.ts` advertised budget schema. |
| `vitest_test_paths` | `tests/spec_budget_is_dollars.test.ts`, `tests/cost_budget_enforcement.test.ts`, `tests/cost_budget_adversarial.test.ts`, `tests/spec_budget_exhausted_reports_dollars.test.ts`, `tests/spec_budget_payload_size_irrelevant.test.ts`, `tests/spec_budget_reserve_pool_decoupled.test.ts`, `tests/spec_budget_drain_is_usd.test.ts`, `tests/spec_budget_unverifiable_without_usd.test.ts`, `tests/spec_budget_doors_are_dollars.test.ts`, `tests/spec_budget_turn_pool.test.ts` (O6/I9), and the migrated suites `tests/runtime_accounting_integrity.test.ts`, `tests/gig_failure_accounting.test.ts`, `tests/gig_reserve_pool.test.ts`, `tests/gig_yielding_state.test.ts` |
| `stop_condition` | Every law below green; `tsc --noEmit` clean; the reserve-pool governor laws (`tests/gig_reserve_pool.test.ts`, `tests/gig_yielding_state.test.ts`) and the usage-honesty laws (`tests/runtime_accounting_integrity.test.ts` #235) still green after their scaffolding is migrated (see *Migration owed*). |
| `non_goals` | chart `budget_envelope` semantics; committed-work Resources/Bookings; `computeCredits` / `max_token_budget` deletion; `simulate` estimates; spend lost across park/resume; per-output cost over-count. |
| `run_protocol` | Laws land RED (observed below). Build the enforcement; once green, break each wire by hand and watch its law go red. |
| `outcome` | _open_ |

## Why

The only budget an operator can set is called dollars — `coltrane dispatch --budget <dollars>` — but
it is enforced in **append-units**: `computeAppendCost = base_cost + 0.1 × payload characters`
(`src/runtime.ts`). A $45 ceiling refused a real gig before its first chair
(*"needs cost=2385.6 but balance=45"*, measured 2026-09-16). The drain hands every gig 2000 append
units, so any chair with more than ~20 KB of context is refused there. A malformed budget silently
means *no* enforcement. And the reserve pool only exists when a money budget does.

Measured again this run (`tests/_scratch_probe`, since removed): handing today's `runGig` a
`budget: { max_usd }` is read as `opening: undefined` — the append gate never trips (`NaN < cost` is
false), the gig runs every chair, and the returned `budget_state` reports `unit: "append-units"` with
no `max_usd` / `spent_usd`, **though `settled_usd` is tracked**. The runtime already knows the settled
dollars; it neither enforces the ceiling against them nor reports the budget in the denomination its
door advertises.

## Obligations → mechanism, callsite, law

### O1 — every door accepts the budget in US dollars, and the advertised schema names the field and its unit
- **Mechanism.** `BudgetInput` becomes `{ max_usd }`. `src/cli.ts` threads `--budget 45` as
  `{ max_usd: 45 }`; `src/server.ts` `gig_dispatch` reads `budget.max_usd`; `src/run_deps.ts`
  `drainBudget` reads `COLTRANE_DRAIN_MAX_USD`. `src/mcp.ts` `MCP_TOOLS` describes `budget` with a
  `max_usd` property named in USD, not a bare `"object"`.
- **Callsites.** `src/cli.ts:489-492`; `src/server.ts:944-950`; `src/run_deps.ts:62-68`;
  `src/mcp.ts` `MCP_TOOLS` `gig_dispatch`.
- **Laws.** `spec_budget_doors_are_dollars.test.ts` (I6 CLI chain + O1 MCP schema);
  `spec_budget_drain_is_usd.test.ts` (drain door); `spec_budget_is_dollars.test.ts` LAW 0 (usage text).

### O2 — the ceiling is enforced against SETTLED spend, checked before each ready batch
- **Mechanism.** At each dispatch-batch boundary, compare `budget.settled_usd` (already reconciled
  from invokers' `result` events, `src/runtime.ts:2006`) against `max_usd`; if reached, do not start
  the next batch — throw `BudgetExhausted`. The batch already running finishes.
- **Callsite.** the batch loop and gate in `src/runtime.ts` (`prepareChair` gate ~`:2491-2503`, the
  per-batch reconcile ~`:2004-2006`).
- **Laws.** `spec_budget_is_dollars.test.ts` LAW 2 (I2); `cost_budget_enforcement.test.ts` I3.

### O3 — the append-unit gate is gone
- **Mechanism.** Delete the `computeAppendCost` comparison; `base_cost`/`k`/payload size no longer
  decide whether a chair runs, and the returned `budget_state` carries no append-unit denomination.
- **Callsite.** `src/runtime.ts` `computeAppendCost` (`:923`) and the gate that consumes it.
- **Laws.** `cost_budget_enforcement.test.ts` O3; `spec_budget_payload_size_irrelevant.test.ts` (I8).

### O4 — the turn reserve pool works with or without a dollar budget
- **Mechanism.** Source the pool from `Standard.reserve_pool` / `Chair.turn_reserve` and track it
  independently of `deps.budget`, instead of hanging it off a `BudgetState` that only exists when a
  money budget is present.
- **Callsite.** `src/runtime.ts` pool seed (`:1397`), the `deps.budget ? {…} : null` construction
  (`:1398`), and the `if (budget && …)` draw guards (`:2760-2793`).
- **Law.** `spec_budget_reserve_pool_decoupled.test.ts` (I5).

### O5 — a budget stop says what happened in dollars
- **Mechanism.** `BudgetExhausted` carries `spent_usd`, `max_usd`, `unit: "usd"`, and a message with
  `$` amounts and `usd`. `src/server.ts`'s `budget_exhausted` reply forwards those same dollar fields.
- **Callsites.** `src/runtime.ts` `BudgetExhausted` (`:891-906`); `src/server.ts` `budget_exhausted`
  replies (`:1328-1335`, `:1126-1135`).
- **Law.** `spec_budget_exhausted_reports_dollars.test.ts` (I4 error + O5 reply).

### O6 — a turn pool needs no money budget (amendment 2026-09-17)
- **Mechanism.** The gig reserve pool opens from `RunDeps.turn_pool` when set, else
  `Standard.reserve_pool`, else 0 — `turn_pool` OVERRIDES the standard default deterministically.
  `BudgetInput.pool` is retired. The per-gig `budget_state` is built whenever a dollar ceiling OR a turn
  pool is in play (not only when `deps.budget` is present): its pool fields (`pool_remaining`, `draws`)
  are filled regardless of money, and its dollar fields (`max_usd`, `spent_usd`, `unit: "usd"`) only when
  a ceiling is set.
- **Callsites.** `src/runtime.ts` pool seed (`:1397` — `deps.budget?.pool ?? standard.reserve_pool`
  becomes `deps.turn_pool ?? standard.reserve_pool`) and the `const budget = deps.budget ? {…} : null`
  construction (`:1398`, which must also build a snapshot when a pool alone is present); `RunDeps`
  (`:261`) gains `turn_pool?: number`.
- **Laws.** `spec_budget_turn_pool.test.ts` (I9 override + O6 pool-only snapshot);
  `gig_reserve_pool.test.ts` and `gig_yielding_state.test.ts` (INV8–INV18 / INV14–INV17 now pass the pool
  via `turn_pool`).

## Coverage — every invariant and failure mode → its law (observed RED)

| id | law (test name) | file | RED reason observed today |
|---|---|---|---|
| I1 | LAW 1 (I1) — a $45 budget runs a $0.02 gig, however large its payload, reported in dollars | `spec_budget_is_dollars.test.ts` | `budget_state.unit` is `append-units`, no `max_usd`/`spent_usd` |
| I2 | LAW 2 (I2) — three $0.03 chairs vs a $0.05 ceiling: two start, then BudgetExhausted | `spec_budget_is_dollars.test.ts` | ceiling never enforced against settled spend; nothing thrown |
| I3 | I3 — running batch finishes and seals, then the next batch does not start | `cost_budget_enforcement.test.ts` | append gate NaN-bypassed; all chairs run, no stop |
| I4 | I4 — BudgetExhausted carries spent_usd/max_usd/unit 'usd' and says so in dollars | `spec_budget_exhausted_reports_dollars.test.ts` | no dollar stop thrown to inspect |
| I5 | I5 — reserve pool draws identically with and without a dollar budget | `spec_budget_reserve_pool_decoupled.test.ts` | no-budget run draws nothing; pool coupled to money |
| I6 | I6 — `--budget 45` reaches runGig as { max_usd: 45 } | `spec_budget_doors_are_dollars.test.ts` | CLI threads `{ opening }`; `budget_state.max_usd` undefined |
| I7 | I7 — drain applies COLTRANE_DRAIN_MAX_USD; 2000 default gone; documented USD | `spec_budget_drain_is_usd.test.ts` | `drainBudget` returns `{ opening: 2000 }`; var unread; undocumented |
| I8 | I8 — payload size does not affect enforcement (fast-check property) | `spec_budget_payload_size_irrelevant.test.ts` | reported spend is append-units, scaling with payload |
| I9 | I9 — `RunDeps.turn_pool` opens the pool with no money budget and overrides `standard.reserve_pool` | `spec_budget_turn_pool.test.ts` | `RunDeps` has no `turn_pool`; the chair gets its full declared reserve (4), so `turn_pool 3` never caps it (observed `offered=4`), and no `budget_state` exists without a money budget |
| O6 | O6 — a turn pool ALONE yields a `budget_state` (pool fields filled, dollar fields omitted) | `spec_budget_turn_pool.test.ts`; `gig_reserve_pool.test.ts` (INV18 vs `spent_usd`) | `BudgetState` is built only when `deps.budget` is set, so a pool with no money budget returns no `budget_state` at all |
| F1 | F1 — malformed max_usd refused by gig_dispatch before anything runs (8 cases) | `cost_budget_adversarial.test.ts` | malformed budget runs unenforced (ok:true) |
| F2 | F2 — retired append-unit fields (opening/base_cost/k) refused, pointed at max_usd (3 cases) | `cost_budget_adversarial.test.ts` | retired fields accepted/ignored; gig runs |
| F3 | F3 — an unverifiable (no-usd) settled invocation stops the next batch, typed | `spec_budget_unverifiable_without_usd.test.ts` | unpriced spend completes silently; no `budget_unverifiable` |
| F4 | F4 — malformed COLTRANE_DRAIN_MAX_USD refuses the drain, naming the variable (4 cases) | `spec_budget_drain_is_usd.test.ts` | `drainBudget` never throws on a bad value |

`uncovered`: none.

## Verification method

Example-based laws for the specific behaviours (I1–I7, I9, O5, O6, F1–F4) — each names a concrete
scenario the contract states. Two universal properties are pinned with **fast-check** (already a dev
dependency):
I8 over payload lengths (payload size is irrelevant to enforcement), and — retained from the existing
governor suite — the reserve-pool conservation laws. Enforcement laws run against the REAL callsites:
`runGig` for the runtime gate, `dispatchTool("gig_dispatch", …)` for the door refusals and the
`budget_exhausted` reply, `runCli(["dispatch", …])` for the CLI thread, `drainBudget` for the drain,
and `MCP_TOOLS` / `WORKER_ENV_CONTRACT` for the advertised surfaces.

## Migration DONE (second law batch — amendment 2026-09-17, this run)

The five suites the first batch left encoding append-unit / pool-coupling scaffolding are now migrated,
so no law in the tree constructs a retired `budget: { opening, base_cost, k, pool }` and none contradicts
the contract once it is built. Per file, with the RED observed this run (`npx vitest run`):

- `tests/gig_reserve_pool.test.ts`, `tests/gig_yielding_state.test.ts` — `runPoolGig`/`runYieldingGig`
  now pass the pool via `RunDeps.turn_pool` with NO money budget (O6/I9), dropping the append-unit
  `opening`. RED now: `turn_pool` is unwired and `BudgetState` is built only when `deps.budget` is set,
  so the pool never opens and no draw/`yielding` is recorded (5 pool laws + 4 yielding laws observed RED).
  INV18 is RE-STATED against the dollar field `spent_usd` (a draw moves `pool_remaining`, never
  `spent_usd`, when a ceiling is also set). The `makeClaudeInvoker`-driven INV19/F7 and the source-scan
  F8 do not use the pool-passing helper and stay GREEN — their property holds today and survives the
  build.
- `tests/runtime_accounting_integrity.test.ts` — the `#232` phantom-charge law (a parallel-batch prep
  charge) is DELETED: it has no dollar analog (a parallel phase is ONE batch; the ceiling is a
  batch-boundary check, so there is no prepared-but-charged-yet-unrun state), and its surviving property
  is already LAW 2 (I2, `spec_budget_is_dollars.test.ts`) + I3 (`cost_budget_enforcement.test.ts`). The
  `#232` throwing-chair law is REWRITTEN to dollars: a chair whose invocation throws settles no dollars —
  observed RED because the failure snapshot has no `spent_usd`. **`#233` is DELETED** (a non-obvious call,
  recorded here for the reviewer): it asserted append-unit cost-basis scaling with payload — the exact
  INVERSE of the contract's I8/O3 (payload size is irrelevant to enforcement) — and constructed
  `budget: { opening, base_cost, k }`, which acceptance criterion 1 forbids. Kept as-is it would be a law
  contradicting I8 the moment enforcement lands; its concern is owned by
  `spec_budget_payload_size_irrelevant.test.ts` (I8). This deviates from the change request's literal
  "keep every non-budget law", because `#233` is in fact a budget/cost law; the overriding goal ("no law
  contradicts the contract") and the acceptance criterion decide it. Every genuinely non-budget law
  (`#235`/`#240`/`#243`/`#245`/`#246`, 17 tests) is kept verbatim and observed GREEN.
- `tests/gig_failure_accounting.test.ts` — THREE `#236` budget laws re-pointed at a `max_usd` ceiling.
  The one the change request named ("a BudgetExhausted abort carries the settled spend"): RED because the
  dollar ceiling is not enforced against settled USD, so no `BudgetExhausted` is thrown at all. And —
  beyond the letter of "keep the rest of the file", a second non-obvious call recorded for the reviewer —
  the two async-snapshot laws ("a FAILED / a SUCCESSFUL async gig surfaces its budget_state") ALSO
  constructed `budget: { opening, base_cost, k }` and asserted `unit: "append-units"` / append-unit
  `spent`/`balance`; those contradict I4/O5 and violate acceptance criterion 1, so they are migrated to
  `max_usd` + `spent_usd` / `unit: "usd"` (RED because `gig_dispatch` reads only `budget.opening`, never
  `budget.max_usd` — `src/server.ts:946` — so a dollar dispatch is dropped and NO `budget_state` surfaces
  on either async path; the O1 door gap). The two `#236` USAGE laws (no budget passed) stay GREEN. Same
  rationale as the `#233` deletion: a law that constructs the retired shape or asserts the retired
  denomination cannot survive the build.
- `tests/run_deps_parity.test.ts` — UNCHANGED, with the evidence the change request asked for: the only
  mention of `budget: { opening, k }` is an illustrative comment on the parser's brace-flattening; every
  assertion is about the PRESENCE of the `budget` key (and other deps) on the `runGig` callsite, never
  its shape. The drain still passes `budget` under the dollar contract, so all 9 laws survive the build —
  observed GREEN this run. No append-unit assertion lives here, so per the change request nothing is
  rewritten and the file is not in this run's diff.
