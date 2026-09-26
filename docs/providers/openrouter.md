# Running Coltrane on OpenRouter

OpenRouter is the reference provider for Coltrane's **completions seat**. The completions seat is the
model-agnostic chair invoker in `src/completions_invoker.ts`, which runs over any OpenAI-compatible
`/chat/completions` endpoint. The engine names no provider. Everything below is deployment
configuration.

> **Status.** The one-line mode (`COLTRANE_MODEL` seating every tier), reading OpenRouter's
> `usage.cost`, and mapping `cache_write_tokens` are specified in
> `docs/specs/openrouter-reference.red-spec.json` and pinned by `tests/openrouter_reference.test.ts`.
> Until that change is built they are **not live**. The live smoke
> (`tests/security/openrouter_live_smoke.spec.ts`) has **not been run against OpenRouter yet**. It
> prints `UNVERIFIED` until someone runs it with a real key.

## The flip

```sh
COLTRANE_COMPLETIONS_URL=https://openrouter.ai/api/v1
COLTRANE_COMPLETIONS_KEY=sk-or-...            # your OpenRouter key
COLTRANE_MODEL=deepseek/deepseek-v4.1-flash   # one model for every tier
```

Setting `COLTRANE_COMPLETIONS_URL` selects the completions seat at every door: `coltrane dispatch`,
MCP `gig_dispatch` and the `coltrane work` drain all go through one `selectChairInvoker`. When the
variable is absent, the Claude CLI seat runs exactly as before. The port appends `/chat/completions`
to the URL and sends the key as `Authorization: Bearer …`.

**How a chair's model is chosen:**

1. `COLTRANE_TIER_ECONOMY` / `COLTRANE_TIER_STANDARD` / `COLTRANE_TIER_PREMIUM`, when set, is used
   for its own tier. It overrides the single model.
2. Otherwise the chair uses `COLTRANE_MODEL`. This is the same fallback role that variable already
   has on the Claude CLI seat.
3. If neither is set, the chair is refused with `unresolved_tier` **before any request is sent**.
   There is no default model. A guessed model would spend money on something nobody chose.

For example, to run cheap chairs on one model and premium chairs on another:

```sh
COLTRANE_MODEL=deepseek/deepseek-v4.1-flash
COLTRANE_TIER_PREMIUM=openai/gpt-5.6-sol
```

If `COLTRANE_MODEL` is also set for the Claude CLI seat (for example `sonnet`), remember that the
same value now seats unmapped tiers on OpenRouter too. OpenRouter will reject a bare `sonnet`
loudly, with a 400 returned as `transport_failed`. Use a full OpenRouter model id.

## Every variable the completions door reads

`tests/openrouter_reference.test.ts` (L3) records which `COLTRANE_*` variables the selector reads and
fails if one is missing from this table.

| variable | meaning |
|---|---|
| `COLTRANE_COMPLETIONS_URL` | chat-completions base URL. If set, the completions seat is used. `https://openrouter.ai/api/v1` for OpenRouter |
| `COLTRANE_COMPLETIONS_KEY` | bearer key |
| `COLTRANE_MODEL` | the one model that seats every tier not mapped below |
| `COLTRANE_TIER_ECONOMY` / `COLTRANE_TIER_STANDARD` / `COLTRANE_TIER_PREMIUM` | per-tier model id; overrides `COLTRANE_MODEL` for that tier |
| `COLTRANE_TIER_LADDER` | optional: comma-separated rungs, cheapest first (e.g. `economy,standard,premium`). A chair that cannot seal is re-seated one rung up |
| `COLTRANE_PRICES_FILE` | optional price table (below). Absent: rounds are priced only by the provider's reported cost |
| `COLTRANE_COMPLETIONS_MAX_TOKENS` | optional per-request output ceiling (`max_tokens`) |
| `COLTRANE_CHAIR_TIMEOUT_MS` | optional per-call timeout (default 120000) |
| `COLTRANE_TRANSCRIPTS_DIR` | where a seat's conversation is kept so that a maker amend resumes it. Default `<COLTRANE_OUTPUTS_DIR>/transcripts` |
| `COLTRANE_OUTPUTS_DIR` | the output root that the transcripts default is placed under (default `$HOME/.eir/coltrane_outputs`) |

## The model must support tool calling

A completions seat **seals by calling `output_write`**, so every seat makes at least one function call,
even a seat with no other tools. A model without function calling cannot seal and is refused `no_seal`.
Check the model's page on OpenRouter: its parameter list must include `tools` (and `tool_choice`).

These models were verified on **2026-09-27** to list `tools` and `tool_choice` as accepted parameters,
both on their model pages and in `https://openrouter.ai/api/v1/models?supported_parameters=tools`:

| model | page | listed price (USD / M tokens: input · output · cache read · cache write) |
|---|---|---|
| `deepseek/deepseek-v4.1-flash` | https://openrouter.ai/deepseek/deepseek-v4.1-flash | 0.30 · 1.20 · 0.006 · — |
| `qwen/qwen3.8-flash` | https://openrouter.ai/qwen/qwen3.8-flash | 0.15 · 0.47 · 0.016 · 0.20 |
| `openai/gpt-5.6-sol` | https://openrouter.ai/openai/gpt-5.6-sol | 1.00 · 5.00 · 0.10 · 1.25 (prompts over 272k tokens: 2.00 · 7.50 · 0.20 · 2.50) |

