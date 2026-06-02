# Stryker Mutation Testing — Baseline Plan

## Status

Config landed at `stryker.conf.json` (repo root). **Baseline mutation run is pending a dedicated
compute window** — stryker is typically 10x–100x the unit-test wall time, and this repo's unit
suite is ~3.5s on this host, so a full-source run is in the 5–30 minute range. The initial config
runs only a representative pair (`src/ledger.ts` + `src/canonical_form.ts`) to keep the first
baseline under five minutes.

## What stryker measures + why it matters

Coverage answers "did the test suite touch this line?". Mutation testing answers the harder
question: "if the line were wrong, would any test notice?".

Stryker rewrites the source with small semantic mutations — flipping `>` to `>=`, swapping `+` to
`-`, replacing return values with `null`, deleting statements, etc. — runs the test suite against
each mutant, and reports:

- **Killed** — at least one test failed on the mutant. Good. The test suite noticed the change.
- **Survived** — every test still passed despite the bug. **Bad.** The code path is either
  untested or the assertions are too loose to catch a real defect there.
- **Timed out** — mutant caused an infinite loop; counted as killed.
- **No coverage** — no test touched the mutated line at all.

Mutation score = killed / (killed + survived). A pure-coverage 100% file can still have a 40%
mutation score if the tests just call the function without asserting on its output.

## Config decisions

- `testRunner: "vitest"` — same runner as the rest of the suite; no duplicate config to maintain.
- `coverageAnalysis: "perTest"` — only re-runs tests that actually hit the mutated line. This is
  the difference between a 5-minute run and a 5-hour run.
- `mutate: [src/ledger.ts, src/canonical_form.ts]` — representative pair. `ledger.ts` is a
  pure-data layer (append-only log mechanics); `canonical_form.ts` is a deterministic
  transform. Both are small, well-tested, and central — ideal proving ground for whether the
  test suite has real assertion teeth.
- **Excluded from `mutate` (per scope brief):**
  - `src/test_topology.ts` — recent landing; let it stabilize.
  - `src/topology_state_space.ts` — does not exist in this branch (noted; will be excluded if it
    lands).
  - `src/subthread_recorder.ts` — does not exist in this branch (noted; will be excluded if it
    lands).
- `concurrency: 4` — conservative for a laptop run; bump on CI.
- `timeoutMS: 60000` — generous timeout per mutant; the unit tests are fast, but stryker
  cold-starts each mutation.
- **Thresholds present but non-breaking:** `high: 80`, `low: 60`, `break: null`. The dashboard
  will colorize results without failing the run. Set `break: 60` in a follow-up once the
  baseline number is known.

## Required devDeps (not installed in this change)

```
npm install --save-dev @stryker-mutator/core @stryker-mutator/vitest-runner
```

Pin both to a matched major; mismatched versions are a common first-run failure mode.

## How to run + read the result

```
npm install --save-dev @stryker-mutator/core @stryker-mutator/vitest-runner   # one-time
npx stryker run                                                                # baseline
open reports/mutation/index.html                                               # HTML dashboard
```

The HTML report lets you drill into each surviving mutant and see exactly what change was made
that no test caught. That's the actionable output — each survivor is either a missing assertion
or a missing test.

## Realistic first-run expectation

- **~60–80% mutation score** = healthy. The suite has real teeth; the surviving mutants are
  edge cases worth following up on.
- **<50%** = alarming. The tests are largely smoke tests — they call functions without checking
  results, or they check shape without checking values.
- **>90%** on a first run = suspicious. Either the file is trivially small (the canonical-form
  module might land here legitimately), or the mutators didn't generate meaningful changes.

The subset baseline (`ledger.ts` + `canonical_form.ts`) will produce something like:

```
-------------------------|---------|----------|-----------|------------|----------|---------|
File                     | % score | # killed | # timeout | # survived | # no cov | # errors|
-------------------------|---------|----------|-----------|------------|----------|---------|
All files                |   xx.xx |       xx |        xx |         xx |       xx |      xx |
 ledger.ts               |   xx.xx |       xx |        xx |         xx |       xx |      xx |
 canonical_form.ts       |   xx.xx |       xx |        xx |         xx |       xx |      xx |
-------------------------|---------|----------|-----------|------------|----------|---------|
```

## What to capture on first real run

Edit this file and fill in:

- [ ] Per-file mutation score for ledger.ts + canonical_form.ts
- [ ] Wall time of the run
- [ ] Top 3 surviving mutants per file (these are the actionable test-gaps)
- [ ] Decision on `break:` threshold for follow-up enforcement PR
- [ ] Plan to expand `mutate[]` to additional files (suggest next: `harmonic_validation.ts`,
      `circle_of_fifths.ts`, `composition.ts`)
