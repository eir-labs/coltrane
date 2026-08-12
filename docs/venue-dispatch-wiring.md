# Venue → dispatch wiring — the RED spec

**Status:** RED spec. The tests named here FAIL today because the wire does not exist. A downstream
implementation gig (`software-change-pr-v1`) makes them GREEN. Do not implement here.

## The gap this closes

`src/venue_realize.ts` exists and is fully tested in isolation (`tests/venue/`): `realize()` /
`resolveAndRealize()` turn a `Venue` contract into an enforced, observable room — the intersected
tool ceiling per seat (via the shared `venueEffectiveTools`, `src/chart.ts:273`), a credential
allowlist (undeclared-present = fail-closed), a per-gig-distinct `isolation_handle`, idempotent
`teardown()`, and `unknown-venue` refusal on a dead slug.

**Nothing on the live dispatch path calls it.** Today:

- `src/claude_invoker.ts:778` sets `effectiveAllowed = ctx.agent.allowed_tools` and `:736/:877` feed
  that UN-intersected grant into `--allowedTools`. `venueEffectiveTools` has exactly one caller —
  `realize()` — never the invoker.
- `src/claude_invoker.ts:969` spawns `spawn(bin, [...args], { stdio })` with **no `env` key**, so
  Node defaults the child env to the full `process.env`: every ambient credential is inherited.
- `src/runtime.ts:45-82` — `AgentInvocationContext` carries no venue/realization field; the dispatch
  seam `prepareChair → executeChair → deps.invoke` (`runtime.ts:2135`) never resolves a room.

So an agent seated in a venue is merely **able** to be confined, not confined. This spec pins the
wire that confines it **by construction** at spawn — the capability-intersection-at-spawn /
zero-ambient-authority pattern (AgentBound, arXiv:2510.21236; the Vibe-Trading #332
`os.environ.copy()` remediation).

## The chosen wire (what the implementation must build)

Two seams, each pinned by its own test file. Where the contract's five open seams
(`subsystem-contract-venue-dispatch-wiring` CAVEAT) had to be resolved to write running tests, this
is the resolution the tests encode — an implementer may realize it differently only by keeping these
observable obligations true.

### 1. Runtime resolves + realizes, and fails closed — `tests/venue_dispatch/dispatch_calls_realize.test.ts`

- The venue slug and a `venues: Map<string, Venue>` enter through `RunDeps` (resolution seam a).
- When a gig names a venue, `runGig` calls `resolveAndRealize(slug, { venues, seats, ambientEnv,
  credentialsPresent, installsPresent, gigId })` **before** `deps.invoke`, and threads the returned
  `Realization` onto `AgentInvocationContext.realization` (threading seam b).
- On **any** refusal (`unknown-venue`, `credential-breach`, `ceiling-empty`, `wildcard-door`, …) the
  chair aborts fail-closed — `deps.invoke` is never called, nothing is sealed — exactly as an
  unresolvable tool grant rejects (`claude_invoker.ts:793`; the preflight guard).
- `teardown()` is invoked at the chair try/finally end (lifecycle seam e); `isolation_handle` is
  per-gig distinct (`venue_realize.ts:195`).

| obligation | mechanism | callsite | red test |
|---|---|---|---|
| O1 call realize on the live path | `resolveAndRealize(slug, …)` before invoke | `runtime.ts:2135` (before `deps.invoke`) | INV8 |
| O2 thread the realization | `ctx.realization` on the invocation | `runtime.ts:45-82`, `:2135` | INV8 |
| O5 per-gig isolation + teardown | distinct `isolation_handle`; `teardown()` in try/finally | `runtime.ts:2028` (`invokeAndWriteChair`) | INV6, INV7 |
| O6 dead-name refusal | `unknown-venue` → chair abort, no spawn | `venue_realize.ts:231`; `runtime.ts` dispatch | F1 |
| O7 credential breach | `credential-breach` → chair abort | `venue_realize.ts:167` | F2 |
| (F3/F4) any refusal | ceiling-empty / wildcard-door → abort, no fallback | `venue_realize.ts:139/182` | F3, F4 |

### 2. Spawn reflects the realization — `tests/venue_dispatch/spawn_reflects_realization.property.test.ts`

- `--allowedTools` carries EXACTLY `venueEffectiveTools(agent, venue)` — the same oracle R10 uses
  (`src/chart.ts:273`), never a re-inlined intersection, never the raw grant.
- The child-process env is an explicit allowlist object built from `venue.credential_surface`
  (resolution seams c/d), passed as the constructed `env` to the spawn/run seam — so an undeclared
  ambient credential never reaches the child. The injected-run seam receives that env as its 4th
  argument (`claude_invoker.ts:884` is called with 3 today), which is how the test reads it
  deterministically with no real process.

| obligation | mechanism | callsite | red test |
|---|---|---|---|
| O3 intersection at spawn | `--allowedTools = venueEffectiveTools(agent, venue)` | `claude_invoker.ts:736/778/877` | INV1, INV2, INV3 |
| O8 one shared oracle | reuse `venueEffectiveTools`, not an inline set | `chart.ts:273` | INV9 |
| O4 allowlist-derived env | constructed `env` from `credential_surface`, passed to spawn | `claude_invoker.ts:884/969` | INV4, INV5 |
| O9 no-venue unregressed | venue-less dispatch keeps raw grants + inherited env | `claude_invoker.ts:778` | INV10 (regression guard) |

## RED-ness

Every confinement invariant asserts the **strict** effect, not a subset law. On the un-wired path
advertised `=== grants`, so `advertised ⊆ grants` is a tautology; INV1 asserts advertised **EQUALS**
`grants ∩ equipment` and INV2 forces `equipment ⊊ grants` so advertised is **strictly smaller** —
green only once the intersection reaches the spawn. The env invariants are RED because no `env` is
constructed or passed today (the child inherits full `process.env`). The fail-closed invariants are
RED because an un-wired venue-named gig runs to completion instead of aborting.

**INV10 is the one paired regression guard** — green today and green after (the wire must narrow ONLY
when a room is named). It is not a confinement axiom; it exists so a wire that over-narrows a
venue-less dispatch is caught.

## Caveat — assumptions the tests encode

The contract carried an OPEN caveat for five resolution-dependent seams. To ship running tests these
were resolved as above: (a) `RunDeps.venue` slug + `RunDeps.venues` map; (b) the whole `Realization`
threaded onto `ctx.realization`, room realized once per gig; (c/d) the child env is an allowlist over
`process.env` filtered by `credential_surface`, so the INV4/INV5 assertions stay
mapping-independent — an **empty** surface admits zero credentials and an **undeclared** injected
secret is absent, without pinning the exact env-var→credential-class mapping; (e) teardown at the
chair try/finally end. An implementation may differ only by keeping the observable obligations above
true. Out of scope, per the contract: re-testing `realize()` in isolation, and real OS sandboxing
beyond the constructed spawn args/env.
