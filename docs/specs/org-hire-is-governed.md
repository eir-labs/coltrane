# Spec: a governed `org_hire` verb — the engine half

**Status:** RED spec (laws written and OBSERVED red, enforcement not yet implemented)
**Laws:** `tests/org_hire_is_governed.test.ts` (13 laws, all red before any `src/` change)
**Change request:** ship the ENGINE HALF of a governed `org_hire` verb — the org-membership
analogue of `venue_credential_mint`.
**Change plan:** bill-org-hire-change-plan-001 · **Decision:** miles-org-hire-frame-change-001

## The gap, concretely

There is no verb that ADMITS an agent to an org. A peer session that asked to be seated as a
player in another org was refused at genome load ("name a seated player"), and the only path to
admit an agent is a human editing store rows by hand. The engine ships no governed surface for the act, so it
has no gate and no audit trail.

## The pattern this copies exactly

`src/venue_credential.ts` ships the engine half of `venue_credential_mint` and nothing else: the
required-shape contract, an EXACT sorted list of typed refusals, and a `deps.mintVenueCredential`
seam a deployment injects (`src/server.ts:3147-3152`), intercepted in `callSurfaceTool`
(`src/server.ts:3203-3264`) BEFORE the hosted check. `deps.queueGig / approveGig / cancelGig`
(`src/server.ts:3124-3137`) are the same shape. `org_hire` follows this split verbatim: **the engine
ships the verb, its zod-derived schema, its shape validation and its refusals; the deployment supplies
the backend.** The engine half needs no store and is fully testable offline, because the refusals are
the testable part.

## Obligations → mechanism → callsite → law

Each obligation is an invariant of the contract. The mechanism and callsite are what
create-change must build; the law is the red test that already asserts it.

### O1 — the verb is on the served surface (INV-1)
- **Mechanism:** an `org_hire` entry in `MCP_TOOLS`, `category: "manage"`-class, with
  `input_schema` derived from the single Zod source via `zodToMcpProps(OrgMemberSchema)` — never a
  hand-written MCP schema. `createToolSurface` (`src/server.ts:3360`) maps `MCP_TOOLS`, so presence
  in `MCP_TOOLS` is presence on every transport.
- **Callsite:** `src/mcp.ts` (the `MCP_TOOLS` array); `OrgMemberSchema` at `src/genome_schema.ts:666`.
- **Law:** `INV-1 · org_hire is on the engine's tool surface`.

### O2 — admission is not authority: no capability field in the input schema (INV-2)
- **Mechanism:** the input schema IS `OrgMemberSchema = z.object({ org_slug, agent_slug })` and
  nothing more. `org_hire` must not accept `caps`/`standards`/a chair/an assignment. Seating is a
  separate act with a separate gate; a credential presented by an incumbent may only NARROW what a
  chair grants, and if `org_hire` could mint authority in one call that narrowing loses its floor.
- **Callsite:** `src/genome_schema.ts:666` (single source); `src/mcp.ts` (served projection).
- **Law:** `INV-2 · its input schema is {org_slug, agent_slug} — no field a capability could travel`
  (pins `Object.keys(OrgMemberSchema.shape)` AND the served `input_schema`, and names the forbidden
  fields explicitly).

### O3 — hiring is never self-service: `not_a_human_member` (INV-3)
- **Mechanism:** decided from `deps.caller` (`CallerIdentity`, `src/venue_credential.ts:52`) ALONE,
  before the backend is reached. `CallerIdentity.kind` is `'member' | 'player' | 'venue' | 'gig'`;
  only `'member'` bears a human. Any non-`'member'` kind → typed `not_a_human_member` refusal, and a
  refused hire never touches `deps.hireMember`.
- **Callsite:** the `org_hire` intercept in `callSurfaceTool` (`src/server.ts`, beside the
  `venue_credential_mint` intercept).
- **Law:** `INV-3 · a '<kind>' caller is refused not_a_human_member, without reaching the backend`
  (one law each for `player`, `venue`, `gig`).

### O4 — no backend wired → a typed refusal, never a throw (INV-4)
- **Mechanism:** with `deps.hireMember` absent, the verb answers `no_backend` naming the seam —
  the same first-class outcome `venue_credential_mint` produces (`src/server.ts:3227-3236`). It is
  intercepted before the hosted check, so it is `no_backend` and never `hosted_unsupported`, and
  `org_hire` appears in NEITHER `HOSTED_BLOCKED` nor `HOSTED_UPSERT` (`src/server.ts:3165-3196`).
- **Callsite:** the `org_hire` intercept in `callSurfaceTool`.
- **Laws:** `INV-4 · a member caller with no backend wired is refused no_backend`; and
  `INV-4 · org_hire is intercepted before the hosted check — no_backend, not hosted_unsupported`
  (the observable proxy for absence from the two module-private hosted maps).

