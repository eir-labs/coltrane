# The change-set branch — a RED spec

The red→green transition becomes a property of a **branch**, keyed by the **originating gig**, and
the governor's approval (merging the RED spec into that branch) becomes the **trigger** for the
implementation. This document is the buildable spec: every obligation below names its mechanism, its
callsite, and the RED test that proves it. The tests fail today because the enforcement is absent;
the implementation pipeline running off this same branch turns them green.

Seam authored for compilation: `src/change_set_branch.ts` — explicitly-stubbed throwing signatures
(same discipline as `src/institution_enforcement.ts` on `spec/coltrane-enforces-its-laws`). Red comes
from failing assertions and thrown stubs, never a type error.

## Naming — decided explicitly, NOT inherited

The governor called it a "gig branch". It is **not** a gig branch: the spec ran as one gig and the
implementation is a **different** gig with its own id, so the branch spans several gigs and can only
be keyed by the **first** one. It is a **change-set branch**, identified by its originating gig.

- **Format:** `changeset/<originating-gig-uuid>[/<human-slug>]`
- The prefix `changeset/` marks the namespace.
- The **full** gig UUID is the **sole key** — untruncated, because truncation would forfeit the
  collision-freedom the branch exists to guarantee.
- An optional trailing **slug** rides alongside for humans and is **outside the key** (parsing
  ignores it). A UUID and a hyphen/underscore slug are both legal `git-check-ref-format(1)`
  components.
- Prior art: Gerrit **Change-Id** (a stable id above the commit, associating many patch sets with
  one logical change; its per-target-branch scoping is exactly why a 1:1 branch↔gig assumption
  breaks). Callsite: `deriveChangeSetBranch` / `parseOriginatingGig` (`src/change_set_branch.ts`);
  the originating gig id is reachable at the publish seat via `ctx.gig_id` (`src/claude_invoker.ts`).
- Tests: `tests/change_set/branch_identity.property.test.ts` (**I1, I2, I3, I19**).

## Item 1 — the publish seat creates and targets the branch

`spec-drafting-v1`'s `publish-red-spec` chair (agent **spec-publisher**) creates the change-set
branch **from main** and opens its RED spec pull request with `base` = **that branch**, never main.
Realized agent-side (method + `Bash(git …)`/`gh pr create` grants) plus the sealed `pull-request.base`
fact, where "targets the change-set branch" becomes assertable. Graphite stacked diffs are the
production evidence that a PR whose base is a branch (not main) is a normal, mergeable workflow.

- A **resumed** gig re-publishing is idempotent: **create-if-absent / reuse-if-present**
  (`ensureChangeSetBranch`) — it never forks a second branch and never clobbers the first.
- A publish that would seal a `pull-request` whose base does not exist on the remote is refused as a
  **dead name** at the pre-flight boundary (`assertBasePublishable`), the same altitude and defect
  class as the engine's missing-gig-input hard stop and dead-tool-grant refusal. Nothing is sealed.
- Callsites: `agents/spec-publisher.json` (method/grants), `domain_types/pull-request.json` (`base`).
- Tests: `tests/change_set/publish_and_preflight.test.ts` (**I4, I17**, resumed-create).

## Item 2 — the implementation targets the same branch and still cannot self-merge

`software-change-pr-v1`'s `publish-pr` chair (agent **pr-publisher**) branches **from** the change-set
branch and opens its GREEN pull request with `base` = the **same** change-set branch (**I5**). The
branch is **carried** in the change-request — an additive optional `change_set_branch` property on
`domain_types/change-request.json`, added through the single Zod source — and **never inferred** from
the working tree, because inference is how a run lands on the wrong branch silently
(`resolveImplementationBranch`; absent-but-expected is a hard stop, **I7**). The seat that built the
change **still cannot merge it**: no publish seat holds a merge grant, and the retarget to a non-main
base adds none (**I8**).

- Callsites: `agents/pr-publisher.json`, `standards/software-change-pr-v1.json`,
  `domain_types/change-request.json`.
- Tests: `tests/change_set/publish_and_preflight.test.ts` (**I5, I7**),
  `tests/change_set/self_merge_survives_retarget.test.ts` (**I8**).

## Item 3 — the trigger (a SEAM, not a deployment)

The webhook path crosses into infrastructure this repo does not own (queued behind a Supabase
integration not yet firing), so the spec pins the **seam**, not one implementation:

- **event:** a RED spec PR merged into the change-set branch
- **payload:** `{ change_set_branch, originating_gig_id, delivery_id }`
- **dispatched standard:** `software-change-pr-v1`, with `change_set_branch` carried into the
  change-request.

Firing twice must not run the implementation twice. GitHub delivers **at-least-once**
(`X-GitHub-Delivery` re-sends the same id on retry; different deliveries of one logical event carry
different ids), so **idempotency is a requirement**. The idempotency **key is the change-set branch**
(idempotent across different deliveries of the same logical event); the delivery id is a secondary
re-send guard. `coltrane work`'s atomic claim/lease (`coltrane_mcp_claim`) is the unique-constraint
analogue that already gives at-most-once **run**, so the trigger's only job is at-most-once
**enqueue** keyed on the branch. Callsite: `ChangeSetTrigger` (`src/change_set_branch.ts`), consumed
by `src/worker.ts`.

- Tests: `tests/change_set/trigger_idempotency.property.test.ts` (**I9, I18**).

## Item 4 — the institution document declares the red space

A change-set branch is **deliberately red** between the spec merge and the implementation merge.
`institutions/coltrane.json` gains a **fourth ADICO law**, `deontic = permitted`, whose evaluable
predicate legitimizes a deliberately-red state where `target_branch != main-line`. It **composes
with Law C by construction**: Law C fires only on `action = "merge-main"`, so a permission scoped to
`target_branch != main-line` narrows nothing Law C governs. It carries a real, recomputable
`content_hash`; Laws A/B/C and their hashes and the empty `lineage` array survive byte-for-byte. The
only permitted edit to `tests/coltrane_institution.test.ts` is `toHaveLength(3) -> toHaveLength(4)`.
This closes the undeclared-rule defect class PR #333 exists to police, and the law must pass that
admissibility bar.

- Callsites: `institutions/coltrane.json`, `src/genome_schema.ts` (`InstitutionalLawSchema`).
- Tests: `tests/change_set/institution_red_space.test.ts` (**I11, I12, I13**).

## Item 5 — retirement

A change-set branch is retired by the **human governor**, on **promotion-to-main** (the final
change-set→main PR is merged) or on abandonment. Retirement is **recorded**, never a silent delete —
the branch is retired **at most once** and every retirement emits a logged record. The lifecycle is a
state machine `{none, red, green, retired}`; a red merge (spec or implementation PR) is **never**
performed against the protected main line, so the fourth law composes with Law C across the whole
transition space.

- Callsite: `ChangeSetBranchMachine` (`src/change_set_branch.ts`).
- Tests: `tests/change_set/lifecycle.model.test.ts` (**I10, I14**).

## Acceptance — additive, and red from assertions only

Every schema touch is additive: every shipped agent, standard, chart, venue and institution file
loads and composes unchanged (**I15**), and the new `change_set_branch` property is optional (**I6**).
The seam compiles as real symbols so the whole spec's red comes from failing assertions and thrown
stubs, never a type error (**I16**). The final promotion PR targets main and is merged by the governor
under green CI, so Law C is satisfied with no exception: main never sees red and the change-set branch
was never the protected main line.

- Tests: `tests/change_set/genome_additive_and_compile.test.ts` (**I6, I15, I16**).
