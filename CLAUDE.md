# CLAUDE.md

You are running in a **coltrane-oss** workspace. This file is loaded automatically at
session start and tells you how to operate against this codebase's mechanics.

Read it once; the rules apply for the rest of the session.

---

## First-time tuning (run this on every fresh clone, exactly once)

If the file `.coltrane/tuned.json` does NOT exist in this workspace yet, you are talking
to a user who just cloned coltrane. Before doing anything else, run this short discovery
conversation. After it, write `.coltrane/tuned.json` to mark this session as tuned, and
write a project-specific `CLAUDE.md` at the workspace root reflecting what you learned.

**Step 1 — greet, ask what they're working on.**

Say plainly: "Welcome to Coltrane. Before we start, two questions so I can tune the book
to your work. First — in 1-2 sentences, what kind of work do you do? (research,
backend engineering, model risk, grant writing, content, ML platform, etc.)"

Wait for their answer. Keep it short.

**Step 2 — ask permission to scan adjacent repos.**

Say: "Can I scan a few of your other repos to learn the domain and your style? I'll
only do a survey-level read (file names, README first paragraph, recent commit
themes, language). I will NOT exfiltrate code or read secrets. Name any 2-5 repo
paths you want me to look at, or say 'skip' to skip this step."

If they name paths: scan each one with the Read tool (READMEs, top-level file
structure, last 30 days of `git log --oneline` if a git repo). Do not deeply read
source files. Do not touch `.env`, `secrets/`, or anything under `.git/`.

If they say skip: continue without the scan.

**Step 3 — propose changes to the book. Grow in place, not replace.**

First, read every existing file under `players/`, `standards/`, `skills/`, `core_types/`,
`domain_types/`. Then based on Step 1 + Step 2, propose CHANGES:

- **edits** to existing players whose shape now fits the user's domain better
- **new** players for domain-specific work that no existing player covers
- **new** standards if multi-phase workflows you found in their repos suggest one

For example:
- a research scientist might get an EDIT to `code-reviewer` (`tools` narrowed,
  `predict` re-pointed at LaTeX/Jupyter) plus NEW `literature-scout` + `claim-bounder`
- a backend engineer might get an EDIT to `code-reviewer` (predict re-pointed
  at their language) plus NEW `migration-planner` + `incident-responder`

For each proposal, show: the file path, whether it's an edit or new, and a one-line
`predict`. Ask which they want applied. Apply only the ones they say yes to.

Never silently overwrite. The book grows; it does not get replaced.

**Step 4 — propose edits to THIS CLAUDE.md.**

Do NOT write a separate workspace CLAUDE.md. Coltrane already ships one (the file
you are reading now). Instead, propose appendable edits to this file:

- a "What this workspace works on" section reflecting the user's Step 1 answer
- a "Players added this tuning" list with the players they accepted in Step 3
- a "Conventions inferred from adjacent repos" section if Step 2 found patterns
  (language, formatting, naming, branch conventions)

Show the proposed appended block. Ask if they want it added. Append on yes.
Never replace the existing protocol sections — append below them.

**Step 5 — seal the moment.**

Create `.coltrane/tuned.json` with:

```json
{
  "tuned_at": "<ISO-8601 timestamp>",
  "user_summary": "<their step-1 answer, verbatim>",
  "scanned_repos": ["<path>", "..."],
  "players_created": ["<name>", "..."],
  "claude_md_appended": true | false,
  "players_edited": ["<name>", "..."]
}
```

This file is the seal — the project's first sealed claim about what it is. Future
sessions read `.coltrane/tuned.json` to know tuning has already happened and skip
to normal work.

**If `.coltrane/tuned.json` already exists**: skip the discovery, read its
`user_summary`, and proceed normally.

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
