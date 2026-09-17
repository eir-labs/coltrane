# The shared turn loop

**Status:** RED spec. Laws written in `tests/spec_turn_loop.test.ts`; not built yet.
**Change record:**

| field | value |
|---|---|
| `scope` | `src/turn_loop.ts` (provider-neutral loop plus accounting), `src/chat_completions_port.ts` (the wire), and `src/completions_invoker.ts` rebuilt on top of both |
| `vitest_test_path` | `tests/spec_turn_loop.test.ts` (31 laws), with its contract in `tests/spec_turn_loop_fixtures.ts` |
| `stop_condition` | all 31 laws green; `tests/spec_completions_invoker.test.ts` still green without edits to its laws; `npm test` green at the bumped pins; `tsc --noEmit` clean; the reachability and declared-field ratchets not raised |
| `non_goals` | see below |
| `run_protocol` | Laws land RED first. Laws 19–23 are red against today's invoker, each on the assertion that names its defect. Laws 1–18 are red because their modules don't exist yet (a throwing proxy, so each law fails on its own). That kind of red can't show the law could catch a bug, so once the code is green, break each defect back in by hand and watch its law go red. Build order: the loop, then the port, then the invoker rewire. |
| `outcome` | _open_ |

## Why one loop

Three callers want the same thing: a seat takes turns, a model thinks, tools run, and spend is counted.

| caller | seam | today |
|---|---|---|
| gig chairs | `AgentInvoker` (`src/runtime.ts:227`) | `claude -p`, or `completions_invoker.ts` with its own inline loop |
| residents | `cortex` (`src/reside.ts:177`) | nothing supplies it |
| `coltrane play` | the terminal | does not exist |

The loop is built once, in the engine. Every caller then gets exact turn counts, cancellation by
signal, a transcript that can be saved and resumed, and one place where spend is measured.

**Why accounting is in scope from the first commit.** A census of the operator's own Claude Code
transcripts (30 days to 2026-09-16, priced at API list rates) came to about $18.6k. Cache reads
were 77% of that, and the average context per call was 346k tokens. Gig chairs run at 31–87k. A
replacement harness only saves money if contexts stay small and turns go to cheaper models, and
neither is manageable without seeing context size and cost on every round. For the same reason the
transcript has to be append-only: a changed prefix gives up the cache, and preserved-thinking
models reject edited history.

## The surface

The contract is written out as types in `tests/spec_turn_loop_fixtures.ts`. In summary:

- `runTurn(messages, opts) → TurnResult`. It never throws. `opts` supplies `port`, `model`,
  `tools?`, `allow?`, `max_rounds`, `timeout_ms?`, `signal?`, `prices?`, `max_tokens?` and `onEvent?`.
- `ModelPort = (ModelRequest) → Promise<ModelReply>`. A port may throw; the loop turns the throw
  into a typed stop.
- `TurnStop` is one of `done`, `round_limit`, `timeout`, `aborted` or `transport_failed`.
- Each `RoundRecord` carries `model`, `usage`, `context_tokens`, `cost_usd` and `tool_calls`.
- `TurnTotals` carries summed tokens by class, `cost_usd` over the priced rounds, `unpriced_rounds`,
  `unreported_rounds` and `peak_context_tokens`.
- `makeChatCompletionsPort({ baseUrl, apiKey, fetchFn })` covers the chat-completions wire. Tool-name
  encoding moves into it, and `completions_invoker.ts` re-exports those names so its existing laws
  keep their import.

## The laws, and the defect each one closes

| law | holds | closes |
|---|---|---|
| 1–2 | a plain answer ends the turn; a tool result reaches the next round | — |
| 3 | usage is **summed** over every round | the invoker reported only the last round (`completions_invoker.ts:268`) |
| 4 | context size per round, plus the peak | nothing showed context size |
| 5–7 | cost comes from a price table the deployment supplies, keyed by the **served** model. A round whose transport names no model is *unpriced*: the requested model does not stand in (amended, see Review). An unpriced model or token class is *unpriced*; a round with no usage is *unreported*. Neither is ever counted as $0. | — |
| 8 | only allowed tools are offered, in the source's own order, and the list is the same every round (so the prefix stays cacheable). No allow list means no tools. | every listed tool was offered (`:238`) |
| 9 | a call to a tool that was never offered does not reach the source | the loop called whatever name came back (`:283`) |
| 10 | running out of rounds is a typed stop, and the transcript it leaves can be continued | fell through to parsing empty content |
| 11–12 | the per-call timeout fires even when the caller passes a signal; an abort is reported as `aborted` | `ctx.signal ?? controller.signal` switched the timeout off (`:256`) |
| 13 | a transport failure is a typed stop, not a throw | — |
| 14 | events fire live, before the next model call | tool calls emitted no events |
| 15 | append-only: a continuation re-sends earlier turns byte-for-byte, the caller's array is not mutated, and the port's opaque `raw` survives | — |
| 16–17 | the port reports cached prompt tokens as cache reads; tool calls round-trip on the wire; a non-2xx response throws | — |
| 18 | neither new file reads the environment or names a vendor | — |
| 19–20 | **the last inch:** a three-round chair's summed tokens and its priced cost reach `GigResult.usage`; a cached prompt still settles the full prompt as `input_tokens` (amended) | the loop's accounting has to reach the ledger |
| 21 | the invoker offers only the chair's grants; a bare in-house grant maps to the engine server's tool | allowed tools were never applied |
| 22 | the venue narrows what the chair can use | the room's limits were never applied |
| 23 | the invoker honours `ctx.turn_budget`, and hitting it returns the refusal `round_limit`; with no chair budget, the agent's `max_tool_calls` bounds the rounds (amended) | `turn_budget` was ignored on this path |

## Review

Reviewed by gig `c539c33b` (`spec-review-and-sequence-v0`; change-decision `5bd05a16`, change-plan
`b411f1f6`). Three findings adopted as law amendments, each red against today's code:

- **Pricing with no served model.** The first draft priced such a round by the requested model. A
  request can name an alias the transport routed elsewhere, so that was a default standing in for
  a value nobody reported. It is now unpriced (law 5, third case).
- **Cached prompts through the invoker.** The port splits `prompt_tokens` into uncached input and
  cache reads, and `GigUsage` has no cache fields. An invoker settling only the uncached part would
  silently shrink the gig's `input_tokens`, and no fixture caching nothing could see it (law 19,
  second case).
- **No chair budget.** No law covered an absent `turn_budget`. Resolution follows the turn-budget
  contract: chair, then agent `max_tool_calls`, then the engine default (law 23, second case).

Declined: a law 2 sub-case (laws 8 and 9 already cover an unallowed call) and an ESLint rule for
law 18 (out of scope). The review's stop-condition counts and some of its law numbering are wrong;
the law files, not the review's paraphrase, are authoritative.

## Non-goals

- **Connecting a tool source in the worker** (`src/cli.ts:351`). That needs an MCP client, which
  belongs to the next change. Laws 8–9 and 21–22 have to land first, or connecting the tools opens
  the bypass.
- **A native Anthropic port with prompt caching.** That is the next change after this one. The
  `raw` field and the append-only law exist so that port fits without changing the loop.
- **Reserve draws (`ctx.turn_reserve`).** They depend on "the chair did not seal", which on this
  path is decided at the runtime seal and not inside the loop.
- **Host tools** (Bash, Read, Edit…), **`coltrane play`**, compaction, and a price config file.
- **Any change to `claude_invoker.ts`.**
