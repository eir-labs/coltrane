# Coltrane

The Well-Tempered Agent System.

An MCP server that composes bands of agents from a content-addressed genome, runs them against typed inputs, and emits a reconstructible, hash-sealed record of what happened. Open source. Self-contained. Per-user.

## Install

```bash
git clone <repo-url> coltrane && cd coltrane
npm install
npm run verify
```

`npm run verify` runs `tsc --noEmit && vitest run` — both gates must pass for green.

## Run the MCP server

```bash
npm run build
node dist/server.js
```

Then point any MCP client (Claude Code, Cursor, anything stdio-MCP) at this binary.

## What it is, in 5 sentences

1. **Genome** — content-addressed JSON/text files under `core_types/`, `domain_types/`, `agents/`, `standards/`, `skills/`. Adding a type or agent means adding a file; no TypeScript changes required.
2. **Five definition classes** — `types · players (agents) · standards · skills · evals`. Each is a hashable, fixture-backable definition.
3. **Six cognitive primitives** — `SENSE · INTERPRET · JUDGE · PLAN · CREATE · VERIFY`. Each maps 1:1 to a core output type (`Signal · Interpretation · Judgment · Plan · Artifact · Verdict`).
4. **Three identity hashes per definition** — `content_hash` (the bytes) · `dependency_hash` (the relational closure) · `effective_hash` (the binding of the two). Two byte-identical definitions in different contexts produce different effective hashes.
5. **One sealed record per gig** — `genome_hash` (deterministic, the reproducibility key) + `run_fingerprint` (carries model_version + eval scores, non-deterministic by design). Both live in the append-only ledger.

## MCP tool surface

32 tools across 5 categories. The full list is in `src/mcp.ts`. Highlights:

| Category | Tools |
|---|---|
| Understand | type_resolve · type_browse · output_query · output_trace · charter_read · execution_history_read · access_grant_check · tool_registry_browse |
| Build | type_register · type_extend · agent_define · agent_evolve · agent_promote · standard_compose · standard_simulate · standard_promote · skill_promote |
| Run | gig_dispatch · gig_monitor · gig_abort · output_write |
| Improve | agent_validate_pipeline · health_check · system_health · system_audit · proposal_create · tool_propose · tool_deprecate_propose · capability_research · session_review_write · learning_synthesize |
| Manage Context | charter_suggest_update |

Approval is gated structurally: `tool_propose`, `tool_deprecate_propose`, and `charter_suggest_update` always require human approval; `type_register` / `type_extend` require it only for breaking changes; lifecycle promotion (`agent_promote` / `standard_promote` / `skill_promote`) is forward-only through a typed state machine; everything else operates within the type-safety guardrails.

## Architecture

| Layer | What it is |
|---|---|
| ENGINE | This repo. The runtime + MCP server + canonical_form contract. Apache-2.0. |
| CONTENT | Per-deployment genome (your definitions). Re-accumulable. |
| INSTITUTION | The party running it, carrying accountability. Not code. |

The engine is given away in full. The accountability stake is the commercial coordinate, held by whoever operates a deployment.

## Litmus test

```bash
rm -rf .coltrane-cache/    # if any
npm run verify             # rebuilds from genome files
```

If the suite stays green after deleting every materialized artifact, the genome is the source of truth.

## Canonical form interoperability

Every implementation that produces the same 3 published hex hashes interoperates:

- `e88dff82403e35c07bce390b88ecb5995ebada86db83242d2ac0a8ff558d37da` — `meta.json` for the `hello-skill` reference vector
- `d778a51deac04f56d1fb5456b2b1498505320c64043b5f402d2dfe27baf21ea4` — `skill.md` for the same
- `25e74fe11444b604f4715e984a1f101dcf7cdd135035696175acf508d54f0fe3` — definition hash

Cross-language conformance: TypeScript (this repo) and Python (`~/eir/math/proofs/test_coltrane_canonical_form.py`) both reproduce these hashes byte-for-byte.

## License

Apache-2.0