### O5 — a dead name fails closed: `unknown_agent` (INV-5)
- **Mechanism:** `deps.hireMember({org_slug, agent_slug})` resolves to
  `{ok:true} | {ok:false, code:'unknown_agent'|'already_member'}` — a TYPED struct so named codes
  survive the seam. `{ok:false, code:'unknown_agent'}` (no `agent_record` with that slug) maps to a
  typed `unknown_agent` refusal, exactly as an unresolvable tool grant fails closed at dispatch.
  Existence is the ONLY precondition — the engine never checks status; governance and naming are
  separate acts (`coltrane-proposer` is `active` yet was never `named`).
- **Callsite:** the `org_hire` intercept; the `deps.hireMember` seam declared on `ToolSurfaceDeps`.
- **Law:** `INV-5 · backend {ok:false, code:'unknown_agent'} maps to a typed unknown_agent refusal`.

### O6 — idempotency is an ERROR, not a silent success: `already_member` (INV-6)
- **Mechanism:** `{ok:false, code:'already_member'}` maps to a typed `already_member` refusal. A
  governance surface must SURFACE a duplicated hire; a silent no-op would mask a human member's
  mistake. (miles settled the defensible-either-way choice on the stricter, more auditable outcome.)
- **Callsite:** the `org_hire` intercept.
- **Law:** `INV-6 · backend {ok:false, code:'already_member'} maps to a typed already_member refusal`.

### O7 — the act is sealed to the ledger, before the caller is told (INV-7, INV-9)
- **Mechanism:** on `{ok:true}`, a `kind:"genome_mutation"` row via `recordIdentity()`
  (`src/genome_writer.ts:119`) — ledger-only, NOT `sealDefinition()`, because a hire writes no genome
  file — with `event:"org_hire"`, `subject_slug = agent_slug`, and `org_slug` carried in the hashed
  content / detail. Sealed inside the `{ok:true}` branch, after the backend confirms and before the
  success is reported. A refused hire seals NOTHING.
- **Callsite:** the `{ok:true}` branch of the `org_hire` intercept.
- **Laws:** `INV-7 · a successful hire seals a genome_mutation row (subject=agent_slug) before it
  returns`; `INV-9 · a refused hire (unknown_agent) seals no genome_mutation row`.

### O8 — admission reports the belonging (INV-8)
- **Mechanism:** on success the verb answers with the `{org_slug, agent_slug}` membership it created,
  carrying nothing with authority.
- **Callsite:** the `{ok:true}` branch of the `org_hire` intercept.
- **Law:** `INV-8 · on success it returns the {org_slug, agent_slug} membership it admitted`.

### O9 — the refusal set is an EXACT, sorted list (INV-10)
- **Mechanism:** `src/org_hire.ts` exports `ORG_HIRE_REFUSALS` as an as-const array in sorted order
  `['already_member','no_backend','not_a_human_member','unknown_agent']`, with the `OrgHireRefusal`
  union type — mirroring `VENUE_CREDENTIAL_REFUSALS` (`src/venue_credential.ts:40-46`). A refusal code
  is a contract with clients, so a fourth appearing silently is a client branch nobody wrote.
- **Callsite:** `src/org_hire.ts` (new file).
- **Law:** `INV-10 · ORG_HIRE_REFUSALS is exactly [...], sorted`.

## Non-goals (unchanged from the decision)

- No store-side insert and no RLS policy — the deployment's half, unreadable by this engine.
- No chair creation, assignment records, or capability records of any kind.
- No coupling to the naming ceremony — the agent_record must EXIST (any status), never be `named`.
- No changes to `src/venue_credential.ts`, `src/worker.ts`, `src/cli.ts`, or the drain's env contract.
- No addition to `HOSTED_UPSERT` (not a genome-class upsert) or `HOSTED_BLOCKED` (callable hosted).

## Honest scope note (for the PR body)

Shipping this does NOT by itself unblock the peer session. It gives the act a governed surface, a
gate, and an audit trail; a deployment must still inject `deps.hireMember`, and a human member must
still perform the hire.

## Observed red (before any `src/` change)

`npx vitest run tests/org_hire_is_governed.test.ts` → **13 laws, 13 red**. INV-1 through INV-9 fail
on `expected undefined to be defined` (the verb is absent from `MCP_TOOLS`, so `createToolSurface`
yields no `org_hire` tool); INV-10 fails on `Cannot find module '../src/org_hire.js'`. The globalSetup
build (`tsc`) passed, so the red is at runtime on each law's own contract line — not a compile error
masquerading as a spec.
