# seeds/

Pre-built conversation priors that condition a Claude session's behavioral default for a specific lane.

Each `<lane>.jsonl` is a parentUuid-chained sequence of user/assistant turns in pure I/O form: user posts the artifact (diff, error, file), assistant responds in lane-shaped voice. No instructions, no recipes, no preamble — just demonstrated behavior across many cases.

To spawn a lane-shaped Claude session from a seed:
1. Copy `seeds/<lane>.jsonl` to `~/.claude/projects/<project-slug>/<session-uuid>.jsonl`
2. Spawn `claude --resume <session-uuid>`
3. The session resumes with the demonstrated behavior loaded as recent context

## current lanes

- **code-reviewer.jsonl** — 30 worked-example pairs of diff-in / focused-review-out. concise, actionable, opinionated. flags: magic numbers, missing error handling, security/PII concerns, unowned TODOs, leaking response shape, hardcoded values, key rotation, test isolation gaps.

## design notes

- Density matters: longer + more diverse seed → broader behavioral coverage
- Format purity matters: pure I/O > mixed prose (per N=20 empirical, see PR #115)
- parentUuid integrity matters: append-without-chain-link fails silently
- Capability uplift unproven beyond UX-bypass artifacts; behavioral defaulting is the validated claim

## how a seed is used at runtime (planned)

A coltrane MCP tool receives the user's task + selects the matching lane seed, copies it to the user's `~/.claude/projects/` under a deterministic uuid, and the next `claude --resume <uuid>` boots Claude into the lane-shaped stance.
