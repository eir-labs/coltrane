# contract-reverify-carries-amendment-v1 — a resumed re-verify carries the amended inputs, not nothing

RED spec. The laws are `tests/spec_reverify_resume_prompt.test.ts`; they FAIL today because the
enforcement below does not exist yet. This document names, per obligation, the mechanism and the
callsite the enforcement must land at, and the red law that will turn green when it does. It AMENDS
`contract-reverify-resume-prompt-v1` in place: that contract's O1 and I1 are SUPERSEDED (their trim was
too aggressive), while its O2 (completions full prompt) and F1 (cold fallback) are KEPT green untouched
and are renumbered I5 and F2 here.

## The defect

A resumed re-verify BLINDS a tool-less verify seat. `buildReverifyResumePrompt` (`src/claude_invoker.ts:356`)
sends a resumed verify spawn only an amend statement — "re-derive your verdict from the CURRENT working
tree — read the amended artifact as it now stands" — plus the output contract. That is right for
`change-verifier`, which holds `Read` and git and whose evidence IS the tree. It is WRONG for a verify
seat whose evidence arrives as sealed inputs and which grants no tool that can reach a tree: the amended
records are never re-sent, so the seat re-judges round one. Measured live: `session-review-v0`'s
round-two verdict cited round 1 three times and wrote "amendment unreadable" while its own `input_refs`
named the amended record. `release-note-verifier` has the same shape. The amended records ARE available —
`prepareChair` resolves inputs fresh for the re-verify (`src/runtime.ts:2472`) — they are simply dropped
because the trim discarded the whole `buildPrompt` layer stack, inputs and all.

## The contract (contract-reverify-carries-amendment-v1)

Source: `contract-reverify-carries-amendment-v1`, decided by the operator 2026-09-19.

### O1 / O2 — carry every amended input, and nothing already covered

**Mechanism.** `buildReverifyResumePrompt` renders an AMENDED-RECORDS section carrying exactly those
current chair inputs whose engine-stamped `content_sha` is ABSENT from the verify chair's own round-one
sealed record's `input_shas`. An input whose `content_sha` IS in that set is NOT re-sent (the trim
`contract-reverify-resume-prompt-v1` bought is kept). Each carried record renders as
`- <domain_type> (from <agent_slug>): <JSON.stringify(data)>` (mirroring `buildPrompt`'s input block).
When the amended set is empty, the section — its `# Amended records` header included — is omitted entirely.

**Callsite.** `buildReverifyResumePrompt` (`src/claude_invoker.ts:356`) and its call site
(`src/claude_invoker.ts:1692-1693`). The function must receive the amended set (threaded through the
ctx), render it, and compute nothing itself.

**Law.** `I1` (section absent when covered, present when amended) and `I2` (two-input: amended payload
carried, covered payload dropped).

### O3 — the RUNTIME resolves the amended set; the prompt renders it

**Mechanism.** At chair prep for the re-verify round (`prepareChair`, `src/runtime.ts:2472`), the runtime
reads the verify chair's own round-one sealed `OutputRecord` (its `input_shas`, engine-stamped at seal —
`src/runtime.ts:2593`), compares each freshly-resolved input's `content_sha` against it, and threads the
amended subset onto the invocation context (a new `AgentInvocationContext` field). The prompt builder
renders what it is handed; NO model output is read to decide what changed. The round-one record is
reachable at that point via `producedByRole.get(vch.role)` (the failing verdict, not yet overwritten).

**Callsite.** `src/runtime.ts:2472` (the re-verify `prepareChair`) and the new ctx field it threads.

**Law.** `I1`/`I2`/`I3` are all driven through `runGig`'s real examine⇄amend loop, so cutting the
runtime's threading makes every carrying law red — the wire-cut check.

### O4 — the working-tree instruction only to a seat that can reach the tree

**Mechanism.** The "re-derive your verdict from the CURRENT working tree" instruction is emitted ONLY
when the verify seat's effective tool set contains a tree-reading tool. A seat granted none is told
instead that "the carried records are your evidence" and that it holds no tool reaching the tree.

