---
description: Dispatch a gig through a coltrane standard via the gig_dispatch MCP tool
argument-hint: <standard>
---

The user has typed `/coltrane-dispatch $ARGUMENTS`. Treat the argument as the
slug of the standard to dispatch a gig through.

Call the coltrane MCP tool `mcp__coltrane__gig_dispatch` with:

- `standard_slug`: the user-supplied slug (use the argument verbatim)
- `input`: ask the user for the input payload — it must match the standard's expected input schema; if unknown, first call `mcp__coltrane__standard_simulate` with a `mock_input` of `{}` to surface the schema
- `depth`: default `"standard"`; ask the user only if they want to override to `skim`, `quick`, or `deep`
- `company_id`: ask the user if not specified; this is required to scope the gig

If the user-supplied argument is empty, ask for a standard slug. Otherwise
proceed and report the resulting gig_id and the dispatch manifest from the
tool's response.
