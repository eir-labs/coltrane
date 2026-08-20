# Red-spec — a fetch claim carries its evidence

**Gig:** c259622c-1b68-402c-9706-9dee894323bf · **Phase:** draft-laws · **Base branch:** `genome/a-fetch-claim-carries-its-evidence`

A grade that CLAIMS a fetch must be unrepresentable without the evidence of that fetch. Three sites,
one shape: each declares a claim about the world and each currently lets the claim stand with nothing
behind it — the comment says A, the schema admits B. These laws close the gap at the layer where the
shape is enforced, so the illegal state is unrepresentable for **every** caller, not only the rows one
existing test loops over.

This document is the spec. The enforcement it demands does **not** exist yet: the RED tests below fail
against the unmodified tree, and that failure is the specification. The create-change seat makes them
GREEN. RED-first was observed before any `src` change (see *Observed RED* per law).

## Files this spec adds (this seat)

- `tests/a_fetch_claim_carries_its_evidence.test.ts` — the four enforcement laws (RED) + five positive
  scope-guards (green now, must stay green so the enforcement cannot over-reach).
- `tests/suite_reaches_no_remote.test.ts` — the standing no-network guard (green from the outset).
- `docs/specs/a_fetch_claim_carries_its_evidence.md` — this document.

The engine already carries `fast-check` (`^3.23.2`, devDependencies), so the property law adds no new
dependency.

## Files the enforcement (create-change seat) must touch

`src/genome_schema.ts`, `domain_types/prior-art-hit.json`, `src/registry.ts` (see Site 2 finding),
`src/server.ts`, `src/mcp.ts`, `tests/fixtures/citation_dereference_snapshot.json` (operator-seeded),
`scripts/refresh_citation_snapshot.ts` (operator refresh, CI never runs it), and — see the
**cross-file consequence** — `tests/institution_law_attribution.test.ts`.

---

## Site 1 — `CitationSchema`: an archive grade is a claim about a fetch that happened

**Callsite:** `src/genome_schema.ts:296-316`. `CitationSchema` is a strict object with a `.refine`
requiring a resolvable identifier. `evidence_grade: z.enum(["archive","attestation"])` and
`retrieved_at: z.string().optional()` — the doc comment says ARCHIVE means "the primary was fetched,
and `retrieved_at` says when," but nothing ties the timestamp to the grade or bounds its value.

**Obligation (INV-1, INV-2):** add a `.superRefine` to the existing strict schema (leaving the
`doi ?? url` `.refine` intact and attestation unconstrained) issuing:
1. one issue when `evidence_grade === "archive"` and `retrieved_at` is absent, and
2. a second when `retrieved_at` parses to a `Date` strictly after the parse-time clock.

Scope-to-archive is deliberate: an attestation citation claims no fetch and carries no timestamp. A
`.superRefine` closes the illegal state for every `CitationSchema` caller at once — a call-site guard
would leave future callers unprotected (change-decision rejected-alternative 1); an unconditional
`retrieved_at` would break valid attestation rows (rejected-alternative 2).

**Red tests:** `INV-1 REJECTS an archive citation with NO retrieved_at`,
`INV-2 REJECTS an archive citation whose retrieved_at is in the future`,
`INV-2 (property) REJECTS ... for EVERY retrieved_at strictly after now`.
**Scope guards (stay green):** `ACCEPTS an archive citation with a safely-past retrieved_at`,
`ACCEPTS an attestation citation with NO retrieved_at`.

**Observed RED:** all three rejection assertions failed (`safeParse` returned `success:true`); both
guards passed.

