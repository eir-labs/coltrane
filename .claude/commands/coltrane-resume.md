---
description: Resume a previously-parked project from its sealed portfolio entry
argument-hint: <genome_slug>
---

The user has typed `/coltrane-resume $ARGUMENTS`. Treat the argument as the
genome_slug of a previously-parked project.

If the argument is empty, ask the user which slug to resume and offer to run
`/coltrane-portfolio` first to see the list.

Invoke `resumeGenome` from `src/portfolio.ts` with the supplied slug (e.g. via
`npx tsx -e "import('./src/portfolio.js').then(m => console.log(JSON.stringify(m.resumeGenome('$ARGUMENTS'), null, 2)))"`
or the equivalent MCP tool when available).

If `resumeGenome` throws `SealMismatchError`, report the recorded vs recomputed
hashes to the user and refuse to continue — the parked state has been tampered
with.

If `resumeGenome` throws `PortfolioNotFoundError`, report no entry exists for
the slug and offer to bootstrap a new project via `/coltrane-new`.

On success: report the restored entry's current_phase, current_standard_slug,
and next_natural_action. Then drop the conductor into that phase by reading
`standards/<current_standard_slug>.json` (if non-null) and resuming the
conductor_protocol at the named phase. The user is now back in the project at
the exact phase it was parked at.
