# CI

GitHub Actions workflows live in `.github/workflows/`. This doc covers what
each workflow does, what's swept, what's deliberately excluded, and how to
read a failure.

## The band table (#262)

Five vitest configs. Every one has a script; every script runs in CI or carries a written
exemption. `tests/test_band_wiring.test.ts` asserts this table closes and goes red if a new
test file matches no config, a config is run by no script, or a band script goes dark.

| config | npm script | CI job | notes |
| --- | --- | --- | --- |
| `vitest.config.ts` | `npm test` (bare `vitest run`) | `ci.yml: verify`, `test.yml: unit` | the fast unit band |
| `tests/failure_modes/vitest.config.ts` | `npm run test:failure-modes` | `ci.yml: verify`, `test.yml: bands` | |
| `tests/honest_broker/vitest.config.ts` | `npm run test:honest-broker` | `ci.yml: verify`, `test.yml: bands` | excluded from the root config so it runs once, under the config written for it |
| `tests/security/vitest.config.ts` | `npm run test:security` | `ci.yml: verify`, `test.yml: bands` | spend-gated: collects + skips unless `COLTRANE_LIVE=1` |
| `tests/e2e/vitest.offline.config.ts` | `npm run e2e:offline` | `ci.yml: verify`, `test.yml: e2e-offline` | the e2e specs that need no model |
| `tests/e2e/vitest.config.ts` | `npm run e2e` | **none — exempt** | needs the claude CLI + `ANTHROPIC_API_KEY`; see "e2e gate" |

`npm run verify` chains every non-exempt script, so local-green and CI-green mean the same
thing. Before this, `ci.yml` ran `npm run verify` while `test.yml` and `coverage.yml` ran
`npx vitest run` directly — root-config only — so CI executed a strictly smaller set than the
gate developers ran, and neither number matched the "481 tests" `ci.yml` claimed.

## Workflows

### `ci.yml` — single-environment verify

The canonical gate. Runs `npm run verify` on `ubuntu-latest` + node 22 only — that is every
deterministic band, not just the unit suite. Stays the pass/fail signal on every PR + push.

### `test.yml` — cross-environment matrix

Sweeps typecheck + the bands across an (OS, node) matrix. The point: catch
environment-specific regressions that `ci.yml` would miss because it runs on a single
(ubuntu, node-22) cell.

**Matrix cells (4 per job × 3 matrixed jobs, plus 1 single-cell job):**

| OS             | Node  | typecheck | unit | bands |
| -------------- | ----- | --------- | ---- | ----- |
| ubuntu-latest  | 20.x  | yes       | yes  | yes   |
| ubuntu-latest  | 22.x  | yes       | yes  | yes   |
| macos-latest   | 20.x  | yes       | yes  | yes   |
| macos-latest   | 22.x  | yes       | yes  | yes   |

`fail-fast: false` — one red cell does not cancel the others. You see the
full failure surface, not just the first to fail.

**Concurrency:** new pushes to the same ref cancel in-progress runs.

**e2e-offline job:** single cell (ubuntu, node 22), on every PR and push. Builds, then runs
`tests/e2e/vitest.offline.config.ts` — the e2e band minus the specs that spawn the real CLI.
It replaces the old `e2e-smoke` stub, which echoed a warning, exited 0, and only ran on
push-to-main, leaving all 36 e2e files executing nowhere.

### `coverage.yml` — PR coverage comment

Tolerant of the absent coverage config. On every PR:

1. Probes for a vitest `coverage:` block in any `vitest.config.*` file.
2. If present: runs `npm test -- --coverage`, posts the summary as a PR comment.
3. If absent: emits a workflow notice and exits clean. No red.

Root band only, deliberately: it is the band that exercises `src/**` broadly, and the other
bands drive subprocesses that v8 coverage cannot see. It goes through `npm test` rather than
a bare `npx vitest run` so the workflow and package.json cannot drift apart.

