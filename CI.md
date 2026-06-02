# CI

GitHub Actions workflows live in `.github/workflows/`. This doc covers what
each workflow does, what's swept, what's deliberately excluded, and how to
read a failure.

## Workflows

### `ci.yml` — single-environment verify

The original gate. Runs `npm run verify` (= `tsc --noEmit && vitest run`) on
`ubuntu-latest` + node 22 only. Fast, deterministic, covers the unit suite.
Stays as the canonical pass/fail signal on every PR + push to main.

### `test.yml` — cross-environment matrix

Sweeps the same `tsc --noEmit` and `vitest run` (unit only) across an
(OS, node) matrix. The point: catch environment-specific regressions that
`ci.yml` would miss because it runs on a single (ubuntu, node-22) cell.

**Matrix cells (4 per job, 2 jobs = 8 cells total):**

| OS             | Node  | typecheck | unit |
| -------------- | ----- | --------- | ---- |
| ubuntu-latest  | 20.x  | yes       | yes  |
| ubuntu-latest  | 22.x  | yes       | yes  |
| macos-latest   | 20.x  | yes       | yes  |
| macos-latest   | 22.x  | yes       | yes  |

`fail-fast: false` — one red cell does not cancel the others. You see the
full failure surface, not just the first to fail.

**Concurrency:** new pushes to the same ref cancel in-progress runs.

**e2e-smoke job:** push-to-main only, single cell (ubuntu, node 22), runs
the `eng_manager` spec — the fastest of the four sub-thread specs. **Currently
documented-but-skipped** (see "e2e gate" below).

### `coverage.yml` — PR coverage comment

Tolerant of the absent coverage config. On every PR:

1. Probes for a vitest `coverage:` block in any `vitest.config.*` file.
2. If present: runs `npx vitest run --coverage`, posts the summary as a PR comment.
3. If absent: emits a workflow notice and exits clean. No red.

Depends on the sibling work in `tonight/miles/phase-15d-coverage-mutation`
landing `@vitest/coverage-v8` + a `coverage:` block in `vitest.config.ts`.

## Deliberately excluded

- **Windows.** Drops two would-be matrix cells. The claude CLI install path
  on Windows is not yet validated for our use, and the band's local
  development is mac+linux. Reintroduce if/when a contributor needs it.
- **claude CLI version sweep.** A future sweep across CLI versions (2.1.x
  matrix) would be valuable for the e2e spec. Not in scope today — the
  e2e job itself is skipped.
- **Node 18.** Vitest 3 + ES2022 work fine on 18 in principle, but the
  `@types/node` devDep is pinned to ^22 and the band ships against ≥20.
- **`write-all` permissions.** Both workflows declare minimal `permissions:`
  blocks. `coverage.yml` adds `pull-requests: write` only because it posts
  the report comment. No `contents: write`, no `id-token: write`, etc.

## e2e gate (open)

The `e2e-smoke` job in `test.yml` is wired but skipped. To enable:

1. Add a step that installs the claude CLI in CI. Candidate install paths:
   - `npm i -g @anthropic-ai/claude-code` (if/when published this way)
   - Anthropic-hosted binary download + install script
   - Bundled in a container image
2. Add `ANTHROPIC_API_KEY` as a repo secret, exported as env to the spec.
3. Pin a known-good CLI version (today: 2.1.160) and document it in this file.
4. Replace the `skip (...)` step with:

   ```yaml
   - run: npx vitest run --config tests/e2e/vitest.config.ts tests/e2e/sub_thread.eng_manager.spec.ts
     env:
       ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
   ```

Until then: the warning surfaces on every push-to-main run so the gap stays
visible.

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
