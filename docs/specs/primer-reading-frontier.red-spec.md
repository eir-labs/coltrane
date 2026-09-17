# contract-primer-reading-frontier-v1 — RED spec

A seat-primer is forked at its **reading frontier**: the primer records where the seat's *reading*
ended, a fork resumes the primer's session **cut there**, the primer's context size and files
describe the conversation **as cut**, and an unresolvable frontier falls back cold.

> A fork loads what the primer READ, never what it then DID; a primer's size and files describe
> exactly the conversation a fork resumes.

Measured cause (change-request source, 2026-09-18): a rolling builder primer grew 101.8k → 233.4k
tokens over five builds because every fork re-pays the WORK the primer did *after* its reading
(12.4k / 7.9k / 5.7k / 3.5k / 14.8k added tokens per build once the seat started writing). Probed on
`claude 2.1.274`: `--resume-session-at <message uuid>` (passed by the Agent SDK's `resumeSessionAt`,
absent from `--help`) starts a fork with the conversation cut after that message — primer `e357474c`
resumed at the tool_result before its first Edit carried 76.6k of context against 101.8k for the whole
session. The `uuid` on every user/assistant line of a seat's stream-json stdout is the same uuid the
session transcript records; a uuid the session does not hold prints
`No message found with message.uuid of: <uuid>`.

**This is a RED spec. It publishes nothing.** Every law below FAILS today on an assertion stating the
contract's reason — the enforcement does not exist (`git grep resume-session-at`/`primer_frontier`
over `src/` finds only the unrelated dispatch *ready* frontier). The seat-primer domain type gains
`frontier` through `type_extend` AFTER this build (out of scope); the laws register their own
permissive stand-in carrying `frontier`.

## Laws

All laws are in `tests/spec_primer_reading_frontier.test.ts`. Testing method: **example-based**, at the
two real seams the standing seat-primer laws already exercise —
`makeClaudeInvoker`'s injected `run` seam (stream-json stdout whose user/assistant lines carry `uuid`,
plus captured argv) run through `runGig` with a real git fixture as `RunDeps.tree_root`.

### O1 — the primer records `frontier`

The prime chair's seat-primer records `frontier`: the uuid of the last `user` line in the seat's
stdout that precedes the first assistant line calling a write tool (`Write`, `Edit`, `MultiEdit` or
`NotebookEdit`). Derived by the engine from stdout, never typed by the model.

- **Mechanism.** A new stdout parse alongside `captureReadPaths` / `captureLastContext`
  (`src/claude_invoker.ts:958`, `:992`): find the first assistant line whose `message.content` holds a
  `tool_use` with a name in `WRITE_TOOLS` (`src/runtime.ts:2988`), then return the `uuid` of the last
  `user` line before it. The invoker forwards it the way it forwards `seat_reads`
  (`src/claude_invoker.ts:1964`); the runtime seals it onto the seat-primer (`src/runtime.ts:3735`).
- **Callsite / seam.** `runGig` → prime chair → `output_write` seal path; primer read back from the store.
- **Law.** *O1 — frontier is the tool_result user line preceding the first Edit* — RED: no `frontier`
  key is derived or sealed today.

### O2 — a fork resumes the session cut at the frontier

A fork of a primer that records a frontier spawns
`--resume <primer session_id> --resume-session-at <frontier> --fork-session --session-id <own uuid>`.
A fork of a primer with no frontier spawns exactly as today (no `--resume-session-at`).

- **Mechanism.** `buildInvokerArgs` already emits the fork triplet
  (`--resume`/`--fork-session`/`--session-id`, `src/claude_invoker.ts:1273`); add `--resume-session-at
  <frontier>` when the fork carries one. The runtime fork wiring (`src/runtime.ts:2868`) must read
  `primer.data.frontier` and thread it onto `ctx.fork` (`src/runtime.ts:3191`).
- **Callsite / seam.** `mostRecentSeatPrimer` → `p.fork` → `ctx.fork` → `buildInvokerArgs`; argv captured.
- **Law.** *O2 — the fork carries --resume-session-at <frontier>* — RED (flag never emitted today);
  the paired *no-frontier forks as today* half is a green control.

### O3 — `context_tokens` is the first-write context

A primer with a frontier records `context_tokens` as the context size
(`input + cache_read + cache_creation`) of the assistant line that made the first write call — the
conversation up to and including the frontier, not the seat's last usage. The `max_context_tokens`
ceiling (`src/runtime.ts:2852`) weighs this value.

- **Mechanism.** Replace the last-usage capture (`captureLastContext`, `src/claude_invoker.ts:992`,
  recorded at `src/runtime.ts:3734`) with the usage on the first-write assistant line for a seat that
  wrote; fall back to last usage only when there is no frontier (F1/I3).
- **Law.** *O3 — context_tokens = the first-write assistant usage* — RED: today records the LAST usage
  (900000) where the contract wants the first-write context (150000).

