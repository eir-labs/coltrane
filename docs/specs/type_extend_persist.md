# Spec: `type_extend` must persist, not merely acknowledge

**Gig** `0d2f156b-4521-4d29-8030-f099ae347724` · **Direction** PERSIST (miles-decision-0d2f156b) · **Plan** bill-plan-0d2f156b

## The defect (reproduced)

`type_extend` acknowledges a mutation it never performs. Calling it on a real type — adding one
optional field — returns `{ ok:true, new_version:2, content_hash, effective_hash }`, yet the
on-disk record stays version 1 without the field and `git status` reports the directory
unmodified. The caller has been told a version exists that exists nowhere on disk, and the
ledger now carries a `genome_mutation` row for a definition the genome does not hold.

**Callsite.** `src/server.ts:1582-1624`, the `type_extend` handler. It validates the merge
(`domainTypeDefect`), computes the next version (`proposeTypeChange`), then:

```
// substrate seal: the new version's identity is recorded in the ledger (file
// materialization of versioned types follows the version-aware loader path).
const versioned = { ...next, version: proposal.next_version };
const tx = deps.genome_dir ? recordIdentity("type_extend", `${base.slug}@v${proposal.next_version}`, versioned, deps.ledger, ...) : undefined;
```

`recordIdentity` (`src/genome_writer.ts:111`) appends a ledger row and writes **no file**. The
deferral names a "version-aware loader path" that does not exist: the loader indexes by
`slug@version` from file **content** (`src/loader.ts:283`), and there are zero `@v` files in
`domain_types/`. The sibling handler `type_register` (`src/server.ts:477-495`) does it right —
`sealDefinition` (file + ledger) then `registerType`.

## The obligation, per invariant

The chosen direction is **PERSIST**: materialize the extended definition exactly as
`type_register` does. The loader resolves an in-place overwrite of `domain_types/<slug>.json`
carrying version 2 with today's code (`DomainTypeMap.get(slug)` returns the highest-version
record, `src/loader.ts:35-43`), so no new infrastructure and no `@v` filename is needed.

| # | Invariant | Mechanism / callsite | Red law |
|---|-----------|----------------------|---------|
| I1 (AC1) | After `ok:true`, a fresh genome load resolves the type with the new field at the bumped version. | Replace `recordIdentity` with `sealDefinition("type_extend", slug, def, ledger, genome_dir, "domain_types", ...)` — writes `domain_types/<slug>.json` via `writeGenomeFileVersioned`. | `AC1/RED` |
| I2 (AC3) | The on-disk `domain_types/<slug>.json` carries the bumped version and the added field. | Same `sealDefinition` write (SEAL BEFORE WRITE). | `AC3/RED` |
| I3 (AC2) | Every `genome_mutation` row sealed by `type_extend` corresponds to a file loadable at the version the row claims — the ledger never asserts what the genome does not hold. | `sealDefinition` appends the ledger row **and** writes the file in one operation; no row without a file. | `AC2/ledger/RED` |
| I4 (AC4) | `type_register` still persists a loadable file and resolves on fresh load — unchanged. | No change to `type_register`; guard pins it. | `AC4/GUARD` |
| I5 (AC5) | The persist path introduces no unresolvable `@v` filename; it overwrites `<slug>.json` in place, whose resolution I1 proves. | `writeGenomeFileVersioned` keys the filename by bare slug; version lives in content. | `AC5/GUARD` |

Additionally the fix must add `deps.registry.registerType(def)` (as `type_register` does at
`src/server.ts:490`) so the extended type is resolvable in the same server session, not only
after reload — covered observationally by I1 for the on-disk path.

## Acceptance gates (process, not in-file laws)

- **AC6** — `npx tsc --noEmit -p tsconfig.json` exits clean (verified this run) and the full
  suite stays green (2863 on main); the three RED laws flip to green when the fix lands, and
  `tests/ledger_event_records.test.ts` (the `type_extend` → `genome_mutation` row) stays green.
- **AC7** — the PR states plainly that PERSIST was chosen over REFUSE, grounded in the loader's
  present content-keyed `slug.json` resolution.

## Laws

All laws live in `tests/type_extend_persist.test.ts` and drive the **real** `dispatchTool`
handlers against a temp `genome_dir`. `type_register` seeds the base type through the working
door; `type_extend` adds an optional `index_revision` field (the field PR #424's law I10 needs,
the motivating case). On unmodified `main` (c203968): I1/I2/I3 are RED — their failure output is
the reproduction ("ledger sealed genome_mutation subject `change-context@v2` claiming version 2,
but a fresh load resolves version 1"); I4/I5 are GREEN guards.
