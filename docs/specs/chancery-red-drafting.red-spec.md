# RED spec — the Coltrane standard `chancery-red-drafting-v0` (DS-1 … DS-5)

**A red pass may change only what its scope names, only a graded spec may start one, and the seat that
gates the scope is not a model.**

`chancery-red-drafting-v0` drafts RED laws in `eir-dev/chancery-os` for a spec already graded PASS. Three
phases, in order: `draft` (agent `chancery-red-drafter`, CREATE, seals a `red-spec`), `scope` (skill-backed
by `scope-gate`, no agent, VERIFY, seals a `scope-verdict`), `review` (agent `chancery-red-reviewer`,
VERIFY, seals a `change-verdict`). `max_examine_rounds` is 3. It publishes nothing: it leaves a branch.

- **Source:** Eugene's ruling, 27 Oct 2026; spec wiki
  `eir:spec.chancery.the-testable-charter.drafting-standard` revision 2 (content_sha
  `e23773dbe682b1a291dcec5f9876bae512aabf745968d7ec9dfde5faac636524`), graded PASS by Vör
  (`eir:spec.chancery.the-testable-charter.drafting-standard.grade-vor`). Vör's two conditions (27 Oct 2026,
  relayed by the coordinator) are binding and are laws here: DS-5 reads "every pre-existing law NOT NAMED
  IN THE SCOPE keeps its verdict and plant outcome"; DS-4 reads the LATEST `spec_grade` for the spec.
- **Scope in:** the genome definitions of the standard, the two agents, the skill `scope-gate` and the type
  `scope-verdict`; engine enforcement in `src/**` needed for DS-2…DS-5.
