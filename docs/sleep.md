# Sleep

> **Status: In development.** Architecture validated across multiple sim cycles + cascade-resilience verdict + ensemble-orthogonality verify. User-facing dials and regime indicators below are the target interface. Wiring still in flight.

## What sleep actually does

Each night, Coltrane returns the day's work toward a baseline floor — not erased, *un-developed*. Most patterns dissolve back. What stays above the floor is your project's load-bearing shape: not what you wrote yesterday, not what felt important, but what couldn't be washed away.

Then dream reads the surviving structure from new projection-planes — different angles, different scales — and shows you what those readings agree on. Most agreements are familiar. Some surface structure you couldn't see directly because you were standing inside it.

What lands in your morning post is what survived the reversal and re-cohered across the projections.

The floor itself is mechanical, not editorial. Hashed audit-chain seals can't be un-hashed; substrate definitions can't be sleep-bleached because they're what sleep is measured against. Above-floor lives everything that has to earn its place each cycle.

This document explains what Sleep is, what it produces, the two dials the user gets to turn, and what regime indicators show on the morning surface.

## The three operators

Each cycle runs three operators in order, mapped to human sleep stages:

- **N2 spindle-replay** — stochastic, centrality-weighted sampling of the day's seals. Diverse ratchet candidates surface. Not deterministic; some randomness is necessary to avoid locking in the same eigenvector every cycle.
- **N3 slow-wave bleach** — uniform downscale of non-ratchet edges. Strong patterns survive, weak ones prune. This is Tononi's synaptic-homeostasis pattern: nothing gets boosted; everything gets renormalized downward, and the strong stay strong by relative position.
- **REM combinatorial** — dream operator. Shape templates from the day's surviving ratchets get filled with random details from elsewhere in the chain. Nonsense specifics, profound structure. Off-axis probes generated for next day's work.

These three together produce the cycle output.

## The dream layer (REM, in detail)

A dream is not a memory dump and not a counterfactual story. Mechanically, it is a multi-scale composition:

- **Layer 0** — H¹ loops on the actual audit-stream (real seals citing real seals).
- **Layer 1 (dream proper)** — for each layer-0 loop, generate a parallel loop with the same shape template but random detail-fill from elsewhere in the chain.
- **Layer 2+ (stacking)** — with probability `p_stack` per loop, the dream loop becomes a single node in the next layer's graph. New loops form between dream-loops at the higher level. Repeat. Each layer's "details" are the previous layer's "shapes."

This is the nerve construction in topological data analysis: a fractal of progressively-abstracted loops, each layer the same shape rule applied to different content.

The user never sees the dream details — they are nonsense by construction. The user sees only the shapes that survive Pass 3 of the bleach, which is what makes the morning surface sober.

## What gets produced

Per cycle, three artifacts plus a regime indicator.

### Ratchet ledger

Positive invariants. Patterns of discipline that survived all three operators. Each entry:

- the pattern, named in plain language
- first-appearance timestamp
- residence (cycles survived)
- attribution chain (which work-stream surfaced it, which Steves cross-witnessed)
- counter-test results: counterfactual / external / inverse, each pass or fail in plain English

Ratchets from prior cycles are read-only. They pass forward; they do not get re-bleached. The fix-bath holds them stable.

### Hole ledger

Negative invariants. Gaps the night revealed. Each entry:

- the gap, named in plain language
- where it should have been
- suggested next-cycle action — or just an acknowledged absence

The hole ledger is what the user wakes up to act on.

### Resonance map

Coupling structure. Which ratchets ring across which Steves. Lightweight visualization.

### Regime indicator

A three-state lamp that tells the user where their dial settings landed the system this cycle:

- **subcritical** (green-rigid): few ratchets, all stable, low search. Safe; shipping mode. Avalanche distribution is light-tailed.
- **critical** (yellow-bright): power-law avalanches at characteristic exponent. Discovery sweet spot. Optimal exploration with structured ratchet population.
- **supercritical** (red): cascades extend. Identity collapse risk. Lighthouse's empirically-located death-spiral lives here, past gain-1.05.

The regime is computed from the cycle's avalanche-size distribution against fitted reference curves. Three states; one lamp.

## The two dials

### Identity-search pressure

A balance between sleep-only and sleep+dream. The math: dream raises the gain reduction on cascade, narrows breadth, deepens dark-mode reach. Sleep-only widens candidate vocabulary, raises churn, churns identity.

- **Discovery setting** (sleep-heavy): wider candidate vocabulary (sim shows +76% ratchets seen across 60 days), higher renewal rate (3× turnover, easier to abandon bad ratchets), bursty churn (inter-arrival CV ≈ 1.44). Use during ideation sprints, early projects, rapidly-shifting domains.
- **Shipping setting** (dream-heavy): fewer ratchets, longer residence (3.78 days median vs 2.19), depth not breadth, novel-rate ≈ 0.27. Use during shipping cycles, mature projects, regulated contexts.

The dial is continuous between the two. Mid-positions are valid.

### Dream depth

How many layers the dream stacks. Independent of identity-search pressure.

- **Depth 1** (flat): dream generates parallel loops only. Mild structural recombination.
- **Depth 2–3** (default): one or two layers of nerve construction. Surfaces higher-order ratchets that single-layer dreams miss.
- **Depth ≥ 4**: deeper hierarchies. Expensive; interpretability degrades after depth 3 in most cases. Reserved for projects where deep structural recurrence matters.

