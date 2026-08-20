# SPEC — one chain, two doors

**Status:** proposed
**Gates:** `tests/spec_one_chain_*.test.ts` (to be written RED-first)

## The claim

A gig arrives one of several ways. What happens to it afterwards is one thing, not several.

Today it is several. `runGig` has **four call sites**, each hand-assembling its deps:

| site | door |
|---|---|
| `src/server.ts:1113` | `gig_dispatch`, the synchronous `wait:true` path |
| `src/server.ts:1198` | `gig_dispatch`, the default asynchronous path |
| `src/worker.ts:1096` | `workOnce`, the drain / `coltrane work` |
| `src/chart.ts:1006` | a movement inside an arrangement |

These are not four kinds of run. They are four copies of one body, differing at the top of the
funnel — how the gig ARRIVED — and then diverging in ways nobody chose.

## The evidence that this is not theoretical

**1. The repository is read from two different fields.** Both doors resolve "which repository does
this gig work on", from different places:

| door | source |
|---|---|
| `gig_dispatch` | `args["repo_url"]` — a top-level dispatch argument (`server.ts:771`) |
| `workOnce` | `resolveWorkingRepo(claim)` — `claim.input.repository`, the TYPED INPUT, falling back to the org column (`worker.ts:144`) |

A change-request carrying a typed `repository` — the field `domain_types/change-request.json`
defines, the field the standard's own input contract names — is honoured by the drain and IGNORED by
a direct dispatch. A `repo_url` argument is honoured by dispatch and unknown to the drain. One fact,
two names, one per door. `resolveWorkingRepo` is not exported from a shared module; it lives in
`worker.ts` and only `workOnce` calls it.

**2. The duplication tax is already recorded in the source.** The two `gig_dispatch` branches carry
these comments, written by whoever had to apply the same fix twice:

> `server.ts:1202` — *"Same venue trio as the sync path above — the DEFAULT dispatch mode must honour
> a named room too, or the fix covers only the deterministic wait:true test path and leaves the path
> the product actually dispatches through discarding the venue."*

> `server.ts:1208` — *"Same repository wire as the sync path above — the default async dispatch must
> populate a named room's tree too, not only the deterministic wait:true path."*

Both describe a fix that landed on one branch and had to be carried to the other by hand. Both
describe the failure that occurs when it is not: the tested path works and the shipped path does not.

**3. The one thing they DID unify stayed unified.** `cli.ts:308` constructs the venue realizer with:

> *"The SAME realizer the interactive path constructs at `src/server.ts:3486` — one bootstrap, so the
> drain and the server cannot drift on which substrate a venue-named room is stood up on."*

That is this spec's thesis, already applied once, to one dep, deliberately.

**And its citation has already rotted.** The realizer is constructed at `server.ts:3701`, not 3486;
line 3486 is now unrelated code about refused upserts. The comment drifted 215 lines while remaining
perfectly convincing to read. This is the strongest argument in this document, and it argues against
the method rather than the intent: the one dep anyone unified was held together by PROSE, and the
prose is now wrong. `CLAUDE.md` says it plainly — *"status and inventory claims rot silently, so
delete them or make them checkable"* — and *"a rule that cannot fail is remembered, not enforced."*

A shared assembler cannot rot, because there is nothing to keep in sync: the second door does not
receive a copy of the wire, it receives the wire.

## The invariant

> **The body of the funnel is one function. A door decides only how the gig arrives.**

Concretely: the steps between "a gig is admitted" and "its result is recorded" — resolve the working
repository, resolve the venue and realize the room, assemble tool providers and MCP configs, resolve
skills / skill_dirs / evals, apply the budget, run, seal — are declared ONCE and consumed by every
door. A door supplies only what is genuinely door-specific: the standard, the input, the gig id, the
abort signal, and how progress is reported.

This mirrors the policy the queue already follows: *"One policy, three call sites, so the door in, the
door out and the result path cannot disagree about which backing owns a gig."* (`CLAUDE.md`, on
`selectQueueBacking`.) That reasoning does not stop at the queue.

## Laws

Numbered so `tests/spec_one_chain_*.test.ts` can implement them RED-first. A failure in a `spec_*`
file is a feature not yet built.

**C1 — one assembler.** There is exactly one exported function that builds a gig's run-deps. Every
`runGig` call site obtains its deps from it. A new call site that hand-rolls deps is a law failure,
not a style preference.

**C2 — the repository has one resolver.** `resolveWorkingRepo` moves to a shared module and is the
only thing that answers "which repository". Both doors call it. The typed input
(`input.repository`) is authoritative; an explicit dispatch argument (`repo_url`) and the org column
are fallbacks, in that order, and the order is asserted.

**C3 — a typed `repository` is honoured by EVERY door.** The same change-request dispatched directly
and enqueued-then-drained resolves to the SAME repository. This is the law that would have caught
the defect this spec was written for.

**C4 — the two `gig_dispatch` branches cannot diverge.** `wait:true` and the default async path build
their deps from the same assembler, so a wire added to one is present in the other by construction
rather than by a comment asking the next person to remember.

**C5 — a door adds nothing silently.** Every dep a door contributes beyond the shared set is named in
one place and is door-specific by argument, not by accident. Adding a dep to one door and not the
others is visible at the type level.

