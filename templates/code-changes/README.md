# Code changes template

This template walks a code change through four phases so the work converges
honestly: scope the change, name it, write it, ship it.

## What you get

Four phase-agents already wired for code work, plus one domain agent that
reviews the diff before it leaves your machine.

- **Explorer** — reads the repository, the existing tests, and the issue
  tracker. Reports what the relevant code looks like today and what neighbouring
  areas the change would touch. Does not pick the fix.
- **Definer** — names the change in one falsifiable sentence: what the diff
  must produce, what would prove the diff is wrong, and what the change is
  explicitly not.
- **Developer** — writes the diff against the definition. Runs the tests.
  Records the output verbatim, including failures.
- **Finalizer** — runs the code-reviewer agent, traces the diff against the
  definition, and opens the pull request only if the criteria hold.

## How to use it

From the repository root:

```
/code-flow add retry-on-timeout to the http client
```

The slash command dispatches the `code-change-protocol` standard, which chains
the four agents in order and stops at any phase whose output does not meet the
seal.

## What this template is not

This is not a code generator. It will not write a full feature from a vague
description. The Definer will refuse a brief that does not yield a falsifiable
diff-target, and the run will return to Explorer for a wider survey.

## The review bar

Before the Finalizer opens a pull request, the `code-reviewer` agent scores
the diff against `code-review-minimum-bar.json`: lint, types, tests, naming,
secrets, scope. A score of zero on any criterion blocks the pull request and
returns the run to the Developer.
