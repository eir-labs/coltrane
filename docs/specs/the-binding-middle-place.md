# The binding middle place — committed work as a first-class genome object

RED-first spec. The sealed lineage-record `lineage-record-committed-future-work-eb1f7b05` located an
omission: Coltrane implements the **intention** (`NorthstarSchema`) and the **settled actual**
(`GigLedgerEntry`) and the **acceptance primitive** (`InstitutionalLawCheckSchema`), and omits the
**binding middle place** — the commitment that carries an amount, an accountable party, a period and
an acceptance condition. In GASB No. 54 terms we hold the appropriation ceiling
(`ChartBudgetEnvelope`) and the expenditure (`GigLedgerEntry`) and omit the **encumbrance**. This
change adds that leg: a **Tour** (the institution-visible aggregation) and its **Bookings** (each a
committed future gig), drawing over declared **Resources**, riding the acceptance seam already on
`main`, and supplying the promised-versus-delivered **numerator** the record named missing.

The build is by REUSE, not invention. `acceptance` is exactly `LawCheck` (`{predicate, inputs}`) and
is decided by the SAME `evaluate()`; tour admissibility returns the SAME `AdmissibilityResult` as
`checkInstitutionAdmissibility` — the third application of that one bar; the tier is
`NormPairSchema`'s `declared | enforced`; the non-convertible-unit rule is house law at
`BudgetState.unit`; the variance reads the SAME ledger chain the engine settles against.

## Change discipline

| field | value |
|---|---|
| `scope` | `TourSchema` / `BookingSchema` / `ResourceSchema`; a party-constrained commitment lifecycle; `checkTourAdmissibility`; a chain-read variance; two visibility queries and two report queries; prior-art attribution rows; Coltrane's own roadmap as the worked-example tour; synthetic funded fixtures. |
| `vitest_test_path` | `tests/committed_work/*.test.ts` (six files), RED-first. |
| `stop_condition` | every contract invariant has ≥1 running RED assertion (or a documented durable guard); the suite compiles; every shipped genome file still loads and composes; `institutions/coltrane.json` still passes admissibility. |
| `non_goals` | stake / payout / heat / witness tiers / currency of account and all economics; any brief/report GENERATOR; store-side tables; unit conversion or exchange rates; any question/interrogation engine. |
| `run_protocol` | `npx tsc --noEmit` (clean) then `npx vitest run tests/committed_work` (RED) then the affected existing suites (green). |
| `outcome` | completed (red-spec) — the enforcement the tests demand is unbuilt by design; that is the point, not a failure. |

## The seam (stubbed signatures whose bodies throw — `src/committed_work.ts`)

Authored exactly as `src/institution_enforcement.ts` was before its bodies were filled: the
signatures, the closed state set, the party vocabulary and the Result codomains are the FIXED SEAM;
the GREEN change fills the bodies without touching them. The suite therefore COMPILES, so every red
assertion fails on absent enforcement (a throw / an unbuilt schema), never on a type error. The GREEN
change promotes the three Zod schemas into the single Zod source in `src/genome_schema.ts` (per
`CLAUDE.md`), re-exporting them from `committed_work.ts` so the tests need no edit.

## Obligation → mechanism → callsite → red test

