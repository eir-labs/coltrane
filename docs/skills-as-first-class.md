# Skills as First-Class Citizens

> *The same musician, reading a better chart, plays a better gig. You don't retrain*
> *the musician — you improve the chart.*

**Status:** DRAFT / proposal. This spec defines the skill model for coltrane and the
plan to restore it. It is a design document, not yet an implementation.

---

## Thesis

**A skill is the unit of improvement, not the agent.** A skill separates *what an agent
knows how to do* from *who the agent is*. When a skill gets better, every agent that
loads it gets better — improvement propagates through the agent graph without touching
a single agent definition.

The deeper move: a skill carries **two halves that share one typed contract** — a
reasoning half the model reads, and a deterministic code half that runs first and
resolves whatever doesn't need a model. Over versions, the code resolves more and the
model resolves less. **Skills learn toward determinism**, shifting work from expensive
inference to near-zero-cost execution — and that drift is *measured*, not claimed.

---

## The problem with the current model

Today coltrane's skill is a stub: a `SkillRecord` of `{ slug, md }` — prompt text
injected into an agent's prompt. That leaves three holes:

1. **Capability is fused with identity.** An agent's `method` mixes *who it is* with
   *what it knows how to do*. Improving a capability means patching every agent that
   has it; knowledge gets duplicated and drifts.
2. **No atomic unit for evolution.** You can evolve an agent, but that's a coarse lever.
   Most improvements are to a *single capability*, not a disposition. There's no way to
   version, test, or hot-load one capability independently.
3. **No path from reasoning to determinism.** Agents re-derive deterministic facts on
   every gig — running a test, extracting a field, computing a hash — burning inference
   on solved problems. There's no mechanism to progressively codify stable reasoning
   into executable code.

---

## The skill model

### Dual-artifact package

A skill is a self-contained package — a directory under `skills/<slug>/`:

```
skills/
└── run-vitest-band/
    ├── meta.json        # identity, typed I/O, determinism_ratio, permission tier
    ├── schema.json      # input_schema + output_schema (the shared contract)
    ├── skill.md         # the reasoning half — what the model reads
    ├── skill.ts         # the execution half — deterministic run(input) → partial | null
    └── fixtures/        # golden {input, expected_output, assertions} — the skill's tests
```

- **`skill.md`** is the reasoning space: method instructions, constraints, and guidance
  assembled into the prompt. This is what the model reads.
- **`skill.ts`** is the execution space: deterministic code that runs *before* the model,
  resolving what can be resolved without inference. Pure function — input in, partial
  output (or `null`) out. No inference, no I/O beyond what the input provides.
- Both halves share the **output schema** as their contract. The code produces a partial
  output; the model produces the rest; the validator checks the union. This is the
  Curry-Howard alignment: the output schema is the proposition, and *both* the code and
  the model's reasoning are proofs that satisfy it.

A **pure-code skill** (like `run-vitest-band`) is the degenerate case: the code resolves
the *entire* output, the residual is empty, and the model never runs (`determinism_ratio`
= 1.0, zero inference cost).

### The runtime flow — code first, model fills the residual

This is the heart of the model and the part a naïve "LLM chair *or* code chair" split
misses:

1. **Code runs first.** `skill.ts run(input)` resolves what it deterministically can,
   validated against the output schema.
2. **Residual = output_schema − what the code resolved.** Computed at runtime; no separate
   residual schema. As the code gets smarter across versions, the residual shrinks
   automatically.
3. **The model reasons only about the gap.** The prompt includes `skill.md` *only for the
   unresolved fields*; pre-resolved fields are handed in as verified context so the model
   can reference them without re-deriving them.
4. **Union validated.** Code-resolved + model-produced output is validated against the
   output schema — same validator, same gate. Each field is tagged with its origin
   (code vs. model) in the recorded signal.

### The determinism gradient

Every skill starts mostly-reasoning (thin code wrapper) and earns determinism over time:

| version | determinism | code handles | model handles |
|---|---|---|---|
| v1 | ~10% | nothing (returns null) | everything |
| v3 | ~35% | the stable, obvious cases | quality, nuance, edge cases |
| v7 | ~55% | above + more structure | subjective analysis, novel patterns |
| v12 | ~80% | above + classification, detection | genuinely ambiguous cases |
| v20+ | ~95% | nearly the whole schema | genuinely novel situations only |

