# Red-spec — `coltrane seal-genome`, the bulk-seal primitive (WO-F07 Article I)

**Change-set branch:** `engine/seal-genome-command`
**Requested by:** WO-F07 (Seal the nomos canon + upstream the naming ritual), signed 2026-08-24,
Documenso #1922537 — Article I.
**Cage:** `src/` and `tests/` only. The command REUSES `sealDefinition` / `genome_writer`; it does
not reimplement sealing, touch the WO-F06 ledger split, or change the orphan detector.

## The hole this closes

The WO-F06 orphan invariant (`coltrane validate` fails on a `standards/|domain_types/|agents/` file
with no `genome_mutation` seal in the tracked genome ledger) has no MIGRATION primitive. A
pre-sealing genome — every file hand-authored or predating the sealed regime — is all orphans, and
there is no command to bring it in-regime in bulk. `seal-genome` is that primitive: it iterates the
blessed write path over every genome file and, for each not-already-sealed file, records its
`genome_mutation` seal. It seals IDENTITY; it does not rewrite content.

## Method

Example-based integration laws against the REAL callsites — `sealDefinition` (the blessed write
path, `src/genome_writer.ts:69`), `detectGenomeOrphans` / `ORPHAN_SCAN_SUBDIRS`
(`src/genome_writer.ts:237,255`), `FileLedger`/`MemoryLedger`/`defaultGenomeLedgerPath`
(`src/ledger.ts`), the canonical-identity functions (`src/canonical_form.ts`), and `runCli`/`USAGE`
(`src/cli.ts`). No property-based engine is warranted: every invariant is a specific behavior of a
concrete command over a concrete genome tree, not a universal algebraic property, so example-based
fixtures against the real substrate are the honest fit (grounding: the WO-F06 sibling suite
`tests/genome_ledger_ships.test.ts` verifies the same substrate example-based).

`sealGenome` lands in a NEW module `src/seal_genome.ts`, which does not exist yet — so the repo's
`as unknown as {…}` shim idiom (which needs the module to exist) does not apply. Instead the maker's
export is referenced through a **runtime-variable dynamic import** (`await import(SEAL_GENOME_MODULE)`
where the specifier is a `const string`, not a literal). A non-literal specifier types as `any`, so
the shared `tsc` gate stays green (verified: `tsc --noEmit` clean), while at runtime today the import
rejects with `Cannot find module '../src/seal_genome.js'` — the RED. The CLI laws bind to the real
`runCli`/`USAGE`, which exist, so they go RED on genuine assertions (exit `2`≠`0`; `USAGE` omits the
command).

### Contract the maker must satisfy

`sealGenome(genome_dir: string, ledger: Ledger): { sealed: string[]; skipped: string[]; errors:
Array<{ path: string; error: string }> }`.

**Rationale for the return shape (a non-obvious choice):** `sealed` and `skipped` are
genome-relative PATHS, not bare counts. bill's plan says "counts"; this red-spec pins arrays because
(a) the CLI needs both the count (`.length`) for its stderr summary and the names for a per-file
report, and (b) the slug-fold law must assert WHICH file was skipped — a bare integer cannot express
that. Per-file `errors` make the loop fault-tolerant (miles risk-2): a malformed / non-canonicalisable
file is reported without aborting the remaining files.

## Obligations (each an invariant, each with its RED test)

All tests live in `tests/seal_genome.test.ts`. Observed RED failures are recorded under each.

### INV-SEAL-ALL (AC1) — seal every file through the blessed path, keyed by the per-kind event
- **Mechanism:** iterate `ORPHAN_SCAN_SUBDIRS` (`["standards","domain_types","agents"]`, imported —
  not re-declared) reading every `.json` file; for each not-already-sealed file call `sealDefinition`
  with the parsed def, the kind-appropriate event (`standard_compose` / `type_register` /
  `agent_define` — the MCP-tool-name convention `sealDefinition` already uses), and the subdir name.
  The seal's `content_hash` is `sha256Hex(canonJson(parsed))` — the same value the idempotency check
  matches on, proving the blessed path (which writes the file AND the seal) was used, not `recordIdentity`.
- **Callsite:** new `src/seal_genome.ts`; reuses `sealDefinition` (`src/genome_writer.ts:69`).
- **Red test:** `…(INV-SEAL-ALL) > appends a genome_mutation seal for every file …, keyed by the
  per-kind event`. **Observed RED:** `Cannot find module '../src/seal_genome.js'`.

### INV-BYTES (AC2, AC5) — content byte-unchanged; only the ledger changes
- **Mechanism:** `sealDefinition` re-serializes the PARSED object as `JSON.stringify(def, null, 2) +
  "\n"`. For a genome already in that on-disk form, `writeGenomeFileVersioned` writes byte-identical
  content and takes no history snapshot (john claim 10). The test snapshots every file's bytes,
  runs `sealGenome`, and asserts each file's parsed content AND raw bytes are identical, and that no
  `genome/history/` snapshot was written. Fixtures are authored in the blessed serialization so
  byte-identity is a real invariant, not a formatting artifact.
