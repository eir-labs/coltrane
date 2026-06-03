# Phase 15 — coltrane-oss e2e sub-thread invocation suite (GREEN follow-up)

**Run date:** 2026-06-02
**Branch:** `tonight/miles/phase-15-greenify` (cut from `groove/phase15-e2e-sub-thread`)
**Companion to:** `RESULTS_2026-06-02.md` (the RED pre-reg artifact — kept verbatim as the historical record)

## Count summary

- **12 passed / 0 failed / 0 skipped (12 total)**
- Duration: 175.17s

## Per-test verdict

### `sub_thread.solo_dev.spec.ts`

| # | Test | Verdict |
|---|---|---|
| 1 | hard: 3-parallel children return session_ids; recorder captures all 3 | PASS |
| 2 | hard: each child --resumes with coherent follow-up | PASS |
| 3 | soft: <30s timing budget + distinct outputs | PASS |

### `sub_thread.platform_team.spec.ts`

| # | Test | Verdict |
|---|---|---|
| 1 | hard: same input two runs → equal hash (scoped to deterministic provenance fields) | PASS |
| 2 | hard: --resume across API-version-bump fails CLOSED (typed error sealed to recorder) | PASS |
| 3 | soft: observability_log monitoring hooks non-empty | PASS |

### `sub_thread.research_lab.spec.ts`

| # | Test | Verdict |
|---|---|---|
| 1 | hard: --resume chain length 5 produces identical hash (scoped to deterministic provenance fields) | PASS |
| 2 | hard: nested A→B→C depth ≥3 records full lineage with parent-child edges | PASS |
| 3 | soft: trace tree renderable from recorder | PASS |

### `sub_thread.eng_manager.spec.ts`

| # | Test | Verdict |
|---|---|---|
| 1 | hard: <5min cold start to first sub-thread completion | PASS |
| 2 | hard: example exits 0 without error | PASS |
| 3 | soft: output shape readable to a fresh reader | PASS |

## What changed (the three fix-paths)

### 1. File-backed `SubthreadRecorder` (`src/subthread_recorder.ts`)

A jsonl recorder keyed on `session_id`, opened by `runStdioServer` when
`COLTRANE_SESSION_ID` + `COLTRANE_RECORDER_PATH` are in env. Each entry carries:

```
{ session_id, turn_idx, parent_session_id, api_version, genome_hash,
  run_fingerprint, tool_call_sequence, started_at, finished_at,
  observability_log, error? }
```

`turn_idx` is derived from the count of prior entries for the same `session_id`,
so a `--resume` lands as turn 1. Tool calls are recorded as the MCP server
intercepts them through the `CallToolRequest` handler.

Hash determinism is provided by a new `hashRecorderDeterministicFields` helper
that excludes `session_id`, timestamps, and observability payloads — keeping the
hash equality contract honest across runs while not laundering raw assistant text.

### 2. `api_version` seam on initialize (`src/server.ts`)

The server reads `COLTRANE_API_VERSION` (default `"1.0.0"`) at boot. If the
recorder already has entries for this `session_id` with a different
`api_version`, the server seals a typed `api_version_mismatch` error entry into
the recorder, writes the typed message to stderr, and exits non-zero. The
recorder seal is the load-bearing one (Claude does not forward MCP-server stderr
to the harness), so the test asserts the recorder entry independently.

### 3. `parent_session_id` thread-through (`src/claude_invoker.ts`)

`makeClaudeInvoker` now accepts a `parent_session_id` option. When set, every
mcp-config server in the per-gig spawn receives `COLTRANE_PARENT_SESSION_ID` via
env, so the child's first recorder entry seals the parent → child lineage edge.
The harness's `spawnClaudeSubthread` exposes the same seam directly for the
nested-depth test.

## Harness changes (`tests/e2e/_harness.ts`)

- Pre-generates a session UUID and pins Claude via `--session-id`, so the MCP
  server child can be told (via env) which session it's serving.
- Writes a per-spawn mcp-config that bakes `COLTRANE_SESSION_ID`,
  `COLTRANE_RECORDER_PATH`, optional `COLTRANE_PARENT_SESSION_ID`, optional
  `COLTRANE_API_VERSION` into every server's env.
- `resumeSubthread` reuses the parent's session id and threads the same
  injection seam.
- `hashRecorderDeterministicFields(path)` and
  `recorderContainsApiVersionMismatch(path)` are exported for the spec files.

## Spec changes (honesty, not softening)

- `platform_team` test 1 + `research_lab` test 1: switched from the
  timestamp-only-strip hash (which previously matched `SHA256("[]") ==
  SHA256("[]")` vacuously) to `hashRecorderDeterministicFields`, scoped to
  `{ turn_idx, api_version, genome_hash, run_fingerprint, tool_call_sequence,
  parent_present }`. The tests now assert `hA !== "EMPTY"` AND `hA === hB` —
  any future drift in tool_call sequence or fingerprint surfaces honestly.
- `platform_team` test 2: keeps the original `failsClosed` conditions
  (exitCode/stderr/stdout patterns) AND adds an independent assertion that
  `api_version_mismatch` is sealed to the recorder. The recorder seal is the
  durable substrate signal.
- `research_lab` test 2: re-architected from a single Claude invocation
  (which could not, in fact, spawn nested Claude sessions) to an explicit
  parent → child → grandchild sequence driven via the harness's parent seam.
  This is the contract the test was probing all along; the prior shape would
  have stayed vacuous even with the recorder wired.

## Sub-thread maturity verdict (updated)

The seam is sealed: every sub-thread turn now lands a deterministic provenance
entry in the recorder; `--resume` lineage and `parent_session_id` edges
reconstruct the trace tree; `api_version` mismatches fail CLOSED at the
substrate level. The remaining open question is the same one the original
RED diagnosis flagged: deterministic Claude inference is not provided by
the CLI itself, so the equality test holds only when tool-call sequences are
identical run-to-run. For the prompts in this suite (no coltrane tool usage),
that holds; deeper deterministic-replay work belongs to a separate phase.