Depends on the sibling work in `tonight/miles/phase-15d-coverage-mutation`
landing `@vitest/coverage-v8` + a `coverage:` block in `vitest.config.ts`.

## Deliberately excluded

- **Windows.** Drops two would-be matrix cells. The claude CLI install path
  on Windows is not yet validated for our use, and the band's local
  development is mac+linux. Reintroduce if/when a contributor needs it.
- **claude CLI version sweep.** A future sweep across CLI versions (2.1.x
  matrix) would be valuable for the live e2e specs. Not in scope today — the
  live half of the band does not run in CI at all yet.
- **Node 18.** Vitest 3 + ES2022 work fine on 18 in principle, but the
  `@types/node` devDep is pinned to ^22 and the band ships against ≥20.
- **`write-all` permissions.** Both workflows declare minimal `permissions:`
  blocks. `coverage.yml` adds `pull-requests: write` only because it posts
  the report comment. No `contents: write`, no `id-token: write`, etc.

## e2e gate (open — the LIVE half only)

The offline half of the e2e band runs on every PR (`test.yml: e2e-offline`). What remains open
is the live half: the specs listed in `LIVE_CLAUDE_SPECS` in
`tests/e2e/vitest.offline.config.ts`, which spawn the real `claude` CLI.

That list is an **exclude**, not an allowlist, on purpose: a new e2e spec is in the CI job by
default, and only lands on the list if someone puts it there deliberately. `npm run e2e` (the
full band, live) is the one script `tests/test_band_wiring.test.ts` exempts from the
CI-coverage assertion, and the exemption carries its reason inline.

To close it:

1. Add a step that installs the claude CLI in CI. Candidate install paths:
   - `npm i -g @anthropic-ai/claude-code` (if/when published this way)
   - Anthropic-hosted binary download + install script
   - Bundled in a container image
2. Add `ANTHROPIC_API_KEY` as a repo secret, exported as env to the spec.
3. Pin a known-good CLI version (today: 2.1.160) and document it in this file.
4. Add a job that runs the full band, and drop the `e2e` entry from `CI_EXEMPT` in
   `tests/test_band_wiring.test.ts`:

   ```yaml
   - run: npm run e2e
     env:
       ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
   ```

   The same key would let the security band run for real:
   `COLTRANE_LIVE=1 npm run test:security`. Both spend money on every run — that is the
   decision being deferred, and it is now the only thing being deferred.

Until then the gap is visible in exactly one place — `CI_EXEMPT` — rather than in a job that
echoes a warning and exits 0.

## Interpreting failures

A failure on a specific matrix cell tells you something narrower than "the
code is broken." Triage by cell:

- **One cell red, three green** → environment-specific. Look at the (OS,
  node) of the red cell and diff against the green ones. Common causes:
  case-sensitive imports (linux vs mac), Node API surface changes between
  20 and 22, native dep prebuilds.
- **Both macos cells red, ubuntu green** → macOS-specific. Often path
  separators, fs case sensitivity, or HFS+/APFS quirks.
- **Both node-20 cells red, node-22 green** → node-version gap. Check
  `@types/node` and any API used that landed in 22.
- **All cells red** → real bug, not environment. Same signal `ci.yml`
  would have given.
- **typecheck red, unit green** → ts surface drift; unit suite doesn't
  exercise the broken types yet (or vitest transpiled past them — see
  band-note on "green tests ≠ it works").
- **coverage.yml red** → coverage config exists but the run failed.
  Usually missing `@vitest/coverage-v8` devDep, or a thresholds gate.

## Status badge

Not added to README in this changeset (`README.md` is out of scope here).
When wiring badges, the URLs are:

- `https://github.com/<owner>/<repo>/actions/workflows/ci.yml/badge.svg`
- `https://github.com/<owner>/<repo>/actions/workflows/test.yml/badge.svg`
- `https://github.com/<owner>/<repo>/actions/workflows/coverage.yml/badge.svg`
