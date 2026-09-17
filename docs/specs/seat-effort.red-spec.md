# seat-effort.red-spec — effort is declared, resolved, always spawned, and recorded

`contract-seat-effort-v1`. Effort is part of the genome and the dispatch, resolved deterministically,
always passed to the spawn, and recorded — never inherited from the operator's `~/.claude/settings.json`.

**Measured defect** (operator, 2026-09-17): seat `ff0a0ebf` ran `"effort":"xhigh"` on all 156 transcript
events because the Claude invoker spawns `--setting-sources user` and never passes `--effort`, so every
seat inherits the operator's `effortLevel`. The `claude` CLI (2.1.274) accepts `--effort
low|medium|high|xhigh|max`; the engine never sends it.

Laws: `tests/spec_seat_effort_is_declared.test.ts`. RED by design — the enforcement they demand does not
exist yet; each fails on an assertion stating the contract's reason (verified this run), never on a
collection/import error.

## The one architectural choice

Precedence resolves **once, in the runtime**, and the RESOLVED value is set on
`AgentInvocationContext.effort` — O2's "reaches the invoker on the invocation context", mirroring how
`depth` threads (`src/runtime.ts:2851`, `RunDeps.depth` at `:352`). Both invokers CARRY it. The Claude
invoker additionally FLOORS to `medium` at the spawn, so a hand-built ctx still yields an explicit
`--effort` — that floor is what makes O3 hold structurally. `EFFORT = {low, medium, high, xhigh, max}`;
tier defaults `economy→low`, `standard→medium`, `premium→high`; untiered → `medium`.

## Obligations → mechanism (callsite) → red law

- **O1** — optional `effort` enum on `AgentSchema` (`EffortSchema` beside `DepthSchema`,
  `src/genome_schema.ts:15`; `AgentObjectSchema` `:92`); advertised on `gig_dispatch`
  (`src/mcp.ts:156`); forwarded by `coltrane dispatch --effort` (`src/cli.ts:477`).
  Laws: `O1/F1 — AgentSchema keeps a valid effort…`, `O1 — gig_dispatch advertises effort…`,
  `O1 — coltrane dispatch … --effort high reaches the invocation as ctx.effort`.
- **O2** — `resolveEffort(deps.effort, agent)` at the ctx site (`src/runtime.ts:2847`) sets `ctx.effort`;
  `RunDeps.effort` sibling of `depth` (`:352`); the dispatch handler threads it into runGig beside
  `depth` (`src/server.ts:968`). Law: `I1/O2 — effort resolves dispatch ▷ agent ▷ tier ▷ medium…`.
- **O3** — `buildInvokerArgs` gains `effort` and pushes exactly one `--effort` (`src/claude_invoker.ts:1024`);
  the invoke door passes `ctx.effort ?? "medium"` (`:1377`). Laws: `O3 — an undeclared, untiered seat
  STILL spawns…`, `O3 (door) — a premium seat dispatched through gig_dispatch…`.
- **O4** — add `effort` to `TurnLoopOptions` (`src/turn_loop.ts:131`) and pass `ctx.effort` into the
  `runTurn(seed, {…})` call (`src/completions_invoker.ts:204`). Law: `O4 — hands runTurn the effort…`.
- **O5** — add `effort` to the `chair_complete` emit (`src/runtime.ts:3291`). Law: `O5 — the resolved
  effort appears on the chair_complete progress event`.

## Invariants

- **I1** — precedence holds for every combination (premium⇒high; premium+xhigh⇒xhigh; +dispatch low⇒low;
  untiered⇒medium). The decision-table law drives `runGig` and reads the resolved `ctx.effort` per case.
- **I2** — exactly one `--effort` pair whatever depth/turn budget applies. Laws: `buildInvokerArgs`
  yields one pair alongside `--max-turns`; the run-seam with `skim` depth + a turn budget still yields one.

## Failure modes

- **F1** — an agent file with an out-of-range effort fails the load, naming agent + field (the loader
  validates every agent through `defineAgent`→`AgentSchema.parse`, `src/loader.ts:360`/`src/composition.ts:204`,
  and rethrows hard at `src/loader.ts:368`). Law: seed a temp genome and assert the load surfaces it.
- **F2** — `gig_dispatch`/CLI receiving an out-of-range effort is refused before anything runs (a
  `readEffort` guard mirroring `readDepth`, `src/server.ts:313`). Law: dispatch `effort:"turbo"` returns
  `{ok:false, error:/effort/}` and invokes no chair.

`O3 (door)` reaches the spawn through a real door: `dispatchTool("gig_dispatch", …) → runGig →
makeClaudeInvoker` (the real run seam), reading `--effort` off the captured spawn args.

Observed red: `npx vitest run tests/spec_seat_effort_is_declared.test.ts` — 12 tests, 12 failed, each on
its contract assertion. The six named controls stay green and unmodified (60 tests, verified this run).

## Out of scope

`src/**`, `scripts/laws.sh`, `agents/**` / `domain_types/**`, the provider wire mapping of effort beyond
carrying it to the port, `alwaysThinkingEnabled` and the stale `MODEL_TIER_MAP` names, committing/pushing.
