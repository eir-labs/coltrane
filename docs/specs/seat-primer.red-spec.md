# Seat primers — RED spec (contract-seat-primer-v1)

**Criteria:** read once per area, fork warm in every later gig — a primer is a sealed, checkable
starting point, never a hidden input. A primer is primed once per `(agent, area)`, sealed with the
blobs it read, and forked by any later chair of that agent that names the area; staleness is decided
by blobs, and every fork is recorded and never cached.

The laws are `tests/spec_seat_primer.test.ts`. Every one FAILS today on an assertion that states the
contract's reason — the enforcement does not exist yet. They observe spawns through
`makeClaudeInvoker`'s injected `run` seam (captured argument lists and prompts) and run through
`runGig`; compose-time refusals go through `composeStandard`.

## Obligations → mechanism, callsite, law

- **O1 — a `prime: { area }` chair seals a `seat-primer` record.** The engine derives
  `{agent_slug, area, session_id (= sessionUuidFor(gig, role)), commit (HEAD at seal), files:[{path,
  blob_sha}]}` from the chair's session id and its forwarded `Read` events — never typed by the model.
  Callsite: `src/runtime.ts` executeChair (the `chair_complete` seal region, ~3364) reading the
  invoker's stream; `src/claude_invoker.ts` makeClaudeInvoker parses the seat's `Read` tool_use
  events from the run's stdout as `captureOutputWrites` already parses its `output_write` calls.
  Law: *O1 — the record carries {agent_slug, area, session_id, commit}*.

- **O2 — `ChairSchema` gains optional `fork_from: { primer: <area slug> }`.** At the chair's first
  spawn the engine looks up the most recent `seat-primer` for `(this chair's agent_slug, area)` in the
  output store, across gigs, and warm-starts: `--resume <primer session_id> --fork-session
  --session-id <the chair's own (gig, role) uuid>`. Callsite: `src/genome_schema.ts` ChairSchema;
  `src/runtime.ts` ctx construction (~2903); `src/claude_invoker.ts` buildInvokerArgs (~1080, which
  today emits `--session-id` XOR `--resume`, never `--fork-session`). Law: *O2 — the fork's first
  spawn carries --resume <primer sid> --fork-session --session-id <own>*.

- **O3 — `chair_complete` of a forked chair records `forked_from`** (the primer record's id,
  session_id and commit). Callsite: `src/runtime.ts` the `chair_complete` emit (~3364). Law: *O3 —
  chair_complete.forked_from names the primer record's id, session_id and commit*.

- **O4 — at fork time the engine compares each primer file's blob_sha with the working tree**
  (`git hash-object` in `RunDeps.tree_root`). Changed paths are named in the fork's prompt as changed
  since priming and recorded as `chair_complete.primer_stale_paths` (empty when nothing changed).
  Callsite: `src/runtime.ts` fork wiring reading `deps.tree_root` (the same `gitInTree` seam the
  law/change stampers use, ~1009); the prompt is built in `src/claude_invoker.ts` buildPrompt.
  Law: *O4 — a primer file edited after seal is the sole primer_stale_paths entry, and the prompt
  names it*.

- **O5 — a forked invocation is never served from the reuse cache.** A fork carries warm conversation
  the reuse key cannot describe, so serving a cached artifact would replay the reading the fork exists
  to reuse. Callsite: `src/runtime.ts` prepareChair, the `effectiveHit` gate (~2685) that already
  withholds the hit for a resumed amend round — the fork is the second withholding condition.
  Law: *O5 — the fork chair still runs on a warm cache whose key would otherwise hit*.

## Invariants → checkable, law

- **I1 — only a chair with `fork_from` forks; a chair without it spawns exactly as today.** Checkable:
  captured args of a standard with no `fork_from` carry no `--fork-session` (a control that holds
  today), while a `fork_from` chair with a primer present does. Law: *I1 — a plain chair (no
  fork_from) spawns exactly as today: no --fork-session*.

- **I2 — the primer's files list is exactly the set of files its seat Read, each with the blob that
  was in the tree when the primer sealed.** Checkable: a priming stub emitting `Read` events for two
  fixture files seals `files` with both paths and their `git hash-object` values. Law: *I2 — files is
  exactly the seat's reads, each with the git blob that was in the tree at seal*.

- **I3 — a primer is agent-specific: a chair never forks a primer sealed by a different agent, even
  for the same area.** Checkable: primers for `(agent-a, area)` and `(agent-b, area)` exist; a chair
  of agent-b forks agent-b's. Law: *I3 — agent-b's chair forks agent-b's primer, never agent-a's*.

## Failure modes → refusal, law

- **F1 — no `seat-primer` for `(agent_slug, area)`:** the chair runs cold with `--session-id` and its
  full prompt; `chair_complete.fork_fallback: primer_missing`; the chair does not fail. Law: *F1 — no
  --fork-session, chair_complete.fork_fallback: primer_missing, and the chair does not fail*.

- **F2 — the primer's session cannot be resumed** (the run seam reports no conversation for its id):
  cold run as F1, `fork_fallback` naming the reason; the chair does not fail. Law: *F2 — the chair
  does not fail and chair_complete.fork_fallback names the unresumable session*.

- **F3 — a chair declares both `prime` and `fork_from`, or `fork_from` names an area that is not a
  lowercase-hyphen slug:** `composeStandard` refuses, naming the chair and the field. Law: *F3 —
  composeStandard refuses prime+fork_from together, or a non-slug area*.

## Testing method

Example-based assertions against the real seams — each obligation/invariant/failure mode is a
specific behaviour of a concrete callsite (a captured spawn arg list, a `chair_complete` field, a
sealed store record, a compose-time throw), not a universal algebraic property, so property-based
generation would add no coverage a targeted example does not already pin. Spawns are observed through
`makeClaudeInvoker`'s injected `run` seam; sealed records through the shared `OutputStore.all()`;
staleness through a temporary git working tree (`git hash-object`); refusals through `composeStandard`.

## Caveats (unverified / assumed, to reconcile when the enforcement lands)

- The `seat-primer` domain type is registered through `type_register` AFTER this build (out of scope
  here). The laws register a permissive stand-in in the fixture registry so the store can hold the
  record; its `path`/`blob_sha` file shape and repo-relative path convention are assumed to match the
  change-set stamper's (`git hash-object` of the tree-relative path). Align the registered type with
  the stand-in, or adjust I2's `files` shape, if the sealed convention differs.
- O4 assumes the engine threads `RunDeps.tree_root` to the fork's staleness comparison and to the
  invoker (for the prompt). O1/I2 assume the seat's `Read` events reach the primer sealer from the
  invoker's stdout (as `output_write` calls already do); through the injected `run` seam the streaming
  `onEvent` path is bypassed, so the sealer must read the returned stdout, not only forwarded events.
