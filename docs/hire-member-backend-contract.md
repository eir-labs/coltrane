# `deps.hireMember` — the admission backend a deployment implements

`org_hire` admits an agent to an organization. The engine ships the verb, its schema, its typed
refusals and its ledger seal; **it cannot write the membership row**, because that row lives in an
org store behind RLS the engine cannot see. This document is the contract for the half a deployment
supplies.

It is the org-membership analogue of `deps.mintVenueCredential`, and the same reasoning applies:
*a decision about who may hire belongs to a deployment this engine cannot see.*

## The signature

```ts
hireMember?: (args: { org_slug: string; agent_slug: string }) => Promise<HireMemberResult>

type HireMemberResult =
  | { ok: true }
  | { ok: false; code: "unknown_agent" | "already_member" };
```

Wire it onto `ToolSurfaceDeps` where you mount `createToolSurface`, beside `queueGig` and
`mintVenueCredential`. Absent, every `org_hire` call returns a typed `no_backend` refusal — the verb
answers honestly rather than pretending a hire happened.

## What the engine has already done before it calls you

You may assume all of this:

| decided by the engine | how |
|---|---|
| the caller is a **human member** | `CallerIdentity.kind === "member"`. Every agent-token kind — `player`, `venue`, `gig` — is refused `not_a_human_member` **before** you are reached. Hiring is never self-service. |
| your backend exists | absent → `no_backend`, you are never called |
| the input shape | validated against `OrgMemberSchema` = `{org_slug, agent_slug}` and nothing else |

## What you decide — exactly two things

These are the only two facts the engine cannot know, because **only the store holds them**:

1. **Does an `agent_record` with that slug exist?** No → `{ ok: false, code: "unknown_agent" }`.
   A dead name must fail closed, exactly as an unresolvable tool grant does at dispatch.
2. **Is that agent already a member of this org?** Yes → `{ ok: false, code: "already_member" }`.
   This is an **error, not a silent no-op** — a governance surface must surface a duplicated hire
   rather than mask a member's mistake.

Otherwise: insert the membership row and return `{ ok: true }`.

## What you must not do

- **Do not create chairs, assignments, or capability grants.** Admission is *belonging*; authority is
  *seating*. A chair carries `caps`, an assignment binds an agent to a chair, and a credential
  presented by an incumbent may only **narrow** what the chair grants. A backend that admitted *and*
  granted would make `org_hire` a path to mint authority in one call, and that narrowing invariant
  would lose its floor. **Membership does not let anyone dispatch anything.**
- **Do not check the `agent_record`'s status.** `existence` is the only precondition. `proposed`,
  `named` and `active` are all hireable, because governance and naming are separate acts — the
  schema says *"nothing is active until governed so"* **and** *"'named' is sealed through the naming
  ceremony"*, and `coltrane-proposer` is `active` having never been `named`.
- **Do not throw for the two named cases.** Return the typed struct. A throw is caught and returned
  as a generic error, and the refusal code — the thing a client branches on — is lost.
- **Do not insert under a service role.** The insert should run under the caller's own authority so
  the store's RLS policies decide, not the backend.

## After you return `{ ok: true }`

The engine seals a `kind:"genome_mutation"` ledger row via `recordIdentity` (ledger-only — a hire
writes no genome file) **before** reporting success: `subject_slug` is the agent admitted, `event` is
`org_hire`, and `org_slug` rides in the hashed detail. A **refused** hire seals nothing, so the chain
never records an admission that did not happen.

**One operational subtlety worth knowing.** The seal happens *after* your insert. If the audit write
fails, the engine returns `audit_write_failed` and says so plainly rather than reporting a success
whose seal never landed — but **your row may already exist at that point**. Make the insert safe to
retry, or expect an operator to reconcile one row against a missing ledger entry.

## Verifying your implementation

The engine half is already pinned by `tests/org_hire_is_governed.test.ts` (13 laws). For your half,
the four cases worth an integration test:

- a member hiring an existing, non-member agent → `{ok:true}`, row present, ledger row present
- a member hiring an unknown slug → `{ok:false, code:"unknown_agent"}`, **no row**, **no ledger row**
- a member hiring an existing member → `{ok:false, code:"already_member"}`, no second row
- an agent token attempting a hire → refused `not_a_human_member` **without reaching your backend**

## What this still does not give you

A member is not a seat. After a successful hire the agent belongs to the org and **still cannot
dispatch**. To let it run standards it needs a chair carrying
`{"grant": "dispatch", "standards": [...]}` and an assignment binding it — a separate governed act,
deliberately not part of this verb.
