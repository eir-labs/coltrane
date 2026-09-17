# Records by address — RED spec

**Contract:** `contract-records-by-address-v1` · **Slice 1** of the seat-briefing plan (2026-09-17).
**Status:** RED. Every law below FAILS today, on an assertion stating the contract's reason — never
on a collection or import error. The enforcement they demand does not exist yet; that is the point.

## The measured problem, and the contract

gig `c1771b13`'s attester hit the 32,000 output-token cap **three times** re-emitting ~150KB of
verbatim law patches into `red-spec.diffs`, and every downstream seat receives the whole record
through `JSON.stringify(o.data)` (`src/claude_invoker.ts`). **The bytes are the cost.** So (operator's
decision): a seat supplies only **where** the bytes are — `{path, commit}` for a law, `{path, base}`
for a change — and the **engine** stamps **what** they are, from git, **at seal**. No patch body is
ever model output or a record field.

## The seal-path mechanism (the callsite)

Stamping is a **seal step**, not a type constraint. It lands in `src/runtime.ts`, inside
`executeChair` (`src/runtime.ts:2573`), **beside the `*_sha` backfill** — the `backfillShas` closure
(`src/runtime.ts:2888`), run over every resolved slice before anything is written
(`for (const { slice } of resolved) backfillShas(slice)`, ~`:2988`). Two new exported seal helpers
sit there, called by domain_type, as `computeAppendCost` (`:923`) and `workingModel` (`:950`) are
exported seal helpers the runtime already calls:

- `stampLawAddresses(laws, tree_root)` — for a `red-spec`, stamps each law's `blob_sha`
  (`git rev-parse <commit>:<path>`) and `tests` (the `it`/`test` titles in that blob, file order).
