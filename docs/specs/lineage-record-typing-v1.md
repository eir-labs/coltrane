# Spec — lineage-record-typing-v1

**Subsystem:** the lineage record is the least-typed artifact in the pipeline that produces it.

## The defect, and the reflexive irony

`lineage-pass-v1` was dispatched twice. The first sealed lineage-record `03cacf6a`, whose every
connection carried a per-edge grounding **strength** in prose — one edge "fully — dereferenceable
internal citation on both sides", eight "conceptual — schema structure, no internal citation". That
asymmetry was the single most useful fact in the record. The second sealed `c2000367` with
`grounded: None` on all nine connections. Same standard, same seat, different rigour, and **nothing
checked either way**.

The cause is not a lazier scribe. `domain_types/lineage-record.json` declares `external_body`,
`internal_inventory`, and `connections` as bare `{"type":"array"}` — no item shape. A record can
seal `connections: [1,2,3]`. Yet `domain_types/lineage-map.json` **one phase upstream** is fully
specified: its edges require `internal_ref`, `external_ref`, a closed-enum `relation`,
`grounding_internal`, and `grounding_external`, `minItems 1`. The pipeline is **enforced at the
weaver and declared at the scribe**. The map cannot hold an ungrounded edge; the published record it
composes into can hold anything — in the very instrument this repo has been using all day to find
declared-tier defects elsewhere. That is the point, not a joke.

## What ships

A tightening of the SCRIBE's published type to the WEAVER's bar, plus a closed-vocabulary grounding
strength neither type carried, plus a seal-boundary check that turns the standard's composition
promise into enforcement — without making the 10 v1 records retroactively invalid.

No new field is invented outside these; the phase structure of `lineage-pass-v1` / `lineage-deepen-v0`
/ `lineage-reweave-v0` is untouched. This is a type-and-seal change.

## The fix splits along what JSON Schema can express

Items 1 & 3 are **pure schema authoring, zero engine code**: `src/registry.ts:240` compiles each
domain type's schema with Ajv (`strict:false`, closed-by-default `additionalProperties`) and enforces
it at the one seal boundary, `src/outputs.ts:567` (`registry.validate` inside `checkWritable`, inside
`write()`). Adding `items` + `required` + `enum` makes the loose cases unseal-able automatically.

Item 4 is the part JSON Schema **cannot** reach — a cross-input referential predicate — and needs
engine code plus a signature change.

## Obligations → mechanism → callsite → red test

### O1 — the connection item meets or exceeds lineage-map's edge
`connections` becomes an array (`minItems 1`) of objects requiring `internal_ref`, `external_ref`,
`relation` ∈ {`descends-from`,`aligns-with`,`diverges-from`,`supersedes`,`informed-by`},
`grounding_internal`, `grounding_external`; `additionalProperties:false`.
- **Mechanism:** author the item schema in `domain_types/lineage-record.json`; Ajv enforces at
  `src/outputs.ts:567`.
- **Red tests:** `I1` (`connections:[1,2,3]` throws), `I2` (property: drop any required field / any
  out-of-enum relation → throws) in `tests/lineage_record_typing.test.ts`.

### O2 — a REQUIRED per-edge grounding strength from a CLOSED ordinal vocabulary
Each connection requires `strength` ∈ a closed, ordinal set. Each value exists for a reason:

| value | grounds on | why it exists |
|---|---|---|
| `dereferenceable-both-sides` (highest) | an internal citation dereferenceable on **both** endpoints | the only tier a governor can mechanically verify by following both citations |
| `structural-correspondence` (middle) | shared schema / structure, no dereferenceable citation | distinguishes a checkable-in-principle structural alignment from a bare analogy |
| `conceptual-analogy` (lowest) | conceptual / semantic correspondence only | marks the weakest edge a sweep should surface **honestly** rather than silently drop |

This reproduces exactly the `03cacf6a` "fully" vs "conceptual" distinction, but filterable,
comparable across passes, and impossible to omit. Free prose and omission are unrepresentable.
- **Mechanism:** `enum` + `required` on the connection item.
- **Red test:** `I3` (missing strength throws; `strength:"fully"` free prose throws; property: legal
  values seal, out-of-vocab refuse) in `tests/lineage_record_typing.test.ts`.

### O3 — grounding strength is SEPARATE from `CitationSchema.evidence_grade`
They are orthogonal. `evidence_grade` ∈ {`archive`,`attestation`} grades the **source's fetch status**
(`src/genome_schema.ts:293-309`, "never laundered upward"). Grounding strength grades the **edge's
firmness**. Both endpoints can be `archive`-grade while the edge between them is a loose conceptual
analogy — W3C PROV-DM ships a closed relation vocabulary and deliberately carries **no** edge
confidence, keeping quality assessment external to the relation. Collapsing them is the obvious future
"simplification" and would destroy the distinction that made `03cacf6a` legible.
- **Mechanism:** `strength` is authored on the connection edge, never as `evidence_grade`; the field
  carries a `$comment` forbidding the merge and citing `src/genome_schema.ts:293-309`.
- **Red test:** `I4` (the item declares `strength` with the closed enum and NOT `evidence_grade`; the
  `$comment` names `evidence_grade`, "orthogonal", and `genome_schema.ts`) in
  `tests/lineage_record_typing.test.ts`.

