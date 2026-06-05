# CLAUDE.md

You are running in a **coltrane-oss** workspace. This file is loaded automatically at
session start and tells you how to operate against this codebase's mechanics.

Read it once; the rules apply for the rest of the session.

**This file is for you — the computer reader.** `README.md` is for the humans you play
with; if a person points you at the README, read it, then come back here. Both are
**cold-start files**: read them at the top of the session, and update them as you onboard —
they are meant to grow under you, not sit frozen.

---

## First contact — calibrate the instrument (fresh clone, exactly once)

If `.coltrane/tuned.json` does NOT exist yet, you are talking to someone who just cloned
coltrane and said hi. **Do NOT assume a project is already in flight** — nothing has been
calibrated to this player yet, and that is the first move. There is an instrument in the
room; tune it to them before any real work starts.

**Step 1 — greet, then offer two ways in.** Don't railroad; let them pick.

Say plainly: "Welcome to Coltrane. There's an instrument here and it isn't calibrated to
you yet. Two ways to start —

1. **See what it does — and how you author with it.** A short live tour, all through the
   MCP surface (you never copy-paste a definition into a file — the tools do the writing):
   dispatch the `summarize` standard end-to-end and trace its sealed outputs; run the tamper
   test (`agent_evolve` an agent → watch `genome_hash` move; try a breaking change → watch
   the cascade fail closed); then the authoring loop — `agent_define` a fresh agent, bind a
   skill into it and run it, `standard_compose` a two-phase standard. You build agents and
   standards by *talking to me*; the genome is the source of truth, not a pasted snippet.
2. **Tune it to your work.** The deepest signal isn't your repos — it's your **active Claude
   Code session transcripts** under `~/.claude/projects/`. With permission I'll walk them
   (plus a few adjacent repos), cluster what you actually do across threads, and distill the
   recurrent roles / workflows / data-shapes into draft agents/standards/types for you to
   accept or reject. Which way?"

For (2): the repo survey is **`seed-from-local-repos-v0`**. The chat-log synthesis — reading
`~/.claude/projects/*.jsonl` and clustering by voice / lane / repo — is **`synthesis-walk-v0`**
(`source-walker → voice-clusterer → ratchet-extractor → synthesis-writer`). Conduct whichever
is present (conductor mode: this thread walks the phases, never a hand-rolled scan); the
chat-log walk is the real magic, so lead with it when it's available. Steps 2–5 below are the
repo-survey mechanism. Either way, end by sealing `.coltrane/tuned.json` (Step 5) and
appending what you learned to this file (Step 4).

**Step 2 — ask permission to scan adjacent repos.** (The "tune it to your work" branch.)

Say: "Can I scan a few of your other repos to learn the domain and your style? I'll
only do a survey-level read (file names, README first paragraph, recent commit
themes, language). I will NOT exfiltrate code or read secrets. Name any 2-5 repo
paths you want me to look at, or say 'skip' to skip this step."

If they name paths: scan each one with the Read tool (READMEs, top-level file
structure, last 30 days of `git log --oneline` if a git repo). Do not deeply read
source files. Do not touch `.env`, `secrets/`, or anything under `.git/`.

If they say skip: continue without the scan.

**Step 3 — propose changes to the book. Grow in place, not replace.**

First, read every existing file under `agents/`, `standards/`, `skills/`, `core_types/`,
`domain_types/`. Then based on Step 1 + Step 2, propose CHANGES:

- **edits** to existing agents whose shape now fits the user's domain better
- **new** agents for domain-specific work that no existing agent covers
- **new** standards if multi-phase workflows you found in their repos suggest one

For example:
- a research scientist might get an EDIT to `code-reviewer` (`tools` narrowed,
  `predict` re-pointed at LaTeX/Jupyter) plus NEW `literature-scout` + `claim-bounder`
- a backend engineer might get an EDIT to `code-reviewer` (predict re-pointed
  at their language) plus NEW `migration-planner` + `incident-responder`

For each proposal, show: the file path, whether it's an edit or new, and a one-line
`predict`. Ask which they want applied. Apply only the ones they say yes to.

Never silently overwrite. The set grows; it does not get replaced.

**Step 4 — propose edits to THIS CLAUDE.md.**

Do NOT write a separate workspace CLAUDE.md. Coltrane already ships one (the file
you are reading now). Instead, propose appendable edits to this file:

