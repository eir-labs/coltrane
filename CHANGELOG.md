# Changelog

Coltrane follows semver with 0.x conventions: while the major is `0`, a **minor** bump
signals a breaking change and a **patch** signals an additive or internal one.

`COLTRANE_VERSION` (`src/version.ts`) is the single source of truth in code and must equal
`package.json`'s `version` — `tests/version_identity.test.ts` enforces that, and also that
the MCP handshake reports the constant rather than a hardcoded literal.

## 0.10.0

### Changed — breaking

- **`COLTRANE_DRAIN_URL` now names the Coltrane SERVICE, not the database.** A drain holds exactly
  one credential: its issued, org-scoped `cdk_` key. That key is an *application* credential,
  resolved inside a `SECURITY DEFINER` function — Supabase has never heard of it. So the box cannot
  address the project directly, and every attempt to make it ends by putting a SECOND credential on
  an unattended machine.

  All three remote writes now go to the app as a plain bearer, and the app holds the privileged
  halves:

  | | |
  |---|---|
  | `POST ${origin}/rest/v1/coltrane_outputs` | the sealed output rows |
  | `POST ${origin}/rest/v1/coltrane_gigs` | the run's own header |
  | `POST ${origin}/storage/v1/object/<bucket>/<gig>/<sha>.json` | the payload artifact |

  **`COLTRANE_STORE_ANON` is no longer read by the write path.** It remains required for the CLAIM
  path (`src/cli.ts`), which still reaches PostgREST directly — a remaining inconsistency, not a
  design.

  A `COLTRANE_DRAIN_URL` pointing at a `*.supabase.co` host now throws with that explanation before
  the first request, rather than half-working. The legacy `<host>/rest/v1` form is tolerated:
  every path is built from the ORIGIN, so a suffix surviving a redeploy cannot produce
  `/rest/v1/storage/v1/…` the way appending to it did.

### Added

- **Every drain write now names the instance it comes from**, as `X-Coltrane-Instance`, taken from
  `COLTRANE_INSTANCE` and omitted when that is unset (a local `coltrane work` run holds no lease and
  should not claim one).

  This is groundwork the store does not yet use. Today the output sinks resolve a token hash and
  check a scope, and stop — so any live drain key can write outputs for **any gig of its org**,
  including gigs it never claimed. `coltrane_drain_repo_for_lease` already checks key + instance +
  live lease, so the store knows how; the write path never asked. Shipping the header ahead of the
  gate means the gate needs no second engine release.

### Fixed

- **The artifact upload has never once succeeded.** It POSTed to
  `<project>/rest/v1/storage/v1/object/…` — a doubled path, at the wrong host, carrying a `cdk_` key
  in an `apikey` header. Three independent faults in one request, answering 401 continuously while
  the row half quietly succeeded. The only symptom was a missing blob, which reads like a Storage
  permissions problem.

  0.9.4 made this worse and looked like a fix: it diagnosed the 401 as a wrong *shape* and moved the
  row writes onto `/rest/v1/rpc/<definer fn>` with the project's anon key. That bought a passing
  row-write by routing around the service seam and adding the second credential. The shape was never
  wrong — the host was, and the app had served both paths correctly the whole time.

### Tests

- `tests/drain_writes_to_the_service.test.ts` — new. Pins the property a URL assertion cannot: one
  credential, as a bearer, to a service that is not the database. Includes the artifact-beside-REST
  law, mutation-verified against the exact suffix bug.
- `tests/gig_header_drain.test.ts` — this law had pinned the wrong thing twice, in opposite
  directions, passing both times by mocking `fetch` and checking a URL. Rewritten to assert the
  credential posture, and its fixture now WITHHOLDS `COLTRANE_STORE_ANON` so a write path that
  starts needing it again fails here.

## 0.9.4

### Fixed

- **The drain can record what it ran.** `COLTRANE_DRAIN_URL` carries two contracts: provisioning
  sets it to `<project>/rest/v1`, and `venue-provision.sh` consumes it as `${base}/rpc/<fn>`.
  0.9.1's write-back appended `/rest/v1/rpc/` to the same value, producing `/rest/v1/rest/v1/rpc/…`
  and `PGRST125 Invalid path specified in request URL` — after a gig had claimed, run, called the
  model and sealed an output. The work was done and could not be recorded. Both shapes are now
  accepted, because a variable whose meaning depends on its reader drifts again the moment a third
  caller appears.

## 0.9.3

### Fixed

- **`acting_for` on the surface that is actually served.** 0.9.2 added it to `hosted_tools.ts`, but
  the hosted endpoint mounts `tool_surface` — `MCP_TOOLS` from `src/mcp.ts`. Different surface,
  different tool. A client had nothing to send, and the store kept answering "no acting_for was
  named", which reads exactly like a stale client cache. Now advertised in `mcp.ts`, read in
  `server.ts`'s case block, and forwarded as `p_acting_for` by `postgrestQueueGig`.