**`determinism_ratio` is computed, not declared.** The recorder tracks which output fields
were resolved by code vs. model on every gig; the ratio is the rolling average across
recent gigs. It reflects *actual behavior*, not aspirational claims.

### The typing guarantee

Strict typing is what makes the gradient safe — without it, a skill version bump could
silently break every agent that loads it:

- **`output_schema` is immutable per major version.** Shape change → new major version, and
  all consuming agents must be re-validated.
- **Code can only resolve fields that exist in the output schema.** The residual is always a
  subset of the full output.
- **`input_schema` changes require cascade checks** — what standards and agents feed this skill?
- **`code_hash` is verified at load.** If the code on disk doesn't match what was approved, the
  skill fails to load and falls back to pure-reasoning mode — graceful degradation, never
  silent corruption.

### Graceful degradation

Every failure mode degrades to pure-reasoning. The code is an *optimization, not a
dependency* — the model can always do the work, just at higher inference cost.

| failure | behavior |
|---|---|
| `code_hash` mismatch | skill loads in pure-reasoning mode; model handles everything; logged |
| `run()` throws | treated as resolving nothing; model handles everything; error in signal |
| `run()` returns invalid output | schema rejects it; treated as `null`; model handles everything |
| code file missing | pure-reasoning mode; logged |

The system never stops a gig because a skill's code failed.

---

## Composition

An agent can load multiple skills per gig. A `composable_with` list on each skill record
defines valid pairings, enforced at compose time (invalid compositions fail loudly).

- Skills with overlapping output-schema fields must declare *identical* types for them.
- Execution order follows dependency: if skill B's input references fields in skill A's
  output, A runs first.
- Each skill's `run()` executes independently — no shared state between code halves.
  Composition happens at the output level, not the execution level.
- The agent sees a single **merged residual**: everything no skill's code resolved.

---

## Evolution — how the system learns toward determinism

The highest-leverage capability: drafting new skill code from performance data.

