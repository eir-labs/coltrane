# A completions seat at every door

**Status:** RED spec. Laws written in `tests/spec_completions_seat_every_door.test.ts`; not built yet.
**Depends on:** the shared turn loop (`docs/specs/turn-loop.red-spec.md`) being green. Laws 4, 6 and 7
run through the rebuilt completions invoker and its chat-completions port.

| field | value |
|---|---|
| `scope` | A new `src/invoker_selection.ts` exporting `selectChairInvoker`, used by `bootstrapServerDeps` (`coltrane dispatch`, MCP `gig_dispatch`) and by `coltrane work`. A price table loaded from `COLTRANE_PRICES_FILE`. The chat-completions port reading `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`. |
| `vitest_test_path` | `tests/spec_completions_seat_every_door.test.ts` (8 laws, one of them a control) |
| `stop_condition` | All 8 laws green; the turn-loop laws and the 17 completions-invoker laws still green; `tsc --noEmit` clean; the reachability and declared-field ratchets not raised. |
| `non_goals` | see below |
| `run_protocol` | Laws land RED. Build through `build-from-red-spec-v0`. Once green, break each wire by hand and watch its law go red. |
| `outcome` | _open_ |

## Why

The debate-school genome (`cognition/bench/school/genome`) runs a maker ⇄ verifier examine loop of up
to 30 rounds. Its model seats hold no tools: text goes in and JSON comes out. That is exactly what
the completions invoker carries. On `claude -p` every round is two Claude Code spawns. On the engine's
turn loop it is two chat completions, on a model priced in cents per million cached tokens.

Two wires are missing:

1. **Only the drain can choose the completions port.** `coltrane work` selects it from
   `COLTRANE_COMPLETIONS_URL` (`src/cli.ts`). `coltrane dispatch` and MCP `gig_dispatch` go through
   `bootstrapServerDeps`, which always builds `makeClaudeInvoker` (`src/server.ts`). debate-school's
   README launches with `coltrane dispatch`.
2. **Nothing loads a price table.** Even on the drain, a cheap run settles as unpriced.

## Deployment configuration

The engine names no provider. A deployment sets:

| variable | meaning |
|---|---|
| `COLTRANE_COMPLETIONS_URL` | chat-completions base URL; its presence selects the completions port |
| `COLTRANE_COMPLETIONS_KEY` | bearer key |
| `COLTRANE_TIER_ECONOMY` / `_STANDARD` / `_PREMIUM` | tier → model id; an unmapped tier is a typed `unresolved_tier` refusal |
| `COLTRANE_PRICES_FILE` | JSON: served model id → `{ input, output, cache_read?, cache_write? }` in USD per million tokens. Absent means spend is unpriced, never $0. Malformed means the process refuses to start, naming the file. |

## The laws

| law | holds |
|---|---|
| 1 | `gig_dispatch` runs a chair through the completions port when a URL is configured: one request to `<url>/chat/completions`, bearer key, the tier's model |
| 2 | *control:* with no URL, the door keeps the Claude invoker and calls no endpoint |
| 3 | each chair's tier routes to its mapped model |
| 4 | the deployment's price table prices the gig, with cache hits at the cache-hit rate, and the full prompt still settles as `input_tokens` |
| 5 | a malformed or negative price table refuses at startup and names the file |
| 6 | the maker ⇄ verifier examine loop completes on the completions port: the maker is amended after each failing verdict, and every call's tokens settle |
| 7 | the port reads `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` |
| 8 | the CLI and server choose the invoker through one `selectChairInvoker`, and neither constructs a completions invoker itself |

## Known limits, recorded rather than guessed

- **Time-of-day pricing.** At least one provider charges half price off-peak. The price table is flat, so
  pricing at peak rates is an upper bound, at most 2× high.
- **Replaying reasoning output.** Whether a thinking-mode `reasoning_content` must be sent back in later
  turns, or must be left out, is not stated in the provider's documentation (checked 2026-09-16). The
  port keeps it in `raw` and does not send it. A live smoke run will settle it.
- **Law 8 is a text scan.** It pins the wiring, and laws 1–3 hold the behaviour.

## Non-goals

- Tool sources for completions seats (debate-school's seats hold no tools).
- Thinking-mode request options, `response_format: json_object`, and time-windowed prices.
- The budget cleanup (a USD ceiling). That is a separate spec.
- Any change to `src/claude_invoker.ts`.