## 0.9.2

### Added

- **`dispatch_gig` can name the player whose authority the work carries.** The store learned this in
  `eir-labs/coltrane-ui#31`; the tool had no field for it. The first gig dispatched through this
  tool was claimed by the drain and failed at `genome load (agent token): agent eugene holds no seat
  in this organization` — `acting_for` defaulted to the human who dispatched, and the genome read is
  gated on seating, so the gig was unrunnable from the moment it was created. `acting_for` now rides
  through to `p_acting_for`; the store enforces that it names a SEATED member.

## 0.9.1

### Fixed

- **Results reach the store.** `output_mirror` posted straight at `/rest/v1/coltrane_outputs` and
  `/rest/v1/coltrane_gigs` with `COLTRANE_DRAIN_KEY` as the project `apikey`. A drain key is an
  APPLICATION credential — it authenticates inside a `SECURITY DEFINER` function against
  `coltrane_drain_key`, and PostgREST has never heard of it. Every write answered 401.

  Survivable while that variable was optional. Venue mode made it the CLAIMING credential, so it is
  now always set: the mirror always fires and every write fails. The run still reports success, the
  gig header never completes, its lease expires, and the store hands the same work to the next
  drain — which runs it and pays for it again, unbounded and silent, because the catch only warned
  when `COLTRANE_DRAIN_DEBUG` happened to be set.

  Both paths now use the definer RPCs built for exactly this — `coltrane_drain_ingest` and
  `coltrane_drain_upsert_gig` — with the drain key as `p_token` and the project key as `apikey`.
  The failure warns unconditionally now, naming the consequence. Found by running a real standard
  through the drain rather than testing the plumbing around it; four laws had pinned the broken
  path by mocking `fetch` and asserting the URL.

- **A seat never inherits the credentials that make the box the box.** `childEnv` was built only
  when a gig named a venue, and the drain names none — so every seat spawned with `process.env`
  inherited whole, including `COLTRANE_DRAIN_KEY`. A deny floor now applies on every path.

- **A cloned repository cannot configure the seat that reads it.** Verified against the pinned CLI:
  without `--setting-sources user`, a repo's `.claude/settings.json` hooks EXECUTE and its
  `CLAUDE.md` is obeyed. One gig's write access became every later gig's code execution.

### Added

- **The working tree is obtained AFTER the claim**, from the repository the store names, with a git
  credential minted per gig against a live lease. `REPO_URL` fixed at provisioning made a per-gig
  fact a per-box one and pinned every gig of an organization to one repository.

## 0.8.1

### Added

- **The drain is a venue, not a player.** A drain worker held ONE player's capability token, chosen
  at boot and carried for its whole life. The store's own columns said otherwise —
  `coltrane_gigs.lease_worker` is `text`, a venue handle, while `acting_for` is the agent — and the
  mismatch had teeth: `coltrane_agent_may_run` was consulted twice, once at dispatch (the
  dispatcher) and again at claim (the claimer). The second is not defence in depth. Authority was
  settled at dispatch and recorded in `acting_for`, so re-filtering the queue by whoever holds the
  worker's token made a gig legitimately dispatched by one player INVISIBLE to a box booted as
  another. The queue did not error; it merely looked empty, which is the worst way for this to fail.

  Venue mode: with `COLTRANE_DRAIN_KEY` and an instance (`COLTRANE_INSTANCE`, defaulting to
  `FLY_APP_NAME`), `claimNextGig` authenticates as the BOX through `coltrane_drain_claim` and
  receives a credential minted for that gig's own `acting_for`, expiring with the lease. Identity
  becomes a consequence of the work rather than a choice made at boot. `ctx.agentToken` starts empty
  and is cleared in a `finally` after each run — after the catch, because `failGig` speaks through
  that same credential — so a drain between gigs holds nothing that opens a door, and one
  compromised mid-gig holds exactly one gig's authority until the lease expires.

  Player mode is unchanged and remains the default when no drain key is present: the chair filter
  was never wrong for a player claiming work, only for a drain forced to be one. Additive, hence a
  patch. Store side: `eir-labs/coltrane-ui#19`.

## 0.8.0

### Added

