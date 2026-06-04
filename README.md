# Coltrane

**Define agents as files. Get sealed run records. Stop prompt drift.**

If you have N+ agents in your Claude Code setup and can't tell which one did what, this is for you.

## Install

```bash
git clone <repo-url> coltrane && cd coltrane
npm install && npm run build
```

The repo ships its own `.mcp.json`, so Coltrane's MCP server auto-starts when Claude Code opens the directory — no `~/.claude/settings.json` edits needed. The project `CLAUDE.md` loads automatically. On a fresh clone, Claude Code reads the first-time tuning protocol in `CLAUDE.md` and runs a short discovery conversation before you start work.

## Define an agent

Agent definitions are JSON files under `agents/`. Loader rules (see `src/loader.ts`):

- one file per agent, slug-keyed
- required: `slug`, `primitives`, `input_types`, `output_types`
- optional: `domain`, `allowed_tools`, `disallowed_tools`

Example `agents/code-reviewer.json`:

```json
{
  "slug": "code-reviewer",
  "primitives": ["JUDGE"],
  "input_types": ["pull-request-summary"],
  "output_types": ["judgment"],
  "allowed_tools": ["read_file", "grep"]
}
```

Reload the MCP server (or restart Claude Code) to pick up new agent files. The genome loads at server start.

## What's actually wired

**Three live definition classes.** `core_types` / `domain_types`, `agents`, `standards`. Skills and evals load from disk but are not yet bound into the runtime — see `tests/e2e/evals_now_fire.spec.ts` and the open `tonight/miles/wire-skills` branch for the work in flight.

**Sealed runs.** Every gig produces a deterministic `genome_hash` (over the standard + its agents in canonical-JSON form) and a `run_fingerprint` (model_version, output_hashes, canonical_form_version). Both land in the append-only ledger (`src/ledger.ts`).

**Forward-sha audit chain** for Steve audit events in Live Mode (`src/audit_chain.ts`). Each event carries `prev_sha = sha_seal` of the prior event; `verifyAuditChain()` walks the stream and reports the exact break point.

**Typed type-evolution.** `type_extend` classifies changes as `additive` or `breaking` and routes breaking changes through approval (`src/composition.ts:requiresApproval`).

**Forward-only promotion.** Agent status moves through `draft → review → approved → active → retired` (skills add `testing` before `active`). Backward moves throw `PromotionError`.

## Known gaps (not yet wired)

The following are documented surface area but not enforced at runtime today. If you depend on them, read the source first.

- **`allowed_tools` is recorded, not enforced.** `agent_define` persists the allowlist; no tool-call gateway gates invocations against it yet.
- **Cost budgets are a spec field, not enforced.** No runtime check against per-gig or per-standard cost ceilings.
- **`output_trace` ignores `max_depth`** and does not filter by `gig_id` — the provenance walk crosses gig boundaries. Use `output_query` with `gig_id` to scope.
- **Skills and evals load but don't fire.** Agent definitions on `main` carry no `skill_slugs`; the runtime does not scan `evals` after phases complete.

## Live Mode (in development)

> **In development.** Wiring lands across several open PRs; commands below are the target interface, not a working end-to-end. See `docs/live_mode.md` for status.

Run four blank Claude Code agents in your Slack workspace. None of them know what they are at startup — identity emerges from the chain of work they accumulate.

```bash
coltrane init --live-slack
coltrane play --live-slack
```

## Verify

```bash
rm -rf .coltrane-cache/
npm run verify
```

`npm run verify` runs `tsc --noEmit && vitest`. Green after cache delete means the genome files are the source of truth.

## Cross-language reproducibility

Three published hashes identify the reference vector. Pinned in `tests/canonical_form.test.ts`. Any implementation that produces these byte-for-byte interoperates.

```
e88dff82403e35c07bce390b88ecb5995ebada86db83242d2ac0a8ff558d37da   meta.json
d778a51deac04f56d1fb5456b2b1498505320c64043b5f402d2dfe27baf21ea4   skill.md
25e74fe11444b604f4715e984a1f101dcf7cdd135035696175acf508d54f0fe3   definition hash
```

## License

Apache-2.0. Fork it. Ship it.
