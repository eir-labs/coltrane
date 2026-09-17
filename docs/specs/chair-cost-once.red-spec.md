# RED spec — a chair invocation's settled cost is attributed once

**Contract:** `contract-chair-cost-once-v1`
**Laws:** `tests/spec_chair_cost_attributed_once.test.ts` (RED)
**Status:** RED by design — the enforcement does not exist yet; these laws make its absence fail.

## The defect (coltrane-ui#242, found 2026-09-17)

`runGig`'s seal loop stamps the chair's settled `cost_usd` and `tokens_used` — `chairReport`,
computed once per chair from that chair's `result` events (`src/runtime.ts` `makeUsageSink().reported()`)
— onto **every** record the chair seals:

```
// src/runtime.ts, the write loop over `resolved` (one entry per sealed record)
for (const { spec, slice } of resolved) {
  const rec = deps.outputs.write({
    …
    ...(chairReport.cost_usd   !== undefined ? { cost_usd:   chairReport.cost_usd }   : {}),
    ...(chairReport.tokens_used !== undefined ? { tokens_used: chairReport.tokens_used } : {}),
  });
}
```

So a chair sealing **N** outputs writes its spend **N times**. Any sum of `OutputMeta.cost_usd`
over a gig double-counts every multi-output chair, and coltrane-ui had to warn readers never to sum
per-output cost within a chair — a warning that is precisely the shape of a spec claiming A while the
code does B.

## The contract

> One settled cost, one record carrying it; the rest point at it.

| id | obligation / invariant | law |
|----|------------------------|-----|
| **O1** | Of the records one chair invocation seals, exactly the **first** carries `cost_usd` and `tokens_used`; every other record omits both and carries `cost_on`: the id of the record that carries them. | `O1 — … for ANY width n≥2 …` |
| **O2** | A single-output chair is **unchanged**: its one record carries `cost_usd` and `tokens_used` and no `cost_on`. | `O2 — … full $0.10 and no cost_on …` |
| **I1** | The sum of `cost_usd` over a completed gig's sealed records equals the sum of its settled chair costs for the chairs that sealed. | `I1 — the contract's checkable …` and `I1 — for ANY two settled costs …` |

## Mechanism, and the callsite each obligation lands on

The one seal boundary is the `resolved`-write loop in `runGig` (`src/runtime.ts`). Today it holds
the whole chair's `chairReport` and applies it per record. The enforcement must, for the records of
ONE chair invocation (the `written` array, in seal order):

- **O1 / O2** — carry `chairReport.cost_usd` / `chairReport.tokens_used` on `written[0]` only, and
  on every `written[i>0]` write **no** `cost_usd` / `tokens_used` but a new `cost_on = written[0].id`.
  For a single-output chair `written` has one element, so it carries the cost and no `cost_on`
  (O2 is the degenerate case of O1).
- **`cost_on`** — a new optional field on `OutputMeta` / `OutputRecord` and `OutputWrite`
  (`src/outputs.ts`): the id of the sibling record of the same invocation that carries the cost.
  It does not exist today; the laws read it through an index cast, so today it reads `undefined`.
- **I1** follows by construction once O1 holds: each chair contributes its settled cost exactly
  once to the gig's sealed `cost_usd`, so the sum over records equals the sum over chairs.

Scope is exactly the seal path and `OutputMeta` (`scope_in`). The gig ledger row and reuse-recall
records are out of scope (`scope_out`) — untouched by these laws.

## Verification method

Every law runs the **real** `runGig` path with a real in-memory `OutputStore`
(`createOutputStore`) and a stubbed `AgentInvoker` whose `result` event reports settled usage exactly
as the CLI's stream-json result does (`total_cost_usd` + `usage`), the template shared by
`tests/runtime_accounting_integrity.test.ts`. No `claude` subprocess is spawned.

- **O1** and **I1** are **universal properties** — "for ANY number of records a chair seals", "for
  ANY pair of settled costs" — and are pinned with **fast-check** (`fc.asyncProperty`, 30 runs each).
  The double-count is a per-record multiplier, so a single hand-picked width or cost could pass by
  luck; the property forecloses that. Each also carries the contract's own worked example so a reader
  sees the concrete number ($0.40 + $0.10 → $0.50) the property generalises.
- **O2** is a **specific behaviour** and is example-based. Because a single-output chair already
  satisfies O2 today, the law draws the boundary the obligation is about — the once-rule reshapes
  **only** multi-output seals — by running the single-output chair alongside a two-output chair in
  one gig: the single chair keeps its whole cost with no `cost_on` (the "unchanged" guarantee), while
  the two-output chair's second record must omit cost and carry `cost_on` at the carrier. That second
  clause is what fails today.

## Observed red (this run)

`npx vitest run tests/spec_chair_cost_attributed_once.test.ts` → **4 tests, 4 failed**, each on a
contract-reason assertion:

- **O1** — `a non-first record of the same invocation carries NO cost_usd (wide-interp): expected 0.01 to be undefined` (the second record carries the cost too).
- **I1 (checkable)** — `the gig's sealed cost_usd sums to the settled $0.50: expected 0.9 to be close to 0.5` (0.40 + 0.40 + 0.10).
- **I1 (property)** — counterexample `[0.01, 0.01]`: `expected 0.03 to be close to 0.02`.
- **O2** — `the multi-output chair's non-first record points cost_on at the carrier: expected undefined to be '<id>'` (`cost_on` is never written).

Controls stay green: `tests/runtime_accounting_integrity.test.ts`,
`tests/gig_failure_accounting.test.ts`, `tests/spec_spend_survives_kill_failure_resume.test.ts`
(31 tests passed).