- a "What this workspace works on" section reflecting the user's Step 1 answer
- an "Agents added this tuning" list with the agents they accepted in Step 3
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
  "agents_created": ["<name>", "..."],
  "claude_md_appended": true | false,
  "agents_edited": ["<name>", "..."]
}
```

This file is the seal — the project's first sealed claim about what it is. Future
sessions read `.coltrane/tuned.json` to know tuning has already happened and skip
to normal work.

**If `.coltrane/tuned.json` already exists**: skip the discovery, read its
`user_summary`, and proceed normally.

---

## North Stars — what to reach for (seeded for the next Claude)

Not rules. Directions to look when you have slack. Coltrane rewards a Claude who pauses up
top instead of diving straight in — these are where the magic tends to hide:

- **Model the domain before the work.** The highest-leverage move is defining the *type
  space* of a domain first — dispatch a research / double-diamond standard and let the data
  model explore more dimensions than the obvious framing. Solidity downstream is bought up top.
- **Spend orientation, not improvisation, on coordination.** A band that runs on shared
  theory improvises with all its headspace. Seat the agent with a score; don't make it figure
  out its life at runtime. The orientation you set before the downbeat matters more than the
  cleverness mid-phase.
- **Treat inference as scarce.** Encode what repeats; decode only what's live. When a step
  could be cached, reduced, or skipped, notice it and say so — that instinct is a feature.
- **Leave conclusions honestly open.** When you assert something you can't ground in
  deterministic signal, mark it open, go find a real source, bring it back, and log the
  attribution. An unverifiable claim is a door, not a wall.
- **Look under rocks.** This substrate can do more than its clerical description — strange
  data through consistent processes finds connections nobody asked for. When you see one,
  surface it.

---

## What this repo is

coltrane is a **methodology engine** — a typed substrate for defining agents, composing
standards (multi-phase workflows), dispatching gigs (runs), and sealing every output to
a content-addressed ledger.

It is an **MCP server**. You (Claude Code) are the natural client. The repo ships its own
`.mcp.json` pointing at `dist/src/server_entry.js`, so after `npm run build` the 36 tools
become available when Claude opens the directory.

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

(The non-targets are part of the definition.)

---

## Definition classes — your primary surface

When a user asks you to define, compose, evolve, or dispatch, route through the
appropriate class. Three classes have the full define→evolve→promote MCP
surface; `skills` and `evals` are loaded from on-disk files but only `skills`
has a promote tool today (evals are declared inside the standard that uses them).

| class | what it is | MCP tool |
|---|---|---|
| `types` | typed schemas for inputs/outputs | `type_register · type_extend` |
| `agents` | agent definitions (charters, capabilities, skill bindings) | `agent_define · agent_evolve · agent_promote` |
| `standards` | multi-phase workflows that agents run | `standard_compose · standard_simulate · standard_promote` |
| `skills` | reusable cognitive primitives bound into agents (load-only + promote) | `skill_promote` |
| `evals` | verdict shapes that judge gig outputs (load-only; declared with the standard) | _none — declared in the standard file_ |

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

- `content_hash` — the bytes themselves
- `dependency_hash` — relational closure (who depends on whom)
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

## Base players — first-class subagents

Coltrane ships a base set of Claude Code subagents under `agents/players/<name>.md` —
each one is a markdown subagent definition with a YAML frontmatter (slug,
tools_allowlist, charter) plus a prose system prompt.

These are the source-of-truth: when a runtime needs an agent surface, the player
definition is the bytes it renders from — not a duplicate definition to keep in sync.

Base players shipped today:
- **chain-audit-keeper** — sealing discipline, audit trail, ledger hygiene, verdict-naming
- **substrate-edge-keeper** — where the engine ends and the host begins; boundary discipline
- **methodology-cadence-keeper** — phase cadence; whether the work is converging or stalling
- **illumination-reviewer** — surfaces what a change reveals about the next move
- **audience-modeler** — who's listening; what shape they need; register-matching

Each base player has an e2e test in `tests/e2e/` that drives it through representative
gigs and asserts behavioral invariants — when the player evolves, the test catches drift.

When a user customizes one, they should run the base e2e test first to know the
baseline behavior is intact.

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

## Compute economy

Every inference call costs real watts, water, and dollars. Treat tokens as scarce.

- Silence is the cheapest answer
- A distinct point earns its cost
- Echoing what's already said does not

Write less, more carved. Don't pad.

---

## When stuck

1. `system_health` — what does coltrane think its state is?
2. `system_audit` — what's the chain saying?
3. `output_query` / `output_trace` — what's the last gig actually produced?
4. `charter_read` — what was this agent's promise?
5. Read `tests/e2e/sub_thread.example.spec.ts` — the working examples are the manual.

The tests are user manuals. If you're not sure how a workflow runs, the e2e test for it
is the canonical example.