Prices and support change. Re-check the page before relying on either.

## Cost: what gets recorded

OpenRouter returns `usage.cost` on every response. Its docs say: "Full usage details are now always
included automatically in every response", and the amount is "the total amount charged to your
account", in US dollars.

- **The engine uses `usage.cost`.** A round that reports a cost settles at that cost, even if a price
  table is also configured. OpenRouter can route one model slug to several upstream providers at
  different prices, so a flat per-model table can only approximate what OpenRouter actually charges.
- **The price table prices only rounds that report no cost.** That covers a provider other than
  OpenRouter, or a response without `usage.cost`.
- **A round with neither is unpriced, never $0.** The chair's sealed record carries no `cost_usd`, and
  the gig's `usage.unpriced_invocations` counts the invocations that could not be priced.
  `total_cost_usd` is then a lower bound. The same count appears on each chair's `chair_spend` row, and
  the `coltrane dispatch` summary prints `unpriced (N invocation(s) with no known price; $x.xx
  priced)` instead of a bare total.
- **A reported 0 is a known price.** A `:free` model's `cost: 0` settles at $0 and is not counted as
  unpriced, even when a price table lists that model at a non-zero rate.
- **A negative reported cost is ignored, not treated as a credit.** The round falls back to the
  price table; if there is no table entry either, the round is unpriced.
- Cache reads (`prompt_tokens_details.cached_tokens`) and cache writes
  (`prompt_tokens_details.cache_write_tokens`) are settled as their own token classes. The full prompt
  still settles as the gig's `input_tokens`. A class that reports 0 tokens needs no rate in the price
  table.
- **Cache reads plus cache writes must not exceed `prompt_tokens`.** The engine treats both as parts
  of `prompt_tokens`. OpenRouter's documented example implies this, but it has not been confirmed
  live. If a response breaks this rule, the port refuses the round (`transport_failed`) and names
  `prompt_tokens`, `cached_tokens` and `cache_write_tokens` with their values. It does not clamp the
  uncached input to 0.

### The price file

`COLTRANE_PRICES_FILE` is a JSON file that maps the model id **the response names as having served
the round** to USD **per million tokens**. `input` and `output` are required. `cache_read` and
`cache_write` are optional, but if a round reports a token class that has no rate, the round is
unpriced (it is not priced at some other rate).

```json
{
  "qwen/qwen3.8-flash": { "input": 0.15, "output": 0.47, "cache_read": 0.016, "cache_write": 0.2 },
  "deepseek/deepseek-v4.1-flash": { "input": 0.30, "output": 1.20, "cache_read": 0.006 }
}
```

The key must match the `model` field of the **response**, which is the model that actually served the
request. It is not necessarily the id you asked for. If OpenRouter serves a dated variant, add that
id too. A price file that is present but malformed (bad JSON, a missing `input`/`output`, or a
negative rate) stops the process at startup and names the file.

## What the completions seat does NOT do

The Claude CLI seat drives a whole coding harness. The completions seat carries **MCP tools only**:

- **No host builtins.** A chair granted `Read`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `Bash`,
  `BashOutput`, `KillShell`, `Glob`, `Grep`, `LS`, `WebFetch`, `WebSearch`, `Task` or `TodoWrite` is
  refused `host_tool_denied` by name, before any request. Those chairs must stay on the Claude CLI
  seat.
- **Scoped grants are refused.** At origin/main a grant like `Bash(git diff:*)` is refused
  `no_tool_source`, because nothing serves it. PR #553 makes it a named refusal. Either way, a scoped
  chair does not run here.
- **Only the engine's own tools.** At `coltrane dispatch` / `gig_dispatch`, a seat can reach the
  engine's MCP surface (`mcp__coltrane__*`) and nothing else. At the `coltrane work` drain it gets
  `output_write` only. Another MCP server's grant (anything in `.mcp.json`) is refused
  `no_tool_source`.
- **No browser.** `mcp__playwright__*` and `browser_grant` need the Claude seat's `--mcp-config` spawn.
  Here that grant is unprovided and refused.
- **No turn reserve.** `COLTRANE_TURN_RESERVE` is passed only to the Claude seat. A completions seat
  stops with `round_limit` at its turn budget.
- **Reasoning output is not replayed.** The port does not send a thinking model's reasoning back on
  later turns.
- **Structured output is via the `output_write` tool call**, not `response_format`.
- **`coltrane chat`** (the bus terminal) still reads only `COLTRANE_TIER_*` and does not use the
  one-line `COLTRANE_MODEL`.

## Checking it live

With the three lines set and a real key:

```sh
COLTRANE_COMPLETIONS_URL=https://openrouter.ai/api/v1 COLTRANE_COMPLETIONS_KEY=sk-or-... \
COLTRANE_MODEL=deepseek/deepseek-v4.1-flash npm run test:security -- openrouter_live_smoke
```

The smoke runs a maker ⇄ verifier gig through OpenRouter. It asserts that tokens settle and that the
cost is either recorded or marked unpriced, never shown as $0. It then writes the **recorded**
response, with its date, over `tests/fixtures/completions_usage/openrouter_chat_completion.json`,
replacing the documented example. It overwrites the fixture only if the recorded response contains a
cache read, because the offline laws need one to exercise the `cached_tokens` mapping.
