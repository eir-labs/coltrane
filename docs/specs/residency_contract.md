# The residency contract — buildable spec + RED suite

This is the falsifiable half of `SPEC-residency-contract.md`. That prose establishes the argument;
this document turns each obligation into a **mechanism at a real callsite, verified by a RED test**.
The suite lives in `tests/spec_reside_*.test.ts` and is **committed failing on purpose**: every
behavioural assertion is red because the enforcement module it names — `src/residency.ts` — does not
exist yet. Authoring that module to the surface below turns the suite green; a green suite is the
proof the presence is entitled to what the prose promises.

Scope note (non-goals honoured): this gig produces the CONTRACT and the RED suite only. It does not
implement `coltrane reside`, and it does not modify `src/worker.ts`, `src/cli.ts`, the venue/room
realization code, or `VenueSchema`. `workOnce` (`src/worker.ts:894`) and `venueMayClaim`
(`src/worker.ts:335`) are cited and reused verbatim, never re-implemented.

---

## The enforcement seam the suite pins — `src/residency.ts`

The in-tree RED technique (`src/committed_work.ts`, `src/change_set_branch.js`) authors a **throwing
seam** in `src/` so the suite compiles and fails on absent enforcement. This gig may not write to
`src/`, and the root `tsconfig.json` compiles `tests/**` into the shared build — so a *static*
`import … from "../src/residency.js"` of an absent module would break `tsc` for the entire suite, not
isolate the reside files. The suite therefore uses a two-part shape (`tests/spec_reside_fixtures.ts`):

1. **The contract as data + types** is declared in the fixtures file — the closed state set, the op
   set, the party-constrained legal-transition table, the residency row shape, and every record/op/
   result type. These are `tsc`-checked and resolvable, so the build stays green.
2. **The enforcement is loaded at runtime** via `loadResidency()`, whose module specifier is a
   runtime `new URL(...).href` (not a string literal), so `tsc` does not resolve it. At runtime the
   import **rejects** until `src/residency.ts` exists — the RED signal — and each suite fails in its
   `beforeAll` naming the absent module.

When `src/residency.ts` is authored to the surface the fixtures declare, `loadResidency()` resolves
and every assertion runs against the real callsite. The tests are not tautologies: they pin the real
module's behaviour, never a stub defined in the test tree. The module must export:

| Symbol | Shape | Pins |
| --- | --- | --- |
| `RESIDENCY_STATES` / `RESIDENCY_OPS` / `LIVE_STATES` | closed sets as data | I4, I5 |
| `LEGAL_TRANSITIONS` | `{from, op, to}[]` — the party-constrained legal table | I5 |
| `RESIDENCY_ROW_FIELDS` | the row shape as data (`venue_slug`, `channel_id`, `fence`, …) | I17, I18 |
| `applyResidencyOp(rec, op)` | total `(rec, op) → {ok:true,next} \| {ok:false,reason}` | I1–I9, I13, I15 |
| `reflexAck(msg, {invoke, clock})` | `{acked:true, elapsed_ticks}` — no model, injected clock | I10, I11 |
| `REFLEX_BUDGET_TICKS` | finite tick budget (not a wall-clock ms) | I11 |
| `reapResidency(rec, now)` | the NAMED reader — forces dead-hibernated → unseated | I14 |
| `readOwnImpressions(rec)` | self-read scoped out (no impression content) | I16 |
| `admitVenueCredential(venue, class)` | `{ok:true} \| {ok:false, reason:"credential_breach"}` | I17, I18 |
| `bootResidency(spec, deps)` | typed refusal BEFORE `seatRow` side effect | I19 |
| `runReside(argv, io)` | verb honouring env + exit codes 0/1/3/2 | I20 |
| `residencyGigPath` | **the exact `workOnce` symbol** (`export { workOnce as residencyGigPath }`) | I12 |

---

## Obligations → mechanism → callsite → red test

- **O1 boot/seat, O13 typed refusals.** `bootResidency` resolves agent → soul, venue → hands,
  confirms the cortex image, then seats a row; an unresolvable input returns
  `{ok:false, refusal:"no_such_agent"|"no_such_venue"|"no_cortex"}` **before** `seatRow` runs — the
  fail-closed posture of `gig_dispatch` (`src/server.ts:3019`, `refusal:"no_backend"`). Identity
  columns are immutable after seating. *Red test:* `spec_reside_surface.test.ts` (I19),
  `spec_reside_transition.test.ts` (I7).
- **O2 claim-and-HOLD, O10 fencing.** `applyResidencyOp(_, {kind:"claim"})` reuses the optimistic
  compare-and-set shape of `claimNextGig` (`src/worker.ts:364`): a second claim on a live residency
  is refused `double_activation`; a monotonic `fence` (Kleppmann) rejects a paused old host's write
  `stale_fence`. *Red test:* `spec_reside_lease.test.ts` (I8, I9).
