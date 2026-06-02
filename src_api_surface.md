# Coltrane-OSS — src/ API surface

The tests already in `tests/` import the following names from `../src`. Anyone implementing `src/` must export exactly these. Derived from `grep -h 'from "../src"' tests/*.ts`.

## Types (TypeScript interfaces/type aliases)
- `AccessGrant` — §9, see schema in `Coltrane Spec.docx.md` line 522-548
- `ProfileSpace` — `"creative" | "harmonic" | "permissions"` (§4)
- `ChangeClass` — `"additive" | "modified" | "breaking"` (§5)

## Constants (data)
- `CORE_TYPES` — array of 6 names: `"Signal","Interpretation","Judgment","Plan","Artifact","Verdict"` (§2)
- `REFERENCE_TYPES` — array of 6 names: `"derived_from","validates","challenges","refines","triggers","contains"` (§2)
- `PRIMITIVE_OUTPUT_TYPE` — map: `{SENSE:"Signal", INTERPRET:"Interpretation", JUDGE:"Judgment", PLAN:"Plan", CREATE:"Artifact", VERIFY:"Verdict"}` (§3)
- `RESOLVE_WEIGHTS` — `{field_coverage:0.4, usage_gravity:0.15, downstream_satisfaction:0.2, domain_affinity:0.15, recency:0.1}` (§5)
- `DEPTH_MULTIPLIER` — `{skim:0.5, quick:0.75, standard:1.0, deep:2.0}` (§12)
- `MODEL_MULTIPLIER` — `{economy:0.5, standard:1.0, premium:2.0}` (§12)
- `MCP_TOOLS` — array of tool definitions `{slug, category, input_schema, output_schema}` (§7, ≈28 tools)

## Functions
- `createRegistry()` — returns an in-memory type registry with `.registerType(t)`, `.resolveType(query)`, `.list()`
- `computeCredits(opts)` — returns number per §12 formula
- `requiresApproval({slug, change_class, target_kind})` — returns boolean per §7 Approval Requirements table
- `checkGrantTTL(grant, nowMs)` — returns `{valid, reason?, remaining_ms?}`
- `defineAgent({slug, primitives, input_types?, output_types?, domain?, ...})` — returns Agent or throws on §3 illegal progression
- `composeStandard({slug, domain, agents, phases})` — returns Standard or throws on §3 cycle / §3 invalid agent mix / domain mismatch
- `proposeAgentChange(base, next)` — returns `{space, approval_required, type_check_passed?}`  per §4 three spaces
- `proposeTypeChange(base, next)` — returns `{change_class, approval_required, next_version, old_version_stays?}` per §5 versioning rules
- `standardSimulate({standard_slug, mock_input, depth})` — returns `{phases[], estimated_cost, estimated_duration_ms}` per §7
- `validateOutput({core_type, domain_type, data})` — returns `{valid, reason?}`, enforces §9 Artifact.validation_criteria + Verdict.checks

## Files the loader must read
- `core_types/<slug>.json` — 6 files for the immutable core types (Eugene: "types as defined in files")
- `domain_types/<slug>.json` — N files for domain extensions
- `agents/<slug>.json` — N files for agent profiles
- `standards/<slug>.json` — N files for standards
- `tools/<slug>.json` — N files for tool registrations

## Honest Note (the rule, not metaphor)
Eugene's directive: "no file changes to make types." That means adding a new type = adding a new JSON file under `core_types/` or `domain_types/`. No TypeScript edit. The runtime loads from disk, validates with ajv, exposes via the registry. The TS layer in `src/` is the LOADER + VALIDATOR, never the SOT of which types exist.

## Owner
See `tracking.json` for `src/` ownership. Anyone unblocked on impl: claim sub-files in `tracking.json.src_implementation`.
