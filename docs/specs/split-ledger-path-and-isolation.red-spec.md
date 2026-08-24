# Red-spec — Restore the split ledger's single path and honor the isolation override (WO-F06 fix)

**Change-set branch:** `genome-ledger-fix-isolation`
**Requested by:** WO-F06 (Genome provenance ships with its repo), signed #1920843 — CI regression of PR #513
**Cage:** `src/ledger.ts` and `src/server.ts` (the fix). This red-spec adds one test file under
`tests/` and this doc under `docs/specs/`; it touches no other tree, and it does NOT edit
`tests/bootstrap_root_isolation.test.ts` (the standing RED spec) or reddening
`tests/genome_ledger_ships.test.ts` (the standing GREEN split spec).

## The hole this closes

The WO-F06 ledger split (`bb283e2`) introduced `SplitLedger` (`src/ledger.ts:587`) and wired it at
the single production construction seam `bootstrapServerDeps` (`src/server.ts:3808`). The routing
design is correct and unchanged. Two contract invariants regressed:

1. **`SplitLedger.integrity().path` returns a CONCATENATION** — `src/ledger.ts:630` joins both
   backing paths with `" + "`: `[g.path, r.path].filter(p => p.length > 0).join(" + ")`. But
   `LedgerIntegrityReport.path` (`src/ledger.ts:181`) is a SINGLE ledger path — it lands verbatim in
   an MCP `system_health` response an operator reads (`tests/integrity_surfaced.test.ts:254-257`
   argues exactly this for the `path` field). A joined string is not a path.

2. **The genome ledger does NOT follow the isolation override.** `bootstrapServerDeps` computes
   `root = genomeRoot ?? process.env.COLTRANE_GENOME ?? process.cwd()` (`src/server.ts:3809`) and
   builds `new FileLedger(defaultGenomeLedgerPath(root))` (`src/server.ts:3860`). When
   `COLTRANE_LEDGER_PATH` relocates the gig ledger but no `genomeRoot`/`COLTRANE_GENOME` is set,
   `root` falls back to `process.cwd()`, so the genome ledger resolves to the **real checkout's**
   `genome/ledger.jsonl` — leaking outside the isolation root. Observed live: the unrooted-bootstrap
   law below received `/Users/…/coltrane-lineage/genome/ledger.jsonl + <override>`.

`tests/bootstrap_root_isolation.test.ts` catches the leak only via `integrity().entries` (Test 1),
which is silent when the checkout's own `genome/ledger.jsonl` is empty — as it is on this branch, so
that assertion is currently GREEN and the leak is latent. This red-spec proves the leak
**deterministically**, independent of checkout state, by seeding a uniquely-slugged seal in the
override's sibling genome ledger and demanding the bootstrap read THAT file — writing nothing into
the real tree.

## Method

Example-based integration tests against the REAL callsites — the concrete `SplitLedger`
(`src/ledger.ts:587`) and the single production seam `bootstrapServerDeps` (`src/server.ts:3808`).
No typed shim is needed: every symbol already exists on the split engine; the enforcement these laws
demand — a single path, and a genome ledger that follows the override — is what does not exist yet.
The shared `tsc --noEmit` build gate is part of the run (it caught a real narrowing bug during
authoring); the genome-arm read is narrowed with the repo's `as GenomeMutationLedgerEntry` idiom, as
`tests/genome_ledger_ships.test.ts` does. All four correction laws are RED on the unmodified split;
the two guards are GREEN and must STAY green through the fix.

## Obligations (each an invariant, each with its test)

All tests live in `tests/split_ledger_path_and_isolation.test.ts`.

### INV-INTEGRITY-PATH-SINGLE — `integrity().path` is one ledger path, never a concatenation
- **Mechanism:** `SplitLedger.integrity()` (`src/ledger.ts:625`) must return `path: r.path` (the gig
  ledger's resolved path), not the `" + "`-joined string. `ok`, `entries` (union sum), and `corrupt`
  (union) stay as-is so health reporting remains complete. No genome-path field is added to
  `LedgerIntegrityReport` and no `genomeIntegrity()` method is introduced — no caller requires either.
- **Callsite:** `src/ledger.ts:630`.
- **RED tests (3):**
  - `returns the gig ledger's resolved path even when both backing ledgers hold entries` (unit).
  - `an UNROOTED bootstrap under COLTRANE_LEDGER_PATH reports that single override path`
    (`bootstrapServerDeps()` → `integrity().path === COLTRANE_LEDGER_PATH`).
  - `an explicitly-rooted bootstrap also reports a single path (the gig override)`
    (`bootstrapServerDeps(root)` → same).
- **Observed RED:** `Received "<genome>/ledger.jsonl + <gig>/ledger.jsonl"`, expected the single gig
  path — all three.

### INV-GENOME-ISOLATES-UNDER-OVERRIDE — the genome ledger follows the isolation override
- **Mechanism:** `bootstrapServerDeps` must derive the genome-ledger root from the SAME override the
  gig ledger uses. When `COLTRANE_LEDGER_PATH` is set (and no `genomeRoot`/`COLTRANE_GENOME`), the
  genome ledger must resolve to `defaultGenomeLedgerPath(dirname(COLTRANE_LEDGER_PATH))` —
  `<override-dir>/genome/ledger.jsonl` — NOT `process.cwd()`. This is wired in `bootstrapServerDeps`,
  NOT by making `defaultGenomeLedgerPath` read `COLTRANE_LEDGER_PATH` (see the env-independence guard).
  The genome-LOADING root (`resolveGenome`) is unchanged — only the genome-LEDGER path follows the
  override.
- **Callsite:** `src/server.ts:3809` (root derivation) → `src/server.ts:3860`
  (`new FileLedger(defaultGenomeLedgerPath(...))`).
- **RED test:** `an unrooted bootstrap under COLTRANE_LEDGER_PATH reads the genome ledger BESIDE the
  override, never the real checkout` — seeds `<override-dir>/genome/ledger.jsonl` with `isolated-seal`
  and asserts `bootstrapServerDeps().ledger.query({kind:"genome_mutation"})` returns exactly it.
- **Observed RED:** `expected [] to include 'isolated-seal'` — the genome ledger read the checkout
  (empty), not the seeded override sibling.

### Guards (GREEN today; the fix must keep them green)

- **INV-ENV-INDEPENDENCE** — `defaultGenomeLedgerPath ignores COLTRANE_LEDGER_PATH — the two
  overrides stay independent`. Forbids the rejected fix that couples the resolver to the gig
  override. Also enforced by `tests/genome_ledger_ships.test.ts` (AC5).
- **INV-ROUTING-PRESERVED** — `SplitLedger still routes genome_mutation to the genome ledger and gig
  rows to the gig ledger`. The WO-F06 routing is design, not a defect. Also enforced by
  `tests/genome_ledger_ships.test.ts` (AC1).

## Corroborating existing specs (not authored here)

- `tests/bootstrap_root_isolation.test.ts` — the standing #328 RED spec (all 5 must pass unedited).
- `tests/genome_ledger_ships.test.ts` — the standing GREEN split spec (must stay green: 8/8).
- `tests/integrity_surfaced.test.ts` — asserts `ledger_integrity.ok`/`corrupt` only, never `path`;
  the single-path restoration cannot regress it.

## Acceptance gate

The full `npm test` unit suite passes on ubuntu and macos once `src/ledger.ts` and `src/server.ts`
are corrected — with these four laws GREEN, the two guards still GREEN, and no edit to
`tests/bootstrap_root_isolation.test.ts`.