### O4 — files describe the conversation as cut

A file the seat Read *before* its frontier is recorded with the blob it had in the tree when the chair
**started** (so a file the seat later edited keeps its pre-edit blob); a file carried from the forked
primer that the seat did not Read before its frontier keeps the blob the forked primer recorded, never
re-blobbed; a file first Read *after* the frontier is not recorded.

- **Mechanism.** The seal re-blobs every read against the tree at seal (`src/runtime.ts:3725`) and
  unions the forked files re-blobbed (`src/runtime.ts:3701`, contract-rolling-seat-primer O2). The
  frontier must (a) snapshot read blobs at chair start, (b) drop reads after the frontier, (c) leave a
  carried-but-not-reread file at its forked blob.
- **Law.** *O4 — read-then-edited keeps its chair-start blob; a post-frontier read is not recorded* —
  RED: today records a.ts's post-edit blob and c.ts too.

### I1 — a carried file stale at fork time stays stale until re-read before the frontier

Primer P1 records `x.ts@B1`; the tree now holds `B2`; a prime+fork chair that never Reads `x.ts`
seals a primer recording `x.ts@B1`, and the next fork names `x.ts` in `primer_stale_paths`.

- **Mechanism.** Same re-blob-on-reseal defect as O4's carried half (`src/runtime.ts:3725`); staleness
  is computed by comparing the recorded blob to the tree (`src/runtime.ts:2860`).
- **Law.** *I1 — a prime+fork chair that never Reads x.ts reseals x.ts at B1, and the next fork names
  it stale* — RED: today the reseal freshens `x.ts` to `B2`, so the next fork sees no staleness.

### I2 — frontier and first write found across every spawn, in order

A first run that only Reads and hits its turn cap, then a reserve continuation that Reads once more and
then Edits: the frontier is the uuid of the continuation's Read tool_result line, and the file it read
is in `files`.

- **Mechanism.** The invoker already concatenates both spawns' stdout for the seal
  (`sealStdout = stdout + "\n" + second.stdout`, `src/claude_invoker.ts:1926`, `:2041`); the frontier
  parse must run over that concatenation, so a first write in the reserve continuation is found and its
  preceding user line (in the continuation) is the frontier.
- **Law.** *I2 — the frontier is the continuation's Read tool_result, and its file is in files* — RED:
  no frontier is derived at all.

### I3 — a no-write seat records no frontier; context and files as today

A stub that only Reads and seals: the primer has no `frontier` key, `context_tokens` is the last usage,
`files` is every Read, and its next fork carries no `--resume-session-at`.

- **Mechanism.** The frontier parse returns none when no write tool was called; O3's context capture
  falls back to last usage; O4's file cut leaves every read.
- **Law.** *I3 — a write seat gets a frontier while a read-only seat gets none* — RED on the write-seat
  half (a frontier IS derived), with the read-only fallbacks as green controls.

### F1 — no user line before the first write → no frontier

If no `user` line precedes the first write call, the primer records no frontier (I3's fork shape:
whole-session resume) and `context_tokens` is the last usage — never a frontier guessed from another
line or session.

- **Mechanism.** The frontier parse yields none when the first write has no preceding user line; the
  context capture falls back to last usage.
- **Law.** *F1 — a user-preceded write gets that frontier; one with none gets no frontier and
  last-usage context* — RED on the user-preceded half (a frontier IS derived).

### F2 — an unresolvable frontier falls back cold

If the fork's `--resume-session-at` names a uuid the primer session does not hold, the chair re-runs cold with `--session-id` and its
full prompt, never failing; `chair_complete.fork_fallback` names the unresolvable frontier.

- **What the CLI does (claude 2.1.274, probed 2026-09-18).** It exits 1; stderr (so the ChildExitError
  message) reads `No message found with message.uuid of: <uuid>`; stdout holds one result event,
  `subtype: "error_during_execution"`, `is_error: true`, carrying the notice ONLY in `errors: [...]`, with
  no `result` text. `resumeSessionLost` reads `result` text alone, so it cannot see this; the law's run
  seam throws exactly this shape.
- **Mechanism.** A new detector alongside `resumeSessionLost` (`src/claude_invoker.ts:1217`) matching
  the frontier-not-found notice in the exit message or the result event's `errors`, reusing the cold-fallback shape (`forkColdFallback`,
  `src/claude_invoker.ts:1794`) so the chair never fails; the reason names the frontier and reaches
  `chair_complete.fork_fallback` (`src/runtime.ts:3799`).
- **Law.** *F2 — the chair re-runs cold, never fails, and fork_fallback names the unresolvable
  frontier* — RED: today the fork never cuts at a frontier, so this fallback path does not exist.

## Out of scope

`src/**` (the enforcement), `domain_types/**` (seat-primer gains `frontier` via `type_extend` after
the build), chat-completions seats, cutting earlier builds' prompts out of a rolling primer, and
committing or pushing.