### O4 — external_body is typed with a closed status vocabulary
Each entry requires a `source`, a `status` ∈ {`reached`,`not-reached`}, and a `note`;
`additionalProperties:false`. `reached` marks a body that produced a lineage-hit; `not-reached` exists
so a named-but-unreached sweep boundary cannot hide as prose or be silently omitted — the honest half
of both records.
- **Mechanism:** item schema + closed `enum` in `domain_types/lineage-record.json`.
- **Red test:** `I5` (property: only the two values seal; missing status throws) in
  `tests/lineage_record_typing.test.ts`.

### O5 — internal_inventory is shaped
Each entry requires a `reference` (a locator another chair can be held to), mirroring
`domain_types/internal-inventory.json`'s `representations` item; `additionalProperties:false`.
- **Mechanism:** item schema in `domain_types/lineage-record.json`.
- **Red test:** `I6` (an entry missing `reference` throws) in `tests/lineage_record_typing.test.ts`.

### O6 — composition fidelity as a CHECK, not a hope
`connections(record) ⊆ edges(consumed lineage-map)` and every `external_body` entry is EITHER
(`status:reached` AND corresponds to a lineage-hit) OR `status:not-reached`. Nothing else is
admissible.
- **Mechanism:** a seal-boundary referential check. `checkWritable` (`src/outputs.ts:515,638`) today
  receives only `{core_type, domain_type, data}` and never sees `input_refs`, so it cannot resolve the
  consumed map/hits via `outputs.get()`. **Thread `input_refs` into the gate**; resolve the predecessor
  `lineage-map` (the associate output) and `lineage-hit` records (the identify-external outputs — the
  scribe's compose chair `depends_on` both, `standards/lineage-pass-v1.json:69`); reject any connection
  triple absent from the map, and any `reached` source absent from the hits. An unresolvable input map
  for a record that declares connections **fails closed** (dead-reference discipline), it does not skip
  the check.
- **Red tests:** `I7` (invented edge against a real input map → throws; control with all edges present
  → seals), `I8` (reached source absent from hits → throws; same body marked not-reached → seals;
  control reached-and-backed → seals) in `tests/lineage_composition_fidelity.test.ts`.

### O7 / I9 — the weaver draws the strength; the scribe carries it through
`strength` is `required` on lineage-map's edge item too (`domain_types/lineage-map.json`), and the
record's carried strength must equal the drawing edge's strength. The seat that draws the edge is the
seat that knows how firmly.
- **Mechanism:** add `strength` (`enum` + `required`) to lineage-map's edge; extend the O6 check with
  a strength-equality predicate on each matched edge.
- **Red tests:** `I9` static half (map edge requires the closed-enum `strength`) in
  `tests/lineage_record_typing.test.ts`; `I9` composition half (carried strength ≠ matched edge →
  throws; equal → seals) in `tests/lineage_composition_fidelity.test.ts`.

### O8 — version bump, and v1 records stay readable
Bump `lineage-record` to **version 2**. Validation is write-time only: `hydrateGig`
(`src/outputs.ts:593-607`) reads rows with **no** re-validation, and `domain_type_version` (default 1,
`src/outputs.ts:640`) is folded into `content_sha` (`src/outputs.ts:653`), so the 10 v1 records and 2
verdicts stay readable, traceable, and hash-stable automatically. They are historical fact and are
**not** held to the v2 bar — stated here explicitly, not left to inference.
- **Red tests:** `I10` (the type is version 2; a reproduced `03cacf6a` / `c2000367` v1 record — loose,
  prose-grounded, invalid under v2 — still hydrates and reports `domain_type_version:1`), `I11` (both
  verdicts hydrate; `lineage-verdict` stays version 1) in `tests/lineage_record_migration.test.ts`.
  See the caveat there: real sealed bytes live in the org store, not this repo tree, so the fixtures
  reproduce the two documented records.

### O9 / I12 — the spec compiles and the genome loads unchanged
The meta-invariant: this change adds test files and this doc, and edits only the two domain-type JSON
files and the seal boundary. Every shipped genome file must still load with zero `load_errors` so that
every RED above comes from an absent-enforcement assertion, never a type error.
- **Red test (green-by-design guard):** `I12` (`loadGenome` reports zero `load_errors`; the lineage
  pass + its four types are present; the registry reconstitutes without throwing) in
  `tests/lineage_record_migration.test.ts`.

## Out of scope

Re-running any lineage pass; redesigning the phase structure of the three lineage standards;
retroactively rewriting sealed records; any change to in-flight branches
(`spec/turn-budget-contract`, `spec/coltrane-enforces-its-laws`, `spec/changeset-branch`,
`tour/booking`); `genome-view.html`.

## Note on execution

The red-spec-drafter seat holds `Read`/`Glob`/`Grep`/`Write`/`Edit` and `git add|diff|status` only —
not a build/test grant. These tests are authored to COMPILE (imports and types match the existing
`tests/domain_type_validation.test.ts` and `tests/bootstrap_genome.test.ts` conventions) and are RED
by construction per the reasoning above, but were not executed in this run. The implementer runs
`npm run build` before sealing, per the acceptance bar; red must come from the assertions, never a
type error.
