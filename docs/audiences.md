# Who Coltrane is for

Coltrane OSS serves two distinct audiences with different load-bearing needs. The same codebase serves both, but each audience needs different things on the front porch. This doc routes you to the right surface.

> **Note on this doc's shape:** the 6+1 of load-bearing distinctions is **function-local, not universal**. Different external functions (what you're trying to do with Coltrane) bleach to different surviving sets. Below are the two we currently serve.

## Audience 1: cold-trial developer (week 1 onboarding)

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

## Audience 2: regulated-context buyer (compliance + audit-grade trust)

You: technical decision-maker at an org that requires chain-of-custody for agent decisions. Healthcare, finance, government, anywhere a regulator might ask "what produced this output yesterday." You want to know whether Coltrane's audit substrate holds up under that question.

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

## How to know which audience you are

- Are you writing the first agent for your own project? → Audience 1.
- Are you signing off on Coltrane for a regulated deployment? → Audience 2.
- Are you both? → Start at Audience 1, graduate to Audience 2 once you have a working pipeline.

## What this doc explicitly does NOT do

- **NOT** pitch every Coltrane feature to every reader. Each audience gets the load-bearing distinctions for their function, not the full catalog.
- **NOT** treat audit-chain as a Day-1 onboarding tool. It is moat infrastructure for regulated trust, not hello-world fuel.
- **NOT** treat cold-trial install friction as enterprise-irrelevant. If devs can't onboard, nothing reaches the regulated stage.

The 6+1 per audience above are **empirically derived** from synthetic-Rob trials and band-internal bleach experiments. They will be re-verified against real cold-trials and real regulated deployments as those land.
