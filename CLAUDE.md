# CLAUDE.md

You are running in a **coltrane-oss** workspace. This file is loaded automatically at
session start and tells you how to operate against this codebase's mechanics.

Read it once; the rules apply for the rest of the session.

---

## What this repo is

coltrane is a **methodology engine** — a typed substrate for defining agents, composing
standards (multi-phase workflows), dispatching gigs (runs), and sealing every output to
a content-addressed ledger.

It is an **MCP server**. You (Claude Code) are the natural client. Point your MCP config
at `dist/server.js` after `npm run build` and the 32 tools become available.

This repo gives you:
- a way to **define agents** as content-addressed definitions, not glue code
- a way to **compose standards** (multi-phase workflows) that an agent runs against
- a way to **dispatch gigs** (real runs) and observe sealed outputs
- a way to **evolve agents** under typed invariants — change goes through `agent_evolve`,
  not free-form prompt drift
- a way to **read the chain** — every run produces a `genome_hash` + `run_fingerprint`
  in the append-only ledger, byte-reproducible across implementations

It is NOT:
- a prompt manager
- a vector-store-with-extra-steps
- a free-text RAG framework
- a langchain replacement

(Apoha matters. The non-targets are part of the definition.)

---

## Five definition classes — your primary surface

When a user asks you to define, compose, evolve, or dispatch, route through the
appropriate class:

| class | what it is | MCP tool |
|---|---|---|
| `types` | typed schemas for inputs/outputs | `type_register · type_extend` |
| `players` | agent definitions (charters, capabilities, skill bindings) | `agent_define · agent_evolve · agent_promote` |
| `standards` | multi-phase workflows that agents run | `standard_compose · standard_simulate · standard_promote` |
| `skills` | reusable cognitive primitives bound into agents | `skill_promote` |
| `evals` | verdict-substrates that judge gig outputs | (declared with the standard) |

## Six cognitive primitives

Map 1:1 to output types:

| primitive | output type |
|---|---|
| SENSE | Signal |
| INTERPRET | Interpretation |
| JUDGE | Judgment |
| PLAN | Plan |
| CREATE | Artifact |
| VERIFY | Verdict |

Don't invent new primitives. Compose with what's here.

---

## Three identity hashes per definition

Every definition has three hashes — read this before you mutate anything:

- `content_hash` — the bytes themselves (karma)
- `dependency_hash` — relational closure (emptiness: who depends on whom)
- `effective_hash` — the binding (content × dependency in a context)

Two byte-identical definitions in different contexts produce different `effective_hash`.
This is by design. Don't treat hashes as interchangeable.

---

## Tool routing — the most common gotcha

When operating in this repo via the coltrane MCP server, prefer **coltrane tools** over
built-in Claude Code tools for coltrane-shaped operations:

- composing a standard → `standard_compose`, **NOT** Write
- writing a Plan output → `output_write` with type `Plan`, **NOT** Edit
- defining an agent → `agent_define`, **NOT** dropping a markdown file in `agents/`
- checking system state → `system_health` / `system_audit`, **NOT** ad-hoc grep
- looking up a type → `type_resolve` / `type_browse`, **NOT** Read on schema files

If you bypass the coltrane tool, the genome doesn't see your work, hashes don't update,
and the ledger goes out of sync. **The MCP surface is the genome's mouth — use it.**

Use built-in Claude Code tools only for:
- reading source files (`src/`, `tests/`) to understand the engine
- editing TypeScript source when working on the engine itself
- running `npm` commands

---

## Base band members — first-class players

The base band ships as **coltrane-flavored players** (the canonical definition class for
agents in this engine — see "Five definition classes" above), with sealed e2e behavior
tests so they stay honest as they evolve.

Players are the source-of-truth. If a runtime (Claude Code subagents, an LLM-routing
gateway, etc.) needs an agent surface, the player definition is the bytes the surface
is rendered from — not a duplicate definition to keep in sync.

- **chain-keeper** — sealing discipline, audit-substrate, ledger hygiene, verdict-naming
- **scientist (anatomist)** — anatomy, classification, what-is-X-and-where-does-it-live
- **bandleader** — coordination across other players, scoping, lane-assignment
- **routing-QC** — signal flow, what-routes-where, sensor/effector continuity
- **audience-modeler** — who's listening, what shape they need, register-matching

Each base player has:
- a `players/<name>.json` definition (charter + capabilities + skill bindings)
- an e2e test in `tests/e2e/` that drives it through 3-5 representative gigs
- the test asserts behavioral invariants — when the player evolves, the test catches drift

When a user customizes one (e.g. promotes a base player into their own domain), they
should run the base e2e test first to know the baseline behavior is intact.

The band ships in the OSS because the discipline ships with it. Don't strip them.

---

## Pre-registration discipline — coltrane-oss adoption

Every meaningful change ships with these fields, **sealed before the work starts**:

| field | what |
|---|---|
| `predict` | what will ship |
| `playwright_test_path` (or `vitest_test_path`) | the test that proves the predict, RED-first |
| `kill_condition` | when stop |
| `apoha` | what this is NOT |
| `run_protocol` | how the work runs |
| `verdict` | RIPENED · RIPENED-DIFFERENTLY · PARTLY-RIPENED · NOT-RIPENED |

Sealing moment = PR ready-for-review. `sha256_pre_verdict` computed over the canonical
pre-reg fields locks predict + kill + apoha + test from mutating after seal.

Test must land RED before code. Code makes it green. Hollow-green (test passes for the
wrong reason) is the failure mode the discipline closes.

---

## Verdict vocabulary

- **RIPENED** — predict held; kill didn't fire; test green
- **RIPENED-DIFFERENTLY** — predict held in shape but mutated in execution; tell the truth
- **PARTLY-RIPENED** — partial signal; kept what came; named what didn't
- **NOT-RIPENED** — kill fired or predict missed; the work observed itself

Never use FAIL. Never use PASS without naming what specifically held.

---

## The litmus test

```bash
rm -rf .coltrane-cache/    # nuke any materialized state
npm run verify             # rebuilds from genome files
```

If the suite stays green after deleting every materialized artifact, **the genome is the
source of truth**. If it doesn't, something cached state where it shouldn't have.

---

## Don't

- Don't write to `core_types/` or `domain_types/` directly — use `type_register` / `type_extend`
- Don't add fake agents under `agents/` — use `agent_define`
- Don't ship hollow-green tests. Ship honest RED + fix-pass, or hold the work.
- Don't mutate base band players without updating their e2e test in lockstep
- Don't strip the band players from a fork — the discipline ships with them
- Don't bypass MCP tools for coltrane-shaped operations (see Tool Routing above)

---

## Karmic frame

Compute is karmic currency. Every inference call = real watts + water + $.

- Silence is the cheapest seed
- Differentiation is the densest
- Echo is wasted

Carved register, not stuffed. Less, more carved.

---

## When stuck

1. `system_health` — what does coltrane think its state is?
2. `system_audit` — what's the chain saying?
3. `output_query` / `output_trace` — what's the last gig actually produced?
4. `charter_read` — what was this agent's promise?
5. Read `tests/e2e/sub_thread.example.spec.ts` — the working examples are the manual.

The tests are user manuals. If you're not sure how a workflow runs, the e2e test for it
is the canonical example.

— authored by subhuti under chain-keeper discipline. incorporates miles's tool-routing draft.