| # | obligation | mechanism / callsite | red test |
|---|---|---|---|
| O1 | Tour references institution + org + responsible_chair, carries period, northstars, bookings | `TourSchema` (mirrors `VenueSchema`: `institution_slug` + `responsible_chair`); all cross-refs are slugs | `schema_shape.test.ts` INV1 |
| O2 | Booking carries aim, amount?, period, accountable_office, acceptance, draws[], lifecycle | `BookingSchema` | `schema_shape.test.ts` INV2, INV14, INV32 |
| O3 | Tour REFERENCES its institution, does not live inside `InstitutionSchema` | Tour is top-level; `InstitutionSchema` gains no bookings field | `schema_shape.test.ts` INV4 |
| O4 | acceptance reuses `LawCheck`, decided by the same `evaluate()`; no second predicate form | `Booking.acceptance: LawCheck`; `evaluate()` from `institution_enforcement` | `tour_admissibility.test.ts` INV3 |
| O5 | lifecycle is a party-constrained state machine, not a status field | `applyCommitmentOp(rec, op)` → `CommitmentTransition` | `commitment_lifecycle.test.ts` INV5–INV12 |
| O6 | capacity is its own class | `ResourceSchema` (holder, quantity, unit, period, transferable) | `schema_shape.test.ts` INV13 |
| O7 | a draw is a vector; over-commitment per unit, no conversion | `checkTourCapacity(tour, resources)`; `Draw[]` | `resource_draw_capacity.test.ts` INV15, INV16 |
| O8 | a non-transferable holding of another org is unreachable | `checkTourCapacity` cross-org rule | `resource_draw_capacity.test.ts` INV17, INV18 |
| O9 | `checkTourAdmissibility` — pure, explicit, collect-all/refuse-once, WIRED into `loadGenome` via `loadTours` (fails closed at load) | `checkTourAdmissibility(doc)` → `AdmissibilityResult` | `tour_admissibility.test.ts` INV19, INV23 |
| O10 | refuse an unmarked/unevaluable commitment; refuse an undeclared-resource draw; reuse the tier vocab | `checkTourAdmissibility`; `Booking.tier` (`NormPairSchema` enum) | `tour_admissibility.test.ts` INV20, INV21, INV22 |
| O11 | variance from the booking → gig → spend chain, read not assembled | `computeVariance(booking, ledger)` reads `GigUsage.total_cost_usd` | `variance_and_reports.test.ts` INV24, INV25 |
| O12 | unpromised work and undispatched bookings both visible | `unpromisedGigs`, `undispatchedBookings` | `variance_and_reports.test.ts` INV26, INV27 |
| O13 | two reports as set-difference queries | `northstarsWithNoBooking`, `bookingsServingNoNorthstar` | `variance_and_reports.test.ts` INV28, INV29 |
| O14 | no stake / economics — the absence IS the spec | forbidden-field-name guard over the seam + worked tour | `economics_additive_worked.test.ts` INV30 |
| O15 | no off-repo reference; every ref resolves in-repo | slug/id cross-refs only; dead-name refusal | `tour_admissibility.test.ts` INV31; `variance_and_reports.test.ts` INV25 |
| O16 | ship Coltrane's roadmap-as-tour (amounts absent) + synthetic funded fixtures | `tours/coltrane.json`; `tests/committed_work/_fixtures.ts` | `economics_additive_worked.test.ts` INV33, INV34 |
| O17 | additive-only; compiles; shipped files load unchanged; coltrane still admissible | new file + new `tours/` dir invisible to `loadGenome` | `economics_additive_worked.test.ts` INV35, INV36, INV37, INV39 |
| O18 | seal GASB 54 + Singh prior art as `GENOME_ATTRIBUTIONS` rows | additive data rows in `genome_schema.ts` (green change) | `economics_additive_worked.test.ts` INV38 |

## The five design points, resolved (from the grounding's open questions)

1. **Booking → gig join key**: an in-repo `Booking.settled_gig_ids[]`, NOT a ledger schema bump — the
   ledger's identity fields stay untouched (INV25).
2. **Draw unit**: a free string treated as OPAQUE and non-convertible, exactly as `BudgetState.unit`
   (`"append-units"`); the no-conversion rule is asserted, not assumed (INV16).
3. **Detach antecedent**: reuses `LawCheck` (`Booking.antecedent`) over sibling-booking facts, keeping
   ONE predicate form; the worked example's second booking is staged this way.
4. **Lifecycle storage**: an append-only operation log (`CommitmentRecord.log`), so Delegate's residual
   responsibility is RECORDED, not overwritten (INV8).
5. **amount × tier**: `amount` absence is simply "no variance numerator", NOT a second tier — the
   acceptance axis is the only checkable-property tier (INV32).

## Stated non-goals — doors closed on purpose, not gaps left open

Two absences below READ like gaps that a later change would be tempted to "fix." They are not
gaps; they are the design, stated here so the door stays shut.

- **No exchange rate, no unit conversion — ever.** A draw is a vector of unit-tagged quantities and
  over-commitment is checked strictly PER UNIT. When capacity is tight across two bookings drawing
  DIFFERENT units, this layer gives no way to rank them, and that is correct: ranking incommensurable
  units is a judgement a chair makes, not arithmetic. A conversion table would hide a policy inside
  a rate and let a spend in one unit silently free capacity in another — the exact failure the
  per-unit rule (INV16) exists to refuse. There is deliberately no rate anywhere in this layer, and
  none is to be added. A cross-unit ranking, if one is ever wanted, is a chair's explicit decision
  recorded as its own object, never a hidden coefficient in this arithmetic.

- **Replenishment is a quantity over time in the resource's OWN unit.** A `Resource` may carry an
  optional `replenishment` — a monthly seat renews, a one-off purchase does not, a rate-based
  capacity decays — so ONE declared-capacity definition serves every kind of holding rather than a
  parallel ledger growing elsewhere that could disagree about the same organization. It stays inside
  the same non-convertible-unit discipline as everything else: the refill magnitude is stated in the
  resource's own unit and the cadence is a period, and NOTHING here converts between units. A
  replenishment is not, and must not become, a rate that translates one unit into another.

## Testing method and the durable guards

The party constraints and the capacity conservation laws are pinned as **property-based** assertions
with `fast-check` (already a repo dependency; the method the reserve-pool no-theft law uses): "a
creditor cannot cancel" and "no unit is ever over-drawn" must hold for EVERY generated case, not one.
The refusals and the variance are **example-based** against the real callsites. Four invariants —
INV35 (shipped files load unchanged), INV36 / INV37 (the seam compiles as real symbols), INV39
(pre-existing files round-trip) — are **durable green guards**, exactly as this repo's own change-set
red spec ships I15 / I16: a guard earns its place by FAILING the moment the discipline is broken (a
minted stake field, a broken shipped file, a missing seam), not by being red today. Every other
invariant has at least one assertion that is RED because the enforcement is absent.
