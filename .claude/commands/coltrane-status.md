---
description: Quick coltrane system health overview via the system_health MCP tool
argument-hint: [window]
---

The user has typed `/coltrane-status $ARGUMENTS`. If an argument is present,
treat it as the `window` parameter (e.g. `7d`, `24h`, `30d`). Otherwise default
to `7d`.

Call the coltrane MCP tool `mcp__coltrane__system_health` with:

- `window`: the user-supplied window or `7d` as default

Report back a concise overview covering:

- gigs run in the window
- total cost
- top type / agent / tool stats
- any bottlenecks surfaced
- budget status

Keep the response under 15 lines unless the user asks for more detail.