**Callsite.** `buildReverifyResumePrompt`, consulting `ctx.agent.allowed_tools` through the tree-reading
accessor (O5).

**Law.** `I4` — the same fixture built over two agents, one with `Read` granted and one with
`allowed_tools: []`; the tree instruction is present in exactly one and the carried-evidence statement
in the other.

### O5 — the tree-reading tool set lives in ONE named home

**Mechanism.** The set of tools that can read the working tree lives in ONE named home in
`src/tool_providers.ts`, reachable only through an accessor (e.g. `grantsTreeReader(allowed)`), so no
call site re-inlines the oracle — the discipline `HOST_BUILTINS` already keeps (unexported set + accessor,
`src/tool_providers.ts:32-98`).

**Callsite.** `src/tool_providers.ts` — the named set and its accessor.

**Law.** Exercised by `I4`: cutting the tree-reading predicate (so every seat looks tool-less, or every
seat looks tool-holding) makes `I4` red.

## Kept green (renumbered), and the failure modes

### I5 — the stateless chat-completions door keeps the full prompt (was O2)

Unchanged. The completions door holds no conversation, so its keep-prompt re-verify still carries the
seat identity and every gig input via `buildPrompt`. `src/completions_invoker.ts` is OUT of scope and
must not change. Law: `I5` (kept, green before and after).

### F1 — no round-one record findable → carry ALL, loudly

**BUILT 2026-09-22.** `amendedSince` (src/runtime.ts) returns every current input with `carried_all: true`,
and the prompt says so. It now has laws (the F1 describe in the law file), drafted with the build.
The "same record id" in F3 below does not occur on the write path, which mints a new id per seal; F3 is
still guarded, because comparing by id reds I1's covered case (an identical re-seal gets a new id).

When no round-one sealed record is findable for the verify role (the verdict was never sealed, or the
store holds none), the re-verify carries ALL current inputs and records that it did so for want of a
prior round. An absent prior round must never read as "nothing changed" and silently carry nothing — the
absence is loud, and it over-sends rather than under-sends. Enforced by the runtime's amended-set
resolution (O3); in the natural examine⇄amend loop the round-one record always exists, so this failure
mode is covered by the resolution's construction rather than a dedicated red law (recorded, not invented).

### F2 — a lost --resume falls back cold (was F1)

Unchanged: a re-verify whose `--resume` session is gone re-runs COLD with the FULL round-one prompt on a
fresh `--session-id`, records `resume_fallback`, and never fails the chair. The amendment carrying must
NOT fire on that path — the full prompt already holds every input. Law: `F2` (kept, red anchor: the
resumed re-verify before the fallback is trimmed).

### F3 — identity is the content_sha, never the record id

An input record present in round one whose `content_sha` has CHANGED (re-sealed under the same record id)
is treated as amended and carried. Identity for this comparison is the `content_sha`, never the record
id — an amended record re-sealed under a familiar id must not be mistaken for one the seat has already
seen. Covered by `I2`/`I3`: the maker re-seals its artifact under the same `make` record id with a
changed `content_sha`, and the law asserts it IS carried.

## Verification method

Example-based / behavioral. I1–I5 and F2 are specific behaviors of a specific spawn (the examine loop's
re-verify), not universal properties over an input space, so each is asserted by driving `runGig`'s REAL
examine⇄amend loop with a verifier that fails once and reading the prompt the re-verify spawn actually
receives — the Claude door through `makeClaudeInvoker`'s injected `run` seam, the chat-completions door
(I5) through `makeCompletionsInvoker`'s injected `fetchFn` seam. No property-based engine is required;
the callsite is deterministic given the fixed loop and the injected seams.

## Controls (must stay green)

`tests/spec_completions_seat_every_door.test.ts` (LAW 6 — the completions examine loop routes by seat
identity), `tests/spec_resumed_gig_continues_chair_session.test.ts`, `tests/spec_amend_resume_prompt.test.ts`,
and `tests/spec_chair_session_continuity.test.ts`.
