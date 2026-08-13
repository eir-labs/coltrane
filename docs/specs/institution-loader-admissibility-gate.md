# Spec — the institution loader, and the admissibility gate on it

Status: RED spec (tests fail because the reader and the gate-call are absent).
Base: `feat/coltrane-enforces-its-laws` / PR #335 (four-valued evaluator + `checkInstitutionAdmissibility`, green).
Scope: make Coltrane's own enforcement **invoked** rather than merely available — one level up, in the
enforcement mechanism itself.

## The defect

PR #335 shipped a working s-expression evaluator and `checkInstitutionAdmissibility`, plus a CI gate
asserting every document in `institutions/` is admissible. But `institutions/` **has no loader**:
`src/loader.ts` never reads it, `LoadedGenome` carries no institutions, and the gate is invoked
**only by tests**. CI catches a bad document at merge; nothing catches one at load, nothing checks a
document arriving from the org store, and nothing will check one authored through a future
`institution_define`. That is the same defect class the enforcement work was built to close —
*modelled, never invoked* — turned on the enforcement mechanism itself. (Independently reached from
the store side by `dashboard-sketch/docs/11-studio-institution-seam.md` §5.2: "the right vocabulary
and not yet a mechanism.")

The fix is exactly a **reader** and a **call**. Every section schema already exists in the one Zod
source (`src/genome_schema.ts`); the gate is already a green pure function; `system_health` already
surfaces `load_errors`.

## ITEM 1 — load institutions

`loadGenome` reads `institutions/*.json` as multi-section documents (shape per
`institutions/quartet.json`: `{institution, organizations?, agent_records?, org_members?, chairs?,
assignments?, forebears?, lineage_edges?, northstars?}`).

- **Mechanism.** `src/institution_loader.ts` → `loadInstitutions(root)` (shipped here as a
  throwing seam) reads the directory, validates **each present section** loss-free against its
  already-authored per-section schema (`InstitutionSchema`, `OrganizationSchema`,
  `AgentRecordSchema`, `InstitutionalChairSchema`, `ChairAssignmentSchema`, `ForebearSchema`,
  `NorthstarSchema`, `LineageEdgeSchema`). An **absent optional section is empty, not an error.**
- **Validation is section-by-section** against the existing schemas (the
  `tests/default_genome_quartet.test.ts:107-119` precedent). No composite `InstitutionDocumentSchema`
  is added — the one-Zod-source discipline stays intact with the smallest new surface. `LoadedInstitution`
  (`src/institution_loader.ts`) is a carried view, not a validator.
- **Callsite / ordering.** The reader is wired into `loadGenome` **after** the agents, standards,
  venues, charts and organization maps are built — institutions reference agents/standards/orgs, so
  their reader sits after those blocks exactly as venues load before charts (`src/loader.ts:447-449`).
- **`LoadedGenome` carries it.** A new `institutions` field (`src/loader.ts`; optional on the interface
  so the out-of-scope store backing need not carry it yet, always populated by `loadGenome`). This is
  the field that gives `institutions/` its first reader in `src/`.

### Malformed / invalid reporting — soft-fail per file

Follows the loader's own two-tier idiom (`core_types/` hard-fails; every definition class soft-fails
per file into `load_errors`). `LoadError.kind` gains `"institution"` (`src/loader.ts:61`). A
malformed-JSON file or a schema-invalid section becomes **one `institution` load_error and that
document drops out**; the rest of the genome loads. It never throws and aborts the whole load —
hard-failing would let one bad document DoS every other class (grounded in the loader idiom, OPA's
all-or-nothing-**per-bundle** activation, and Kubernetes fail-closed-**per-object** admission). A
duplicate institution slug fails closed on the collision (record the later one as a load_error; keep
the first).

`institution` load_errors reach the operator through the existing `system_health` `load_errors`
channel (`src/server.ts:1606,1720`) with no new plumbing; `bootstrapServerDeps` threads the field the
same way it threads `venues`/`charts` (`src/server.ts:3216-3218`).

## ITEM 2 — the gate moves from CI to the load path

`checkInstitutionAdmissibility` (`src/institution_enforcement.ts:450-458`) is invoked on the load path
for every schema-valid document.

