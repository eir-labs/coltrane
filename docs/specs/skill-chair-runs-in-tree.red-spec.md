# RED spec — contract-skill-chair-runs-in-tree-v1

**A chair's work happens in the gig's tree, whichever kind of seat does it.**

An agent chair already obeys this: the records-by-address seal reads `RunDeps.tree_root` and
*refuses* (`tree_root_unknown`) rather than defaulting to `process.cwd()`. A **skill-backed** chair
does not. Its deterministic code half runs in a child process (`executeSkillAsync`,
`src/skill_subprocess.ts`) that is spawned with **no `cwd` option**, so it inherits the *engine
process's* working directory — the long-lived queue worker's own directory, never the claimed gig's
workspace clone (`src/worker.ts` sets `tree_root: workspace?.dir`; the local dispatch door,
`src/server.ts`, sets it to the genome dir).

A tier-2 skill that runs a command against "the tree" (e.g. `skills/run-vitest-band` spawns
`npx vitest run` with no `cwd`) therefore runs it against the *worker's* directory and reports that
tree's verdict with full provenance — doing B while the record claims A. No shipped standard seats such
a skill today (only `patent-triage-v1`'s pure `verdict-gate`), so the defect is **latent**; every
mechanical seat trips it on its first worker run.

- **Source of the finding:** gig input change-request (read 2026-09-18 while preparing mechanical
  seats, "debate slice 2: attest, integrity and redness as skill chairs").
- **Scope in:** `src/runtime.ts` (skill chair execution), `src/skill_subprocess.ts`
  (`executeSkillAsync` spawn options).
- **Scope out:** runs with no `tree_root` (unchanged), the permission tiers and their filesystem
  grants, the synchronous `executeSkill` used outside `runGig`.
- **Laws:** `tests/spec_skill_chair_runs_in_tree.test.ts`.

## The real callsites (read this run)

- `src/skill_subprocess.ts` — `executeSkillAsync` spawns
  `spawn("node", [...tierFlags(tier, dir), runnerPath(), dir], { stdio: [...], env: skillEnv() })`.
  There is **no `cwd`** in the spawn options, so the child inherits the parent process's working
  directory. (Verified with Read, `src/skill_subprocess.ts` line ~247.)
- `src/runtime.ts` — `executeChair`'s skill branch:
  `const r = await executeSkillAsync(p.skill_dir, skillInput, 120_000, { signal: deps.signal });`
  It forwards no `tree_root`. (Verified with Read, `src/runtime.ts` line ~3103; `deps.tree_root` is
  in scope here — the prime-snapshot block a few lines above uses it.)
- `src/skill_runner.mjs` — the child harness imports the skill via an **absolute** path
  (`resolve(skillDir)`), so the child's `cwd` does not affect its ability to load `skill.mjs`; the
  `cwd` only governs where the skill's own work resolves. (Verified with Read.)

## Verification method

Example-based, at the one real seam the contract's output crosses — a skill-backed chair run through
`runGig`, exactly as `tests/skill_chair_integration.test.ts` drives one. A real skill package
(`meta.json` + `skill.mjs`) is written to a temp directory and registered through `RunDeps.skill_dirs`;
its tier-0 code half returns `process.cwd()` (the child's own working directory) as the sealed output.
`RunDeps.tree_root` is a **separate** temp directory that differs from the test process's cwd, so a
child that honoured it reports a directory the engine process never sat in. Working directories are
compared by **realpath** (on macOS the system temp dir is a `/var → /private/var` symlink and
`process.cwd()` resolves it, so a raw string compare would spuriously differ). `process.cwd()` reads a
process property, not the filesystem, so the tier-0 permission cage is untouched — confirmed by the
sandbox-confinement control staying green.

## Obligations & invariants → laws

| id | statement | mechanism (where the fix must land) | law |
|----|-----------|-------------------------------------|-----|
| **O1** | When `RunDeps.tree_root` is set, a skill chair's code half runs in a child whose working directory is `tree_root`. | `executeChair` forwards `deps.tree_root` to `executeSkillAsync`, which sets `cwd: tree_root` on its `spawn` options. | `O1 — … > the skill child's working directory is tree_root, not the engine process's directory` |
| **I1** | The working directory follows the run, not the engine process. | The `cwd` is chosen from the per-run `tree_root`, not a process-global default; two runs in one process resolve independently. | `I1 — … > two runGig calls in the same process with different tree_roots each report their OWN tree_root` |
| **I2** | A run with no `tree_root` is unchanged. | Absent `tree_root`, no `cwd` is set and the child inherits the engine process's directory, as today; the `tree_root` branch must be a *distinct* branch from this fallback. | `I2 — … > with no tree_root the skill reports the test process's cwd, while a tree_root run in the same process reports its tree_root` |

## Observed RED (this run)

`npx vitest run tests/spec_skill_chair_runs_in_tree.test.ts` — **3 tests, 3 failed**. Every failure is
the child reporting the engine process's directory (`/Users/eugenestuckless/eir/coltrane`) where the
contract requires the run's `tree_root` temp directory:

- **O1** fails at the `cwd = tree_root` assertion (received the engine cwd).
- **I1** fails at run A's `tree_root` assertion (both runs report the one shared engine cwd, so they
  are identical instead of per-run).
- **I2**: the no-`tree_root` half is **green today** (the fallback already inherits `process.cwd()` —
  the unchanged behaviour the contract preserves); the test as a whole is RED at the *contrast*
  assertion — a `tree_root` run in the same process must land in its `tree_root` and not in the
  fallback directory, and today it does not, so the fallback is not a distinct branch at all.

The controls stay green: `tests/skill_chair_integration.test.ts`,
`tests/skill_chair_core_resolution.test.ts`, `tests/skill_chair_server_dispatch.test.ts`,
`tests/skill_abort.test.ts`, `tests/skill_run_vitest_band.test.ts`,
`tests/skill_sandbox_confinement.test.ts` (25 tests passed).
