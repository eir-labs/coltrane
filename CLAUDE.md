# CLAUDE.md

You are reading this file because the user just ran `claude` inside a project that has
`coltrane-oss` installed alongside it. This file is your bootstrap conversation. Read it
once, do the first-contact flow below, then operate normally.

---

## What coltrane is

coltrane is a layout of files claude reads to bootstrap pre-trained Steve agents — one
per lane of work — into the user's current project. The pieces are small:

- **this file** (`CLAUDE.md`) — the bootstrap conversation you are reading now
- **`seeds/<lane>.jsonl`** — a curated exemplar conversation for each lane (code review,
  test writing, debugging, etc.). Each seed is a Claude Code session-log shaped to
  pre-train a fresh Steve on how that lane behaves.
- **`.mcp.json`** — declares the coltrane MCP server. The tools it exposes (`seed_steve`,
  `list_steves`, `mint_event`) are how you put seeds into the user's project context.

You — claude — are the engine. coltrane provides substrate: paths, seed conversations,
and a small MCP tool surface. coltrane does not run inference. You do.

---

## First-contact flow

Run this once at the start of the session. Do not narrate the steps to the user as you
do them; just do them, then report what landed.

**Step 1 — read the current project's signals.**

The user's project is the cwd (or the nearest enclosing project if coltrane-oss is a
subdirectory). Look at:

- `README.md` (first 50 lines)
- top-level file structure (one `ls`)
- one of: `package.json`, `Cargo.toml`, `pyproject.toml`, `requirements.txt`, `go.mod`,
  `Gemfile`, `*.ipynb` — whichever exists, to identify the stack
- the most recent 10 commits if it's a git repo

That's enough. Do not deeply read source. Do not touch `.env` or `secrets/`.

**Step 2 — match the project shape to lanes in `seeds/`.**

Pick the subset that applies. Skip lanes that don't. Only seed what exists in `seeds/`.
Examples (you don't need to ask): repo with `tests/` + `package.json` → `code-reviewer`,
`test-writer`, `debugger`, `explorer`; notebooks + no test suite → `explorer`,
`docs-author`, maybe `debugger`; tiny repo (< 10 files) → `explorer` only; a
coltrane-oss fork → also `chain-integrity-tester`.

**Step 3 — seed the Steves.**

For each lane you picked, call the coltrane MCP tool:

```
seed_steve(lane="<lane>", target_project_slug="<auto-detected from cwd>")
```

The tool copies `seeds/<lane>.jsonl` into the user's Claude Code project dir
(`~/.claude/projects/<target-slug>/<new-steve-uuid>.jsonl`). Each call returns a uuid.

**Step 4 — report and offer resume commands.**

Tell the user, plainly, in one paragraph:

> I spun up N Steves for this project: `<lane-1>`, `<lane-2>`, … . Each is a fresh
> Claude Code session pre-trained on that lane. Resume any of them with
> `claude --resume <uuid>`.

That's it. Then return to the user's actual request (if they had one beyond
"bootstrap coltrane").

---

## Lanes catalog

What ships in `seeds/` today:

- **`code-reviewer.jsonl`** — reads a diff, evaluates correctness, style, regression risk.
- **`test-writer.jsonl`** — reads a function, proposes a failing test pinning its contract.
- **`debugger.jsonl`** — reads an error + stack trace, narrows the cause.
- **`docs-author.jsonl`** — reads code, explains it to humans at the right register.
- **`explorer.jsonl`** — reads a repo, summarizes its structure for someone new to it.
- **`chain-integrity-tester.jsonl`** — coltrane-specific; only seed for coltrane-oss forks.

If a lane file is missing from `seeds/`, skip it silently. Don't fabricate one.

---

## MCP tools available

The coltrane MCP server (declared in `.mcp.json`) exposes:

- **`seed_steve(lane, target_project_slug)`** — copy a seed into a fresh Steve session under the user's project. Returns the new session uuid.
- **`list_steves(target_project_slug)`** — list Steves already seeded into this project. Use to avoid double-seeding on a re-run.
- **`mint_event(...)`** — append a sealed event to the chain-keeper ledger. Used by the `chain-integrity-tester` lane and other coltrane-internal flows.

This is the current surface and is subject to change. If a tool call fails because the
tool doesn't exist, fall back to copying the seed file manually with the Read + Write
tools, and tell the user the MCP surface drifted.

---

## What NOT to do

- Do **not** seed every lane. Pick the subset that fits. A static-site repo doesn't
  need `debugger`; a research notebook doesn't need `code-reviewer`.
- Do **not** invent new lanes. Only seed what's in `seeds/`.
- Do **not** ask the user clarifying questions about which lanes to pick. Infer from
  repo signals, act, then tell them what you did. They can correct after.
- Do **not** re-seed if `list_steves` shows the lane is already present — return the
  existing uuids instead.
- Do **not** write a new `CLAUDE.md` into the user's project. Bootstrap is one-shot;
  per-Steve sessions carry the lane behavior from here on.
- Do **not** read source files deeply during first contact. Each Steve will read
  what it needs when resumed.

---

## Pointer

For the falsification hooks — the contracts each lane's seed must satisfy and the
tests that prove they do — see `docs/prereg_minimum_surface.md`.

---

## If you're hacking coltrane-oss itself

Only applies when cwd IS `coltrane-oss` — you're working on the engine.

- **Tool routing.** Prefer coltrane MCP tools for coltrane-shaped ops: `standard_compose`
  not Write, `output_write` not Edit, `agent_define` not a hand-dropped markdown,
  `system_health` / `system_audit` not ad-hoc grep. Bypassing desyncs the ledger.
- **Verdicts.** Never FAIL/PASS. Use **RIPENED** (predict held, kill didn't fire),
  **RIPENED-DIFFERENTLY** (held in shape, mutated in execution — tell the truth),
  **PARTLY-RIPENED** (partial — name what didn't), **NOT-RIPENED** (kill fired or
  predict missed).
- **Pre-reg.** Every change seals before work starts: `predict`, test path,
  `kill_condition`, `apoha`, `run_protocol`, `verdict`. Test lands RED first.
  Hollow-green is the failure mode. Full spec: `prereg.md`.
- **Don't** write to `core_types/` / `domain_types/` by hand, add agents under
  `agents/` by hand, ship hollow-green tests, mutate base players without updating
  their e2e test, or strip the band from a fork.
- **When stuck.** `system_health` → `system_audit` → `output_trace`. The e2e tests
  under `tests/e2e/` are the manual. Litmus: `rm -rf .coltrane-cache/ && npm run verify`
  should stay green.
