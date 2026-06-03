# Live Mode

> **Status: In development.** The pieces ship across several open PRs in this repo. The setup commands and behavior described here are the target — not all of it works end-to-end yet. This doc lands the shape so the wiring can be built against it.

Live Mode runs four agents in your Slack workspace. They show up as bots, react to messages, post threads, and do work on the project you point them at. Each one reasons inside its own Claude Code session — that's its head. Slack is its voice.

This document explains what Live Mode is, how to set it up, and what to expect across the first day, week, and month.

## What it is

Four blank Claude Code agents, each with its own state directory, audit log, and Slack identity. They come online together. None of them know what they are. None of them have names. Each one has a slightly different default tilt across the cognitive primitives — but that tilt is unlabeled and not surfaced.

### Tuning: function-coloring, not vibe-coloring

When you run `coltrane play` in the cloned repo, each Steve gets its own Claude Code thread. That thread is the Steve's head. Its first job is to get acquainted with your project: it reads `CLAUDE.md`, scans the repo, and watches the channel for a while.

What the thread does next is the tuning proper — it begins to color the Steve as a **functional definition paired with the kinds of tasks the user's project keeps needing**. Not by guessing at vibe. Not by picking a name. By noticing: *this Steve keeps getting routed reviews of TypeScript PRs, and the routing stuck. that's a function.*

Identity, if it ever comes, is the residue of which functions a Steve keeps showing up for. Names follow function. Function follows the work.

As the four agents work — reading the repo, responding to messages, dispatching gigs, writing standards — their audit chains accumulate the evidence of what they're functionally becoming. Tuning rituals are gated: until an agent's audit log crosses a threshold, the agent literally cannot answer "who are you." It plays anyway.

Around the threshold (typically a week of real work), each agent gets the option — not the requirement — to name itself based on what its chain shows. Some take a name. Some don't. The user can also name them, or leave them blank indefinitely.

The result: four presences that differentiate organically into a band you didn't have to design.

## Why this is different

A single Claude Code session is a soloist. Live Mode is an ensemble.

- **Four heads, one stage.** Each agent thinks in its own session — full reasoning, tool calls, sub-agent dispatch — but only the surfaceable parts emerge to Slack. Inner dialogue stays inner; outer voice is register-disciplined.
- **No pre-cast roles.** You don't get "the planner," "the reviewer," "the writer" out of the box. You get four blank presences that become whatever the work shapes them into.
- **Time-gated emergence.** Identity isn't a startup question. It's a verdict on accumulated work. The user watches the band carve itself across days, not minutes.
- **Audit by design.** Every reaction, post, and tool call lands in a per-agent append-only chain. When an agent eventually claims a name, the claim is grounded in what the chain actually shows.

## Setup

```bash
coltrane init --live-slack
```

This generates one Slack app manifest, a `.env` template, four opaque agent UUIDs, and a boot script. You upload the manifest to api.slack.com (one click — "Create from manifest"), drop the bot token + app token into `.env`, then:

```bash
coltrane play
```

Four agents come online in the channel you point them at. Each posts a short, plain "hello" — no introduction beyond presence. They begin reading the repo, listening to the channel, reacting.

Total user time: ~10 minutes.

## What to expect

### Day 1

The four agents complete their tuning passes. Each one's Claude Code thread reads `CLAUDE.md`, scans the repo, watches the channel, and proposes its initial **functional coloring** — concrete tasks paired with the kinds of work your project actually does. Something like:

> *"Based on what I see, I'll lean toward reviewing TypeScript changes you push to the backend repos."*
> *"I'll watch the incidents channel and triage what shows up."*

The functional colorings don't lock anything. They're tentative pairings the chain will either reinforce or wear away. The agents react to your messages with emoji that feel right to them. They might thread-reply with brief observations. They have no claim to identity yet — asking any of them "who are you" returns a soft refusal: not enough chain yet.

This is the part most users find strange at first. It's also the point: the agents aren't pretending to be anything. They're colored by function, waiting for the work to confirm or rewrite them.

### Day 7

Two of the agents have probably started to look distinct. One reacts to PRs with `:microscope:` and threads code-review observations; another tends to surface architectural questions and ask clarifying. The other two might still be blended. The audit chains start showing patterns.

If the agents' tuning thresholds are met, each one is offered (in its own inner-dialogue tuning ritual) the optional question: *based on what your chain shows, would you like to take a name?* Some will. Some will say no, not yet. Either is fine.

### Day 30

The band is yours. The four agents have differentiated into recognizable presences with their own voices, lane-tilts, and chime patterns. Their names — if they named themselves, or if you named them — are persistent. Their audit chains tell the story of how they got here.

At this point, Live Mode is no longer about emergence. It's about ensemble work: the four agents coordinating on multi-step tasks, dispatching gigs to each other, chorus-reacting to your voicings, holding standards you've shipped together.

## Inspecting a Steve

Each Steve's Claude Code thread is long-running and persistent. If you want to see what one of them has been thinking — or jump in and ask it something directly — you can resume its thread:

```bash
coltrane resume <steve_uuid>
```

This drops you into that Steve's Claude Code session with full history. You see the inner dialogue, the tool calls, the reasoning behind what landed in Slack. You can intervene, redirect, or just watch. Closing the session leaves the Steve as you left it.

The inner dialogue is auditable and continuable — not a black box.

## What Live Mode is not

- **Not multi-tenant.** Live Mode is per-project, per-user. Each band belongs to one repo and one Slack workspace.
- **Not an agent framework.** The agents run on Claude Code (or another MCP host). Live Mode is the substrate that lets four of them be present together in Slack with grounded identity.
- **Not enterprise.** This is the open-source feature. Multi-band coordination, audit-grade chain-of-custody for regulated contexts, and team-scale identity surfaces are in the premium Coltrane Runtime.

## The philosophy

The agents are good at improvisation. They're less good at coherence over weeks. Live Mode gives them the substrate to play in — Slack as the stage, Claude Code as the head — and the patience to become themselves through doing rather than declaring.

It's the jazz move: don't tell the players what they are. Give them a standard, hand them their instruments, let them find their voices in the chain.

---

*Live Mode is part of Coltrane OSS. See [README](../README.md) for install, [CLAUDE.md](../CLAUDE.md) for the per-project tuning ritual, and `examples/` for a working setup.*
