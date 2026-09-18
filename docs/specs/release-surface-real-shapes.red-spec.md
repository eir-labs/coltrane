# Release surface — read the real declaration shapes, be loud about what you can't read

`contract-release-surface-real-shapes-v1` · RED spec · laws in
`tests/spec_release_surface_real_shapes.test.ts`

## The measured problem

The release-record compiler (`src/releases.ts`, built at `dd12c2c`) compiled all 75 releases of
this repository, and for `v0.24.31` it returned `mcp_tools: null`, `mcp_tool_args: null` and
`cli_flags: null` — three of the five surfaces, **silently**, on the release that in fact added a
`gig_dispatch` argument and two CLI flags. The compiler's own laws
(`tests/spec_release_record.test.ts`) pass because their fixtures use *simplified* declaration
shapes that no real module writes.

The real shapes, read at HEAD:

| surface | real declaration (verbatim) | why today's parser misses it |
| --- | --- | --- |
| MCP | `const TOOL_DEFS: readonly Omit<MCPToolDef, "description">[] = [ … ]` then `export const MCP_TOOLS: readonly MCPToolDef[] = TOOL_DEFS.map((t) => {` (`src/mcp.ts:44,420`) | `parseMcp` gates on `/export const MCP_TOOLS\s*=\s*\[/` (`src/releases.ts:92`) — the array is named `TOOL_DEFS` and `MCP_TOOLS` is a `.map()`, so the gate matches nothing → `null`. |
| CLI | flag lines under an `Options` heading inside a template literal `export const USAGE = \`…\`` (`src/cli.ts:51,91‑106`) — **no `HELP` constant** | `parseCli` gates on `/export const HELP\b/` (`src/releases.ts:110`) → `null`. |
| env | `export const WORKER_ENV_CONTRACT: readonly WorkerEnvVar[] = [ { name: "COLTRANE_…", … }, … ]` (`src/worker_env.ts:59`) | `parseEnv` gates on a **bare identifier match** `/WORKER_ENV_CONTRACT/` (`src/releases.ts:122`). It parses the real file, but a file that only *mentions* the identifier (a comment, a type) with no entry array reads as an empty set — and the diff then silently reports the whole predecessor env table as *removed*. |

A `null` that means "could not tell" is indistinguishable, in a rendered changelog, from a release
that changed no tools — the absence stands in for a value, which is the defect class this engine
refuses everywhere else.

## The contract, and where each obligation is met

The fix has two halves: the parsers must read the shapes the repository actually writes (and keep
reading the simplified ones the control fixtures use), and a surface that genuinely cannot be read
must be **named**, not nulled in silence.

The enforcement lives in `src/releases.ts` (out of scope for this red-spec — the builder writes it).
Every law builds its own temporary git repository whose surface files are copied **byte-for-byte**
from the real modules at HEAD; no law reads this repository's own history, invokes a model, or
reaches the network.

### O1 — the MCP surface is read from the tool-definition array whatever its name/annotation
- **Mechanism:** generalize the `parseMcp` gate so a typed array (`const TOOL_DEFS: readonly Omit<…>[] = [`)
  exported through a trailing `.map(…)` still yields slugs into `mcp_tools` and `<slug>.<arg>` into
  `mcp_tool_args`. Aligned whitespace and the type annotation must not stop it.
- **Callsite:** `parseMcp` / `src/releases.ts:90‑105`, reached through `compileReleases`.
- **Law:** `O1 — a typed TOOL_DEFS array exported through .map() yields the slugs and <slug>.<arg> args`.
  Byte-faithful `src/mcp.ts` (lines 44/45/46/58/420 copied verbatim); asserts `mcp_tools` and
  `mcp_tool_args` are non-null and carry `type_resolve`, `type_browse`, `agent_browse` and args such
  as `type_resolve.required_fields`, `type_browse.min_usage`, `agent_browse.primitive`. RED today:
  `mcp_tools` is `null`.

### O2 — the CLI surface is read from the flag lines, with no `HELP` constant required
- **Mechanism:** read a flag from any line whose first non-space characters are `--<name>`, inside
  `src/cli.ts`, with the `<placeholder>` stripped (`--effort <low|…>` → `--effort`). Do not require a
  `HELP` constant; the real block is `export const USAGE = \`…\``.
- **Callsite:** `parseCli` / `src/releases.ts:107‑116`.
- **Law:** `O2 — flag lines under an Options heading in USAGE read as their names, without placeholders`.
  Byte-faithful `src/cli.ts` (the `USAGE` template with `${COLTRANE_VERSION}`, two usage lines
  carrying mid-line `--check`/`--any`/`--residency`, the `Options` heading, and the flag lines).
  Asserts `--input`, `--depth`, `--effort`, `--budget`, `--help` are read and the mid-line
  `--check`/`--any`/`--residency` are **not** (they are not the first non-space characters of their
  line). RED today: `cli_flags` is `null`.

### O3 — env vars are read from the array ENTRIES, not the bare identifier
- **Mechanism:** read `{ name: "COLTRANE_…" }` entries out of the contract array declaration, so the
  identifier appearing only in a comment or a type does not count as "the table is present".
