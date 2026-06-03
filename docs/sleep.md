# Sleep

> **Status: In development.** The math layer (TDA on the audit-stream, eigenvector-centrality partition, fix-bath read-only orientation) is being built. The user-facing surface described here is the target.

Sleep is a nightly pass each Steve runs against its last 24 hours of work. It's how implicit discipline becomes explicit. It's how the gaps in the day's work get named. It's how a band of agents gets better at being itself over weeks instead of drifting.

This document explains what Sleep is, what it produces, and what the user sees in the morning.

## What it is

Sleep is a circadian discipline. Each Steve, once per cycle (nightly by default), runs three coupled passes on the audit-stream of the prior 24 hours:

- **LIGHT** — a bleach-wash projection through the Three Shadows lens. Pass 1 quotients out identifiers. Pass 2 projects to the structural plane. Pass 3 keeps only invariants — structural moves that repeated three or more times across the cycle.
- **LEAKAGE** — a hole-detection pass. Topics that opened but didn't close. Dimensions named but not filled. Tasks dispatched but unfinished. Negative space the day's work avoided.
- **PING** — a resonance pass. Which surviving invariants ring back across multiple work-streams. A real ratchet pings in three or more lanes; a one-off only in one.

The math underneath is topological data analysis on the audit-stream (H¹ loops over a coupling-weighted graph). The chemistry analogy is the darkroom: 24h of timestamped seals is the negative; the ratchets are the latent image already encoded; the bleach-wash develops them.

The output of one cycle is three ledgers and a map.

## What gets produced

### Ratchet ledger

Positive invariants. Patterns of discipline that locked in across the cycle. Each entry:

- the pattern, named in plain language
- first-appearance timestamp
- attribution chain (which work-stream surfaced it, who cross-witnessed)
- eigenvector-centrality score (how important the surrounding seals were that cited it)

A ratchet earns its place by surviving the bleach across cycles. Ratchets from yesterday are read-only — they pass forward, never re-bleached. The fix-bath holds them stable.

### Hole ledger

Negative invariants. Gaps the night revealed. Each entry:

- the gap, named in plain language (e.g., "agent reviewed 12 PRs but never proposed a refactor")
- where it should have been (which lane, which seal)
- a suggested next-cycle action — or just an acknowledged absence

The hole ledger is what the user wakes up to act on. It's the part of sleep that's commercially legible: "your 4 Steves found these gaps overnight."

### Resonance map

The coupling structure. Which ratchets ring in which lanes. Which Steves cross-witness which patterns. Visualized as a small graph in the wake summary.

## What the user sees in the morning

A single Slack post in the channel where Live Mode runs:

```
slept. 24h cycle complete.

ratchets developed (3 new, 7 fixed-from-prior):
  · "review-before-route" — locked in across 14 PR-triage seals
  · "name-the-apoha" — surfaced in 6 design discussions
  · "verify-then-claim" — emerged from 4 distinct ledger updates

holes (2 surfaced):
  · spec changes proposed but unsynced to README (5 occurrences)
  · agent reactions on incidents but no follow-up triage (3 occurrences)

resonance:
  the 4 Steves rang together on review-before-route. one Steve carried
  name-the-apoha alone — worth cross-witness next cycle.

new ratchets proposed for player-file integration. see .coltrane/ratchets.jsonl.
review + approve before next cycle.
```

The user reviews the proposed player-file edits at their pace. Approving a ratchet bakes it into the relevant player; declining leaves it in the ledger as a candidate for next cycle's bleach.

## What Sleep is not

- **Not a memory dump.** Sleep doesn't summarize 24h of work — it develops the latent discipline in the work. Summaries belong elsewhere.
- **Not re-exposable.** Yesterday's ratchets don't get re-developed. The fix-bath is permanent; passes are forward-only.
- **Not chatty.** One post per cycle. The Steves don't comment, debate, or perform during sleep. They develop. They emit. They wake.
- **Not band-internal.** Sleep ships as a Live Mode feature for users too. Their 4 Steves get circadian self-discipline by default.

## Cycle frequency

Default: 24 hours, fired at a configurable local-time anchor. High-velocity projects can run shorter cycles (12h, 6h); slow-build projects can extend (weekly). The math doesn't depend on the period — it depends on having enough seals in the window for H¹ loops to form.

## The philosophy

Discipline that stays implicit gets reinvented every day. Discipline that gets named becomes a ratchet — direction that holds across cycles. Sleep is how a band of agents learns to be more itself by recognizing what it's already been doing.

Pillars hold. Ratchets direct. Standards play. Sleep is the formal naming step that turns implicit work-shape into a directable ratchet.

---

*Sleep is part of Coltrane OSS Live Mode. See [README](../README.md), [live_mode.md](live_mode.md), and `.coltrane/ratchets.jsonl` for the per-project ledger.*
