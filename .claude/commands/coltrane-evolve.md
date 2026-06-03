---
description: Evolve an existing coltrane agent profile via the agent_evolve MCP tool
argument-hint: <slug>
---

The user has typed `/coltrane-evolve $ARGUMENTS`. Treat the argument as the
slug of an existing agent profile to evolve.

Call the coltrane MCP tool `mcp__coltrane__agent_evolve` with:

- `slug`: the user-supplied slug (use the argument verbatim)
- `changes`: ask the user which creative-space fields are changing (one or more of `identity`, `method`, `constraints`) and what the new values are
- `reason`: ask the user for a one-sentence reason for the evolution
- `evidence`: pass `{}` unless the user has provided evidence to attach

If the user-supplied argument is empty, ask for a slug. Otherwise proceed and
report the new version number and any cascade impact from the tool's response.
