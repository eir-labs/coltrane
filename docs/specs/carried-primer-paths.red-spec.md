# carried-primer-paths — RED spec

**Contract:** `contract-carried-primer-paths-v1`
**Criteria:** a primer names its files the way the repository does, whether the seat read them or inherited them.
**Scope in:** `src/runtime.ts` (the seat-primer seal). **Scope out:** records already sealed; the fork-time staleness comparison.
**Laws:** `tests/spec_carried_primer_paths_relative.test.ts` (RED — the enforcement does not exist yet).

## The regression

`contract-seat-primer-paths-v1` put every path a primer records through `toTreeRelative`
(`src/runtime.ts`, the `chair.prime` seal): re-expressed relative to `RunDeps.tree_root`, POSIX-separated,
and dropped when it resolves outside `tree_root`. Reviewing **a3e69d2**
(`contract-primer-reading-frontier-v1`) on 2026-09-18 surfaced that the a3e69d2 seal normalizes **only the
seat's own reads** (`readRel`); the **carried** files of a forked primer enter `orderedPaths` **raw** from
the forked record:

```
// src/runtime.ts:3770-3773  (the union)
const orderedPaths: string[] = [];
const seenPaths = new Set<string>();
for (const path of [...forkedFiles.map((f) => f.path), ...readRel]) {   // ← carried paths RAW
  if (!seenPaths.has(path)) { seenPaths.add(path); orderedPaths.push(path); }
}
```

`readRel` (lines 3760-3765) is built by mapping each read through `toTreeRelative`; `forkedFiles.map((f) => f.path)`
is not. So a carried absolute path is resealed absolute forever, a carried path outside `tree_root` is never
dropped, and a carried absolute spelling plus a relative read of the same file de-dupe as two distinct
strings. Measured (change-request): three seat-primers sealed 2026-09-17 before fdb36ff (gigs 54f62153,
955f7cc6, 6ea6d047) carry 4, 6 and 8 absolute paths under `/Users/eugenestuckless/eir/coltrane`. The
standing path laws (`tests/spec_seat_primer_paths_relative.test.ts`) exercise Read events only, so none of
them saw this.

## Obligations, invariants, failure modes

### O1 — a carried absolute path is resealed tree_root-relative, keeping the forked blob

**Statement.** A carried file whose path is absolute under `tree_root` is resealed as its `tree_root`-relative
POSIX path, keeping the blob the forked primer recorded (unless the seat read it before its frontier, per
`contract-primer-reading-frontier-v1` O4).

**Mechanism.** The union at `src/runtime.ts:3772` must feed each carried path through the **same**
`toTreeRelative` (lines 3751-3757) it already applies to reads, before de-duping — while the carried file's
blob continues to come from `forkedBlob` (lines 3768, 3789), so a carried file the seat did not re-read keeps
what the forked primer recorded rather than being re-blobbed at seal.

**Callsite.** `src/runtime.ts` — the `chair.prime` seal, the `orderedPaths` union (line 3772) reading
`forkedFiles` from `p.fork.primer_files` (fork wiring, lines 2867/2883).

**Verified by.** `O1 — a carried file whose path is absolute under tree_root is resealed as its tree_root-relative POSIX path`
› *a carried <root>/src/a.ts the seat did NOT re-read is resealed as src/a.ts at the blob the forked primer recorded*.

### I1 — a carried file and a read of the same file appear once

**Statement.** A carried file and a read of the same file appear once, whatever spelling each used.
**Checkable.** Forked primer carries `<root>/src/a.ts`; the seat Reads `src/a.ts` before its frontier: `files`
has exactly one `src/a.ts` entry, at the read's blob.

**Mechanism.** Once the carried path is normalized (O1), the carried absolute spelling and the relative read
collapse to one `tree_root`-relative key in `seenPaths` (line 3771). `blobFor` (lines 3780-3790) already
prefers the read's chair-start blob over the forked blob when a path is in `readSet`, so the single surviving
entry carries the read's blob.

**Callsite.** `src/runtime.ts` — the `orderedPaths`/`seenPaths` de-dup (lines 3770-3774) over the union of
normalized carried paths and `readRel`, then `blobFor` (lines 3780-3791).

**Verified by.** `I1 — a carried file and a read of the same file appear once, whatever spelling each used`
› *the forked primer carries <root>/src/a.ts; the seat Reads src/a.ts before its frontier: files has exactly one src/a.ts entry, at the read's blob*.

### F1 — a carried file resolving outside tree_root is never stored

**Condition.** A carried file's path resolves outside `tree_root`.
**Refusal.** It is absent from the resealed files, never stored.

**Mechanism.** `toTreeRelative` returns `undefined` for a path that resolves outside `tree_root` (line 3755);
applied to carried paths (O1's fix), such a carried file is dropped from `orderedPaths` exactly as an
out-of-tree read already is (lines 3762-3764).

**Callsite.** `src/runtime.ts` — `toTreeRelative`'s outside-`tree_root` guard (line 3755) applied to the
carried branch of the union (line 3772).

**Verified by.** `F1 — a carried file whose path resolves outside tree_root is never stored`
› *a carried file OUTSIDE tree_root is absent from the resealed files, never stored as an absolute path*.

## Testing method

Example-based, at the real seal seam, driven exactly as `tests/spec_primer_reading_frontier.test.ts` drives
it: the forked seat-primer is **seeded directly into the output store** (its `files` become the carried
`primer_files`), and a **prime+fork chair** is run through `runGig` with `makeClaudeInvoker`'s injected `run`
seam over a **real git fixture** as `RunDeps.tree_root`. The chair reads the seeded primer's files, unions
them with the seat's own reads, and reseals a fresher primer — the diff this contract corrects. Each
invariant is a specific behavior of that union (not a universal property), so example-based is the fit,
matching the standing carried/rolling/path laws. Distinct sentinel blobs separate "keeps the forked blob"
(O1) and "at the read's blob" (I1) from any re-blobbing at seal.

## Observed failures (RED, as of this seal)

`npx vitest run tests/spec_carried_primer_paths_relative.test.ts` — 3 failed / 3, each on the contract
assertion (never an import or setup error):

- **O1** — resealed `files[0].path` is the absolute `/var/…/carried-paths-o1-…/src/a.ts`; expected `src/a.ts`.
- **I1** — resealed `files` has two entries (the carried absolute `@ forked blob` and the read `src/a.ts @ read blob`); expected exactly one `src/a.ts @ read blob`.
- **F1** — resealed paths are `[/var/…/src/a.ts, /var/…-out-…/elsewhere.ts]`; expected `[src/a.ts]` (the outside carried file dropped).

## Controls (must stay green, unchanged)

`tests/spec_seat_primer_paths_relative.test.ts`, `tests/spec_primer_reading_frontier.test.ts`,
`tests/spec_rolling_seat_primer.test.ts`, `tests/spec_seat_primer.test.ts` — the standing
path/frontier/primer laws this contract only extends to the carried side.
