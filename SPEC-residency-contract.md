# The residency contract — a RED specification

A **residency** is a genome agent living in a room: not a gig that runs and ends, but a standing
presence that listens, answers, works, and accretes identity over time. A **resident host** is any
box that runs `coltrane reside`: a Fly machine, a laptop, a container. This document is the contract
such a host is entitled to, written as the gaps between `coltrane work` and a life that stays, and
the laws that close them.

`coltrane work` already exists and is the floor this builds on: it claims one queued gig from the org
store, runs it under a minted credential, drains the result, and exits — 0 complete or parked, 1
failed, 3 the queue was empty (`src/cli.ts:209`, `src/worker.ts`). Everything `work` does, `reside`
reuses. What `reside` adds is everything that makes the difference between *doing a unit of work* and
*being someone who lives here*: it is claimed and HELD, it is woken by a room rather than pulled from
a queue, it keeps one continuing mind rather than a fresh chair per gig, and its growth seals back to
the genome so it can, in time, be named.

Every gap below was chosen the way the worker contract's were: by asking what breaks the moment a
`work` loop is asked to stay resident instead of exiting. The suite in `tests/spec_reside_*.test.ts`
is the falsifiable half of this document. It is committed **failing on purpose**. See
[RED → GREEN](#red--green).

---

## One word, two rooms — and they are not the same room

`reside` lives at the intersection of two things the repo both calls a "room", and conflating them is
the first defect waiting to happen.

- **The venue** is the TOOL room: a governed contract with a tool ceiling, a credential surface,
  doors, and installs (`VenueSchema`, `src/genome_schema.ts:938`; realized by `src/venue_realize.ts`).
  It answers *what may this presence touch* — its hands. A venue instance is a running host standing
  that room up; a venue credential lets it act as one (see the worker contract, Gap 1, and the
  `venue_credential_mint` we ship).
- **The channel** is the SOCIAL room: where the presence has a voice — a Slack channel, a thread, a
  place people speak to it and it answers. It answers *where is this presence heard*.

A residency has BOTH, on different axes, and neither substitutes for the other. A persona with a
venue but no channel can act but cannot be spoken to; with a channel but no venue it can be spoken to
but has no hands. This document says **venue** for the tool room and **channel** for the social room
throughout, and never "room" unqualified. Gap 4 is the general case of what goes wrong when a
residency tries to fold one into the other.

---

## The binding — `coltrane_residency`

A residency is a durable row in the org store, the standing analogue of a queued gig. The engine
reads it; it never invents it. Its shape (the company store owns the table; the engine owns the
contract of what it reads):

```
agent_slug      → the genome agent this presence IS       (identity: public.coltrane_agent)
venue_slug      → the genome venue = its tool ceiling + credential surface   (its hands)
channel_id      → the social room = its voice
soul_output_id  → the sealed output that is its soul, or null (a blank presence — plays first)
status          seated · listening · playing · hibernated · drained · unseated
session_id      the resident cortex's continuity handle (warm cache; the transcript is disposable)
cursor          how far it has read its inbox
host            which box holds it now, or null (unclaimed)
lease_until     the claim's expiry — a heartbeat renews it; a dead box lets it lapse
heartbeat_at    last proof of life
```

Identity columns (`agent_slug`, the org, `channel_id`) are immutable after seating: a residency may
be re-hosted, re-leased, and advanced, but re-pointing it at another agent, org, or channel is a new
residency, not an edit. `venue_slug` REPLACES the ad-hoc "hands" list a first draft would carry — the
venue already formalizes the tool ceiling and credential surface, and a second list beside it is a
second contract free to disagree with the first (the worker contract's Gap 3, in miniature).

---

## Gap 1 — `work` exits; nothing claims and HOLDS a presence

### What is true today
`workOnce` claims a gig, runs it, drains, and returns. The claim is scoped to that gig and expires
with its lease (`src/worker.ts:298-342`). There is no notion of a claim that a host keeps across many
units of work, renews while it lives, and releases when it dies.

### Why it is a defect
A presence that re-claims from scratch on every message is not resident — it is a queue worker with a
chat skin, and two boxes reading the same channel both answer. Standing presence needs exactly one
host holding a residency at a time, provably, with a dead host's grip falling open on its own.

### The contract
1. **`coltrane reside` claims a residency under a lease.** Given a residency id, or by claiming the
   next unhosted seat for its org (`--any`, mirroring how `work` claims the next gig), it sets
   `host`, `status`, and `lease_until` in one atomic store call — the same optimistic-claim shape
   `work` uses, so two boxes cannot both win.
2. **The lease is a heartbeat, not a lock.** The loop renews `lease_until` on a cadence; a crashed
   host stops renewing and the seat becomes claimable again after expiry. No human unwedges a dead
   box.
3. **Release is explicit and clean.** On `SIGTERM`/`SIGINT` the loop sets `status` to a resting value,
   clears `host`, and lets the lease lapse — a graceful `unseat`, so a redeploy hands the seat over
   rather than racing for it.
4. **A residency for a non-agent, or a lapsed venue, is refused — typed.** `refusal: "no_such_agent"`
   / `refusal: "no_such_venue"`, the fail-closed shape `gig_dispatch` already uses when its seams are
   absent (`src/server.ts:2957-3060`).

### Left to the deployment
The store's claim/renew/release RPCs, exactly as the gig queue's are deployment-wired via
`deps.queueGig`. The engine ships the verb, the lease cadence, and the refusals.

---

## Gap 2 — a worker is PULLED by a queue; a presence is PUSHED by a channel

### What is true today
`work` is pull-driven: it asks the store for a gig. Nothing in the engine is push-driven — nothing
listens to a social room and reacts to a message arriving in it. The desk pattern supplied this in
bash (a Slack socket listener appending to an inbox file), outside the engine, ungoverned and
undrifting only by luck.

### Why it is a defect
A resident presence's work arrives as speech, not as a queued row. Without a listener the engine can
only be told to work; it cannot be *spoken to*. And the listener has a hard real-time budget a model
can never meet: an unacknowledged message reads to a human as "it's dead."

### The contract
1. **The reflex is separate from the mind, and dumb by design.** `reside` runs a listener that
   acknowledges an inbound message in reflex time (< 250 ms: an envelope ack, a receipt reaction) and
   appends it to the residency's inbox — with NO model anywhere on that path. It acks even when the
   cortex is busy or dead; an unacked message therefore means the listener process is down, a pager
   fact, not a mood.
2. **The channel is a venue door, not an ambient secret.** The listener's transport (a Slack app
   token, say) is a credential CLASS the venue declares in its `credential_surface`, minted with the
   rest of the environment by `venue_credential_mint`. A channel the venue does not declare is a
   `credential-breach`, the same gate `realize` already applies (worker contract, Gap 1, law 6) —
   never a token read from ambient env.
3. **The wake is the inbox growing, and every wake ends in an utterance.** The cortex wakes on inbox
   growth, not on a timer; and a wake that produces no reply in the channel is a defect, because the
   always-answer law is what makes the presence legible. `cursor` advances in the store so a
   re-hosted box never re-answers what a dead one already did.

### Left to the deployment
The concrete channel transport (Slack socket, etc.) behind a small `deps.channelListener` seam — the
engine owns the reflex budget, the inbox format, the cursor discipline, and the wake protocol; the
deployment owns which chat system.

---

## Gap 3 — `work` spawns a fresh chair per gig; a presence keeps one mind

### What is true today
Every `work` run spawns a new chair with a fresh context (`src/runtime.ts`). That is correct for
bounded work — a gig should not inherit a previous gig's head. But it means there is no *continuing*
mind: nothing that remembers this morning by this afternoon.

### Why it is a defect
A persona that forgets between messages is not a persona. Continuity is what a resident cortex is
FOR. The bash desk supplied it with `claude -p --resume <session>`; the engine has no first-class
notion of a session that survives across the many gigs one presence runs.

### The contract
1. **The cortex is a resident session, resumed by handle.** `reside` maintains one continuing model
   session per residency, its handle stored as `session_id` on the row. A wake resumes it; a box
   recreated from the roster resumes the same life from the same handle.
2. **Continuity is warm cache, not the self.** `--resume` cannot hold weeks. The DURABLE memory is
   the sealed record (Gap 5): at boot or thaw the cortex warms up from the last K sealed
   session-reviews and its private impressions, and treats the transcript as disposable. A lost
   session handle costs a warm-up, not an identity.
3. **A stale boot forces a fresh session.** Bumping the residency's soul/boot reference starts a new
   session rather than resuming into stale instructions — a resumed cortex carries its old boot, an
   observed failure the contract names rather than inherits.
4. **The cortex runs on the FLOOR, never the room** — see Gap 6.

### Left to the deployment
The model invoker is already `deps`-injected (`makeClaudeInvoker`, `src/claude_invoker.ts`); `reside`
adds only the resume-by-handle discipline around it.

---

## Gap 4 — becoming: a presence cannot seal its own growth back to the genome

### What is true today
`output_write` and the seal/name machinery exist (`coltrane_name_seal` gates naming on witnessed
evidence). But nothing in a standing loop CALLS them on the presence's own behalf: a gig seals its
work; a residency has no moment where it seals *itself*.

### Why it is a defect
The engine's rule is that identity is earned by sealed, witnessed evidence — not by a counter, and
not by anything a runtime holds privately. If a resident cortex's growth lives only in its transcript,
it can never be named, because naming reads the sealed chain, not the transcript. *Becoming is
sealing, not remembering.*

### The contract
1. **The seam is the session, not the gig.** At a hibernate or a session boundary, `reside` seals a
   `session-review` output through the ordinary governed verb — the same path any chair uses — so it
   lands in the sealed chain and surfaces in the deeds the naming gate reads. No new ledger, no
   privileged write.
2. **The private half stays private.** A presence's *impression* of a counterpart (its cheap local
   model of them) is not evidence and is not sealed; it lives in the residency's private memory and
   is rebuildable. Only the shareable, witnessed half becomes a deed. This is the ROLODEX split, and
   the seal path must honor it: sealing an impression as evidence would let a presence witness itself.
