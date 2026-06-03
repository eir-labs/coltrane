---
description: List the user's in-flight project portfolio with phase + parked-status
argument-hint: [genomes_root]
---

The user has typed `/coltrane-portfolio $ARGUMENTS`. If an argument is present,
treat it as the `genomes_root` directory for the portfolio storage. Otherwise
default to the current working directory.

Invoke the portfolio listing by running the `listPortfolio` function from
`src/portfolio.ts` (e.g. via `npx tsx -e "import('./src/portfolio.js').then(m => console.log(JSON.stringify(m.listPortfolio($ARGUMENTS), null, 2)))"` or
the equivalent MCP tool when available).

Format the result as a table with these columns:

- genome_slug
- current_phase
- current_standard_slug
- last_touched_utc
- parked (yes / no — yes if parked_at_utc is non-null)
- next_natural_action

Read the table aloud to the user, then ask which slug they'd like to resume or
whether they want to voice a new in-flight thought.

If the portfolio is empty, report that and offer to bootstrap the first project
via `/coltrane-new`.
