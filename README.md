# Coltrane

**Define your Claude Code subagents as files. Get sealed audit trails. Stop prompt drift.**

If you have N+ agents in your CC setup and can't tell which one did what, this is for you.

## Install

```bash
git clone <repo-url> coltrane && cd coltrane
npm install && npm run build
```

That's it. Open Claude Code in this directory and say "hi."

The repo ships its own `.mcp.json`, so Coltrane's MCP server auto-starts when Claude opens the directory — no `~/.claude/settings.json` edits, no manual server start. The project CLAUDE.md loads automatically, and the first-time tuning ritual greets you: it learns what kind of work you do, asks permission to scan a few of your other repos for context, then proposes edits to existing player files or new ones tuned to what it finds. The book grows in place; it doesn't get replaced.

## Define an agent in 30 seconds

Create `players/code-reviewer.json`:

```json
{
  "name": "code-reviewer",
  "predict": "Catches >80% of seeded bugs in the test fixture",
  "kill_condition": "Misses a security-class bug",
  "tools": ["read_file", "grep", "ast_query"]
}
```

CC can now invoke this agent. No restarts. No code changes. The file IS the agent.

## What you get

**Blast radius bounded.** Every agent declares its tool allowlist in its definition. The agent literally cannot call tools outside that list. No surprise side effects.

**No self-promotion.** Agents cannot promote themselves or modify their own charter. Promotion (DRAFT → CANDIDATE → PROMOTED) is forward-only and requires human approval.

**Type safety on changes.** Breaking changes to types gate on review. Forward-compatible additions don't. The type system tells you which is which before you ship.

**Sealed runs.** Every gig produces a `genome_hash` (reproducible) + `run_fingerprint` (model version, scores). Append-only ledger. When something fails, you can replay exactly what happened.

## Live Mode (in development)

> **In development.** The wiring lands across several open PRs; the commands below are the target interface, not yet a working end-to-end. See `docs/live_mode.md` for status.

Run four blank Claude Code agents in your Slack workspace. They show up as bots, react to messages, post threads, and do work on the project you point them at. None of them know what they are at startup — identity emerges from the chain of work they accumulate.

```bash
coltrane init --live-slack
coltrane play --live-slack
```

See `docs/live_mode.md` for the longer story: setup, what to expect on day 1 / day 7 / day 30, and why the agents start blank.

## Verify it works

```bash
rm -rf .coltrane-cache/
npm run verify
```

Green after cache delete = your agent files are the source of truth. (They are.)

## Cross-language reproducibility

Three published hashes identify the reference vector. Any implementation that produces these byte-for-byte interoperates. An independent Python reference implementation already does.

```
e88dff82403e35c07bce390b88ecb5995ebada86db83242d2ac0a8ff558d37da   meta.json
d778a51deac04f56d1fb5456b2b1498505320c64043b5f402d2dfe27baf21ea4   skill.md
25e74fe11444b604f4715e984a1f101dcf7cdd135035696175acf508d54f0fe3   definition hash
```

## License

Apache-2.0. Fork it. Ship it.
