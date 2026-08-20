# Grounding-as-input — the RED spec

Today the reading seat of `software-change-pr-v1` (agent `john`, role `read-context`) re-derives the
same repository facts on every gig, and its tool-call budget is the binding constraint on what a
change may cover. Measured this week: successful groundings landed at **14, 15, 17, 19, 19, 22, 24**
calls against a cap of 24 — successes AT the ceiling — and three gigs died at `error_max_turns`,
each losing the whole grounding because exhaustion produces NOTHING. The determining variable was
not brief length but HOW MANY PLACES the reader had to look.

`domain_types/change-context.json` splits along a line nobody drew deliberately. **Mechanical**:
`relevant_files` (target paths + import graph), `existing_tests` (module→tests, a pure index
lookup), `entry_points` (exports + call sites), `conventions_observed` (repo-wide, IDENTICAL every
run), `boundary` (a restatement of the request's `target_paths`/`out_of_scope`). **Judgment**:
`claims`, `unknowns`, and the frame. The reader spends scarce turns on the mechanical half and runs
out before the judgment half — the half that is why the fix is correct.

This spec holds **two decoupled ideas apart** and turns each obligation into a currently-failing
axiom. It does NOT implement the enforcement.

## The gap, read from the tree

- `standards/software-change-pr-v1.json:141` declares `input_types: ["change-request"]` only. The
  `read-context` chair (`:16`) is already an ENTRY chair (`depends_on: []`, `:19`) whose
  `output_contract` is `change-context` — but nothing lets a change-context ARRIVE as an input.
- `src/runtime.ts:2071` `pullSeeds` already offers a gig-payload record to an entry chair by type,
  and `src/runtime.ts:2101` (#156) already lets a gig-payload record satisfy an entry chair's
  `input_contract` when the type is in the standard's `input_types`. The seam exists; the
  declaration that would use it (change-context ∈ input_types, ∈ read-context's input_contract) does
  not.
- `standards/lineage-reweave-v0.json` already seeds an entry chair (`associate`, `depends_on []`)
  with senses it did not gather (`tests/studio_repass.test.ts:84`). The pattern is proven for the
  lineage family; it has never been applied to codebase grounding.
- There is **no deterministic producer** for the mechanical fields. No `src/repo_index.ts`, no
  `repository-index` type. The mechanical half is re-read by a model on every run.
- There is **no seam module**: no `assembleChangeContext`, no load-bearing-claim predicate, no
  freshness gate. Nothing makes it impossible to satisfy change-context by lookup alone.

## The contract this spec pins (asserted, not implemented)

Two new modules and two genome edits an implementation gig must produce to turn this spec green.

```
// src/repo_index.ts — the deterministic producer of the MECHANICAL fields
compileRepositoryIndex(files: {path,content}[], opts: {source_revision}): RepositoryIndex   // throws RepoIndexError, never a partial index
reconcileMechanical(compiled: RepositoryIndex, modelReading): RepositoryIndex                 // compiler is authoritative on divergence

RepositoryIndex = {
  source_revision, files_to_exports, file_importers, module_tests,
  entry_points, conventions_observed, boundary
  // NO claims / unknowns / frame — mechanical structure only, by construction
}

// src/grounding.ts — the grounding-as-input seam + the judgment guards
assembleChangeContext(index, judgment): ChangeContext        // mechanical from index, judgment from reader/human; throws if index carries judgment
admitChangeContext(rec, index): {ok, reason?}                // reject empty/derivable claims; require >=1 load-bearing claim (locator + non-derivable)
freshnessGate(rec, currentRevision): {ok, reason?}           // refuse a stale index revision
snapshotMechanical(rec): {...}                                // the golden-master surface — strips claims/unknowns/frame
consumerAcceptsGrounding(rec): {ok, reason?}                  // producer-agnostic acceptance — keys on the TYPE only

// genome edits
domain_types/repository-index.json                           // the compiled artifact type (mechanical fields + source revision)
standards/software-change-pr-v1.json                         // change-context added to input_types AND read-context's input_contract
```

The load-bearing constraint (`constraint_that_matters_most`): **do not compile away the claims.** A
locator is mechanical, but "line 189 pushes `env:{}` unconditionally, and the comment concedes the
posture was provisional" is a READING. The spec makes it impossible to satisfy change-context by
replacing judgment with lookup — a prohibition (the compiler never emits claims) plus a positive
predicate (an admissible claim carries a `file:line` locator AND asserts something NOT derivable
from the mechanical fields).

## Obligations, mechanisms, callsites

Each obligation maps to at least one RED test (see `coverage_map`). The verification method is
chosen per invariant — property-based / metamorphic (fast-check) where the invariant is a universal
property of the compiler, example / consumer-contract where it is a specific behavior of the seam.

**The mechanical producer (C2, O3-O4).** `compileRepositoryIndex` obeys universal laws asserted over
generated synthetic repos, WITHOUT a hand-authored oracle (which would recreate the model reading it
replaces):
- I1 round-trip — every `file→importers` edge is the exact inverse of a real export-consumption.
- I2 no dangling edges — every endpoint resolves to a real source file.
- I3 `entry_points` ⊆ declared exports.
- I4 `module→tests` soundness — every entry names a test that references the module.
- I5 determinism — permuting file order leaves the index byte-identical.
- I6/I7/I8 locality — add-one-import / rename / delete-test each move exactly the edges they must.
- Callsite: `tests/repo_index_compiler.test.ts` against `src/repo_index.ts`.

**Do-not-compile-away-the-claims (C3, O5-O6-O11).** The compiler produces mechanical structure only,
and a change-context is unsatisfiable by lookup:
- I12 prohibition — the compiled index carries no `claims` / `unknowns` / `frame`.
- I13 positive predicate — empty claims OR every-claim-derivable-from-the-index is REFUSED; only a
  claim with a `file:line` locator asserting a non-derivable reading is admitted.
- I14 no oracle for judgment — the golden-master surface (`snapshotMechanical`) strips judgment.
- I15 oracle-on-divergence — where a model reading disagrees, the compiler value stands.
- I18 fail-closed — a repo the compiler cannot fully resolve is REFUSED, never sealed as partial.
- Callsites: `tests/repo_index_compiler.test.ts`, `tests/grounding_as_input.test.ts` against
  `src/repo_index.ts` / `src/grounding.ts`.

**Grounding-as-input (C1, O1-O2-O8).** change-context arrives as an input from any of four
interchangeable producers, verified in isolation (the Pact consumer/provider split):
- I9 the consumer declares change-context a seedable input at its `depends_on []` entry chair.
- I10 every producer emits a record that satisfies the shared change-context type (via
  `loadRegistry(genome).validate`).
- I11 the consumer is producer-agnostic — it keys on the type, never on who produced it.
- I16 freshness — a change-context whose index revision != current source is refused (F1).
- I17 degrade-not-die — a reader/human that hit its cap may seal partial grounding, naming the
  unreached areas in `unknowns`, ONLY while still carrying a load-bearing claim (contingent; the cap
  itself is re-examined after the structural change lands, never raised as the fix — out of scope).
- Callsites: `tests/grounding_as_input.test.ts` against the real loaded genome + `src/grounding.ts`.

## Why RED now

`src/repo_index.ts` and `src/grounding.ts` do not exist, and `software-change-pr-v1` does not yet
accept change-context as an input. Every assertion is on enforcement that is unbuilt: the property
suite errors on the missing compiler import; the seam suite fails on the missing seam module and the
un-declared input. An implementation gig turns each axiom green by building the producer and the
seam, and by wiring change-context as a first-class input — at which point the reader stops
re-deriving the mechanical half and the exhaustion symptom may cease to be reachable at all.
