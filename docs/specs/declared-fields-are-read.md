# Spec: the reachability ratchet extends to declared fields nothing reads

## The contract

The exported-symbols ratchet (`tests/exported_symbols_are_reachable.test.ts`) pins the count of
exported symbols nothing calls. It cannot see a **declared field** — a schema property or Zod object
key — that is parsed, stored, and never read. Every defect diagnosed on 2026-08-20 was of that
second kind, and four shipped with passing tests that proved a mechanism works while nothing reached
it. This change ships the **detector and the pin only**. It fixes no field, touches no schema, adds
no dependency, and uses no AST — the exported-symbols regex technique is the precedent.

## Obligations, their mechanism, and the red test that verifies each

Reader corpus throughout is **top-level `src/*.ts`, flat** — the exact scope of the exported-symbols
ratchet. `tests/` is deliberately NOT a reader: the failure mode is that tests reached mechanisms
runtime never did, so a test reference must not count as a read.

| # | Invariant | Mechanism / callsite | Red test |
|---|-----------|----------------------|----------|
| INV-EXTRACT-NONVACUOUS | The sweep parses the three namespaces and finds fields (`totalFields > 0`). | `analyzeDeclaredFieldReachability()` unions the keys of `schema.properties` in every `domain_types/*.json` and `core_types/*.json` with every Zod `.object({ field: … })` key in `src/genome_schema.ts`. | `the sweep extracts declared fields at all — the law is not vacuous` |
| INV-NAMES-NOT-COUNT | The detector yields NAMES, not a bare count. | `report.unread` is a `string[]` of field identifiers; the pin test's failure message joins them. | `names the unread fields — a bare count tells nobody what to fix` |
| INV-CALIB-UNREAD-TESTS_ADDED | `tests_added` (declared, zero src/ readers) IS reported unread. | `tests_added` ∈ `domain_types/change-set.json` `schema.properties`, ∉ its `required_fields`; `grep -rn "tests_added" src/` → 0 lines. | `calibration+: 'tests_added' … IS reported unread` |
| INV-CALIB-READ-REPOSITORY | `repository` is NOT reported unread. | Read at `src/worker.ts:145` via `(claim.input as { repository?: unknown })?.repository`. | `calibration-: repository, supplies, hydration … are NOT unread` |
| INV-CALIB-READ-SUPPLIES | `supplies` is NOT reported unread. | Value read at `src/runtime.ts:2585` (`p.chair.supplies`); keys at `src/composition.ts:346`. | `calibration-: repository, supplies, hydration … are NOT unread` |
| INV-CALIB-READ-HYDRATION | `hydration` is NOT reported unread. | Read at `src/claude_invoker.ts:183/185`, `src/runtime.ts:2585`. | `calibration-: repository, supplies, hydration … are NOT unread` |
| INV-SOUND-FAILSAFE | No false positives: every reported-unread field truly has no `\bname\b` in `src/*.ts` (the engine under-reports). | The test independently re-reads the corpus and asserts no reported name matches — an over-read (spread, partial, skipped file) fails here. | `fail-safe soundness: every reported-unread field truly has NO word-boundary read in src/*.ts` |
| INV-BLINDSPOTS-DOCUMENTED | The method and its blind spots travel WITH the analysis as a testable artifact. | The engine exports `methodNote`; the test asserts it names `Object.keys`, `spread`, `dynamic`, the `READ` fail-safe, and the `src/`-only corpus. | `blind spots and method are documented on the engine …` |
| INV-PIN-RATCHET | The count of unread fields is pinned and may only decrease. | `PINNED_UNREAD_FIELDS` is the true, hand-verified count; `unread.length === PINNED_UNREAD_FIELDS`. | `no NEW unread declared fields (pinned at …)` |

## Method and its known blind spots

Field name is READ iff a word-boundary regex `\bname\b` matches anywhere in the concatenated
`src/*.ts` text. Names shorter than 5 chars are excluded (they collide with incidental substrings —
same trade as the exported-symbols law, which silently omits genuinely-unread short fields).

**Fail-safe: ambiguous is READ.** Any word-boundary hit counts as a read — including a name inside an
`Object.keys(x)` argument, a spread `{...x}`, or a `as { name: T }` assertion. Precise exclusion
needs an AST (forbidden) and risks calling a value-read field dead. The hydration defect hid inside
an `Object.keys` read, so the law errs toward READ. Precedent for stating blind spots aloud: the
exported-symbols law once reported 60 orphans where the truth was 19 (it could not see `export *`).

Blind spots: (a) `obj[variable]` dynamic key → shows UNREAD (false positive, triage before fixing);
(b) `{...obj}` spread → shows UNREAD; (c) `as { field: T }` assertions DO count as reads;
(d) `Object.keys(x)` counted as READ; (e) `src/*.ts` only — a tests-only reference is NOT a read;
(f) Zod extraction tracks current syntax; `.extend`/`.merge`/`.pick` could be missed until taught.

## RED-first structure

`tests/declared_fields_are_read.test.ts` (this seal) holds the calibration, guard, soundness, and
ratchet assertions and imports the **engine** it demands from
`./support/declared_field_reachability.js`. That module does not exist yet — the enforcement is
unbuilt — so every assertion is RED via an unresolved import. The builder ADDS the engine module,
implements the method above, computes the true count, hand-verifies a sample (recorded in that
module), and pins `PINNED_UNREAD_FIELDS`. The builder may NOT edit the sealed test file. The engine
lives under `tests/support/` (not `src/`) deliberately: were it in `src/`, its own source text would
enter the reader corpus and could mask a genuinely-unread field.

### Engine module contract (`tests/support/declared_field_reachability.ts`, ADDED by the builder)

```ts
export interface FieldReachabilityReport {
  unread: string[];     // declared field names (>= 5 chars) with zero \bname\b reads in src/*.ts, sorted
  totalFields: number;  // count of distinct declared field names swept across the three namespaces
  methodNote: string;   // method + blind spots (must name Object.keys, spread, dynamic, READ, src/)
}
export function analyzeDeclaredFieldReachability(): FieldReachabilityReport;
export const PINNED_UNREAD_FIELDS: number; // the true, hand-verified count; may only decrease
```

## Non-goals

Do not fix the unread fields the law names. Do not modify `domain_types/`, `core_types/`, or
`src/genome_schema.ts`. Do not alter `tests/exported_symbols_are_reachable.test.ts`. No new
dependency, no AST library, no network, no built `dist/`.