- `stampChangeAddresses(changes, tree_root)` — for a `change-set`, stamps `blob_sha`
  (`git hash-object` of the file in `tree_root`, or the literal `"deleted"`), `patch_sha256`
  (sha256 of `git diff <base> -- <path>` in `tree_root`) and `bytes` (that diff's length).

`tree_root` is a new `RunDeps` field (`src/runtime.ts:261`): the directory whose git objects the seal
stamps from. Stamping **never** reads `process.cwd()`.

## Obligations → mechanism, callsite, verifying law

| Obl | Mechanism / callsite | Verifying law |
|-----|----------------------|---------------|
| **O1** | `red-spec` → **v3**: `laws:[{path,commit,blob_sha,tests}]`, no `diffs`; seat gives `{path,commit}`, engine stamps `{blob_sha,tests}`. `domain_types/red-spec.json`; `runtime.ts:2888` | `spec_records_by_address` — *O1 — a red-spec v3 carrying `laws` … validates* |
| **O2** | `change-set` → **v2**: `changes:[{path,base,blob_sha,patch_sha256,bytes}]`, no `diffs`; deletion → `blob_sha:"deleted"`. `domain_types/change-set.json`; `runtime.ts:2888` | *O2 — a change-set v2 … validates*; *O2 — a file absent … stamps blob_sha as the literal "deleted"* |
| **O3** | `RunDeps.tree_root`; stamping resolves against it, never `process.cwd()`. `runtime.ts:261`, `:2888` | *O3 — stamping reads RunDeps.tree_root, not process.cwd()* |
| **O4** | No agent declaring `red-spec`/`change-set` names the retired `diffs` in method/constraints (declared-fields defect, inverted). `agents/*.json` (offenders today: change-verifier, deploy-scout, red-law-reviewer, red-spec-attester, red-spec-builder, spec-reviewer) | *O4 — no agent declaring red-spec or change-set … names `diffs`* |
| **O5** | Starvation guarantee in address form: no free-text patch field, and a sealed address always resolves to exact committed bytes. `domain_types/red-spec.json`; `stampLawAddresses` | `a_patch_carries_a_patch` — *O5 — a sealed law address resolves to the EXACT committed bytes*; *O5 — the v3 red-spec has no free-text patch field* |

## Invariants → verifying law (`spec_records_by_address.test.ts`)

| Inv | Checkable | Verifying law |
|-----|-----------|---------------|
| **I1** | 14 laws of ~10KB files each seal as JSON < 4KB | *I1 — 14 laws of ~10KB files each seal … under 4KB* |
| **I2** | `blob_sha == git rev-parse <commit>:<path>`; `tests ==` the blob's titles, in order | *I2 — the stamped blob_sha equals `git rev-parse <commit>:<path>` …* |
| **I3** | `patch_sha256`/`bytes ==` sha256/length of `git diff <base> -- <path>` in `tree_root` | *I3 — a change's patch_sha256 and bytes equal … `git diff <base> -- <path>`* |
| **I4** | seal drill finds `draft-red-laws-v0` + `build-from-red-spec-v0` dispatchable under the address shape | *I4 — the seal drill finds draft-red-laws-v0 and build-from-red-spec-v0 dispatchable …* |

## Failure modes → verifying law (`spec_records_by_address.test.ts`)

| FM | Refusal | Verifying law |
|----|---------|---------------|
| **F1** | unknown commit / absent path → `law_record_unresolvable` naming `path@commit`; nothing sealed | *F1 — an unresolvable law address …*; *F1 — an unknown commit …* |
| **F2** | no `tree_root` → `tree_root_unknown`; never a fallback to `process.cwd()` | *F2 — a red-spec … no tree_root …*; *F2 — a change-set … no tree_root …* |
| **F3** | seat-supplied `blob_sha`/`tests`/`patch_sha256`/`bytes` disagreeing with the engine → `law_bytes_mismatch` naming path+field; never silently overwritten | *F3 — a seat-supplied blob_sha …*; *F3 — a seat-supplied change `bytes` …* |
| **F4** | retired shape (either type with `diffs`) → validation fails naming the missing `laws`/`changes` | *F4 — a retired-shape red-spec … names `laws`*; *F4 — a retired-shape change-set … names `changes`* |

## The three superseded suites — the decision, stated (not silent)

1. **`a_patch_carries_a_patch.test.ts` — REWRITTEN to the address contract.** The old law defended
   `red-spec.diffs[].patch` (a string a drafter could seal a summary into). `diffs` is retired, so the
   starvation guarantee is re-expressed in **address form** (O5): no free-text patch field for prose to
   hide in, and a sealed address always resolves to exact bytes.
2. **`the_drill_honours_a_pattern.test.ts` — PRESERVED title-for-title.** *Reason:* D1–D6 exercise the
   drill's general pattern-tolerance through **synthetic** types (`patch-carrier`, `impossible-carrier`,
   `contradictory`), never the real `red-spec` schema. Retiring `diffs` removes the motivating example
   (`red-spec.diffs[].patch`, 30d1b48) but changes no assertion; the drill must still honour a `pattern`
   on any type carrying one. Not left pinning `diffs[].patch` — it never asserted on it.
3. **`a_stale_genome_says_so.test.ts` — PRESERVED title-for-title.** *Reason:* its subject is external
   genome drift → a dispatch warning, verified through synthetic types (`stale-sig`). No assertion
   depends on the record shape; it names `red-spec`/`diffs` only in historical comments, which stay
   accurate. Orthogonal to the record migration.

## Testing method

Example-based (Vitest) for specific behaviours — type acceptance/refusal, the named refusal codes, the
drill's dispatchability. **Axiomatic** where the invariant is a universal property computed and
compared against git's own answer: I2 (`blob_sha`/`tests` vs `git rev-parse`), I3 (`patch_sha256`/
`bytes` vs the real `git diff`), I1 (a size bound over a large fixture). Every git-touching law builds
a **temporary git repository it creates itself** (`mkdtempSync` + `git init`) and tears it down;
**nothing reads or writes this repository's own history.** The not-yet-existing seal helpers are
reached **reflectively** through the runtime namespace, so a missing export is `undefined` (red via a
leading, contract-stating assertion) rather than an ESM link error that stops the file collecting.

## Provenance / the inherited tree

When this drafter was seated, `git status --porcelain` reported two paths already present — both this
seat's own target deliverables, for this gig: `a_patch_carries_a_patch.test.ts` (modified) and
`spec_records_by_address.test.ts` (untracked). No foreign run's work was present. This run verified
both against the real callsites and **ran** them — all 19 laws observed RED for the contract's reason.
Every path was staged explicitly by name; nothing was blanket-staged.
