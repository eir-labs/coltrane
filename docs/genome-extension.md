# Genome Extension & Polymorphism

> *The engine ships a base genome. A consumer extends it — inherits the base,*
> *adds its domain, specializes what it needs. Subclassing, for the whole*
> *definition set.*

**Status:** DRAFT / proposal. Defines layered, polymorphic genomes. The `core_types`
compile-in (a base layer for the `types` class) is the first concrete slice.

---

## Thesis

Today `loadGenome(root)` loads **one** directory and treats it as the whole world. That
forces every downstream consumer to hand-author or copy everything — the 6 immutable
core types, base players, starter standards — before they can do their own work, and it
means a base improvement reaches no one.

**Genome extension** makes the genome *layered*: the engine (or any upstream) ships a
**base genome**, and a consumer's genome **extends** it — inheriting the base, adding its
domain definitions, and **overriding by slug** where it needs to specialize. The same
move as class inheritance, applied to the full set of definition classes.

---

## This is the generalization of things we already do

| already shipping | is really… |
|---|---|
| the 6 immutable core types | a base layer for the `types` class (every genome inherits them) |
| the base players (shipped subagents) | base `agents` a consumer inherits + specializes |
| skill knowledge propagation (improve a base skill → every agent that loads it improves) | base `skills` inherited and improving *underneath* consumers |

So the `core_types` compile-in isn't a one-off downstream fix — it's the **first slice of
genome extension**, restricted to one class. The same layering generalizes to
`domain_types`, `agents`, `standards`, `skills`, `evals`.

---

## The hash model already anticipates this

The three identity hashes were built for contextual binding:

- `content_hash` — the bytes of a definition (identical in the base or anywhere)
- `dependency_hash` — its relational closure
- `effective_hash` — **the binding in a context**

*"Two byte-identical definitions in different contexts produce different `effective_hash`."*
That sentence is polymorphism. A base `summarizer` bound into a consumer's extended
genome has a different `effective_hash` than the same bytes in the base — same definition,
contextualized binding. The substrate was designed for layered contexts; extension is
what produces them.

---

## The model

### Layers

A loaded genome is a stack of layers, lowest (base) to highest (consumer):

```
[ base genome ]      ← shipped by the engine (or an upstream package), version-pinned
[ … intermediate ]   ← optional further bases (a domain pack a team shares)
[ consumer genome ]  ← the local repo: domain types + agents + standards on top
```

`loadGenome` resolves the stack into one effective genome:

- **Inherit** — every definition in a lower layer is present unless overridden.
- **Add** — a higher layer introduces new slugs freely.
- **Override by slug** — a higher layer may replace a lower-layer definition of the same
  slug (polymorphic specialization). Precedence is strictly highest-layer-wins, and the
  override is recorded (provenance: which layer supplied each effective definition).

### What extends, what is immutable

| class | extensible? |
|---|---|
| `core_types` | **No.** The 6 are immutable substrate (1:1 with the cognitive primitives). A base provides them; no layer adds a 7th or alters one. |
| `domain_types` | Yes — add subtypes (`extends` a core type); override by slug. |
| `agents` | Yes — add agents; override/specialize a base player by slug. |
| `standards` | Yes — add standards; override a base standard by slug. |
| `skills` | Yes — add skills; override a base skill by slug (and base skills improve underneath). |
| `evals` | Yes — add/override. |

Extension lives at every layer *except* the core set.

### Type subtyping (Liskov)

Polymorphic *types* — a base contract written against `Signal` accepting any subtype of
`Signal` — is sound only if a subtype **carries its base's contract**: a domain type
extending `Signal` must include `Signal`'s required fields (schema ⊇ base schema). This
is not enforced today (a domain type declares its own schema with no superset check). It
is a prerequisite for subtype-aware contracts and for safe `agents`/`standards` overrides.

---

## Versioning

A consumer **pins a base genome version** (like extending a versioned base class). When
the base evolves:

- the consumer re-resolves against the new base version;
- a **cascade check** (the genome-level lift of `agent_evolve`'s `cascade_check`) reports
  what in the consumer layer breaks against the new base — overridden slugs whose base
  contract shifted, dangling references, type-edges that no longer hold;
- the consumer either accepts the new base (clean) or pins the old until it adapts.

Each layer is content-addressed; the **effective genome's hash** is a function of the
layer stack, so the same consumer genome over two different base versions is two
distinguishable, reproducible states.

---

## What it gets us

- **Minimal consumer genomes** — author only your domain; inherit a working base (cores +
  players + starter standards + skills).
- **Compounding** — improve a base standard or skill once and *every* consumer inherits it
  (the skill-spec payoff, generalized to the whole genome).
- **Polymorphic specialization** — override one base agent for your domain, inherit the
  other dozen unchanged. Knowledge stays in the base; identity-level tweaks stay local.
- **A real packaging story** — `npm install` brings the engine *and its base genome*; the
  consumer repo extends it. No hand-copying immutable substrate to boot.

---

## Relationship to other specs

- **[Skills as first-class](./skills-as-first-class.md)** — base skills are a layer here;
  "improve a skill, every agent that loads it improves" is genome extension for the
  `skills` class. The two specs compose.
- **core_types compile-in** — the first slice: a base layer for `types`, providing the
  immutable 6 so a consumer genome with none still boots.

---

## Phased plan

- **Phase 1 — base layer for `core_types` (the compile-in).** The engine provides the 6
  canonical core types; `loadGenome` seeds them when a genome root has none. Fixes
  downstream boot today and is the first, smallest layer. *(In progress.)*
- **Phase 2 — multi-layer resolution for all classes.** `loadGenome` accepts a layer
  stack (base + consumer), resolves with highest-layer-wins precedence, records per-slug
  provenance, and computes the effective genome hash over the stack.
- **Phase 3 — base pinning + cascade + subtype-safe contracts.** Version-pin the base;
  genome-level cascade check on base evolution; enforce schema inheritance (domain ⊇ base)
  so subtype substitution in contracts is sound.

---

## Open questions

1. **How is the base referenced?** A manifest field on the consumer genome
   (`extends_genome: "@eir-dev/coltrane@<version>"`), resolved from the installed package?
   A path? Multiple bases?
2. **Override conflict rules.** Is overriding a base agent silent, or does it require an
   explicit "I am replacing base slug X" marker so an accidental slug collision fails loud?
3. **Hashing the stack.** Exact rule for folding layer hashes into the effective genome
   hash so reproducibility holds across base-version bumps.
4. **Subtype substitution in contracts.** Once schema inheritance is enforced, do
   input/output contracts match by exact slug *or* by "slug or any subtype"? The looser
   rule unlocks reusable base players; it also loosens exactness — likely opt-in per chair.
