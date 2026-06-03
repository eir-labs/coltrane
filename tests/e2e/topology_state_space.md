# Phase 17 — Topology equivalence-classes for sub-thread e2e state-space

**Run date:** 2026-06-02

This spec applies an equivalence-class collapse to the test-cell state-space of the
phase-15 e2e sub-thread suite. The core move is standard: instead of running every
cell of a high-dimensional product space, identify equivalence classes under the
system's invariants and sample 1-2 representatives per class.

## State-space definition

Four axes:

- **parent_turn** ∈ {0, 1, 2, 3, 4} (5 levels) — turns taken in the parent sub-thread before spawn
- **child_turn** ∈ {0, 1, 2, 3, 4} (5 levels) — turns taken inside the child sub-thread after spawn
- **context_size_class** ∈ {small, medium, near_overflow} (3 levels)
- **persona** ∈ {solo_dev, platform_team, research_lab, eng_manager} (4 levels)

Cartesian product = **5 × 5 × 3 × 4 = 300 cells**.

### Transitions

- `spawn`: `parent_turn += 1`, new child with `child_turn = 0`
- `resume`: `child_turn += 1`, same session
- `context-overflow`: `context_size_class` upgrades toward `near_overflow`
- `persona-switch`: persona changes mid-flow (rare; treated as separate run)

## Coltrane invariants — design predictions

Before running, we predict (and document) which dimensions should be invariant under
coltrane's actual implementation. These are pre-registered: if any prediction is
violated by a representative cell failing, the equivalence class is invalidated and
must be drilled.

### Invariance prediction 1: persona under sub-thread protocol

The MCP handshake (`spawnClaudeSubthread` → `claude -p --output-format stream-json`)
is identical across personas. Personas differ only in their **assertions** (recorder
hooks, hash stability, lineage, ramp budget) — not in the transport. Therefore for
any structural failure (e.g. "no sub-thread recorder wired", phase-15 RESULTS F1/F3/F4/F5),
all four personas in the same (parent_turn, child_turn, context) cell collapse to one class.

**Counter-condition:** this does NOT hold for assertion-specific tests. eng_manager-F1
(5-min ramp) is a timing assertion unique to that persona; it cannot collapse with
platform_team-F2 (api-version fail-closed) even at the same coordinates.

### Invariance prediction 2: context_size_class — small/medium collapse

`context_size_class=small` (one-shot prompts, <100 tokens) and `context_size_class=medium`
(few-turn prompts, 100-2000 tokens) exercise the same code paths in coltrane's
MCP transport. Only `near_overflow` (>50% of model context window) triggers
truncation/summarization paths.

Therefore for the same (parent_turn, child_turn, persona), `small` and `medium` collapse
into one class. `near_overflow` is a separate class.

**Counter-condition:** does NOT hold if coltrane has a context-aware path that
activates earlier than overflow. Phase-15 grep shows no such path exists today
→ collapse is honest.

### Invariance prediction 3: chain_depth dominates over (parent_turn, child_turn) split

What matters for coltrane sub-thread behavior is `chain_depth = max(parent_turn, child_turn)` —
the depth of the resume chain — not whether the depth came from parent-side or
child-side accumulation.

Concretely: (parent_turn=2, child_turn=0) and (parent_turn=0, child_turn=2) and
(parent_turn=1, child_turn=1) should all collapse to `chain_depth=2`.

**Counter-condition:** does NOT hold if coltrane treats parent/child asymmetrically
(e.g. parent's ledger is durable but child's is in-memory). Phase-15 RESULTS suggests
no recorder is wired AT ALL for sub-threads → the asymmetry doesn't yet exist
→ collapse is honest.

### Invariance prediction 4: depth ≥ 1 is one class (post-cold-start)

`chain_depth=0` exercises only cold-start. `chain_depth=1` exercises the first resume.
`chain_depth=2..4` exercises the same resume code path repeatedly. Since coltrane has
NO per-depth special-casing in `claude_invoker.ts`, depths 1, 2, 3, 4 collapse to one
class: "resume-chain-of-any-length-≥1".

**Counter-condition:** does NOT hold if coltrane installs any depth-aware logic
(e.g. compaction at depth=3). None observed in phase-15.

## Equivalence-class derivation

Applying the four invariance predictions, the 300-cell space collapses to:

