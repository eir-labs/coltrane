# Changelog

Coltrane follows semver with 0.x conventions: while the major is `0`, a **minor** bump
signals a breaking change and a **patch** signals an additive or internal one.

`COLTRANE_VERSION` (`src/version.ts`) is the single source of truth in code and must equal
`package.json`'s `version` — `tests/version_identity.test.ts` enforces that, and also that
the MCP handshake reports the constant rather than a hardcoded literal.

## 0.5.0

The through-line of this release: **the engine had a habit of answering confidently when it
should have refused.** A guardrail that no caller could discover, a filter that silently did
nothing, a lifecycle field that round-tripped and changed nothing, a `proposal_id` for a
proposal never recorded. Each read as working software. Most of what follows is the engine
learning to say "no" or "I don't know" where it used to return a plausible answer.

### Breaking

- **`OutputStore` gains `typeFingerprint(slug)` and `validateWrite(o)`.** Any external
  implementation must add them — same shape as 0.4.0's `Ledger.integrity()` addition, and for
  the same reason: the store is the single owner of a question two layers now need answered.

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

- **`CheckpointStore` gains `remove(gig_id)`.** Called when a gig completes. Nothing previously
  removed a checkpoint, so every gig a deployment ran left a file behind forever. A failed or
  aborted gig keeps its checkpoint, because that is what resume reads.

  **Migration.** `remove() {}` is a valid implementation; it forgoes the reclamation only.

- **The loader refuses three definition shapes it used to accept silently**, plus six further
  bypasses of the same rule found on review — including `type: ["string","null"]`, the same
  constraint in JSON Schema's other legal spelling. A genome that loaded under 0.4.1 may now
  report `load_errors`. That is the point: it was not loading what its author wrote.

- **`gig_dispatch` refuses a `retired` standard** and warns on a `deprecated` one. Previously
  `status` was recorded and read by nothing, so a standard marked retired stayed dispatchable.

- **Calls that used to succeed on nonsense now fail.** In each case the prior behaviour was a
  confident wrong answer, not a tolerant one:
  - `capability_research` with no `need` — previously returned `gap: true, "propose a new
    tool/type"` for a search of the empty string.
  - `tool_propose` / `tool_deprecate_propose` with no `slug` — previously returned a
    fabricated `proposal_id` for a proposal that was never recorded.
  - `output_trace` with an unrecognised `direction`, `system_health` / `health_check` with an
    unparseable `window`, `system_audit` with an unknown `check` — previously ignored, so the
    caller received an answer to a different question with nothing marking the difference.

- **`company_id` is removed from the MCP surface.** It was advertised on `gig_dispatch`,
  `charter_read` and `charter_suggest_update` and read by none of them. It is worse than a
  merely dead argument because it is tenancy-shaped: a caller passing it to scope a run would
  reasonably believe the run was scoped. The engine deliberately does not do tenancy —
  `principal` on the ledger is provenance, explicitly not access control — so it stops
  advertising a guarantee it does not make. It survives as a field on `AccessGrant`.

- **Several tools' advertised input schemas changed** to match what their handlers read. Most
  notably `output_write` now advertises `gig_id`, `agent_slug`, `phase` and the cost fields;
  `access_grant_check` and `capability_research` advertise the arguments they actually consume.

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
    sealed. **Refused, never silently run cold**, if `genome_hash`, the **producers**, the
    dispatch payload, `model_version`, `depth`, the canonical form, or any consumed domain type
    has moved; the reply carries `resume_refused` and a `drift` list.
  - `RunDeps.reuse` / `gig_dispatch({ reuse: true })` — a chair whose producer definition,
    consumed input **content**, payload, model and depth hash to a prior sealed output is
    served from it instead of invoked. Presence of the store is the opt-in, for reads *and*
    writes: the store is cross-gig by construction, so populating it is itself a decision.
    A found-but-unusable entry is reported and the chair does the work.
  - Reuse is never a way to skip a check. Every recalled output crosses the same seal boundary
    a derived one does (core agreement, the registry schema, the substance floor) and is
    re-hashed to the `content_sha` the original seal produced — which is why a resumed or
    fully-reused run carries the **same `run_fingerprint`** as the cold run it stands in for.
  - Nothing is silent: `GigResult.skipped` / `.resumed_from` / `.reuse`, the `gig_resumed`,
    `chair_skipped` and `reuse_rejected` progress events, `gig_monitor.skipped_chairs`, a
    `skipped` chair status of its own, and `OutputRecord.reused_from` on the record itself.

