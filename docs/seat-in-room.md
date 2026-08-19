# The seat runs inside the room

A realized room used to hold only **servers**. The chair — the seat — ran on the **host**: it was
spawned by `src/claude_invoker.ts` with no `cwd`, so its working directory was the host repository.
Two gigs dispatched at once wrote to one tree and corrupted each other's change-set. The workaround
was hand-rolled git worktrees, which leak and which nobody reaps.

This change moves the seat **into** the room. When a gig is realized into a containerized venue whose
`floor` selects a **seat-bearing** image, the chair runs as:

```
docker exec -i -w <workspace> <container> claude …
```

so its cwd is the room's own per-realization workspace. Isolation is by **construction**: two
concurrent gigs realize into distinct rooms with distinct workspaces, and neither seat can observe or
overwrite the other's tree. Reclamation is the venue's **ephemeral lifecycle** (`docker compose down
-v` + removal of the realization directory), not an operator's discipline.

## The two images are deliberate opposites

| | `Dockerfile.room` → `coltrane/room:<tag>` | `Dockerfile.floor` → `coltrane/floor:<floor>` |
|---|---|---|
| Holds | **servers** (chair reaches them from outside) | the **seat itself** |
| Toolchain | **excluded** — production deps only, no compiler, no test runner, no `claude` binary | **included** — git, dev deps, the `claude` agent binary |
| Justification | a **ceiling**: the smaller the surface, the tighter the ceiling | a **floor**: the seat needs the toolchain to do work in the room |

**Do not merge them.** The room is toolchain-OUT by design; the floor is toolchain-IN by design. That
opposition is the point, and it is stated at the top of both Dockerfiles.

Credential material is **never** baked into either image. The venue's `credential_surface` is
delivered by `docker cp` into the created-but-not-started container at realization time
(`deliverCredentialFiles` in `src/venue_realizer.ts`), landing at `/run/secrets/<class>` inside the
room and never on the host filesystem while the room runs. Auth for the in-room seat is therefore
**file-based** — a container has no macOS keychain — and no host credential is forwarded via `docker
exec -e`.

## Running a real gig with its seat in the room

A deployment declares a seat-bearing venue by adding a `floor` to a container venue. Starting from the
shipped `venues/engine-room-v1.json` (substrate `container`), a seat-bearing variant is the same
contract plus one field:

```jsonc
{
  "slug": "engine-room-seat-v1",
  "substrate": "container",
  "floor": "seat",                 // ← selects coltrane/floor:seat (Dockerfile.floor)
  "equipment": { "tools": ["type_browse", "agent_browse"] },
  "credential_surface": [],
  "lifecycle": { "policy": "ephemeral" },
  "mcp_servers": [
    { "slug": "coltrane", "transport": "stdio",
      "command": ["node", "/app/dist/src/server_entry.js"], "credential_names": [] }
  ]
}
```

Dispatch a **software-change** gig against it (`standards/software-change-v1.json`). Its chairs run
inside the room; the seal that proves in-room execution is the **`change-set`** output
(`domain_types/change-set.json`) — a diff sealed as an artifact, derived from the tree the seat
actually held. Because the room narrows the seat by `agent.allowed_tools ∩ venue.equipment.tools`
*before* the spawn is relocated, the in-room chair advertises exactly the intersected ceiling — moving
it inside cannot widen it.

Build the two images and run the live laws that prove the behaviour end to end:

```sh
docker build -f Dockerfile.room  -t coltrane/room:ephemeral .
docker build -f Dockerfile.floor -t coltrane/floor:seat .
npx vitest run tests/spec_venue_room_live.test.ts
```

The seat-bearing laws (`describe("two concurrent gigs get their own room …")`) stand up two floored
rooms **concurrently**, prove each seat's cwd is its own workspace and that neither can read the
other's tree, then prove nothing — container, network, or realization directory — survives teardown.
They gate on `coltrane/floor:seat` existing and **skip** without it; the CI `room` job builds both
images so they run for real.

## Egress, stated honestly (v0)

The room network is `internal: true` (`renderComposeConfig` emits `networks: { room-net: { internal:
true } }`). A seat that must reach a git remote would need a door, and `doors.egress` **is declared in
the contract but is NOT enforced at a network boundary today** — the room simply denies all egress.

v0 does not pretend otherwise, and it does not need a door: the change-set is a **diff sealed as an
output**, and a later effector performs the push outside the room. So the room stays egress-less and
the seat operates on a sealed workspace. Enforcing `doors.egress` at a network boundary is a **named
gap**, not closed here.

## What must not regress

- No docker socket mount, not privileged, no `cap_add`, no host network, no host PID namespace. A
  floored room renders the **same** locked-down posture as an unfloored room — only the image string
  changes. Pinned by `tests/spec_venue_realization_substrate.test.ts` (untouched) and by the posture
  law in `tests/venue_dispatch/seat_runs_in_room.test.ts`.
- No credential material readable on the host filesystem while the room runs — delivery stays `docker
  cp` into the container, never a compose file-secret bind mount.
- A seat inside the room is still narrowed by the room: `agent.allowed_tools ∩ venue.equipment.tools`
  remains the oracle, on both the host and the in-room arm.

## Out of scope (declared, not done here)

- **Docker-in-docker** — a seat inside a room must not be able to realize another room. The floor
  image carries no docker socket and the room network is internal, so it cannot; this is not widened.
- **Enforcing `doors.egress`** at a network boundary (see above).
- The **queue/conductor** policy layer, which lives in the deployment repo.
- A **version pin** for the agent binary in `Dockerfile.floor`, which belongs with the image-pinning
  lane that also applies `installs`.
