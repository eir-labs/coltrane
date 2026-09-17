# RED spec — a chat-completions seat's context ceiling

`contract-seat-context-ceiling-v1`. Laws: `tests/spec_seat_context_ceiling.test.ts`.

## Why

Since commit `0685280` the shared turn loop stops with `context_limit` after the round whose
MEASURED context (input + cache_read + cache_write) crosses `TurnLoopOptions.max_context_tokens` —
but **nothing sets it**: no agent field, no dispatch argument, and the chat-completions invoker
(`src/completions_invoker.ts`) never passes one. So no turn-loop (DeepSeek) seat has a ceiling.
Measured the same week: a seat's cost is `turns × context`, and contexts climbed from 27k to 300k+
tokens. The enforcement seam already exists (`src/turn_loop.ts`, its GREEN controls
`tests/spec_turn_loop.test.ts` and `tests/spec_seat_metrics.test.ts`); what is missing is the WIRING
from a declared ceiling down to that seam. This spec is the RED laws for that wiring.

The criteria (from the contract): **a seat's context ceiling is declared like its effort — dispatch
over agent — and absent means NONE, never a guessed default.** It is scoped to the chat-completions
invoker; the Claude invoker (`claude -p`) has no per-round context ceiling and is out of scope.

## Method

Example-based, exercising the **real callsites**, mirroring the sibling `contract-seat-effort-v1`
(`tests/spec_seat_effort_is_declared.test.ts`) which threads a declared control through the same
schema → resolver → invoker path. The ceiling's EFFECT (a `context_limit` stop) is observable end to
end, so the invoker/door laws run the **real** `runTurn` over a fake chat-completions transport
(`fakeCompletions`, which the port converts `prompt_tokens → context tokens`) rather than mocking the
loop — a law watching the actual stop, not a stubbed constant. No property-based engine is warranted:
every invariant here is a specific behaviour (a field survives, a value resolves, a stop becomes a
typed refusal), not a universal property over a large input space.

## Obligations → mechanism, callsite, law

| # | Obligation | Mechanism / callsite | Law |
|---|---|---|---|
| **O1** | `AgentSchema` gains an optional **positive-integer** `max_context_tokens`; `gig_dispatch` accepts and advertises it; `coltrane dispatch --max-context-tokens <n>` sends it. | `src/genome_schema.ts` `AgentObjectSchema` (add `max_context_tokens: z.number().int().positive().optional()`, declared like `effort` so it round-trips); `src/mcp.ts` `gig_dispatch` `input_schema`; `src/cli.ts` `dispatch` case forwards `--max-context-tokens`; `src/server.ts` reads it. | `O1 — …authorable…` (schema keeps a valid ceiling, refuses non-positive/non-integer naming agent+field), `O1 — gig_dispatch advertises…`, `O1 — coltrane dispatch --max-context-tokens…` |
| **O2** | The ceiling resolves **dispatch ▷ agent ▷ none**; the resolved value reaches the invoker on the invocation context. | `src/runtime.ts` — a `resolveMaxContextTokens(deps.max_context_tokens, agent)` sibling of `resolveEffort`, set on `AgentInvocationContext.max_context_tokens` at the invoke ctx site (~3124); `RunDeps.max_context_tokens` threaded by the dispatch door (`src/server.ts`) beside `effort`. Absent ⇒ `undefined` (no floor, unlike effort). | `O2 — the ceiling resolves dispatch ▷ agent ▷ none…` |
| **O3** | The chat-completions invoker passes the resolved ceiling to `runTurn` as `max_context_tokens`. | `src/completions_invoker.ts` `makeCompletionsInvoker` — `...(ctx.max_context_tokens !== undefined ? { max_context_tokens: ctx.max_context_tokens } : {})` on the `runTurn` call (beside `effort`, ~205). | `O3 — the invoker passes the resolved ceiling…` (a ceiling stops the seat; no model call after the crossing) |
| **O4** | On a `context_limit` stop the chair fails with a **typed** `context_limit` refusal naming the context tokens reached and the ceiling; it never seals a partial answer as complete. | `src/completions_invoker.ts` — add `"context_limit"` to `CompletionsRefusal` / `COMPLETIONS_REFUSALS`; handle `result.stop === "context_limit"` before `extractJson`, `refuse("context_limit", …reached (result.totals.peak_context_tokens) … ceiling (ctx.max_context_tokens)…)`. The runtime already turns `{ok:false, refusal, message}` into a chair failure (`src/runtime.ts` ~3413). | `O4 — a context_limit stop becomes a typed refusal…`, and the door law below |

## Invariant

| # | Invariant | Law |
|---|---|---|
| **I1** | With no ceiling declared anywhere, `runTurn` receives no `max_context_tokens` and behaves exactly as today — the turn runs to `done` past any context size (absent is not a guessed default). | `I1 — with no ceiling declared… runs to done past any context` — one law by contrast: the same oversized transport (round-1 context 5000 tokens) runs to `done` and SEALS with no ceiling, and STOPS at `context_limit` with one. The done half is I1's contract reason; the stop half is why it is RED today. |

## Failure mode

| # | Condition | Refusal | Law |
|---|---|---|---|
| **F1** | An agent file or a dispatch declares a `max_context_tokens` that is not a positive integer. | The genome load reports a load error naming the agent and field, **or** the dispatch is refused before anything runs naming the field and value. | `F1 — …genome load reports a load error naming the agent and the field`, `F1 — gig_dispatch refuses… naming the field and the value, and invokes nothing` |

## Doors

`O2/O3/O4 (door)` drives the full path through **`runGig`** with the chat-completions invoker over a
fake completions endpoint: an agent that DECLARES a ceiling whose context crosses it fails the gig with
`context_limit` and seals no output. `O1 — coltrane dispatch…` and `F1 — gig_dispatch refuses…` drive
the CLI and MCP dispatch doors respectively.

## Controls (must stay green)

`tests/spec_turn_loop.test.ts`, `tests/spec_seat_metrics.test.ts`,
`tests/spec_completions_seat_every_door.test.ts`, `tests/spec_seat_effort_is_declared.test.ts` — the
loop's ceiling seam and the sibling declared-control paths this spec wires into.

## Out of scope

`src/**`, `scripts/laws.sh`, `agents/**`, `domain_types/**`, the Claude invoker, and committing or
pushing. These laws are RED by design: the enforcement they demand does not exist yet.
