---
name: cost-discipline-standard
description: Cost-budget discipline over an append-only audit log. Every claim that wants to count as a result is registered before the run; results are graded by an external check; the only way to read the log is backward, from any event to the events that caused it.
version: 3.3
status: draft
---

# Cost-discipline standard v3.3

Defines how an agent proposes, tests, and settles a result claim against a finite cost budget, recorded on an append-only audit log.

## Scope

Applies to any agent writing audit-log events. Read-only consumers (dashboards, audit tools) are out of scope.

## Required event types

Every test cycle uses these five typed event records. The audit log's validator rejects mis-typed records at write time.

### 1. registration

Required before any test run that wants to claim a result against pre-stated predictions.

Required fields:
- `claim` (str) — what is being tested, one sentence
- `predictions` (list of dict, each with `name`, `condition`, `kill_verdict`)
- `kill_conditions` (list of str) — at least one condition under which the claim is structurally false
- `not_testing` (list of str) — what the claim is explicitly NOT testing
- `attribution_chain` (list of dict) — prior_art_ref + author + attestation
- `expected_artifacts` (list of str) — paths the test run will produce

### 2. test_run

The actual run. Must reference the registration by its hash.

Required fields:
- `registration_hash`
- `script_path`, `script_hash`
- `outputs` (dict keyed by prediction name)
- `started_at_utc`, `completed_at_utc`, `exit_code`

### 3. result

Compares the test run outputs against the pre-stated predictions.

Required fields:
- `test_run_hash`
- `per_prediction_results` (dict: prediction_name → `{condition_met, raw_value, reason}`)
- `overall_result` ∈ {`passed`, `passed_with_changes:<spec>`, `failed_at:<spec>`, `incomplete:<spec>`}
- `kill_conditions_triggered` (list of str, empty if none)

### 4. revision

When a result invalidates the claim, the **standard** is revised (not the test).

Required fields:
- `result_hash`
- `standard_target` (file path + section)
- `change_description`
- `change_rationale` (must cite the specific failure or kill condition)
- `addresses_prior_review_points` (dict: for each prior open review point, does this revision honor it?)

### 5. cycle_close

Closes the test cycle. Adds credit to the agent's budget only if an external check graded this cycle.

Required fields:
- `revision_hash` (or null if the result passed without revision)
- `next_claim_seed` (or null if no follow-up is intended)
- `credit_delta` ∈ {-1, 0, +1} (+1 only if a `settlement` event with `external_grader` recorded credit)
- `attribution_to_next_cycle` (list of prior_art_refs)

## Cost per append

Every append carries a cost. Five-channel baseline:

```
cost[compute]        = 1 + 0.1 * size(payload)
cost[energy]         = compute * tokens_per_kwh_inverse
cost[attention]      = measured externally (response latency)
cost[correction_tax] = measured externally (rejection rate)
cost[credit]         = -1 if event_type ∈ {registration, test_run, result, revision, cycle_close} else 0
```

Pre-append balance check: read `~/.eir/cost_ledger.jsonl` snapshot for `balance[agent_id]`. If `balance[channel] < cost[channel]` for any required channel, raise `BudgetExhausted(agent_id, channel, deficit)`.

## Settlement and credit

A `settlement` event records the outcome of an external check. Required fields:
- `outcome` ∈ {PASS, FAIL, NO_VERDICT}
- `external_grader` ∈ {cold-reviewer, held-out-task, real-user, ci-container}
- `pass_shape` (required if outcome=PASS) — names which sub-shape of the grader passed
- `evidence_uri` (required if outcome=PASS)
- `credit` (scalar — sum across channels)
- `per_channel_credit` (optional dict — breaks scalar down by channel)

Validator raises:
- `InvalidGraderSource` if `external_grader` missing or not in enum
- `InvalidEvidence` if outcome=PASS and evidence_uri is None
- `SelfGradingAttempt` if `grader == agent_being_settled`

`NO_VERDICT` is a first-class outcome. An agent with a high abstention rate is more disciplined, not less.

### Pass shapes per grader

Each `external_grader` has one or more named pass shapes. A settlement records which shape passed:

- `cold-reviewer`:
  - `static_clone_read` — reviewer clones the main branch, reads README + types + audit-log without running the system
  - `live_runtime_boot` — reviewer clones the integrated stack, boots the system, runs an example, observes the audit log populate
- `held-out-task`:
  - `containerized_pass` — task runs in a container, container reports PASS
- `real-user`:
  - `feature_use_acknowledged` — user uses the feature and explicitly acknowledges it works
  - `deployed_iteration_accepted` — user requests a change, change ships, user accepts it
- `ci-container`:
  - `verify_green` — `npm run verify` returns 0 on the pull request
  - `e2e_green` — the designated end-to-end suite returns 0

A settlement names exactly one pass shape. Different shapes recognize different credit values.

## Read interface

Backward-queryability is the only read interface. Four read primitives, identical whether the audit log uses text-pattern classification or typed-event classification:

- `chain_query.registrations_by_agent(agent_id, time_window)`
- `chain_query.completed_cycles(agent_id, time_window)` — joins registration → test_run → result → revision? → cycle_close by hash references
- `chain_query.failure_rate(agent_id, time_window)`
- `chain_query.cycle_lineage(event_hash)` — backward walk of `prev_hash`

The read side is strictly read-only over the append-only log. No second write path.

## Failure rate as a discipline metric

Failure rate = (count of results with `failed_at:*` or `passed_with_changes:*`) / (total results in a window). It is a calibration signal, not a pass/fail gate. A higher rate indicates more willingness to register claims that the test can invalidate.

## Cardinal compliance requirement

For any claim that wants to count as a result, the agent must append a `registration` event to the audit log BEFORE running the test. Claims tested without a prior registration cannot be settled as PASS. Self-grading without an `external_grader` cannot add credit.

The log refuses what cannot be honestly settled.

## Naming rule

Two artifacts with the same `kind` or `mode` name MUST share the same shape. Two implementations using the same identifier with different content register as `NO_VERDICT`-by-collision and block downstream settlement until disambiguated.

Disambiguation is a rename, not a merge. The new name describes what the artifact actually is; the prior name remains available for whatever shape it honestly described.

Rationale: when multiple authors build in parallel, identical names with different shapes accumulate silently and surface only when downstream code tries to join across them. Distinguish at write time, not at integration time.

## Relationship to snapshot event type

The audit log also defines a generic `snapshot` event for arbitrary working-memory state (any payload + an optional `fingerprint` field for similarity search and replay). The snapshot event is independent of the five typed cycle events above:

- The five cycle event types (`registration`, `test_run`, `result`, `revision`, `cycle_close`) are typed snapshots of test-cycle state. They satisfy the snapshot interface naturally.
- The generic `snapshot` event type covers untyped working-memory captures that aren't tied to a test cycle.
- The `fingerprint` field can attach to any event type. Cycle events can carry fingerprints; settlements can be fingerprinted for cross-cycle similarity search.

## Open questions

- Cycle boundary definition: per-settlement vs clock-hour vs event-count. Default proposal: per-settlement.
- External grader protocols (reaction emoji / pull-request merge / ticket close) need disambiguation before settlement validators ship.

## Implementation phases

- **Phase 0:** spec + typed events + cost-on-append wire
- **Phase 1:** every agent's append() routes through the cost-aware writer
- **Phase 2:** at least one `external_grader` configured ({cold-reviewer, held-out-task, real-user})
- **Phase 3:** backward-queryability primitives wired against typed events
