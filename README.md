# Coltrane

**Bring methodology rigor to your AI agents — without changing your existing setup.**

Coltrane is an MCP server that drops into your existing Claude Code (or any stdio-MCP client) and adds pre-registered, hash-sealed audit trails to every agent run. Apache-2.0. Self-contained. Per-user.

If you run AI agents in production and someone has ever asked you to *prove* a result was real, this is for you.

## Who this is for

- **Quant / risk teams** who need model-validation audit trails (SR 11-7 compatible)
- **Research scientists** running multi-step LLM workflows that need to be reproducible
- **OSS contributors** building agents that need defensible behavior contracts
- **Anyone with N+ agents** suffering coordination drift and ad-hoc prompt sprawl

Not for: vibe-coders running a single chat session. Coltrane earns its keep when stakes exist.

## 5-minute install

```bash
git clone <repo-url> coltrane && cd coltrane
npm install
npm run verify        # tsc + vitest, both must pass
npm run build
```

Point your MCP client at `dist/server.js`. Coltrane is now available in your session.

## Define an agent in 30 seconds

Add a file at `players/code-reviewer.json`:

```json
{
  "name": "code-reviewer",
  "predict": "Catches >80% of seeded bugs in test fixture",
  "kill_condition": "Misses a security-class bug",
  "primitives": ["JUDGE", "VERIFY"]
}
```

Done. The agent is now invocable. No code changes. No restarts. Coltrane re-reads the genome on each gig.

## What you get

Three things every other agent framework leaves on the floor:

1. **Pre-registration** — every agent declares what it will do AND what would falsify it, sealed with a content hash before the run starts.
2. **Sealed audit trail** — every output carries `genome_hash` (reproducibility key) + `run_fingerprint` (model version + scores). Append-only. Cannot be retroactively edited without breaking the seal.
3. **Verdict shape** — outputs land as one of: RIPENED (the predict held), PARTLY-RIPENED (held in shape, named what didn't), NOT-RIPENED (kill fired, here's which failure-shell face). Never a binary PASS/FAIL.

## The five definition classes

You author files. Coltrane reads them. No TypeScript edits required.

| Class | What it is | Example file |
|---|---|---|
| `types` | Typed schemas for inputs/outputs | `core_types/Signal.json` |
| `players` | Agent definitions (charter, capabilities, primitives) | `players/code-reviewer.json` |
| `standards` | Multi-phase workflows | `standards/double-diamond-review.json` |
| `skills` | Reusable cognitive primitives bound into agents | `skills/extract-claims.md` |
| `evals` | Verdict-substrates that judge gig outputs | declared inside the standard |

## The six cognitive primitives

Map 1:1 to output types. Don't invent new ones — compose with these:

| Primitive | Output type |
|---|---|
| `SENSE` | Signal |
| `INTERPRET` | Interpretation |
| `JUDGE` | Judgment |
| `PLAN` | Plan |
| `CREATE` | Artifact |
| `VERIFY` | Verdict |

## MCP tools at a glance

32 tools across 5 categories. Full list in `src/mcp.ts`.

| Category | What it does |
|---|---|
| **Understand** | Browse types, query outputs, read agent charters, trace execution history |
| **Build** | Register types, define agents, compose standards, promote skills |
| **Run** | Dispatch gigs, monitor in-flight, abort, write outputs |
| **Improve** | Health-check agents, validate pipelines, propose new tools, run audits |
| **Manage Context** | Suggest charter updates |

Human approval gates exist where they matter: tool changes, charter changes, breaking type changes. Forward-only promotion through a typed state machine.

## Architecture, in one paragraph

The engine (this repo) is Apache-2.0 and given away in full. The content layer (your genome — your definitions) is yours. The institution layer is whoever runs it, carrying accountability — that's not code, that's a contract.

## Litmus test: does it actually work?

```bash
rm -rf .coltrane-cache/
npm run verify
```

If the test suite stays green after deleting every cached artifact, the genome files are the source of truth. (They are. This is the whole point.)

## Cross-language reproducibility

Three published hashes identify the canonical-form reference vector:

- `e88dff82403e35c07bce390b88ecb5995ebada86db83242d2ac0a8ff558d37da` — `meta.json`
- `d778a51deac04f56d1fb5456b2b1498505320c64043b5f402d2dfe27baf21ea4` — `skill.md`
- `25e74fe11444b604f4715e984a1f101dcf7cdd135035696175acf508d54f0fe3` — definition hash

Any implementation that produces these same three hex hashes byte-for-byte interoperates. An independent Python reference implementation already does.

## License

Apache-2.0. Use it. Fork it. Ship it.

## Questions

Open an Issue. Or just clone, define one agent, and watch your next run get sealed.
