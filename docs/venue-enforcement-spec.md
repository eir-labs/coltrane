# Production Venue Contract — Enforcement Specification

**Status:** SPEC ONLY — no enforcement or isolation code ships with this document.
**Scope:** the production build of the venue contract declared in `src/genome_schema.ts` `VenueSchema`.
**Companion tests:** `tests/venue_enforcement.test.ts` (RED-first `it.todo`/`describe.todo`).
**Approval:** this document is merged by a human before any implementation gig is dispatched.

## 0. Problem — the venue is declared but inert

`VenueSchema` (genome_schema.ts ~660–689) declares five enforcement surfaces —
`equipment.tools` (the tool ceiling), `doors.ingress`/`doors.egress` (origin
allowlists), `installs` (digest-pinned), `credential_surface` (credential classes
by name), `lifecycle.policy`/`rebuild_cadence`, and `responsible_chair`. Today none
of them reach the spawn:

- The equipment ceiling is **computed then discarded**. `venueEffectiveTools`
  (chart.ts:273) has one call site (chart.ts:548) inside
  `if (venueEffectiveTools(a, venue).length > 0) continue;` — tested for emptiness
  (rule R10) then dropped. chart.ts:520–522 states that non-goal outright.
- The spawn receives `agent.allowed_tools` **uninterected** at claude_invoker.ts:778.
- `doors` / `installs` / `credential_surface` / `lifecycle` / `responsible_chair`
  are stored at server.ts:1400–1404 (`venue_define`) and counted at
  server.ts:2330–2336 (`venue_browse`) but enforced nowhere.
- `venue` appears zero times in runtime.ts and claude_invoker.ts.
- `realize(contract)->realization` and behavioural-probe verification are declared
  out of layer at genome_schema.ts:611–614.

The two shipped venues — `venues/ci-deploy-room-v1.json` and
`venues/empty-room-v1.json` — are the concrete examples this spec is written against.

> All line numbers are **confirmed-as-of the upstream read** for this gig. The engine
> may drift between gigs; the implementation gig MUST re-confirm each callsite before
> applying a change. This caveat is carried, not closed — this seat holds no tools to
> re-run the sweep.

## 1. Per-field enforcement

Each field states: **(i)** its current state, **(ii)** the specified enforcement
mechanism, **(iii)** the exact engine callsite where it is applied, **(iv)** the data
shape threaded to reach that callsite.

### 1.1 `equipment.tools` — the tool ceiling

- **(i) Current:** declared in `VenueSchema`; computed by `venueEffectiveTools`
  (chart.ts:273–276) and tested for emptiness at chart.ts:548, then discarded. The
  spawn's `effectiveAllowed` at claude_invoker.ts:778 is `agent.allowed_tools`,
  uninterected.
- **(ii) Mechanism:** the effective tool set of a seated agent is
  `agent.allowed_tools ∩ venue.equipment.tools`, matched by `toolBaseName` (so a
  scoped grant `Bash(npx vitest run:*)` intersects the ceiling entry `Bash` on the
  base name). The intersection is computed by **reusing `venueEffectiveTools`**, so
  the runtime value is the same function the compose-time R10 check already calls —
  the two cannot drift.
- **(iii) Callsite:** where `effectiveAllowed` is set, claude_invoker.ts:778. It
  becomes `venueEffectiveTools(agent, venue)` when a venue is in force, else
  `agent.allowed_tools` unchanged (no venue ⇒ no narrowing).
- **(iv) Data shape:** `venue` is threaded chart → `runChart` → `runGig`
  (runtime.ts gains a `venue` parameter) → the invoker. A chart naming a venue the
  genome does not hold is a dead name that fails closed at compose, exactly as an
  unresolvable tool grant does.

### 1.2 `credential_surface` — the credential allowlist

- **(i) Current:** stored (server.ts:1400–1404), counted (server.ts:2330–2336),
  enforced nowhere. `spawnStreaming` (claude_invoker.ts:960–969) spawns with no
  `env` field, so the child inherits the **full parent env**.
