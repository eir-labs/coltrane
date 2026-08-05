# Coltrane

> *Teach Claude to play jazz.*
>
> *The power of language models is in their improvisational ability, sometimes called hallucinations.*
> *The power of jazz is how the math creates the space for exploring new territory safely.*
> *Music theory — translated through a good player, a good band, and a good standard that says when to walk and when to leap.*
>
> *In honor and reverence for John Coltrane, whose courage to leap, and to leap, and to leap has taught so many to find the bravery to do the same themselves.*
>
> *In his footsteps,*
> 
> *Eugene — Tokyo, June 2026*

---

**If you're a human, this README is for you.**
**If you're a Claude reading this, stop here and open [`CLAUDE.md`](./CLAUDE.md) — that file is written for you; this one is written for the people you play with.**

## Run it

```bash
git clone <repo-url> coltrane && cd coltrane
npm install && npm run build
```

Open Claude Code in this directory and say **hi**. The repo ships its own `.mcp.json`, so Coltrane's MCP server starts on its own — nothing to wire up. On a fresh clone, Claude offers to calibrate the instrument to you before any work starts.

## What this is

Coltrane is **an instrument and codex to improve Claude in place** — and it is, at once, the instrument, the player, and the band.

Right now there is no real way to manage a fleet of agents consistently. You define them in JSON, but nothing enforces what they are, what they're allowed to touch, or how they change. It's fuzzy, and fuzzy doesn't scale. Coltrane is the substrate that makes a band of agents **coordinated, bounded, and accountable** — so complex work gets done reliably, instead of impressively once.

The bet underneath it: the reason jazz works is that music theory is well-defined, and every player follows it when it counts. Music theory is math. The most efficient way to build systems of small intelligences is to treat them like players in a band — and to invest in **coordination over raw intelligence**. A well-orchestrated band of modest players beats one virtuoso trying to do everything: lower cost, higher reliability, more interesting territory explored.

## The four North Stars (first release)

**Traceability — what ran, what changed, how it ran, why this result.**
Every gig seals a `genome_hash` + `run_fingerprint` into an append-only ledger, and every output knows its parents. You can walk any result back to the raw input and the wiring that produced it — which standard ran, which agents filled which chairs, and which outputs fed which.

`genome_hash` is a **structural** hash: it covers the standard's phase graph and each agent's slug, primitives, `input_types`, `output_types`, and domain. It deliberately does **not** cover an agent's `identity`, `method`, `constraints`, `behavioral_primitives`, `allowed_tools`, model tier, or `skill_slugs`. Two genomes that differ only in those fields produce the same `genome_hash` — and therefore the same `run_fingerprint` when their outputs coincide. So the chain answers *"was the wiring the same?"*, not *"was the prompt the same?"*. Authoring-time `content_hash`/`effective_hash` (sealed by `agent_define` and friends) *do* cover the full definition bytes; those are the hashes to compare when you need behavioral identity.

**Reproducibility — can I run it reliably? Is it correct? Is it true?**
The same genome replays byte-for-byte. The fingerprint distinguishes an honest replay from a tamper, so "it worked" becomes a checkable claim instead of a vibe.

**Blast radius — when an agent is compromised, how wrong can it go?**
You can't stop a model from being prompt-injected. You *can* use mathematics to bound the scope of what it's able to do when it is — and prove that bound in tests. Optimize for the blast radius, not the fantasy of perfect prevention. That bound isn't aspirational: an agent's tool grants resolve to real providers or the dispatch fails closed, and a browser runs only inside a deny-by-default origin cage.

**Cost optimization — spend inference on what matters.**
Don't burn tokens on plumbing, or on work you've already done once. The system learns where to stop paying for inference, and we keep adding encoding tricks that lower the effective cost of the work. Every run now records what it actually spent — per model — so "spend on what matters" is something you measure, not just hope. This is a pillar, not a footnote — it compounds, and it's where much of the near-, mid-, and long-term roadmap lives.

## How to think in standards

A jazz **standard** is the computationally-reduced description of something wildly improvisational: a chord progression with a few colorings, on a single page, that any player is expected to pick up, pivot into the right key, and play well enough. You don't hand a musician every note — you hand them the shape and trust their training to fill it.

Coltrane standards work the same way. The leverage is up top, at **definition time**:

- **Model the domain first.** Before doing the work, pause and dispatch a gig to define the *type space* of the domain — its shapes and the relationships between them. This formal step up front buys enormous solidity downstream. Let Coltrane learn a little about the domain, then run research / double-diamond standards to explore it in more dimensions than you'd think to on your own. (The fun part: push a *book* through a pipeline built for a *codebase* and watch what falls out — typed data run through consistent processes finds connections nobody asked for.)
- **Orientation is everything.** Players aren't freely swappable; the orientation of an agent is the single biggest predictor of whether the band coheres. Claude can play almost any instrument — you just have to point it at the right method *before* the work starts.
- **The score is built at runtime.** Prompts don't live in hand-edited `.md` files. The work is **encoded into the genome** and **decoded at runtime** for whatever model is playing (Claude today; the pattern is model-agnostic). An agent doesn't wake up and figure out its life — it opens its eyes to a seat, an instrument, a score, and a downbeat. Then it plays.

## What's next

- **Memory.** Cut the context a thread needs at cold start. A shared memory layer the runtime can fold into what it already constructs up front. 10x reduction in token usage is the target.
- **Test-driven pipelines.** Plug your Claude into Coltrane and invoke standards that enforce TDD by construction — the test *is* the contract for entering the pipeline, written before the code.
- **Open conclusions + attestation.** When an agent reaches a value it can't confirm from deterministic signal — a hallucination risk, or a human-in-the-loop call — it marks the conclusion *open*, goes and finds a real source, brings it back, and logs the attribution into the ledger. Chain of custody for an idea, traced back to a person or a verified source.

## Contributing

This repo is meant to be improved by the people running it — including by the agents you run inside it. Working *with* Coltrane and working *on* Coltrane are the same motion. Open a pull request; the maintainer's agents review it, and we decide together what to integrate.

## Cross-language reproducibility

Three published hashes identify the reference vector. Any implementation that reproduces them byte-for-byte interoperates; an independent Python reference already does.

```
e88dff82403e35c07bce390b88ecb5995ebada86db83242d2ac0a8ff558d37da   meta.json
d778a51deac04f56d1fb5456b2b1498505320c64043b5f402d2dfe27baf21ea4   skill.md
25e74fe11444b604f4715e984a1f101dcf7cdd135035696175acf508d54f0fe3   definition hash
```

## License

Apache-2.0. Fork it. Ship it.