1. **Observe.** Read recordings; identify stable patterns ("across 300 gigs, this field was
   resolved identically 294 times; the 6 exceptions share a shape").
2. **Draft.** Write a new `skill.ts` that handles the stable pattern in `run()`. The edge
   cases are noted in a corresponding `skill.md` update so the model handles them as residual.
3. **Test on history.** Execute the new code against the historical inputs from the sample.
   Compare output to what agents actually produced. Record match rate, cost delta, failure modes.
4. **Propose.** Submit the new code + updated `skill.md` + statistical evidence + projected
   impact (`determinism_ratio: 0.45 → 0.52`, `avg_cost: $0.030 → $0.025`, residual shrinks).
   The review surface is one code file.

**Guardrails:**

| change | approval | guardrail |
|---|---|---|
| code patch (determinism improvement) | required | must A/B test against historical inputs |
| `skill.md` patch (reasoning refinement) | auto-append | periodic human review |
| new skill draft | required | must include evidence from a meaningful gig sample |
| output-schema change | **always** required | cascade check: what agents + standards break? |

---

## Knowledge propagation — the payoff

When skills are first-class, improvements propagate through the agent graph without
touching agent definitions.

- **Before (capability fused into agents):** a fix to a shared capability is applied N times
  across N agents, each slightly differently because each agent's method text differs. Drift
  accumulates; one fix becomes N failure modes.
- **After (skill-centric):** improve the skill `v7 → v8`; every agent that lists it in its
  skill slots gets the improvement on the next gig. One fix, one review, universal propagation.
  The agents don't change — the chart gets better.

Skills are the **knowledge layer**; agents are the **reasoning layer**. Separating them lets
knowledge compound across the whole fleet instead of being locked inside individual agents.

---

## Data model

### Skill

| field | purpose |
|---|---|
| `slug` | unique identifier |
| `version` | independent of agent versions |
| `status` | draft → review → approved → active → retired |
| `parent_version` | lineage — what version this evolved from |
| `created_by` | provenance |
| `skill_type` | extraction \| analysis \| generation \| orchestration |
| `determinism_ratio` | computed from recordings: 0.0 (pure reasoning) → 1.0 (pure code) |
| `method_md` | reasoning instructions (the `skill.md` payload) |
| `code_ref` | path to the code half within the package |
| `code_hash` | content hash of the code; verified at load |
| `input_schema` / `output_schema` | typed contract |
| `required_tools` | tool grants the code half needs (the enforcement boundary) |
| `composable_with` | valid composition partners |
| `runtime_deps` | what the code half expects available (Node stdlib by default) |
| `performance_stats` | cached avg_cost, avg_duration, determinism_trend |

### Agent — leaner

Agent definitions describe *identity and disposition, not capability*. Skills carry the
capability.

| field | purpose |
|---|---|
| `slug`, `version`, `status` | identity |
| `primitives` | how it thinks |
| `identity` / `method` | who it is, how it reasons (2–3 paragraphs) |
| `skill_slots` | which skills it CAN load |
| `default_skills` | which load by default |

---

## Adapting to coltrane-OSS

The original model assumed a database + object storage + a Python/Deno container. OSS
coltrane is Node/TS, genome-as-files, "depend on nothing but Claude Code." The adaptation:

| original | OSS |
|---|---|
| skills table in a DB; code in object storage | the **genome is the source of truth** — a skill is a directory under `skills/<slug>/`; `code_hash` is content-addressed over the files |
| Python `skill.py`, container with bs4/requests | TS `skill.ts`, Node stdlib (no container) |
| `skills.load` / `skills.execute` MCP tools | the loader reads packages from the genome directly; `skill_define` / `skill_evolve` / `skill_promote` already exist on the MCP surface |
| Deno `--allow-*` permission flags as the cage | **open question** — see below |
| recorder tracks field origin in a DB signal | the existing recorder/output store tags field origin; `learning_synthesize` is the evolution loop's home |

What maps onto existing OSS pieces:

- **Loader** (`src/loader.ts`) — extend skill loading from `{slug, md}` to the full package
  (meta + schema + code + fixtures), with `code_hash` verification + graceful degradation.
- **Runtime** (`src/runtime.ts` / `runGig`) — add the code-first pass: run the bound skill's
  code, compute the residual, invoke the model only for the gap, validate the union, tag origins.
- **Composition** (`src/composition.ts`) — resolve agent + skills (not just agent); validate
  `composable_with`.
- **Recorder** — tag each output field's origin (code vs. model); feed `determinism_ratio`.
- **Evolution** (`learning_synthesize`) — observe → draft code → test-on-history → propose.

---

## Phased implementation plan

- **Phase 1 — package + loader + pure-code executor.** Load `skills/<slug>/` packages
  (meta + schema + code + fixtures); verify `code_hash`; run `skill.ts` deterministically;
  validate output against the schema; run fixtures as the skill's own tests. Land
  `run-vitest-band` (`determinism_ratio` 1.0) as the first skill — this properly fixes the
  e2e-band "an LLM should not babysit a deterministic command" problem *and* establishes
  the first-class model. Residual/scoring come later.
- **Phase 2 — code-first / model-residual flow.** Run code → compute residual → model fills
  only the gap → tag field origins → validate the union. The full dual-artifact runtime.
- **Phase 3 — determinism scoring + evolution.** Compute `determinism_ratio` from recordings
  (rolling average, `determinism_trend`); the observe → draft → test → propose loop that
  codifies stable reasoning into code.

---

## Open questions

1. **Sandbox / isolation.** How does `skill.ts` run safely? Options: a Node subprocess where
   the permission tier maps to granted env/fs/exec; an in-process `node:vm` or worker; or a
   tighter mechanism. The original used Deno `--allow-*` flags as the cage. *Decide during
   Phase 1, once the package + contract shape is concrete.*
2. **Runtime dependencies vs. zero-dep.** Pure-code skills should lean on Node stdlib only.
   When a skill genuinely needs a dependency, how is it declared and bounded without breaking
   the zero-dependency posture?
3. **`determinism_ratio` computation in the OSS recorder.** Field-origin tagging needs to flow
   from the runtime through the output store so the rolling average is computable from sealed
   records.