- **(ii) Mechanism:** the child env is built from an **allowlist** derived from
  `venue.credential_surface` — only credential classes named there may be passed to
  the child. An undeclared credential present in the parent env is a **breach**: the
  spawn is **refused**, not silently stripped, so a misconfiguration is loud. A
  declared class absent from the parent env is reported (the room cannot be realized
  without a credential it promises).
- **(iii) Callsite:** the `spawn` call inside `spawnStreaming`,
  claude_invoker.ts:960–969, is passed a **scoped `env`** built from the allowlist
  instead of inheriting `process.env`.
- **(iv) Data shape:** the same threaded `venue`; the allowlist is derived once when
  the room is realized and applied to every spawn under it.

### 1.3 `doors` — ingress / egress origin allowlists

- **(i) Current:** stored and counted, enforced nowhere.
- **(ii) Mechanism:** `doors.egress` bounds the child's outbound network to the
  declared origins; an egress to an origin outside the list is refused.
  `doors.ingress` constrains accepted inbound origins for the realized room. This
  reuses the caged-browser posture (`--allowed-origins`, server-enforced) generalised
  to the room's whole network surface.
- **(iii) Callsite:** applied when the isolated room is realized (§3), as the network
  scope of the per-gig boundary — not a per-tool flag but a property of the room the
  spawn runs inside.
- **(iv) Data shape:** `doors` off the threaded `venue`.

### 1.4 `installs` — digest-pinned dependencies

- **(i) Current:** stored and counted, verified nowhere.
- **(ii) Mechanism:** each install is verified against its `sha256` digest pin
  **before the room is used**; a mismatch refuses entry to the room rather than
  proceeding on an unverified dependency.
- **(iii) Callsite:** the realize step (§3), as a precondition of declaring the room
  ready — entry is refused on mismatch.
- **(iv) Data shape:** `installs` off the threaded `venue`.

### 1.5 `lifecycle` — policy / rebuild_cadence

- **(i) Current:** stored and counted; `venueDefect` already refuses a standing venue
  without `rebuild_cadence` at compose, but no runtime honours the field.
- **(ii) Mechanism:** `lifecycle.policy=ephemeral` drives **per-gig teardown** of the
  isolated room (§3). The compose-time `venueDefect` check is retained; the runtime
  additionally honours the policy by tearing the room down when the gig seals.
- **(iii) Callsite:** the teardown step of the per-gig isolation lifecycle (§3),
  keyed on `lifecycle.policy`.
- **(iv) Data shape:** `lifecycle` off the threaded `venue`.

### 1.6 `responsible_chair` — the accountable office

- **(i) Current:** stored and counted, not carried into the run record.
- **(ii) Mechanism:** `responsible_chair` is carried on the **realized room's
  record**, so the accountable office for a room is a fact in the ledger, not a
  recollection.
- **(iii) Callsite:** stamped onto the realization record when the room is realized (§3).
- **(iv) Data shape:** `responsible_chair` off the threaded `venue`.

## 2. Isolation-mechanism evaluation

The venue's per-field enforcement (§1) presumes a **per-gig isolated room**. Two
mechanisms can back it.

### Option A — lightweight per-gig clone + subprocess boundary (RECOMMENDED)

A fresh per-gig **git clone** in an ephemeral temp dir (branch `gig/<id>`, push,
teardown — the posture `play-gig.sh` already uses), combined with a **node subprocess
boundary**, **stdio-scoped credentials** (the scoped `env` of §1.2), and
**optionally** Node's `--permission` model for filesystem/network scoping.

- **Delivers:** own working tree (scoped filesystem), scoped network + credentials,
  clean teardown, no shared long-lived process.
- **Cost:** light — a clone plus a subprocess; no image build, no daemon.
- **Caveat:** `--permission` is **conditional** on the implementation gig confirming
  the `package.json` engine field / installed Node version supports it; if not
  available, the subprocess boundary + scoped env still deliver the isolation, with
  `--permission` as later hardening.

### Option B — Docker / OCI container per gig

A per-gig container image realized from the venue contract.

- **Delivers:** the strongest isolation boundary (kernel-level).
- **Cost:** heavy — image build/pull per gig, a container runtime dependency in every
  deployment, slower teardown, more surface to operate.

