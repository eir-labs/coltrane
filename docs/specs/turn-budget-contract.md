# Turn budget as a contract-level, reactive, pooled quantity

**Status:** RED spec (tests written, enforcement not yet built).
**Scope:** one additive change set across `src/genome_schema.ts`, `src/composition.ts`,
`src/runtime.ts`, `src/claude_invoker.ts`. Additive-only on the schema side — every shipped
standard / chart / agent / institution file must load and compose unchanged.

The reserve-grant continuation, `ChildExitError`, and budget-stop write recovery already exist on
branch `fix/bootstrap-root-isolation` and are **out of scope** to re-implement. This spec layers a
chair-scoped budget, a gig-scoped pool, and the `yielding` observable *on top of* that machinery.

The change is one idea at three scales:

1. **Item 1** relocates the guaranteed turn floor from the *player* (agent) to the *work* (chair).
2. **Item 2** makes `chair.turn_reserve` the per-chair elasticity ceiling on a shared per-gig pool.
3. **Item 3** projects the chair-scale reserve draw as the gig-scale `yielding` observable.

Structural map (grounding): a chair's `turn_budget` is YARN queue *capacity* / Kubernetes *request*
(a guaranteed floor); `turn_reserve` is YARN *maximum-capacity* / a Kubernetes *limit* with
`user-limit-factor = 1.0` (a hard per-consumer ceiling, no theft); the gig pool is lent free
capacity; `yielding` is Kubernetes' reactive memory-limit — observed at the parent under pressure,
never gated in-band.

---

## Item 1 — the turn budget moves from the agent to the chair

### O1 / O2 / O3 / O4 — schema + resolution

**Mechanism.** `ChairSchema` (`src/genome_schema.ts`, the `ChairSchema = z.object({…})` at ~line
135) gains two additive fields:

```ts
turn_budget: z.number().int().nonnegative().optional(),
turn_reserve: z.number().int().nonnegative().optional(),
```

Both `.optional()` so every existing chair record parses unchanged (a Zod object drops unknown keys
today, so the fields must be *declared* to be retained). The mirror `Chair` interface
(`src/composition.ts:29-81`) gains the same two optional fields; the `...ch` spread at
`src/composition.ts:251` then carries them into the runtime `Chair` for free.

