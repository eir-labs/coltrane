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
Ten assertions are executable against the engine as it stands and RED today — on ABSENCE of the
mechanism, or (V4) on the PRESENCE of a field a ruling removed: six since revision 1, four added at
revision 6; the rest are `it.todo` because the seam
they pin has no API yet to assert against. A todo
is a law without a seam, not a law deferred. **This PR is RED by design.** The gate is the
spec-review verdict, not the test run. `scripts/laws.sh` counts are bumped so the only red is the
laws themselves.

**Revision 6** folds in what was found after revision 5 (written 1–2 Oct), verified against the engine's
`main` on 2026-10-25, then a non-author review of the first revision-6 draft ("accept with named fixes",
each applied below) and three operator rulings given the same day. Step 0 is BUILT and steps 1–4 are not
started (a status section; step 0's laws re-pointed at what exists). An institution's governing record may
live in an EXTERNAL governing store and the genome holds a pinned COPY of it, never the authority — and
residencies and namings are SEALED IN THAT STORE; the engine verifies, it no longer seals (K). Every law
carries a RULE LEVEL, a law with none is refused at admission, and every institution's constitution is
sealed by its SPONSORING ORGANIZATION's governor office — there is no sovereign institution (V). The store,
not caller code, mints a trace for every sealed plan and output, and deviation and novelty are derived
(G8–G11). Operator decisions dated 2026-10-25, each recorded with the alternatives it rejected: K
(governance source), the sealer under K, V (levels), admission refusal of a level-less law, no sovereign
institution, and the trace. The store port and its enumeration, the type seams, the trace's chaining and
trigger, priced acts and the reduction judge are the SPEC AUTHOR's proposals, marked as such; every real
choice they raise is a question in "Open at revision 6", not decided here. Every operator decision revision
5 recorded is unchanged EXCEPT where a 2026-10-25 ruling changes it, and each such place says so (R4 and L1:
who seals; no sovereign institution). Revision 5's text carried G1–G7 only in the laws file; they are
restated below from it, unchanged, so the trace has a section to sit in.

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

The branch is rebased onto `main` (6fff3f7); line references are to that tree.

- **Step 0 — Residency: BUILT.** The reside contract (`docs/specs/residency_contract.md`) is
  implemented: `src/residency.ts` is the state machine (closed states, closed ops, a party-constrained
  legal-transition table, the reflex, the reaper, the boot preflight — "the 40 laws in
  `tests/spec_reside_*.test.ts`", per its own header), `src/reside.ts` is the standing loop mounted as
  `coltrane reside`, and `src/reside_backing.ts` selects the seat backing. The hosted seat is a DOOR:
  `postgrestSeatBacking` (`src/genome_store.ts`) drives the residency over public residency doors, named
  once in `HOSTED_SEAT_DOORS` (`src/genome_store.ts:1163`), the backing injected by the deployment, not
  named by the loop (`tests/the_hosted_seat_is_a_door.test.ts`). A residency's token is minted INTO ITS
  VAULT by a member act whose answer never carries the token
  (`tests/a_residencys_token_is_minted_into_its_vault.test.ts`).
- **What step 0 as built does NOT yet carry, or carries against this spec**, said so it is not assumed:
  - the built residency row (`RESIDENCY_ROW_FIELDS`: `agent_slug, org, venue_slug, channel_id,
    soul_output_id, status, session_id, cursor, host, lease_until, heartbeat_at, fence`) names no
    INSTITUTION and no OFFICE, so R1 ("through a current residency in the gig's institution") has no column
    to resolve through;
  - **the residency CARRIES CAPABILITIES, against R2.** A residency claim carries `hands` and
    `may_dispatch` (`src/reside.ts:142-143`; read from the hosted claim at `src/genome_store.ts:1209-1210`
    and written at seating, `:1124-1130`); the local backing hands every claim `may_dispatch: ["*"]`
    (`src/reside_backing.ts:289`). R2 says a residency grants OFFICES, not capabilities. The built comment
    says the wildcard "widens nothing" because dispatch authority still sits on the chair — but it is a
    capability field on the residency all the same;
  - the transition table reserves `unseat` to the holder and `reap` to the reaper (`RESERVED_PARTY`,
    `src/residency.ts:229`); **`drain` is UNRESERVED** — any party may drain a residency — and there is no
    REMOVAL by the sealing office (R1 "can be removed", R3);
  - the row keys on `agent_slug`, not a player uuid (P2, step 4); there is no `kind` (R5); and a booking
    does not park on an unheld office (T1).

  How R1/R2/R3 meet the built row is question O2 below.
- **#578 — a lineage-record names its forebear (v3).** Since revision 5, `lineage-record` (the lineage OF A
  QUESTION, L0) gained a `forebear`. That is pressure on L0: the question-lineage now carries the one field
  that defines a PLAYER lineage seal (L1 `{player_id, forebear, alignment, angle}`), so the two objects L0
  separates now share a word. L0 stands — a question's forebear is a source, a player's is who it aligns
  with — but the separation is now a claim a law must hold, not a difference in shape anyone can see.
- **Steps 1–4: NOT STARTED.** A grep of `src/` finds no reflection phase, no session note, no gig-plan
  (`src/seat_plan.ts` is a PRE-FLIGHT that counts seats and bytes, not a sealed plan), no player lineage
  seal and no player store. All six revision-1 executable laws are red for the same absence, and so are
  the four added at revision 6.

## Three words for three things

The first draft used "chair" for three different objects. Fixed:

- **POSITION** — on a chart. `{ role, needs: [mode], in, out }`. Names the mode it needs, never who plays.
- **SEAT** — in a plan. A position with a player in it, for ONE gig: `{ position, player_id, office, tools, tier, cap, inputs, hydration, venue }` (`office` added at revision 6: the office the player holds by residency and is seated through, R1 — the trace and G12 read it). Produced and sealed by the planner. Every per-player law at gig time hooks here.
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
  sealing office, not two, or the bootstrap is a cycle (second review). **Revision 6 (operator decision,
  2026-10-25 — K4):** that seal is an ACT IN THE GOVERNING STORE. The engine holds the sealed record by
  content hash and refuses an unsealed one; it verifies, it no longer seals. The ritual still runs as a gig
  in the engine; its human seat's verdict is sealed where the governor's office is governed. Per player, never per
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

**The trace.** The engine already has a provenance graph: `coltrane trace <output-id>` walks an output's
provenance (`src/cli.ts:71`) and `output_trace` returns it as a graph (`src/mcp.ts:75`). The trace below
EXTENDS that graph; it is not a second one. Two words are reserved here to avoid collisions: a **trace
intent** is minted from a sealed plan — it is NOT the pull-request intent the engine already hashes
(`intent_sha`, `src/runtime.ts:1558`), and pricing below is NOT the credit arithmetic of `computeCredits`
(`src/pricing.ts:24`).

**OPERATOR DECISION, 2026-10-25:** the trace is minted by the STORE, never by caller code; DEVIATION and
NOVELTY are DERIVED, never stored. Rejected: *trace as caller code* (a trace a writer must remember to emit
is a trace some writer skips, and the absence returns a legitimate-looking ledger). That is the whole of
the decision; the rest of this section is the spec author's proposal for how.

- **G8** — every sealed gig plan mints a **trace intent**, minted on the PLAN row's insert (not the gig's:
  the plan is what was authorized; a gig row exists before its plan is sealed). The intent names the
  AUTHORIZING ACT in the governing store by an act id OPAQUE to the engine — carried, never interpreted.
  What a standalone engine's intent names is O7.