### Recommendation

**Recommend Option A** — the lightest mechanism that still delivers real per-gig
isolation (own tree, scoped fs/network/credentials, clean teardown, no shared
process). Docker is heavier than a per-gig clone plus subprocess boundary and is
warranted only if a threat model the human names at approval requires a kernel
boundary. **The final choice is the human's at PR approval** — this recommendation is
advisory.

## 3. Per-gig isolation lifecycle

1. **Realize** — from the venue contract build the isolated room: fresh clone in an
   ephemeral temp dir on branch `gig/<id>`; verify `installs` against their digest
   pins (§1.4, refuse on mismatch); derive the credential allowlist from
   `credential_surface` (§1.2); scope the network from `doors` (§1.3); stamp
   `responsible_chair` onto the realization record (§1.6). The room is declared ready
   only if every precondition holds.
2. **Run** — the seated agent spawns inside the room with `effectiveAllowed =
   agent.allowed_tools ∩ venue.equipment.tools` (§1.1) and the scoped `env` (§1.2).
3. **Seal** — the gig's outputs are sealed to the ledger as today.
4. **Teardown** — when `lifecycle.policy=ephemeral`, push `gig/<id>` and tear the
   working tree down (§1.5); no room outlives its gig.

**Resume-as-fresh-thread.** A resumed gig does **not** reattach to a shared
long-lived process. It realizes a **fresh isolated room** (step 1) and continues from
the existing gig's **sealed state** — the ledger is the continuity, the process is
not. Resume = realize a new room + replay from sealed state, never a warm handle.

## 4. The approval gate

Two gates exist; they are **distinct** and this spec keeps them apart.

### 4.1 Runtime `awaiting_approval` (existing)

A per-standard human-chair gate **inside** a running gig: a chair parks the gig at
`awaiting_approval` (runtime.ts:136–139 / 217–225 / 500–507) until a human acts. This
is unchanged and is **not** the gate this spec adds.

### 4.2 PR-review approval gate (specified here)

A **scheduler-level** gate that blocks the **next** gig by construction:

1. The spec gig produces this PR (spec doc + pending tests) and stops.
2. The result is surfaced on an **approvals page**; the next (implementation) gig
   cannot be dispatched while the PR is unmerged — it is **blocked by construction**,
   not by a runtime park.
3. A human **reviews** → requests changes **or** confirms.
4. On confirm, the PR is **merged**.
5. Only then does the **implementation gig** dispatch, against the merged spec.

The difference: `awaiting_approval` parks a chair *inside* one gig; the PR-review gate
gates the *transition between* gigs. Conflating them would misstate the semantics. The
approvals-page HTTP endpoint does **not yet exist** (§5).

## 5. Open items — must be closed before enforcement is claimed complete

- **The bifrost invoker.** `src/bifrost_invoker.ts` appeared in the upstream grep but
  was **not read**. It must be confirmed to apply the **same** ceiling + credential
  scoping as claude_invoker.ts before enforcement is claimed complete — a second spawn
  path that bypasses the ceiling would void the guarantee. There is no confirmed
  locator to specify against; the implementation gig must read it.
- **`runChart` venue-threading** and **Node `--permission` availability** to be
  re-confirmed by the implementation gig (the engine may drift; this seat ran no sweep).
- **The approvals-page HTTP endpoint** does not yet exist and must be built as part of
  the approval-gate work (§4.2).
- **`realize(contract)->realization` behavioural-probe verification** (genome_schema.ts:611–614)
  remains a lower layer, **out of scope** here — §3 realizes and statically verifies
  the room; probing a running room against its contract is a later layer.

## 6. What ships with this spec

- This document.
- `tests/venue_enforcement.test.ts` — one `it.todo`/`describe.todo` per invariant in
  §1–§4, so `npm run verify` stays green and the PR is mergeable. The implementation
  gig converts each `todo` into a real RED-then-GREEN assertion against the callsites
  in §1, after this PR is merged.
- **No** enforcement or isolation code. That is the next gig, against the merged spec.
