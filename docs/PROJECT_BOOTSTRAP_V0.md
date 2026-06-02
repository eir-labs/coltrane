# project-bootstrap-v0 — the seed that plants seeds

The double-diamond × safe-prereg discipline that births a new coltrane-flavored project. **Coltrane-oss is the meta-seed. Each scaffolded project is its own seed. The bootstrap standard is the planting motion.**

## When this runs

Once, when a new project repo is forked/cloned from coltrane-oss. Two execution surfaces (same score):

**Conductor mode (default — most users)**: The Claude Code thread the user is already in IS the conductor. The user says:

> "let's do project-bootstrap-v0"
> *— or —*
> "I'd like to scaffold a new research-brief project"

Claude reads `standards/project-bootstrap-v0.json`, walks the phases conversationally, and prompts the user at each seal-seam. No separate CLI invocation. The thread is the gig.

**Dispatch mode (power user)**: Conductor uses Claude Code's `Task` tool with `subagent_type=<phase.agent>` to spawn a separate Claude (compiled from `.claude/agents/<agent>.md`) for each phase. Isolated context per phase, parallelizable. Useful when phases are heavy or want clean separation. Also accessible via CLI:

```bash
coltrane dispatch project-bootstrap-v0 --use-case <code-changes | research-briefs | operations | idea-exploration | bare>
```

Either way: the standard JSON is the score. Mode is just the conductor's seat.

## Conductor mode protocol

When Claude reads this standard in conductor mode:

1. **Discover** — Claude asks the user what kind of project (or scans cwd for hints). Surfaces tensions inline.
2. **Define** — Claude proposes the charter: `predict`, `kill`, `apoha`, `use_case`. User reviews + refines.
3. **Seam 1 seal** — Claude asks: *"ready to seal the charter? (yes / no / refine)"*. On yes: computes `sha256_pre_verdict` over `{predict, kill, apoha}`, writes ledger entry, freezes the sealed fields. On no: stays in DEFINE for iteration.
4. **Develop** — Claude generates the project files (or proposes them inline for the user to approve). Charter fields are FROZEN; only observation appendable.
5. **Seam 2 / Seam 3** — implicit (charter freezes at seam 2; verdict scope freezes at seam 3 when deliverables are sealed).
6. **Deliver** — Claude commits, runs preseed e2e specs, computes verdict, chimes welcome.

The user may interject at any phase: refine, abort, request honest-broker pass, adjust apoha. The conductor accommodates.

## The double-diamond shape

```
problem space  ─►  ┌─────────────┐         ┌─────────────┐  ─►  solution space
                   │  DISCOVER   │ ── SEAM │   DEFINE    │
expand            └─────────────┘  1     └─────────────┘                 contract
                                                                                  │
                                                                                  ▼
                                                                          ──── SEAM 2 ────
                                                                                  │
                   ┌─────────────┐         ┌─────────────┐                       │
contract  ◄─       │   DELIVER   │ ── SEAM │  DEVELOP    │  ◄── expand          │
                   └─────────────┘  3     └─────────────┘                       │
                                                                                  │
                                                                                  ▼
                                                                            VERDICT
```

Two diamonds (D1 = problem space, D2 = solution space). Three seams between four phases. **Each seam carries a sealed pre-reg cut** — the apoha-discipline applied at every transition.

## The 4 phases

| phase | agent | role | seam behavior |
| :-- | :-- | :-- | :-- |
| **DISCOVER** | `domain-explorer` | Diverge. Survey use-case. Scan cwd. Output domain-survey naming candidates + tensions. | — |
| **DEFINE** | `problem-definer` | Converge. Name the falsifiable: predict + kill + apoha. Emit project-charter. | **SEAM 1**: charter SEALED (sha256_pre_verdict computed) |
| **DEVELOP** | `solution-developer` | Diverge. Generate files: `.coltrane/`, `.claude/`, `CLAUDE.md`, `tests/e2e/preseed/`, `tonight/`, `README.md`. | **SEAM 2**: charter fields FROZEN; only observation appendable |
| **DELIVER** | `delivery-finalizer` | Converge. `git init` + first commit + run preseed e2e + ripen the charter + chime welcome. | **SEAM 3**: verdict scope FROZEN; verdict appended |