- **The chart is a loadable, authorable genome class.** 0.7.0 shipped `ChartSchema` and
  `composeChart`/`runChart` with no way to load a chart from the genome and no MCP surface — the
  implementing agent declined to advertise a tool it could not back. Now: `charts/` is a genome
  directory. `loadGenome`/`resolveGenome` validate each file through `ChartSchema` **and**
  `composeChart` against the loaded standards, agents and venues, so a chart naming a standard the
  genome does not hold is a `LoadError` of kind `"chart"` carrying the rule that fired — not a
  surprise at minute nine. `LoadedGenome` gains `charts` and `venues`; `loadLayeredGenome` folds both
  (and threads `inheritedStandards`/`inheritedVenues`, so a consumer chart may arrange the base's
  standards). `chart_define` + `chart_browse` and `venue_define` + `venue_browse` join the registry,
  their `input_schema` generated from their schemas; the discoverability-parity table gains both
  classes. `gig_dispatch` gains `chart_slug`, EXCLUSIVE with `standard_slug` through `dispatchTarget`
  — a chart dispatch composes against the real payload's keys, runs `runChart` on both the
  synchronous and async paths, and replies with the arrangement's own manifest (`chart_hash`, the
  per-movement roll-up, cumulative spend against the envelope). Every dispatch preflight — the
  retired/deprecated status read and the seal drill — now sweeps EVERY movement's standard, so a
  chart cannot route a movement past a gate a direct dispatch would fail.

  Ships `charts/software-delivery-v1.json`: ONE movement over `software-change-v1`. No truthful
  two-movement pairing exists among the shipped standards — `software-change-v1` seals
  `change-set`/`change-verdict`/`Judgment` and the only outside needs any other shipped standard
  declares are `design-question`, `change-request` and `invention-disclosure`, so every candidate
  edge would have been invented. A one-movement chart is the degenerate case and its `chart_hash`
  short-circuits to `genomeHash` of that standard, which is exactly the honest thing to ship.

- **The venue: `chart.venue` stops meaning nothing.** `VenueSchema` (one Zod source) declares a
  room's end-state and never how it is built: `equipment.tools` (a deny-by-default allowlist),
  `doors.ingress`/`doors.egress` stated separately because what may reach a room and what may leave
  it are different questions, digest-pinned `installs`, a `credential_surface` of permitted key
  CLASSES, an ephemeral-by-default `lifecycle`, and a `responsible_chair` — one named office that
  answers for the room. Field rules have teeth: an install with no `sha256:<64 hex>` digest is
  refused (an unpinned install names a family of rooms), a door containing `*` is refused, and
  `venueDefect` refuses a `standing` venue with no `rebuild_cadence` — a standing room accumulates
  drift and residue no output's `input_shas` can cover, so the exception owes a cadence.

  **The ceiling rule (R10).** Where a chart names a venue, the effective tool set of every seated
  agent — the movement's own composed roster plus anyone the chart seats over it — is
  `allowed_tools ∩ equipment.tools`. A venue can therefore only NARROW a player; a tool present in
  the room and absent from the charter never appears. An agent whose whole grant set is unreachable
  in the room refuses the chart at compose time, naming the agent, the venue and the empty
  intersection; an agent that grants nothing needs nothing from the room and is seated. A venue the
  caller cannot resolve fails closed — an unresolvable ceiling is not an absent ceiling. The venue is
  deliberately NOT folded into `chart_hash`: a room is environment, not structure.

  Ships `venues/empty-room-v1.json` — the ingestion room, bare by construction: no tools, one
  ingress door, no egress, no credentials, nothing installed, ephemeral, with the formal statement of
  why bareness is the control rather than a configuration choice.

  **Not implemented, and deliberately:** realizing a room from its contract, and verifying one by
  behavioural probe. Those are the layer below the contract; what lands here is the half the engine
  can enforce before anything runs.

- `GigRunState` gains `chart_slug`, surfaced by `gig_monitor`, so an async performance is
  distinguishable from an async run. `genome_reload` syncs charts and venues in place alongside the
  other classes. `GenomeClass` gains `chart` and `venue`: the file store writes
  `charts/<slug>.json` and `venues/<slug>.json`, and a hosted define rides the same upsert port —
  where the STORE side is not yet built, so the RPC refuses it loudly rather than the engine
  pretending the class does not exist.

## 0.7.0

### Added

