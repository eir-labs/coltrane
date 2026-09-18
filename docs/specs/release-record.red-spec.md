# Red-spec: the release record, compiled from git

**Contract:** `contract-release-record-v1`
**Laws:** `tests/spec_release_record.test.ts` (12 laws, RED)
**Enforcement (not built here):** a new `src/releases.ts`, exporting `compileReleases`, re-exported from `src/index.ts`.

## Why this exists

`.github/workflows/publish.yml` cuts a release on every push to `main` and derives the version from
conventional-commit prefixes (`scripts/next_version.mjs`: `feat` → minor, `!:`/`BREAKING-CHANGE` →
major, else patch). Measured across `v0.24.20..v0.24.31`: **0 of 11 commit subjects carry any such
prefix**, so all 75 tags are patches — including `v0.24.31`, which shipped a domain-type version bump,
two CLI flags, a `gig_dispatch` argument and three refusal kinds. A changelog grouped by the bump
would render one flat list, and the bump cannot be trusted to say what changed.

The repo can answer the question **mechanically** instead. Every surface an integrator sees is *data
readable at any tag* with `git show <tag>:<path>`:

| surface | source (real callsite) | read as |
| --- | --- | --- |
| `mcp_tools` | `MCP_TOOLS` in `src/mcp.ts` (`src/mcp.ts:420`) | the tool slugs |
| `mcp_tool_args` | each tool's `input_schema` properties | `"<slug>.<argument>"` |
| `cli_flags` | the help block in `src/cli.ts` (`src/cli.ts:73`+) | the long `--flags` |
| `env_vars` | `WORKER_ENV_CONTRACT` in `src/worker_env.ts` (`src/worker_env.ts:59`) | the variable `name`s |
| `domain_types` | each `domain_types/*.json`'s `slug`+`version` | `"<slug>@<version>"` |
| `laws` | `EXPECTED_LAWS`/`EXPECTED_FILES` in `scripts/laws.sh` (`scripts/laws.sh:28,34`) | the pinned counts |

A release's surface diff is therefore **derivable, not a claim**.

## What the compiler must do

`compileReleases({ tree_root })` returns a `ReleaseRecord[]`, **oldest first**, one per `v*` tag:

```
{ version, tag, date, commits: [{ sha, subject }], bump, laws: { before, after, files }, surface }
```

### Obligations

- **O1** — one record per `v*` tag, oldest first. `version` is the semver, `tag` the ref (they are
  distinct fields; `version` is `tag` without its `v`). `date` is the tag's commit date, ISO.
  `commits` is the range **since the previous tag**, oldest first; the earliest tag's range is every
  commit up to it, and its `laws.before` is **`null`, never `0`** (there is no predecessor count, and
  `0` would falsely claim an empty suite the day before). `bump` is derived exactly the
  `scripts/next_version.mjs` way. `laws.after`/`laws.files` are read from `scripts/laws.sh` at the tag;
  `laws.before` is the predecessor's `after`.
  *Mechanism:* enumerate `v*` tags by commit date; for each, `git show <tag>:scripts/laws.sh` for the
  counts, `git log <prev>..<tag>` for the range. *Verified by:* the three `O1 —` laws.
- **O2** — `surface` names five keys (`mcp_tools`, `mcp_tool_args`, `cli_flags`, `env_vars`,
  `domain_types`), each an `{ added, removed }` of **plain strings, both sorted**. A domain-type
  version bump reads as one `removed` (`slug@old`) and one `added` (`slug@new`).
  *Verified by:* the `O2 —` law (exact deltas `v0.1.0 → v0.2.0`, plus the sorted/plain-string shape).
- **O3** — every field is read **at that tag** (`git show <tag>:<path>`), never from the working
  tree, so a record compiled today equals the record compiled the day the tag was cut.
  *Verified by:* the `O3 —` law — it mutates the working tree with an uncommitted "smuggled" surface
  and asserts the already-cut tag's record is byte-for-byte unchanged.

### Invariants

- **I1** — compiling twice is deeply equal, and a tag's record does not change when a later tag is
  added. *Verified by:* the `I1 —` law (compile ×2, add a third tag, first two records unchanged).
- **I2** — a release that changed nothing an integrator can see says so **explicitly**: every surface
  list is present and empty (`{ added: [], removed: [] }`), and the record is still returned.
  *Verified by:* the `I2 —` law (a comment-only commit).
- **I3** — the bump is **derived**, not read back from the version numbers. *Verified by:* the `I3 —`
  law — three consecutive patch-*named* tags whose ranges carry `chore`/`feat:`/`BREAKING-CHANGE:`
  report `patch`/`minor`/`major` respectively.

### Failure modes

- **F1** — a surface file **absent** at a tag (an older release predating it) or **unparseable** has
  its list set to `null` for that release — distinguishable from `[]` ("present and nothing changed")
  — and the rest of the record still compiles. *Verified by:* the two `F1 —` laws (an absent
  `src/worker_env.ts`; a garbled `src/mcp.ts`).
- **F2** — a `tree_root` that is not a git repository, or holds no `v*` tag, **throws** naming which of
  the two — it never returns `[]` as if the project had no releases. *Verified by:* the two `F2 —`
  laws.

## Testing method

Example-based laws over **real git fixture repositories**, each built in a fresh temp directory
(`mkdtemp` + `git init`) with two or three tags over files shaped like `src/mcp.ts`, `src/cli.ts`,
`src/worker_env.ts`, `domain_types/*.json` and `scripts/laws.sh`, then `compileReleases` is called
against the fixture root. Commit dates are pinned so ordering and the `date` field are deterministic.
The checkables are specific behaviours (an exact delta, a null-vs-empty distinction, a named refusal),
which is why they are example-based rather than property-based — a universal-property engine would add
a dependency without sharpening a single one of these assertions. **No law reads the coltrane repo's
own history, invokes a model, or reaches the network.**

> Note: this seat is a root agent with no grounding-dossier upstream, so no `method_findings` fixed the
> method; the example-based-over-git-fixtures choice follows directly from the contract's checkables and
> the acceptance criteria (which require fixture repos), and is recorded here as that rationale.

## Why the laws are RED today

`src/releases.ts` is unwritten and `src/index.ts` re-exports nothing named `compileReleases`. Each law
reaches the compiler **reflectively** off the `src/index.js` namespace (which exists and compiles
today) and **leads** with `expect(typeof compileReleases).toBe("function")`, stating the contract's
reason. So the file collects cleanly (no ESM link error, no `tsc` break) and every law fails on the
contract, not on an incidental `TypeError`. Observed: all 12 fail on that leading assertion
(`expected 'undefined' to be 'function'`); the three named controls
(`exported_symbols_are_reachable`, `declared_fields_are_read`, `version_identity`) stay green. When the
builder adds the compiler, each law's downstream assertions verify the real contract against the real
`git show`-based callsite.
