# contract-seat-ask-v1 — asking a past seat, on its own resumed session, with no hands

**Status:** RED spec. The laws in `tests/spec_seat_ask.test.ts` fail today because `seat_ask` does
not exist. This document names, per obligation, the mechanism and the callsite the enforcement must
use, and the red law that verifies it. It publishes nothing.

## Why

Reconciliation is a discussion with a reconciliation agent, not an agent grading itself — "an agent
writing its own memory will drift toward excuses" (operator, 2026-09-19). The asymmetry that makes it
honest: the **reconciler** holds the deterministic record (a gig census — chairs, amend rounds, failed
verdicts, departures, spend), and the **worker** holds the memory of *why*. Today the engine has no
verb to ask a past seat anything. A chair's session is derived from `(gig_id, role)` and the Claude
invoker can resume it (contract-chair-session-continuity-v1), but nothing exposes that as a tool — so
the only way to get a worker's reasoning into a reconciliation is to ask a **fresh** seat to *imagine*
it. That invented story is exactly what the ledger must never accrue. Resuming the seat's own session
is the cheap half: measured this session, re-reading a seat's context cold costs ~540k cache-read
tokens per turn; resuming the conversation it already holds does not.

## The decided shape

`seat_ask({ gig_id, role, question, max_turns? }) → { answer, session_id, resumed: true }`, or a typed
refusal when there is no conversation to ask.

**Non-obvious choice — the answer is prose, returned verbatim.** A hands-off seat has no tools and
seals nothing; it replies in prose. So the verb returns that prose as `answer`, never re-parsed as
JSON (the engine's normal text path extracts JSON from a seat's stdout — that path is for a working
chair that emits a structured output, not for an interrogated one). The injected `run` seam's return
value in the laws is therefore the seat's answer text itself: a non-empty string in the O1/I1/I2
laws, and `""` in the F2 law.

## Obligations → mechanism → callsite → law

### O1 — resume THAT seat's session; send only the question
- **Mechanism.** The handler resolves the session uuid with `sessionUuidFor(gig_id, role)`
  (`src/claude_invoker.ts:1274`) — the SAME derivation the amend loop uses (`src/runtime.ts:3812`,
  `3945`) — and drives the resumed, hands-off spawn through `deps.invoke` (a `makeClaudeInvoker`,
  `src/claude_invoker.ts:1486`). The only thing sent is the question: it becomes the `-p <question>`
  positional built by `buildInvokerArgs` (`src/claude_invoker.ts:1375`, `:1384`). No gig input, no
  identity layer, no method — the conversation already holds them, which is what makes the ask cheap.
- **Callsite.** New `case "seat_ask"` in `runImpl` (`src/server.ts:490`), reached through
  `dispatchTool` (`src/server.ts:437`); `KNOWN_SLUGS` is built from `MCP_TOOLS`, so advertising the
  verb (O3) routes it. Returns `{ answer, session_id, resumed: true }` as `ToolResult.data`.
- **Law.** `O1 — returns { answer, session_id, resumed: true } and the ONLY thing the spawn is sent is
  the question`.

### O2 — the asked seat is given NO tools; the turn cap defaults to 2
- **Mechanism.** The spawn carries an EMPTY allow list, so `buildInvokerArgs` emits no `--allowedTools`
  (`src/claude_invoker.ts:1440`) — nothing is granted, MCP or builtin. The host builtins are refused by
  construction: `hostBuiltinDenials` (`src/tool_providers.ts:94`) over an empty allow set denies every
  member of `HOST_BUILTINS` (`src/tool_providers.ts:32`, incl. `Write`/`Edit`/`Bash`/`Read`), emitted
  as `--disallowedTools`; `--strict-mcp-config` (`:1414`) keeps ambient MCP denied. A resumed seat that
  could act is a seat that could rewrite the very record it is being asked about. The turn cap is
  `max_turns ?? 2`, threaded as `max_tool_calls` so `buildInvokerArgs` always emits `--max-turns`
  (`:1407`) — never unbounded.
