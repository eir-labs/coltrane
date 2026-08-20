# Spec — a sealed output stamps the type's REAL version

**Status:** RED spec (laws written; enforcement not yet implemented)
**Branch:** `spec/type-extend-second-extend` (build on `ae7954d`, PR #433)
**Gig:** 4fe55e0b · draft-laws
**Red tests:** `tests/domain_type_version_stamp.test.ts`
**Change plan:** bill-change-plan-4fe55e0b · **Decision:** miles-change-decision-4fe55e0b

## The contract

A sealed output records which domain type it conforms to and, inside the content-hash
pre-image (`src/canonical_form.ts:114`), the **version that type carried at seal time** — the
version the loaded genome's copy holds at that moment. Not the newest, not the constant `1`.

Until PR #433 every domain type was version 1 — nothing could bump one — so hardcoding `1` was
accurate. #433 made a type's version real: `type_extend` persists a bumped definition and a second
extend reaches v3. The seal stamp did not follow. Because `domain_type_version` is folded into
`outputContentHash`, the constant is in the record's **identity**, not merely a field beside it:
two outputs conforming to genuinely different versions of one type hash as though they conformed to
the same. This is how the readable-chain promise (every output carries a trustworthy `content_sha`)
degrades without anything failing.

## Obligations → mechanism → callsite → law

The direction (settled by miles) is a new `OutputStore.typeVersionOf(slug): number` that parallels
`coreTypeOf`, reading the in-memory registry (`registry.listTypes().find(t => t.slug === slug)?.version ?? 1`).
The four seal sites read the current genome's version through it; `RunDeps` still touches the
registry only via `OutputStore`. `outputs.write()` keeps its `o.domain_type_version ?? 1` default,
which is what preserves byte-identity for the 9,110 already-sealed v1 records.

| # | Obligation | Mechanism / callsite | Law |
|---|------------|----------------------|-----|
| AC1 | The **primary seal** records the real version, observed on the sealed record | Pass `domain_type_version: deps.outputs.typeVersionOf(spec.domain_type)` into `outputs.write()` at `src/runtime.ts:2742` (today it omits the field → defaults to 1) | **LAW A** (RED) |
| AC2 | The **drain path** carries the version the type held at seal | Re-derive via `typeVersionOf` at the drain SHA-verify (`src/worker.ts:732`) and the drain write (`src/worker.ts:783`); the sink omits the field (`worker.ts:479`), so it is re-derived from the genome, not the row | **LAW B** (RED) |
| AC3 | `outputContentHash` folds the real version, so two records of different versions of one type do **not** hash identically — includes the **reuse re-hash** site | Replace hardcoded `domain_type_version: 1` at `src/runtime.ts:2050` with `typeVersionOf` | **LAW C** (RED) |
| AC4 | A type still at v1 produces **byte-identical** records to before this change | The `?? 1` default in `outputs.write()` is untouched; no v1 hash moves | **LAW D** (green guard, frozen hex vector) |
| AC5 | `type_register` still stamps a **new** type as v1 — that site is correct and stays | `src/server.ts:492` left unchanged; a new type genuinely is v1 | **LAW E** (green guard, behavioral) |

## Verification method

Axiomatic / example-based, exercising the **real callsites** end-to-end — no callsite is mocked or
asserted by inspecting a passed argument:

- **LAW A / C / D** drive the primary seal through `composeStandard` + `runGig` (the
  `runtime.ts:2742` path) and read the sealed record back out of the store.
- **LAW B** drives the exported `resumeStateFromDrain` (`src/worker.ts:679`) — the reconstruction
  the drain worker runs — hitting `worker.ts:732` (SHA-verify) and `worker.ts:783` (write). The
  drained row's `content_sha` is the genuine v3 pre-image hash, so a re-hash under the wrong
  version (1) is refused, which is the observable RED.
- **LAW E** drives `dispatchTool`'s `type_register` handler and reads the persisted
  `domain_types/<slug>.json`.

`probe-note` (extends `Signal`, substance floor `source`) is registered at an explicit version so
the registry reports it; the seal data is held constant across every law so a `content_sha`
difference can only come from the version folded into the pre-image.

## Observed red (on `ae7954d`, before any src change)

```
× LAW A/AC1/RED  expected 1 to be 3   (the primary seal defaults domain_type_version to 1)
× LAW C/AC3/RED  'a8cb0e05…' not to be 'a8cb0e05…'  (v1 and v3 records collide — identical hash)
× LAW B/AC2/RED  drain reconstruction refused a v3-sealed row — re-seals to a different content_sha
                 (worker.ts:732 re-hashes with the hardcoded 1, not the genome's 3)
✓ LAW D/AC4      v1 byte-identity holds (frozen vector a8cb0e05…3ecaa37)
✓ LAW E/AC5      type_register persists a freshly created type at version 1
```

The three RED laws fail for exactly the defect the change-request names; the two guards are green by
design — an invariance ("this must NOT move") stated as a RED law would be asserting the wrong
thing, so it is pinned green and turns red only if the fix wrongly moves a v1 hash or touches the
`type_register` site.

## Explicitly examined and left alone

- **`src/server.ts:492`** (`type_register`, `version: 1`) — **CORRECT, unchanged.** `type_register`
  creates a NEW type, which genuinely is v1. LAW E guards it.
- **Backfilling the 9,110 already-sealed outputs** — out of scope; they were sealed at v1, their
  stamp is accurate, and rewriting a sealed record's hash is the one thing an append-only ledger may
  never do.
- **`registry.score()` / reuse enforcement** — an independent defect documented on PR #433.

## Accepted exposure (recorded, not silently re-decided)

The reuse and drain re-hash paths re-derive the **current** genome version via `typeVersionOf`. If a
type is extended *after* a record was sealed, the re-hash uses the newer version — point-in-time
version tracking is out of scope for this change (miles-change-decision-4fe55e0b). A future change
may thread the sealed version through the record if exact historical reproduction is required.