**C6 — non-vacuity: behaviour is unchanged.** Every existing dispatch, drain, chart-movement and
venue law passes untouched. This is a unification, not a redesign: if a law changes, the change is
the defect being fixed (C2/C3) and is stated as such.

## Non-goals

- NOT changing what any door accepts. `repo_url` on `gig_dispatch` keeps working; it becomes a
  fallback beneath the typed input rather than the only source.
- NOT unifying the DOORS themselves. Enqueue-then-drain and dispatch-now are genuinely different
  admission paths with different authorization; only the body they share is unified.
- NOT touching venue realization, credential minting, or the drain's env contract beyond routing
  them through the shared assembler unchanged.
- NOT introducing a dependency.

## Why this is worth a spec rather than a patch

The defect is not any one of these wires. It is that the funnel has four bodies, so every future wire
is a coin flip about which doors receive it — and the failure mode is silent: the door you tested
works, and the door the product uses does not. Fixing the repository wire alone would leave the
generator of these defects in place, and the next one would arrive the same way.

## Gates — the RED laws, and the mechanism each demands

The laws above are sealed as RED tests in `tests/spec_one_chain_two_doors.test.ts`, observed failing
against unmodified `main` for the stated defect (not for a missing import — see the file header on how
each stays behavioural). Each obligation names the mechanism `create-change` must build and the
callsite it lands at. The RED tests do not import the not-yet-existent assembler or resolver statically;
they text-parse source and dynamic-import through a string specifier, so one pending symbol never blocks
the whole band.

| law | obligation → mechanism (callsite) | RED gate |
|---|---|---|
| **C1** | One exported `assembleRunDeps()` in `src/run_deps.ts` builds a gig's run-deps; every `runGig` call site obtains its deps from it (`server.ts:1113`/`:1198`, `worker.ts:1096`; `chart.ts:1006` inherits via `{ ...deps }`). | `C1.a/b/c` (assembler exists + server + worker use it); `C1.d` (chart resolves no repo of its own — a green-on-`main` pass-through guard). |
| **C2** | `resolveWorkingRepo` moves to `src/run_deps.ts` with THREE tiers — typed `input.repository` ▸ explicit `repo_url` argument ▸ org column — asserted in order. Signature `resolveWorkingRepo(claim, explicitRepoUrl?)`; keep **arity 1** (a default initializer on `explicitRepoUrl`) so `tests/the_repo_is_typed_input` R0 (`resolveWorkingRepo.length === 1`) stays green. `worker.ts` re-exports it, so that same suite's `import { resolveWorkingRepo } from "../src/worker.js"` stays valid. | `C2` (dynamic-imports `run_deps.js`; the tier-2 middle rung is the new one — `main`'s resolver has only typed→org). |
| **C3** | The dispatch door resolves the repository through the shared resolver, so `input.repository` is honoured (replacing the bare `args["repo_url"]` read at `server.ts:771`). | `C3` (real `dispatchTool` handler + real `resolveWorkingRepo` drain resolver; on `main` dispatch resolves `undefined`, drain resolves the typed repo). |
| **C4** | Both `gig_dispatch` branches build deps from `assembleRunDeps`; the `server.ts:1202`/`:1208` "Same venue trio"/"Same repository wire" hand-carry comments are deleted (the wire is inherited, not copied by reminder). | `C4.a` (comments gone); `C4.b` (server routes through the assembler). |
| **C5** | The wire that legitimately differs per door — `mcpServerConfigs` (empty on the drain per `run_deps.ts:19-25`; the bootstrap map on the server) — is set inside `assembleRunDeps` and supplied by explicit argument, never two hand-listed inline copies. | `C5` (comment-stripped `run_deps.ts` code names the assembler and sets `mcpServerConfigs`). |
| **C6** | Unification, not redesign: the only behaviour that changes is C2/C3 (a typed repository is honoured everywhere); `repo_url` on `gig_dispatch` keeps working as a fallback beneath the typed input. | `C6.a` (capstone — wait:true, async and drain resolve one repository); `C6.b` (repo_url fallback preserved — a green-on-`main` non-goal guard). C6's full "every existing law passes untouched" clause is verified by the whole root suite staying green at the seal gate. |

**Co-evolution owed at `create-change` (a contradiction surfaced, not resolved here).** `tests/run_deps_parity.test.ts` pins enforcement-key parity by TEXT-parsing the two inline `runGig` call-site literals in `server.ts`/`worker.ts`. C1/C4 collapse those literals into `assembleRunDeps`, which moves the enforcement keys off the call sites — so `run_deps_parity`'s parse breaks after the fix. Its own author sanctioned the migration in writing ("If the two call sites are ever replaced by ONE shared assembly … this test should be re-pointed at that assembly rather than deleted, because what it pins is the invariant, not the duplication"). This is aligned with the spec, not contradicting it — but the `draft-laws`/`create-change` separation means the implementer cannot edit `tests/`, so re-pointing `run_deps_parity` to parse the assembler must be authorised for whoever holds `tests/`. Left un-re-pointed, the root suite cannot be green after the fix and the stop-condition is unmeetable. This red-spec does **not** edit `run_deps_parity` (surfaced, per the no-weakening rule).
