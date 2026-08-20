# SPEC — `coltrane work --check`: a surface for the drain-environment preflight

Status: RED spec (laws written; enforcement not yet built)
Change: add a `--check` flag to the `work` command in `src/cli.ts`
Laws: `tests/cli_work_check.test.ts`
Upstream: bill `bill-change-plan-work-check-flag`, miles `miles-change-decision-work-check-flag`

## Why this exists

`coltrane work` claims a queued gig from an org store and runs it. When the box's drain
environment is wrong, the failure surfaces late, deep, and disguised — a missing
`COLTRANE_DRAIN_URL` reads as an authorization problem three layers down. An operator standing up
a new box needs to ask *"is this box ready to drain?"* and get an answer **before** spending a gig
to find out.

`src/drain_preflight.ts` already answers that question. `drainPreflight(env)` is a PURE collector
over the drain's five-variable environment contract — it returns `{ present, missing, suspicious }`
and reuses `normalizeWorkerEnv` so it cannot drift from what the worker itself reads
(`src/drain_preflight.ts:85`, `:109`). **Nothing calls it.** This change gives it a CLI surface; it
does not change what it detects.

## The obligation, and where it is discharged

The `--check` branch lives inside the existing `work` branch of `runCli`
(`src/cli.ts:209`), placed **before** the credential derivation and the `workOnce` call
(`src/cli.ts:217`, `:226`). When `parseArgs` reports `flags.check === true`:

| # | Obligation | Mechanism / callsite | Red law |
|---|------------|----------------------|---------|
| READY | A satisfied environment exits **0** and the report names each required variable as **present**. | Call `drainPreflight(process.env)`; render each `present[]` entry by name via the `line()` helper (`src/cli.ts:179`, → `io.err`); return `0` when `missing.length === 0 && suspicious.length === 0`. | `work --check READY …` |
| MISSING | An absent required variable exits **1** and is named specifically. | Render each `missing[]` entry by its `variable` name to `io.err`; the non-empty `missing[]` forces the `else` return `1`. | `work --check MISSING …` |
| CONFLATION | `COLTRANE_DRAIN_URL` host equal to `COLTRANE_STORE_URL` host exits **1** and the conflation is surfaced, not silently collected — including the legacy `/rest/v1` suffix variant `normalizeWorkerEnv` strips. | Render each `suspicious[]` entry's `variable` and `message` (`src/drain_preflight.ts:113-119`) to `io.err`; non-empty `suspicious[]` returns `1`. | `work --check CONFLATION …` (two laws) |
| NO-SECRET | A report **is** produced and echoes no environment-variable VALUE. | Render only variable NAMES and presence/suspicion CLASSES — never `env[name]`. `drainPreflight` already carries no secret in its result (`src/drain_preflight.ts:19-22`, `:96-100`); the renderer must preserve that by printing names, not values. | `work --check NO-SECRET …` (two laws) |
| NO-CLAIM | `--check` claims nothing, runs nothing, touches no store. | The branch `return`s the readiness code **before** the `workOnce` call site (`src/cli.ts:226`), so no claim, lease, or store contact occurs. | `work --check NO-CLAIM …` |
| PIN | `coltrane work` with no flags behaves exactly as today. | The `--check` block is entered only when `flags.check === true`; a flagless run skips it and reaches the unchanged credential check and `workOnce` wiring. | `work PIN …` (two laws) |
| REACHABLE | The command ships in the published package. | `bin.coltrane` → `./dist/src/cli_entry.js` and `files` ships `dist/src` (`package.json:28`, `:57`); `cli_entry.ts` delegates to `runCli` (`src/cli_entry.ts:7`, `:18`). No `package.json` edit is required. | `work --check REACHABLE …` |

The `USAGE` string (`src/cli.ts:42-85`) gains a one-line note that `work --check` reports
drain-environment readiness and exits without claiming — house wording matching the adjacent
entries.

## Settled decisions (from miles)

- **Output channel: `io.err` (stderr).** A preflight report is diagnostic status, not
  machine-consumable data; the suite enforces stdout-is-data / stderr-is-status.
- **Exit cardinality: two codes, `0` ready / `1` unready.** Both missing-var and conflation are
  "unready"; the specific reason is surfaced in the rendered report, so a third numeric code adds
  no distinction the operator needs.
- **Suspicious ⇒ exit 1.** A `COLTRANE_DRAIN_URL` aimed at the `COLTRANE_STORE_URL` host sends
  write traffic to the read endpoint; reporting it ready would let an operator proceed on false
  assurance — the exact late-and-disguised failure `--check` exists to prevent.
- **A flag on `work`, not a new `coltrane check` command.** The question is specifically
  "is this box ready to run work?"; a top-level command implies general health, already served by
  `coltrane health`. `--check` is parsed by `parseArgs`; `KNOWN` is unchanged.

## Out of scope

`drainPreflight` internals, `src/worker.ts`, the claim/lease/drain paths, `package.json`, and
`src/cli_entry.ts` are **not** touched — the collector stays the single source of the drain
contract, and this change only gives it a door.

## RED state

Before the branch exists, `work --check` is an unrecognized flag that falls through to the
credential/claim path — so no presence report reaches `io.err`, the readiness exit codes are never
returned, and the `workOnce` double IS invoked. The six `--check` laws fail on exactly those facts;
PIN and REACHABLE are green before and after, guarding the flagless path and the published surface.
