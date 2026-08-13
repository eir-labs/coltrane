# The venue's walls RED spec — a declared workspace, an isolation floor, and ports

The venue realization boundary (`src/venue_realize.ts`) already enforces the tool ceiling, the
doors, the credential surface, the install digests, the lifecycle, and the accountable office. It
says NOTHING about **where a seated chair may write, how strong the wall around it must be, or what
ports its gig may bind.** This spec completes the room along that axis. It is the falsifiable RED
contract a later implementation gig turns green — each obligation is a currently-failing assertion
against the real callsite. It does NOT implement the enforcement; it makes the absence FAIL.

## The gap, and what it cost

`VenueSchema` had zero hits for `workspace`, `cwd`, `filesystem`, or `worktree`. So a seated chair's
write target was undeclared and defaulted to the host's working tree. The cost was four failures in
one session, one root cause — concurrent gigs sharing one working tree: interleaved writes; a run
verified against another change-set's stubs; a spec branch that captured a stale snapshot and
conflicted at merge; and — the governance failure — unreviewed implementation code sealed inside a
spec PR, because the spec seat sealed whatever was staged when it ran. Hand-driven git worktrees
fixed the cooperative case but are a convention, not a wall.

## What ships (additive), and where

### Schema — one Zod source (`src/genome_schema.ts`)

- `IsolationCapabilitySchema` — the orthogonal capability set a floor may demand
  (`filesystem-boundary` · `network-namespace` · `pid-namespace` · `distinct-credential-surface`).
  Orthogonal, not a ladder, because macOS offers a private directory but no namespaces — a ladder
  would conflate independent walls.
- `VenueWorkspaceSchema` — `{ isolation_floor: IsolationCapability[] }`, optional on the venue.
  **Deny-by-default:** an absent workspace yields a private ephemeral tree (the WORKTREE strategy),
  never the host's cwd. The schema comment states the WORKTREE strategy's limits so its
  convention-not-wall status is declared, not discovered: worktrees share one `.git` object store
  and ref namespace (and config, hooks, stash); the process table is shared; ports are shared; and
  there is no filesystem boundary.
- `VenuePortsSchema` — `{ count? , range?, named? }`, optional. A bind-port need — a thing `doors`
  (an ORIGIN allowlist) structurally cannot express.
- `VenueSchema` gains `workspace?` and `ports?`. Both optional ⇒ every shipped venue loads and
  composes unchanged; the MCP `venue_define` surface stays generated from the schema (no drift).

### Realizer seam (`src/venue_realize.ts`)

- `RefusalCode` gains `isolation-floor-unmet` and `port-exhausted`, joined to the existing ordered
  gauntlet BEFORE the per-seat ceiling (structural room soundness precedes a seat's judgement;
  existing codes retain precedence).
- `RealizationOk` gains `workspace?: RealizedWorkspace` (path · strategy · ephemeral) and
  `ports?: number[]` (the concrete assigned ports). `RealizeOpts` gains a DECLARED
  `hostProfile?: HostCapabilityProfile` (never a runtime probe — the suite stays host-independent)
  and `portsHeld?: number[]`.
- Strategy seam behind the one contract: `selectStrategy(floor, host)` chooses the cheapest strategy
  whose capabilities ⊇ the floor, or returns null ⇒ the caller refuses `isolation-floor-unmet`
  (fail closed, never a silent downgrade). `strategyCapabilities(strategy)` is the WORKTREE |
  SANDBOXED-PROCESS | CONTAINER capability map; CONTAINER and microVM are the specified-but-stubbed
  seam (throwing signatures, so the tree compiles and RED comes from an absent body). `isContained`
  and `sealTouchesOnlyWorkspace` are the containment predicates; `allocatePorts(need, held)` assigns
  disjoint ports or refuses on exhaustion.
- **Runtime wire (`src/runtime.ts`):** `resolveAndRealize` runs once before the first chair and
  already aborts the gig closed on any refusal. The implementation gig threads the DECLARED host
  profile in, and threads the realized `workspace` path (as the spawn cwd) and assigned `ports` onto
  each chair's ctx.

### The declared divergence

`works locally` (a macOS dev host: no namespaces ⇒ WORKTREE) and `works on drain` (a Fly microVM: a
real Linux kernel ⇒ a hard floor is meetable) may LEGITIMATELY diverge. That is a declared property
of the venue — the same venue refuses on the cheap host and realizes on the microVM — not a surprise
found at 2am. Stated in the `VenueWorkspaceSchema` comment.

## Out of scope (seam only)

Building the CONTAINER or microVM realizers, or any hypervisor / Firecracker / gVisor work — only
the seam and the two strategies this repo can honestly exercise (WORKTREE, SANDBOXED-PROCESS) ship.
Actual network-namespace **egress** enforcement (once a gig's network is its own namespace,
`doors.egress` becomes enforceable at the interface rather than advice) is NAMED as the follow-on,
not built here. No change to the tool-grant ceiling, browser cage, or credential surface.

## Obligation → mechanism → callsite → red test

| Obligation | Mechanism | Callsite | Red test |
|---|---|---|---|
| Declared deny-by-default workspace (absent ⇒ private ephemeral tree, not cwd) | `RealizationOk.workspace`, worktree default | `src/venue_realize.ts` `realize` | `tests/venue/venue_workspace.property.test.ts` INV1, INV3 |
| Workspace is a containment boundary | `isContained` / `sealTouchesOnlyWorkspace` | `src/venue_realize.ts` | `venue_workspace.property.test.ts` INV2, INV16 |
| Cross-gig workspace disjointness | per-gig realized path | `realize` | `venue_workspace.property.test.ts` INV8 |
| Isolation floor fails closed, never downgrades | `selectStrategy` → `isolation-floor-unmet` refusal | `realize` gauntlet | `tests/venue/venue_isolation_floor.property.test.ts` INV4, INV5 |
| Host-independence — refusal asserted, never skipped | declared `hostProfile` | `realize` | `venue_isolation_floor.property.test.ts` INV14 |
| Port allocation is part of realization | `allocatePorts`, `RealizationOk.ports` | `realize` | `tests/venue/venue_ports.property.test.ts` INV6, INV7 |
| Teardown residue-free & non-interfering across gigs | `teardown` / per-call closure | `realize` | `tests/venue/venue_walls_refusals.test.ts` INV9 |
| Every refusal (incl. new codes) is inert | `refuse` deny-by-default surface | `realize` | `venue_walls_refusals.test.ts` INV10 |
| New checks join the ordered gauntlet | breach ordering | `realize` | `venue_walls_refusals.test.ts` INV11 |
| Realization-once & abort-closed at dispatch | `resolveAndRealize` before first chair | `src/runtime.ts` `runGig` | `tests/venue_dispatch/floor_refusal_aborts.test.ts` INV15 |
| Tree compiles; schema additive (acceptance guards) | throwing-stub seam; optional fields | both | `tests/venue/venue_walls_seam.test.ts` INV12, INV13 |

The enforcement invariants (INV1–INV11, INV14–INV16) are RED because the bodies throw or `realize`
does not yet stamp `workspace`/`ports` nor check the floor/ports. INV12 (tree compiles) and INV13
(shipped genome loads & composes unchanged, `coltrane.json` still admissible) are GREEN acceptance
guards by design — they pin that the RED spec is well-formed and additive, and would red only under
regression.