3. **Naming is not a side effect of `reside`.** The loop seals; it never names. `coltrane_name_seal`
   fires on the evidence like it does for any agent — a residency is not privileged to name itself.

### Left to the deployment
Nothing new — the seal path is the existing governed verb. The contract only fixes WHEN a standing
loop calls it.

---

## Gap 5 — hibernate-without-death: a parked presence must cost nothing and lose nothing

### What is true today
`work` has no idle state — it exits when the queue is empty (code 3). A residency cannot exit on an
idle channel; it must stay reachable. But a full cortex held warm on every idle presence is a cost
with no work behind it.

### Why it is a defect
The House economics of the whole system depend on a parked presence being nearly free: a residency
waiting on a human gate, or on a quiet channel, should bank its fire, not burn a model session doing
nothing. And it must relight into the *same* life, or hibernation is just a slower death.

### The contract
1. **Idle past a threshold hibernates.** The cortex is killed; `session_id`, `cursor`, and the
   private memory are already in the store; `status` becomes `hibernated`. The cheap reflex listener
   keeps acking — the presence is still reachable, it is only not thinking.
2. **Thaw resumes the same life.** A message on a hibernated residency relights the cortex on the
   stored session and warms up from the sealed deeds. The heartbeat/lease continues through
   hibernation so the seat is never mistaken for abandoned.
