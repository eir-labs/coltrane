# Declared-Field Reachability Sweep — Red-Spec

**Branch:** `laws/declared-fields-red`
**Law file (sealed, not edited):** `tests/declared_fields_are_read.test.ts` (7 laws)
**Enforcement built:** `tests/support/declared_field_reachability.ts`
**Sibling ratchet (untouched):** `tests/exported_symbols_are_reachable.test.ts` (pinned 19)

## The contract

A declared FIELD that nothing reads is a contract the code does not keep. The
exported-symbols ratchet pins dead *exported symbols*; it is blind to a declared
field — parsed, stored, validated, and never read by name. Seven such defects were
diagnosed in this repo on 2026-08-20 and four shipped with **passing** tests: each
test proved a mechanism WORKS; none asked whether anything REACHES the field
(`supplies` read only through `Object.keys`, `repository` unread for ten days,
`dirsByState.done`/`.failed`, `change-set.tests_added` with zero readers).

This spec builds the sweep the sealed law demands: enumerate every declared field
name across three namespaces and report, BY NAME, the ones no `src/` code reads.

## Obligations → mechanism → callsite → red test

Each obligation is an invariant of the sealed law; each is verified by a running
assertion in `tests/declared_fields_are_read.test.ts` that was RED against the stub
(`{ unread: [], totalFields: 0, methodNote: "" }`, `PINNED_UNREAD_FIELDS = 0`) and
is now green by describing the truth.

| # | Obligation | Mechanism (in `declared_field_reachability.ts`) | Red test |
|---|------------|--------------------------------------------------|----------|
| INV-1 | The sweep actually extracts declared fields — not vacuous | `analyzeDeclaredFieldReachability()` unions `declaredFieldsFromJsonDir("domain_types")`, `…("core_types")`, and `declaredFieldsFromGenomeSchema()`; `totalFields` counts the swept (≥5-char) population | `the sweep extracts declared fields at all — the law is not vacuous` |
| INV-2 | Unread fields are named, not merely counted | `unread` is a sorted `string[]` of field identifiers | `names the unread fields — a bare count tells nobody what to fix` |
| INV-3 | A truly-dead field is caught (positive calibration) | `tests_added` (domain_types/change-set.json, not in required_fields) has no `\btests_added\b` in the corpus → lands in `unread` | `` calibration+: `tests_added` … IS reported unread `` |
| INV-4 | A read field is never flagged (negative calibration / fail-safe) | `repository` (src/worker.ts), `supplies` (src/runtime.ts value + src/composition.ts `Object.keys`), `hydration` (src/claude_invoker.ts) each produce a `\bname\b` hit → excluded from `unread` | `` calibration-: `repository`, `supplies`, `hydration` … are NOT unread `` |
| INV-5 | Soundness — no false positive | READ iff `\bname\b` matches anywhere in the concatenated top-level `src/*.ts`; any hit (value, destructure, spread token, `Object.keys(x)` arg, dynamic sibling, type assertion) counts | `fail-safe soundness: every reported-unread field truly has NO word-boundary read in src/*.ts` |
| INV-6 | Method + blind spots are a first-class, testable artifact | `report.methodNote` (const `METHOD_NOTE`) documents the method and blind spots and contains the markers `Object.keys`, `spread`, `dynamic`, `READ`, `src/` | `blind spots and method are documented on the engine, not just in a strippable comment` |
| INV-7 | Ratchet — the count may only decrease | `PINNED_UNREAD_FIELDS = 181` equals `report.unread.length`; the law fails if the count GROWS | `` no NEW unread declared fields (pinned at 181) `` |

## Method and its blind spots

Pure Node `fs` + regex — no AST, no dependency, no network (the sibling ratchet's
technique). A field name ≥ 5 chars is READ iff `\bname\b` matches anywhere in the
concatenated text of top-level `src/*.ts` files. The sweep **under-reports on
purpose** (fail-safe toward READ), so the pinned number is a LOWER bound on the true
dead-field count. Blind spots, stated so the number is trusted for what it is:

- **(a) dynamic key access** `obj[variable]` — the field name is not a token, so a
  field reached only this way shows as unread (triage by hand before fixing).
- **(b) wildcard spread** `{...obj}` — copies fields without naming them.
- **(c) destructuring / `as { field: T }`** — DO name the token → counted READ.
- **(d) `Object.keys(x)`** — reads key existence, not values, but is counted READ
  when the name appears (the exact pattern the hydration defect hid inside).
- **(e) corpus is `src/*.ts` only** — a reference from `tests/` does NOT count as
  read (a test naming a field while nothing at runtime reaches it is the very defect
  this closes; the engine lives under `tests/support/` so its own prose is outside
  the corpus).
- **(f) Zod extraction reads current syntax** — novel combinators (`.extend`,
  `.merge`, `.pick`, `.omit`) could synthesise a field the extractor misses.
- **(g) names < 5 chars excluded** — collide with incidental substrings; silently
  omits genuinely-unread short fields (e.g. `done`), an accepted limit.

## Why 181 is the true number

The 60-vs-19 over-count in the exported-symbols ratchet (blind to `export *`) is why
the number is verified, not asserted:

1. The soundness law (INV-5) confirms every one of the 181 has zero `\bname\b` reads
   in `src/*.ts` — none is a partial-match false positive.
2. The Zod extractor was audited to capture ONLY `z.object({…})` field keys:
   `.refine`/`.superRefine` bodies (with their `message`/`code`/`path` keys) chain
   after the object's closing brace and fall outside every captured span, and there
   are no multi-line object-literal defaults or inline union object args to leak
   non-field tokens.
3. Calibration lands correctly: `tests_added` present; `repository`/`supplies`/
   `hydration` absent.

The bulk of the 181 are agent-I/O schema fields (`domain_types/*.json` output types)
that flow through generic Zod validation and are consumed by prompts/agents, never
read by name in orchestrator `src/` — exactly the dead-contract class this ratchet
pins and holds from growing.

## Non-goals honoured

Detection only — no field is fixed. `domain_types/`, `core_types/`,
`src/genome_schema.ts`, the sealed law file, and
`tests/exported_symbols_are_reachable.test.ts` are untouched. No new dependency, no
AST library, no network.