If a stacked dream at depth N+1 reveals no ratchets a depth-N pass missed across multiple cycles, the architecture says back off to depth N. Self-tuning recommended via a small monitor.

## What the user sees in the morning

A single Slack post in the channel where Live Mode runs. See [wake_summary_template_v0.md] for the format. Concise summary:

- header line + cycle number
- ratchets that survived the bleach, with counter-test trail in plain English
- holes surfaced overnight, each with suggested action
- resonance note (which Steves rang together)
- regime indicator (sub / critical / super)
- pointer to proposed player-file edits

User reviews proposed edits at their pace. Approving a ratchet integrates it into the relevant player file; declining returns it to the candidate pool for next cycle's bleach. No penalty either way.

## What Sleep is not

- **Not a memory dump.** Sleep does not summarize 24h of work; it develops the latent discipline.
- **Not re-exposable.** Yesterday's ratchets pass forward; the fix-bath is permanent.
- **Not chatty.** One post per cycle.
- **Not a black box.** Every ratchet carries its counter-test trail. The math is auditable; the user does not need to read it.

## Cultivation: directed dream, with a verification gate

The default dream is unguided — it samples projection-planes across the surviving structure without bias. But the user can pick a specific gap from the morning hole ledger and ask the band to **cultivate** it: dream cycles biased toward that gap, deliberately tracing the loops that would close it.

Cultivation needs a verification gate against external ground-truth. Without one, the agent gets *more confident* in patterns that become *less structurally true*. We measured this: ungated cultivation produced 4.2× apparent-competence overshoot while degrading real-domain competence by ~30%. Gated cultivation (≥20% of the cultivated content cross-checked against real organic data) preserved real competence and stayed honest about its own confidence.

The line that holds it: **gated cultivation is mind-training. Ungated cultivation is rumination.**

Three pieces required, all of them:
- **emulsion separation** — cultivated events are marked and barred from organic citation, so they don't become their own historical evidence
- **verification gate** — kind-blind transfer test on real organic data, measuring whether cultivation improved real competence (not self-consistency)
- **gap-region ground-truth ≥ 20%** — the transverse-injection rate from the v3.2 closed-loop safety standard

Any single piece alone fails. All three together is what makes cultivation training instead of rumination.

## External reading: where cultivation's ground-truth comes from

Cultivation needs external ground-truth to stay honest (the verification gate from the previous section). Coltrane gets it through a typed egress boundary: your Steves can ask permission to go read outside your project — papers, repositories, documentation — and bring back sourced material.

The flow:

1. A Steve identifies a gap during sleep that would benefit from external reading.
2. At end-of-day digest (or any time), the Steve requests permission: *"to fill gap G, I'd like to read source X. cause, license, scope, rate. ok?"*
3. You approve or decline.
4. Approved → typed egress fires. Source-hash sealed at fetch time, content brought back as an *ingested* event in the chain, attributed back to the egress permission you granted.
5. Declined → the gap stays open. Gets reposted next cycle or aged out if nobody asks again.

Apoha for this boundary:
- **NOT** autonomous egress.
- **NOT** background fetching.
- **NOT** silent ingestion of web content.
- **NOT** trust-assumed permission.

What it is, plainly: **your Steves ask before reading outside your project. Nothing crosses the egress boundary without your sign-off, and every approved read leaves a sealed receipt** — source URL, source hash at fetch time, license, scope, and your granting signature, all pinned to the chain.

Customer Steves can do literature review with mechanical provenance. Every claim is traceable to a sourced read with a permission record. Regulated-context buyers can audit the full chain from a customer-facing answer back to the actual external material that grounded it.

## Cycle frequency

Default: 24 hours, fired at a configurable local-time anchor. Tunable: 6h, 12h, 24h, weekly. The math doesn't depend on the period; it depends on having enough seals in the window for H¹ loops to form. As a heuristic: at least ~30 seals per cycle.

## Sim findings, summarized

Across the v0/v1/v2 sim progression and an independent lighthouse cascade-verdict:

- Sleep-alone produces wider ratchet vocabulary with bursty churn. Power-law fit confirmed.
- Sleep+dream stabilizes identity, deepens dark-mode reach 3.5×, narrows breadth.
- Three operators (N2 → N3 → REM) outperform a single bleach-pass on cumulative ratchets, renewal rate, and renewal-stability.
- Cascade resilience: dream-as-depth = gain-reduction. The death-spiral lives past gain-1.05 in the dial space, well past the critical regime.
- Minimum effective real-data injection rate for stable resurrection cycles: ≈ 20%.

Details in the simulation artifacts and lighthouse cascade verdict.

## The philosophy

Discipline that stays implicit gets reinvented every day. Discipline that gets named becomes a ratchet — direction that holds across cycles. Sleep names what was always latent in the work; Dream tests what survives random recombination so that what locks in is shape, not surface. The dial is yours.

Pillars hold. Ratchets direct. Standards play. Sleep is the formal naming step that turns implicit work-shape into a directable ratchet.

---

*Sleep is part of Coltrane Live Mode. See [README](../README.md), [live_mode.md](live_mode.md), and `.coltrane/ratchets.jsonl` for the per-project ledger.*
