# RED spec — an amend round spends a seat only where the verdict's fix can land

**Contract:** `contract-amend-nearest-makers-v1`
**Criteria:** an amend round spends a seat only where the verdict's fix can land.
**Scope in:** `src/runtime.ts` — the EXAMINE⇄AMEND maker selection.
**Scope out:** verdict content analysis; standards' phase graphs.
**Publishes nothing.** These are RED laws: they fail on today's engine and describe the enforcement that does not exist yet.

## The defect (read from the tree)

`src/runtime.ts` EXAMINE⇄AMEND block (~line 2306) selects the makers to re-invoke as *every* chair in the verify seat's `depends_on` that produces an Artifact:

```ts
const makers = vch.depends_on
  .map((role) => allChairs.find((c) => c.role === role))
  .filter((c): c is Chair => !!c && producesArtifact(c));
```

It never asks whether one of those makers is **upstream of another**. So in build-from-red-spec-v0's shape — `verify ⟵ {attest, build}`, `build ⟵ attest` — an amend round re-invokes **both** attest and build. attest's only role was to feed build (whose fix is where the verdict lands). Re-running attest (a) re-does settled work and (b) hands build a freshly-made attestation instead of the exact record the failing round judged. This is the same over-reach the operator observed in gig `73d79f8c` (attest-laws resumed on every amend round though its inputs never change).

## Obligations, invariants, failure modes → mechanism, callsite, law

Each row's law lives in `tests/spec_amend_reruns_nearest_makers.test.ts` and runs through `runGig`'s real examine loop with a verifier that fails once, counting each chair's invocations.

### O1 — re-invoke only the makers no other maker in the set depends on

> Of today's maker set, an amend round re-invokes only the makers that no other maker in the set depends on, directly or through `depends_on`. A maker upstream of another in the set is not re-invoked; its sealed records from the failing round remain the amend round's inputs.

- **Mechanism to add:** at the callsite above, after computing today's maker set, drop any maker that another maker *in the set* depends on (transitively over `depends_on`). Re-invoke only the resulting sinks.
- **Callsite:** `src/runtime.ts` EXAMINE⇄AMEND, the `const makers = …` selection (~2306) and the `for (const mk of makers)` amend loop (~2317).
- **Law (RED):** `O1 — a maker upstream of another in the set, even transitively, is not re-invoked`. A chain `top ⟵ mid ⟵ base`, `verify ⟵ {base, mid, top}`. Only `top` re-runs; `base` and `mid` are settled. Fails today: base and mid each run twice.

### O2 — the skipped maker's records are carried unchanged

> The skipped maker's records are carried into the round unchanged (same record ids and content_sha), so the re-run makers and the re-verify see exactly what they saw before.

- **Mechanism to add:** because the upstream maker is not re-invoked, its record stays in `producedByRole`, and `prepareChair` gathers it from there unchanged for the downstream maker — same `id`, same `content_sha`.
- **Callsite:** `src/runtime.ts` `prepareChair` frontier gather from `producedByRole` (~2669–2675); the amend loop must not `dropFromProduced`/re-`set` a skipped maker's role.
- **Law (RED):** `O2 — the skipped maker's record is carried into the amend unchanged (same id and content_sha)`. In the build-from-red-spec-v0 shape, build's amend-round `attestation` input must have the same `id` and `content_sha` as its failing-round input. Fails today: attest is re-made, so build is fed a new record (new UUID `id`, different `content_sha`).

### I1 — independent makers all re-run, as today

> Makers that do not depend on each other all re-run, as today. *(Checkable: two independent Artifact makers both depended on by the verifier: both invoked in the amend round.)*

- **Mechanism:** the narrowing removes only makers with a dependant *in the set*; mutually-independent sinks all remain.
- **Callsite:** same selection at ~2306.
- **Law (RED):** `I1 — independent makers both re-run; the shared upstream they consume is not re-made`. A fan `leafa ⟵ base`, `leafb ⟵ base`, `verify ⟵ {base, leafa, leafb}`. `leafa` and `leafb` are two independent makers both depended on by the verifier — both re-run (its own-account direction is green today, since today re-runs everything). The law is RED today on its exact-selection completion: `base` is depended on by both leaves and must be settled, but today it is re-made.

### I2 — build-from-red-spec-v0's shape invokes build, not attest

> In build-from-red-spec-v0's shape (verify depends on attest and build; build depends on attest), an amend round invokes build and not attest. *(Checkable: attest invoked once across the gig, build twice.)*

- **Mechanism:** the exact case the narrowing exists for.
- **Callsite:** selection at ~2306.
- **Law (RED):** `I2 — build-from-red-spec-v0's shape: an amend round invokes build and not attest`. Asserts `attest` invoked once across the gig, `build` twice. Fails today: attest runs twice.

### F1 — never select zero makers

> Never select zero makers: at least the makers with no dependant in the set re-run; a law asserts a non-empty selection for every composed graph shape tested. *(A cycle is impossible in a composed standard, so the narrowing cannot select none.)*

- **Mechanism:** an acyclic `depends_on` graph always has at least one sink among the makers, so the narrowed set is non-empty.
- **Callsite:** selection at ~2306.
- **Law (RED):** `F1 — the amend selection is never empty and never the whole set: exactly the makers with no dependant re-run, for every composed graph shape`. Iterates the enumerated shapes (build-from-red-spec-v0, transitive chain, fan, independent pair) and asserts the re-invoked set is non-empty and equal to the sink makers. RED today: on every shape with a non-sink maker, today re-runs the whole set.

## Testing method

Example-based, through `runGig`'s real examine loop with a verifier that fails once, counting each chair's invocations (acceptance criterion #2) and — for O2 — reading the `OutputRecord.id`/`content_sha` the downstream maker actually receives via the invocation context. The graph-shape space is small and closed (chain / fan / independent), so it is hand-enumerated rather than generated; no property-based engine (fast-check) is added. F1's "every composed graph shape" clause is covered by iterating that enumerated set.

## Controls (stay green)

`tests/examine_amend_loop.test.ts`, `tests/spec_amend_round_carries_its_work.test.ts`, `tests/amend_round_is_not_served_from_cache.test.ts`, `tests/spec_resumed_gig_continues_chair_session.test.ts`. No existing law asserts that a multi-maker set "all re-run" — every examine-loop fixture uses a single maker — so none is rewritten.

## Caveat

This seat is a root agent with no upstream grounding-dossier, so the verification method above was chosen by the seat (per the acceptance criteria) rather than adopted from `method_findings`. The `~line` references are approximate at the inherited `HEAD` (8154df7).
