# Changelog

Coltrane follows semver with 0.x conventions: while the major is `0`, a **minor** bump
signals a breaking change and a **patch** signals an additive or internal one.

`COLTRANE_VERSION` (`src/version.ts`) is the single source of truth in code and must equal
`package.json`'s `version` — `tests/version_identity.test.ts` enforces that, and also that
the MCP handshake reports the constant rather than a hardcoded literal.

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
