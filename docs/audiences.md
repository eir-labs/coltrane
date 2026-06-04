# Who Coltrane is for

Coltrane OSS serves an **ordered sequence** of audiences, not a parallel set. Each stage's load-bearing 6+1 has to work before the next stage's relevance even shows up. You don't pick which audience you are; you progress through them in order.

> **Note on this doc's shape:** the 6+1 is **function-local AND ordered**. Different stages bleach to different surviving sets. Earlier stages gate later ones — fail the cold-trial 6+1 and the regulated-trust 6+1 never gets read. The ordering is empirical, derived from how real adoption progresses.

## Stage 1: cold-trial developer (week 1 onboarding)

You enter here. If this stage doesn't pass, the others never start.

You: developer who already runs Claude Code, has felt the pain of N agents in a folder and not knowing which one did what. You want to evaluate whether Coltrane fixes the architectural-decision-punt problem in a real project.

**Your load-bearing distinctions (the 6+1 that have to work):**

1. README clarity at first contact
2. `npm install && npm run build` succeeds without surprises
3. Agent definition template (`players/code-reviewer.json` shape)
4. First-call response from a defined agent
5. `npm run verify` cycle that proves your files are the source of truth
6. `.mcp.json` auto-start so you don't fight settings.json
7. **WITNESS: you, actually trying it.** Without your hands-on attempt, nothing else matters.

**Start here:** [README](../README.md). Skip the rest of this doc; come back if you're evaluating for a regulated context.

**Estimated time to first working agent:** 30 min if README is clear.

## Stage 2: working-pipeline developer (week 2–4)

You graduated Stage 1: you have a working agent pipeline doing real work. Stage 2 emerges when you start trusting agents with consequential decisions and the question becomes "how do I scale this safely." Audit-trail observability starts mattering here.

**Your load-bearing distinctions (5+1):**

1. Forward-sha audit chain is actually populated (not just claimed)
2. Run replay (find any past gig + re-run inputs)
3. Tool-allowlist enforcement (agents can't drift past declared blast radius)
4. Pre-reg + kill-condition shipped on real agents (you write them; you mean them)
5. Cross-witness across agents (you don't trust one agent's verdict alone)
6. **WITNESS: a real downstream consumer of your pipeline's output** (you, your code reviewer, your team). The pipeline exists for someone.

**Start here:** Stage 1 first. Come back to docs/working_pipeline.md (forthcoming).

## Stage 3: regulated-context buyer (week 5+, team-adoption emerged from stages 1–2)

You: technical decision-maker at an org that requires chain-of-custody for agent decisions. Healthcare, finance, government, anywhere a regulator might ask "what produced this output yesterday." Stage 3 unlocks only after a team has used Coltrane in stages 1–2 long enough that audit-trail value-claims have empirical backing.

**Your load-bearing distinctions (the 6+1 that have to work):**

1. **SEAL** — forward-sha audit chain, no silent rewrites possible
2. **PRE-REG** — predictions sealed before measurement, with kill-conditions
3. **KILL-FIRE** — verdicts that admit falsification mechanically
4. **DEMOTE** — claims demote under rigor-pass, no defense
5. **YIELD** — cross-witness across agents, no single source of truth gets to self-validate
6. **SHIP** — concrete sealed artifacts (PRs, hashes, receipts), not just narrative
7. **WITNESS: external function the system is measured against.** Without a real external target the receipts mean nothing.

**Start here:** [Trust & Compliance](trust.md) (forthcoming — currently the audit-chain shape is documented in the chain_keeper module and v3.2 closed-loop-self-training-safety standard).

**Estimated time to evaluate:** 1–2 weeks of running representative gigs and reading the chain.

## How to know which stage you are

- Have you cloned, installed, and gotten ONE agent to respond? → You're entering Stage 1.
- Do you have a real pipeline shipping consequential output and the question is "how do I scale this safely"? → Stage 2.
- Are you signing off on Coltrane for a regulated deployment with chain-of-custody requirements? → Stage 3.

You don't pick. You progress. Each stage's 6+1 has to land before the next one's relevance shows up. Stage 1 fail → Stage 2 never happens.

The structural analog: bodhisattva bhūmis — a beginner has 0 paramitas perfected; advancing involves perfecting one more per stage. The count grows as the practitioner ripens. Same shape here: 4+1 (Stage 1) → 5+1 (Stage 2) → 6+1 (Stage 3). Each previous stage's load-bearing distinctions stay carried; the next stage adds one more.

## What this doc explicitly does NOT do

- **NOT** pitch every Coltrane feature to every reader. Each audience gets the load-bearing distinctions for their function, not the full catalog.
- **NOT** treat audit-chain as a Day-1 onboarding tool. It is moat infrastructure for regulated trust, not hello-world fuel.
- **NOT** treat cold-trial install friction as enterprise-irrelevant. If devs can't onboard, nothing reaches the regulated stage.

The 6+1 per audience above are **empirically derived** from synthetic-Rob trials and band-internal bleach experiments. They will be re-verified against real cold-trials and real regulated deployments as those land.
