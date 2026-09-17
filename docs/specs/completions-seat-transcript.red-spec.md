# RED spec — contract-completions-seat-transcript-v1

**Criteria.** A chat-completions seat resumes its own conversation the way a Claude seat does, and is
never told it holds a conversation it does not have.

**The defect this closes.** `buildPrompt` (`src/claude_invoker.ts`) returns the TRIMMED amend prompt
whenever `ctx.resume` is set and `resume_keep_prompt` is not. `makeCompletionsInvoker`
(`src/completions_invoker.ts`) builds its one seed message from `buildPrompt`
(`src/completions_invoker.ts:209` — `const seed: TurnMessage[] = [{ role: "user", content: prompt }]`)
but holds no conversation: `runTurn`'s final `messages` are discarded. So a maker amend on the cheap
door ships one 424-char message reading "resuming the conversation that already holds your disposition,
identity, method, tools and the gig input" while carrying NONE of it (measured against dist@1066df9:
round one 857 chars, amend 424, neither the identity nor the gig input in the amend). A Claude seat is
spared this because the CLI keeps the transcript under its `--session-id`; the completions door has no
equivalent, and DeepSeek/OpenAI-compatible providers bill a re-sent prefix at the cache rate, so an
append-only transcript is both correct and cheap.

**Method.** Example-based, at the two real seams the contract's outputs cross — the maker ⇄ verifier
examine loop through `runGig` on `makeCompletionsInvoker` with a fake `fetchFn` transport whose
requests' `messages` are observed, and `selectChairInvoker` with an env object whose wired file-backed
store writes are observed on disk. This mirrors `tests/spec_completions_seat_every_door.test.ts` LAW 6,
which runs the same loop but never inspects the request messages (which is why it stays green through
the defect). All laws live in `tests/spec_completions_seat_transcript.test.ts`.

Because `tsc` compiles `tests/**` (root `tsconfig.json` `include`), the not-yet-existing
`transcripts` option on `CompletionsInvokerOptions` is passed through an `as CompletionsInvokerOptions`
cast (excess-property safe), the not-yet-existing file-backed store module is never imported (it is
probed only through the file `selectChairInvoker` writes), and every law fails today on a contract
assertion rather than an import or setup error.

## Obligations

### O1 — save the transcript after the turn, whatever the stop
When a transcript store is wired, every completions invocation that has a session id
(`sessionUuidFor(gig_id, role)`) saves `runTurn`'s final `messages` under that id after the turn.
- **Mechanism / callsite:** in `makeCompletionsInvoker` (`src/completions_invoker.ts`), after
  `runTurn` returns and unconditionally on any stop, write `result.messages` to
  `opts.transcripts?.save(sessionUuidFor(ctx.gig_id, ctx.role), result.messages)`.
- **Law:** `O1 — a completions seat saves its transcript … > after the run the store holds the maker's
  and the verifier's transcripts …`. Today the injected store is empty for both the maker and the
  verify session ids (RED: `expected undefined to be truthy`).

### O2 — a maker amend resumes the saved transcript, then one new user message
A maker amend (`ctx.resume` true, `resume_keep_prompt` not true) whose session has a saved transcript
seeds `runTurn` with that transcript followed by exactly one new user message: the trimmed amend prompt
`buildPrompt` builds.
- **Mechanism / callsite:** before building `seed`, when `ctx.resume && !ctx.resume_keep_prompt` and
  `opts.transcripts?.load(sid)` returns a transcript, seed = `[...loaded, { role: "user", content:
  buildPrompt(ctx) }]` (the trimmed prompt buildPrompt already returns on an amend). The full-prompt
  seed path is unchanged for a first invocation.
- **Law:** `O2/I1 — a maker amend re-sends the saved transcript unchanged … > the amend request is
  [round-one user prompt, round-one assistant answer, trimmed amend prompt] …`. Today the amend ships
  one message (RED).

