# CLAUDE.md

You are running in a **coltrane-oss** workspace. This file is loaded automatically at
session start and tells you how to operate against this codebase's mechanics.

Read it once; the rules apply for the rest of the session.

---

## First-time tuning (run this on every fresh clone, exactly once)

If the file `.coltrane/tuned.json` does NOT exist in this workspace yet, you are talking
to a user who just cloned coltrane. Before doing anything else, run this short discovery
conversation. After it, write `.coltrane/tuned.json` to mark this session as tuned.

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

If they name paths: scan each with the Read tool (READMEs, top-level file structure,
last 30 days of `git log --oneline` if a git repo). Do not deeply read source files.
Do not touch `.env`, `secrets/`, or anything under `.git/`.

If they say skip: continue without the scan.

**Step 3 — propose changes to the book. Grow in place, not replace.**

First, read every existing file under `agents/`, `standards/`, `skills/`, `core_types/`,
`domain_types/`, `evals/`. Then based on Step 1 + Step 2, propose CHANGES:

- **edits** to existing agents whose shape now fits the user's domain better
- **new** agents for domain-specific work that no existing agent covers
- **new** standards if multi-phase workflows you found in their repos suggest one

For each proposal, show: the file path, whether it's an edit or new, and a one-line
description. Ask which they want applied. Apply only the ones they say yes to.

Never silently overwrite. The book grows; it does not get replaced.

**Step 4 — propose edits to THIS CLAUDE.md.**

Do NOT write a separate workspace CLAUDE.md. Coltrane already ships one. Instead,
propose appendable edits:

- a "What this workspace works on" section reflecting the user's Step 1 answer
- an "Agents added this tuning" list with what they accepted in Step 3
- a "Conventions inferred from adjacent repos" section if Step 2 found patterns

Show the proposed appended block. Ask if they want it added. Append on yes.
Never replace the existing protocol sections — append below them.

**Step 5 — seal the moment.**

Create `.coltrane/tuned.json` with:

```json
{
  "tuned_at": "<ISO-8601 timestamp>",
  "user_summary": "<their step-1 answer, verbatim>",
  "scanned_repos": ["<path>", "..."],
  "agents_created": ["<slug>", "..."],
  "claude_md_appended": true,
  "agents_edited": ["<slug>", "..."]
}
```

**If `.coltrane/tuned.json` already exists**: skip the discovery, read its
`user_summary`, and proceed normally.

---

## What this repo is

coltrane is a **methodology engine** — a typed substrate for defining agents, composing
standards (multi-phase workflows), dispatching gigs (runs), and recording every run to
a content-addressed ledger.

It is an **MCP server**. You (Claude Code) are the natural client. The `.mcp.json` in
the repo root auto-wires `dist/server.js` after `npm run build`. The server registers
**34 tools** (see `src/mcp.ts` — `MCP_TOOLS`).

This repo gives you:
- a way to **define agents** as content-addressed definitions (`agent_define`)
- a way to **compose standards** (multi-phase workflows) that an agent runs against
- a way to **dispatch gigs** and read sealed outputs (`gig_dispatch`, `output_query`)
- a way to **evolve agents** under typed invariants — `agent_evolve` increments
  the version and classifies the change (creative / harmonic / permissions)
- a way to **read the chain** — every run produces `genome_hash` + `run_fingerprint`
  in the append-only ledger

It is NOT:
- a prompt manager
- a vector-store-with-extra-steps
- a free-text RAG framework
- a langchain replacement

(Apoha matters. The non-targets are part of the definition.)

---

## Definition classes — what's wired, what's loaded

The loader (`src/loader.ts`) reads all six directories at server start. Three classes
are wired end-to-end. Two load but are not yet bound into the runtime. Read the source
before depending on the unwired ones.

| class | dir | status | tools |
|---|---|---|---|
| `types` | `core_types/`, `domain_types/` | wired (validation at write) | `type_register`, `type_extend`, `type_resolve`, `type_browse` |
| `agents` | `agents/` | wired (define, evolve, dispatch) | `agent_define`, `agent_evolve`, `agent_promote` |
| `standards` | `standards/` | wired (compose, simulate, dispatch) | `standard_compose`, `standard_simulate`, `standard_promote` |
| `skills` | `skills/` | **loaded, not wired** — `defineAgent` carries no `skill_slugs` on main; runtime does not inject skill prompts | `skill_promote` (status only) |
| `evals` | `evals/` | **loaded, not wired** — runtime does not scan evals after phases; see `tests/e2e/evals_now_fire.spec.ts` for the target test | (declared inline with the standard) |

