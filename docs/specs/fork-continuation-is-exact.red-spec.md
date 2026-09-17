# contract-fork-continuation-is-exact-v1 — RED spec

A seat's LATER spawns must continue the conversation that seat is actually in, and a primer must
describe EXACTLY the conversation a fork resumes. This spec pins three confirmed defects in
`src/claude_invoker.ts` (read at `cfc3da2`) as running RED laws. The enforcement does not exist yet;
every law fails today on an assertion that states the contract's reason.

- **Laws:** `tests/spec_fork_continuation_is_exact.test.ts`
- **Subject under test:** `src/claude_invoker.ts` (`withResume`, the reserve continuation, the
  seal-repair spawn, `assistantContextOf`, the frontier read scan). Out of scope: `src/runtime.ts`,
  the chat-completions door, the reuse cache.
- **Testing method:** example-based, at the two real seams the contract's outputs cross.
  - The arg-list laws (O1, F1) invoke `makeClaudeInvoker` directly through its injected `run` seam and
    CAPTURE each spawn's argv. The reserve laws drive a first spawn that stops at its turn budget (the
    CLI's `error_max_turns` result) so the reserve continuation really runs — the shape
    `tests/the_reserve_fires_on_the_subtype.test.ts` drives — over a fork `ctx` (`ctx.fork` threaded as
    `runGig` threads it), with the chair's own `(gig, role)` session derived by `sessionUuidFor`.
  - The primer laws (O2, O3, I3) run through `runGig` over a PRIME chair whose invoker's injected `run`
    seam returns a stream-json transcript carrying `user`/`assistant` lines with `uuid`/`usage` — the
    same lines a real seat's stdout carries — and read the sealed `seat-primer` back. This is the shape
    `tests/spec_primer_reading_frontier.test.ts` drives.

## Obligations

### O1 — a later spawn continues the chair's OWN session

Every spawn that CONTINUES a chair's own session — the turn-budget reserve continuation and the
seal-repair spawn — must carry exactly one `--resume`, naming the chair's own session uuid, and carry
neither `--resume-session-at` nor `--fork-session`. A fork's warm start belongs to its FIRST spawn only.

- **Mechanism today (broken).** The reserve continuation builds its args with
  `withResume(baseArgs, sessionId)` (`claude_invoker.ts:2022`). `withResume` (`:1267`) drops ONLY
  `--session-id <uuid>` and appends `--resume <own>`. For a fork chair, `baseArgs` is the warm start
  `--resume <primer> --resume-session-at <frontier> --fork-session --session-id <own>`
  (`buildInvokerArgs`, `:1365`), so the continuation becomes
  `--resume <primer> --resume-session-at <frontier> --fork-session --resume <own>` — two `--resume`
  targets (the primer's frontier uuid, which is not a message in the fork's own session), and a
  `--fork-session` that would branch again. The seal-repair spawn (`:2166`) reuses `baseArgs` verbatim,
  so the same leftover reaches it (and it re-opens `--session-id <own>`, which the first spawn already
  created).
- **Mechanism required.** Continue the chair's own session: strip `--session-id`, `--fork-session`,
  `--resume-session-at`, and any inherited `--resume`, then append a single `--resume <own>`. Apply it
  to BOTH the reserve continuation (`:2022`) and the seal-repair spawn (`:2166`).
- **Verified by:** `O1/I1/I2 — the turn-budget reserve continuation resumes the chair's OWN session ›
  a plain chair's reserve is unchanged …` (reserve continuation) and
  `O1 — the seal-repair continuation of a fork chair resumes its OWN session › a fork chair that seals
  nothing is repaired with --resume <own> …` (seal-repair spawn).

### O2 — a usage reporting nothing contributes no reading

A usage object that reports NONE of `input_tokens`, `cache_read_input_tokens` or
`cache_creation_input_tokens` must contribute NO context reading (`undefined`, never `0`), so the
first-write context falls back to the last reported reading and a primer never records
`context_tokens` `0` from a usage that reported nothing.

- **Mechanism today (broken).** `assistantContextOf` (`:1013`) returns
  `(input ?? 0) + (cache_read ?? 0) + (cache_creation ?? 0)`, so a usage reporting only
  `output_tokens` yields `0`. The frontier path takes `firstWriteContext = usage ?? lastUsageBefore`
  (`:1058`); `0` is not `undefined`, so a real earlier reading is discarded, the primer seals
  `context_tokens 0`, and runtime's ceiling test (`primer_context > ceiling`) can never fire.
- **Mechanism required.** `assistantContextOf` returns `undefined` when the usage carries none of the
  three fields, so `usage ?? lastUsageBefore` falls through to the last reported reading.
- **Verified by:** `O2/I3 — a usage that reports none of the three context fields contributes no
  reading › the first-write line reports only output_tokens after an earlier 40,000-input reading …`.

### O3 — a primer's files are the reads before its frontier line

A primer's `files` must be the files the seat Read in lines BEFORE its frontier line, so every recorded
file is one the cut conversation holds: a Read in the same assistant turn as the first write (the
frontier cuts before that turn) must NOT be recorded.

- **Mechanism today (broken).** The frontier read scan (`captureReadingFrontier`, `:1061`) records a
  Read from ANY assistant line before the FIRST WRITE line. But the frontier is the last `user` line
  before that write (`:1057`). When one assistant turn reads and then writes (the CLI emits one line per
  content block, so the Read and the Edit are separate lines of the same message, with no `user` line
  between), the Read is recorded although the cut conversation ends before that turn — the primer names a
  file the fork does not hold, and the fork is told it is fresh.
- **Mechanism required.** Collect reads only up to the frontier `user` line, not up to the first write
  line, so reads in the write's own turn are excluded.
- **Verified by:** `O3 — a primer's files are the reads before its frontier line › a file read in the
  write's OWN turn (after the frontier) is not recorded …`.

## Invariants (controls)

- **I1 — a non-fork chair's reserve continuation is unchanged.** A plain chair that hits its turn
  budget resumes exactly `--resume <own>`, with no `--fork-session` and no `--resume-session-at`.
  Asserted (green) alongside the fork case in the O1 reserve law; the fix must not disturb it.
- **I2 — the fork's own first spawn still warm-starts.** The same fork chair's FIRST spawn still carries
  `--resume <primer> --resume-session-at <frontier> --fork-session --session-id <own>`. Asserted (green)
  in the O1 reserve law.
- **I3 — a primer's `context_tokens` is a reading the seat actually reported.** A seat whose first-write
  line carries a usage reporting only `output_tokens`, after an earlier line reporting 40,000 input
  tokens, records 40,000. Verified by the O2 law (same mechanism).

## Failure modes

- **F1 — a fork chair whose own-session reserve continuation cannot be resumed.** The existing cold
  fallback stands (a fresh `--session-id` spawn with the full prompt), carrying no `--resume-session-at`
  and no `--fork-session`. Verified by `F1 — the reserve continuation of a fork chair whose own session
  is lost falls back cold …`: the reserve resumes the fork's own session (RED today — it resumes the
  primer), and when that resume is lost the cold fallback opens `--session-id` with no fork flags
  (control that stays green).

## Coverage

Every obligation, invariant and failure mode has at least one running law that fails today on an
assertion stating the contract's reason. `uncovered` is empty. The laws are RED by design: the
enforcement they demand does not exist yet.
