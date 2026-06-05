# Pre-registration — Minimum Surface Design

> Pre-registered before code lands. The claims and falsification hooks below are sealed in this file at PR-merge time. If subsequent measurement kills a claim, this file stays as historical record and the retraction is added at the bottom.

## Background

coltrane-oss is converging on a radical simplification of its install surface. The proposal under test:

- Ship exactly three things in the repo: `CLAUDE.md` (the bootstrap conversation), `seeds/<lane>.jsonl` (per-lane seeded Claude sessions), and `.mcp.json` (MCP server registration).
- Install flow: `git clone <repo>` + `claude` in the repo directory.
- No `coltrane init` step. No separate CLI. Claude reads `CLAUDE.md` and runs the bootstrap as conversation.
- `seeds/<lane>.jsonl` files are copied into `~/.claude/projects/<slug>/<steve-uuid>.jsonl` so the user can `claude --resume <steve-uuid>` and pick up a pre-primed session in that lane.
- coltrane is the substrate (write-paths + MCP tools). Claude is the engine.

Prior empirical signal: a broken-link identification task on raw sha values showed SEEDED 80% vs COLD 40% (N=5). A parallel N=3 run was ceiling'd by task design and is not load-bearing here.

The per-project lane-prior generator (cluster `~/.claude/projects/*` history into exemplars) is the day-N refinement, not the MVP. MVP is the static repo-shipped seeds.

## Claims under test

### C1 — Three files are sufficient for unaided bootstrap

`CLAUDE.md` + `seeds/<lane>.jsonl` + `.mcp.json` together are sufficient for Claude Code to complete project bootstrap on a fresh clone without a separate coltrane CLI step and without prompting the user for clarifications that would have to be answered in `CLAUDE.md` anyway.

### C2 — Lane-flavored seeds confer measurable capability uplift

A Claude session resumed from `seeds/<lane>.jsonl` exhibits higher task-success on lane-aligned tasks than a cold Claude session with no resume, when both are given identical task prompts. This generalizes the N=5 broken-link result (80% vs 40%) across held-out task families.

### C3 — The MCP surface fits in ≤3 tools

The MCP tool surface required to support the bootstrap and the seeded-lane flow fits in three tools or fewer. Working set under test: `seed_steve`, `list_steves`, `mint_event`.

## Falsification hooks

### C1-kill

On a fresh clone, with only the three shipped files present, Claude asks the user a clarifying question whose answer would need to be written back into `CLAUDE.md` (i.e. the question reveals a gap in the bootstrap document that we'd have to close anyway). Observed in ≥2 of 5 fresh-clone runs across distinct first-time users → C1 falsified.

### C2-kill

On held-out task families, paired-arm measurement shows SEEDED hit-rate not significantly above COLD at N≥20 per family. Operationalized: across the three task families, the average per-family delta (SEEDED − COLD) is < 20 percentage points, OR a per-family one-sided test against the COLD baseline fails to reject at α=0.05.

### C3-kill

The minimum MCP surface that supports the bootstrap and the seeded-lane flow grows past three tools as we wire it. Operationalized: if at the end of the implementation PR the MCP surface required by the bootstrap path enumerates 4 or more tools, C3 is falsified.

## What this is NOT

- This is NOT a fine-tuned model claim. No weights are changed. The model is stock Claude Code.
- This is NOT a generic role-template claim. The seeds are not system prompts, not personas, not character cards.
- This is NOT a session-replay-verbatim claim. The seeded session is a prior, not a script; subsequent turns are free generation.
- This is NOT a "we built smart inference" claim. The inference is Claude's. coltrane only provides the substrate.
- This is NOT a coltrane-CLI re-skinning. The proposal eliminates the CLI surface for the bootstrap path; it does not hide it.
- This is NOT a RAG / vector-store claim. Seeds are concrete conversation turns, not retrieved fragments.

## Pre-registered measurement plan (C2)

C2 is the load-bearing capability claim. Measurement protocol:

**Task families** (3 distinct):

1. **Broken-link identification on raw sha values** — the original subhuti task. Held-out instances, distinct from the N=5 set used previously.
2. **Type-resolution disambiguation** — given a candidate type description and an existing registry slice, decide whether to register-new vs extend-existing, with a known correct verdict.
3. **Standard composition validity** — given a partial multi-phase pipeline and a goal, identify whether the composition is well-formed under §5 rules; if not, name the violation.

Task families are chosen for distinctness, not similarity. The point is to test whether lane priors generalize, not whether they replay.

**Arms (paired, per task instance):**

- COLD: fresh `claude -p "<task prompt>"` invocation. No resume, no seeds, default tools.
- SEEDED: `claude --resume <steve-uuid>` after seeds for the relevant lane have been copied into the project session dir; same `<task prompt>` appended.

Each task instance runs both arms. Arm assignment within a measurement run is recorded but anonymized in the judge step.

**Blind judge protocol:**

- A separate `claude -p` instance (the judge) receives the task description, the correct verdict, and two anonymized responses labeled A / B.
- Judge returns: `{A_correct: bool, B_correct: bool, notes: str}`.
- Judge does not know which arm produced which response.
- Judge prompt is sealed in `evals/c2_judge_prompt.md` before measurement begins.

**Sample size and threshold:**

- N ≥ 20 paired task instances per family (60 total minimum).
- Success threshold for C2 to hold: SEEDED − COLD ≥ 20 percentage points hit-rate **averaged across the three families**, with each family showing a positive delta.
- A family with negative or near-zero delta is reported even if the overall average clears the bar; the asymmetry is itself a finding.

**Pre-commitments:**

- Task instances are written and frozen before any measurement run.
- Judge prompt is frozen before measurement.
- Seed files used for the SEEDED arm are the exact bytes shipped in the repo at the measurement commit; no per-run tuning.
- No optional stopping. We run the full N before reading any per-instance result.

## Decision gates

**If C1 is falsified:** retreat from "no CLI" only. The `coltrane init` step returns to close the specific gap the clarifying-question revealed. The seed-shipping mechanism stays. CLAUDE.md gets the specific question's answer baked in if applicable. Ship.

**If C2 is falsified:** retract the capability-uplift claim. Demote seeds from "lane prior confers capability" to "vocabulary priming" in all docs. Remove the SEEDED vs COLD comparison from the README. The substrate (write-paths + MCP) still ships; the seeds still ship as vocabulary scaffolding. The marketing changes; the mechanics survive.

**If C3 is falsified:** publish the actual MCP surface count and the minimum justification for each tool past the third. Do not pretend the bound held. The "≤3 tools" claim is a design-discipline target; exceeding it is a real cost, not a sentence to delete.

**Ships regardless of falsification outcomes:** the three-file repo layout itself, since it's strictly simpler than what's there now and falsifying C1/C2/C3 does not make the existing surface better.

## Sealing

Pre-reg seal commit: this file's content_hash at PR merge.

Falsification observations land as appended sections at the bottom of this file, dated, with the measurement commit referenced. The original claims and falsification hooks are never edited after seal.