- **The CHART — a gig is a performance of many standards.** `ChartSchema` (one Zod source,
  `src/genome_schema.ts`) declares MOVEMENTS naming standards, typed EDGES carrying a movement's
  sealed outputs into the next movement's entry chairs, arrangement-level APPROVAL GATES keyed by
  `gate_id`, and a BUDGET ENVELOPE over the whole performance. `composeChart` (`src/chart.ts`) runs
  ten rules in a fixed firing order (R0 schema → R1 movement_id → R2 standard resolution → R3 dead
  seat → R4 endpoints → R5 acyclicity → R6 dead-name/optional classification → R7 dead slot → R8
  gate keys → R9 envelope) and returns a structured violation list. `runChart` walks the movements
  in topological order, one `runGig` each, and does everything interesting at the boundary — the
  only place a stop is free: gathers the incoming edges' carriers as SEALED RECORDS (so the sink's
  provenance reaches back across the boundary), parks on an unapproved gate, compares real settled
  spend to the envelope, and records what completed so a resume never re-derives it.

  A single-standard gig is the DEGENERATE one-movement chart: `chart_hash` short-circuits
  byte-for-byte to `genomeHash` of that standard, so its `run_fingerprint`, ledger row id and
  checkpoint id are unchanged. `GigLedgerEntry` gains `chart_slug` + `movement_id` (both optional;
  `standard_slug` stays non-null, because a movement always names exactly one standard);
  `CheckpointRole` gains `movement_id`; `GigCheckpoint` gains `prior_budget_state`; the reuse cache
  key gains a chart namespace, appended only for a chart run so no existing key moves.

### Changed

- **`genome_hash` moved once, to stop moving.** 0.6.6 added two `.default([])` fields to
  `ChairSchema`; no standard's structure changed, but the materialized empty arrays entered
  `canonJson` and `genomeHash` moved for the whole genome — re-keying the ledger and refusing
  resumes for a drift that did not exist. `genomeHash` now hashes through `canonStructuralJson`,
  which drops object keys whose value states nothing (`undefined`, `null`, `[]`, `{}`) while keeping
  `0`/`""`/`false` and every array position. Reaching that canonicalization moves the hash ONE final
  time: a pre-existing ledger row's `genome_hash` will differ from a freshly computed one, and a
  resume or drained-state reconstruction across the bump is REFUSED with a drift line (re-dispatch
  cold). After this, a new schema default is hash-neutral. Pinned by
  `tests/genome_hash_stability.test.ts`.

## 0.5.1

A patch release that exists because CI ran for the first time and disagreed with the package
about what it could run on.

### Fixed

- **`server_restart` killed the child it had just reported as serving.** The relay's whole
  purpose is swapping the server child without dropping the client's stdio pipe. Every swap
  destroyed its own successor roughly two seconds later.

  `restartChild` raced the outgoing child's `exit` against a 2s SIGKILL escalation.
  `Promise.race` discards the loser's value but does not cancel it, and the timer closed over
  the mutable `child` binding rather than the process it was armed for. On the ordinary path —
  old child exits promptly, exit branch wins — the timer stayed armed, fired 2s later, read
  `child` (by then the healthy replacement), found it alive, and killed it.

  Which symptom you saw depended only on where your next call landed relative to the exit
  being reaped: `buildNoChildError`, telling you to restart an MCP client that had just
  restarted successfully — or a write into a dying pipe, silently discarded, hanging forever.

  0.5.0's #260 work made a *failed* swap reportable. This made a *successful* one fatal, which
  is why it hid behind it. The timer now targets a captured local and is cleared once the swap
  moves on, so it can only ever reach the process it was armed for.

  Found because `relay_restart_handshake` failed about 1 run in 10 — it finishes inside the 2s
  window on a quick machine, so it could only catch this by accident. A second case now waits
  the window out deliberately and asserts the replacement still answers.

- **`engines` promised Node 20; the engine cannot run there.** Skill execution spawns with
  `--permission`, which is Node 22+. On Node 20 every code-bearing skill dies with
  `node: bad option: --permission`. 0.5.0 shipped claiming `>=20`, so npm installed it with a
  warning and the failure arrived later, at the first skill.

  `engines` now says `>=22`. Because npm treats that as advisory rather than a hard gate,
  `skill_subprocess` also checks the runtime at both spawn sites and refuses with a message
  naming the reason instead of the flag.

  **There is deliberately no fallback.** Running a skill on a runtime with no permission model
  means running it unsandboxed, and quietly doing that would invert the guarantee the sandbox
  exists to provide. On Node < 22 skill execution refuses; everything else is unaffected.

  **Migration.** Upgrade to Node 22+. If you are on 20 and cannot move yet, stay on 0.5.0 —
  it is the same engine with a wrong compatibility claim, and skills were already failing.

### Internal

Test-infrastructure repairs with no runtime effect, kept here because each one was a check
that reported success without doing its job:

- The import-allowlist guard asserted it had run whenever `CI` was set — true in every Actions
  job, while eslint installs in one. It now keys off a variable set where the dependency
  actually exists.
- Two pack audits each triggered a build into `dist/` and raced, one reading a file the other
  was still writing. The build moved to a single `globalSetup`; the suite got faster.
- `midflight_kill` spawned its worker through `npx`, so its SIGTERM went to npx rather than to
  the process under test — which could not have handled the signal anyway, its loop never
  unwinding to the event loop. Termination came from a SIGKILL that killed the tree on macOS
  and orphaned it on Linux. The child is now the worker itself, and the test asserts the
  signal was received.