**Refusal at load — the chosen meaning, defended.** An inadmissible institution **fails closed: it
does NOT enter `LoadedGenome.institutions`, and its offenders are recorded as an `institution`
load_error; the rest of the genome loads.**

Rejected alternatives and why:

- *Whole-genome hard-fail* — REJECTED. One overclaiming document would take down every other class;
  it inverts the loader's own soft-fail-per-file law and OPA's per-bundle (not per-server) granularity.
- *Load-with-a-warning (still in the map)* — REJECTED. A reader downstream would trust a document the
  gate refused; this is the exact "modelled, never invoked" trust gap the change closes. Fail closed,
  as `evaluate` fails closed on a `DEAD_NAME` (`src/institution_enforcement.ts:28-30,293-297`), mirrors
  Kubernetes admission rejecting an object **before** it is persisted.

The CI gate (`tests/institution_admissibility_gate.test.ts`) **stays** as the merge-time guard; the
load gate is the runtime one. A differential invariant pins the two enforcement points to one
predicate so they cannot drift, and both shipped documents pass admissibility as of commit `9259298`,
so the gate turns on **and** every shipped file loads unchanged.

## ITEM 3 — the two adjacent dead limbs are INDEPENDENT gaps (out of scope)

Read the code; both are (b) independent gaps, not wired by loading institutions:

- **`InstitutionalChairSchema.supplies`** (`src/genome_schema.ts:610`) is a **distinct field** from the
  standard phase-chair `ChairSchema.supplies` (`src/genome_schema.ts:161`) that `composition.ts:329`
  reads at compose time for skill hydration. Reading the *institutional* one requires a SEAT-time
  engine (`ChairAssignment` → seated-agent hydration) that **does not exist in `src/`**. Loading
  institutions is a prerequisite, not the wiring. Out of scope.
- **`DispatchCapGrantSchema`** (`src/genome_schema.ts:584`) has exactly two hits in `src/`, both in
  `genome_schema.ts` (the definition and its inclusion in the `CapGrantSchema` union at `:591`) —
  **zero call sites**. Dispatch authorization on the file backing does not consult institutional caps;
  a dispatch-time authz check reading loaded caps is separate work. Out of scope.

## ITEM 4 — the seam to the store (shape only)

`GenomeStore.GenomeClass` (`src/genome_store.ts:43`) gains an `"institution"` member. The store row is
the **same `{slug, definition}` envelope** charts and venues already use
(`src/genome_store.ts` PostgREST selects `coltrane_charts?select=slug,definition` /
`coltrane_venues?select=slug,definition`), where `definition` **is** the multi-section file document
validated through the same section gates the loader runs — so file and store backings cannot drift.
The institution select is `coltrane_institution?select=slug,definition`.

**Not built here:** the store backing, `institution_define`, `institution_browse`. An institution
written to the store before the runtime admissibility bar exists is a row that cannot later clear it,
and the hosted half is queued behind a Supabase integration this repo does not own.
`institution_browse` is owed as a **pair** with `institution_define` the moment either exists
(discoverability parity, `tests/genome_browse_parity.test.ts:44-62` — the parity table gains a seventh
row); they ship together or not at all.

## Acceptance / red tests

Every contract invariant has a real failing assertion in the working tree, failing because the reader
and the gate-call are absent — not because a file fails to typecheck. The compile seam is the empty
`institutions` map in `loadGenome` plus the throwing `loadInstitutions` signature, exactly as
`src/institution_enforcement.ts` shipped its seam. Coverage:

- `tests/institution_loader.test.ts` — INV1, INV4, INV5, INV6, INV7, INV8, INV13, INV14.
- `tests/institution_load_gate.test.ts` — INV2, INV3, INV9, INV10, INV11.
- `tests/institution_store_seam.test.ts` — INV12.

Method: property-based + metamorphic (`fast-check`, already a dependency) for the universal properties
(totality, admissibility-load agreement, per-document isolation, additive-monotone, collect-all) and a
differential test pinning the CI gate to the load gate; example/structural assertions for the shipped
documents, load ordering, `LoadError` representability, and the store envelope.

Untouched (pinned behaviour this builds on): `tests/institution_admissibility.test.ts`,
`tests/institution_law_evaluator.test.ts`, `tests/institution_additive_invariance.test.ts`,
`tests/institution_admissibility_gate.test.ts`.
