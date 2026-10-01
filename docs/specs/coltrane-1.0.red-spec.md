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
Six assertions are executable against the engine as it stands and RED today on ABSENCE of the
mechanism; the rest are `it.todo` because the seam they pin has no API yet to assert against. A todo
is a law without a seam, not a law deferred. **This PR is RED by design.** The gate is the
spec-review verdict, not the test run. `scripts/laws.sh` counts are bumped so the only red is the
laws themselves.

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
- **R6** — hydration slots bound "at seat time" (CLAUDE.md, `p.chair.supplies`, `src/runtime.ts:
  3669`) bind at PLAN time from the office's supplies through the seat. The institution still
  supplies the data; the seat is where it arrives. Slots with `binding: "gig"` (`src/genome_schema.ts:
  66, :75`; skipped at compose, `src/composition.ts:411`) are filled by the PLANNER onto the seat from
  the work set — the same act that resolves the seat's inputs (G1). The dispatcher fills nothing.

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

0. **Residency** (R1, R3, R5, T1). Mostly already in `institutions/`; make it sealed and load-bearing.
   INDEPENDENT of step 1 — the third review showed memory belongs to the player and survives a residency
   ending (M1/R3), so nothing in memory is owned "against" a residency. Steps 0 and 1 ship in parallel.
1. **Memory + reflection** (M1–M5, G5, A3–A4). New store with its own ledger, new final phase. Additive.
   TRANSITIONAL: until P2 (step 4) `memory_ref` keys on the nick, contradicting P2 in the interim — said
   here rather than discovered.
2. **Plan + seat** (G1–G7, A2, R2, R4, R6). New first movement, new sealed types, plan in run identity, the
   planner's office and its grant, gig-bound slots onto the seat. HARD dependency on 0 (R1: no residency,
   no seat); bypasses 1. R2/R4/R6 moved here from step 0 — they have no subject until there is a plan.
3. **Lineage mandatory** (P3, P5, L1–L4, A1). Depends on 2 (checked at plan) AND on 0 (a seal needs the
   governor's residency to be sealed by).
4. **Strip and shrink** (C1–C4, P1, P2, P4, S1, H1–H2). The one-time break. 71 players become however many
   have earned a name.
5. There is no step 5.

## Open at the time of writing

Nothing. Formerly open, now decided: bootstrap (R4), notes-content (R3), consolidation cadence (M3), plan amendment (G6),
`tensions[]` (L1), who plans a queued gig (G7), what a booking names (T1), where evals go (C4); and from
the third review: the reflection seat's capability (M2/G6), the planner's own grant (R2), a rung's note (A3),
the governor's seal (P3), checks vs judgements (C4), tension with the user (L1), an unheld office (T1).

Every question raised across four revisions is now decided above, each with the alternative it
rejected. A decision is not a law: each is owed one at its build step, and this document stops being a
spec the day the last of them is green.