- **The capability gate fails CLOSED.** `exposedTools` walked the agent's grant and filtered
  only the tools it RECOGNISED; a tool in none of the three scope classes matched no branch and
  was exposed unconditionally, whatever the grant said. The gate's coverage was its own
  allowlist, so the tools it had never heard of were exactly the ones it could not stop. An
  unrecognised tool is now denied, and `undeclaredScopeTools()` lists them so an operator sees
  the problem while authoring rather than mid-run.

- **The prompt is delivered on stdin when it is too large for the command line.** Windows caps
  a command line at ~32,767 characters and the invoker put the whole chair prompt in argv, so a
  strategize-phase prompt (blueprint + draft + review) died with `ENAMETOOLONG`. A consumer
  reported it as "broken on Windows … local dev was practically unusable" and worked around it
  by monkey-patching `child_process.spawn` — a patch coupled to this module's argv construction
  through the package's built output, which would therefore break *silently* on any release
  that touched it. `-p` is a boolean flag and the prompt is positional, so the fix keeps the
  flag and moves the positional: no consumer needs to patch anything.

  Threshold `COLTRANE_PROMPT_ARG_LIMIT` (default 16,000, deliberately well under the cap
  because the mcp-config path and tool lists share the line); `COLTRANE_PROMPT_MODE=arg|stdin`
  forces either route. An unrecognised value falls back to the size test rather than failing a
  dispatch. Below the threshold nothing changes, and stdin is opened only when something is
  going down it, so TTY detection is unaffected for existing callers.

- **A skill-backed chair is interruptible.** It ran a blocking subprocess, so abort could not
  reach it — a "stopped" run kept burning. Now spawned non-blocking, SIGKILLed on abort, not
  spawned at all if already aborted, and capped at 64MB of output.

- **The advertised-schema guard covers all 37 tools.** A tool's `input_schema` and its handler
  are two statements of one fact, and nothing checked they agreed. Both directions are bugs:
  read-but-unadvertised is an undiscoverable control, advertised-but-unread is a silent no-op.

- **Arguments that were advertised and ignored now work**: `window` on `system_health` /
  `health_check`, `status` and `min_usage` on `type_browse`, `data_filter` on `output_query`,
  `direction` on `output_trace`, `scope` / `check` on `system_audit`, `since` on
  `learning_synthesize`, and the rationale fields (`reason`, `evidence`, `notes`,
  `agent_version`, `domain`, `spec`, `category`) which are now recorded rather than discarded.

- **`writeFileAtomic`** (`src/fs_atomic.ts`), shared by the genome writer and the checkpoint
  store.

### Fixed

- **`output_write` read `gig_id` and advertised it nowhere.** A prompt written against the
  schema omits it, the handler defaults it to `""`, and the sealed output attaches to no gig.
  A live run of a consuming product produced 509 such orphans. This is that bug's root cause.

- **`capability_research` reported a gap for every capability.** It advertised `need`/`context`
  and read `query`/`capability` — no overlap — so every schema-following call searched the
  empty string, matched nothing, and was told to build a new tool. The one tool whose purpose
  is preventing redundant definitions recommended one unconditionally.

- **Genome writes are atomic.** `sealDefinition` records a definition's identity in the ledger
  *before* writing the file — deliberate, because the reverse manufactures a definition with no
  recorded identity — and that ordering is only safe if the write is all-or-nothing. A torn
  `writeFileSync` left the ledger asserting a content hash whose bytes on disk hash to
  something else, which is the engine's central provenance claim failing silently. The same
  function writes the prior version to history before overwriting, so an interrupted overwrite
  could destroy the live file while its only backup was also mid-write.

- **A refused resume destroyed the prior run's state**, turning a `failed` gig into a
  permanently `running` one and discarding the very error being acted on.

- **`type_extend` was a third door** that could persist a definition the loader had just
  declared illegal.

- **`tool_propose` and `tool_deprecate_propose` minted receipts for work they never did** —
  a `randomUUID()` returned as a `proposal_id`, every argument discarded, nothing written. Both
  are now recorded through the same ledger path `proposal_create` uses.

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