When a user asks you to define, compose, or dispatch, route through the corresponding
tool. When they ask for skills or evals, name the gap honestly.

## Six cognitive primitives

Map 1:1 to core types (`src/core_types.ts`):

| primitive | core type |
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

Every sealed definition carries three hashes (see `src/genome_writer.ts`):

- `content_hash` — the bytes themselves
- `dependency_hash` — relational closure (who depends on whom)
- `effective_hash` — the binding (content × dependency in a context)

Two byte-identical definitions in different contexts produce different `effective_hash`.
This is by design. Don't treat them as interchangeable.

---

## Tool routing — the most common gotcha

When operating in this repo via the coltrane MCP server, prefer **coltrane tools** over
built-in Claude Code tools for coltrane-shaped operations:

- composing a standard → `standard_compose`, **NOT** Write
- writing a typed output → `output_write`, **NOT** Edit
- defining an agent → `agent_define`, **NOT** dropping a JSON file in `agents/`
- looking up a type → `type_resolve` / `type_browse`, **NOT** Read on schema files

If you bypass the coltrane tool, the genome doesn't see your work, hashes don't update,
and the ledger goes out of sync. **The MCP surface is the genome's mouth — use it.**

Use built-in Claude Code tools only for:
- reading source files (`src/`, `tests/`) to understand the engine
- editing TypeScript source when working on the engine itself
- running `npm` commands

---

## Promotion lifecycle — forward-only

Status moves through ordered chains (see `src/mcp.ts:AGENT_STATUS_ORDER`):

- agents + standards: `draft → review → approved → active → retired`
- skills: `draft → testing → active → retired`

Backward or sideways transitions throw `PromotionError`. Idempotent (current = target
is allowed).

---

## Base players in this repo

The base agents live under `agents/players/` as markdown charters. Today the directory
contains:

- `audience-modeler.md`
- `chain-audit-keeper.md`
- `illumination-reviewer.md`
- `methodology-cadence-keeper.md`
- `substrate-edge-keeper.md`

These are charter documents, not loadable agent JSON. The loadable agents (consumed by
the runtime) live as `.json` files directly under `agents/`. When promoting a charter
into a runnable agent, write a sibling `.json` with the required shape (`slug`,
`primitives`, `input_types`, `output_types`).

---

## Pre-registration discipline

Every meaningful change ships with these fields, **sealed before the work starts**
via the `prereg_seal` tool (`src/pre_reg.ts`):

| field | what |
|---|---|
| `predict` | what will ship |
| `kill_condition` | when stop |
| `apoha` | what this is NOT |

Sealing computes `sha256_pre_verdict` over the canonical-JSON of the triplet, writes
an append-only ledger entry, and returns the SEALED state. The triplet cannot mutate
after seal — re-sealing the same `pre_reg_id` throws `PreRegSealError`.

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
npm run verify             # tsc --noEmit && vitest, rebuilds from genome files
```

If the suite stays green after deleting every materialized artifact, **the genome is the
source of truth**. If it doesn't, something cached state where it shouldn't have.

---

## Don't

- Don't write to `core_types/` or `domain_types/` directly — use `type_register` / `type_extend`
- Don't drop agent JSON into `agents/` by hand — use `agent_define` so the ledger seals it
- Don't ship hollow-green tests. Ship honest RED + fix-pass, or hold the work.
- Don't bypass MCP tools for coltrane-shaped operations (see Tool Routing above)
- Don't claim skills or evals affect the run — they don't yet. Name the gap.

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
3. `output_query` (scoped by `gig_id`) — what's the last gig actually produced?
   Note: `output_trace` walks the full provenance graph and currently ignores
   `max_depth` + crosses gig boundaries; use `output_query` to scope.
4. `charter_read` — what was this agent's promise?
5. Read the closest e2e test in `tests/e2e/` — the four `sub_thread.*.spec.ts`
   variants (`solo_dev`, `eng_manager`, `platform_team`, `research_lab`) are the
   working examples.

The tests are user manuals. If you're not sure how a workflow runs, the e2e test for it
is the canonical example.

— authored by subhuti under chain-keeper discipline. incorporates miles's tool-routing draft.