## The safe-prereg discipline

The framework's signature discipline (predict + kill + apoha + sealed-before-observation) applied to the project itself — but in a *safe* form.

**Soft-defaults policy** (the default for the OSS preseed):
- DEFINE phase auto-creates a `project-charter` (the birth pre-reg).
- User marks the bootstrap PR ready-for-review OR runs `coltrane-seal` slash-command → seal fires.
- If user skips seal: DEVELOP runs anyway. The recorder emits `WARN: running without sealed charter — this is observation, not verification`.
- DELIVER computes verdict if seal exists; otherwise the artifact says `UNVERIFIED` (not failed).

**Opt-in tightening** (for users who want R1-style hard-gates):
- Set `project-charter.seal_required = true` at DEFINE time.
- DEVELOP then refuses to run without a sealed charter.
- DELIVER refuses to emit `RIPENED` without seam-3 seal.

This lines up with the Heliograph Validation Program's R1–R8 standing rules (see `ops/heliograph_validation_program/PROGRAM.md` in the operations repo) — the hard-gate version of the same discipline.

## The dogfood resonance

**The framework's first artifact about itself is a coltrane standard executing the framework's own methodology.** A new user's first encounter is the framework in motion: they don't read about the double-diamond, they ride one. The charter is sealed and committed. Every future pre-reg in the project extends from this birth-substrate.

## Templates

Each template is a `templates/<use-case>/` directory in coltrane-oss containing the files DEVELOP will unroll:

- `templates/code-changes/` — code-change-flavored preseed (miles's lane)
- `templates/research-briefs/` — research-flavored preseed (subhuti's lane)
- `templates/operations/` — ops-readiness preseed (subhuti's lane)
- `templates/idea-exploration/` — diverge-discipline preseed (groove's lane)
- `templates/bare/` — minimal: just the 4 phase-agents + 4 domain standards + 3 skills

Every template ships with:
- The 4 universal phase-agents (`domain-explorer`, `problem-definer`, `solution-developer`, `delivery-finalizer`)
- The 4 domain standards (`code_change_protocol`, `research_brief_protocol`, `ops_readiness_protocol`, `idea_exploration_protocol`)
- The 3 universal skills (`coltrane-governance`, `apoha-discipline`, `rubric-loading`)
- An e2e spec stub for each preseed entity (per the band-members-as-e2e-coverage directive)
- A `CLAUDE.md` describing how to use the project
- A first sealed charter (the bootstrap's own output, committed)

## What this standard is NOT

- **NOT a CLI wrapper** — `npx create-coltrane-project` was a dropped iteration. Coltrane-oss is the seed; you use it via GitHub template-repo "Use this template" or `gh repo create --template`. The bootstrap standard is what runs INSIDE the cloned repo to specialize it.
- **NOT a one-time-only operation** — `coltrane dispatch project-bootstrap-v0 --add-template <t>` extends an existing project. Each invocation adds a sealed charter; the project accumulates the chain.
- **NOT a framework-of-frameworks** — there is no meta-meta layer. Coltrane-oss is the meta-seed; the bootstrap standard is the planting motion; each scaffolded project is a seed. Three levels, recursion grounds at the project (which can plant its own sub-seeds via per-project standards, but those are inside the project, not outside).

## See also

- `agents/domain-explorer.json` (miles) — diverge-N-alternatives, refuses-premature-convergence
- `agents/problem-definer.json` (miles) — analyst+critic, seals the predict+kill+apoha
- `agents/solution-developer.json` (miles) — executor+synthesizer, generates files
- `agents/delivery-finalizer.json` (miles) — critic+audience_modeler, ripens the charter
- `domain_types/project-charter.json` (cajal) — the birth pre-reg type
- `templates/<use-case>/` — domain-specific scaffolding payloads (miles + subhuti + groove)
