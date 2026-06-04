---
name: cost-discipline-standard
description: Standard for cost-disciplined methodology cadence in chain-resident form. Every load-bearing claim seals before run; verdicts settle externally; backward-queryability is the read interface.
version: 3.3
sealed_at_utc: 2026-06-04T21:40:00Z
parent: eir-finitude-budget-v0.pdf
status: draft
---

# Cost-discipline standard v3.3

The standard governs how voices propose, test, and settle load-bearing claims against a finite cost budget on an append-only chain.

## Scope

Applies to any voice writing chain events. Read-only consumers (UI, audit) are out of scope.

## Required event_kinds

Every voice's methodology cycle uses these five typed kinds. The chain rejects mis-typed appends at validator level.

### 1. prereg_seal

Required before any empirical run that claims a verdict against pre-stated predictions.

Required fields:
- `claim` (str) — load-bearing assertion, one sentence
- `predictions` (list of dict, each with `name`, `condition`, `kill_verdict`)
- `kill_conditions` (list of str) — at least one global falsifying condition
- `apoha` (list of str) — what the claim is NOT testing
- `attribution_chain` (list of dict) — prior_art_ref + author + attestation
- `expected_artifacts` (list of str) — paths the empirical run will produce

### 2. empirical_run

The actual run. Must reference the prereg by sha.

Required fields:
- `prereg_sha`
- `script_path`, `script_sha`
- `outputs` (dict keyed by prediction name)
- `started_at_utc`, `completed_at_utc`, `exit_code`

### 3. verdict

Adjudicates the empirical run against the pre-stated predictions.

Required fields:
- `empirical_run_sha`
- `per_prediction_verdicts` (dict: prediction_name → {condition_met, raw_value, reason})
- `overall_verdict` ∈ {`passed_for_seal`, `ripened_differently:<spec>`, `failed_at:<spec>`, `incomplete_to:<spec>`}
- `kill_conditions_triggered` (list of str, empty if none)

### 4. amendment

When verdict falsifies the claim, the STANDARD is amended (not the test).

Required fields:
- `verdict_sha`
- `standard_target` (file path + section)
- `change_description`
- `change_rationale` (must cite specific kill_condition / prediction-failure)
- `survives_crow_test` (dict: for each related prior crow, does this amendment honor it?)

### 5. cycle_close

Closes the methodology cycle. Mints ratchet only if external_verdict_source settled this cycle.

Required fields:
- `amendment_sha` (or null if verdict passed without amendment)
- `next_claim_seed` (or null for terminal cycle)
- `cycle_ratchet_delta` ∈ {-1, 0, +1} (+1 only if a `settlement` event with external_verdict_source minted)
- `attribution_to_next_cycle` (list of prior_art_refs)

## Cost-on-append

Every append carries cost. Cost formula (5-channel baseline):

```
cost[compute]        = 1 + 0.1 * size(payload)
cost[energy]         = compute * tokens_per_kwh_inverse
cost[attention]      = measured externally (Slack response latency)
cost[correction_tax] = measured externally (rebuke rate)
cost[ratchet]        = -1 if kind ∈ {prereg_seal, empirical_run, verdict, amendment, cycle_close} else 0
```

Pre-append balance check: read `~/.eir/cost_ledger.jsonl` snapshot for `balance[voice_id]`. If `balance[channel] < cost[channel]` for any required channel, raise `BudgetExhausted(voice_id, channel, deficit)`.

## Settlement and mint

A `settlement` event_kind validates externally. Required fields:
- `verdict` ∈ {PASS, FAIL, NO_VERDICT}
- `external_verdict_source` ∈ {rob-cold-trial, held-out-task, real-user, github-actions-container}
- `verdict_pass_shape` (required if verdict=PASS) — names which sub-shape of the source minted
- `evidence_uri` (required if verdict=PASS)
- `mint` (dict of per-channel mint values)

### Pass-shapes per source

Each external_verdict_source has one or more named pass-shapes. A settlement names which shape minted:

- `rob-cold-trial`:
  - `static_clone_read` — Rob clones main, audits README + core_types + audit-chain without running a live Steve
  - `live_runtime_boot` — Rob clones the integrated stack, boots a Steve in Claude Code, runs a gig, observes audit-chain populate
- `held-out-task`:
  - `containerized_pass` — task runs in github-actions container, container settles PASS
