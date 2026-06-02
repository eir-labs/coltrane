---
description: Dispatch the code-change-protocol standard for a named code change.
---

Dispatch the `code-change-protocol` standard for the following code change task:

$ARGUMENTS

Use the `mcp__coltrane__gig_dispatch` tool with:

- `standard_slug`: `code-change-protocol`
- `input`: `{ "task": "<the task above>" }`
- `depth`: `full`

The standard will chain four phase-agents in order:

1. `domain-explorer` surveys the repository surface and the neighbouring areas the change would touch.
2. `problem-definer` names the predict, the kill, and the apoha, and freezes them.
3. `solution-developer` writes the diff under the seal and records the test output verbatim.
4. `delivery-finalizer` runs the `code-reviewer` agent against `code-review-minimum-bar`, renders the verdict, and opens the pull request only if the predict held and the review bar passed.

After dispatch, monitor the gig with `mcp__coltrane__gig_monitor` and report the verdict from the deliver phase.
