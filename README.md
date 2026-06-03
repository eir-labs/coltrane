# Coltrane

**Define your Claude Code subagents as files. Get sealed audit trails. Stop prompt drift.**

If you have N+ agents in your CC setup and can't tell which one did what, this is for you.

## Install

```bash
git clone <repo-url> coltrane && cd coltrane
npm install && npm run build
```

Add coltrane to your Claude Code MCP config (one block, in `~/.claude/settings.json` or this repo's `.mcp.json`):

```json
{
  "mcpServers": {
    "coltrane": { "command": "node", "args": ["dist/server.js"] }
  }
}
```

Open Claude Code in this directory. Say "hi." Coltrane's MCP server auto-starts, the project CLAUDE.md loads, and the first-time tuning ritual greets you to learn what kind of work you do. From there, it asks permission to scan a few of your other repos for context, then drafts 3-5 starter player files tuned to what it finds.

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