## 0.5.0

The through-line of this release: **the engine had a habit of answering confidently when it
should have refused.** A guardrail that no caller could discover, a filter that silently did
nothing, a lifecycle field that round-tripped and changed nothing, a `proposal_id` for a
proposal never recorded. Each read as working software. Most of what follows is the engine
learning to say "no" or "I don't know" where it used to return a plausible answer.

### Breaking

- **`OutputStore` gains `typeFingerprint(slug)` and `validateWrite(o)`.** Any external
  implementation must add them — same shape as 0.4.0's `Ledger.integrity()` addition, and for
  the same reason: the store is the single owner of a question two layers now need answered.

  `typeFingerprint` hashes a type's current shape (core + required list + schema).
  `validateWrite` answers "would `write` accept this?" without persisting — `write` now calls
  the same internal gate, so the two answers cannot drift. Reuse needs both: the first to
  detect that a domain type moved under a cached output, the second to decide about a
  multi-output entry *before* any of it becomes durable.

  **Migration.** A store with no registry can answer honestly:

  ```ts
  typeFingerprint(): string { return ""; }   // "" = cannot describe → never reused
  validateWrite() { return { valid: true }; }
  ```

- **`CheckpointStore` gains `remove(gig_id)`.** Called when a gig completes. Nothing previously
  removed a checkpoint, so every gig a deployment ran left a file behind forever. A failed or
  aborted gig keeps its checkpoint, because that is what resume reads.

  **Migration.** `remove() {}` is a valid implementation; it forgoes the reclamation only.

- **The loader refuses three definition shapes it used to accept silently**, plus six further
  bypasses of the same rule found on review — including `type: ["string","null"]`, the same
  constraint in JSON Schema's other legal spelling. A genome that loaded under 0.4.1 may now
  report `load_errors`. That is the point: it was not loading what its author wrote.

- **`gig_dispatch` refuses a `retired` standard** and warns on a `deprecated` one. Previously
  `status` was recorded and read by nothing, so a standard marked retired stayed dispatchable.

- **Calls that used to succeed on nonsense now fail.** In each case the prior behaviour was a
  confident wrong answer, not a tolerant one:
  - `capability_research` with no `need` — previously returned `gap: true, "propose a new
    tool/type"` for a search of the empty string.
  - `tool_propose` / `tool_deprecate_propose` with no `slug` — previously returned a
    fabricated `proposal_id` for a proposal that was never recorded.
  - `output_trace` with an unrecognised `direction`, `system_health` / `health_check` with an
    unparseable `window`, `system_audit` with an unknown `check` — previously ignored, so the
    caller received an answer to a different question with nothing marking the difference.

- **`company_id` is removed from the MCP surface.** It was advertised on `gig_dispatch`,
  `charter_read` and `charter_suggest_update` and read by none of them. It is worse than a
  merely dead argument because it is tenancy-shaped: a caller passing it to scope a run would
  reasonably believe the run was scoped. The engine deliberately does not do tenancy —
  `principal` on the ledger is provenance, explicitly not access control — so it stops
  advertising a guarantee it does not make. It survives as a field on `AccessGrant`.

- **Several tools' advertised input schemas changed** to match what their handlers read. Most
  notably `output_write` now advertises `gig_id`, `agent_slug`, `phase` and the cost fields;
  `access_grant_check` and `capability_research` advertise the arguments they actually consume.

### Added

- **Phase checkpoint/resume, and engine-level output reuse.** One idea, two ranges: reuse a
  sealed output instead of paying to derive it again. A mid-run failure used to discard every
  completed phase — a full convergence run is ~$4–7, and a failure at phase 5 threw away
  phases 1–4.

  - `RunDeps.checkpoints` — a durable per-gig record of each completed chair's sealed outputs.
    Written automatically when wired; a checkpoint you must opt into *before* the failure is
    one you never have.
  - `RunDeps.resume_from` / `gig_dispatch({ resume_gig_id })` — continue that gig (same
    `gig_id`, so `output_trace` still reaches the restored ancestors), skipping what already
    sealed. **Refused, never silently run cold**, if `genome_hash`, the **producers**, the
    dispatch payload, `model_version`, `depth`, the canonical form, or any consumed domain type
    has moved; the reply carries `resume_refused` and a `drift` list.
  - `RunDeps.reuse` / `gig_dispatch({ reuse: true })` — a chair whose producer definition,
    consumed input **content**, payload, model and depth hash to a prior sealed output is
    served from it instead of invoked. Presence of the store is the opt-in, for reads *and*
    writes: the store is cross-gig by construction, so populating it is itself a decision.
    A found-but-unusable entry is reported and the chair does the work.
  - Reuse is never a way to skip a check. Every recalled output crosses the same seal boundary
    a derived one does (core agreement, the registry schema, the substance floor) and is
    re-hashed to the `content_sha` the original seal produced — which is why a resumed or
    fully-reused run carries the **same `run_fingerprint`** as the cold run it stands in for.
  - Nothing is silent: `GigResult.skipped` / `.resumed_from` / `.reuse`, the `gig_resumed`,
    `chair_skipped` and `reuse_rejected` progress events, `gig_monitor.skipped_chairs`, a
    `skipped` chair status of its own, and `OutputRecord.reused_from` on the record itself.

