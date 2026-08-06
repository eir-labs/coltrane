# Changelog

Coltrane follows semver with 0.x conventions: while the major is `0`, a **minor** bump
signals a breaking change and a **patch** signals an additive or internal one.

`COLTRANE_VERSION` (`src/version.ts`) is the single source of truth in code and must equal
`package.json`'s `version` — `tests/version_identity.test.ts` enforces that, and also that
the MCP handshake reports the constant rather than a hardcoded literal.

## Unreleased

### Breaking

- **`OutputStore` gains two methods, `typeFingerprint(slug)` and `validateWrite(o)`.** Any
  external implementation of the `OutputStore` interface must add them — same shape as
  0.4.0's `Ledger.integrity()` addition, and for the same reason: the store is the single
  owner of a question two layers now need answered.

  `typeFingerprint` hashes a type's current shape (core + required list + schema).
  `validateWrite` answers "would `write` accept this?" without persisting — `write` now calls
  the same internal gate, so the two answers cannot drift. Reuse needs both: the first to
  detect that a domain type moved under a cached output, the second to decide about a
  multi-output entry *before* any of it becomes durable.

  **Migration.** A store with no registry can answer honestly:

  ```ts
  typeFingerprint(): string { return ""; }   // "" = cannot describe → never reused
  validateWrite() { return { valid: true }; }
  ```

### Added

- **Phase checkpoint/resume, and engine-level output reuse.** One idea, two ranges: reuse a
  sealed output instead of paying to derive it again. A mid-run failure used to discard every
  completed phase — a full convergence run is ~$4–7, and a failure at phase 5 threw away
  phases 1–4.

  - `RunDeps.checkpoints` — a durable per-gig record of each completed chair's sealed outputs.
    Written automatically when wired; a checkpoint you must opt into *before* the failure is
    one you never have.
  - `RunDeps.resume_from` / `gig_dispatch({ resume_gig_id })` — continue that gig (same
    `gig_id`, so `output_trace` still reaches the restored ancestors), skipping what already
    sealed. **Refused, never silently run cold**, if `genome_hash`, the dispatch payload,
    `model_version`, `depth`, the canonical form, or any consumed domain type has moved; the
    reply carries `resume_refused` and a `drift` list.
  - `RunDeps.reuse` / `gig_dispatch({ reuse: true })` — a chair whose producer definition,
    consumed input **content**, payload, model and depth hash to a prior sealed output is
    served from it instead of invoked. Presence of the store is the opt-in, for reads *and*
    writes: the store is cross-gig by construction, so populating it is itself a decision.
    A found-but-unusable entry is reported and the chair does the work.
  - Reuse is never a way to skip a check. Every recalled output crosses the same seal boundary
    a derived one does (#263 core agreement, the registry schema, the #227/#228 substance
    floor) and is re-hashed to the `content_sha` the original seal produced — which is why a
    resumed or fully-reused run carries the **same `run_fingerprint`** as the cold run it
    stands in for.
  - Nothing is silent: `GigResult.skipped` / `.resumed_from` / `.reuse`, the `gig_resumed`,
    `chair_skipped` and `reuse_rejected` progress events, `gig_monitor.skipped_chairs`, a
    `skipped` chair status of its own, and `OutputRecord.reused_from` on the record itself.

## 0.4.1

### Fixed

- **The bare specifier was not resolvable.** `exports["."]` declared `types` and `import` but
  no fallback condition, so `require.resolve("@eir-labs/coltrane")` failed with
  `ERR_PACKAGE_PATH_NOT_EXPORTED` even though `import` worked. Path resolution is not module
  loading — a consumer locating the package (to hand a path to a dynamic import, or to point
  a tool at `dist/`) hit an error for something the package plainly ships. Adding `default`
  makes it resolvable under any condition; the package remains ESM-only.

  Found by installing 0.4.0 from the registry and using it, not by reading the manifest.

## 0.4.0

### Breaking

- **`Ledger` gains a fourth method, `integrity(): LedgerIntegrityReport`.** Any external
  implementation of the `Ledger` interface must add it. (#255)

  `FileLedger` already had it as a class method; the interface did not declare it, so a
  consumer holding a `Ledger` could not ask whether its own audit trail was intact — the
  engine's own test had to cast through `Record<string, unknown>` to reach it. Since the
  point of the ledger is auditability, "you cannot ask" was not a defensible default.

  **Migration.** An implementation whose storage cannot tear still owes an answer; "there is
  nothing here to corrupt" is one, and a missing method is not:

  ```ts
  integrity(): LedgerIntegrityReport {
    return { ok: true, path: "", entries: this.rows.length, corrupt: [] };
  }
  ```

  This is what `MemoryLedger` returns.

### Added

- `system_health` surfaces `ledger_integrity`, `outputs_integrity`, `counts_complete` and
  `counts_complete_basis`, and advertises all four in its MCP `output_schema`. Corruption was
  previously detected, reported into a void, and invisible to operators. (#255)
- `Chair.optional_outputs` — declares which promised output types may legitimately be absent.
  The `output_contract` is now a **floor**: a chair sealing fewer types than it promised fails
  the run unless the absence was declared. Deny-by-default. (#243)

### Changed

- **`counts_complete` is `false` or `null`, never `true`.** Corruption found is provable;
  completeness is not — a jsonl truncated at a line boundary loses whole rows without leaving
  a parse error. `counts_complete_basis` states what was and was not checked. (#255)
- A chair is now **all-or-nothing**: every check that can reject it runs before the first
  output is sealed, so a failed chair no longer leaves persisted outputs with no ledger row.
  (#243)
- `outputs.integrity()` re-scans from disk on every call instead of reporting the corruption
  accumulated during reads, which never included files the process wrote itself. (#255)
- `standard_simulate` refuses an unknown standard, and reports `not_implemented` on a host
  with no standards wired — matching `gig_dispatch` rather than quoting a price for a run the
  same server would refuse. (#267)
- `outputs.write` rejects a record whose `core_type` contradicts its `domain_type`'s
  `extends`, and rejects a `core_type` that is not a core type at all. (#263)
- A skill-backed chair may no longer declare more than one output type: it seals exactly one,
  so a longer contract was a promise the runtime could not keep or report breaking. (#243)

## 0.3.0

First tagged version. Establishes `COLTRANE_VERSION` as the single source of truth and makes
the MCP handshake report it rather than a hardcoded `"0.1.0"`. (#257)