- **Callsite:** new `src/seal_genome.ts`; `writeGenomeFileVersioned` unchanged.
- **Red test:** `…(INV-BYTES) > every file's bytes AND parsed content are identical after a full run
  …`. **Observed RED:** `Cannot find module '../src/seal_genome.js'`.

### INV-IDEMPOTENT (AC3) — a second run seals nothing already sealed
- **Mechanism:** a file is already-sealed when a `genome_mutation` entry for its base slug carries a
  matching `content_hash`; such files are skipped. First run seals N, skips 0; second run seals 0,
  skips N, and appends NO new ledger entries (`ledger.count({kind:"genome_mutation"})` unchanged).
- **Callsite:** new `src/seal_genome.ts` (skip logic); `ledger.query`/`count` unchanged.
- **Red test:** `…(INV-IDEMPOTENT) > first run seals N and skips 0; second run seals 0 and skips N,
  adding no new ledger entries`. **Observed RED:** `Cannot find module '../src/seal_genome.js'`.

### INV-FOLD (miles risk-3) — the slug@vN fold matches detectGenomeOrphans exactly
- **Mechanism:** the skip check folds `subject_slug` via `split("@")[0]` before matching the base
  slug — identical to `detectGenomeOrphans` (`src/genome_writer.ts:260`). A file `evo.json` sealed
  only under `evo@v2` (as `agent_evolve` records it) matches the fold and its `content_hash`, so it
  is skipped, never re-sealed. Verbatim matching would re-seal it and break idempotency.
- **Callsite:** new `src/seal_genome.ts` (the fold).
- **Red test:** `…(INV-FOLD) > an agent_evolve seal recorded at subject_slug='evo@v2' covers
  agents/evo.json …`. **Observed RED:** `Cannot find module '../src/seal_genome.js'`.

### INV-ORPHAN-CLOSURE (AC4) — orphans before, none after
- **Mechanism:** after a complete run every scanned file carries a seal keyed by its base slug, so
  `detectGenomeOrphans(genome_dir, ledger)` returns `[]`. The test asserts orphans are non-empty on
  the unsealed fixture (precondition) and `[]` after the run (the closure).
- **Callsite:** new `src/seal_genome.ts`; `detectGenomeOrphans` unchanged.
- **Red test:** `…(INV-ORPHAN-CLOSURE) > detectGenomeOrphans is non-empty on the unsealed fixture and
  returns [] after a full run`. **Observed RED:** `Cannot find module '../src/seal_genome.js'`.

### INV-VALIDATE (AC4) — `coltrane validate` passes against the sealed canon
- **Mechanism:** `seal-genome` writes seals to `defaultGenomeLedgerPath(genome_dir)`, the same ledger
  `coltrane validate` reads via `deps.ledger`. On a loadable genome, after sealing, the genome ledger
  holds 3 seals (so validate's orphan gate actually FIRES, not skips), `detectGenomeOrphans` is `[]`,
  and `validate` exits 0; a second `seal-genome` adds no seals.
- **Callsite:** new `src/seal_genome.ts` + `src/cli.ts` (the switch case); `validate` unchanged.
- **Red test:** `…(INV-CLI, INV-VALIDATE) > seals a loadable genome, then coltrane validate passes
  and a second seal-genome seals nothing`. **Observed RED:** `expected 2 to be 0 — unknown command
  "seal-genome"` (the command is not in `KNOWN`).

### INV-CLI — `seal-genome` is a documented, dispatchable command
- **Mechanism:** `seal-genome` is added to `KNOWN` (`src/cli.ts:205`) and `USAGE` (`src/cli.ts:45`),
  with a `runCli` case that resolves `genome_dir` from argv (default cwd), constructs minimal deps
  (`new FileLedger(defaultGenomeLedgerPath(genome_dir))`), calls `sealGenome`, emits counts to
  stderr, and returns exit 0 when every file is sealed-or-skipped (exit 1 on any per-file error).
- **Callsite:** `src/cli.ts` (`KNOWN`, `USAGE`, the new case).
- **Red test:** `…(INV-CLI, INV-VALIDATE) > is a documented, known command — USAGE names it and
  runCli does not reject it as malformed`. **Observed RED:** `USAGE … expected to contain 'coltrane
  seal-genome'` and, for the empty-dir dispatch, `expected 2 to be 0`.

## AC6 — containment (no change outside `src/` and `tests/`)

This is a diff-scope obligation on the MAKER's change, verified when the maker's diff is reviewed
(files_touched: `src/cli.ts`, `src/seal_genome.ts`, `tests/seal_genome.test.ts`), not a runtime
assertion — a vitest law cannot honestly witness "no file outside the cage changed". It is recorded
here so the coverage is not silently dropped; the red-spec's own captured diff touches only
`tests/seal_genome.test.ts` and this doc under `docs/specs/`.

## Inherited tree

`git status --porcelain` was EMPTY at the start of this run — nothing was inherited, so everything in
the captured diff is this run's own work.
