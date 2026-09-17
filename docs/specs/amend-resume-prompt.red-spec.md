# RED spec — contract-amend-resume-prompt-v1

A resumed amend carries **what is new, not the whole original prompt** (decision 3 of
`contract-chair-session-continuity-v1`, operator 2026-09-17). Today the examine⇄amend loop
re-invokes the maker with `ctx.resume = true` (`src/runtime.ts:2272`, `:2930`), the invoker swaps
`--session-id` for `--resume` (`src/claude_invoker.ts:1450`–`1456`), but the prompt it resumes with
is still the FULL `buildPrompt` output (`src/claude_invoker.ts:1345`) — every layer the resumed
conversation already holds. Each amend round therefore re-pays the round-one prompt the resume
exists to avoid (departure recorded by build gig 40e20568, commit 7adcefd).

These are RED tests: real, running assertions that fail today because the enforcement does not
exist. They observe spawns through `makeClaudeInvoker`'s injected `run` seam and run through
`runGig`'s real examine⇄amend loop — the amend re-invocation is the true callsite.

## Obligations & invariants

Laws live in `tests/spec_amend_resume_prompt.test.ts` unless noted.

- **O1 — the resumed amend carries the failing verdict + an amend-round statement.**
  Mechanism: when `ctx.resume === true`, `buildPrompt` (`src/claude_invoker.ts:138`) emits a trimmed
  prompt that states this is an amend round of the same chair and renders the failing verdict's
  content (its `pass:false` and failing `checks`). Red test: `O1 — the resumed amend prompt carries
  the failing verdict and says it is an amend round` (asserts the failing-check marker survives and
  an `/amend round/i` statement is present — the latter absent today).

- **O2 — the resumed amend re-sends none of the original prompt.**
  Mechanism: the trimmed prompt omits `buildPrompt`'s `# Disposition` / `# Identity` / `# Context`
  layers and the gig input JSON. Callsite: `buildPrompt` layer assembly (`src/claude_invoker.ts:150`–
  `243`). Red test: `O2 — the resumed amend prompt re-sends none of the original prompt`.

- **I1 — a resumed amend prompt is a small fraction of round one.**
  Checkable: with a round-one prompt over 4KB, the amend prompt is under a quarter of its length.
  Red test: `I1 — a resumed amend prompt is under a quarter of a round-one prompt over 4KB`.

- **I2 — a cold amend still receives the FULL prompt.**
  Mechanism: on a resume the run seam reports no conversation for (`resumeSessionLost`,
  `src/claude_invoker.ts:1067`), the main amend path falls back COLD — a fresh `--session-id` spawn
  carrying the full `buildPrompt` — because nothing else carries the chair's context. Today the
  cold fallback (`resumeColdFallback`, `:1556`) is wired only into the reserve-continuation branch
  (`:1603`–`1608`), never the main amend resume, so a lost amend session fails the chair. Red test:
  `I2 — the lost-session fallback re-sends the FULL prompt on a fresh session`.

- **F1 — the lost-session fallback never fails the chair, and is recorded.**
  Mechanism: the fallback is loud, not silent — `chair_complete` (`src/runtime.ts:3364`–`3382`)
  records `resume_fallback` for the seat that fell back (rather than claiming a resume that never
  happened). Refusal: never fail the chair. Red test: `F1 — the lost-session fallback never fails
  the chair, and chair_complete records resume_fallback`.

## Law O3 re-route (in `tests/spec_chair_session_continuity.test.ts`)

O3 previously identified the maker's spawns by the seat line in the prompt text
(`c.prompt.includes('"make" chair')`). Once a resumed amend carries only what is new (O2), the
amend prompt no longer names the seat, so that filter would silently miss it — the exact class of
"does B while the spec says A" this contract closes. O3 is rewritten to identify each spawn by its
**session flag** — the uuid after `--session-id` (round one) or `--resume` (an amend), compared with
`sessionUuidFor(gig_id, role)` — never by prompt text. Its title and every other law in that file
are unchanged, and the file stays green today.

## Controls

`tests/chair_turn_reserve.test.ts`, `tests/examine_amend_loop.test.ts`, and
`tests/spec_amend_round_carries_its_work.test.ts` stay green (the reserve continuation is already
trimmed and out of scope; the amend loop's work-carrying is unchanged).
