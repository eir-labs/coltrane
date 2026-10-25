# RED spec — a player is a name, a lineage, a memory and an instrument (coltrane 1.0)

**Criteria.** Capability belongs to the gig plan. Behaviour belongs to lineage. Notes belong to the
player. A chart is a chord progression. A gig is planned, played, and reflected on. A player holds
an office by residency and can be removed. Nothing a player carries is shaped to a model.

**Why now.** Measured 2026-10-01 across one session: 71 agents on `main` for a repertoire a quartet
should play. Grouped by what the engine could not then move off the agent, 35 groups; by exact
capability signature, 49. Every defect found that day was one defect — the agent definition carrying
the institution's job: tools on the player (#568 made them a chair ceiling), caps on the player
(`turn_budget` already resolved chair > agent), a role in a spend row where a player belonged (#567),
three players that were one written three times (#569). Patching that field by field is 0.x work
under a design the repo already states in its own vocabulary — `lineage-pass-v1`, `naming-ritual-v1`,
`institutions/`, `tours/`, chairs with `human: true`, ADICO `bearing_laws` — and has not made
structural.

**Laws.** `tests/spec_coltrane_1_0.test.ts`. Run `npx vitest run tests/spec_coltrane_1_0.test.ts`.
Nine assertions are executable against the engine as it stands and RED today on ABSENCE of the
mechanism (six since revision 1, three added at revision 6); the rest are `it.todo` because the seam
they pin has no API yet to assert against. A todo
is a law without a seam, not a law deferred. **This PR is RED by design.** The gate is the
spec-review verdict, not the test run. `scripts/laws.sh` counts are bumped so the only red is the
laws themselves.

**Revision 6** folds in what was found after revision 5 (written 1–2 Oct), verified against the engine's
`main` on 2026-10-25: step 0 is BUILT and steps 1–4 are not started (a status section, step 0's laws
re-pointed at what exists); an institution's governing record may live in an EXTERNAL governing store and
the genome holds a pinned COPY of it, never the authority (K); every law carries a RULE LEVEL, and a
constitutional change is sealed by the sponsoring organization's governor or, for a sovereign
institution, by its own (V); a sealed plan mints a trace INTENT and a sealed output a trace STEP (G8–G11);
the store port may be implemented by an external store, its contract is enumerated once, and where two
sides disagree on a column's type the contract names one (S2–S4); seats and traces carry enough to price
an act (G12); and step 4's survivors are chosen by a reduction judge, not by hand (D1). Items K, V and the
trace are OPERATOR DECISIONS dated 2026-10-25, each with the alternative it rejected. The store port,
the type seams, pricing and the reduction judge are the SPEC AUTHOR's proposals, marked as such; every
real choice they raise is a question in "Open at revision 6", not decided here. Every operator decision
revision 5 recorded is unchanged. Revision 5's text carried G1–G7 only in the laws file; they are restated
below from it, unchanged, so the trace has a section to sit in.

**Revision 5** folds in a THIRD non-author review of revision 4, which found four contradictions between a
decision and a law already in the document — the spec had stopped looking — plus seven more operator decisions
and one new object: a TURN is a gig.

**Revision 4** closed every open question by operator decision (2026-10-01); each is recorded as decided,
with the alternative it rejected, so the reasoning survives.

**Revision 3** folded in a SECOND non-author review of revision 2 on top of the first; what it found is marked
"second review" below.

**Revision 2** folded in a non-author review (ranked gaps G-A…G-G, a seam check per law, a sweep of
contradicting laws) and two objects named by the operator: residency and model agnosticism. The
review's pivotal finding and the operator's are the same gap seen from two sides: the first draft had
no object for *a position with a player in it*. It now has two, because that is one thing at plan
time and another thing across time.

## Status at revision 6 — verified against `main`, 2026-10-25

This PR's branch is based on an older `main`; the status below is read from `main` at the time of
writing, not from the branch.

- **Step 0 — Residency: BUILT.** The reside contract (`docs/specs/residency_contract.md`) is
  implemented: `src/residency.ts` is the state machine (closed states, closed ops, a party-constrained
  legal-transition table, the reflex, the reaper, the boot preflight — 43 laws per its own header,
  `tests/spec_reside_*.test.ts`), `src/reside.ts` is the standing loop mounted as `coltrane reside`, and
  `src/reside_backing.ts` selects the seat backing. The hosted seat is a DOOR: `postgrestSeatBacking`
  (`src/genome_store.ts`) drives the residency over public residency doors, the store backing injected by
  the deployment, not named by the loop (`tests/the_hosted_seat_is_a_door.test.ts`). A residency's token is
  minted INTO ITS VAULT by a member act whose answer never carries the token
  (`tests/a_residencys_token_is_minted_into_its_vault.test.ts`).
- **What step 0 as built does NOT yet carry**, said so it is not assumed: the built residency row
  (`RESIDENCY_ROW_FIELDS`: `agent_slug, org, venue_slug, channel_id, soul_output_id, status, session_id,
  cursor, host, lease_until, heartbeat_at, fence`) names no INSTITUTION and no OFFICE, so R1 ("through a
  current residency in the gig's institution") has no column to resolve through; the transition table
  reserves `unseat` to the holder and `reap` to the reaper, so there is no REMOVAL by the sealing office
  (R1 "can be removed", R3); the row keys on `agent_slug`, not a player uuid (P2, step 4); there is no
  `kind` (R5); and a booking does not park on an unheld office (T1). How R1/R3 meet the built row is
  question O2 below.
- **Steps 1–4: NOT STARTED.** A grep of `src/` on `main` finds no reflection phase, no session note, no
  gig-plan (`src/seat_plan.ts` is a PRE-FLIGHT that counts seats and bytes, not a sealed plan), no player
  lineage seal and no player store. All six revision-1 executable laws are red on `main` for the same
  absence, and so are the three added at revision 6.

## Three words for three things

The first draft used "chair" for three different objects. Fixed:

- **POSITION** — on a chart. `{ role, needs: [mode], in, out }`. Names the mode it needs, never who plays.
- **SEAT** — in a plan. A position with a player in it, for ONE gig: `{ position, player_id, tools, tier, cap, inputs, hydration, venue }`. Produced and sealed by the planner. Every per-player law at gig time hooks here.
- **OFFICE** — in an institution. Held by a player across gigs, by RESIDENCY, removable. Grants which positions a player may be planned into. The Ostrom position.

## Objects

### Player — `{ id, nick, lineage_ref, skills[], memory_ref }`

- **P1** — a player file carrying any of `primitives`, `behavioral_primitives`, `allowed_tools`,
  `model_tier`, `input_types`, `output_types`, `max_tool_calls`, `code_tool_access`, `method`,
  `constraints`, `identity` is REFUSED at load, naming the field. Eleven fields, not nine: the first
  draft left `behavioral_primitives` (disposition) and `identity` on the player, and disposition is
  what the LINEAGE carries. Mechanism: the loader's agent pass (`src/loader.ts:344-375`); today
  `AgentObjectSchema` (`src/genome_schema.ts:100`) REQUIRES `primitives` (:102),
  `behavioral_primitives` (:123), `identity`/`method`/`constraints` (:120-122). The direction inverts.
- **P2** — identity is `id` (uuid). `nick` is never a map key, a path segment, or a hash input.
  Today every `agents.get(slug)` keys on the nick; `genome_hash` sorts agents by slug
  (`src/runtime.ts:1397`); `src/genome_writer.ts:61-62` makes the slug a PATH under `genome/history/`.
- **P3** — a player of `kind: player` with no sealed PLAYER LINEAGE cannot be seated. Refused at PLAN, naming the
  player. (The first draft said "at compose" — there is no player at compose under C1.)
- **P4** — `human: true` becomes `kind: "human" | "player"`. Both are agent KINDS that hold offices
  and occupy seats. Mechanism: `ChairSchema` (`src/genome_schema.ts:201`, `human` at :226).
- **P5** — disposition lives in the player lineage seal, not on the player record and not in the
  plan. A plan may not re-dispose a player; a chart may not.

### Lineage — two objects, previously conflated

- **L0** — `lineage-record` (`domain_types/lineage-record.json`) is the lineage OF A QUESTION:
  external body, internal inventory, connections, gap, alignment. It is produced by
  `lineage-pass-v1` and attached to an institution. It is NOT a player's lineage and this spec stops
  using it as one.
- **L1** — a PLAYER LINEAGE SEAL is a new sealed type: `{ player_id, forebear, alignment, angle }` — who the player aligns with, on what angle — and
  NOTHING else. Sealed by the human office of `naming-ritual-v1`
  (`standards/naming-ritual-v1.json:57-58`) — and that office IS the governor's office (R4): one
  sealing office, not two, or the bootstrap is a cycle (second review). Per player, never per
  institution. **A residency may exist without a seal only during build steps 0–2**; from step 3 a
  resident with no seal cannot be planned into any seat (P3). **HUMANS NEED NO LINEAGE SEAL** (operator
  decision, third review): P3 applies to `kind: player` only. A human IS their lineage; the ritual is how a
  PLAYER earns a name from a forebear. So the governor's residency stays the ONE fixed point (R4) — the
  third review showed that otherwise the governor's own seal would be a second self-sealed record, since
  sealing any lineage seats the governor in the ritual's human seat. **Tension with the USER lives
  nowhere** (operator decision): it is what happens when a player plays for one; it needs no object, and
  the design intent survives only as prose. **`tensions[]` is DROPPED from the
  seal** (operator decision): a per-player immutable foundation cannot enumerate peers who are
  institution-scoped and who leave. Tension is EMERGENT — what two lineages produce when the plan
  seats them side by side — not declared. Rejected: naming other lineages on the seal (stable, but a
  second graph to keep true); naming players on the residency (institutional, ends on removal).
- **L2** — a player's prompt foundation is built FROM the seal's text. There is no `identity` field
  to drift from it. Mechanism: `buildPrompt` (`src/claude_invoker.ts:147`) reads `a.identity` at
  :204; the completions door calls the same `buildPrompt` (`src/completions_invoker.ts:342, :349, :362`), so one change covers
  both doors.
- **L3** — the behavioural floor keys on the seal's forebear discipline, not a primitives enum.
  Mechanism: `tests/_support/behavioral_families.ts:5-13` derives owed families from
  `a.primitives`; `tests/genome_behavioral_floor.test.ts:78`.
- **L4** — the current named players pass through the ritual like any other. A nick that alludes
  is permitted; the formal name is earned.

### Memory — the player's own store, with its own ledger

- **M1** — a memory artifact inside a repo tree is a `load_error`. "Repo tree" is DEFINED (second
  review: without it M1 is unenforceable and a file backing is a repo by every test the loader can
  run): any path under a genome root the loader is given, or under a directory containing `.git`. The
  player store's FILE backing (M5) lives under a path that is neither, named by `COLTRANE_PLAYER_STORE`,
  and the loader refuses a genome root that contains or is contained by it. The loader today reads a fixed
  list of directories (`src/loader.ts:258-657`) and walks nothing else, so this is a NEW pass, named
  here so it is not assumed to exist.
- **M2** — every gig's final phase is REFLECTION, appended by the ENGINE in the phase loop
  (`src/runtime.ts:2372`). REFLECTION IS THE FIFTH ENGINE AMENDMENT (operator decision, third review):
  when the ladder settles, the engine seals a `plan-amendment` adding one reflection seat per player that
  played, each with a FIXED engine-defined grant — read-only, low tier, small cap — so the seat has a
  capability source under G4 and G6 without being in the frame. It seats each player that played AFTER the ladder settles — the set of
  players is not known until the amend ladder stops re-seating (G6). It seals a session note per
  player.
- **M3** — a session note references the gig's outputs by `content_sha` and never carries their
  text. Consolidation (notes → generalised memory) is a SEALED act whose `input_shas` are the notes
  consumed, and it happens AT EVERY REFLECTION (operator decision): the reflection seat writes the
  gig's note and folds it into the player's generalised memory in one sealed act, so memory is always
  consolidated and a player is never seated carrying raw notes. Rejected: consolidating on the way
  into the next gig (a player that never plays again never consolidates, and the ten minutes before
  a gig are for the set list); a separate rehearsal chart (a new standard and a scheduling question).
- **M4** — a seated player is handed its consolidated memory on the invoke ctx (`src/runtime.ts:
  3660-3690`, beside `hydration` at :3669). A player with none is handed NOTHING — no default, no
  stand-in primer.
- **M5** — THE PLAYER STORE HAS ITS OWN LEDGER AND OUTPUT STORE. Sealing in this engine is
  `OutputStore.write` plus a ledger row (`chair_spend` at `src/runtime.ts:3825`, `gig` at :4437), both institutional. The first
  draft said notes live outside every repo AND are sealed with provenance, and did not say whose
  ledger — the reviewer was right that as written M1 and M3 cannot both hold. Resolution: the
  player store is a `GenomeStore`-style port with three backings like every other store in this
  engine (file / PostgREST / RPC), carrying its own ledger; cross-store references are by
  `content_sha` only and are NOT resolved by `outputs.addRef` — a note may name an institutional
  output it can no longer read (R3).

### Chart — a chord progression

`{ slug, phases[{ name, intent, positions[{ role, needs: [mode], in, out }] }] }`

- **C1** — a position names the MODE it needs, never who plays. No `agent_slug` on a chart; no
  `Standard.agent_slugs` (`src/genome_schema.ts:313`). Asserted as a universal negative over EVERY
  shipped standard, not one fixture.
- **C2** — a chart carrying methods, constraints, tool grants, tiers or caps is REFUSED. 260 pages
  of chord progressions. Mechanism: `StandardSchema` (:299) + the loader's standards pass.
- **C4** — TWO KINDS, NAMED (operator decision, third review — revising revision 4's C4). A CHECK is
  deterministic and engine-run: today's evals (`on_type`, `non_empty_fields`, `asserts`, run at
  `src/runtime.ts:4401-4418` with zero inference). It stays on the chart as a declared shape — a NAMED
  exception to C2, because it carries no capability and costs no inference. A JUDGEMENT needs a mind and
  is a VERIFY position; G3 applies to it by construction. The word "eval" goes; the chart says which it
  means. Revision 4 made every eval a VERIFY position, which would have turned a field-presence check into
  a model call and forced every one-position chart with an eval to seat a second player — against "treat
  inference as scarce". Rejected: all evals as positions (that cost); all evals engine-run (gives up the
  idea that some judgements on a chart deserve a player).

### Gig plan — a SEAT per position (G)

Restated from the laws file, unchanged (revision 5 carried these only there):

- **G1** — before performance a planner seals a gig-plan: the FIRST phase played is the plan, not the
  chart's first phase.
- **G2** — a seat whose position's needed mode the player's lineage does not support is refused AT PLAN
  (decidable there because the position carries `needs`; compose has no registry, `src/composition.ts:464`).
- **G3** — a seat that VERIFIES another seat's output cannot hold the same player.
- **G4** — the plan is the ONLY source of per-seat capability: a seat no plan granted anything reaches
  nothing, whatever the player file says.
- **G5** — reflection is appended by the engine, never declared on a chart (executable under M2/G5).
- **G6** — re-seating after the seal is a SEALED AMENDMENT by the ENGINE (expansion, ladder rungs, and
  reflection) or an OFFICE (approval) — and no one else; the planner's frame is final once sealed.
- **G7** — the plan is part of run identity: its `content_sha` enters `RunIdentity`, the checkpoint key
  becomes `(plan_sha, seat)`, and `ClaimedGig` carries the plan; a QUEUED gig is planned AT ENQUEUE by a
  resident planner of the queueing institution — the drain executes and never plans.

**The trace — OPERATOR DECISION, 2026-10-25.** Every sealed act is traced, and the trace is written by
the STORE, not by the engine's callers. Rejected: *trace as caller code* (a trace a writer must remember
to emit is a trace some writer skips, and the absence returns a legitimate-looking ledger).

- **G8** — every sealed gig plan mints a trace INTENT. The intent names the AUTHORIZING ACT in the
  governing store by an act id that is OPAQUE to the engine — the engine carries it and never interprets it.
  What a standalone engine's intent names is O7.
- **G9** — every sealed output mints a trace STEP pointing at its intent.
- **G10** — steps are APPEND-ONLY and CHAINED: each carries `prev_hash` and `hash`, so a removed or
  reordered step breaks the chain where it happened.
- **G11** — DEVIATION and NOVELTY are DERIVED — views over intents and steps — and never stored. The
  mechanism on a store that has one is an INSERT TRIGGER on gigs and on outputs that writes the trace, so no
  writer can skip it; what the file backing does, having no trigger, is O8.
- **G12** — PRICED ACTS (spec author's proposal). A seat is sealed with `(office, position mode, inputs,
  tier/model)` and its outputs by `content_sha` — enough to price each act as a code length under its
  office's lineage (two-part minimum description length: Rissanen 1978; Grünwald, *The Minimum Description
  Length Principle*, 2007). 1.0 does NOT build pricing. The law is only that the seat and trace shapes
  MUST carry office, position, inputs and outputs-by-hash, so pricing is possible later without a
  migration.

### Tours — a booking names an office

- **T1** — a Booking (`tours/*.json`, today `responsible_chair`) names the OFFICE responsible
  (operator decision). Whoever holds that office by residency at performance time is accountable, so
  a booking survives the player changing. `tours/coltrane.json:7` already names an institutional chair, so
  T1 is largely the status quo made law. **A booking whose office has NO incumbent at performance time
  PARKS** (operator decision, third review) — the same doctrine as a human chair with no approval: nothing
  is adopted on an absent incumbent, nothing fails that a seating could fill. Admissibility today checks
  only that the chair resolves, not that it is held. Rejected: naming a player (breaks when the residency ends
  before the gig); naming a plan (seats players before the work set exists, contradicting G1).

### Residency — a player holds an office, and can be removed

`{ player_id, institution, office, from, until | removed, grants[] }`, sealed.

- **R1** — a player is seated at a gig only through a CURRENT residency in the gig's institution.
  No residency, no seat. The plan resolves position → player THROUGH residency; P3's lineage gate
  sits beside it — lineage says who you are, residency says where you may sit. Mechanism:
  `institutions/*.json` chairs, assignments and incumbents (`institutions/quartet.json` — `org_members` :127, `chairs` :141, `assignments` :360),
  `DispatchCapGrantSchema` (`src/genome_schema.ts:843`). The first draft had three words for one
  thing and defined only the chart's.
- **R2** — a residency grants OFFICES, not capabilities. Tools and tier still come from the seat;
  residency bounds which positions a player may be planned into, including the planner's office.
  **ONE named exception** (operator decision, third review): the PLANNER's office carries a fixed grant
  — tools, tier, cap — sealed on the office by the governor, because it is the office that creates seats
  and so is the one seat in no plan. Rejected: a standing plan for planning (a plan that is never a
  gig's); engine-run planning (the set-list conversation becomes a lookup).
  The dispatch grant (`caps`) moves from the institutional chair to the planner's office.
- **R3** — ending a residency (expiry or removal) is a sealed act. The player's memory stays the
  player's (M1); the institution's outputs stay the institution's. A departed player must not carry
  the institution's text out with it — which is why M3 references by `content_sha`, and why the
  institution decides what a departed player may still dereference. This CLOSES the first draft's
  open question 3.
- **R4** — the first planner is seated by residency granted directly by the governor's office, not
  by a plan. The governor is the one office whose residency is not planned, because it is the
  office that seals namings and residencies. **The governor's own residency is the one self-sealed
  record in the system** — the fixed point, written down rather than left implicit (second review).
  Every other residency is sealed by it. This CLOSES the first draft's open question 1.
- **R5** — a human holding an office is a residency too (`kind: human`). Removal works identically.
- **Re-pointed at revision 6.** R1, R3, R5 and T1 now name the BUILT residency as their subject —
  `src/residency.ts` (`RESIDENCY_ROW_FIELDS`, `LEGAL_TRANSITIONS`, `applyResidencyOp`) and its seat
  backings — not `institutions/*.json` assignments alone. Each law is owed as the gap between the built
  row and the clause: an office and institution on the row (R1), removal as a sealed act of the sealing
  office (R3), a `kind` (R5), parking on an unheld office (T1). See O2.
- **R6** — hydration slots bound "at seat time" (CLAUDE.md, `p.chair.supplies`, `src/runtime.ts:
  3669`) bind at PLAN time from the office's supplies through the seat. The institution still
  supplies the data; the seat is where it arrives. Slots with `binding: "gig"` (`src/genome_schema.ts:
  66, :75`; skipped at compose, `src/composition.ts:411`) are filled by the PLANNER onto the seat from
  the work set — the same act that resolves the seat's inputs (G1). The dispatcher fills nothing.

### Governance source — the engine holds a copy, never the authority (K)

Revision 5 treated `institutions/*.json` as the authority over an institution, its offices, its charter
and its laws. That was true when nothing else held them. **OPERATOR DECISION, 2026-10-25:** an
institution's offices, charter and laws may be held by an EXTERNAL GOVERNING STORE — the institution's
governing store — and COPIED DOWN into the genome, pinned by content hash. The engine holds a copy, never
the authority. Rejected: *the genome is the authority* (the engine would then be where governance is
amended, and a repo commit would be a constitutional act no governing office sealed).

- **K1** — the genome's institution file is one of two things: AUTHORED LOCALLY (a standalone engine with
  no governing store — today's shape, unchanged) or a PINNED COPY of the governing store's record, carrying
  a pin block `pinned_from: { record, content_hash }` beside the `institution` section (the block's name
  and shape are the spec author's proposal). **A pinned copy whose content hash disagrees with the hash its
  pin declares is a `load_error` naming BOTH hashes** — the one the source declared and the one the copy
  actually has — and the document drops out like any other inadmissible institution. Seam:
  `loadInstitutions` (`src/institution_loader.ts`), which today ignores any section it does not know.
  What exactly is hashed is O3.
- **K2** — a pinned copy is not edited in the genome. A local edit to a pinned copy is not an amendment;
  it is a hash mismatch, and K1 refuses it. The record changes only where it is governed, and comes down
  again as a new pin.
- **K3** — the engine's own VARIANTS (an evolved charter, a proposed law, a new office) climb back to the
  governing store only through a governed path: NOVELTY → VERDICT → A HUMAN SEAL. The engine proposes; it
  never writes the authority. (The engine's existing `charter_suggest_update` / proposal surfaces are the
  novelty end of that path; the verdict and the seal are the governing store's.)

### Rule levels — every law says which level it is at (V)

**OPERATOR DECISION, 2026-10-25:** every law the engine carries — an institution's laws
(`InstitutionalLawSchema`), a chair's obligations (`NormPairSchema`), a `bearing_laws` record's ADICO law —
carries a LEVEL ∈ `operational | collective-choice | constitutional`, after Ostrom's levels of action and
Crawford & Ostrom (1995), "A Grammar of Institutions" — the same paper the ADICO grammar in
`src/genome_schema.ts` already cites. Rejected: *level-less laws* (a law that does not say what level it
is at cannot say who may change it, so every amendment is argued from scratch).

- **V1** — a law with no level is REFUSED, and a level outside the three is REFUSED. Today both
  `InstitutionalLawSchema` and `NormPairSchema` are STRICT, so a `level` field fails to parse — the field
  must be declared to exist at all. Asserted over the schemas AND over every law and obligation the shipped
  institutions carry (the universe pinned: every institution loads, the count is non-zero). Whether `level`
  is required with no default is O4.
- **V2** — a change at the CONSTITUTIONAL level — a charter, or a constitutional law — of a NON-SOVEREIGN
  institution requires the seal of its SPONSORING ORGANIZATION's governor office. A SOVEREIGN institution
  (`InstitutionSchema.sovereign`) seals its own. This GENERALISES R4's fixed point: the self-sealed
  governor residency is the sovereign case; every non-sovereign institution's constitution is sealed one
  level up. How the sponsor is named is O5.
- **V3** — the constitutional amendment of a charter is ITSELF a sealed act, with its own record — never a
  silent overwrite of the charter text. Under K, that record is the governing store's; the engine receives
  it as a new pin.

### Model agnosticism — cross-cutting

- **A1** — nothing a player carries is model-shaped: no model name, no model-specific prompt
  grammar, no invoker-specific session artefact, in the player record, the lineage seal, the skills
  or the memory. A lineage seal that only reads under one model is not a seal.
- **A2** — the seat names the model. `resolveModel(tier, fallback)` (`src/claude_invoker.ts:38`)
  reads the seat and nothing else. Same seat, different model, same player.
- **A3** — memory is written in the invoker-neutral note shape, never as a model session. Session
  continuity (`sessionUuidFor`, `--resume`) is an invoker's optimisation WITHIN a gig; memory is
  what survives the invoker. A player whose notes exist only as a vendor session id has no memory.
  **A ladder rung ends continuity** (second review): a `plan-amendment` that changes a seat's tier
  (G6) starts a fresh session under the new model; the new model does not `--resume` the old model's
  conversation. **A rung starts COLD** (operator decision, third review): a fresh seat with the same
  inputs and the failing verdict as its only extra. No mid-gig note — revision 4 said "the reflection note
  is what carries across" a rung, but M2 puts reflection once, after the ladder settles, so at rung time
  no note exists. That sentence is retracted.
  (This is also why the role→player session re-key kept colliding with the self-review barrier: it
  was asking a session to do memory's job.)
- **A4** — reflection runs under whichever door played the gig and produces the same note shape.
  The completions door already keeps transcripts (`tests/spec_completions_seat_transcript.test.ts`);
  reflection reads those, not a vendor's session store.

### Stores — every object on every backing

- **S1** — every new object (player, player lineage seal, gig-plan, plan-amendment, seat, residency,
  session note, consolidated memory) has a row shape on ALL THREE backings of `GenomeStore`
  (`src/genome_store.ts:41` — `GenomeClass` is seven classes today; `Q.agents` selects
  `identity,method,constraints,…` at :113-115 and reconstruction runs `defineAgent` at :292, which
  throws on a missing disposition). A law per object that the file, PostgREST and RPC views cannot
  drift — the existing parity invariant (`tests/genome_browse_parity.test.ts`) extended.
- **S2** — THE PORT, NOT THE STORE (spec author's proposal; entailed by K). A backing may target an
  EXTERNAL store that emits the engine's tables — gig, output, trace, drain lease, residency, player store —
  from its OWN declaration. The engine depends on the port's contract, never on which store implements it;
  the engine names no store. (The hosted seat already works this way: the loop names no store symbol and
  the deployment injects the backing.)
- **S3** — the port contract's TABLE and RPC set is ENUMERATED ONCE, as data, in the engine; each
  backing's parity test runs against that enumeration, so a table a backing forgets is a red parity law,
  not a runtime surprise. Today the selects live in a query map (`Q`, `src/genome_store.ts`) and nothing
  enumerates the RPCs.
- **S4** — KNOWN TYPE SEAMS (spec author's proposal). Where the engine and an external store disagree on a
  column's type, the port contract names ONE type and both sides conform. Seams found at revision 6:

  | Column | Types seen across the two sides | The contract's one type |
  | --- | --- | --- |
  | an act's verb | `uuid` vs `text` | O6 |
  | a trace payload | `text` vs `jsonb` | O6 |
  | a work order / work program id | `text` vs `uuid` | O6 |
  | a sequence | `integer` vs `bigint` | O6 |
  | a standard's `input_types` | `jsonb` vs array | O6 |

  The law is that each named column has exactly one type in the contract and every backing's row shape
  conforms; which type each gets is O6.

### Turn — a request is a gig

A request to the engine is a GIG (operator decision, 2026-10-02): planned, performed, reflected on, sealed
closed. There is no work outside a gig, and there is no open-ended turn. This document's own history is
the counterexample: open-ended turns whose closure was never deterministic, patches believed landed and
never read back, a review loop with no closing seal.

- **U1** — every request is a gig with the three movements. Work that is not inside one is not the
  engine's work.
- **U2** — turn closure IS the sealed reflection (M2, the fifth amendment). It is engine-appended and
  never left open; a turn is closed when its reflection is sealed and not before.
- **U3** — a turn that cannot reach reflection is a FAILED gig with a sealed reason — never an open one,
  and never a quiet success. (The ledger already refuses to let a failed gig record nothing; this extends
  that to the turn.)

## The hash, said once

`genome_hash` (`src/runtime.ts:1406`) covers the standard's phase graph and each agent's slug,
primitives, input_types, output_types, domain. Under 1.0 it covers charts (positions, modes, types);
run identity adds the plan's `content_sha` (G7); player identity is `id` + the lineage seal's
content hash.

- **H1** — every existing `genome_hash` and `run_fingerprint` changes meaning on the day this
  lands. `tests/genome_hash_stability.test.ts:101-106` pins the exact hash today and flips.
  `genome_hash` is NEVER waived at resume (`src/reuse.ts:168`), so every live checkpoint and reuse
  entry dies with it — not only ledger comparability. The 1.0 release says so in its first paragraph.
- **H2** — IDENTITY CONTINUITY ACROSS THE BREAK. A sealed `slug → player_id` table maps every 0.x
  ledger row, checkpoint and `genome/history/<slug>/` path onto a uuid player. Rows that cannot be
  mapped are reported as such, never guessed. (#567's 126 dark `chair_spend` rows are the
  precedent for what unmapped looks like.)

## What leaves

From agents: eleven fields (everything but `id`, `nick`, `lineage_ref`, `skills`, `memory_ref`).
From standards: `agent_slugs`, every agent-bound chair, every method and constraint. From
institutions: `caps` on chairs (moves to the planner's office). From the engine: the compose-time
"chair feeds an agent a type it never declared" refusal (`src/composition.ts:470`); the
primitives-keyed floor; `venueEffectiveTools(agent, venue)` as a public oracle; the role-keyed
session as anything other than an invoker optimisation.

## What it supersedes

A sweep of `tests/` for laws asserting the opposite of a 1.0 law: the behavioural floor
(`tests/genome_behavioral_floor.test.ts:63-90`, 7 laws × 71 agents ≈ 497), `chair_spend` must carry
`agent_slug` (#567, fights P2 — it becomes `player_id`), the agent∩chair∩venue ceiling (#568, fights
G4 — the agent is no longer a source), `venueEffectiveTools(agent, …)`
(`tests/chart_venue_classes.test.ts:174-185`), the pinned hash, `human: true` fixtures
(`tests/human_chair_approval.test.ts:38, 69`), agent-bound chairs in the session-continuity and
carried-skills laws. `agent_slug` appears in 198 test files. **Estimate: 550–650 of ~4400 laws
superseded outright (13–15%), fixture edits in ~200 files.** Said here so step 4's size is not a
surprise.

## Build order — each gates the next

0. **Residency** (R1, R3, R5, T1). **BUILT on `main`** (see Status): the reside contract, the hosted seat
   as a door, the token minted into the vault. Owed against it: the gaps the Status names (office and
   institution on the row, removal by the sealing office, `kind`, parking) — O2. K1–K3 and V1–V3 attach
   to the institution file this step rests on; where they land in this order is O1.
   Revision 5 said: mostly already in `institutions/`; make it sealed and load-bearing.
   INDEPENDENT of step 1 — the third review showed memory belongs to the player and survives a residency
   ending (M1/R3), so nothing in memory is owned "against" a residency. Steps 0 and 1 ship in parallel.
1. **Memory + reflection** (M1–M5, G5, A3–A4). New store with its own ledger, new final phase. Additive.
   TRANSITIONAL: until P2 (step 4) `memory_ref` keys on the nick, contradicting P2 in the interim — said
   here rather than discovered.
2. **Plan + seat** (G1–G7, A2, R2, R4, R6). New first movement, new sealed types, plan in run identity, the
   planner's office and its grant, gig-bound slots onto the seat. HARD dependency on 0 (R1: no residency,
   no seat); bypasses 1. R2/R4/R6 moved here from step 0 — they have no subject until there is a plan.
   THE TRACE (G8–G11) and the priced-act shape (G12) land here: a trace intent has no subject until there
   is a sealed plan. S2–S4 attach to whichever step first adds a table to the port contract — step 1's
   player store — not to step 4 (spec author's proposal).
3. **Lineage mandatory** (P3, P5, L1–L4, A1). Depends on 2 (checked at plan) AND on 0 (a seal needs the
   governor's residency to be sealed by).
4. **Strip and shrink** (C1–C4, P1, P2, P4, S1, H1–H2, D1). The one-time break. 71 players become however many
   have earned a name. The estimate in "What it supersedes" stands. **D1** (spec author's proposal): WHICH
   players, charts and institutions survive is decided by a REDUCTION JUDGE, not by hand — a candidate
   reduction is accepted only if replay holds ∧ the planted defects are still caught ∧ held-out work still
   passes ∧ the two-part description length of the genome STRICTLY DROPS. A player "has earned a name" when
   declaring it SHORTENS the description: a name that costs more to state than it saves is not kept. Which
   corpus the judge reads is O9.
5. There is no step 5.

## Open at the time of writing

Nothing. Formerly open, now decided: bootstrap (R4), notes-content (R3), consolidation cadence (M3), plan amendment (G6),
`tensions[]` (L1), who plans a queued gig (G7), what a booking names (T1), where evals go (C4); and from
the third review: the reflection seat's capability (M2/G6), the planner's own grant (R2), a rung's note (A3),
the governor's seal (P3), checks vs judgements (C4), tension with the user (L1), an unheld office (T1).

Every question raised across revisions 1–5 is decided above, each with the alternative it rejected.
Revision 6's three operator decisions (K, V, the trace) are recorded where they apply, with theirs.

## Open at revision 6

Each is the operator's to decide; the alternatives are listed, none is chosen here.

- **O1 — where K and V land in the build order.** (a) In step 0, re-opening a built step; (b) a new step
  between 0 and 2, so step 0 stays closed and the plan's office checks (R2, R4) read levels from the start;
  (c) in step 4, because V1 makes `level` required on every shipped law and that is a one-time break.
- **O2 — how R1/R3 meet the built residency.** (a) Extend the built row with `institution`, `office`,
  `from`, `until | removed`, and add a `remove` op reserved to the sealing office; (b) keep the reside row as
  PRESENCE (where a player sits and listens) and add a separate sealed OFFICE-HOLDING record that R1
  resolves through; (c) resolve office through the existing chair assignment (`ChairAssignmentSchema`) and
  leave the reside row as it is.
- **O3 — what a pin's content hash covers.** (a) sha256 over the engine's canonical JSON of the document
  minus its pin block; (b) the governing store's own hash of its record, carried verbatim, re-derived by a
  canonicalization the port contract publishes; (c) both, and K1 names all three on a mismatch.
- **O4 — a law with no level in a standalone engine.** (a) Required, no default — every shipped law and
  obligation is migrated when V1 lands; (b) defaulted to `operational` (against "absent must mean decline",
  stated so it is chosen knowingly); (c) required only on a pinned copy, optional on a locally authored file.
- **O5 — how a non-sovereign institution names its sponsoring organization (V2).** (a) The existing
  `OrganizationSchema.parent_org` chain; (b) a new `sponsor` field on the institution section; (c) only the
  governing store's record names it, and the engine reads it from the pinned copy.
- **O6 — the one type per seam (S4).** (a) The wider type wins (`text` over `uuid`, `jsonb` over `text`,
  `bigint` over `integer`, `jsonb` over array); (b) the stricter type wins (`uuid`, `jsonb`, `uuid`,
  `bigint`, array); (c) the external store's declaration wins and the engine conforms.
- **O7 — a trace intent in a standalone engine (G8).** (a) Required — a standalone engine mints a local act
  and names it; (b) nullable — a standalone intent names no act and says so; (c) the operator's approval of
  the gig is the act.
- **O8 — the trace on the file backing (G11).** (a) The file backing's write path appends the trace in the
  same write as the gig or output row — still the store's write, never a caller's; (b) the file backing
  refuses step-2 gigs; (c) the trace exists only on stores that have triggers, and the file backing says so.
- **O9 — the reduction judge's corpus (D1).** (a) The ledger's replay corpus; (b) a held-out set sealed
  before step 4 begins; (c) both, with the held-out set never read while candidates are drawn.

A decision is not a law: each is owed one at its build step, and this document stops being a spec the day
the last of them is green.
