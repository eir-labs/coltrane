# Test bands

The suite is organized into **seven bands** across **five vitest configs**. Each band
proves a different property and runs under a different cost/latency profile. The first
band is the fast green gate you run on every change; the heavier bands are run
deliberately.

| band | config | count | what it proves | cost |
|---|---|---|---|---|
| **unit** | `vitest.config.ts` | 80 | pure logic, genome load, registry, hashing, composition, packaging-metadata gates | fast, parallel |
| **integration** | `tests/e2e/vitest.config.ts` | 15 | engine invariants end-to-end (chain-query, provenance, type-fail, hot-reload, schema edges) — no LLM | medium, serial |
| **cognition-live** | `tests/e2e/vitest.config.ts` | 14 | a live agent drives the engine through the MCP surface | **billed** (spawns `claude`), slow |
| **packaging** | `tests/e2e/vitest.config.ts` | 3 | the published tarball installs + boots + works downstream | slow (real `npm install`) |
| **failure-injection** | `tests/failure_modes/vitest.config.ts` | 5 | robustness under hostile conditions: disk-full, mid-flight kill, concurrent writes, malformed genome | medium |
| **honest-broker** | `tests/honest_broker/vitest.config.ts` | 2 | ledger durability: FileLedger append + gig_dispatch contracts | medium |
| **security** | `tests/security/vitest.config.ts` | 1 | prompt-injection resistance | billed, slow |

Total: **120 specs.** 15 of them are **nested-billed** — they spawn their own `claude`
subprocess (the `sub_thread.*`, `*_live`, `skills_*`, `scaffold/*`, `user_drives` family),
so they cost real tokens and take minutes each.

## How each band runs

```bash
# unit — the fast gate (also what `npm run verify` runs after a typecheck)
npm test

# integration + cognition-live + packaging all share the e2e config
npm run e2e
# a single e2e spec:
npx vitest run --config tests/e2e/vitest.config.ts tests/e2e/<spec>.spec.ts

# the standalone configs (no npm script yet — invoke directly)
npx vitest run --config tests/failure_modes/vitest.config.ts
npx vitest run --config tests/honest_broker/vitest.config.ts
npx vitest run --config tests/security/vitest.config.ts
```

## Harnesses

| harness | used by | provides |
|---|---|---|
| `tests/e2e/_harness.ts` | integration, cognition-live | `setupTempdirColtrane` (isolated genome), `spawnClaudeSubthread` (live agent driver), recorder assertions |
| `tests/e2e/_genome_load_check.ts` | integration | genome-load assertions |
| `tests/security/_inject_harness.ts` | security | adversarial-input injection |
| _(none yet)_ | **packaging** | each spec rolls its own build→pack→install scaffold — **shared `_packaging_harness.ts` is a known refactor** |

## Running every band through coltrane

The suite can also be verified *through* coltrane itself: the `e2e-suite-v0` standard
runs a spec as a grounded, sealed gig (the runner executes it under its scoped
`Bash(npx vitest run:*)` grant and emits a verdict; a judge aggregates). The full
coverage manifest — every spec, grouped by band — lives at
`.coltrane/test_execution_plan.json`.
