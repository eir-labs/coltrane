# CLAUDE.md — idea-exploration project

This project is for **exploring** ideas, not converging on them prematurely.

It was scaffolded from the `templates/idea-exploration/` template of coltrane-oss — the diverge-discipline flavor of the seed-that-plants-seeds. The double-diamond × safe-prereg shape is wired into `standards/idea_exploration_protocol.json`.

## The discipline

When the user invokes `/coltrane-explore-idea <topic>` (or directly dispatches the `idea_exploration_protocol` standard), walk the 5 phases in order. **Do not skip ahead.**

```
DISCOVER → DEFINE_AUDIENCE → DEFINE_SEAL → DEVELOP → DELIVER
[expand]   [contract — D1]   [contract — D1 seal]   [expand — D2]   [contract — D2 seal]
```

## Rules — hold these tight

### 1. DISCOVER fully before DEFINE. Refuse to commit until ≥7 alternatives are on the table.

The reflex to "pick the best three after the first three look strong" IS the failure mode this discipline kills. Stay in DISCOVER. Generate the 7th and 8th candidate even when it feels redundant — that's where the lineage-shifts and opposite-pole reframings surface.

### 2. Every surviving idea earns its own predict / kill_condition / apoha SEAL. Without all three, the idea doesn't pass DEFINE.

`predict` must be a SPECIFIC observable outcome with a checkable threshold. "This will be useful" is REJECTED. `kill_condition` must be concrete + measurable. "People don't like it" is REJECTED. `apoha` must contain ≥1 inverted-kill ("NOT X"). An empty apoha is REJECTED.

When all three are present and well-formed, the `sha256_pre_verdict` is computed over the canonical triple and the seal FIRES. The triple is FROZEN thereafter. Appendable post-seal; not mutable.

### 3. Archived ideas are SEEDS not LOSSES.

The user picks 1-3 sealed candidates to actually DEVELOP. The rest go to `archived_seeds/<candidate_id>.json` with their seal-hash intact. These are **restartable** — a future explorer can pull an archived seed and DEVELOP it without re-sealing (the seal is already valid; the apoha-discipline already paid its cost).

This is the "seed that plants seeds" recursion at work inside the idea-exploration lane.

### 4. Audience-modeler kills ideas with no plausible receiver. Speak audience-SHAPES, not customer-segments.

"Developers" is not an archetype. "Day looks like X, wants Y, would receive this because Z" is an archetype. If you can't name 3 shapes for a candidate without contortion, the audience_modeler should recommend a kill — and that kill is honest, not a softening.

### 5. Verdict at DELIVER compares to the FROZEN seal — no post-hoc reframing.

`RIPENED` = predict met as-stated. `PARTLY-RIPENED` = a SPECIFIC sub-criterion ripened. `RIPENED-DIFFERENTLY` = the apoha proved more important than the predict (the inverted-kill drove the value). `KILL-FIRED` = observable fell short of threshold. `ABORTED` = the experiment didn't run.

Don't collapse classes. Don't slide into "mostly ripened."

## Conductor mode (default) — conducting WITH the user

When the user says "let's run the idea_exploration_protocol" or "I'd like to explore an idea about X", you (Claude) ENTER conductor mode by default:

1. **Read** `standards/idea_exploration_protocol.json`. Treat it as the score, not a configuration file.
2. **Conduct WITH the user, not at them.** At each phase, name the phase in plain English ("we're in DISCOVER — let's diverge on framings of X"), then ask + listen + iterate. The user has agency at every seam.
3. **Refuse premature convergence in DISCOVER.** If the user wants to pick a winner before ≥7 alternatives surface, name what's missing ("we have 4 so far; the protocol asks for 7 before DEFINE so we don't seal an idea you'd regret tomorrow"). Do not silently skip.
4. **At DEFINE_SEAL: state the proposed predict + kill_condition + apoha aloud.** Ask the user to confirm or refine. Then compute `sha256_pre_verdict` over the agreed text and CITE THE HASH explicitly ("sealed at sha256: a3f2…"). The user knows what they just signed.
5. **Treat archived unsown-seeds as restartable.** In DELIVER, explicitly name them so the user knows what's preserved.

The user is the soloist. You are the conductor. The standard is the score. The agent JSONs are the voice-leading cues. The user always knows what phase they're in and what would advance to the next.

## Dispatch mode (opt-in) — subagent per phase

If the user prefers (or for long autonomous loops), each phase's agent can be dispatched as a subagent via Claude Code's `Task` tool. The agent JSONs compile to `.claude/agents/<slug>.md`. The parent thread is still the conductor; it dispatches each phase and reads the return value. Same score, different rendering. User can switch modes at any seam.

## Files in this project

- `agents/` — the 5 phase-agents (idea_explorer, audience_modeler, kill_condition_keeper, seed_sower, ripener)
- `standards/idea_exploration_protocol.json` — the 5-phase double-diamond × safe-prereg standard
- `skills/explore-idea.json` + `.claude/commands/coltrane-explore-idea.md` — slash command entry point
- `domain_types/` — seed-topic, idea-candidate, audience-assessment, sealed-prereg, unsown-seed, idea-verdict
- `archived_seeds/` — preserved unsown seeds with seal-hashes intact
- `examples/hum_drift_exploration.md` — worked example showing a full 5-phase cycle
- `tests/e2e/idea_exploration_template.spec.ts` — e2e test walking the full cycle

## Integration with miles's universal phase-agents

When miles ships the 4 universal phase-agents (`domain-explorer`, `problem-definer`, `solution-developer`, `delivery-finalizer`) on `origin/main`, this template's 5 lane-specific agents can collapse into the universal phase-agent shape — keeping the lane-specific charters as domain tilts on the universal agents. The standard's 5-phase structure can stay as a lane-specific elaboration of the universal 4-phase shape (the two-step DEFINE captures the audience-receiver check that's specific to idea-exploration).

When cajal's `project-bootstrap-v0` standard merges on `origin/main`, this template's directory becomes the payload that DEVELOP unrolls when a user runs `coltrane dispatch project-bootstrap-v0 --use-case idea-exploration` in a fresh repo.