### O3 — a file-backed store, wired by selectChairInvoker from the env object
The engine ships a file-backed `TranscriptStore` that writes one JSON file per session id under a
directory it is given, and `selectChairInvoker` (`src/invoker_selection.ts`) wires it on the
completions path at `COLTRANE_TRANSCRIPTS_DIR` when set, else at
`<COLTRANE_OUTPUTS_DIR or $HOME/.eir/coltrane_outputs>/transcripts`, reading only the env object it is
passed.
- **Mechanism / callsite:** a new store module under `src/` (the port + its file-backed
  implementation, `save` writing `<dir>/<session id>.json`); in the completions branch of
  `selectChairInvoker`, construct it from `env["COLTRANE_TRANSCRIPTS_DIR"] ??
  join(env["COLTRANE_OUTPUTS_DIR"] ?? join(homedir(), ".eir/coltrane_outputs"), "transcripts")` and
  pass it as `transcripts`.
- **Laws:** `O3 — … at COLTRANE_TRANSCRIPTS_DIR when set …` and `O3 — … else under
  <COLTRANE_OUTPUTS_DIR>/transcripts …`. Today no file is written under either directory (RED).

## Invariants

### I1 — resumption is append-only
The amend request re-sends the saved transcript unchanged as its prefix, so a provider's prefix cache
can serve it. **Checkable:** the amend request's messages, minus the last, deep-equal round one's final
messages in order (the round-one user prompt, the assistant answer).
- **Law:** `O2/I1 — …` — `amend.messages.slice(0, -1)` must deep-equal
  `[round1UserPrompt, { role: "assistant", content: <round-one answer> }]`. Today `[]` (RED).

### I2 — only a resume reads a transcript
A first invocation seeds exactly `[its full prompt]` even when the store holds messages for its session
id. **Checkable:** a store pre-loaded under `sessionUuidFor(gig_id, role)`; the first request carries
one message, the full prompt.
- **Law:** `I2 — a first invocation seeds exactly its full prompt … > round one ignores a pre-loaded
  transcript …`. The invariant is a biconditional — a non-resume must NOT read the store (correct
  today, and the law asserts round one ignores a pre-loaded sentinel) AND a resume MUST read it (RED
  today: the amend reads no transcript and ships one message, so `expected 1 to be greater than 1`).
  The failing half is what makes this law red today.

### I3 — a second amend resumes the first amend's transcript
**Checkable:** verifier fails twice; the second amend's prefix deep-equals the first amend's final
messages.
- **Law:** `I3 — a second amend resumes the first amend's transcript …`. Today the second amend ships
  one message; its prefix is `[]` (RED).

## Failure modes

### F1 — a maker amend with no saved transcript
Condition: a maker amend with no saved transcript (no store wired, or nothing saved under its session
id). Refusal: the seat is seeded with the FULL prompt (`buildPrompt` with resume off — identity,
method, gig input), never the resume-only prompt, and the invoker emits a `resume_fallback` event so
`chair_complete` records `resume_fallback: true`; the chair does not fail.
- **Mechanism / callsite:** when `ctx.resume && !ctx.resume_keep_prompt` but no transcript loads,
  rebuild the seed from `buildPrompt({ ...ctx, resume: false })` (the full cold prompt) and emit
  `ctx.onEvent?.({ type: "resume_fallback", … })` — the same event the Claude invoker emits
  (`src/claude_invoker.ts:1880`), which `runtime.ts:3252` folds into `chair_complete.resume_fallback`.
- **Law:** `F1 — a maker amend with no saved transcript …`. Today the amend ships the trimmed
  resume-only prompt (no identity, no gig input) and emits no event (RED on both the full-prompt and
  the `resume_fallback` assertions); the chair completing is the one green co-assertion.

## Controls (must stay green, unchanged)
`tests/spec_completions_seat_every_door.test.ts`, `tests/spec_completions_invoker.test.ts`,
`tests/spec_turn_loop.test.ts`, `tests/spec_reverify_resume_prompt.test.ts`,
`tests/spec_amend_resume_prompt.test.ts`, `tests/spec_seat_context_ceiling.test.ts` — verified green
alongside these RED laws.

## Out of scope
The Claude invoker; `src/turn_loop.ts` semantics; a re-verify of a chat-completions seat (keeps today's
full prompt and fresh transcript); primers and forks for chat-completions seats; a killed gig resumed
under the same id; sealing transcripts into the output store.
