# Coltrane enforces the laws it declares — RED spec

Coltrane's public position is that an institutional law is machine-checkable at the moment of
action, not prose that sounds binding. Today that is not demonstrated by its own genome:
`institutions/coltrane.json` ships three ADICO laws whose `check.predicate` is a real s-expression
that nothing has ever evaluated, and `composeStandard` verifies chair caps at dispatch while
verifying no chair obligation at all. This change repairs the claim. It ships in the open-source
repo, because withholding the mechanism that makes a law checkable publishes the opposite claim.

This document is the RED spec: the tests exist and fail because the enforcement is absent. The
GREEN change fills the stub bodies in `src/institution_enforcement.ts`, adds one additive optional
field to `NormPairSchema`, and edits `institutions/coltrane.json`.

## Change discipline

| field | value |
|---|---|
| `scope` | (1) a zero-dependency s-expression predicate evaluator `evaluate(check, facts) -> Verdict`; (2) an explicitly-invoked `checkInstitutionAdmissibility(doc)`; (3) an additive optional obligation-tier field on `NormPairSchema`; (4) edits to `institutions/coltrane.json` so it passes its own bar. |
| `vitest_test_path` | `tests/institution_law_evaluator.test.ts`, `tests/institution_admissibility.test.ts`, `tests/institution_additive_invariance.test.ts` |
| `stop_condition` | every subsystem-contract invariant I1–I25 has a real failing assertion; the suite compiles (`tsc --noEmit`); the four pinned institution tests stay green. |
| `non_goals` | no question/interrogation engine, VOI axes, or gated stages; no change to `InstitutionSchema.lineage`; no turn-budget work (PR #331); no wiring admissibility into `loadGenome`; no multi-law combining; no SUPPRESS/INSERT enforcement actions; no value-type-checking of facts. |
| `run_protocol` | RED tests written first (this spec); GREEN fills `src/institution_enforcement.ts`, extends `NormPairSchema`, edits `coltrane.json`; `npm run verify`. |
| `outcome` | RED spec: completed. |

## Item 1 — the predicate evaluator

New callsite: `evaluate(check: {predicate, inputs}, facts) -> Verdict` in
`src/institution_enforcement.ts` (stub throws today). The verdict codomain is a closed algebra
grounded in XACML 3.0's four-valued model:

| verdict | meaning | red test |
|---|---|---|
| `PERMIT` | an allow atom, or a satisfied obligation | I6, I21 |
| `DENY` | a deny atom, or a breached obligation (the `or_else` fires) | I6, I7, I20, I22 |
| `NOT_APPLICABLE` | the guard of `(=> P Q)` is false — the law does not govern this action | I4, I5, I20–I22 |
| `UNDECIDED` | well-formed but the fact-only evaluator cannot reduce it (e.g. `resolvable`/`forall` with no genome); never coerced to a decision | I4, I8 |
| `DEAD_NAME` | a name declared in `check.inputs` is absent from the facts; fails closed, the analogue of `resolveAgentGrants().unknown` in `src/runtime.ts` | I3, I23 |

Reduction rules (`(=> P Q)`: P-false → `NOT_APPLICABLE`, P-true → reduce Q; atom `allow`/`deny` →
`PERMIT`/`DENY`; `(require R)`: R-true → `PERMIT`, R-false → `DENY`; `and`/`not`/`=`/`or` are the
ordinary boolean/equality operators over supplied atoms). The operator table is the **union** across
both shipped institutions — coltrane `{=>, and, not, =, is-agent, human-governor, require, allow,
deny}` and quartet `{subseteq, forall, resolvable, nonempty, declared_before, has, or,
backed_by_contract}`. An operator the evaluator does not implement is `UNDECIDED` at runtime (I8)
and an admissibility refusal statically (I12).

**Fact-record convention this spec fixes.** A `principal` fact (e.g. `actor`) is an object; `(is-agent
x)` reads `x.is_agent === true` and `(human-governor x)` reads `x.human_governor === true`. `action`,
`source`, `ci-status` are supplied as their literal string values.

**DEAD_NAME vs UNDECIDED are distinct** (dossier open-question, resolved as a decision): DEAD_NAME is
a document/call defect that fails closed; UNDECIDED is an honest non-decision on a well-formed
predicate. Folding both into one value would lose the ledger's ability to tell a defect from an
undecidable predicate. Neither is ever coerced to PERMIT/DENY (I4).

**SMT backend later, same interface.** SMT-LIB2 is itself s-expression many-sorted first-order logic,
so a Z3 backend sits behind the identical `evaluate()` signature and codomain; solve-vs-evaluate
stays inside the box (I9). PERMIT/DENY/UNDECIDED is a deliberate strict subset of the edit-automata
TERMINATE/SUPPRESS/INSERT taxonomy (Ligatti, Bauer & Walker 2005); SUPPRESS and INSERT are a named
future gap, extendable behind this interface.

## Item 2 — admissibility: a document declares its own enforcement

New callsite: `checkInstitutionAdmissibility(doc) -> {admitted, offenders[]}` in
`src/institution_enforcement.ts` (stub throws today). Per law: predicate parses (I10); every free
variable is declared and every declared input is referenced (I11); every operator is implemented
(I12); `or_else` is non-empty (I13 — the ADICO slot separating a rule from a norm; the schema's
`z.string()` lets `''` through, so admissibility adds the check). Per chair obligation: it is
verified **or** marked declared-tier (I14) — an unmarked unverified obligation is refused, so
silence cannot pass a norm off as a rule. Offenders are collected and refused **once** (I15),
mirroring the collect-all/refuse-once sweep in `src/runtime.ts:1144-1194`.

The marking lives as an **additive optional field on `NormPairSchema`** (`tier: "declared" |
"enforced"`, absent-parses-fine), so pre-existing files still parse (I17). Admissibility is a
separate explicitly-invoked pure function; it is **not** wired into `loadGenome` — a universal gate
would refuse `quartet.json` and break "loads unchanged" (I16).

## Item 3 — close the three findings on coltrane.json

- **(a) Laws evaluate.** Each of the three laws is exercised against a typed fact record with at
  least one refusal and one permission (I20–I22), plus a dead-name case (I23). Required GREEN edit:
  Law A declares an input `target_branch` its predicate never references — an unused declaration I11
  refuses. Remove `target_branch` from Law A's `inputs` (and recompute that law's `content_hash`,
  which `tests/coltrane_institution.test.ts` pins) so coltrane.json passes I19.
- **(b) Chair obligations.** The `change-author` and `human-governor` chairs carry unmarked
  obligations with no verifier. **Decision (deliberate, per lineage-record 03cacf6a): mark them
  declared-tier, do NOT begin enforcing them.** Beginning to enforce obligations would change the
  institution's design; this change only makes the enforced/declared split *stated in the document*
  rather than discovered by a lineage pass. GREEN adds `"tier": "declared"` to each obligation
  (I24), which leaves `InstitutionSchema.lineage` untouched (I25).
- **(c) `preferred_skills`.** Stays soft down to its names — a chair may prefer a technique no agent
  has grown yet. Unchanged; stated as a decision.

## Additive-only, proven not asserted

`I18` loads every shipped agent/standard/chart/venue file through `loadGenome` and asserts no load
errors, and round-trips a declared-tier-marked institution chair loss-free — the specific guard that
the schema change did not start refusing an existing file.

## Do-not-touch

`tests/coltrane_institution.test.ts`, `tests/institution_laws.test.ts`,
`tests/institutional_schema_layer.test.ts`, `tests/institution_law_attribution.test.ts` (pinned
green); `InstitutionSchema.lineage` (deliberately empty in OSS); PR #331's branch files;
`genome-view.html`.
