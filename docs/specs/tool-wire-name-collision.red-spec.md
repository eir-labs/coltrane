# contract-tool-wire-name-collision-v1 — RED spec

**Criteria.** Two tools a seat cannot tell apart on the wire are a **refusal**, never an insertion-order winner.

**Laws (RED):** `tests/spec_tool_wire_name_collision.test.ts`
**Controls (stay green):** `tests/spec_turn_loop.test.ts`, `tests/spec_completions_invoker.test.ts`, `tests/spec_completions_seat_every_door.test.ts`, `tests/spec_completions_seat_transcript.test.ts`

## The defect

`src/chat_completions_port.ts:214` builds the reverse map that resolves a reply's function name back to
its MCP name:

```ts
const byWireName = new Map(req.tools.map((t) => [encodeToolName(t.name), t.name]));
```

`new Map(entries)` silently keeps the **last** duplicate key. When two OFFERED tools encode to the same
wire name — two MCP servers each exposing a tool of the same base name, or (at the third encoding tier)
two long names sharing a 23-byte prefix whose 64-bit digests collide — the model is sent two identical
function definitions, calls that name, and the port resolves it to whichever tool won the Map. The other
server's tool runs, and both the model and the invoker read it as success: the silent-wrong-value class,
reachable by ordinary configuration. The K6 witness's ask (PR #534, 2026-09-04): refuse at the map, one
layer down where it is reachable, and make the law about the offered **set**
(`new Set(listed.map(encodeToolName)).size === listed.length`), not about the digest separating two strings.

## Obligations → mechanism, callsite, law

### O1 — the turn refuses a colliding offered set before any model call
`TurnLoopOptions` (`src/turn_loop.ts:131`) gains an optional `wire_name: (name: string) => string`. In
`runTurn` (`src/turn_loop.ts:224`), the offered set is computed once at `:247–249`; when `wire_name` is
supplied, map the OFFERED names through it and, if
`new Set(offered.map(wire_name)).size !== offered.length`, set a new typed stop `tool_name_collision`
(added to `TurnStop`/`TURN_STOPS` at `:87–97`) and return **before** the round loop reaches `opts.port`
(`:280`). The `error` names both colliding MCP names and the wire name they share.
- Law: `O1 — two offered tools that map to one wire name stop tool_name_collision before any model call, naming both MCP names and the shared wire name` — asserts `stop === "tool_name_collision"`, zero model calls, and the error names `mcp__a__foo`, `mcp__b__foo`, and the shared wire name. RED today: no `wire_name`, no such stop → the turn runs and stops `done`.

### O2 — the completions invoker surfaces the stop as a typed refusal
`makeCompletionsInvoker` (`src/completions_invoker.ts:146`) passes `encodeToolName` as `wire_name` into
the `runTurn` call (`:250`), adds `tool_name_collision` to `CompletionsRefusal`/`COMPLETIONS_REFUSALS`
(`:102–127`), and maps the stop to a `refuse("tool_name_collision", …)` beside the other stop→refusal
branches (`:308–339`). The message names both tools; nothing is sealed and no model call is made.
- Law: `O2 — makeCompletionsInvoker refuses tool_name_collision naming the tool, seals nothing, and never calls the model` — asserts `COMPLETIONS_REFUSALS` includes `tool_name_collision`, the returned refusal is `tool_name_collision`, the message names the tool, and the fake fetch is never called. RED today on all three.

### O3 — the port refuses a colliding request before it fetches
`makeChatCompletionsPort`'s returned port (`src/chat_completions_port.ts:211`) checks, before building
`byWireName` (`:214`) and before `doFetch` (`:223`), that the request's tools invert:
`new Set(req.tools.map((t) => encodeToolName(t.name))).size === req.tools.length`. When they do not, it
throws a refusal naming both tools and the wire name they collapsed onto — the map is never built from a
set it cannot invert. This is the fail-closed layer the witness noted is reachable.
- Law: `O3 — a request whose tools encode to the same wire name is refused before the fetch, naming the wire name they collapsed onto` — asserts the port throws, no fetch, and the message names the wire name. RED today: the port builds the collapsing Map and fetches.

## Invariants

- **I1 — a distinct tool set is unaffected.** Law `I1 — a distinct three-tool set with wire_name runs and offers all three, while a genuine wire-name collision on the same path is still refused`. The control half (three distinct names, all offered, turn runs) is green today and after the fix; the RED half (a genuine collision on the SAME `wire_name` path must still refuse) fails today, so the invariant is not satisfied by a check that never refuses.
- **I2 — only the OFFERED set matters.** Law `I2 — a wire collision with only one tool inside the allow list runs normally; both inside the allow list is refused`. The control half (two tools collide on the wire but only one is inside the allow list → the offered set holds no collision → the turn runs) is green; the RED half (both inside the allow list → the offered set collides → refuse) fails today, proving the check is over `offered`, not `listed` or the allow list.

## Failure mode

- **F1 — no `wire_name` supplied.** Law `F1 — no wire_name means no collision check and the turn behaves exactly as today; supplying wire_name is what turns the check on`. Control half (a colliding set with no `wire_name` runs exactly as today) is green; RED half (the same set WITH `wire_name` is refused) fails today, proving the check is gated on `wire_name` — the off-switch, not the absence of the feature.

## Testing method and a deliberate choice

Example-based, at the three real seams. `runTurn` is driven directly with a stub `ModelPort` + `ToolSource`
and an injected `wire_name` that collapses two DISTINCT names onto one — the exact contract shape (O1, I1,
I2, F1). The invoker law goes through `makeCompletionsInvoker` with a fake fetch that must never be called
(O2). The port law drives `makeChatCompletionsPort` directly (O3).

**Why O2/O3 use two tools of the same MCP name.** A DISTINCT-name collision under the real `encodeToolName`
exists only at the third tier — two long names sharing a 23-byte prefix AND colliding on a 64-bit digest —
which is infeasible to construct deterministically in a test (birthday bound ~2^32; `shortDigest` is 64-bit
by construction, `src/chat_completions_port.ts:45–53`). Two tools of the same MCP name are the
hand-constructible instance of the SAME set-size violation the contract refuses
(`new Set(encoded).size < length`) and exercise the real encoding (identity on a safe name). The `runTurn`
laws exhibit the DISTINCT-name collapse directly, through the injected `wire_name` the contract adds for
exactly that purpose.

The tests are RED by design: the enforcement they demand — `wire_name`, the `tool_name_collision` stop and
refusal, and the port's pre-fetch set check — does not exist yet.
