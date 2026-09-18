# RED spec — no dispatch payload key is silently ignored

`contract-unknown-gig-input-v1`. Laws: `tests/spec_unknown_gig_input.test.ts`. Status: **RED** — the
enforcement does not exist yet; every law fails today on an assertion stating the contract's reason.

## The measured problem

`src/runtime.ts` @52d2dda. The dispatch preflight computes `normalizeKey` (~1516). Inside
`missingGigInput` (~1524) it computes both `nearMiss` — a provided key that normalizes to the needed
one — and `unknown` — every provided key the standard does not declare. **Both exist only inside that
error message, which is raised only when a declared input is absent.** So when every declared input is
present, an undeclared key is neither refused nor mentioned: it is dropped in silence.

A payload carrying both spellings, `grant-requirements` and `grant_requirements`, has one read and one
dropped, and the caller cannot tell which carried their data. In a doctor-facing product the dropped
key is the RFP requirements. The engine already refuses a dead tool grant, an unenforceable skill
permission and a boundary check with a missing term list; an undeclared dispatch key is the same class,
and is currently silent.

## Testing method

Example-based, through `runGig` with a standard composed by `composeStandard` (the
`silent_resolution.test.ts` #244 house pattern) and an in-memory `MemoryLedger`/output store. No model,
no network. I2 uses an `invoke` that **throws if ever called**, so "before any chair fires" is proven,
not asserted. The O2 CLI law goes through `coltrane dispatch`'s own output path via `runCli([...], io)`
with a stderr-capturing `CliIO` — the `tests/spec_spend_survives_kill_failure_resume.test.ts` (O3)
pattern.

The spec introduces one progress-event variant — `{ type: "undeclared_gig_input"; standard: string;
keys: string[] }`, `keys` sorted. It is not in the `GigProgressEvent` union yet, so the laws read
`.type`/`.keys` through a widening cast (`evType`/`keysOf`); `tsc` (build_once's globalSetup) stays
clean and the laws fail at runtime on the missing emission, not at compile time.

## Obligations → mechanism, callsite, law

### O1 — a near-miss is refused even when the declared key is present
**Mechanism.** In the gig-input preflight (`src/runtime.ts`, the `{ … }` block ~1581, before any
`prepareChair`/invoke), for each provided key `K` not in `standardInputs` whose `normalizeKey(K)`
equals `normalizeKey(D)` for a declared input `D` **that is present in `gigInput`**, throw a typed
`RuntimeError` naming the offending key `K`, the declared key `D` it resembles, and the rule that gig
input keys are the hyphenated type slug. It fires **even when `D` is present**, because one of the two
is being dropped and the caller cannot see which.
**Law.** `O1 — a key that normalizes to a declared input FAILS the gig, naming the offending key, the
declared key, and the hyphen rule`. Red today: with the declared key present the preflight passes, the
chair runs, and the gig completes — the observed value is a `GigResult`, not a refusal.

### O2 — every other undeclared key is named, never dropped
**Mechanism.** At the same preflight, collect every provided key not declared and not a refused
near-miss, and emit **one** `undeclared_gig_input` progress event via `emit(...)` (`src/runtime.ts`
~1608) carrying all of them, sorted. This is not a refusal — the gig runs on. `coltrane dispatch`
(`src/cli.ts` `dispatch` case ~469) surfaces them to stderr through `line(io, …)`, naming the standard
that did not declare them.
**Laws.** `O2 — undeclared keys (no near-miss) surface on ONE typed preflight event, and the gig still
completes` (runtime), and `O2 (CLI) — a completing dispatch with harmless metadata writes the
undeclared keys and the standard to stderr`. Red today: no event is emitted and the CLI prints only
`complete — …`.

## Invariants → law

### I1 — an exactly-declared payload is untouched
Keys equal to the declared inputs: no refusal, no event, byte-identical to today.
**Law.** `I1 — exactly the declared keys: no refusal, no undeclared-key event — and the mechanism DOES
fire when a key is undeclared`. The clean half is the invariant; the non-vacuity half (one undeclared
key ⇒ exactly one event) is what makes I1's silence a real guarantee and is red today.

### I2 — the near-miss refusal costs nothing
It fires before any invocation.
**Law.** `I2 — an invoke that THROWS if called is never reached: the near-miss dispatch still fails with
the typed refusal`. Red today with proof of the cost: the observed error is `phase "p0" aborted —
chair(s) failed: N (N: CHAIR_RAN …)` — a real chair ran before the knowable-at-t=0 refusal.

### I3 — all undeclared keys are named, not the first
**Law.** `I3 — three undeclared keys beside the declared one are all named, in sorted order`. Red today:
no event.

## Failure modes → law

### F1 — the missing-input path is preserved
When a declared input is missing **and** the payload carries a near miss for it, the existing
`MissingGigInput` error still fires with its current hint (already law-bound). The new collision refusal
never replaces it or fires twice for the same key — it fires only when the declared key is **present**.
**Law.** `F1 — a missing declared input keeps its MissingGigInput error; the collision refusal fires
only when the declared key is present, and never twice for the same key`. Case A (missing path →
`MissingGigInput`) is a control that holds today; case B (declared present) is red — the near-miss is
dropped rather than refused, and the refused key must not also appear on an `undeclared_gig_input`
event.

## Controls that stay green
`tests/runtime.test.ts`, `tests/chairs.test.ts`, and any suite asserting the current `MissingGigInput`
wording (`tests/silent_resolution.test.ts` #244 neighbourhood). The new refusal fires **only** on the
declared-present path; the missing-input path is untouched — so no existing wording changes.
