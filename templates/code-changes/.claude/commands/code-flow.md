---
description: Dispatch the code-change-protocol standard for a named code change.
---

Dispatch the `code-change-protocol` standard for the following code change task:

$ARGUMENTS

This standard is executed in **dispatch mode**: you (the current Claude thread) are the conductor. You do not call `mcp__coltrane__*` tools yourself. Instead, for each phase of `code-change-protocol`, you dispatch the phase's compiled agent as a subagent via the `Task` tool with `subagent_type` matching the phase agent's slug. The subagent context enforces the per-phase tool allowlist; the conductor enforces the phase ordering.

## Conductor protocol

The standard `code-change-protocol` declares four phases in this order:

1. `discover` → `subagent_type: domain-explorer`
2. `define` → `subagent_type: problem-definer`
3. `develop` → `subagent_type: solution-developer`
4. `deliver` → `subagent_type: delivery-finalizer`

For each phase in order:

1. Compose a short prompt for the phase agent that names the phase, restates the task, and forwards any sealed artifacts produced by earlier phases.
2. Call the `Task` tool exactly once with `subagent_type` set to the phase agent's slug and the composed prompt as the description.
3. Wait for the subagent's result. Summarize it for the user in one sentence that names what the phase did and whether the seal-state advanced.
4. Move to the next phase. If a phase reports a kill or a refused seal, stop the chain and report the verdict — do not advance.

## Hard rules

- **Do not call any `mcp__coltrane__*` tool from this thread.** The per-phase tool allowlist lives on each subagent. A direct call from the conductor bypasses that allowlist and breaks the contract.
- **Exactly one `Task` dispatch per phase.** Do not split a phase across multiple subagent calls; do not skip a phase; do not reorder.
- **Phase ordering is fixed:** discover → define → develop → deliver. Earlier phases produce sealed inputs for later phases; later phases must not re-open earlier seals.
- **Narrate the chain to the user.** Between subagent dispatches, write a one-sentence summary of what the phase produced and what the next phase will receive. This is the conducting-with-user narrative.

## Output

After the four dispatches, report the final verdict from `deliver`: whether the predict held, whether any kill fired, and whether the pull request was opened. If the chain stopped early, report which phase stopped it and why.
