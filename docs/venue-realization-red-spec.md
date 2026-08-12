# The venue realization RED spec — the effects boundary made real

A venue is today a two-thirds-built control. The DECLARATION and the COMPOSE-TIME check are real
and tested (`VenueSchema`, `venueEffectiveTools`, `composeChart` R10, the loader, the MCP surface).
The runtime is not: the code path that spawns a chair (`src/claude_invoker.ts`) never consults a
venue. This spec is the falsifiable RED contract that a later implementation gig turns green — it
turns each venue obligation into a currently-failing axiom. It does NOT implement the enforcement.

## The gap, read from the tree

- `src/chart.ts:273` `venueEffectiveTools(agent, venue)` already computes `allowed_tools ∩
  equipment.tools`, but its ONLY caller is `composeChart` R10 (`src/chart.ts:548`), which uses it to
  prove EMPTINESS at author time. The non-goal at 519–522 states it deliberately does not apply the
  intersection to anything. Computed and discarded.
- `src/claude_invoker.ts:877` passes `allowed_tools: effectiveAllowed` — the agent's full resolved
  grants — straight into `buildInvokerArgs` → the child's `--allowedTools`. No venue intersection on
  this path. The ceiling is UNINTERSECTED at the boundary that actually spawns the child.
- `src/claude_invoker.ts:969` spawns the child as `spawn(bin, [...args], { stdio })` with no `env`
  option, so it inherits the full parent `process.env`. `credential_surface` is inert at runtime: an
  undeclared credential is neither refused nor stripped, it is simply present.
- There is no `realize` step, so `doors.egress`, install digests, per-gig isolation, lifecycle
  teardown, and `responsible_chair`-on-a-realized-record have no runtime existence. The schema's own
  comment (`src/genome_schema.ts:609-614`) names this the deliberately-deferred lower layer.

## The realize contract this spec pins (asserted, not implemented)

```
realize(venue: Venue, opts: RealizeOpts): Realization | Refusal
resolveAndRealize(slug: string, opts: RealizeOpts & { venues: Map<string, Venue> }): Realization | Refusal

RealizeOpts = {
  seats: { agent: Agent }[],
  ambientEnv: Record<string, string>,
  credentialsPresent?: string[],          // credential CLASSES detected in the ambient environment
  installsPresent?: { ref: string, digest: string }[],
  gigId: string,
}
Realization = {
  ok: true,
  seats: { agent_slug: string, effective_tools: string[], env: Record<string, string> }[],
  provisioned_credentials: string[],
  canReach(host: string): boolean,        // egress probe — observable, mechanism-agnostic
  canAccept(origin: string): boolean,     // ingress probe
  isolation_handle: string,
  responsible_chair?: string,
  lifecycle: { policy: 'ephemeral' | 'standing', rebuild_cadence?: string },
  tornDown(): boolean,
  teardown(): void,
}
Refusal = { ok: false, refusal: { code: RefusalCode, detail: string } }
RefusalCode = 'ceiling-empty' | 'credential-breach' | 'install-digest-mismatch'
            | 'standing-without-cadence' | 'wildcard-door' | 'unknown-venue'
```

The invariant the spec asserts is OBSERVABLE (no destination outside `doors.egress` is reachable),
not the mechanism (OS process + network namespace/proxy vs container vs microVM). That substrate is
the implementation pipeline's choice — an open question the RED contract deliberately leaves open.

## Obligations, mechanisms, callsites

| # | Obligation | Mechanism (asserted) | Callsite the impl binds to | Red test |
|---|---|---|---|---|
| O1 | Add fast-check devDependency | property engine present | `package.json` | import failure across all property files |
| O2 | `realize(contract)->realization` | single mediating boundary | new `src/venue_realize.ts` | every venue test imports it |
| O3/O5 | Ceiling applied to spawn | `venueEffectiveTools` → `--allowedTools` | `claude_invoker.ts:877` | `venue_ceiling.property` I1, `venue_boundary` I18 |
| O4 | Preflight/spawn agree | same resolution path | `claude_invoker.ts:778` | `venue_boundary` I3 |
| O6 | Empty equipment ⇒ empty spawn | deny-by-default | `empty-room-v1` | `venue_ceiling.property` I4 |
| O7/O8 | Env allowlist; undeclared = breach | default-deny env, refuse-not-strip | `claude_invoker.ts:969` | `venue_credentials.property` I5, I6 |
| O9/O10/O11 | Egress/ingress allowlists | deny-by-default hosts | `doors` | `venue_doors.property` I7, I8, I9 |
| O12 | Install digest verified | refuse on mismatch/absence | `installs` | `venue_installs.property` I10 |
| O13/O14 | Per-gig isolation + teardown | isolation handle, residue-free | realization | `venue_realization.model` I12, I13, I14 |
| O15 | Standing cadence | refuse snowflake | `venueDefect` | `venue_realization.example` I15 |
| O16 | Accountability carry | verbatim stamp | realization | `venue_realization.example` I11 |
| O17 | Dead venue fail-closed | refuse unknown slug | `resolveAndRealize` | `venue_realization.example` I17 |
| O18 | No wildcard door | refuse at parse AND realize | `HostSchema` | `venue_realization.example` I16 |

## Verification method

fast-check (added as a devDependency — the first RED obligation, since none exists per
`package.json:95-101`) expresses the universal invariants as generated `for all` properties with
shrinking to a minimal counterexample: the ceiling axiom, the credential-breach/allowlist axioms,
the egress/ingress allowlist axioms, the install-digest axiom. fast-check model-based testing
(`fc.commands` + `fc.modelRun`) covers the stateful realize/attempt/teardown sequence and asserts
the real realization never permits what the declared model forbids. Example-based Vitest tests pin
the specific shipped instances (`ci-deploy-room-v1`'s vercel-token-only surface, `empty-room-v1`'s
zero-tool/zero-egress room, the `responsible_chair` carry, the standing-cadence refusal).

Prior art grounding each half: object-capability / POLA default-deny (the tool ceiling and env
allowlist), Kubernetes deny-by-default egress NetworkPolicy (the doors), Docker pull-by-digest
immutability (the installs), HashiCorp Vault short-lived scoped dynamic secrets (per-gig credential
provisioning). Each is a standard production control, not a coltrane invention.

## Status

RED. Every file fails at import (fast-check absent and/or `src/venue_realize.ts` absent). No
assertion is a tautology — the ceiling tests assert against the existing `venueEffectiveTools`