- **A sealed output records WHICH model produced it** (`model`, `model_tier`). `cost_usd` was
  recorded per chair and the model was not, so a run whose chairs deliberately sit on different
  tiers — the entire point of per-chair routing — could not attribute its own spend to a tier.
  The gig ledger row's `by_model` is gig-level and cannot separate two chairs in one run.

  Stamped through the invoker's own `resolveModel`, now exported, so the seal and the spawn
  cannot disagree. Absent for skill-backed chairs and for anything sealed before this existed —
  absent means unknown, never "the default". `improvement_report` gains a `tiers` axis on top
  of it, which is what makes "does the cheap tier still clear the bar for THIS chair" answerable.

- **`improvement_report` — improvement as a measurement, not a count.** `learning_synthesize`
  answers "is there enough evidence to act?" and returns a review count. It could not answer
  the question the typed-and-sealed design exists to make answerable: **did this producer get
  better, and what did it cost?**

  Every input was already sealed and nothing joined them. Outputs carry `agent_slug`,
  `cost_usd` and `created_at`; reviews carry `quality_scores` against a specific `output_id`
  and `agent_version`. The report buckets a producer's outputs by version and returns mean cost
  and mean quality per version, plus the version-to-version delta and a verdict — *better and
  cheaper*, *cheaper and worse*, and so on.

  An unmeasured quantity is `null`, never `0`: zero cost reads as "free" and zero quality as
  "worthless", and both would be fabricated numbers. A delta is emitted only where BOTH ends
  are measured, and when the report cannot answer its own question it says
  `comparable: false` with the reason, rather than returning empty arrays that read as "no
  change".

- **The skill iteration loop: `skill_browse`, `skill_inspect`, `skill_execute`, `skill_evolve`.**
  The surface was define + promote — a skill could be created and given production status, and
  never run, tested, listed or revised through the engine. Adding a fixture gate to promotion
  made that gap sharper rather than better: a skill could be refused for failing fixtures with
  no supported way to run them and see which.

  `skill_execute` with `mode: "test"` runs the skill's own fixtures and reports the threshold
  promotion would hold it to, so "why was I refused" is one call. `skill_inspect` reports
  `promotable` before anyone tries, and deliberately does NOT return fixture `expected_output`
  — an answer key is not inspection.

  `skill_evolve` is the one with the guarantee: a candidate runs against the CURRENT fixtures
  in a throwaway copy and lands only on a clean pass, so **a skill cannot regress through this
  door**. On acceptance the version bumps, because the bytes that run changed and an evolved
  skill under an unchanged version is the edit-under-a-stable-slug shape `producers_sha` exists
  to catch. `evolveSkill` had implemented exactly this since before the open-source split and
  had no caller anywhere — the fourth gate this release found built and unwired.

- **A skill must pass its own fixtures to become `active`.** Promotion checked that a skill's
  METADATA parsed and nothing else, so a code half that failed every one of its fixtures
  promoted cleanly. `runSkillFixtures` — which runs each fixture repeatedly, checks expected
  output and assertions, and checks the runs agree — had been in the tree the whole time with
  no caller outside the test suite.

  The threshold is keyed off MEASURED determinism, not the declared `determinism_ratio`: a
  skill whose runs agree must pass every fixture, one that varies must pass 80%. Claiming
  determinism therefore costs something.

  A code skill with NO fixtures is refused — silence is not a pass, and allowing it would make
  the gate opt-out by omission. Reasoning-only skills are not gated (there is nothing to run),
  and promotion to a non-`active` status is not gated (a skill has to be able to reach the
  state where the work happens). The passing report is recorded on the ledger row, so the audit
  trail says what the promotion rested on rather than only that someone asked.

