# RED spec — contract-resumed-gig-session-v1

A resumed gig picks up an interrupted chair's OWN conversation; an id collision is a resume, never a
failure. Chair session ids are derived from `(gig_id, role)` (`sessionUuidFor`, src/claude_invoker.ts)
and a resumed gig keeps its `gig_id`, so a chair's first spawn in a resumed gig — and the examine
loop's re-verify — re-opens `--session-id <uuid>` for a session the killed attempt already created.
The CLI refuses that (`Error: Session ID <uuid> is already in use.`). The engine already recovers the
LOST case (`--resume` finds no conversation → cold fallback, contract-amend-resume-prompt-v1); it does
NOT recover the COLLISION case. That is what these laws demand.

Laws: `tests/spec_resumed_gig_continues_chair_session.test.ts`. They observe spawns through
`makeClaudeInvoker`'s injected `run` seam and drive `runGig` — one through the examine loop with a
verifier that fails once, one with `resume_from`. All are RED today.

## Obligations

### O1 — the re-verify resumes, it never collides
**Mechanism / callsite.** The examine loop re-invokes the verify seat at `src/runtime.ts:2309`
(`prepareChair(vch, phase.name, [], { round: round + 1 })`). Only the AMEND makers are prepared with
`{ resume: true }` (`:2301`); the re-verify is not, so the invoker re-opens `--session-id` for the
verifier's own round-one session (`sessionUuidFor(gig, vch.role)`) and the CLI refuses it. The
enforcement: prepare the re-verify with `resume: true` too, so `buildInvokerArgs` (`:1120`) emits
`--resume <uuid>` (no `--session-id`) and `buildPrompt` (`:157`) sends only the "amended, re-derive
from the current tree" continuation.
**Red law.** `O1/I1 — the examine loop's re-verify RESUMES the verifier's session instead of colliding`.

### O2 — a collided `--session-id` spawn is resumed, not failed
**Mechanism / callsite.** The invoker's first-run block, `src/claude_invoker.ts:1618-1631`, only
recovers `resumeRound && resumeSessionLost` and rethrows everything else — a collision fails the
chair. The enforcement adds a collision detector beside `resumeSessionLost` (`:1092`) reading
`Session ID … is already in use` (from the result stream or the exit message), and, when a non-resume
`--session-id` spawn collides, re-spawns ONCE with `withResume(baseArgs, sessionId)` (`:1075`) and a
short prompt saying this chair's previous attempt was interrupted and the current tree is
authoritative. The chair never fails on the collision.
**Red law.** `O2/O3/I1 — a resumed chair whose killed attempt made the session RESUMES it …` (driven
through `runGig` with `resume_from`; asserts no-fail, the `--resume` retry, and the short prompt).

### O3 — a continued chair records `resumed` + `session_id`
**Mechanism / callsite.** `chair_complete` sets `resumed: p.resume === true` at `src/runtime.ts:3445`,
so a collision-resumed chair (whose `p.resume` is false) would report `resumed:false`. The invoker
must emit a resume-on-collision event (cf. the `resume_fallback` event at `:1600`), captured in
`executeChair` (cf. `:2985`) and folded into `chair_complete.resumed`/`session_id`.
**Red law.** `O2/O3/I1 …` — asserts `chair_complete.resumed === true` and the continued `session_id`.

### I1 — a first spawn opens; only a second spawn or a collision resumes
**Mechanism / callsite.** `buildInvokerArgs:1120-1122` opens with `--session-id` and resumes only on
`opts.resume`; the O1/O2 changes add the only other resume trigger (a collision). A first,
non-colliding spawn, and a chair whose work is never amended, stay `--session-id` and never resume.
**Red laws.** `O1/I1 …` (the planner passes first time → spawned once, never resumed) and `O2/O3/I1 …`
(the first spawn opens and collides, only then is `--resume` used — never resume-first).

## Failure mode

### F1 — a resume after a collision that finds no conversation falls back COLD
**Mechanism / callsite.** After the collision retry's `--resume`, reuse `resumeSessionLost` (`:1092`)
and `resumeColdFallback` (`:1599`): a fresh `--session-id` spawn with the full prompt, `resume_fallback`
emitted, the chair never failed.
**Red law.** `F1 — a resume after a collision that finds no conversation falls back COLD and loud`.

## Coverage

Every contract invariant has ≥1 RED law; `uncovered` is empty. Testing method: example-based
behavioural laws over the two real seams (`makeClaudeInvoker`'s injected `run`, and `runGig`), each a
specific spawn/record behaviour rather than a universal algebraic property — no property-based engine
is added.