- **G9** — every sealed output mints a **trace step** pointing at its intent. In `output_trace`'s graph a
  trace step is an edge from the output to its plan's intent, so a walk from any output reaches what
  authorized it.
- **G10** — (spec author's proposal) steps are APPEND-ONLY and CHAINED: each carries `prev_hash` and
  `hash`, so a removed or reordered step breaks the chain where it happened.
- **G11** — deviation and novelty are DERIVED views over intents and steps, never stored (operator
  decision). The MECHANISM — an insert trigger on plan rows and on outputs that writes the trace, so no
  writer can skip it — is the spec author's proposal; what the file backing does, having no trigger, is O8.
- **G12** — PRICED ACTS (spec author's proposal). A seat is sealed with `(office, position mode, inputs,
  tier/model)` and its outputs by `content_sha` — enough to price each act later as a code length under
  what L1 allows a seat to be described by: the SEATED PLAYER's lineage seal and the OFFICE's statements
  (its charter, laws and obligations) — not an "office lineage", which this spec does not have. Two-part
  minimum description length: Rissanen 1978; Grünwald, *The Minimum Description Length Principle*, 2007.
  1.0 does NOT build pricing. The law is only that the seat and trace shapes MUST carry office, position,
  inputs and outputs-by-hash, so pricing is possible later without a migration.

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
  **Revision 6.** Two operator rulings of 2026-10-25 change who seals and whose fixed point this is. (i) K4:
  residencies and namings are sealed by an ACT IN THE GOVERNING STORE; the engine holds each sealed record
  by content hash and refuses an unsealed one — the engine VERIFIES the fixed point, it does not seal it.
  (ii) V2: there is no sovereign institution; every institution's constitution is sealed by its SPONSORING
  ORGANIZATION's governor office. FOLLOWING FROM THE TWO — not itself a recorded decision, and flagged for
  operator confirmation (O10) — the governor office whose residency is the one self-sealed record is the
  ORGANIZATION's governor, not an institution's.
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

K covers BOTH read paths the engine has for an institution: the FILE loader (`loadInstitutions`,
`src/institution_loader.ts`) and the HOSTED read (`Q.institutions`, `src/genome_store.ts:148-157`, whose
reconstruction has no institution branch yet). One check, shared by both, so the two cannot disagree about
whether a copy is honest — the discipline the institution envelope already states ("file and store backings
cannot drift").

- **K1** — the genome's institution document is one of two things: AUTHORED LOCALLY (a standalone engine
  — today's shape, unchanged) or a PINNED COPY of the governing store's record, carrying a pin block
  `pinned_from: { record, content_hash }` beside the `institution` section (the block's name and shape are
  the spec author's proposal). **A pinned copy whose content hash disagrees with the hash its pin declares
  is a `load_error` naming BOTH hashes** — the one the source declared and the one the copy actually has —
  and the document drops out like any inadmissible institution. **A pinned copy whose hash MATCHES is
  admitted** (the positive control: the law takes the copy's hash from the refusal and re-pins with it, so
  it fixes no hash format — what is hashed, and how, is O3).
- **K2** — a pinned copy is not edited in the genome. A local edit to a pinned copy is not an amendment;
  it is a hash mismatch, and K1 refuses it. The record changes only where it is governed, and comes down
  again as a new pin. **The engine writes into institution files today:** `persistLineageAdoption`
  (`src/lineage_persist.ts:78`) writes an adopted lineage into the document's `institution` section. On a
  locally authored file that stays; on a PINNED COPY that write must become a PROPOSAL to the governing
  store (K3), never a local edit — or the engine's own adoption would break its own pin.
- **K3** — the engine's own VARIANTS (an evolved charter, a proposed law, a new office, an adopted
  lineage) climb back to the governing store only through a governed path: NOVELTY → VERDICT → A HUMAN
  SEAL. The engine proposes; it never writes the authority. (The engine's existing charter-suggestion and
  proposal surfaces are the novelty end of that path; the verdict and the seal are the governing store's.)
- **K4** — WHO SEALS. **OPERATOR DECISION, 2026-10-25:** residencies and namings are sealed by an ACT IN
  THE GOVERNING STORE. The engine holds the sealed record by content hash and REFUSES an unsealed one; it
  verifies, it no longer seals. Rejected: *the engine's governor office* (the engine would seal the
  authority it only holds a copy of — K's own contradiction); *either, by mode* (two sealers for one record
  kind, chosen by deployment, is two answers to "who sealed this"). R4 and L1 are reconciled to this above.
  What a STANDALONE engine — one with locally authored institution files and no governing store —
  verifies against is O11.

### Rule levels — every law says which level it is at (V)

**OPERATOR DECISION, 2026-10-25:** every law the engine carries — an institution's laws
(`InstitutionalLawSchema`), a chair's obligations (`NormPairSchema`), a `bearing_laws` record's ADICO law —
carries a LEVEL ∈ `operational | collective-choice | constitutional`, after Ostrom's levels of action and
Crawford & Ostrom (1995), "A Grammar of Institutions" — the same paper the ADICO grammar in
`src/genome_schema.ts` already cites. Rejected: *level-less laws* (a law that does not say what level it
is at cannot say who may change it, so every amendment is argued from scratch).

- **V1** — **OPERATOR DECISION, 2026-10-25:** a law with no level is REFUSED AT ADMISSION — the
  institution is refused, naming the law — and the law itself still PARSES. This is the precedent the
  engine already has for an obligation's `tier`: optional in `NormPairSchema`, refused when unmarked by
  `checkInstitutionAdmissibility` (`src/institution_enforcement.ts`). Rejected: *schema refusal* (a parse
  failure drops the document with a zod message, not an admissibility offender naming the law); *pinned
  copies only* (a locally authored law would then be the one place a level could be silent). A level
  outside the three fails the schema's enum. Today both schemas are STRICT, so a `level` cannot be written
  at all — the law is red on that.
- **V2** — **OPERATOR DECISION, 2026-10-25, verbatim: "theres no such thing as a sovereign
  institution."** Every institution's constitution — its charter and its constitutional laws — is changed
  only under the seal of its SPONSORING ORGANIZATION's governor office. Sovereignty, where it exists, is an
  ORGANIZATION's. Rejected (by the ruling): a sovereign institution that seals its own constitution — which
  revision 6's first draft proposed and this revision withdraws. `InstitutionSchema.sovereign`
  (`src/genome_schema.ts:801`) exists today and is RULED OUT: owed removal at step 4's strip (V4). How an
  institution names its sponsor is O5. **Where the charter lives today:** only on the ORGANIZATION
  (`OrganizationSchema.charter`, `src/genome_schema.ts:814`); `InstitutionSchema` has no charter. So "an
  institution's charter" has no field yet — V2's subject is the organization's charter as it binds the
  institution, until O5 says otherwise.
- **V3** — the constitutional amendment of a charter is ITSELF a sealed act, with its own record — never a
  silent overwrite of the charter text (today `OrganizationSchema.charter` is a nullable string, so an
  overwrite is exactly what a write would do). Under K and K4 that record is the governing store's; the
  engine receives it as a new pin.
- **V4** — no institution is sovereign: `InstitutionSchema` carries no `sovereign` field and no shipped
  institution declares one. Red today on PRESENCE. Owed at step 4.

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
- **S2** — THE PORT, NOT THE STORE (spec author's proposal). A backing may target an EXTERNAL store that
  emits the engine's tables — gig, output, trace, drain lease, residency, player store — from its OWN
  declaration. The engine depends on the port's contract, never on which store implements it; the engine
  names no store. (The hosted seat already works this way: the loop names no store symbol and the
  deployment injects the backing.)
- **S3** — (spec author's proposal) the port contract's TABLE and RPC set is ENUMERATED ONCE, as data, in
  the engine, and it BINDS THE ACTUAL WRITERS: every table the engine's writers and hosted readers address
  — the output and gig mirrors (`src/output_mirror.ts:493`, `:633`), the hosted gig read
  (`src/hosted_tools.ts:122`) — is in the enumeration, and every residency door is among its RPCs.
  `HOSTED_SEAT_DOORS` (`src/genome_store.ts:1163`) is the existing PARTIAL enumeration — the residency doors
  named once — and S3 generalises it. Each backing's parity test runs against the enumeration. The
  executable law covers the tables that exist TODAY and goes green only on a real enumeration those writers
  are checked against, never on a name appearing in a file. Tables owed by later steps join with their
  step: **S3.1** the player store's tables at step 1, **S3.2** the trace's tables at step 2.
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
   institution on the row, capabilities on the residency, an unreserved `drain`, removal by the sealing
   office, `kind`, parking) — O2. K1–K4 and V1–V3 attach to the institution document this step rests on;
   where they land in this order is O1.
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
   is a sealed plan. S3 lands with today's tables; S3.1 joins at step 1, S3.2 here (spec author's
   proposal). S2 and S4 attach to whichever step first adds a table to the port contract.
3. **Lineage mandatory** (P3, P5, L1–L4, A1). Depends on 2 (checked at plan) AND on 0 (a seal needs the
   governor's residency to be sealed by — under K4, an act in the governing store the engine verifies).
4. **Strip and shrink** (C1–C4, P1, P2, P4, S1, H1–H2, V4, D1). The one-time break. 71 players become
   however many have earned a name. The estimate in "What it supersedes" stands. **D1** (spec author's
   proposal): the reduction judge is scoped to PLAYERS and CHARTS in LOCALLY AUTHORED files — never a pinned
   copy, which is the governing store's (K). The judge PROPOSES; it does not decide. A candidate reduction
   is proposed only if replay holds ∧ the planted defects are still caught ∧ held-out work still passes ∧
   the two-part description length of the genome STRICTLY DROPS, and it travels K3's governed path —
   novelty → verdict → a human seal — where the HUMAN SEAL decides. A name is still EARNED THROUGH THE
   NAMING RITUAL (L1, L4): that declaring a player shortens the description is EVIDENCE for the seal, not a
   replacement for it. Which corpus the judge reads is O9. `InstitutionSchema.sovereign` is removed here
   (V4).
5. There is no step 5.

## Open at the time of writing

Nothing. Formerly open, now decided: bootstrap (R4), notes-content (R3), consolidation cadence (M3), plan amendment (G6),
`tensions[]` (L1), who plans a queued gig (G7), what a booking names (T1), where evals go (C4); and from
the third review: the reflection seat's capability (M2/G6), the planner's own grant (R2), a rung's note (A3),
the governor's seal (P3), checks vs judgements (C4), tension with the user (L1), an unheld office (T1).

Every question raised across revisions 1–5 is decided above, each with the alternative it rejected.
Revision 6's operator decisions (K, K4, V, V1's admission refusal, V2's ruling, the trace) are recorded
where they apply, with theirs.

## Open at revision 6

Each is the operator's to decide; the alternatives are listed, none is chosen here. (O4 — what happens to
a law with no level — was decided on 2026-10-25 and is recorded at V1.)

- **O1 — where K and V land in the build order.** (a) In step 0, re-opening a built step; (b) a new step
  between 0 and 2, so step 0 stays closed and the plan's office checks (R2, R4) read levels from the start;
  (c) in step 4, because V1 refuses every shipped institution until its laws carry levels, which is a
  one-time break.
- **O2 — how R1/R2/R3 meet the built residency.** (a) Extend the built row with `institution`, `office`,
  `from`, `until | removed`, and add a `remove` op reserved to the sealing office; (b) keep the reside row as
  PRESENCE (where a player sits and listens) and add a separate sealed OFFICE-HOLDING record that R1
  resolves through; (c) resolve office through the existing chair assignment (`ChairAssignmentSchema`) and
  leave the reside row as it is; (d) reserve `drain` to the sealing office (today it is unreserved), with
  any of (a)–(c). Independently of which: **do `hands` and `may_dispatch` stay on the residency** (as a
  narrowing the chair still bounds) **or leave it for the seat** (R2 read strictly)?
- **O3 — what a pin's content hash covers.** The engine already hashes laws one by one: each institutional
  law carries its own `content_hash` (`src/genome_schema.ts:548`), and `canonJson` drops `content_hash`
  from what it hashes (`EXCLUDED_FIELDS`, `src/canonical_form.ts:5`). (a) A hash over the engine's
  canonical JSON of the whole document minus its pin block (so per-law hashes are excluded, as today);
  (b) the governing store's own hash of its record, carried verbatim, re-derived by a canonicalization the
  port contract publishes; (c) both, and K1 names all three on a mismatch.
- **O5 — how an institution names its sponsoring organization (V2).** (a) The existing org↔institution
  link (`OrgInstitutionSchema` `{org_slug, institution_slug}`), with exactly one link marked as sponsor;
  (b) a new `sponsor_org` field on the institution section; (c) only the governing store's record names it,
  and the engine reads it from the pinned copy.
- **O6 — the one type per seam (S4).** (a) The wider type wins (`text` over `uuid`, `jsonb` over `text`,
  `bigint` over `integer`, `jsonb` over array); (b) the stricter type wins (`uuid`, `jsonb`, `uuid`,
  `bigint`, array). (The external store's declaration winning is not offered: S2 makes the engine depend
  on the contract, not on a store.)
- **O7 — a trace intent in a standalone engine (G8).** (a) Required — a standalone engine mints a local act
  and names it; (b) nullable — a standalone intent names no act and says so; (c) the operator's approval of
  the gig is the act — which covers only gigs that pass an approval gate, so it needs (a) or (b) beside it.
- **O8 — the trace on the file backing (G11).** Under S1 (every object on ALL THREE backings, the file
  backing included) this reduces to one answer: (a) the file backing's write path appends the trace in the
  same write as the plan or output row — still the store's write, never a caller's. The alternatives — (b)
  the file backing refuses step-2 gigs, (c) the trace exists only on stores with triggers — are open only if
  S1 is amended to exempt the file backing.
- **O9 — the reduction judge's corpus (D1).** (a) A held-out set sealed before step 4 begins; (b) that
  held-out set PLUS the ledger's replay corpus, with the held-out set never read while candidates are
  drawn. (Replay alone is not offered: D1 already requires held-out work.)
- **O10 — CONFIRM: the fixed point is the organization's governor.** Following from K4 and V2 (R4 above),
  the one self-sealed residency is the ORGANIZATION's governor office. Not recorded as a decision; the
  operator is asked to confirm or correct it.
- **O11 — what a standalone engine verifies against (K4).** K1 keeps locally authored institution files;
  K4 has residencies and namings sealed in a governing store. (a) A standalone deployment runs a local
  governing store behind the port (S2), so every engine has one; (b) a standalone engine seats no players
  under residency — K4's verification is required only when a governing store is configured, and its
  absence is a named refusal, not a pass; (c) a locally authored institution's governor office seals inside
  the engine, as revision 5 had it — which K4 rejected as "either, by mode", so it is listed only to say why
  it is not available.

A decision is not a law: each is owed one at its build step, and this document stops being a spec the day
the last of them is green.