- **A command line: `coltrane`.** The package shipped exactly one executable — the MCP stdio
  server — so the engine was reachable from an MCP client and from nowhere else. Not CI, not
  cron, not a container, not a queue worker, not a shell. A methodology engine whose only caller
  is an interactive client cannot be part of a build.

  ```
  coltrane validate      # exits non-zero on load errors — the CI gate
  coltrane dispatch <standard> --input @in.json [--depth skim] [--budget 5] [--reuse]
  coltrane monitor <gig> --follow      coltrane trace <output-id>
  coltrane logs <gig>                  coltrane simulate <standard>
  coltrane abort <gig>                 coltrane health
  coltrane serve         # the MCP stdio server, as before
  ```

  A thin wrapper by design: `dispatchTool` was already the whole tool surface as a pure
  function and `bootstrapServerDeps` already resolved the genome, ledger and output store. Two
  front doors that disagreed about what a dispatch means would be the defect this release spent
  its time removing.

  Data on stdout, everything else on stderr, so `coltrane dispatch … --json | jq` and
  `coltrane dispatch … | xargs coltrane monitor` both work. Exit 0 success, 1 ran-and-failed,
  2 malformed — a CI job can tell a broken genome from a broken invocation.

  `coltrane-server` is unchanged, so no existing `.mcp.json` breaks.

- **The capability gate fails CLOSED.** `exposedTools` walked the agent's grant and filtered
  only the tools it RECOGNISED; a tool in none of the three scope classes matched no branch and
  was exposed unconditionally, whatever the grant said. The gate's coverage was its own
  allowlist, so the tools it had never heard of were exactly the ones it could not stop. An
  unrecognised tool is now denied, and `undeclaredScopeTools()` lists them so an operator sees
  the problem while authoring rather than mid-run.

- **The prompt is delivered on stdin when it is too large for the command line.** Windows caps
  a command line at ~32,767 characters and the invoker put the whole chair prompt in argv, so a
  strategize-phase prompt (blueprint + draft + review) died with `ENAMETOOLONG`. A consumer
  reported it as "broken on Windows … local dev was practically unusable" and worked around it
  by monkey-patching `child_process.spawn` — a patch coupled to this module's argv construction
  through the package's built output, which would therefore break *silently* on any release
  that touched it. `-p` is a boolean flag and the prompt is positional, so the fix keeps the
  flag and moves the positional: no consumer needs to patch anything.

  Threshold `COLTRANE_PROMPT_ARG_LIMIT` (default 16,000, deliberately well under the cap
  because the mcp-config path and tool lists share the line); `COLTRANE_PROMPT_MODE=arg|stdin`
  forces either route. An unrecognised value falls back to the size test rather than failing a
  dispatch. Below the threshold nothing changes, and stdin is opened only when something is
  going down it, so TTY detection is unaffected for existing callers.

- **A skill-backed chair is interruptible.** It ran a blocking subprocess, so abort could not
  reach it — a "stopped" run kept burning. Now spawned non-blocking, SIGKILLed on abort, not
  spawned at all if already aborted, and capped at 64MB of output.

- **The advertised-schema guard covers all 37 tools.** A tool's `input_schema` and its handler
  are two statements of one fact, and nothing checked they agreed. Both directions are bugs:
  read-but-unadvertised is an undiscoverable control, advertised-but-unread is a silent no-op.

- **Arguments that were advertised and ignored now work**: `window` on `system_health` /
  `health_check`, `status` and `min_usage` on `type_browse`, `data_filter` on `output_query`,
  `direction` on `output_trace`, `scope` / `check` on `system_audit`, `since` on
  `learning_synthesize`, and the rationale fields (`reason`, `evidence`, `notes`,
  `agent_version`, `domain`, `spec`, `category`) which are now recorded rather than discarded.

- **`writeFileAtomic`** (`src/fs_atomic.ts`), shared by the genome writer and the checkpoint
  store.

### Security

- **A tier-0 skill could read any file, the whole parent environment, and reach the network** —
  while the source asserted, in two places, that it "cannot write, spawn, or reach the network".
  Probed through `executeSkill` on a real machine, a tier-0 skill read `/etc/passwd`, saw all 77
  of the parent's environment variables, and completed an outbound HTTPS request.

  `--allow-fs-read=*` is literally "read every file", so reads were never confined. The
  environment inheritance is the one with teeth: `process.env` carries the provider credential,
  so a skill could exfiltrate it in one line.

  Now: tier 0 is confined to its own package directory (its inputs arrive on stdin; it never
  needed more), tier 1+ still reads and writes broadly because that is what those tiers are
  for, and **every** tier receives an explicit minimal environment instead of the parent's.

  **What is still not gated: the network.** Node's permission model has no network flag, so the
  original guarantee was unimplementable in this runtime rather than merely misconfigured. It is
  now stated rather than denied. What changed is that there is no longer a credential in reach.

  `tests/skill_sandbox_confinement.test.ts` probes the capability rather than the flag string —
  asserting on flags is how the false claim survived. The `fs-read` threshold in the cage matrix
  moves 0 → 1 accordingly; that matrix had been asserting what the implementation did rather
  than what the tier promised.