**Threading.** `AgentInvocationContext` (`src/runtime.ts:47-92`) gains optional `turn_budget?` and
`turn_reserve?`, populated at the invocation site (`src/runtime.ts:2196-2209`) from the seated
chair — exactly as `depth` (#237) is threaded at `src/runtime.ts:2203`.

**Resolution (chair > agent > engine default).** At `src/claude_invoker.ts:954-959` the effective
`--max-turns` today is `a.max_tool_calls` clamped by any depth cap. The new order:

```
resolved = ctx.turn_budget  ?? a.max_tool_calls  ?? ENGINE_DEFAULT (absent → CLI default)
maxToolCalls = depthCap === undefined ? resolved : min(depthCap, resolved ?? depthCap)
```

- **Absent ≠ zero.** `ctx.turn_budget === undefined` falls through to the agent tier;
  `ctx.turn_budget === 0` is a deliberate hard floor of zero and does **not** fall through.
- **Tighten-never-widen.** The depth cap still clamps: a chair may narrow, never widen, the depth
  bound (mirrors the existing `min()` precedent).
- **Reserve without budget (O4).** `turn_reserve` declared with `turn_budget` absent resolves the
  budget through the fallthrough tiers while the reserve remains the chair's draw ceiling.

**Reserve source.** The invoker's reserve turns today come only from the invoker-level
`opts.turn_reserve` (`src/claude_invoker.ts:830`), identical for every chair. New resolution:
`reserveTurns = ctx.turn_reserve ?? opts.turn_reserve` (still with the `> 0` floor). The pinned
`chair_turn_reserve.test.ts` drives `opts.turn_reserve` and stays green; the chair-scoped path is
layered above it.

**Verified by** `tests/chair_turn_budget_schema.test.ts` (INV1, F1) and
`tests/chair_turn_budget_resolution.test.ts` (INV2-INV7, F4) — both authored RED against the schema
and the real `--max-turns` spawn args.

---

## Item 2 — the gig-level overflow pool

### O5 / O6 / O7 / O8 / O9 — declaration, draw, cap, starvation, empty-pool

**Declaration site (O5, F5).** The pool is declared on the dispatch payload as the primary source —
a new optional `pool?: number` on `BudgetInput` (`src/runtime.ts:388-394`), carried on the same
dispatch budget input. `StandardSchema` MAY carry a `reserve_pool?` default; when both are present
the dispatch value wins deterministically (no max/sum). `runGig` resolves
`poolOpening = deps.budget?.pool ?? standard.reserve_pool ?? 0` and seeds a `pool_remaining` on the
`BudgetState` it builds at `src/runtime.ts:1100-1113`.

**The draw (O6) mirrors the append-unit reserve/settle cycle (#232).** At chair-prep
(`src/runtime.ts:2043-2055`, alongside the append-unit reservation) the runtime computes the chair's
offered reserve `min(chair.turn_reserve ?? 0, pool_remaining − pool_reserved)` and threads it as
`ctx.turn_reserve`. Prep runs sequentially (the append-unit gate already increments `reserved`
synchronously there), so even a parallel batch cannot over-lend — **conservation holds**. After the
invocation, if the chair actually drew (its `budget_reserve_granted` event fired), the draw settles:
`pool_remaining -= granted`; otherwise the reservation is released. `effective_draw = min(own
reserve, pool_remaining)` is therefore the law, not a hope — theft is structurally impossible (F2).

**Recording (O8, INV13).** The runtime intercepts the invoker's `budget_reserve_granted` event
(already emitted at `src/claude_invoker.ts:1022-1025`, carrying `agent` + `reserve_turns` +
`sealed_before_grant`) inside the invocation's `onEvent` handler (`src/runtime.ts:2208`) and appends
a draw record `{ role, granted, pool_remaining_after }` to `BudgetState.draws`. A dry pool emits a
`budget_reserve_denied` marker (new); the runtime records a `denied` draw so starvation is visible.

**Starvation (O7, F3).** `pool_remaining` decreases to zero and stays there; a later chair is offered
`0`, draws nothing, and gets a visible denied-draw record — the pool never lends what it does not
hold. This is a reachable, recorded state, never a silent no-op.

**Empty-pool boundary (O9, F7, INV19).** A chair stopped at its budget with an empty pool
(`ctx.turn_reserve` resolves to `0`) keeps every output already sealed past the write boundary — the
existing `error_max_turns` recovery (`src/claude_invoker.ts:1019`, guarded by `reserveTurns > 0`)
is unchanged — and additionally emits the visible `budget_reserve_denied` marker. Stated as a
deliberate decision: the empty-pool path is the current keep-sealed-writes behaviour *plus* a
starvation record, not a silent inheritance.

**Orthogonality (O_/INV18).** Turns are not append-units are not dollars. A reserve draw moves
`pool_remaining` only; it never touches `spent`/`balance`/`base_cost`/`k`
(`src/runtime.ts:2028-2074`) and an append-unit depletion never consumes pool turns.

**Verified by** `tests/gig_reserve_pool.test.ts`: a fast-check property over generated pools and
chair-reserve vectors pins the min-law, no-theft, conservation, monotonicity and starvation
(INV8-INV12); example tests pin attribution (INV13/F6), dispatch-over-standard (F5), starvation
(F3), orthogonality (INV18); and an invoker-seam test pins the empty-pool boundary (INV19/F7).

---

## Item 3 — wire `yielding`

### D1 — the written decision: one concept at two scales

**A chair-in-reserve and a gig-that-is-yielding are ONE condition seen at two scales, not two
concepts.** A gig is `yielding` **iff** at least one seated chair is currently drawing its reserve.
This is the gig-scale projection of Item 2's chair-scale draw. `yielding` is a *reactive observed
state* (Kubernetes' memory-limit shape) — set at the parent when the draw is observed, never an
in-band gate (the invoker already argues the reserve cannot be delivered in-band because a chair's
tools are host tools the child's coltrane server never sees).

v0 scopes `yielding` to the **reserve-draw view only**. The append-unit "below cost-of-next-append"
pressure the original comment (`src/runtime.ts:402`) names is deferred; making `yielding` a union of
both pressures is a non-goal here.

### O10 / O11 / O12 — set, read, exit

**Set (O10, INV14).** On intercepting `budget_reserve_granted` for a seated chair, the runtime sets
`BudgetState.agent_state = "yielding"` — the first executable write of that member, which today
appears only in the comment at `src/runtime.ts:402` and the union at `src/runtime.ts:413`.

**Read (O11, INV17).** The transition is surfaced through `RunDeps.onProgress`
(`src/runtime.ts:218-222`) as an operator-facing budget-state event carrying `agent_state`, and on
the final `GigResult.budget_state`. `yielding` is no longer a term that only appears in a comment
and a union.

**Exit (O12, INV16).** `yielding` clears back to `active` when the drawing chair lands within its
reserve, and moves to `depleted` when the chair spends its reserve (and the pool) without landing —
in which case the failure carries the `depleted` `budget_state` attached at `src/runtime.ts:2621`.

**Verified by** `tests/gig_yielding_state.test.ts`: behavioural set + read (INV14/INV17), the INV15
biconditional that makes D1 executable, both exit transitions (INV16), and a source-scan set-site
guard (F8) — the direct guard against the lineage-record-03cacf6a "declared rule, no enforcement"
defect. A green suite is impossible unless something both **sets** and **reads** `yielding`.

---

## Out of scope (stated)

- Re-implementing the reserve-grant continuation, `ChildExitError`, or budget-stop write recovery
  (built and green on `fix/bootstrap-root-isolation`).
- Converting append-units to dollars, or changing what `BudgetState.settled_usd` means.
- Any change to the genome-view HTML.
- Pool preemption / reclaim of an early chair's undrawn-but-reserved share (v0 is strict draw-down,
  no preemption).
- Making `yielding` also cover the append-unit "below cost-of-next-append" pressure (deferred).
- `tests/chair_budget_stop_keeps_sealed_writes.test.ts` and `tests/chair_turn_reserve.test.ts` are
  **not modified** — they pin the invoker-level behaviour this set builds on, and must stay green.
