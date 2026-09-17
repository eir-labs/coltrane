# contract-rolling-seat-primer-v1 — RED spec

**Criteria.** Every build primes; the next forks; a primer too large to be worth forking is
**replaced, never forked.**

This rolls the standing seat-primer (`contract-seat-primer-v1`, sealed 117cf6b) forward. That
contract made a `prime` chair and a `fork_from` chair **mutually exclusive** (its F3, refused at
`composeStandard`), so a build could never fork the latest primer and seal a fresher one — and a
primer sealed from a whole build seat (measured 2026-09-17: 200k–340k tokens) forked unbounded would
start every later build at that size and re-read it every turn. This contract lets one chair **prime
and fork the same area** (a build primes it and forks the prior primer of it), records each primer's
**context size**, and adds a **`max_context_tokens` ceiling** on `fork_from` that replaces a bloated
primer instead of forking it.

The laws below are RED by design: the enforcement they demand does not exist yet. Each FAILS today on
an assertion stating the contract's reason, never on an import or a setup error. Compose refusals go
through `composeStandard`; runtime behaviour is observed through `makeClaudeInvoker`'s injected `run`
seam (captured argv + the seat's Read/usage stream) and run through `runGig`.

Scope in: `src/genome_schema.ts`, `src/composition.ts`, `src/runtime.ts`, `src/claude_invoker.ts`.
Scope out (unchanged, and NOT touched by this red-spec): `src/**` enforcement, `scripts/laws.sh`,
`agents/**`, `domain_types/**`, and any commit/push.

**Testing method.** Example-based, at the two seams the contract's outputs cross:
`composeStandard(def)` for the admissibility rule (a specific chair shape is admitted or refused, so an
example chair is the exact unit), and `runGig` over a standard whose chair carries `prime`/`fork_from`,
with the spawn's argv and the sealed `seat-primer` record read back, for the runtime obligations. No
property-based engine is warranted: every invariant here is a specific behaviour of a specific chair
shape, not a universal property over a generated domain (no engine is added to the repo).

A chair that BOTH primes and forks the same area is the state O1 will ADMIT but `composeStandard`
REFUSES today, so the runtime laws attach `fork_from` onto a validly-composed prime-only chair
(post-compose) to exercise the real runtime `Chair` shape through `runGig` without the law dying on the
compose throw O1 is itself red against; each such law states that reason at its callsite.

---

## Obligations

### O1 — same-area prime+fork admitted; different areas refused, naming both
A chair may declare `prime` and `fork_from` naming the SAME area. `composeStandard` refuses only a
chair whose `prime.area` differs from its `fork_from.primer`, naming the chair and both areas.

- **Mechanism / callsite.** `src/composition.ts:312` — the `if (ch.prime && ch.fork_from) throw`
  block (contract-seat-primer-v1 F3) is replaced by a comparison: refuse only when
  `ch.prime.area !== ch.fork_from.primer`, and put both area slugs into the message. The lowercase-
  hyphen slug check (`composition.ts:319`) is unchanged.
- **Laws.**
  `tests/spec_rolling_seat_primer.test.ts` — “O1 … a chair that primes AND forks the SAME area is
  ADMITTED” (`.not.toThrow`, red today) and “… DIFFERENT areas is refused, naming the chair AND both
  areas” (`.toThrow(/area-a/)`, `.toThrow(/area-b/)`, red today).
  `tests/spec_seat_primer.test.ts` — the REWRITTEN F3 first law “prime+fork_from of the SAME area is
  ADMITTED; DIFFERENT areas are refused, naming the chair and both areas” (its sibling non-slug law
  stays green).

### O2 — a prime+fork chair seals a fresher primer: own session, files = forked ∪ own
A chair that forked a primer AND primes the area seals a new `seat-primer` whose `session_id` is its
own `(gig_id, role)` uuid (the fork), and whose `files` are the UNION of the forked primer's files and
the paths its own seat Read, each with its blob at seal. The next fork resumes this fresher session.

- **Mechanism / callsite.** `src/runtime.ts:3609-3634` — the `chair.prime` seal. Today `files` is the
  seat's own reads only. When the same chair also has `chair.fork_from` with a resolved primer
  (`PreparedChair.fork`, resolved at `runtime.ts:2791-2815`), the seal must union that primer's `files`
  (carried on the fork record — extend the `fork` prep to keep the primer's `files`, not only its
  `primer_id`/`session_id`) with the seat's own reads, de-duped by path, each re-blobbed at seal. The
  `session_id` is already the chair's own `(gig, role)` uuid (`runtime.ts:3611`).
- **Law.** `tests/spec_rolling_seat_primer.test.ts` — “O2 … the resealed primer's files are the forked
  primer's files ∪ its own reads, under its own session” (union assertion red today: the reseal keeps
  only its own reads).

### O3 — every seat-primer records its context size at seal
Every `seat-primer` records `context_tokens`: the context size (`input + cache_read + cache_creation`)
of the last usage its seat reported before sealing.

- **Mechanism / callsite.** `src/runtime.ts:3628` — the `seat-primer` `data` object gains
  `context_tokens`. The value is the last assistant usage's context — the same sum `#seat-metrics`
  already folds as `lastAssistantContext` (`runtime.ts:3157-3162`). Under the injected `run` seam
  streamed assistant events do not reach `onEvent`, so the invoker must parse the last usage from the
  returned stdout and forward it, exactly as it already parses a prime seat's reads
  (`captureReadPaths`, `src/claude_invoker.ts:909`, emitted as `seat_reads` at
  `claude_invoker.ts:1876`) — a companion `captureLastContext` emitted the same way.
