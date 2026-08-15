# The worker contract — a RED specification

A **worker** is any host that runs `coltrane work`: a container, a laptop, a CI runner. This
document is the contract such a host is entitled to, written as five gaps and the laws that close
them.

Every gap here was found by RUNNING the system. None came from review. That distinction is the
reason the document exists: each one is cheap to describe and was expensive to find, because each
failed as something else — a Storage permissions problem, a stale client cache, an empty queue, a
tool the model "chose not to use". The point of writing them down is that the next person meets the
refusal instead of the symptom.

The suite in `tests/spec_*.test.ts` is the falsifiable half of this document. It is committed
**failing on purpose**. See [RED → GREEN](#red--green) before assuming CI is broken.

---

## One word, two things — and they are the same thing

`Venue` is a genome class: a room contract with a tool ceiling, a credential surface, doors, and
installs (`src/genome_schema.ts:938`, realized by `src/venue_realize.ts`). The repo ALSO says
"venue" for a running host — "venue mode", "venue credential" — in `src/cli.ts` and `src/worker.ts`.

`src/cli.ts:211-216` already reconciles them, and the reconciliation is right: *"the venue is the
room, and a room may hold more than one stage"*. So, used consistently throughout this document:

- **the venue** is the ROOM, declared in the genome, named by a chart, realized before a chair runs;
- **a venue instance** is one running host standing that room up, named by `COLTRANE_INSTANCE`;
- **a venue credential** is what lets a host act as a venue instance of its organization.

Gap 3 is the general case of what goes wrong when a single name carries two contracts, so this
document does not create another one. Where it needs the second sense it says *venue instance*.

---

## Gap 1 — no verb mints a venue credential

### What is true today

To run a worker you need a venue credential (an org-scoped, instance-bound drain key) plus a set of
environment variables. The engine ships no MCP verb that produces either. `MCP_TOOLS` (`src/mcp.ts`)
has no minting tool; `createToolSurface` (`src/server.ts:3092`) therefore cannot mount one.

Every deployment invents its own path, and in practice those paths go through a browser: a human
signs in, reads a value off a screen, and carries it somewhere by hand.

### Why it is a defect and not a deployment concern

A flow that requires a human to hand-carry a value cannot be driven by an MCP invocation. The MCP
surface is how an assistant is meant to operate Coltrane — the repo's own governor ruling is that
*"the hosted Coltrane MCP is the Coltrane MCP"* (`src/tool_surface.ts`, `src/server.ts:2911`). A
capability with no verb is a capability an assistant cannot use.

The hand-carried step is also precisely what the venue credential design exists to remove. `cdk_`
keys were introduced so a box holds one credential and the store mints per-gig authority on each
claim (`src/worker.ts:298-318`). Provisioning that design by copy-paste from a browser puts the
long-lived secret back on a human's clipboard, which is the state the design replaced.

### The contract

The engine's tool surface exposes `venue_credential_mint`:

```
venue_credential_mint(org_slug: string, instance: string) -> {
  instance: string,
  env: Record<string, string>,     // the COMPLETE worker environment, canonical names only
  credential_classes: string[],    // in `VenueSchema.credential_surface` vocabulary
  expires_at?: string | null,
}
```

1. **The verb exists on the real surface.** In `MCP_TOOLS`, therefore in `createToolSurface`,
   therefore on every transport that mounts it. `0.9.3` is the precedent for why this sentence is
   worth writing: a field added to a surface nothing serves is a field no client can send.

2. **It returns the COMPLETE environment, not just the key.** Every required variable in
   [the worker environment contract](#the-worker-environment-contract) with a real value. A caller
   must never assemble the rest by hand, and must never have to infer which URL names which host —
   Gap 3 is what that inference costs.

3. **A grant that is not complete is refused, not returned.** If the wired backend answers with an
   env missing a required variable, the engine refuses (`refusal: "incomplete_env"`) naming the
   variables. Handing back a half-set would move the assembly problem to the caller while looking
   like success.

4. **A gig-scoped credential may not mint one.** A gig token is issued to one agent for one gig and
   expires with that gig's lease (`src/worker.ts:319-342`). A venue credential is org-scoped and
   outlives every gig. Allowing the first to mint the second turns the narrowest credential in the
   system into the broadest — a privilege escalation with no store-side gate to catch it, because
   the store sees a valid org-scoped request. The refusal is its own typed answer
   (`refusal: "gig_scoped_token"`), not a generic authorization failure, because a caller that
   cannot tell "you may not" from "not with THIS credential" retries forever with the same one.

5. **The credential is returned exactly once.** Nothing reads it back. There is no
   `venue_credential_read`, and the grant is not persisted by the engine.

6. **The grant names the credential CLASSES it provisioned, in the venue contract's own
   vocabulary.** `credential_classes: string[]`, the same names a `VenueSchema.credential_surface`
   declares (`src/genome_schema.ts:938`). This is not bookkeeping. `realize` already treats a
   credential class present in the environment but NOT declared by the room as a `credential-breach`
   refusal — so a mint that provisions a class no venue declares stands up a box every room then
   refuses, and the operator debugs a working credential against a correct refusal. Naming the
   classes lets an author check the two against each other before a gig is ever dispatched.

7. **With no backend wired, the verb answers honestly.** `refusal: "no_backend"`, `ok: false`, an
   error naming the seam to wire — and it does not throw. This is the shape
   `src/server.ts:2957-3060` already uses for `gig_dispatch`, `gig_approve` and `gig_cancel` when
   their store seams are absent. Follow it.

**Typed refusals, not a boolean.** `ToolResult` gains `refusal?: string`, a machine-readable code.
The precedent is `RefusalCode` in `src/venue_realize.ts:23` — a fail-closed answer naming exactly
one breach. The existing `hosted_unsupported` flag is deliberately NOT reused: it means "this
surface is hosted and this tool is local-process", and a missing minting backend is neither. Reusing
it because it is nearby is how a name comes to mean two things, which is Gap 3.

### Left to the deployment

**Authorization, entirely.** The engine has no opinion about who may run a venue and no way to check
one; that rule lives in the store. The engine ships the verb, its schema, its shape validation, and
its refusals. A deployment wires the minting backend:

```ts
// ToolSurfaceDeps
mintVenueCredential?: (args: { org_slug: string; instance: string })
  => Promise<VenueCredentialGrant>;
```

This is the division `src/tool_providers.ts:9-10` already states for MCP servers — *"The OSS engine
ships this RESOLUTION machinery; a deployment registers the actual server config (the server itself
is deployment-provided)"* — and the division `deps.queueGig` already implements for dispatch.

**Credential format.** The engine does not sniff prefixes to decide what a bearer is. The host
declares it, because the host issued it:

```ts
export interface CallerIdentity {
  kind: "member" | "player" | "venue" | "gig";
  gig_id?: string;   // present iff kind === "gig"
}
```

String-sniffing `ctk_` / `cdk_` would put a deployment's credential format inside the engine, where
it cannot be changed without a release. Declaring it keeps the format where it is issued.

---

## Gap 2 — the venue is the governed declaration surface, and it cannot declare a provider

This section follows existing prior art rather than inventing a shape. The vocabulary, the state
names, and the deny-by-default decisions below come from an internal design record for this exact
problem; the implementer should follow the existing `VenueSchema` grain in `src/genome_schema.ts`
and the existing `realize` gauntlet in `src/venue_realize.ts`, not a parallel scheme.

### What is true today

Most of the venue contract already exists, and it is good.

- **`VenueSchema`** (`src/genome_schema.ts:938`, `.strict()`) declares a room: `equipment.tools` (a
  deny-by-default tool allowlist, defaulting to the EMPTY room), `credential_surface` (which CLASSES
  of credential may legitimately be present — never material), `doors` (ingress/egress host
  allowlists, `*` refused), `installs` (digest-pinned), `lifecycle`, `responsible_chair`.
- **A room can only narrow a player.** `venueEffectiveTools` (`src/chart.ts:273`) intersects
  `allowed_tools ∩ equipment.tools`, and `composeChart` R10 (`src/chart.ts:548`) refuses a chart
  whose venue starves a seated agent, or whose venue slug resolves to nothing.
- **A chart names its room by slug** (`src/genome_schema.ts:857`).
- **Realization exists and is wired.** `resolveAndRealize` (`src/venue_realize.ts`) runs the ordered
  gauntlet — dead name, wildcard door, standing-without-cadence, install digest, credential breach,
  per-seat ceiling — and `runGig` calls it before the first chair (`src/runtime.ts:924`), threading
  the realized room onto every chair's context (`src/runtime.ts:2308`).
- **Two rooms ship**: `venues/empty-room-v1.json`, `venues/ci-deploy-room-v1.json`.

So the gap is not "there is no governed way to declare what a room holds". It is narrower and
sharper:

1. **A venue cannot declare an MCP SERVER.** `equipment.tools` may name `mcp__<server>__<tool>`, and
   nothing in the contract says what provides that server. The schema says so itself at
   `src/genome_schema.ts:~890`: *"Realization (building the room from the contract) and verification
   by behavioural probe are a lower layer and are not modelled here."* True when written; it is now
   the hole.
2. **Realization does not construct the spawn's MCP environment.** `src/venue_realize.ts` computes
   the ceiling, checks doors, installs, credentials and lifecycle — and returns no server config.
   The spawn's `--mcp-config` still comes from the AMBIENT map: `readMcpServerConfigs`
   (`src/server.ts:3170`) reading `.mcp.json` from the genome root at bootstrap. The comment at
   `src/server.ts:1123` states it plainly — *"dispatch preflight resolves against the invoker's
   environment"*. The environment, not the contract.
3. **On a drain, neither exists.** `workOnce` calls `runGig` with `mcpServerConfigs: {}` and sets no
   `venue` or `venues` at all (`src/worker.ts:936-943`). A drained gig therefore realizes NO room —
   the gauntlet never runs — and holds an empty provider map. `src/run_deps.ts:19-25` explains the
   empty map, and the reason is right: a drain's cwd is a freshly cloned, untrusted repository, and
   letting a clone declare MCP servers for the seat that reads it reintroduces exactly what
   `--setting-sources user` was added to close.

### Why it is a defect

The three facts compose into one: **a tool granted in a venue's `equipment.tools` can be absent from
the spawn's actual MCP environment, and nothing discovers it until use.** A server named in
`equipment.tools` passes R10 at compose time — R10 checks the tool-name intersection, which is a
different question — and is then resolved against a map the venue never saw.

Observed as: any standard whose chairs grant `mcp__<server>__*` tools runs on the operator's own
checkout and fails preflight everywhere else. The refusal is correct; the absence of any way to
satisfy it is the defect. The cage forces a choice between "an untrusted clone declares your tools"
and "no external tools at all", and ships the second.

### The contract

**1. The venue declares its servers.** `VenueSchema` gains `mcp_servers`, an optional array of a new
`McpServerDeclarationSchema`:

```
slug:             string   — matches the `mcp__<slug>__*` grant prefix
transport:        "stdio" | "sse"
command:          string[] — required when transport is "stdio"
url:              string   — required when transport is "sse"
credential_names: string[] — each MUST appear in this venue's `credential_surface`
env_names:        string[] — optional, non-secret env bindings
```

Zod-validated in the one `genome_schema.ts` source, no hand-edited `input_schema`, and the schema
stays `.strict()`. **A venue naming `mcp__notes__*` in `equipment.tools` with no `mcp_servers` entry
whose slug is `notes` fails to parse, naming the undeclared slug.** That single rule is what makes
"granted but unprovided" impossible to author, rather than merely detectable later.

`credential_names` referencing `credential_surface` is not decoration: `realize` already treats a
credential class present but undeclared as a `credential-breach` refusal, so a server that needed a
credential the room never declared would stand up a box every room then refuses.

**2. `realizeVenue` is a state machine, and it constructs the environment.** A new
`src/venue_realizer.ts` — the layer below `VenueSchema`, sibling to the existing
`src/venue_realize.ts` gauntlet:

```
realizeVenue(venue, credentialResolver, opts?) -> Promise<RealizationHandle>

EMPTY → PREPARED → VERIFIED → PLAYING → TORN_DOWN
                 ↘ FAILED (terminal, from PREPARED or VERIFIED)
```

- **PREPARED** — a per-gig tmpdir; for each `mcp_servers` entry, credentials fetched through
  `credentialResolver(credential_names)`, a server config built, and the per-gig mcp-config JSON
  written. **The ambient `.mcp.json` is never merged.** Engine server entries (`ENGINE_MCP_SERVER`)
  are ADDITIVE on top of the venue's declared servers — venue-declared servers are the base layer,
  engine tools are always present.
- **VERIFIED** — the probe. For each declared server, call the MCP `tools/list` method and assert
  BOTH directions:
  - every grant in `equipment.tools` prefixed for this server appears in the response, else
    `VenueRealizationError` carrying the missing grant and the server slug;
  - no returned tool is absent from `equipment.tools` — a venue WIDER than its contract — else
    `VenueContractViolation` carrying the extra tool and the server slug.

  Both halt before PLAYING and before any chair spawns. The second direction is the one a naive
  implementation omits, and it is the one that matters: a server that quietly advertises more than
  the room declared has silently widened the ceiling R10 spent its whole existence enforcing.
- **FAILED** carries the state it failed in plus the offending grant or violation detail. A state
  name without the offending name is a stack trace with extra steps.
- **The empty room traverses the whole machine spawning nothing.** `venues/empty-room-v1.json`
  declares no servers, so PREPARED writes only engine entries, VERIFIED probes nothing, and zero
  child processes are created. The bare case must stay free, or every venue-less gig pays for a
  feature it does not use.

**3. The drift guard.** `assertToolGrantsResolvable` must receive `handle.mcpServerConfigs` — the
realized per-venue map merged with engine entries — and **never** the ambient map. The internal law
is reference identity: the object preflight resolves against is the object the spawn is configured
from. Two objects that agree today are two objects that can disagree tomorrow, which is exactly what
`resolveAgentGrants` (`src/tool_providers.ts:138`) was written to prevent one layer up.

**4. The drain realizes.** `workOnce` reads the venue slug from the claimed gig's chart (defaulting
to the empty room when absent), resolves the venue from the genome, realizes it before running, and
tears down in a `finally`. A `VenueRealizationError` or `VenueContractViolation` marks the gig
failed and is not retried — a contract that cannot be fulfilled will not be fulfilled on a second
attempt.

### Left to the deployment

**`CredentialResolver` is the boundary, and it is the whole of it.** The genome declares credential
CLASSES; the resolver binds names to values at realization time. Env-var-backed locally, secrets
manager in production — the engine cannot tell and must not be able to. Secrets never live in the
genome, which is why `credential_surface` was defined as a list of names and never a place material
could sit.

This is the same division `src/tool_providers.ts:9` already states for MCP servers — *"The OSS
engine ships this RESOLUTION machinery; a deployment registers the actual server config"* — with the
registration moved from an ambient file to a governed contract.

### Explicitly out of scope

Named so the implementer does not widen the change: containerization (isolation stays a node
subprocess); kernel-level enforcement of `doors` (enforced at the MCP server layer, as the
playwright cage enforces `--allowed-origins`); a concrete secrets backend; standing-venue caching
across gigs; hermetic install execution (the `installs` shape may extend, the install process does
not); any change to compose-time R10.

### Open — provider credentials per gig, not per box

`CredentialResolver` says WHERE a credential comes from. It does not say how long the worker holds
one, and the difference matters: a worker holding one long-lived credential per provider defeats the
venue design as thoroughly as a long-lived git token did.

The repo already contains the right pattern. `src/workspace.ts:60-89` obtains a per-gig git
credential from a broker endpoint against a **live lease** — not at boot, not in the container's
environment, not the same one twice — and hands it back when the gig ends. A drain between gigs holds
no git credential at all.

Provider credentials should have that shape, resolved per realization and released at teardown.
**This spec deliberately does not specify it.** The endpoint shape and the scoping rule are open.
What is closed is the direction: a provider credential fixed in the box's environment at
provisioning is the defect `src/workspace.ts` was written to remove, and reintroducing it under a
new name is not an implementation detail.

---

## Gap 3 — one variable, three contracts

### What is true today

`COLTRANE_DRAIN_URL` is read by three callers that do not agree on what it names. Two treat it as
the database's PostgREST base; one treats it as the Coltrane service origin. The variable's own
source comment said **"ONE VARIABLE, TWO CONTRACTS"** — and the count was already wrong when it was
written, because a third reader existed and nobody had looked.

`0.10.0` settled the meaning (it names the service) and added a diagnostic at
`src/output_mirror.ts:331`. It did not settle the NAME, and it did not move the check to startup.

### Why it is a defect

Read the failure sequence, because every step of it looked like a fix:

- **Pointed at the database.** Row writes succeeded — the definer RPCs are anon-exposed — while the
  artifact upload answered 401 indefinitely. The only symptom was a missing blob, which reads like a
  storage-permissions problem. Two days.
- **Repointed at the service.** The writes worked. Boot-time provisioning broke, sitting in a retry
  loop against an HTTP 307 — a web framework's router answering a request meant for PostgREST.
- Each fix was correct and moved the failure somewhere else, because the variable had never named
  one thing.

`0.9.4`'s changelog entry contains the general statement: *"a variable whose meaning depends on who
reads it will drift again the moment a third caller appears — which is exactly how this happened."*
That is true and the repair it shipped (accept both shapes) treated the symptom. The name is the
defect.

### The contract

1. **One variable names one host and means one thing.** A worker reaches two hosts — a database and
   a service — so that is two variables, each named for what it is:

   | canonical | host | replaces |
   |---|---|---|
   | `COLTRANE_STORE_URL` | the database's PostgREST base | — |
   | `COLTRANE_SERVICE_URL` | the Coltrane service origin | `COLTRANE_DRAIN_URL` |

   `COLTRANE_DRAIN_URL` is named for a ROLE, not a host, which is how it came to hold both. It is
   demoted to a legacy alias: tolerated, normalized onto `COLTRANE_SERVICE_URL`, and never the
   canonical name of anything.

2. **Startup validation, in the worker's own voice.** `assertWorkerEnv(env)` runs before the first
   request and refuses with a message NAMING the misconfiguration:
   - a required variable absent → named;
   - `COLTRANE_SERVICE_URL` naming a database host → refused, in the worker's words, not
     rediscovered from a 401 at first write;
   - `COLTRANE_STORE_URL` and `COLTRANE_SERVICE_URL` naming the SAME host → refused, naming both.
     This is the exact shape of the failure above, and it is detectable without knowing which one is
     wrong.
   - the legacy alias present AND disagreeing with the canonical name → refused, naming both. Two
     names for one host that disagree is the bug in its purest form; picking a winner silently is
     how it survives.

3. **Tolerate legacy by NORMALIZING, never by appending.** `normalizeWorkerEnv(env)` maps the legacy
   shape onto the canonical one and is idempotent. `src/output_mirror.ts:317-320` already states the
   reason: *"every path above is built from the ORIGIN, so a suffix that survives cannot silently
   produce `/rest/v1/rest/v1/…` the way appending to it did."* Appending is what produced the doubled
   path segments; normalization is the general form of the fix.

4. **One documented place.** `WORKER_ENV_CONTRACT` in `src/worker_env.ts` enumerates every variable
   the worker path reads, each with its host, its role, whether it is required, and a one-sentence
   meaning. The law that gives it teeth is a completeness law: every `process.env[…]` read in the
   worker-path modules must be enumerated there. A contract that documents a subset is the same
   defect one layer up.

### The worker environment contract

The table the engine must ship, as `WORKER_ENV_CONTRACT`. Each entry carries a `host`
(`service` | `store` | `none`), a `role` (`url` | `credential` | `identity` | `tuning`), a
`required` (`always` | `venue` | `player` | `conditional` | `never`), a one-sentence `meaning`, and
optional `legacy_names`. Only a `url` or a `credential` may name a host — a tuning knob that claims
one is the category error this gap is made of.

| variable | host | role | required | meaning |
|---|---|---|---|---|
| `COLTRANE_STORE_URL` | store | url | always | the database's PostgREST base; the claim path speaks here |
| `COLTRANE_STORE_ANON` | store | credential | always | the project's anon key; transport for the claim RPC |
| `COLTRANE_SERVICE_URL` | service | url | always | the Coltrane service origin; every drain write goes here |
| `COLTRANE_DRAIN_KEY` | service | credential | venue | the venue credential, presented as a bearer |
| `COLTRANE_INSTANCE` | — | identity | venue | which venue this box is; the key is bound to it |
| `COLTRANE_AGENT_TOKEN` | store | credential | player | a seated player's own token |
| `COLTRANE_GIT_CREDENTIALS_URL` | service | url | conditional | the per-gig git credential broker; needed when the org names a repository |
| `COLTRANE_TOOL_PROVIDERS` | — | tuning | never | the trusted provider source (Gap 2) |
| `COLTRANE_DRAIN_BUCKET`, `COLTRANE_DRAIN_OPENING`, `COLTRANE_GIG_TIMEOUT_MS`, `COLTRANE_CHAIR_TIMEOUT_MS`, `COLTRANE_MODEL`, `COLTRANE_MIRROR_DIR`, `COLTRANE_WORKER_CHECKPOINTS`, `COLTRANE_WORKER_STATE_TTL_DAYS`, `COLTRANE_DRAIN_PG` | — | tuning | never | bounded overrides; each documented at its read site |

Legacy names, tolerated and normalized: `COLTRANE_DRAIN_URL` → `COLTRANE_SERVICE_URL`;
`FLY_APP_NAME` → `COLTRANE_INSTANCE`.

`FLY_APP_NAME` deserves its own sentence. It is read as an instance fallback
(`src/cli.ts:218`) because one hosting provider sets it for free, and the convenience is real. It is
also a provider-specific name inside a provider-agnostic engine, and it means a box can acquire a
venue identity nobody set. Keep it, list it as a legacy alias so it is visible, and prefer an
explicit `COLTRANE_INSTANCE` everywhere a deployment is written down.

### Left to the deployment

Every VALUE. The engine names the variables, states which host each addresses, and refuses a set
that cannot be right. It bakes in no host, no origin, and no default for anything that names one.

---

## Gap 4 — three ways to run a standard, no single story

> Where there are two or three ways of doing something and there should be one, codify the language.

### What is true today

Three ways to execute a standard, with different genome sources, different credentials, and no
document reconciling them:

| # | how | genome from | credential | who runs it |
|---|---|---|---|---|
| 1 | `coltrane run` / `coltrane dispatch` | local files (`bootstrapServerDeps`) | none | this process |
| 2 | `coltrane work` | the store, on the claim | venue credential **or** player token | this process |
| 3 | `gig_dispatch` on the MCP surface | the store | the caller's bearer | whichever worker claims it |

And mode 2 itself accepts two credential shapes with materially different semantics
(`src/cli.ts:203-232`, `src/worker.ts:298-363`):

- **venue** — org-scoped, instance-bound. The store mints a per-gig credential on each claim, so the
  worker holds nothing between gigs.
- **player** — one agent's own token, held for its lifetime, claiming only what its own chairs
  authorize.

Both are legitimate. Nothing states when each is correct, and there is no documented way to obtain
either — which is Gap 1.

### Why it is a defect

The condition selecting the mode is derived in two places. `src/cli.ts:219` computes
`venueMode = Boolean(drainKey && instance)`; `src/worker.ts:320` re-derives
`ctx.drainKey && ctx.instance` at the claim. They agree today. `src/worker.ts:345-356` exists
*because* they might not — a comment explaining that if the instance is lost anywhere downstream of
the CLI guard, the worker would present an empty bearer to the store. That defensive branch is the
correct response to a condition with two homes, and the better response is one home.

### The contract

1. **The modes are named, and the naming is single-sourced.**

```ts
export type WorkerCredentialMode =
  | { mode: "venue";  drainKey: string; instance: string }
  | { mode: "player"; agentToken: string }
  | { mode: "none";   why: string };

export function workerCredentialMode(env): WorkerCredentialMode;
```

   - **Venue wins when both are present.** A box holding both is a drain that also happens to carry a
     player token; the venue credential is the correct one and the player token should not be used.
     Codified rather than left to call-site order.
   - **A venue key with no instance is a misconfiguration, not a downgrade** — even when a player
     token is present. Today that combination silently selects player mode, and a box provisioned as
     a venue then claims a DIFFERENT set of gigs under a DIFFERENT identity. The operator sees a
     queue that merely looks empty, which is the symptom already on record at `src/worker.ts:305`,
     arrived at from the other direction. Refuse, and name `COLTRANE_INSTANCE`.
   - **`why` is the refusal.** When the mode is `none`, `why` says what is missing in one sentence,
     and the CLI PRINTS IT rather than composing its own. One question, one answer, one wording.
   - **The answer carries its fields.** `{mode:"venue"}` alone makes the caller re-read the
     environment for the key and the instance, which is the second derivation coming straight back.

2. **The default recommendation is venue mode.** A drain should hold the venue credential: it claims
   any gig dispatched to its org and runs each as that gig's own `acting_for`
   (`src/cli.ts:224-225`). Player mode is correct for exactly one case — a human or agent running a
   worker as THEMSELVES, claiming only what their own chairs authorize. It was only ever wrong for a
   drain forced to be one (`src/worker.ts:313`).

3. **The credential story, in one place.** Venue credentials are obtained with
   `venue_credential_mint` (Gap 1), which also returns the environment. Player tokens are issued to a
   seated agent by the store; a worker holding one is acting as that agent and inherits its chairs.
   Neither is obtained through a browser.

4. **Consolidation, concretely.**
   - **`coltrane dispatch` and `coltrane run` should be one verb.** They are two names for "run a
     local-file genome in this process". Keep `dispatch` — it is the word the MCP surface, the store
     and the ledger already use — and make `run` an alias that says so.
   - **`gig_dispatch` should be the only thing that decides WHERE work runs.** It queues; a worker
     claims. Local dispatch is the special case where the queue has one consumer and it is this
     process. That is already how the code is shaped; it is not how the CLI reads.
   - **Deprecate the `FLY_APP_NAME` instance fallback** in favour of an explicit `COLTRANE_INSTANCE`
     (Gap 3). Tolerate, warn, and stop documenting it.
   - **`COLTRANE_STORE_ANON` on the claim path is the remaining inconsistency**, recorded in
     `0.10.0`'s changelog rather than hidden. The write path holds one credential; the claim path
     still reaches PostgREST directly and needs a project key. The single story is the write path's:
     one credential, to the service. Moving the claim behind the service seam removes the second
     credential from the box entirely. Not specified here — it needs a store-side endpoint — but it
     is the direction, and no new caller should be added to the PostgREST path.

### Left to the deployment

Which mode a given box runs in, and the issuance policy behind each credential. The engine states
what the modes ARE and answers "which one is this worker in" from one function.

---

## Gap 5 — the claim does not filter by the venue a gig's chart already names

### What is true today

The concept exists. `ChartSchema.venue` (`src/genome_schema.ts:857`) names the room a performance is
held in, by slug; `composeChart` R10 refuses a dead slug or a room that starves a seated agent; and
`runGig` resolves and realizes it before the first chair (`src/runtime.ts:924`). A chart already
says where it wants to be run.

**The claim does not read it.** `claimNextGig` (`src/worker.ts:319`) takes ANY queued gig of the
organization: selection is by org, well-formedness, and age. There is no venue predicate on the gig
row or in the claim RPC. And the drained run does not realize the room either — `workOnce` passes no
`venue`/`venues` to `runGig` at all (`src/worker.ts:936-943`), which is Gap 2's third fact.

`gig_dispatch` (`src/mcp.ts:146`) likewise carries no venue, and neither queue seam
(`src/genome_store.ts:493`, `:527`) forwards one — so even a store that wanted to filter has nothing
on the row to filter on until it loads and resolves the chart.

### Why it is a defect

A gig can be claimed by a worker that cannot realize its venue. Once Gap 2 lands, that worker fails
at construction — correctly, loudly — while a worker that CAN realize the room sits idle. Today it
is worse and quieter: the drain realizes nothing, so the room's ceiling, doors and credential
surface are simply not applied to a drained run.

Work cannot be routed. In practice the only way to make a gig run somewhere specific is to stop
every other worker, which is what a missing predicate looks like from the operator's chair.

### The contract

1. **The venue travels on the row.** `gig_dispatch` advertises `venue?: string`, and both queue
   seams forward it (`p_venue`, explicitly `null` when unnamed — an omitted key and a null are
   different statements to a store, which is why `p_acting_for` is already passed this way at
   `src/genome_store.ts:547`). For a chart dispatch it is the chart's own `venue`; for a bare
   standard dispatch it is whatever the caller names, or nothing. **Surfacing, not inventing**: the
   value is a `VenueSchema` slug, the same one R10 already checks.

2. **A worker states which rooms it can realize, and the claim honours it.** The engine ships the
   predicate:

```ts
export function venueMayClaim(
  gigVenue: string | null | undefined,
  realizable: readonly string[] | undefined,
): boolean;
```

   - a gig naming NO venue is claimable by any worker — including one that declares nothing;
   - a gig naming a venue is claimable only by a worker that can realize that venue;
   - the predicate is total and pure, so the claim, the worker-side check and any store-side gate
     share one oracle rather than three implementations of one rule. That is the reason
     `resolveAgentGrants` (`src/tool_providers.ts:138`) exists one layer down.

3. **Unnamed stays unnamed.** Targeting must not become mandatory routing. The moment every dispatch
   needs a venue, a queue with no matching worker is a silently stalled queue — strictly worse than
   the state being fixed. The empty room is the default a chart falls back to, and the empty room is
   realizable everywhere.

4. **A mis-routed claim fails loudly.** If a claim payload names a venue this worker cannot realize,
   the worker refuses it by name rather than running it. The store deciding correctly is the primary
   control; this is the worker declining to act on a decision it can see is wrong, and it names both
   sides so the operator learns which is misconfigured. The consequence is the one already accepted
   at `src/worker.ts:330-339`: the row stays leased until its lease expires. Stalling one row for one
   lease window is the correct price for not running work in a room this box cannot stand up.

### Interaction with Gap 2

These are one feature with two halves. Gap 2 makes a room's providers real; Gap 5 is how work
reaches a worker that can build that room. Shipped without Gap 2, routing distinguishes boxes that
differ only by name. Shipped without Gap 5, heterogeneous rooms exist and nothing can be aimed at
them — and the first worker to poll takes a gig it will fail to realize.

### Left to the deployment

The queue predicate itself. The store decides which row a claim returns, and it is the only thing
that CAN, because it holds the queue. The engine supplies the column's meaning, the dispatch
argument, the worker's declaration of what it can realize, and the shared predicate.

---

## RED → GREEN

**48 laws across five files, all failing.** That is the deliverable, not an accident.

| file | gap | laws |
|---|---|---|
| `tests/spec_venue_credential_mint.test.ts` | 1 | 10 |
| `tests/spec_venue_realization.test.ts` | 2 | 10 |
| `tests/spec_worker_environment.test.ts` | 3 | 14 |
| `tests/spec_worker_run_modes.test.ts` | 4 | 9 |
| `tests/spec_venue_targeting.test.ts` | 5 | 5 |

- **CI is expected to be red until these are implemented.** Every file opens with a banner saying
  so. A failure whose file is named `spec_*` is pending implementation; a failure anywhere else is a
  regression. That is the whole reason for the naming convention — a reader should be able to tell
  them apart at a glance, without reading the diff. As landed: `vitest run` reports
  **48 failed, 2626 passed**.
- **The imports are the specification.** Where a module or export does not exist yet, the test names
  it anyway and fails on the missing binding.
- **`npx tsc --noEmit` is CLEAN, deliberately.** The obvious way to write these tests is a static
  import of a module that is not there, and it is wrong here: this repo's vitest `globalSetup` runs
  `npm run build` first, so ONE compile error stops every band from running and nobody can tell a
  pending spec from a regression. So the two not-yet-existing modules are loaded through a specifier
  held in a `const`. tsc stays clean; the red lands at runtime, on the law that needs the module,
  naming it. Each law fails on its own line with its own message rather than taking the file down at
  link time.
- **The job is to make them pass without weakening them.** No `it.skip`, no relaxed matcher, no
  deleted assertion, no `.js` specifier quietly deleted. If a law is wrong, the argument for
  changing it belongs in a diff to this document first — the laws are downstream of the reasoning,
  not a substitute for it.
- **Done looks like:** `npm run verify` green, `SPEC-worker-contract.md` still accurate, and the
  five `spec_*` files unchanged except where the spec itself changed with an argument attached.

Each law states the property, not the implementation. Where a law reads source text
(the environment-completeness law), it does so for the same reason
`tests/advertised_args_are_read.test.ts` does: the property is about a declaration matching what the
code does, and nothing but the code can testify to the second half.

Under this repo's inverted semver — while the major is `0`, **minor = breaking**, **patch =
additive** — landing all five is a **minor** bump. Gaps 1, 2 and 5 are additive; Gap 3 is not. A
worker whose environment names the wrong host boots today and refuses afterwards, which is the whole
point and is still a break.

---

## What this document does NOT specify

Honest gaps, listed so nobody mistakes silence for a decision.

- **Provider credentials per gig.** `CredentialResolver` is specified as the boundary; how long a
  worker holds what it resolves is not. Direction stated (per-gig, brokered against the lease,
  following `src/workspace.ts`); shape deliberately open. See Gap 2.
- **Pinning a gig to a venue INSTANCE.** Gap 5 routes on the venue — the room — because that is what
  a chart names and what a worker either can or cannot build. "Run this on THAT box" is a different
  question with a different answer, and answering both with one field is how a name comes to carry
  two contracts. Not specified.
- **Anything below the realization boundary.** Containerization, kernel-level enforcement of
  `doors`, hermetic install execution, standing-venue caching across gigs. Named in Gap 2 as out of
  scope so the implementer does not widen the change into them.
- **The store schema.** No column names, no RPC signatures, no migration. The engine names
  arguments and their meaning; the store's shape is the deployment's.
- **Who may mint a venue credential.** Deliberately absent from the engine. The engine refuses a
  gig-scoped credential because that is a structural fact about credential scope, not a policy. Every
  other question — which members, which orgs, how many instances — is store-side, and an engine that
  answered it would be answering for deployments it cannot see.
- **Instance identity.** Whether an instance name is per-app or per-machine is a deployment choice
  with real consequences, already reasoned at `src/worker.ts:73-81` and `src/cli.ts:211-216`. This
  document does not settle it and should not.
- **Moving the claim path behind the service seam.** Named as the direction in Gap 4; needs a
  store-side endpoint that does not exist. Not specified.
- **Migration for the legacy variable name.** `COLTRANE_DRAIN_URL` is tolerated and normalized. How
  long, and whether a warning becomes a refusal, is a release decision this document leaves to the
  changelog.
