# seat-primer paths are tree_root-relative — red-spec

**Contract:** `contract-seat-primer-paths-v1`
**Laws:** `tests/spec_seat_primer_paths_relative.test.ts` (RED — the enforcement does not exist yet)
**Controls (stay green):** `tests/spec_seat_primer.test.ts`, `tests/spec_rolling_seat_primer.test.ts`

## Why

A seat-primer must name its files the way the repository does, so **any** checkout of the
primer's commit can use it. The first real seat-primer (gig `54f62153`, observed 2026-09-17) recorded
its files as **absolute** checkout paths (`/Users/…/coltrane/src/runtime.ts`), because the seat's
`Read` events carry absolute paths. That ties a primer to one checkout's location: a clone elsewhere
— a worktree, the drain's workspace, another machine — would find none of its files, so every path
would compare as stale or unreadable.

The area of enforcement is two callsites in `src/runtime.ts`:

1. **the prime seal** — where a `chair.prime` seat's forwarded `Read` events become the seat-primer's
   `files[]` (each `{path, blob_sha}`). Verified locations at draft time: `src/runtime.ts` around the
   `if (chair.prime)` block (the `reads`/`orderedPaths`/`files` derivation) and, upstream, the
   `captureReadPaths` in `src/claude_invoker.ts` that de-dupes the raw `file_path` strings.
2. **the fork-time staleness check** — where a fork resolves each primer path against the *forking*
   run's `deps.tree_root` via `gitInTree(deps.tree_root, ["hash-object", f.path])` (`src/runtime.ts`,
   the `chair.fork_from` prep block). A relative path resolves in any checkout; an absolute path from
   another checkout does not.

Scope out (not touched by these laws): the `Read` tool itself; `src/**` implementation; `agents/**`;
`domain_types/**`.

## Obligations, invariant, failure mode → mechanism → law

Each obligation below names the mechanism the enforcement must add and the callsite it lives at, and
references the red law that verifies it. Every law FAILS today on an assertion stating the contract's
reason — never on an import or a setup error — and passes once the mechanism exists.

### O1 — record each file relative to `RunDeps.tree_root` (POSIX separators)

*A seat-primer records each file's path relative to `RunDeps.tree_root`, whether the seat's Read event
named it absolutely or relatively.*

- **Mechanism:** at the prime seal, before building `files[]`, normalize each read path to
  `tree_root`-relative form using POSIX separators (an already-relative path is kept; an absolute path
  under `tree_root` is made relative to it).
- **Callsite:** `src/runtime.ts`, the `chair.prime` seal (`reads`/`orderedPaths` → `files`).
- **Law:** `O1 — a seat-primer records each file relative to RunDeps.tree_root` — a seat Reads an
  absolute path under a temporary git `tree_root`; the sealed `files[].path` must be `src/a.ts`, not
  the absolute checkout path.
  Observed RED: `expected [ '/var/…/primer-paths-o1-…/src/a.ts' ] to deeply equal [ 'src/a.ts' ]`.

### O2 — resolve primer paths against the forking run's own `tree_root` at fork time

*At fork time, primer paths are resolved against the forking run's own `tree_root` for the staleness
comparison, so a primer sealed under one checkout path is fresh in another checkout of the same commit.*

- **Mechanism:** with O1 in force the recorded paths are already `tree_root`-relative, so the existing
  `gitInTree(deps.tree_root, ["hash-object", f.path])` naturally resolves them in the forking checkout;
  the staleness comparison then reflects content, not checkout location.
- **Callsite:** `src/runtime.ts`, the `chair.fork_from` prep (`stale_paths` filter).
- **Law:** `O2 — at fork time, primer paths resolve against the forking run's own tree_root` — a primer
  is sealed under one temporary checkout; that checkout is removed; the fork runs in a *different*
  checkout whose file bytes are identical. `chair_complete.primer_stale_paths` must be `[]` (fresh).
  Observed RED: `expected [ '/var/…/primer-paths-o2-a-…/src/a.ts' ] to deeply equal []` — the absolute
  path recorded under the now-deleted original checkout cannot be hashed, so the file is falsely stale.

### I1 — the same file read absolutely and relatively appears once

*The same file read as an absolute path and as a relative path appears once in `files`.*
Checkable: Read events for `<root>/src/a.ts` and `src/a.ts` under `tree_root <root>` → `files` has
exactly one entry, `src/a.ts`.

- **Mechanism:** normalizing to `tree_root`-relative form (O1) collapses the two spellings to one key,
  so the existing first-appearance de-dup keeps a single `src/a.ts` entry.
- **Callsite:** `src/runtime.ts`, the `chair.prime` seal de-dup (and `captureReadPaths` upstream).
- **Law:** `I1 — the same file read absolutely and relatively appears once in files`.
  Observed RED: `expected [ Array(2) ] to deeply equal [ { path: 'src/a.ts', … } ]` — the absolute and
  relative spellings are two distinct strings today and the file is recorded twice.

### F1 — a Read outside `tree_root` is not recorded

*A Read event names a file outside `tree_root` → it is not recorded in `files` (it is not part of the
area), never as an absolute path.*

- **Mechanism:** at the prime seal, drop any read path that does not resolve inside `tree_root` before
  building `files[]`.
- **Callsite:** `src/runtime.ts`, the `chair.prime` seal (the read-path filter).
- **Law:** `F1 — a Read event naming a file outside tree_root is not recorded in files` — a seat Reads
  one in-tree file and one file outside `tree_root`; `files` must be `['src/a.ts']`, and no entry may
  carry the outside file's absolute path.
  Observed RED: `expected [ …(2) ] to deeply equal [ 'src/a.ts' ]` — the outside file is folded in
  today, stored verbatim as an absolute path escaping the area.

## Testing method

Example-based, at the two real seams the contract's outputs cross:

- The **prime seal** (O1/I1/F1): a `prime` chair is run through `runGig` with `makeClaudeInvoker`'s
  injected `run` seam emitting `Read` events (absolute paths) under a temporary **git** `tree_root`
  (init + commit, so the seal's `git rev-parse HEAD` and `git hash-object` resolve). The sealed
  `seat-primer.files` are read back from the store and asserted. Each of O1/I1/F1 is a specific input
  shape (an absolute read; the same file two ways; an outside read) → an example is the exact unit.
- The **fork-time staleness check** (O2): a primer is sealed under one temporary checkout, that
  checkout is removed, and the fork is run through `runGig` in a *different* checkout of identical
  bytes; `chair_complete.primer_stale_paths` is asserted empty. The two-checkout example is the exact
  demonstration of location-independence.

No property-based engine is added: each invariant here is a specific behavior at a specific callsite,
not a universal numeric/structural property, so example-based laws are the right instrument.
