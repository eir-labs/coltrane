# SPEC — deliberation-before-amendment-v1 (the landrace amendment)

**Status:** RED. The tests in `tests/deliberation_before_amendment_v1_spec.test.ts` fail today
because `standards/deliberation-before-amendment-v1.json` does not exist yet. That is the
RED-first gate this institution's own law requires: the failing law lands before the artefact.

## Why

Founding-pass Step 2. `docs/founding/RUNBOOK.md` line 53 records the founding finding: the seed's
`deliberation-before-amendment-v0` does not validate on this engine tip. The engine's `NEEDS_TARGET`
rule (`src/composition.ts:582-588`) refuses a first phase whose seat holds exactly one primitive,
`VERIFY`, when there is no upstream phase target (`upstreamPhasePrimitives.size === 0 &&
ag.primitives.length === 1`). v0's sole `VERIFY` phase trips exactly this guard.

The mend is not to relax the engine — it is to give the reviewer an upstream to target. A
non-drafting reader frames the proposed amendment BEFORE judgment; the reviewer then judges what the
reader framed. This is the thin-canon doctrine made structural: **the reader frames and never
judges; the reviewer judges and never drafts.**

## The obligation — the two-phase graph

A single new file, `standards/deliberation-before-amendment-v1.json`. No existing standard or agent
is modified; no engine source is touched.

| Invariant | Obligation | Mechanism / callsite | RED test |
|-----------|-----------|----------------------|----------|
| INV-1 | The standard file exists | `standards/deliberation-before-amendment-v1.json` on disk | `INV-1 presence › the standard file exists on disk` |
| INV-2 | Exactly two phases, order `read-proposal` → `deliberate` | `phases[].name` | `INV-2 phase count + order › has exactly two phases…` |
| INV-3 | `read-proposal` chair = `context-reader` (SENSE+INTERPRET, per `agents/context-reader.json`), `input_contract=['change-request']`, `output_contract=['change-context']`, no `depends_on` | `phases[0].chairs[0]` | `INV-3 read-proposal chair › …` (4 tests) |
| INV-4 | `deliberate` chair = `spec-reviewer` (VERIFY, per `agents/spec-reviewer.json`), `depends_on=['read-proposal']`, `input_contract=['red-spec','change-context']`, `output_contract=['change-verdict']` | `phases[1].chairs[0]` | `INV-4 deliberate chair › …` (4 tests) |
| INV-5 | `domain='spec-drafting'`, `input_types=['change-request','red-spec']`, `output_types=['change-verdict']`, `status='active'` | top-level standard fields | `INV-5 metadata › …` (4 tests) |
| INV-6 | Each phase's `intent` carries the thin-canon doctrine: reader frames, never judges; reviewer judges, never drafts | `phases[].intent` | `INV-6 thin-canon intent doctrine › …` (4 tests) |
| INV-7 | The standard composes green — `NEEDS_TARGET` passes because the VERIFY phase now has its upstream target; `npx coltrane validate` reports no load error | `loadGenome(REPO)` runs `composeStandard`; `src/composition.ts:582-588`; validate at `src/cli.ts:351-354` | `INV-7 composes under validate › …` (2 tests) |

## How INV-7 is proven RED, then GREEN

`npx coltrane validate` loads the genome and exits non-zero on any `load_error`
(`src/cli.ts:351-354`). `loadGenome` runs `composeStandard` over every standard file, so a
`NEEDS_TARGET` refusal surfaces as a `load_error` keyed to this slug. The INV-7 test asserts there
is **no** such error and that the standard loaded — which is exactly `validate` green over the new
graph. Today the file is absent, so `g.standards.has(SLUG)` is false and the test fails; once the
standard is authored with `context-reader` (SENSE+INTERPRET) as phase 1,
`upstreamPhasePrimitives = {SENSE, INTERPRET}` when `spec-reviewer` (VERIFY, length 1) is evaluated
in phase 2, the `NEEDS_TARGET` condition is false, and the graph composes.

## Not in scope

No agent file is edited (`context-reader`, `spec-reviewer` are used as-is). No existing standard is
edited. `src/composition.ts` is not patched. The institution law count stays at 7 — a standard file
is not a law. No `deliberation-before-amendment-v0` is created. No private sibling-project
vocabulary crosses the public boundary.