- **Callsite:** `parseEnv` / `src/releases.ts:118‑128`.
- **Laws:** `O3 — a file that only MENTIONS the contract does not silently erase the predecessor's env
  table` (a `worker_env.ts` mentioning `WORKER_ENV_CONTRACT` in a comment/type but declaring no entry
  array must **not** read as `{ added: [], removed: [both predecessor vars] }`, and must be named in
  `surface_unread`; RED today — it reads as the whole table removed). Plus `O3 — a real
  WORKER_ENV_CONTRACT array with entries still reads its names (the presence half)`, guarding that the
  normal case keeps parsing across the change.
- **Non-obvious choice (recorded):** O3's statement says such a file "reads as empty rather than as
  the previous release's list," while F1 says a present-but-unreadable surface is `null` + named in
  `surface_unread`. These are reconciled by treating the mention-only / no-entries case as
  **unread** (the loud F1 refusal), not as a silent empty diff — an empty `{added:[],removed:[]}`
  would itself be the kind of silence ("nothing changed") the engine condemns. The O3 law therefore
  asserts only the point both readings share: it must **not** render the predecessor's list as
  removed, and it must be named unread. This choice is stated here rather than invented in the test.

### I1 — both shapes parse (control stays green)
- **Law:** `I1 — the control's simplified fixtures AND the byte-faithful ones each yield a non-null
  surface`. One repo with the simplified shapes (`export const MCP_TOOLS = [`, `export const HELP`)
  and one with the byte-faithful shapes; each must yield non-null `mcp_tools`/`cli_flags` with the
  slugs and flags it declares. RED today on the byte-faithful half. This is the
  `tests/spec_release_record.test.ts` control's guarantee: the parsers must accept **both**.

### I2 — a real-shaped change reports the change, not null
- **Law:** `I2 — one tool arg and one CLI flag added across two byte-faithful tags read as .added`.
  Two tags over byte-faithful files where `agent_browse` gains a `primitive` argument and the CLI
  gains `--effort`; asserts `mcp_tool_args.added` names `agent_browse.primitive` and
  `cli_flags.added` names `--effort`. RED today: both surfaces are `null`, so a real change reads as
  "unknown."

### F1 — a present-but-unreadable surface is NAMED, not silently null
- **Mechanism:** add a `surface_unread: string[]` field to `ReleaseRecord`, populated with the
  surface keys that were present at the tag but yielded no entry, so a changelog can say "could not
  read the tool registry here" instead of showing a silent gap.
- **Callsite:** the record assembly in `compileReleases` / `src/releases.ts:242‑265`.
- **Laws:** `F1 — every record carries a surface_unread list; a fully-read record names nothing`
  (asserts the field is an array and empty when every surface parsed) and `F1 — a present-but-garbled
  src/mcp.ts nulls its lists AND names them in surface_unread` (asserts `surface_unread` contains
  `mcp_tools` and `mcp_tool_args`, and not `cli_flags`). RED today: the field does not exist.

## Testing method

Example-based, over real git fixture repositories. Each law creates a fresh temp repo with
`git init`, writes the surface files, commits at pinned dates and tags, then calls the real
`compileReleases({ tree_root })` reached reflectively off the `src/index.js` namespace (the same house
pattern as `tests/spec_release_record.test.ts` and `tests/spec_records_by_address.test.ts`). No
property-based engine is added: every obligation here is a *specific behaviour* over a *specific
declaration shape* — the defect is precisely that a general-looking parser missed the concrete real
shapes — so the fidelity that matters is byte-faithfulness of the fixture to the real module, not
input-space coverage. The grounding-dossier was not supplied to this root agent (see caveat); the
method is chosen from the contract's checkables, which are all example-shaped.

## Observed red (run this drafting)

`npx vitest run tests/spec_release_surface_real_shapes.test.ts` → **8 failed / 8**, each on the
contract-stating assertion:

- O1 → `mcp_tools is null on the REAL src/mcp.ts shape …: expected null not to be null`
- O2 → `cli_flags is null on the REAL src/cli.ts shape …: expected null not to be null`
- O3 (mention-only) → `… must not read as the predecessor's whole env table removed: expected
  { added: [], removed: […] } to not deeply equal { added: [], removed: […] }`
- O3 (presence half) → `a fully-read record reports an empty surface_unread: expected undefined to
  deeply equal []`
- I1 → `the real TOOL_DEFS/.map shape must ALSO parse …: expected null not to be null`
- I2 → `mcp_tool_args must be non-null to report the added argument: expected null not to be null`
- F1 (fully-read) → `every record carries a surface_unread array: expected false to be true`
- F1 (garbled) → `… must be NAMED in surface_unread …: expected undefined to deeply equal
  ArrayContaining ["mcp_tools", "mcp_tool_args"]`

Controls stay green in the same run: `tests/spec_release_record.test.ts`,
`tests/exported_symbols_are_reachable.test.ts`, `tests/declared_fields_are_read.test.ts` — 32 passed.

## Caveat

This gig reached the drafter as a root agent with **no grounding-dossier** among its inputs, so no
`method_findings` fixed the verification approach; the example-based-over-git-fixtures method is
derived from the contract's checkables and the house pattern of the existing control test, and is
recorded as such rather than cited. Every declaration-shape fact above is grounded in a Read of the
named file and line at HEAD during this run.