**⚠ Cross-file consequence (MANDATORY, not in the change-plan's `files_touched`).**
`tests/institution_law_attribution.test.ts:35-43` defines its `crawfordOstrom` fixture as
`evidence_grade:"archive"` with **no** `retrieved_at`, and asserts `CitationSchema.parse(...)`
succeeds at line 46 and again at line 63 (via the doi-stripped `rest`). Once the `.superRefine` lands,
those two assertions begin to THROW, so the file drops below its 14 passing and the stop condition
breaks. The create-change seat MUST add a safely-past `retrieved_at` (e.g. `"2020-01-01"`) to that
fixture. This is the exact "spec claims A while the system does B" hole this seat exists to surface: a
schema change with an undocumented downstream break.

## Site 2 — `prior-art-hit`: `verified:true` requires `verification_method`, at the real callsite

**Callsite:** `domain_types/prior-art-hit.json` declares `verified:boolean` and
`verification_method:enum[fetch,snippet]`, with `required_fields` only `["source","title"]` — so a hit
may claim `verified:true` with no method. The shape is enforced through `registry.validate`
(`src/registry.ts:330-372`), the path `outputs.write` runs on every seal.

**Obligation (INV-3):** `verified === true` must require `verification_method`.

**⚠ Finding — the JSON change alone is a silent no-op.** `registry.validate` does not compile the
authored schema. It calls `effective(dt)` (`src/registry.ts:276-293`), which **reconstructs** a fresh
schema object carrying only `{type, properties, required, additionalProperties}` and hands *that* to
`ajv.compile` (`src/registry.ts:371-372`, the single `ajv.compile` in `src/`). Any top-level
conditional keyword added to the JSON — `if/then`, `allOf`, `dependentRequired`, `dependentSchemas` —
is **dropped** by `effective()` and never reaches Ajv. So closing Site 2 requires **two** mechanisms:
1. add the conditional to `domain_types/prior-art-hit.json`, and
2. thread that conditional through `effective()` so the compiled schema actually carries it.

Because the registry validator is `new Ajv({ allErrors:true, strict:false })` (default draft-07, not
`Ajv2019`/`Ajv2020`), `dependentRequired` is **not** available; use the draft-07 form
`if:{properties:{verified:{const:true}}, required:["verified"]}, then:{required:["verification_method"]}`
(or an equivalent `allOf`). This resolves the change-plan's "confirm the supported draft" step: it is
draft-07, so the `if/then` form is the correct one.

The law is written against `registry.validate` (the real enforcement path), not a fresh Ajv over the
raw JSON — validating the raw file would prove nothing about what the seal enforces
(change-decision rejected-alternative 4: test-level/adjacent enforcement leaves the real consumers
unprotected).

**Red test:** `INV-3 REJECTS a hit that claims verified:true with NO verification_method`.
**Scope guards (stay green):** `ACCEPTS a verified:true hit that names its verification_method`,
`ACCEPTS a hit that makes no verified claim at all`.

**Observed RED:** `registry.validate` returned `valid:true` for `{source,title,verified:true}`; both
guards passed. The existing `prior-art-hit` shape test and the two e2e fixtures
(`{...,verified:true,verification_method:"fetch"}`) remain satisfied by the guarded form.

## Site 3 — `output_write` validate-mode names what it is: VALIDATED, not SEALED

**Callsite:** `src/server.ts:682-693`. In `validate` mode the success response is
`{ ok:true, requires_approval, data:{ validated:true, validation_result:{valid:true} } }` — no field
names what did **not** happen. A truthful compose chair (gig `fbda9ffe-…`) read `validated` as
`sealed` and filed a false completion; the runtime had rejected the seal.

**Obligation (INV-4):** the validate-mode success response carries an explicit `sealed:false`
(`ok:true` stays — validation genuinely succeeded), and the tool's declared `output_schema` in
`src/mcp.ts:198` (currently `output_id, primitive, output, validation_result, validated`) advertises
`sealed` so the returned field is discoverable rather than folklore. The seal-mode branch
(`src/server.ts:695-721`) is byte-for-byte unchanged.

**Red tests:** `INV-4 the validate-mode success response carries an explicit sealed:false`,
`INV-4 the output_write output_schema ADVERTISES the sealed field`.

**Observed RED:** `r.data.sealed` was `undefined` (asserted `=== false`); the declared `output_schema`
did not contain `sealed`.

## Snapshot — every archive claim resolves in a committed, offline dereference record

**Obligation (INV-5):** a committed snapshot `tests/fixtures/citation_dereference_snapshot.json`
records one real dereference per archive-grade `GENOME_ATTRIBUTIONS` identifier. The law (offline —
reads the fixture + `GENOME_ATTRIBUTIONS` in-process, no network) asserts every archive identifier
resolves in the snapshot and is `reachable:true`; where the `route` is `crossref`, the snapshot's
`authors`/`year`/`title` MATCH the record; and `BookingSchema`'s citation `url` is the fetchable GASB
PDF `https://storage.gasb.org/GASBS%2054.pdf` (200, application/pdf, 577708 bytes per the operator
dereference), not the 403 marketing summary at `www.gasb.org/page/document?...`.

**Snapshot record shape** (consumed by the law): `{ identifier, route:"crossref"|"direct", reachable,
authors?, year?, title? }`, `identifier` = the citation's `doi ?? url`. The eight archive identifiers
and routes:

| subject | identifier | route |
|---|---|---|
| InstitutionalLawSchema | doi:10.2307/2082975 | crossref |
| DeonticSchema | doi:10.1093/mind/LX.237.1 | crossref |
| InstitutionSchema | https://archive.org/details/conceptoflaw0000hart | direct |
| InstitutionalChairSchema | https://archive.org/details/moralityoflaw0000full | direct |
| InstitutionalChairSchema.caps | doi:10.1017/CBO9780511808678 | crossref |
| NormPairSchema | doi:10.1023/A:1004748624537 | crossref |
| BookingSchema | https://storage.gasb.org/GASBS%2054.pdf | direct |
| applyCommitmentOp | doi:10.1109/MC.2009.347 | crossref |

**Population is an operator act, not this seat's and not CI's.** This seat writes the LAW; the
create-change/operator seat seeds the fixture (from the operator-supplied dereference in the gig
input) and corrects the `BookingSchema.url`, and commits `scripts/refresh_citation_snapshot.ts` — the
single place a network call is permitted, iterating identifiers by route (crossref for doi, direct GET
for url) and rewriting the fixture. It is under `scripts/`, which the root vitest `include`
(`tests/**/*.test.ts`) does not match, so CI never runs it and the no-remote guard stays green.

The Singh/Chopra/Desai row (doi:10.1109/MC.2009.347) stays `archive`: crossref returns
`Singh; Chopra; Desai, 2009, "Commitment-Based Service-Oriented Architecture", Computer`, matching the
record. One blocked retrieval route (IEEE Xplore bot-block) is not an evidence failure; downgrading
would destroy true information (non-goal held). `BookingSchema` is a precision correction (wrong URL →
fetchable URL), not a re-grade — the grade stays `archive` (non-goal held).

**Red tests:** `INV-5 every archive-grade identifier resolves in the snapshot and is marked
reachable`, `INV-5 where the route is crossref, snapshot authors/year/title MATCH the record`,
`INV-5 BookingSchema's citation url is the fetchable GASB PDF`.
**Scope guard (stay green):** `INV-5 there is at least one archive-grade citation to hold to account`
(the fixture is not vacuous).

**Observed RED:** the fixture does not exist (`ENOENT`) and `BookingSchema.url` is still the summary
page.

**Caveat (carried from change-plan tradeoff 3):** the gig input fully enumerates only three crossref
records (Crawford&Ostrom 1995, Makinson&van der Torre 2000, Singh/Chopra/Desai 2009) plus the GASB
PDF; the remaining rows are stated to "resolve directly" and are operator-confirmed. The crossref
match law therefore compares the snapshot to the in-tree record, and the refresh script is the
mechanism that re-derives the snapshot from a live fetch. No field is invented by this seat.

## The standing no-remote guard

`tests/suite_reaches_no_remote.test.ts` is **not** a RED-first law — it is green from the outset and
must stay green through every edit. It scans the exact file set the root vitest config runs
(`tests/**/*.test.ts` minus the config's excludes: `e2e/`, `security/`, `honest_broker/`,
`spec_venue_room_live.test.ts`) for network **call sites** (`fetch(`, `http(s).get/request(`,
`net.connect/createConnection(`, `new WebSocket(`) and network module imports (`node:http(s)`, `net`,
`tls`, `dgram`, `undici`, `axios`, `node-fetch`, `got`, `superagent`). It strips block comments, line
comments, and string/template literals **before** the call-site scan, so a primitive named in prose
("a skill could exfiltrate it with a single fetch", `tests/skill_sandbox_confinement.test.ts`) or
embedded as data (a skill body handed to the sandbox, the enum value `"fetch"`) is not mistaken for
the suite reaching a remote — green for the right reason, not by luck.

**Observed:** green (3 tests) against the current tree; must stay green after the enforcement lands.

## Coverage

Every contract invariant has at least one real, running RED test (INV-6 is the standing guard, green
by design — its property already holds and RED would mean the suite reaches the network). `uncovered`
is empty. See the sealed red-spec's `coverage_map`.

## Stop condition

The four laws are RED for the right reason before any `src` change (observed above), then GREEN after.
`tests/institution_law_attribution.test.ts` stays at 14 passing (given the mandatory `crawfordOstrom`
fixture edit) and `tests/suite_reaches_no_remote.test.ts` stays green. `CitationSchema.safeParse` for
an archive citation with no `retrieved_at`, and one dated in the future, both return `success:false`.
Full suite at or above the 2848-across-267 baseline.
