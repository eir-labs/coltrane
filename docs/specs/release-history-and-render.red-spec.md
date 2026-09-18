# Release history & note rendering — RED spec

**Contract:** `contract-release-history-and-render-v1`
**Laws:** `tests/spec_release_history_and_render.test.ts`
**Callsite under contract:** `src/releases.ts` (exported through `src/index.ts` line 65, `export * from "./releases.js"`)
**Status:** RED by design — `compileReleases` ignores `pending`, and `releasesJson` / `renderReleaseNote` do not exist yet.

## Why this exists (the measured problem)

Two remaining pieces of the changelog tab on coltrane.eir.sh, per the operator's 2026-09-18 decision:

1. **The package cannot carry the release it is itself shipping.** `.github/workflows/publish.yml`
   computes the next version, stamps it, runs `npm run verify`, **publishes**, and **then** pushes the
   tag. At the moment the package is built, the release being shipped has **no tag yet**, and
   `compileReleases` (`src/releases.ts`) walks tags only — measured on this repo it compiles 75 records
   whose newest is `v0.24.31`, the release *before* the one a publish run would ship.
2. **The release-note registers are read by no runtime.** The `release-note` type (`release-notes-v0`,
   fields `headline` / `plain_md` / `formal_md` / `claims[{text,evidence,value}]` / `unreadable` —
   `domain_types/release-note.json`) is read by the seats that write and judge it and by **nothing in
   `src/`** (this moved the declared-field ratchet 218→224). The changelog needs those registers as
   markdown; the engine is where that belongs, so the UI imports the package rather than reimplementing
   the rendering.

## Verification method

Example-based, no property engine (the checkables are specific behaviours). The history laws build their
own fixture git repository with the `tests/spec_release_record.test.ts` house pattern (`git init` in a
tmp dir, pinned commit dates, lightweight tags) and call the compiler against it — **no law reads this
repository's own history, invokes a model, or reaches the network**. The render laws call the renderer
with a plain release-note object and a plain release-record object, both constructed in the test.

Every export the mechanism must add is reached **reflectively** off the `src/index.js` namespace (which
exists and compiles today) so the file COLLECTS; a not-yet-existing export leads with a contract-stating
`typeof === "function"` assertion, and the `pending` laws call the existing `compileReleases` and fail on
the behaviour it does not yet have. Each law therefore fails on the CONTRACT, never on an ESM link error.

## Obligations → mechanism → law

### O1 — a pending record for the version about to be published
`compileReleases({ tree_root, pending: { version } })` appends **one** further record for the commits
since the last tag, compiled exactly as a tagged release: `tag` is the v-prefixed pending version, `date`
is HEAD's commit date, `commits` is the range since the last tag, the law counts read HEAD against that
tag, and the surface diffs HEAD against it. The appended record carries `pending: true`; every tagged
record carries `pending: false`. Without `pending`, the result is unchanged.
- Law: *O1 — pending {version} appends one record for the commits since the last tag, marked pending*
- Law: *O1 — without a pending option the result is unchanged: only tagged records, each pending:false*

### O2 — a stable JSON document of the whole history
`releasesJson(options)` returns the same records as a JSON document, **newest first**, as
`{ generated_from: "compileReleases", releases: [...] }`, pretty-printed (2-space) with a single trailing
newline, byte-identical for the same inputs.
- Law: *O2 — releasesJson returns { generated_from, releases } newest first, the same records compileReleases returns*
- Law: *O2 — the document is pretty-printed with a trailing newline, and byte-identical for the same inputs*
- Law: *O2 — with a pending version the document leads with the pending release (still newest first)*

### O3 — markdown for one note, every field rendered, in order
`renderReleaseNote(note, record)` returns markdown carrying, in order: the headline as a heading, the
plain register, the formal register, then an evidence section listing each claim with the record path
behind it and the value read there. Every field the note declares is rendered — headline, plain_md,
formal_md, claims and unreadable — and the surfaces named in `unreadable` are **stated** as unreadable
rather than omitted.
- Law: *O3 — renders the headline as a heading, then the plain register, then the formal register, in order*
- Law: *O3 — the evidence section lists each claim with the record path behind it and the value read there*
- Law: *O3 — a surface the record marks unread is STATED as unreadable, never omitted*

## Invariants → law

### I1 — a pending record is the record that tag would have carried
Compile with `pending {version: "0.2.0"}`, then really tag `v0.2.0` and compile again: the two records
agree on commits, surface, laws, bump, version and date — only the `pending` flag differs (the fixture
gives them the same `tag`, `v0.2.0`).
- Law: *I1 — compile pending, then really cut the tag: the two records agree on all but the pending flag*

### I2 — the rendering is derived from the note, not decorated
No claim appears in the markdown that is not in the note. The checkable: a note whose claims name two
paths renders exactly those two evidence rows; dropping a claim drops its row, and the renderer does not
re-add the row from the record's own field.
- Law: *I2 — a note whose claims name two paths renders exactly those two evidence rows; dropping a claim drops its row*

## Failure modes → law

### F1 — a pending version that is already tagged
`compileReleases` throws, naming that version **and** the tag that holds it, rather than emitting two
records for one version.
- Law: *F1 — pending {version} that is already tagged throws, naming the version and the tag that holds it*

### F2 — a claim whose evidence does not hold
When a claim's `evidence` path does not resolve in the record, or resolves to a different value, the
rendered markdown marks that row **UNSUPPORTED**, naming what the record actually holds; it never renders
an unsupported claim as if it were evidenced, and never silently drops it. A claim whose value matches is
not marked.
- Law: *F2 — a claim whose path does not resolve, or resolves to a different value, is marked UNSUPPORTED naming what the record holds*

## Non-obvious choices (rationale)

- **`value` is compared as a string.** `release-note.json` documents `claim.value` as "the value read at
  that path" and types it `string`. The render laws therefore resolve the `evidence` path against the
  record, stringify, and compare to `claim.value` — the good F2 claim uses `bump` (`"minor"`) to avoid a
  number/string ambiguity, and the mismatch case uses `laws.after` (record holds `150`, claim says
  `999`) so the refusal can name `150`.
- **Evidence path syntax.** The type's own example is `surface.cli_flags.added[0]`, so the O3 law
  exercises a bracket index alongside plain dot paths (`laws.after`, `bump`); the builder's path
  resolver must accept both.
- **I2 tests derivation by subtraction.** Rather than asserting a brittle row-count against an unknown
  markdown format, it removes a claim and asserts its row (and its record path token) disappears — which
  holds whether or not the renderer also lists record surface changes elsewhere, so it does not
  over-constrain the format while still proving the evidence section follows the note.
- **The pending record uses the simplified control surface shapes.** The byte-faithful shapes are already
  law-bound and green in `tests/spec_release_surface_real_shapes.test.ts`; these laws reuse the simplified
  fixtures so they exercise the *history* behaviour (pending append, JSON document) without re-litigating
  surface parsing.

## Caveat — inputs

No grounding-dossier `method_findings` were supplied (this seat is a root agent). The verification method
(example-based, git-fixture + plain-object) was chosen from the contract's checkables and the acceptance
criteria, which explicitly call for a fixture git repository for the history laws and plain-object calls
for the render laws. The reconciliation of O3's `unreadable` rendering with the `release-note` type's
`unreadable` field is grounded in `domain_types/release-note.json` (read this run).