- `real-user`:
  - `feature_use_acknowledged` — user uses the feature and chimes positive (e.g., Tash's `looks good :))` on the deal pipeline)
  - `deployed_iteration_accepted` — user requests change, change ships, user accepts
- `github-actions-container`:
  - `verify_green` — `npm run verify` (tsc --noEmit && vitest) returns 0 on PR
  - `e2e_green` — designated e2e suite returns 0

A settlement event references exactly one pass-shape. Different shapes mint different ratchet values (e.g., `static_clone_read` may mint less than `live_runtime_boot` per principal call).

Validator raises:
- `InvalidVerdictSource` if `external_verdict_source` missing or not in enum
- `InvalidEvidence` if verdict=PASS and evidence_uri is None
- `SelfMintAttempt` if `verdict_grader == voice_being_settled` (G1 hardest)

`NO_VERDICT` is first-class. A voice with high abstention is more disciplined, not less.

## Read interface

Backward-queryability is the only read interface. Four primitives, structurally invariant whether the chain is text-proxy or chain-truth:

- `chain_query.preregs_by_voice(voice_id, time_window) → list[prereg_seal]`
- `chain_query.completed_cycles(voice_id, time_window) → list[(prereg, empirical, verdict, amendment?, cycle_close)]`
- `chain_query.falsification_rate(voice_id, time_window) → float`
- `chain_query.cycle_lineage(event_sha) → graph`

Read-side is strictly read-only over append-only chain. No second write path.

## Apoha-rate as discipline metric

Falsification rate (count of verdicts with `failed_at:*` or `ripened_differently:*` divided by total verdicts in a window) is the band-internal discipline metric. Higher rate means more willingness to seal claims the verdict can kill. Rate is not a pass/fail gate; it is a calibration signal.

Tonight's stage-2 chain-truth read (`miles_chain_query_proto`) surfaces the band's current state: only 17 sealed methodology events EVER across all voices. The text-proxy stage-1 inflated counts 100-1000x because it measured methodology-PROSE not methodology-SEALED. This standard exists to close that gap.

## Cardinal compliance requirement

For any load-bearing claim, the voice must append `prereg_seal` to the chain BEFORE running the empirical test. Claims that ran without prior seal cannot be settled as PASS. Self-grading without external_verdict_source cannot mint.

The chain refuses what cannot be honestly settled.

## Naming-apoha rule

Two artifacts with the same `kind` or `mode` name MUST share the same shape. Two implementations using the same identifier with different content register as a NO_VERDICT-by-collision and block downstream settlement until disambiguated.

Disambiguation is a rename, not a merge. The rename names what the artifact actually IS (chain-dag-v0, cognitive-shape-v0, ratings-fingerprint-v0); the prior name remains available for the shape-it-honestly-described.

Rationale: when multiple voices build in parallel, identical names with different shapes accumulate silently and surface only when settlement tries to join across artifacts. The apoha rule is: distinguish at write-time, not at integration-time. Discovered empirically tonight (two `basic-graph-v0` shipments in 5 min with divergent content; subhuti renamed Python to `chain-dag-v0`).

## Relationship to working-memory snapshot event_kind

The substrate also defines a generic `snapshot` event_kind for arbitrary working-memory state (chain_keeper takes any payload + an optional `fingerprint` field for similarity search / replay). Snapshot is orthogonal to methodology cadence:

- Methodology event_kinds (`prereg_seal`, `empirical_run`, `verdict`, `amendment`, `cycle_close`) ARE typed snapshots of methodology claim state. They satisfy the snapshot interface naturally.
- The generic `snapshot` event_kind covers untyped working-memory captures that aren't methodology claims.
- The `fingerprint` field (basic-graph in OSS / closed eirmath mode for licensed) can attach to ANY event_kind including methodology kinds. Methodology cycles can have fingerprints; settlements can be fingerprinted for cross-cycle similarity.

Snapshot is the substrate primitive; methodology event_kinds are typed disciplines on top.

## Honest gaps

- Inbound socket_listener does not yet seal chain events for named-ant chains (miles/cajal/groove/subhuti). Subhuti's 10-line fix is queued.
- Cycle boundary definition is open: per-settlement vs clock-hour vs band-rotation. Default: per-settlement.
- External grader protocol candidates (Slack emoji-reaction / PR merge / Linear close) need principal call before Phase A finalizes.
- Cost-of-the-standard-itself: applies to its own engineering. Phase A implementation must land cheaply.

## Implementation phases

- **Phase 0 (sealed):** spec + substrate types v1.3 + chain_keeper state extension (10/10 tests green)
- **Phase 1 (in flight):** chain_keeper cost-on-append + settlement event_kind validator
- **Phase 2:** every voice's emit() routes through chain_keeper-with-cost
- **Phase 3:** external grader configured (at least one of {rob-cold-trial, held-out-task, real-user})
- **Phase 4:** backward-queryability primitives wired against chain-truth

## Attribution

- Canonical spec: eir-finitude-budget-v0.pdf
- Substrate types: cajal v1.3 (budget-state.json + settlement.json, PR #56)
- chain_keeper state extension: groove (voice_state + cycle_state + derived_from_shas, 10/10 tests)
- chain_keeper cost-on-append wire: subhuti (in flight)
- 5 event_kinds + read-side primitives: this standard
- Falsification-rate empirical receipt: stage-2 chain-truth read (PR #57)