- **Law.** `tests/spec_rolling_seat_primer.test.ts` — “O3 … context_tokens = input + cache_read +
  cache_creation of the LAST usage the seat reported” (asserts the LAST of two usages, red today: no
  primer records a context size).

### O4 — a `max_context_tokens` ceiling replaces a bloated primer, never forks it
`fork_from` gains optional `max_context_tokens`. When the latest primer's `context_tokens` exceeds it,
the chair does not fork: it runs cold with `--session-id` and its full prompt, and `chair_complete`
records `fork_fallback: primer_too_large`. If the chair also primes, its cold reads seal a fresh, small
primer.

- **Mechanism / callsite.** `src/genome_schema.ts:240` — `fork_from` gains
  `max_context_tokens: z.number().optional()`, mirrored on the composition `FlowChair.fork_from`
  (`src/composition.ts:94`) and the runtime `FlowChair.fork_from` (`src/runtime.ts:94`). The decision
  is at the fork wiring `src/runtime.ts:2791-2815`: when a primer resolves and
  `max_context_tokens !== undefined && primer.context_tokens > max_context_tokens`, set
  `fork_fallback = "primer_too_large"` and leave `fork` undefined — so the spawn carries no
  `--fork-session`/`--resume` (a cold `--session-id` open, `src/claude_invoker.ts:1197-1202`) and
  `chair_complete` records the fallback (`runtime.ts:3679`, the `p.fork_fallback` branch). A ceiling-
  blocked chair that also primes still seals its `chair.prime` primer from its cold reads
  (`runtime.ts:3609`).
- **Laws.** `tests/spec_rolling_seat_primer.test.ts` — “O4 … a fork over a too-large primer runs COLD
  … and records fork_fallback: primer_too_large” and “… a ceiling-blocked chair that ALSO primes does
  not fail, and its cold reads seal a fresh primer” (both red today: the ceiling is ignored and the
  fork warm-starts).

---

## Invariant

### I1 — absent the ceiling, the fork happens whatever the size
Without `max_context_tokens`, a `fork_from` chair forks the latest primer whatever its size (today's
behaviour). Checkable: a primer with `context_tokens` 500000 and no ceiling — the spawn carries
`--fork-session`.

- **Mechanism / callsite.** `src/runtime.ts:2791-2815` — with `max_context_tokens` absent there is no
  size comparison, so `fork` is set for any resolved primer and the warm-start proceeds
  (`--fork-session`, `src/claude_invoker.ts:1197`). This is the standing behaviour, and the law pins it
  as the COMPLEMENT of O4: size gates the fork ONLY through the ceiling.
- **Law.** `tests/spec_rolling_seat_primer.test.ts` — “I1 … a 500000-token primer with no ceiling is
  forked; a ceiling below it is the ONLY thing that suppresses the fork.” The no-ceiling half is the
  standing behaviour (holds today and must keep holding); the with-ceiling half is red today (O4
  unbuilt), which is what makes the law fail on I1's discrimination rather than a claim that would hold
  whether or not `max_context_tokens` ever means anything.

---

## Failure mode

### F1 — prime+fork the same area with no primer yet: cold, `primer_missing`, seals the first primer
A chair primes and forks the same area but no primer exists yet: it runs cold
(`fork_fallback: primer_missing`), its reads seal the first primer, and the chair does not fail.

- **Mechanism / callsite.** Admissible only once O1 lands (`src/composition.ts:312`). At runtime the
  fork wiring finds no primer (`src/runtime.ts:2794`) → `fork_fallback = "primer_missing"`, no fork; the
  `chair.prime` seal (`runtime.ts:3609`) still writes the first `seat-primer` from the cold reads; the
  chair never throws.
- **Law.** `tests/spec_rolling_seat_primer.test.ts` — “F1 … prime+fork of the same area is admissible,
  and with no primer it colds, records primer_missing, and does not fail.” The admissibility assertion
  (`composeStandard(...).not.toThrow`) is red today; the cold-reseal behaviour is exercised on the
  post-attached runtime chair.

---

## Coverage

| id | law | file |
|----|-----|------|
| O1 | prime+fork same area admitted; different areas refused naming both | `tests/spec_rolling_seat_primer.test.ts` (and the rewritten F3 in `tests/spec_seat_primer.test.ts`) |
| O2 | resealed primer files = forked ∪ own reads, own session | `tests/spec_rolling_seat_primer.test.ts` |
| O3 | context_tokens = last usage's input+cache_read+cache_creation | `tests/spec_rolling_seat_primer.test.ts` |
| O4 | too-large primer runs cold, fork_fallback: primer_too_large | `tests/spec_rolling_seat_primer.test.ts` |
| I1 | no ceiling → forks any size; a ceiling is the only suppressor | `tests/spec_rolling_seat_primer.test.ts` |
| F1 | prime+fork no primer → cold, primer_missing, seals first primer | `tests/spec_rolling_seat_primer.test.ts` |

`uncovered` is empty. Controls kept green (named in the change request):
`tests/spec_chair_session_continuity.test.ts`, `tests/spec_resumed_gig_continues_chair_session.test.ts`,
`tests/spec_seat_effort_is_declared.test.ts`, and every law of `tests/spec_seat_primer.test.ts` other
than its rewritten F3 first law.

**Observed red (this run, `npx vitest run`):** `tests/spec_rolling_seat_primer.test.ts` — 8 tests, 8
failed; `tests/spec_seat_primer.test.ts` — 12 tests, 1 failed (the rewritten F3 first law), 11 passed;
the three named controls — 23 passed. Every rolling-primer failure is an assertion stating the
contract's reason (admissibility, files union, context size, ceiling refusal), never an import or setup
error.
