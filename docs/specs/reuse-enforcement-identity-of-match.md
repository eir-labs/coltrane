# Reuse enforcement must know identity from duplication

**Gig** 2b3af80b · phase draft-laws · agent red-spec-drafter
**Target** `src/registry.ts` (private `score` closure, `registerType`, `resolveType`)
**Laws** `tests/type_resolution.test.ts` — `describe("reuse enforcement — identity of the match (own version vs duplicate)")`

This is a RED spec. The laws below are written and running against the real
callsites in `src/registry.ts` at c203968. INV-1 is RED **by design** — the
enforcement it demands does not exist yet. INV-2 and INV-3 are must-not-weaken
guard pins: GREEN today, and each names the wrong implementation under which it
would go RED, so neither is a tautology.

## The defect

`registerType` (`src/registry.ts:296`) calls the private `score` closure
(`src/registry.ts:244`) with a query built from the new type's own
`{ extends, domain, required_fields }`, and throws when the best existing score
is `>=80`:

```
reuse enforcement: an existing type scores 90.00000000000001 (>=80)
```

`score` filters candidates by `extends`, then ranks on field coverage and
domain affinity (`src/registry.ts:245-263`). **The query carries no slug, and
`score` consults none.** So a type's own next version — same slug, same parent,
same domain, a superset of its own `required_fields` — scores near-100 against
its stored prior version and is refused as a duplicate of itself. Measured
consequence: PR #432 could not call `registerType` after persisting an extended
type and had to route the entry in through `replaceTypes`.

`score` computes `best` across candidates in a loop and **discards which
candidate won** (`src/registry.ts:260`), so a caller holding the result cannot
ask "was the match myself?". Identity is absent from a decision that is entirely
about identity.

## The obligations

| Obligation | Mechanism (to be built) | Callsite | Law |
|---|---|---|---|
| A type's own next version (same slug) is not refused as a self-duplicate | `registerType` must exclude its own slug from candidacy before scoring | `src/registry.ts:302-305` | INV-1 |
| A genuinely similar, differently-named new type is still refused at `>=80` | Scoring is unchanged for every candidate whose slug is not the registrar's own | `src/registry.ts:245-263` | INV-2 |
| `resolveType` still surfaces same-slug candidates | The `resolveType` path must pass **no** exclusion — "what should I reuse?" keeps same-slug matches | `src/registry.ts:309-311` | INV-3 |

## Chosen shape (settled upstream, recorded here)

**Shape A** — give the private `score` closure an optional slug-exclusion set;
`registerType` passes `new Set([def.slug])`; `resolveType` passes nothing.

Grounded in what both call paths need, read from the code:

- `score` is a **non-exported closure**; adding an optional parameter touches no
  public contract. `ResolveResult` (`src/registry.ts:40-44`) — the return type of
  the exported `resolveType` — is left unchanged.
- `registerType` asks "is this a NEW type that duplicates an existing one?".
  Excluding its own slug removes the one candidate that can never be a
  duplicate-of-a-different-type: itself.
- `resolveType` asks a **different** question — "what should I reuse?" — where a
  same-slug candidate is a meaningful reuse target. It passes no exclusion, so
  that path is structurally unchanged and zero-cost.

Rejected: **Shape B** (emit the winning candidate's slug in `ResolveResult` and
compare in `registerType`) widens a public type with a winner-slug that has no
meaning to `resolveType`'s callers. **Post-hoc candidate scan** is structurally
wrong — `candidates` is the full same-`extends` set, not the winner, so
self-membership does not mean self won. **Pre-score existence gate**
(`types.has(def.slug)`) removes enforcement for any re-registration rather than
correcting its identity blindness.

## The laws

- **INV-1** `accepts a same-slug next version (superset required_fields) instead
  of refusing it as a self-duplicate` — registers `finding`, then a same-slug
  next version adding a declared+required `evidence` field, and asserts
  `registerType` does not throw. **RED today**: throws
  `reuse enforcement: an existing type scores 90.00000000000001 (>=80)`.
- **Calibration** `a same-slug next version scores >= 80 against its own prior
  version` — proves the INV-1 fixture genuinely trips the gate (superset
  direction: `field_coverage = 3/4 = 0.75`, score `= 90`), so the pre-fix
  failure is a real refusal and not a fixture that trivially scores `<80`.
  GREEN.
- **INV-2** `still refuses a genuinely similar type under a DIFFERENT slug at
  >= 80` — registers `finding`, then `{ ...finding, slug: "finding-2" }`, and
  asserts the specific `reuse enforcement: an existing type scores N (>=80)`
  error. GREEN before and after; would go RED if the fix excluded by existence
  rather than by the registrar's own slug.
- **INV-3** `resolveType still surfaces the same-slug candidate rather than
  silently dropping it` — asserts the same-slug candidate is present in
  `candidates`, `action === "use"`, `score >= 80`. GREEN before and after;
  would go RED if slug-exclusion leaked into the shared `score` path instead of
  being scoped to `registerType`.

The sibling law `rejects registration when an existing type already scores at
least 80` (`tests/type_resolution.test.ts:60-64`) stays present and unmodified —
INV-2 is its stronger, error-specific companion.

## Out of scope

Unwinding PR #432's `replaceTypes` workaround; changing the 80/50 thresholds or
`RESOLVE_WEIGHTS`; usage/recency statistics; `domain_type_version` handling.