3. **Hibernation is observable, not silent.** The status transition is a store fact, so a liveness
   view can tell "parked and cheap" from "hung". A residency that stops heart-beating while
   `hibernated` is the one failure this gap cannot make invisible, and the status makes it legible.

### Left to the deployment
The idle threshold and the wake transport; the engine owns the state machine and its invariants.

---

## Gap 6 — a cortex needs the FLOOR; a residency realized on the room cannot think

### What is true today
Two images ship: `Dockerfile.room` (toolchain-OUT — MCP servers inside, no compiler, no test runner,
**no `claude` binary**, a deliberate ceiling) and `Dockerfile.floor` (toolchain-IN — git, dev deps,
the agent binary — where the chair itself runs). The worker contract's Gap 6 pins this distinction
for a drained gig. It is sharper for a residency.

### Why it is a defect
A resident cortex IS the agent binary running continuously. Stand a residency up on the room image —
the natural mistake, because "residency" sounds like "a room" — and it has tools but nothing to think
with, and the failure is the invisible kind: it comes up, acks in reflex, and never answers, because
there is no cortex to wake. This gap has not failed in production only because there is no `reside`
yet to fail it; pin it before there is.

### The contract
1. **`reside` runs on the floor, and says so.** The residency container is a `Dockerfile.floor`
   descendant; the venue's tool room is reached from the floor exactly as a chair reaches its room
   (`docker exec -i` stdio, `--network none`-compatible), never by unifying the two images.
2. **A residency whose realized environment lacks a cortex refuses at boot** — `refusal:
   "no_cortex"`, fail-closed, before it acks a single message, so the operator meets the refusal
   instead of the silent no-answer.

### Left to the deployment
The image build and the box; the engine ships the boot-time cortex check and its refusal.

---

## `coltrane reside` — the verb

```
coltrane reside [<residency-id> | --any]
  Hold a residency and live in it: claim under lease, listen to the channel (reflex),
  keep a resident cortex (floor), run gigs via the work drain, seal session-reviews,
  heartbeat, hibernate when idle, release cleanly on signal.

  env: COLTRANE_STORE_URL, COLTRANE_STORE_ANON, and a VENUE credential
       (COLTRANE_INSTANCE + the venue's minted environment — NOT a gig token);
       the model invoker per makeClaudeInvoker; checkpoints as for `work`.
  exit: 0 released cleanly (signal/unseat), 1 the loop failed, 3 no claimable residency (with --any).
```

Data to stdout, everything else to stderr, per the CLI's standing convention (`src/cli.ts` header).
`reside` is a THIN wrapper over the same `dispatchTool`/`workOnce` core `work` wraps — two front doors
that agree on what a gig means, plus the standing loop around them. Almost nothing here is new gig
behaviour, which is the point.

---

## RED → GREEN

`tests/spec_reside_*.test.ts` is committed failing. Each `it` names one law above and asserts the
engine's real answer — the claim atomicity of Gap 1, the reflex-without-model of Gap 2, the
resume-by-handle of Gap 3, the seal-on-session-boundary of Gap 4, the hibernate/thaw invariants of
Gap 5, the boot-time cortex refusal of Gap 6. Red means the law is stated and unmet; a green suite is
the proof the presence is entitled to what this document promises. Do not "fix" CI by weakening a
test — close the gap it names.

## What this does NOT change

Identity, naming, seats, and the sealed chain stay in the genome (`coltrane_agent`, `coltrane_outputs`,
`coltrane_name_seal`) — `reside` reads and seals, it never becomes a second store of self. The gig
drain, its credential minting, and its walled exec are `work`'s, reused verbatim. The venue contract
is unchanged; `reside` consumes it. New surface: one verb, one row shape it reads, six laws.
