---
description: Define a new coltrane agent profile via the agent_define MCP tool
argument-hint: <slug>
---

The user has typed `/coltrane-new-agent $ARGUMENTS`. Treat the argument as the
slug for a new agent profile.

Call the coltrane MCP tool `mcp__coltrane__agent_define` with:

- `slug`: the user-supplied slug (use the argument verbatim)
- `primitives`: ask the user which primitives the agent uses if not obvious from context; default to `["INTERPRET"]` for a single-step transform
- `input_types`: ask the user which domain types the agent consumes; default to `[]` for a source agent
- `output_types`: ask the user which domain types the agent produces; this is required — do not default
- `identity`: a short statement of who the agent is and what it does (1 sentence)
- `method`: how the agent works step by step (2-4 sentences)
- `constraints`: a list of what the agent will not do (3-5 items)
- `permissions`: sensible defaults — `{ "allowed_tools": [], "disallowed_tools": [], "model_tier": "balanced", "max_tool_calls": 10, "max_token_budget": 50000, "can_write_outputs": true, "can_trigger_standards": false }`

If the user-supplied argument is empty, ask for a slug. Otherwise proceed and
report the resulting agent_profile_id and validation_result from the tool's
response.
