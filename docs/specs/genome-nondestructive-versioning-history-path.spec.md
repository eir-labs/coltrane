# Red-spec — Genome non-destructive versioning snapshots to the tracked `genome/history/` path

**Gig:** 835d51eb · WO-F06 (Genome provenance ships with its repo), third reconciliation
**Branch:** `publish/genome-ledger-ships` (atop the WO-F06 split + isolation fix)
**Subsystem:** genome writer — non-destructive versioned overwrite (`writeGenomeFileVersioned`, `src/genome_writer.ts`)
**Scope:** `tests/genome_nondestructive_versioning.test.ts` only. `src/genome_writer.ts` is NOT modified — the WO-F06 relocation to `genome/history/` stays exactly as written.

## Context

WO-F06 Article II deliberately MOVED the genome history snapshots from the gitignored
`.coltrane/history/` path to the git-TRACKED `genome/history/` path, so prior versions ship
with the repo instead of being lost to a fresh clone. The snapshot STILL happens on a
destructive overwrite — only the destination path changed.

The verification suite for this invariant (`tests/genome_nondestructive_versioning.test.ts`)
still asserted the retired `.coltrane/history/…` path at two sites (lines 45, 59) and named
it in the file-level comment (line 3). Consequently:

- The **snapshot-before-overwrite** test was RED — it asserted `existsSync` at the old path,
  which is never written; observed `expected false to be true` at line 46.
- The **no-op-overwrite** test passed **spuriously** — its negative `existsSync` assertion at
  the old path was vacuously satisfied because nothing ever writes there.

This spec corrects the stale path expectation to the real callsite the writer populates.

## Real callsite (read, not invented)

`src/genome_writer.ts:42` — the only writer of a history snapshot:

```
const histDir = join(genome_dir, "genome", "history", subdir, slug);
mkdirSync(histDir, { recursive: true });
writeFileAtomic(join(histDir, `${prior}.json`), oldBytes);   // only when oldBytes !== jsonText
```

With `genome_dir = <mkdtemp dir>` and `subdir = "standards"`, the true snapshot directory is
`join(dir, "genome", "history", "standards", slug)`. The authoritative green reference for this
path already lives at `tests/genome_ledger_ships.test.ts:321` (AC4), which asserts the tracked
`genome/history/` path is PRESENT and the gitignored `.coltrane/history/` path is ABSENT.

## Invariants and obligations

### INV-1 — snapshot-before-overwrite lands under the tracked `genome/history/` path

Composing over an existing standard slug with **different** bytes MUST snapshot the prior bytes
under `genome/history/standards/<slug>/` **before** the current file is overwritten, and the
snapshotted bytes MUST equal the prior version verbatim (recoverable content, not just a hash).

- **Mechanism:** `writeGenomeFileVersioned` (`src/genome_writer.ts:38-47`) — on `existsSync(path)`
  with `oldBytes !== jsonText`, atomically writes `oldBytes` to `join(genome_dir, "genome",
  "history", subdir, slug, "<priorHash>.json")`.
- **Callsite exercised:** `standard_compose` → `sealDefinition` → `writeGenomeFileVersioned`
  (`src/genome_writer.ts:112`), driven through `dispatchTool("standard_compose", …)`.
- **Verified by:** `composing over an existing standard slug snapshots the prior bytes before
  overwriting` — asserts `existsSync(join(dir, "genome", "history", "standards", slug))` is true,
  the directory holds ≥1 snapshot, and the snapshot bytes equal the prior `v1` file bytes.
  Non-tautological: it fails if the writer stops snapshotting, writes elsewhere, or corrupts the
  preserved bytes.

### INV-2 — identical-bytes overwrite writes no snapshot (idempotent no-op)

Re-composing **identical** content over an existing slug MUST NOT write any history snapshot at
`genome/history/standards/<slug>/`.

- **Mechanism:** the `oldBytes !== jsonText` guard (`src/genome_writer.ts:40`) — identical bytes
  skip the snapshot branch entirely.
- **Callsite exercised:** two consecutive `dispatchTool("standard_compose", args, deps)` calls
  with byte-identical args.
- **Verified by:** `re-composing identical content writes no history snapshot (no-op overwrite)`
  — asserts `existsSync(join(dir, "genome", "history", "standards", slug))` is false. With the
  path corrected to where the writer actually writes, this negative assertion is now MEANINGFUL
  (a broken no-op guard would make it fail) rather than vacuously true against a dead path.

## Observed behaviour

- **Before edit (RED baseline):** `npx vitest run tests/genome_nondestructive_versioning.test.ts`
  → 1 failed / 1 passed. INV-1's test failed with `AssertionError: expected false to be true` at
  `tests/genome_nondestructive_versioning.test.ts:46`. INV-2's test passed spuriously.
- **After edit:** the same file → 2 passed. The three sibling WO-F06 tests
  (`genome_ledger_ships`, `bootstrap_root_isolation`, `split_ledger_path_and_isolation`) →
  21 passed across the 4 files. Full `npx vitest run` → 335 files passed, 2 skipped, 3365 tests
  passed, 22 todo, 0 failed.

## Note on RED vs GREEN

This is a change-gig correcting a stale test expectation, not a greenfield enforcement spec. The
RED that was observed and recorded is the **baseline failure** of INV-1's test against the retired
`.coltrane/history/` path. The corrected tests are GREEN because the enforcement they demand
(`src/genome_writer.ts:42`) already exists — WO-F06 implemented it. The correction re-points the
assertions at the real callsite; both tests remain able to FAIL for the right reason (writer stops
snapshotting / snapshots to the wrong place / corrupts bytes / breaks the no-op guard).
`src/genome_writer.ts` is unchanged (`git status --porcelain` shows only the one test file).