### Class A: cold-start, structural
`(parent_turn=0, child_turn=0, context ∈ {small, medium}, any persona)`
Cells in class: 4 personas × 1 chain_depth × 2 context_classes = **8 cells**
Representative count: **1** (single persona/context combo) + **3 cross-persona checks**
to validate invariance prediction 1.
**Rationale:** all four personas share the cold-start MCP-handshake path. One rep tests
the path; three cross-persona reps validate persona-invariance.

### Class B: cold-start, near-overflow
`(parent_turn=0, child_turn=0, context=near_overflow, any persona)`
Cells in class: 4 personas × 1 chain_depth × 1 context_class = **4 cells**
Representative count: **1**.
**Rationale:** if coltrane has no overflow path (predicted), this collapses to class A.
Sample 1 rep to TEST that prediction; if it fails differently from class A, split.

### Class C: resume-chain, structural
`(chain_depth ≥ 1, context ∈ {small, medium}, any persona)`
Cells in class: 4 personas × (chain_depth 1..4, with parent/child both varying = 21 combos
within the 5×5 grid where max(p,c) ∈ {1,2,3,4}) × 2 context = 4 × 21 × 2 = **168 cells**
Representative count: **1 per chain_depth = 4** + **3 cross-persona checks at depth=2**
to validate invariance prediction 3 (parent/child symmetry).
**Rationale:** depths 1-4 SHOULD all show the same recorder-missing failure (phase-15
F1/F3/F4/F5). One rep at each depth tests the prediction. If depth=4 fails differently
from depth=1, we've discovered a non-trivial depth-coupling and must drill.

### Class D: resume-chain, near-overflow
`(chain_depth ≥ 1, context=near_overflow, any persona)`
Cells in class: 4 personas × 21 chain-depth combos × 1 context = **84 cells**
Representative count: **1**.
**Rationale:** combines class C + class B's overflow path. Single rep to confirm.

### Class E: assertion-specific (per-persona timing/structural assertions)
These cells cannot collapse across personas because their assertions are persona-
specific. We sample 1 rep per persona at chain_depth=0 (or 1 for platform, 3 for research):
- eng_manager: 5-min cold-start ramp
- platform_team: api-version fail-closed
- research_lab: parent-child lineage (requires depth ≥ 2)
- solo_dev: 3-parallel timing

Representative count: **4** (one per persona).
**Rationale:** these are exactly the phase-15 hard-assertion tests. They live outside
the persona-invariance collapse because they EACH probe a different subsystem.

### Class F: parent/child asymmetry probe
A targeted check that (parent_turn=2, child_turn=0) and (parent_turn=0, child_turn=2)
give the same verdict — validates invariance prediction 3.
Representative count: **2**.

## Summary

| Class | Cells covered | Reps sampled |
|---|---|---|
| A: cold-start, structural | 8 | 4 (1 + 3 cross-persona) |
| B: cold-start, near-overflow | 4 | 1 |
| C: resume-chain, structural | 168 | 7 (4 chain-depths + 3 cross-persona at depth=2) |
| D: resume-chain, near-overflow | 84 | 1 |
| E: assertion-specific (per-persona) | 4 (subset of A/C) | 4 |
| F: parent/child asymmetry probe | 2 (subset of C) | 2 |
| **Reachable union (deduped)** | **300 / 300** | **19 reps** |

The union of A∪B∪C∪D covers exactly the 300 cells once overlaps are deduped via
`chain_depth ≥ 1` membership. The generator script does the exact accounting and reports 300/300.

**Raw compute saving:** 300 cells → 19 reps = **15.8× reduction** if predictions hold.

## Generalization rule

For each representative cell:
- **PASS** → all cells in its equivalence class are PRESUMED PASS. No follow-up.
- **FAIL** → the equivalence class is FLAGGED; the failure-mode fingerprint is recorded.
  Other cells in the class are presumed to share the failure (consistent with the
  underlying root-cause hypothesis) UNLESS a follow-up drill is requested.
- **MIXED-MODE within a class** (one rep passes, another fails on the same class) →
  the class is INVALIDATED; we revert to per-cell sampling within that class.

## Kill conditions (pre-registered)

- If three or more equivalence classes are invalidated by mixed-mode reps, the
  methodology is failing to capture the actual coupling structure → STOP
  and report KILLED.
- If the equivalence-collapse demonstrably doesn't fit the cells, reshape and
  report RIPENED-DIFFERENTLY.

## What this is NOT

- NOT re-running every cell of the full 300-cell grid.
- NOT extending coltrane code; this is a test-scope topology layer.
- NOT making phase-15 RED tests GREEN by patching; reps run honestly against current state.
