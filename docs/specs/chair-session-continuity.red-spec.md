# RED spec — chair session continuity (`contract-chair-session-continuity-v1`)

A chair's second use in a gig resumes its own `claude` conversation instead of re-reading cold.
The resume is recorded, and a resume that cannot find its session falls back cold, loudly. These
are the RED laws; nothing here is implemented yet — every law FAILS today on the assertion stating
the contract's reason (observed 2026-09-17, `npx vitest run tests/spec_chair_session_continuity.test.ts`
→ 8 failed / 8).

Laws: `tests/spec_chair_session_continuity.test.ts`. Out of scope: chat-completions seats, telling a
resumed seat which files changed, committing/pushing (`src/**`, `agents/**`, `scripts/laws.sh` untouched).

## Grounding — the real callsites the laws bind to

- **Spawn arg list** — `buildInvokerArgs` (`src/claude_invoker.ts:1025`) builds the `claude -p` vector;
  emits neither `--session-id` nor `--resume` today (the CLI supports both, `claude` 2.1.274). Observed
  through `makeClaudeInvoker`'s injected `run` seam (captured arg lists).
- **Reserve continuation** — `src/claude_invoker.ts:1491`, `const continuation = … ${prompt}`, a fresh
  spawn that re-sends the whole original prompt.
- **Examine⇄amend re-invocation** — `src/runtime.ts:2251-2265` re-invokes each maker with the failing
  verdict as input, on a fresh spawn.
- **`chair_complete`** — emit at `src/runtime.ts:3338` (type `:197-223`): no `session_id`, no `resumed`.
- **Reuse lookup** — `lookupReuse` (`src/runtime.ts:2338`) keys on inputs/agent/skills; the
  conversation is not among them, so a resumed invocation must be made ineligible, not served.

## Obligations → mechanism, callsite, law

| id | obligation | mechanism / callsite (to build) | red law |
|----|------------|--------------------------------|---------|
| O1 | every spawn passes `--session-id <uuid>`, deterministic in `(gig_id, role)`, RFC 4122; no `gig_id` → no flag | derive the uuid from `(ctx.gig_id, ctx.role)` and add `--session-id` in `buildInvokerArgs`/`makeClaudeInvoker` | `O1 — the spawn carries --session-id <uuid>; …` |
| O2 | the reserve continuation `--resume`s that session (no second `--session-id`) and carries only the new text | at `src/claude_invoker.ts:1491`, swap the fresh spawn for `--resume <uuid>` and drop the embedded `${prompt}` | `O2 — the turn-budget reserve continuation RESUMES …` |
| O3 | an amend re-invocation `--resume`s the maker's own prior-round session, feeding only the failing verdict | at `src/runtime.ts:2251`, thread the resume onto the re-invocation's spawn | `O3 — an amend round RESUMES the maker's own session …` |
| O4 | `chair_complete` records `session_id` (uuid) and `resumed` (bool) | add both fields at the emit, `src/runtime.ts:3338` (+ the event type) | `O4 — chair_complete records the seat's session_id …` |
| O5 | a resumed invocation is never served from the reuse cache | short-circuit `lookupReuse` (`src/runtime.ts:2338`) for a resumed chair | `O5 — a RESUMED (amend-round) invocation is never served …` |

## Invariants → law

- **I1** (determinism + isolation): same `(gig_id, role)` ⇒ same uuid; two roles in one gig, or one
  role in two gigs, never share. Law derives for `(g1,a),(g1,a),(g1,b),(g2,a)` and asserts
  first-two-equal / others-distinct / all match the UUID pattern.
  → `I1 — the session uuid is deterministic in (gig_id, role) …`
- **I2** (a first invocation never resumes): round one carries `--session-id`, never `--resume`.
  → `I2 — a first invocation opens a session, it never resumes one`

## Failure mode → law

- **F1**: a resume whose session cannot be found (deleted transcript, different machine/room) must
  re-run cold with `--session-id` and the full prompt, record `resumed:false` with `resume_fallback`
  naming the reason, and never fail the chair or fall back silently. The law scripts a resume that
  returns `error_during_execution` / "No conversation found with session ID" and asserts the invoker
  does not throw and re-runs cold with the full original prompt.
  → `F1 — a resume whose session is gone falls back COLD and loud …`

## Testing method

Axiomatic + example-based (vitest — no property-based dependency added). The universal properties —
I1's determinism/isolation and O1's RFC-4122 shape — are asserted axiomatically over the uuids
observed at the spawn seam (`(g1,a),(g1,a),(g1,b),(g2,a)` + a UUID pattern), the contract's own
`checkable`. The specific behaviours (O2/O3/O4/O5/F1) are example-based against the real callsites: the
spawn through `makeClaudeInvoker`'s injected `run` seam, and O3/O4/O5 through `runGig` (O3 through its
examine⇄amend loop). Controls kept green and unmodified: `chair_turn_reserve`, `prompt_delivery_stdin`,
`invoker_cage`, `examine_amend_loop`, `spec_seat_effort_is_declared` (43 tests passing).