- **Callsite.** `src/claude_invoker.ts` (the resumed, hands-off branch) + `src/server.ts` handler.
- **Laws.** `O2 — empty allow list, no MCP tool, and the write/act builtins denied by construction …`
  (acceptance #4) and `O2 — --max-turns defaults to 2 when max_turns is omitted, honours an explicit
  cap, and is ALWAYS present`.

### O3 — advertised on the MCP surface with its arguments
- **Mechanism.** A `TOOL_DEFS` entry (`src/mcp.ts:44`) `{ slug: "seat_ask", … input_schema: obj({
  gig_id: "string", role: "string", question: "string", max_turns: "number" }), output_schema: obj({
  answer: "string", session_id: "string", resumed: "boolean" }) }`, the same shape `gig_dispatch`
  uses (`src/mcp.ts:158`). `obj` (`src/mcp.ts:23`) generates `{ type:"object", properties:{…} }` so the
  arguments cannot drift from the surface.
- **Law.** `O3 — seat_ask is a verb in MCP_TOOLS and its generated schema carries gig_id, role,
  question and max_turns`.

### I1 — an answer is attributed to the conversation that produced it
- **Mechanism.** The returned `session_id` IS `sessionUuidFor(gig_id, role)`; the spawn carries
  `--resume <that uuid>` and never `--session-id` (a resume CONTINUES, an open FORKS a fresh session —
  `buildInvokerArgs` `:1402`–`:1404`). `withResume` (`:1294`) is the same one-session discipline.
- **Law.** `I1 — session_id equals sessionUuidFor(gig_id, role) AND the spawn resumes that exact uuid
  (never opens a fresh one)`.

### I2 — asking changes nothing
- **Mechanism.** The handler seals no output and appends no ledger row of its own — it only reads a
  conversation and returns text. `deps.outputs.all()` (`src/outputs.ts:313`) and `deps.ledger.query()`
  (`src/ledger.ts:611`) are byte-identical before and after a successful ask.
- **Law.** `I2 — a SUCCESSFUL ask seals no output and writes no ledger row: the store and ledger are
  byte-identical before and after`.

### F1 — no conversation is a typed refusal, never an invented answer
- **Mechanism.** A `--resume` whose session is gone is reported by the CLI as a result event matching
  `resumeSessionLost` (`src/claude_invoker.ts:1313`, `/no conversation found|no such session|session
  .*not found/i`). The seat_ask path must NOT take the amend loop's cold fallback
  (`resumeColdFallback`, `:1907`) — a fresh `--session-id` seat would invent the reasoning this verb
  exists to prevent. Instead it returns a typed refusal naming `gig_id` and `role`. Returned, never
  thrown (runImpl's try/catch, `src/server.ts:491`, keeps a tool refusal a value).
- **Law.** `F1 — a lost/absent session returns a typed refusal naming the gig and role, spawns NO fresh
  seat, and never throws`.

### F2 — an empty answer is an empty answer
- **Mechanism.** A resumed seat that replies with nothing yields `{ answer: "", resumed: true }` — the
  emptiness is the seat's, not the engine's, so it is neither a refusal nor a filled-in guess.
- **Law.** `F2 — the resumed seat answering with nothing yields { answer: '', resumed: true } …`.

## Verification method

Example-based laws, `vitest`. Each is a specific behaviour of one new verb, not a universal property,
so example-based assertions against the real callsites are the right instrument (no property engine is
warranted). The tool is driven through the engine's own dispatch path (`dispatchTool`) and the spawn is
observed through `makeClaudeInvoker`'s injected `run` seam — captured argument lists and the
`-p <question>` positional — exactly as the existing engine-tool and invoker-cage suites do
(acceptance #2).

## Controls (must stay green; not weakened by this spec)

`tests/spec_chair_session_continuity.test.ts`, `tests/spec_resumed_gig_continues_chair_session.test.ts`,
`tests/invoker_cage.test.ts`, `tests/genome_browse_parity.test.ts`.

## Out of scope

`src/**` (the implementation), `scripts/laws.sh`, `agents/**`, `standards/**`, `domain_types/**`, the
reconciliation standard itself, the agent lesson ledger, asking a seat that ran on a chat-completions
door (it holds no resumable session), committing or pushing.
