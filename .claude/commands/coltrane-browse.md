---
description: Browse the coltrane MCP tool registry via the tool_registry_browse MCP tool
argument-hint: [category]
---

The user has typed `/coltrane-browse $ARGUMENTS`. If an argument is present,
treat it as the `category` filter (one of `understand`, `build`, `run`,
`improve`, `manage_context`). Otherwise list all categories.

Call the coltrane MCP tool `mcp__coltrane__tool_registry_browse` with:

- `category`: the user-supplied category, or omit to list everything
- `usage_min`: omit (default 0)
- `unused_since`: omit (default none)

Report back a grouped list of tools by category, with the slug and a one-line
description for each. If usage stats are present in the response, include the
top 3 most-used tools at the top.
