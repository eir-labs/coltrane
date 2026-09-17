# contract-reverify-resume-prompt-v1 — a resumed re-verify carries only what is new

RED spec. The laws are `tests/spec_reverify_resume_prompt.test.ts`; they FAIL today because the
enforcement below does not exist yet. This document names, per obligation, the mechanism and the
callsite the enforcement must land at, and the red law that will turn green when it does.

## The defect

Recorded by build gig 7332d166 (`4c1ed5e`). The examine⇄amend loop's re-verify RESUMES the verifier's
round-one Claude session — `runtime.ts:2346` prepares it with `{ resume: true, keep_prompt: true }` — but
is handed the FULL prompt. `keep_prompt` was introduced (contract-resumed-gig-session-v1) so the SAME
`buildPrompt` could serve BOTH the resuming Claude door and the stateless chat-completions door, whose
examine-loop law (`tests/spec_completions_seat_every_door.test.ts` LAW 6) routes each spawn by the seat
identity IN its prompt. So `buildPrompt` keeps the full prompt whenever `resume_keep_prompt` is set
(`src/claude_invoker.ts:163` — the trim branch is skipped). A resumed Claude conversation already holds
the whole round-one prompt, so every re-verify re-sends it — the exact cold read the resume exists to
avoid. Measured: the re-verify prompt is byte-for-byte the round-one prompt (I1 law: 6864 == 6864 chars).

## The contract (contract-reverify-resume-prompt-v1)

A resumed conversation is sent only what is new; a stateless seat is sent everything. The Claude door
(which resumes) trims the re-verify; the chat-completions door (which is stateless) keeps the full
prompt. `src/completions_invoker.ts` is OUT of scope and must not change — the divergence has to be
achieved on the Claude side.

### O1 — the resumed Claude re-verify is short

**Mechanism.** The Claude invoker, when it is about to spawn a re-verify (`ctx.resume === true &&
ctx.resume_keep_prompt === true` with a resolvable session), must build a SHORT prompt for the spawn
rather than the full stack: a statement that the makers amended their work and the verdict must be
re-derived from the current tree, plus the chair's output contract (its `verdict` output type / seal
directive). It must re-send no `buildPrompt` layer (`# Disposition`, `# Identity`, `# Method`,
`# Context`) and not the gig input — the resumed conversation already holds all of them.

**Callsite.** `src/claude_invoker.ts:1489-1491`, where the invoker chooses `prompt` for the spawn.
Today `resumingWithSession` is true and `prompt = buildPrompt(ctx, …)`, which returns the FULL prompt
because `ctx.resume_keep_prompt` skips the trim at `src/claude_invoker.ts:163`. The trim for a re-verify
must be applied HERE, on the Claude side only, so `fullPrompt` (the cold-fallback prompt, built with
`resume: false`) stays full and `src/completions_invoker.ts:186` is untouched.

**Law.** `O1 — the resumed re-verify re-sends no buildPrompt layer and no gig input, only the amend +
re-derive statement and the output contract`.

### O2 — the stateless chat-completions re-verify keeps the full prompt

**Mechanism.** The chat-completions door holds no conversation, so its re-verify must still carry its
whole context — the seat identity (the signal LAW 6 routes on) and the gig input. Because O1's trim is
applied on the Claude side (not in shared `buildPrompt`), the completions door's `buildPrompt(ctx, …)`
call keeps returning the full prompt, and the two doors DIVERGE: the completions re-verify stays full
while the Claude re-verify shrinks.

**Callsite.** `src/completions_invoker.ts:186` (the completions door's `buildPrompt` call) must remain a
full-prompt call — this file is out of scope, so the enforcement is precisely that the O1 change does
NOT reach it. The law observes this door through `makeCompletionsInvoker`'s injected `fetchFn` seam.

**Law.** `O2 — the completions re-verify carries the seat identity + gig input, and diverges from the
trimmed Claude re-verify`. Its whole-context assertions guard LAW 6; its load-bearing assertion — the
Claude re-verify is a small fraction of the completions re-verify — is red today because both doors send
the full prompt (6864 vs 7265 chars, not the required < ¼).

### I1 — the resumed re-verify is under a quarter of the round-one prompt

**Mechanism.** The direct size consequence of O1. `checkable`: the round-one verifier prompt is over
4KB; the resumed re-verify is under a quarter of it.

**Callsite.** Same as O1. Observed at the spawn boundary through the injected `run` seam.

**Law.** `I1 — a resumed re-verify prompt is under a quarter of a round-one verifier prompt over 4KB`.
Red today: 6864 not < 1716 (round one is re-sent verbatim).

### F1 — a lost re-verify resume falls back cold, full, and never fails the chair

**Mechanism.** A re-verify whose `--resume` finds no conversation has nothing to rely on, so the cold
fallback must re-send the FULL prompt on a fresh `--session-id`, record `resume_fallback`, and never
fail the chair. This is the generic resume fallback (`resumeColdFallback`, `src/claude_invoker.ts:1714`,
reached from `:1792`), which re-sends `fullPrompt` — the full prompt built with `resume: false`. The
fallback only becomes DISTINGUISHABLE from the normal re-verify once O1 trims the normal path; until
then both are full, and the law's red anchor is that the resumed (non-fallback) re-verify is still full.

**Callsite.** `src/claude_invoker.ts:1791-1793` (resolve-lost) and `:1802-1804` (throw-lost) → `:1714`.
`coldArgs`/`fullPrompt` (`:1625-1626`) must stay full for the re-verify path.

**Law.** `F1 — the lost re-verify re-runs COLD with the FULL prompt on a fresh session, records
resume_fallback, and does not fail`. Its red anchor asserts the resumed re-verify (before the fallback)
is trimmed (no `# Disposition`); its guards assert the cold fallback is full, the chair does not throw,
and `chair_complete` records `resume_fallback`.

## Controls (must stay green)

`tests/spec_completions_seat_every_door.test.ts` (LAW 6 — the completions examine loop routes by seat
identity), `tests/spec_resumed_gig_continues_chair_session.test.ts`, `tests/spec_amend_resume_prompt.test.ts`,
and `tests/spec_chair_session_continuity.test.ts`. Verified green alongside the red laws.

## Verification method

Example-based / behavioral. O1, O2, I1, F1 are specific behaviors of a specific spawn (the examine
loop's re-verify), not universal properties over an input space, so each is asserted by driving
`runGig`'s REAL examine⇄amend loop with a verifier that fails once and reading the prompt the re-verify
spawn actually receives — the Claude door through `makeClaudeInvoker`'s injected `run` seam, the
chat-completions door through `makeCompletionsInvoker`'s injected `fetchFn` seam. No property-based
engine is required; the callsite is deterministic given the fixed loop and the injected seams.
