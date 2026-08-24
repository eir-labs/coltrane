# Red-spec — Genome provenance ships with its repo (WO-F06)

**Change-set branch:** `engine/genome-ledger-ships`
**Requested by:** WO-F06, signed by the sovereign 2026-08-24 (Documenso #1920843)
**Cage:** `src/` and `tests/` only. `.gitignore` and `.github/` are NOT touched.

## The hole this closes

`src/ledger.ts:237` (`defaultLedgerPath`) resolves ONE ledger — `<root>/.coltrane/ledger.jsonl`,
which `.gitignore` excludes — and every `LedgerEntryKind` (`gig`, `genome_mutation`,
`governance`) is written there. `src/genome_writer.ts:40` snapshots prior genome versions to the
equally-gitignored `<root>/.coltrane/history/`. So a genome repo ships its `standards/`,
`domain_types/`, `agents/` files but NOT the seals that give them identity. On a fresh clone every
genome object is an orphan by the engine's own invariant (`src/genome_writer.ts:1-6`: "a
hand-edited file with no ledger entry is an orphan — no identity, outside the substrate").

## Obligations (each an invariant, each with its RED test)

Every test lives in `tests/genome_ledger_ships.test.ts` unless noted. All are RED on the
unmodified engine — observed failures recorded below. Method: example-based integration tests
against the REAL callsites (`FileLedger`, `writeGenomeFileVersioned`, `sealDefinition`, `runCli`),
plus a resolver/property check on the two env-var overrides. `SplitLedger`,
`defaultGenomeLedgerPath` and `detectGenomeOrphans` are referenced through a typed `as unknown as
{…}` shim so the file typechecks under the shared `tsc` build gate while resolving to `undefined`
(→ throw → RED) at runtime today.

### AC1a — genome_mutation seals route to a git-tracked path outside `.coltrane/`
- **Mechanism:** a new `SplitLedger` (implements `Ledger`) constructed from a genome `FileLedger`
  at `defaultGenomeLedgerPath(root)` = `<root>/genome/ledger.jsonl` and a gig `FileLedger` at
  `defaultLedgerPath(root)`. `append()` dispatches by `entry.kind`: `genome_mutation` → the
  genome ledger. Wired at the single confirmed construction seam `bootstrapServerDeps`
  (`src/server.ts:3851`), which already roots both the ledger and `genome_dir` at the same `root`
  (`src/server.ts:3808-3809, 3899`) — so `genome/ledger.jsonl` lands beside the genome files, no
  `.gitignore` edit needed.
- **Callsite:** `src/ledger.ts` (new `SplitLedger`, new `defaultGenomeLedgerPath`); `src/server.ts:3851`.
- **Red test:** `the ledger split routes seals by kind (AC1, AC5) > routes kind=genome_mutation to
  the tracked genome ledger OUTSIDE .coltrane/, and kind=gig to .coltrane/`.

### AC1b — gig rows stay under `.coltrane/`, and reads union both sources
- **Mechanism:** `SplitLedger.append()` routes `gig` (and `governance`, per miles's decision) to
  the gig `FileLedger` at `.coltrane/ledger.jsonl`; `query`/`count`/`integrity` union both files so
  `genome_reload` and existing consumers see every entry.
- **Callsite:** `src/ledger.ts` (new `SplitLedger`).
- **Red tests:** `…routes kind=genome_mutation…` (gig half) and `…reads union both sources, so
  genome_reload and existing consumers see every entry`.

### AC5 — `COLTRANE_LEDGER_PATH` overrides the gig ledger ONLY; the genome ledger gets its own var
- **Mechanism:** `defaultLedgerPath` unchanged (still honors `COLTRANE_LEDGER_PATH`). New
  `defaultGenomeLedgerPath(root?)` returns `COLTRANE_GENOME_LEDGER_PATH` or
  `<root>/genome/ledger.jsonl`. The two overrides do not bleed into each other — required so test
  setup can isolate both ledgers to temp dirs.
- **Callsite:** `src/ledger.ts:237` (unchanged) + new `defaultGenomeLedgerPath`.
- **Red test:** `…COLTRANE_LEDGER_PATH still overrides the GIG ledger only; COLTRANE_GENOME_LEDGER_PATH
  overrides the genome ledger, and neither bleeds`.

### AC2a / AC2b — the orphan detector
- **Mechanism:** new `detectGenomeOrphans(genome_dir, ledger)` in `src/genome_writer.ts` scans
  files under `standards/`, `domain_types/`, `agents/` (skills/ excluded per miles's non-goal),
  derives each file's slug, and returns those with no matching `subject_slug` among the
  `kind=genome_mutation` rows in the genome ledger. A fully sealed dir yields `[]`; an unsealed
  file is returned.
- **Callsite:** `src/genome_writer.ts` (new export); seals produced via the blessed path
  `sealDefinition` (`src/genome_writer.ts:67`).
- **Red tests:** `the orphan detector correlates genome files with their seals (AC2) > a fully
  sealed genome dir yields ZERO orphans` and `> a genome file with no matching seal IS reported as
  an orphan; sealed siblings are not`.

### AC3 — the orphan invariant ships inside `coltrane validate`
- **Mechanism:** in `src/cli.ts` `validate` case, after the existing `genome_reload`/`load_errors`
  check, invoke `detectGenomeOrphans(deps.genome_dir, deps.ledger)` and exit non-zero (naming the
  offending files) when any orphan is found; update `USAGE`. Ships the CI check via `validate` with
  no `.github/` wiring.
- **Callsite:** `src/cli.ts:351-374` (the `validate` case).
- **Red test:** `coltrane validate enforces the orphan invariant (AC3) > exits NON-ZERO and names
  the offender when a loadable genome file has no seal`. Companion GREEN guard `> exits 0 when
  every genome file is sealed` proves a sealed dir still passes (non-regression; the failing dir
  still LOADS, so the non-zero exit can only be the orphan check).

### AC4 — prior-version history snapshots ship with the genome
- **Mechanism:** `writeGenomeFileVersioned` snapshots displaced bytes to
  `<genome_dir>/genome/history/<subdir>/<slug>/<hash>.json` (tracked), not
  `.coltrane/history/…` (gitignored).
- **Callsite:** `src/genome_writer.ts:40-43`.
- **Red tests:** `prior-version history snapshots ship with the genome (AC4) > snapshots a
  displaced version under genome/history/, not .coltrane/history/`, and the updated baseline in
  `tests/genome_write_is_atomic.test.ts:52` (was `.coltrane/history/`, a departure inside the
  tests/ cage per the change-plan step 2).

### AC6 — the cage
Not a runtime invariant but a delivery constraint on the maker's diff: the implementation touches
only `src/` and `tests/`. It is structurally satisfied by the mechanisms above (all seals and
snapshots land at cage-legal tracked paths, so no `.gitignore`/`.github/` edit is required) and is
verified by `git diff --name-only` at seal time, not by a runtime assertion — recorded here so it
is not mistaken for an uncovered behavioral invariant.

## Observed RED (run: `npx vitest run tests/genome_ledger_ships.test.ts tests/genome_write_is_atomic.test.ts`)

```
FAIL  AC1 routes kind=genome_mutation …            TypeError: SplitLedger is not a constructor
FAIL  AC1 reads union both sources                 TypeError: SplitLedger is not a constructor
FAIL  AC5 overrides do not bleed                   TypeError: defaultGenomeLedgerPath is not a function
FAIL  AC2a fully sealed dir yields ZERO orphans    TypeError: detectGenomeOrphans is not a function
FAIL  AC2b unsealed file IS an orphan              TypeError: detectGenomeOrphans is not a function
FAIL  AC3 exits NON-ZERO on unsealed genome file   AssertionError: expected 0 to be 1
FAIL  AC4 snapshots under genome/history/          AssertionError: expected false to be true
FAIL  genome_write_is_atomic overwrite baseline    ENOENT: …/genome/history/domain_types/note
PASS  AC3 exits 0 when every genome file is sealed (non-regression guard)
```

The tests are RED by design: the enforcement they demand does not exist yet. That is the point.

## Inherited tree

`git status --porcelain` at the start of this run was EMPTY — nothing inherited, nothing left
alone. The captured diff is exactly the three paths this run wrote.