### Fixed

- **`output_write` read `gig_id` and advertised it nowhere.** A prompt written against the
  schema omits it, the handler defaults it to `""`, and the sealed output attaches to no gig.
  A live run of a consuming product produced 509 such orphans. This is that bug's root cause.

- **`capability_research` reported a gap for every capability.** It advertised `need`/`context`
  and read `query`/`capability` — no overlap — so every schema-following call searched the
  empty string, matched nothing, and was told to build a new tool. The one tool whose purpose
  is preventing redundant definitions recommended one unconditionally.

- **Genome writes are atomic.** `sealDefinition` records a definition's identity in the ledger
  *before* writing the file — deliberate, because the reverse manufactures a definition with no
  recorded identity — and that ordering is only safe if the write is all-or-nothing. A torn
  `writeFileSync` left the ledger asserting a content hash whose bytes on disk hash to
  something else, which is the engine's central provenance claim failing silently. The same
  function writes the prior version to history before overwriting, so an interrupted overwrite
  could destroy the live file while its only backup was also mid-write.

- **A refused resume destroyed the prior run's state**, turning a `failed` gig into a
  permanently `running` one and discarding the very error being acted on.

- **`type_extend` was a third door** that could persist a definition the loader had just
  declared illegal.

- **`tool_propose` and `tool_deprecate_propose` minted receipts for work they never did** —
  a `randomUUID()` returned as a `proposal_id`, every argument discarded, nothing written. Both
  are now recorded through the same ledger path `proposal_create` uses.

## 0.4.1

### Fixed

- **The bare specifier was not resolvable.** `exports["."]` declared `types` and `import` but
  no fallback condition, so `require.resolve("@eir-labs/coltrane")` failed with
  `ERR_PACKAGE_PATH_NOT_EXPORTED` even though `import` worked. Path resolution is not module
  loading — a consumer locating the package (to hand a path to a dynamic import, or to point
  a tool at `dist/`) hit an error for something the package plainly ships. Adding `default`
  makes it resolvable under any condition; the package remains ESM-only.

  Found by installing 0.4.0 from the registry and using it, not by reading the manifest.

## 0.4.0

### Breaking

- **`Ledger` gains a fourth method, `integrity(): LedgerIntegrityReport`.** Any external
  implementation of the `Ledger` interface must add it. (#255)

  `FileLedger` already had it as a class method; the interface did not declare it, so a
  consumer holding a `Ledger` could not ask whether its own audit trail was intact — the
  engine's own test had to cast through `Record<string, unknown>` to reach it. Since the
  point of the ledger is auditability, "you cannot ask" was not a defensible default.

  **Migration.** An implementation whose storage cannot tear still owes an answer; "there is
  nothing here to corrupt" is one, and a missing method is not:

  ```ts
  integrity(): LedgerIntegrityReport {
    return { ok: true, path: "", entries: this.rows.length, corrupt: [] };
  }
  ```

  This is what `MemoryLedger` returns.

### Added

- `system_health` surfaces `ledger_integrity`, `outputs_integrity`, `counts_complete` and
  `counts_complete_basis`, and advertises all four in its MCP `output_schema`. Corruption was
  previously detected, reported into a void, and invisible to operators. (#255)
- `Chair.optional_outputs` — declares which promised output types may legitimately be absent.
  The `output_contract` is now a **floor**: a chair sealing fewer types than it promised fails
  the run unless the absence was declared. Deny-by-default. (#243)

### Changed

- **`counts_complete` is `false` or `null`, never `true`.** Corruption found is provable;
  completeness is not — a jsonl truncated at a line boundary loses whole rows without leaving
  a parse error. `counts_complete_basis` states what was and was not checked. (#255)
- A chair is now **all-or-nothing**: every check that can reject it runs before the first
  output is sealed, so a failed chair no longer leaves persisted outputs with no ledger row.
  (#243)
- `outputs.integrity()` re-scans from disk on every call instead of reporting the corruption
  accumulated during reads, which never included files the process wrote itself. (#255)
- `standard_simulate` refuses an unknown standard, and reports `not_implemented` on a host
  with no standards wired — matching `gig_dispatch` rather than quoting a price for a run the
  same server would refuse. (#267)
- `outputs.write` rejects a record whose `core_type` contradicts its `domain_type`'s
  `extends`, and rejects a `core_type` that is not a core type at all. (#263)
- A skill-backed chair may no longer declare more than one output type: it seals exactly one,
  so a longer contract was a promise the runtime could not keep or report breaking. (#243)

## 0.3.0

First tagged version. Establishes `COLTRANE_VERSION` as the single source of truth and makes
the MCP handshake report it rather than a hardcoded `"0.1.0"`. (#257)