- **Scope out:** building `spec_grade` / `make:spec_grade` (Forseti, chancery-os; DS-6 is not this repo's);
  dispatching the testable charter's red pass; anything in `eir-dev/chancery-os`.
- **Laws:** `tests/chancery_red_drafting.test.ts` (33 laws: 30 red today, 3 DS-4 controls green today — see
  "Observed RED"). No existing law is modified or removed;
  `scripts/laws.sh` is untouched (the operator adjusts pinned counts at commit).

## What is red today, and how the laws reach it

Nothing the contract names exists: `standards/chancery-red-drafting-v0.json`, the agents
`chancery-red-drafter` / `chancery-red-reviewer`, `skills/scope-gate/`, the type `scope-verdict`, any
reader of a `spec_grade` on the run path, any baseline-vs-branch comparison. Every law imports only
production symbols that exist today (`loadGenome`, `composeStandard`, `defineAgent`, `seatEffectiveTools`,
`executeSkillAsync`, `loadSkillPackage`, `runGig`, `createRegistry`, `createOutputStore`) and reaches the
missing thing **at runtime** — through the repo-root genome, the compose path, the skill execution path,
`runGig`, or a property read off `src/index.ts` — so each fails on an assertion that states the reason,
never on an import or type error (`npx tsc --noEmit -p .` is clean with the file in place).

## Verification method

Example-based throughout. Each invariant is a specific behaviour with a named plant and a named refusal,
not a universal property over a generable space, so a property engine would add a dependency and no teeth;
none was added. Each refusal law is paired with a **control that must be admitted**, so a gate that refuses
everything cannot pass. DS-1 and DS-5 build a throwaway git repo in a temp dir (no chancery-os checkout is
read or needed). The planted compositions for DS-2/DS-3 are built from the **loaded** standard with the
smallest edit (swap one chair's seat, or one agent's grant) and recomposed through `composeStandard`; the
planted seat is built to be otherwise valid (it declares the inputs and skills the chair needs, the chair's
ceiling is removed) so only the named defect can refuse it. Because that validity is reasoned, not yet
observed, every compose-refusal law ALSO requires the message to state a reason token that the unrelated
compose rules (missing input, undeclared skill, dead ceiling — which also name the chair and the agent) do
not contain: DS-2 `model|deterministic|determinism|gate`; DS-3 P1 `same|different|distinct|separate|
independent|itself|self-review|cannot review|may not review|own work` plus the drafter's slug; DS-3 P2*
`write|write-capable|read-only|grant` plus the tool name. Naming the chair alone does not pass.
DS-4 is the exception to "the standard must exist": it runs the held standard when the genome holds it, and
otherwise a stand-in of the same slug with one agent-backed `draft` chair (carrying none of the guarded
behaviour), so it reaches `runGig` today and fails on the absent admission rather than on the absent
standard. DS-2/DS-3, whose subject is the standard, never use the stand-in.

## Seams this red-spec fixes (decisions the contract left open — an implementer meets these, not re-derives them)

1. **`scope-gate` input/output (DS-1).** The skill is run through `executeSkillAsync(skills/scope-gate,
   input, …, { cwd: <repo> })` — the exact call a skill-backed chair makes with `RunDeps.tree_root` as `cwd`.
   Input: `{ scope: { files: string[], laws: string[], terms: string[] }, baseline_commit: string }`. The
   staged diff is the index against `HEAD` (`git diff --cached`) in that `cwd`. Output: a `scope-verdict`
   object with a boolean `pass`, whose refusal **names** the offending file or id (the law asserts the
   serialized verdict contains it). The output must also validate as the genome's `scope-verdict` type
   (extends `Verdict`: `id`, `target_ref`, `pass`, `checks[≥1]`). The skill needs tier ≥ 2 to run `git`.
2. **`crossing/*.sx` grammar (DS-1) — UNVERIFIED ASSUMPTION.** No chancery-os checkout was readable, so the
   fixtures assume one `(law "<id>" …)` / `(term "<id>" …)` form per id, the id a quoted string right after
   the head. If chancery-os's real grammar differs, the fixture moves, not the contract. Note the plants edit
   a law's **body** without touching its `(law "id"` line (P1) — a gate that greps hunk lines for ids is red.
3. **Where `spec_grade` records reach the run path (DS-4).** The change-request names its record
   (`spec_grade: <id>`), and carries `spec`, `content_hash` and `scope.laws`. Chancery supplies, as
   `RunDeps.spec_grades`, `{ conformance_seat: <principal>, grades: [{ id, record: {spec, content_hash,
   verdict, scope, by} }] }` — the spec's grades in record order, **oldest first**, each alongside the id it is
   held under. The specified record shape gains no field (it has no id and no timestamp; "later" is list
   order, as the contract says). The gate sits in `runGig` before the first chair is taken.
   **Finding while observing:** the genome's existing `change-request` type is CLOSED
   (`additionalProperties: false`, `domain_types/change-request.json`), so `runGig`'s payload check refuses
   `spec`, `content_hash`, `spec_grade`, `scope`, `baseline_commit` and `branch` at the door
   (`gig input "change-request" does not satisfy its type`) before any gate could read them. The standard's
   gig input must therefore be a type that can carry them — `change-request` extended (`type_extend`), or
   another input type the standard declares. The law "DS-4 input" asserts the declared input type validates
   the payload; without it the real-genome DS-4 laws would fail at the door and mask the missing reader.
4. **The baseline comparison (DS-5).** `compareBaselineLoop({ baseline, branch, scope })` exported from
   `src/index.ts`; `LoopResult = { laws: [{ id, verdict: "pass"|"fail", plants: [{ id, outcome: "red"|"green" }] }] }`
   (a plant is `green` when the law **passes its own plant**); `scope = { laws, terms }`. Returns (or resolves
   to) `{ pass: boolean, … }`; a refusal names the law and, for a plant, the plant.
5. **Declarations the enforcement reads (DS-2/DS-3).** The laws mutate the *loaded* standard minimally and
   so work with whatever declaration the genome door lands (a chair field that already passes the schema —
   e.g. `supplies` — or a schema change in `src/**`). Genome records are limited to what
   `src/genome_schema.ts` accepts; unknown keys on a standard or chair are stripped.

## Invariants → laws

| id | statement | mechanism and callsite | laws (titles in `tests/chancery_red_drafting.test.ts`) |
|----|-----------|------------------------|--------------------------------------------------------|
| **DS-1** | A red pass whose diff writes a file outside the scope list, or adds, amends or renames a law/term id the scope does not name, is refused, naming the file or id. | The `scope-gate` skill (`skills/scope-gate/`, determinism 1.0): (a) diff file set ⊆ `scope.files`; (b) the diff of `crossing/laws.sx`/`terms.sx` may add/amend only `scope.laws`/`scope.terms`; a rename = remove old id AND add new id, both must be scoped. Run through `executeSkillAsync` (`src/skill_subprocess.ts`) with `cwd` = the tree. | control (in-scope passes, seals as `scope-verdict`); **P1** unscoped law's body edited → names `institution:charter:sealed-and-amended-under-its-sponsors-governor`; **P2** writes `loop/loop.sh` → names the file; **P3** named law renamed to an unscoped id → names the new id; **P3b** unnamed law renamed to a named id → names the old id; **P4** unscoped law added; **P5** unscoped term amended (`record-refs-resolve`). |
| **DS-2** | The `scope` chair is skill-backed (skill declares `determinism_ratio` 1.0) and holds no model seat; a phase graph that seats a model at `scope` fails to compose. | `composeStandard` (`src/composition.ts`, the chair-validation loop: today a chair with `agent_slug` set is an agent chair whatever its `skill_slug`; `isSkillChair` is computed there) must refuse a model seat at the gate chair, naming it. The standard's shape (O1) and the skill's ratio are asserted on the loaded genome. | control (standard as held: phases `draft`,`scope`,`review`; chairs/agents/primitives/outputs; 3 rounds; composes; skill ratio 1.0); package (skill is code-first, ratio 1.0, fixtures); **P1** agent in place of skill; **P2** agent alongside skill. |
| **DS-3** | `review` is held by a different seat from the drafter and holds no write grant. | `composeStandard` must refuse the drafter at `review` and a review seat whose effective grant (`seatEffectiveTools`, `src/chart.ts` — agent ∩ chair ceiling) includes a write tool, naming the chair (and the offending seat/grant). O3's write grant is read as: `Write`/`Edit`/`MultiEdit`/`NotebookEdit`, an **unscoped** `Bash` (a scoped `Bash(cmd:*)` is not write-capable), or `code_tool_access` `write`/`full`. | control (different agent; effective grant has no write tool; composes); **P1** drafter at `review`; **P2** `Write`; **P2b** `Edit`/`MultiEdit`/`NotebookEdit`; **P2c** unscoped `Bash`; **P2d** `code_tool_access: write`. |
| **DS-4** | The gig runs only when the input names a `spec_grade` that is PASS, at the input's content hash, by the conformance seat, whose scope covers every input law id, AND is the LATEST for the spec. | A reader of `RunDeps.spec_grades` at the head of `runGig` (`src/runtime.ts`, before the preflight and before any `prepareChair`), refusing with a typed error before any model seat is invoked. | **input** (the declared gig input type can carry the gate's fields); controls (admitting PASS lets `draft` run; a later grade of ANOTHER spec does not refuse; grade scope `null` admits); **P1** HOLD; **P2** wrong principal; **P3** wrong hash; **P4** scope omits a named law; **P5** older PASS with a later grade at a newer hash → names the later grade; **P6** no grade named; **P7** named id not supplied. |
| **DS-5** | Every pre-existing law not named in the scope keeps, on the branch, its verdict and the outcome of each of its plants. | `compareBaselineLoop` (new, exported from `src/index.ts`): for each baseline law whose id is not in `scope.laws`, the branch result must hold the same verdict and the same outcome for each plant; a named law is excepted; a law new on the branch is unconstrained. | controls (identical results; scoped law's verdict + plant outcome change plus a new red law → not refused); **P1** amended term `record-refs-resolve` makes unscoped `…references-resolve` pass its plant `dangling-ref` → names law and plant; **P2** unscoped law's verdict flips; **P3** unscoped law absent from the branch. |

Obligations O1–O5 map onto these: O1 (the standard's shape) → DS-2 control; O2 (the gate) → DS-1 and the DS-2
package law; O3 (review holds no write) → DS-3; O4 (only a graded spec) → DS-4; O5 (the baseline holds) →
DS-5. O3's *drafter* half ("writes only within the input's scope list, reads the repo") is **not** an
invariant in the contract and has no law here — it is a grant on the agent record, enforced by DS-1 at the
diff rather than at compose; recorded so the omission is visible.

## Law plants — the smallest production edit that turns each red

The enforcement does not exist yet, so each plant is the **removal** of the thing that must exist:

| laws | plant (production edit → red) |
|------|-------------------------------|
| DS-1 | `skills/scope-gate/skill.mjs`: skip the id check of `crossing/laws.sx`/`terms.sx` (accept any id), or drop the file-set subset check — the matching P law goes green→red |
| DS-2 | `src/composition.ts`: delete the compose-time refusal of an agent (or an agent beside a skill) at the gate chair |
| DS-3 | `src/composition.ts`: delete the compose-time refusal of the drafter at `review` / of a write-capable effective grant at `review` |
| DS-4 | `src/runtime.ts`: delete the `spec_grades` admission at the head of `runGig` (or admit on verdict alone, or on the named record without the latest-grade check for P5) |
| DS-5 | `src/…`: make `compareBaselineLoop` ignore plant outcomes (P1), ignore verdict changes (P2), or skip absent laws (P3) |

## Observed RED (this run)

`npx vitest run tests/chancery_red_drafting.test.ts` — **33 tests, 30 failed, 3 passed** (the three DS-4
controls, green today because the stand-in seats `draft` — which also shows the harness is live: a run that
should seat the draft chair does). Each failure is an assertion naming the reason:

- **DS-1 (7):** all fail at `skills/scope-gate/ does not exist — the scope gate is not built`, *after* the
  throwaway repo is built and the planted diff staged (so the fixtures and the staging are exercised).
- **DS-2 (4), DS-3 (6):** fail at `standards/chancery-red-drafting-v0.json is not in the genome …` (and the
  package law at `skills/scope-gate/ does not exist`). The planted-composition laws take the standard before
  the compose, so their failure never reads as "composeStandard accepted it".
- **DS-4 (11 laws):** P1–P7 run `runGig` on the stand-in and fail on the contract's reason — `a model seat
  was INVOKED (draft) before the grade was refused: expected [ 'draft' ] to deeply equal []` — i.e. nothing
  reads the grade. The "input" law fails with `the input type "change-request" cannot carry the gate's
  fields: additionalProperties: must NOT have additional properties 'spec'; … 'spec_grade'; 'scope' …`
  (the closed type, see Seams §3). The three controls pass.
- **DS-5 (5):** the fixtures run first — the real git repo, two commits, the toy loop, and the fixture
  assertions (baseline all-pass/all-red; the amended term really makes the unscoped plant green) — then each
  fails at `src/index.ts exports no 'compareBaselineLoop' — there is no baseline-vs-branch comparison`. A
  first run failed these five on a fixture bug of this spec's own (`matchAll` on a non-global regex); that was
  fixed and re-observed before sealing.

## Caveats — what was NOT observed, stated rather than hidden

- **No plant could be applied to production code**, because every seam is absent: a plant here is the
  removal of enforcement that does not exist. The redness observed is the *absence* red, not a
  mutation-of-existing-code red. Once the genome lands, DS-2/DS-3 fail at their *behavioural* assertions
  (composed-when-refused), which today are unreachable behind the missing-standard assertion. That the
  planted compositions are otherwise valid (so only the named defect refuses them) was established by
  reading `composeStandard`, **not by running them**; the reason-token requirement above is the guard
  against an unrelated compose error satisfying a law, but the first operator run after the genome lands
  should confirm it and report any law that refuses for an unrelated compose rule. (DS-4's recording
  invoker, by contrast, *was* observed seating `draft` in the three controls.)
- **The DS-1 `.sx` fixtures remain UNVERIFIED against the real `crossing/laws.sx`/`terms.sx`** (not readable
  from this worktree; the shell refused listing outside it). This cannot be closed from here: the operator
  should check the fixture grammar against a chancery-os file before building the skill.
- **Failure-mode ids → laws** (the coverage_map is keyed by invariant): F-DS1-P1 → DS-1 P1; F-DS1-P2 → DS-1
  P2; F-DS1-P3 → DS-1 P3; F-DS2 → DS-2 P1; F-DS3-P1 → DS-3 P1; F-DS3-P2 → DS-3 P2; F-DS4-P1…P5 → DS-4 P1…P5;
  F-DS5 → DS-5 P1.
- **The `.sx` grammar, the `scope-gate` input shape, `RunDeps.spec_grades`, and `compareBaselineLoop`'s
  signature are this spec's choices** (see Seams); none is in the contract text. They are the likeliest
  place for an honest implementer to disagree; change the law and this doc together, not one alone.
- `by` / the conformance principal are opaque strings here; the real principal-ref format is chancery's.