- **O3 push/reflex.** `reflexAck` acks with the model-invoker called zero times, within
  `REFLEX_BUDGET_TICKS` on an injected clock. *Red test:* `spec_reside_reflex.test.ts` (I10, I11).
- **O4 one cortex, O9 hibernate.** `applyResidencyOp` hibernate→thaw preserves `session_id`
  (the resume handle — `src/claude_invoker.ts:798` `parent_session_id`), `cursor`, and private
  memory. *Red test:* `spec_reside_liveness.test.ts` (I15).
- **O5 seal = becoming.** `applyResidencyOp(_, {kind:"wake_seal"})` advances `cursor` **only** when a
  `sealed_output_sha` is present, in one bundled write; a wake with no seal is refused
  `cursor_without_seal` (the message stays unconsumed). No other op advances the cursor, and a
  re-hosted box cannot re-answer a consumed message. This is the structural close of the live
  output_write ok-without-seal bug. *Red test:* `spec_reside_cursor.test.ts` (I1, I2, I3).
- **O6 same floor.** `residencyGigPath === workOnce` by referential identity — a second gig-path
  implementation fails by existing, the discipline `venueMayClaim` already enforces
  (`src/worker.ts:335`). *Red test:* `spec_reside_surface.test.ts` (I12).
- **O7 venue is hands, O8 transition function.** `RESIDENCY_ROW_FIELDS` carries `venue_slug` and no
  second hands list; `admitVenueCredential` refuses an undeclared credential class
  (`credential_surface`, `src/genome_schema.ts:1019`). `applyResidencyOp` is the party-constrained
  total transition function (the `applyCommitmentOp` pattern, `src/committed_work.ts:214`). *Red
  test:* `spec_reside_surface.test.ts` (I17, I18), `spec_reside_transition.test.ts` (I4, I5, I6).
- **O11 continuous cortex liveness.** Each `heartbeat` op carries a `cortex_alive` proof; a false
  proof is refused `dead_cortex` or forced to a visible-failure state — an hour-six death surfaces
  like an hour-zero one. *Red test:* `spec_reside_liveness.test.ts` (I13).
- **O12 named reaper.** `reapResidency` is the named reader: a `hibernated` residency whose
  `heartbeat_at` lapsed past `lease_until` is forced to `unseated`. *Red test:*
  `spec_reside_liveness.test.ts` (I14).
- **O14 verb parity.** `runReside` honours `COLTRANE_STORE_URL` / `COLTRANE_STORE_ANON` and mirrors
  `work`'s exit codes (`src/cli.ts:209`). *Red test:* `spec_reside_surface.test.ts` (I20). Caveat:
  asserted against verb wiring that does not exist yet; expected RED.
- **O15 red offline suite.** The whole suite runs offline (no `fetch`, no wall clock), keeping
  `tests/suite_reaches_no_remote.test.ts` green. *Guard:* `spec_reside_offline.test.ts` (I21).

---

## Verification method

**Property-based and model-based** (`fast-check ^3.23.2`, already a devDependency; the
`tests/committed_work/commitment_lifecycle.test.ts` and `tests/change_set/lifecycle.model.test.ts`
patterns), because the load-bearing invariants are universal properties over a state/transition
space, not single behaviours:

- **Exhaustive over the finite domain** — I5 (every `state × op` pair vs the legal table) and I6
  (every reserved op × every wrong actor) are enumerated, not sampled.
- **Property over generated inputs** — I1, I2, I4, I7, I9, I10, I11, I13, I15, I16.
- **Model-based over random op sequences** — I1 (cursor never exceeds the seal count across any wake
  sequence), I3 (no message answered twice across any host-swap sequence), I8 (single host across any
  claim sequence).
- **Referential identity** — I12 (`residencyGigPath === workOnce`).
- **Deterministic simulation** — I11 replaces the unmeasurable wall-clock 250 ms with an injected
  clock + a tick budget (the TigerBeetle VOPR / FoundationDB method), so the law holds identically on
  a laptop and a loaded Fly machine.

**The one non-RED invariant.** I21 ("the suite reaches no remote") is a property of the deliverable,
not of the absent enforcement, so a red assertion would be nonsensical. It is a **standing guard**,
green by design — exactly like `tests/suite_reaches_no_remote.test.ts` itself ("green from the outset
and must STAY green"). `spec_reside_offline.test.ts` does not import the absent module, so it runs and
stays green while every other reside file is red on that import. This is the sole justified exception
to RED-by-default, and it is covered, not uncovered.
