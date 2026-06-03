---
description: Walk the double-diamond × safe-prereg idea-exploration discipline on a seed topic. Refuses premature convergence; seals at DEFINE; archives non-developed candidates as restartable seeds.
argument-hint: <topic in quotes>
---

# /coltrane-explore-idea $ARGUMENTS

You are running the **idea-exploration template** of coltrane. The user has just invoked this slash command with the topic `$ARGUMENTS`.

Dispatch the `idea_exploration_protocol` standard with the user's topic as the seed-topic. Use the coltrane MCP tool `mcp__coltrane__standard_dispatch` (or `standard_simulate` for dry-run).

## The 5 phases — walk them in order

### 1. DISCOVER (agent: `idea_explorer`)
- Generate **at least 7 distinct framings** of the topic. Each candidate: `{id, framing, one_liner, tensions[], lineage?}`.
- **REFUSE to converge early.** Even if 3 framings look strong, keep going until 7 are on the table.
- The gate: count >= 7 AND audience_modeler diversity_score >= 60.
- If you find yourself wanting to "pick the best," that's the premature-convergence reflex. **Stay in DISCOVER.**

### 2. DEFINE_AUDIENCE (agent: `audience_modeler`)
- For EACH candidate, name 3 specific audience archetypes. **NOT** "developers", **NOT** "users". Shape archetypes: their day, their want, what would make this LAND for THEM.
- If a candidate has zero plausible receiver: `kill_recommended: true` with a specific `kill_reason`. Carry the kill into the seal phase.
- Compute diversity_score across the candidate-set 0-100.

### 3. DEFINE_SEAL (agent: `kill_condition_keeper`) — **SEAL FIRES HERE**
- For each surviving (non-kill-recommended) candidate, emit a `sealed-prereg`:
  - `predict`: SPECIFIC observable outcome with checkable threshold. **NOT** "this will be useful".
  - `kill_condition`: concrete + measurable falsification trigger.
  - `apoha`: array of >=1 "NOT X" inverted-kills.
  - `sha256_pre_verdict`: sha256 over canonical_json({candidate_id, predict, kill_condition, apoha}).
- Once emitted, the sealed triple is **FROZEN**. The seal hash is the apoha-discipline made operational.

### 4. DEVELOP (agent: `seed_sower`)
- **Ask the user which 1-3 sealed candidates to actually build.**
- For each NON-selected sealed candidate: emit `unsown-seed` to `archived_seeds/<candidate_id>.json` with seal-hash intact. These are SEEDS not LOSSES — restartable.
- For each SELECTED: execute the build under its frozen seal. No spec drift.

### 5. DELIVER (agent: `ripener`)
- For each developed candidate: check actual outcome → verdict ∈ {RIPENED, PARTLY-RIPENED, RIPENED-DIFFERENTLY, KILL-FIRED, ABORTED}.
- For each unsown-seed: re-verify sha256_pre_verdict against canonical re-hash. Confirm restartability.
- Emit verdict bundle. Done.

## Apoha for this skill

- **NOT** a generic creative-brainstorm. The framings must carry tensions, not vibes.
- **NOT** "pick the winner early." The reflex to converge IS the failure mode this discipline kills.
- **NOT** silent-loss of non-developed ideas. Every archived seed gets its seal-hash preserved.
- **NOT** verdict-drift. Ripening compares to the FROZEN seal, not a present-day reinterpretation.

Begin with phase 1 (DISCOVER). Do not skip ahead.
