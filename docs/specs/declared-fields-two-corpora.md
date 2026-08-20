# Spec: the declared-field sweep splits into two corpora — engine vs contract

## The contract

`tests/declared_fields_are_read.test.ts` + `tests/support/declared_field_reachability.ts` ship one
sweep that unions **three namespaces** and searches **one corpus** (top-level `src/*.ts`). Those three
namespaces are not one population — they carry two different reader obligations:

- **ENGINE fields** — the Zod object keys of `src/genome_schema.ts`. `src/` is the *right* corpus:
  orchestrator code is supposed to read them. A genome field with no `src/` reader is a genuine
  dead-contract defect.
- **CONTRACT fields** — the `schema.properties` keys of `domain_types/*.json` + `core_types/*.json`.
  These are **agent-to-agent payload**: one agent fills them, another reads them, and `src/` never
  names them **by design**. Their reader corpus is `agents/` + `standards/` + `evals/` + `src/` — a
  field named by an agent method or a standard **is** read.

Searching only `src/` for both conflates the two: of the 181 reported unread, most are CONTRACT
fields that `src/` was never going to name, and the four real ENGINE cases the ratchet exists for are
buried among them. It also **weakens the calibration**: `tests_added` (a CONTRACT field on
`change-set.json`) was found unread by the *original* claim that **nothing anywhere** reads it —
established by grepping `src/ tests/ standards/ evals/`. A `src/`-only sweep proves only "no `src/`
reader", which for a payload field proves far less.

This change ships the **split detector and the two pins only**. It fixes no field, touches no schema,
adds no dependency, uses no AST, and makes no network call. It **extends** the existing seven laws
rather than rewriting them.

## Obligations, their mechanism, and the red test that verifies each

Every red test lives in `tests/declared_fields_are_read.test.ts`, in the new describe block
`declared fields split into two corpora — engine (src/) vs contract (broad)`. Each is RED today
because the enforcement it names is `undefined` — the two analyzers and two pins do not exist yet, so
the call throws `… is not a function` inside its own `it` (the existing seven laws keep running green).

| # | Invariant | Mechanism / callsite | Red test |
|---|-----------|----------------------|----------|
| INV-ENGINE-CORPUS | ENGINE fields = `genome_schema.ts` Zod keys, searched in `src/*.ts` **only**; a non-`src/` hit does not clear an engine field. | `analyzeEngineFieldReachability()` reuses `declaredFieldsFromGenomeSchema()` and the flat `src/*.ts` reader; `MIN_NAME_LENGTH` and the Object.keys/spread/dynamic fail-safe unchanged. | `engine population is non-vacuous and yields NAMES …`; `engine fail-safe soundness: every engine-unread field truly has NO word-boundary read in src/*.ts` |
| INV-CONTRACT-CORPUS | CONTRACT fields = `domain_types/*.json` + `core_types/*.json` `schema.properties`, searched in `agents/` + `standards/` + `evals/` + `src/`; a `\bname\b` hit in **any** of the four is READ. | `analyzeContractFieldReachability()` extracts the JSON-dir property keys and sweeps a recursive broad corpus (agents recursive, incl. `phase_agents/`, `players/`, `seeds/`; `src/` recursive incl. `src/judges/`). | `contract population is non-vacuous and yields NAMES …`; `contract fail-safe soundness: no contract-unread field has a word-boundary hit in the BROAD corpus` |
| INV-SEPARATE-PINS | The two populations report separately with **separate** ratchet floors; no single combined count replaces them. | Exports `PINNED_UNREAD_ENGINE_FIELDS` and `PINNED_UNREAD_CONTRACT_FIELDS`; each `report.unread.length === ` its own pin. | `two SEPARATE pins — the engine ratchet is not the contract ratchet` |
| INV-CALIB-POS-TESTS_ADDED | `tests_added` IS unread against the **broad** corpus (the original, stronger claim: nothing anywhere reads it). | `tests_added` ∈ `change-set.json` `schema.properties`, ∉ its `required_fields`; zero `\btests_added\b` across `agents/ standards/ evals/ src/`. | `calibration+ (sharpened): 'tests_added' IS unread against the BROAD corpus` |
| INV-CALIB-NEG-REPOSITORY | `repository` is unread in **neither** population. | CONTRACT field read at `src/worker.ts` (`(claim.input as { repository?: unknown })?.repository`, ~line 145); a `src/` hit clears it in both. | `calibration- : 'repository' is unread in NEITHER population (read at src/worker.ts)` |
| INV-CALIB-NEG-SUPPLIES-HYDRATION | `supplies` and `hydration` are NOT unread in the ENGINE population. | `supplies` value-read `src/runtime.ts:2585` and keys `src/composition.ts:346` (`Object.keys(ch.supplies ?? {})`, counted READ); `hydration` `src/claude_invoker.ts:183/185`, `src/runtime.ts:2585`. | `calibration- : 'supplies' and 'hydration' are NOT unread in the ENGINE population` |
| INV-MIN-NAME-LENGTH | The `>= 5`-char exclusion (its stated consequence: genuinely-unread short fields silently omitted) survives in **both** populations. | Both analyzers skip names below `MIN_NAME_LENGTH`; no reported name is shorter than 5. | `MIN_NAME_LENGTH holds in BOTH populations — no reported name is shorter than 5 chars` |
| INV-METHODNOTE-FAILSAFE | `methodNote` survives as a first-class, testable string on **both** reports, carrying every marker; the fail-safe (ambiguous is READ → each pin is a LOWER bound) is preserved. | Both reports expose `methodNote` naming `Object.keys`, `spread`, `dynamic`, the `READ` fail-safe, and `src/`. | `METHOD_NOTE survives on BOTH reports with every marker — not a strippable comment` |
| INV-OBJECTKEYS-AS-READ | A field appearing only inside `Object.keys(x)` counts as READ (not excluded from readers). | Preserved in both sweeps; exercised by `supplies` (cleared via `Object.keys(ch.supplies)`) and asserted in `methodNote`. | `calibration- : 'supplies' and 'hydration' …`; `METHOD_NOTE survives on BOTH reports …` |
| INV-CONTRACT-SOUNDNESS-INDEPENDENT | The CONTRACT soundness law re-reads the broad corpus **independently** of the engine — an engine corpus bug cannot mask a false positive. | The test file's own `broadCorpus()` / `readTreeText()` re-derive `agents/ + standards/ + evals/ + src/` from scratch (not the engine's reader), and a non-vacuity guard proves each non-`src/` location contributed text. | `contract fail-safe soundness …`; `the broad corpus genuinely reaches agents/ + standards/ + evals/ — the soundness law is not vacuous` |

## Method and its preserved invariants

A field name is READ iff `\bname\b` matches in the relevant corpus. Names below `MIN_NAME_LENGTH = 5`
are excluded (they collide with incidental substrings) — an accepted limit, not a completeness claim.

**Fail-safe: ambiguous is READ.** Any word-boundary hit counts as a read — including a name inside an
`Object.keys(x)` argument, a spread `{...x}`, or an `as { name: T }` assertion. Precise exclusion needs
an AST (forbidden) and risks calling a value-read field dead. The hydration defect hid inside an
`Object.keys` read, so each sweep errs toward READ, and each pin is therefore a **lower bound** on the
true dead-field count. This posture is preserved unchanged in **both** populations.

**agents/ corpus depth (recorded choice).** The CONTRACT reader is **recursive** — agents' top-level
`*.json` plus `phase_agents/`, `players/`, and `seeds/`, and `src/` recursively (so `src/judges/`
counts). Rationale: the fail-safe under-reports, so a broader reader set can only *lower* the contract
pin, never inflate it — recursive is the conservative choice. The test-side `broadCorpus()` applies the
**same** depth so the soundness cross-check cannot be stricter than the analyzer.

## RED-first structure

`tests/declared_fields_are_read.test.ts` is the SEALED law. The two-population enforcement it demands —
`analyzeEngineFieldReachability()`, `analyzeContractFieldReachability()`,
`PINNED_UNREAD_ENGINE_FIELDS`, `PINNED_UNREAD_CONTRACT_FIELDS` from
`./support/declared_field_reachability.js` — does not exist yet. To keep `tsc` clean (this repo builds
before vitest) while staying RED at runtime, the laws reach those symbols through a namespace import
cast to a declared **future shape** (`TwoCorporaEngine`): the compiler sees the intended types, but at
runtime each member is `undefined`, so every new law fails RED on its own assertion. That absence
failing loudly, per-law, IS the spec.

The builder ADDS the two analyzers and two hand-verified pins to
`tests/support/declared_field_reachability.ts`, extending `METHOD_NOTE` and `CALIBRATION_TRAIL` to
document both populations, and re-points the original seven laws per population. The pin values are
**not** in the upstream record (the current 181 is a combined count; the split is unknown until the
analyzers run) — the builder sets each pin by hand-verification against actual grep output during the
GREEN steps, a false positive fixed in the analyzer and never absorbed into a pin. The engine lives
under `tests/support/` (not `src/`) deliberately: were it in `src/`, its own source text — which names
every calibration field in prose — would enter the reader corpus and mask a dead field.

### Engine module contract (`tests/support/declared_field_reachability.ts`, ADDED by the builder)

```ts
export interface FieldReachabilityReport {
  unread: string[];     // declared field names (>= 5 chars) with no reader in the population's corpus, sorted
  totalFields: number;  // count of distinct names swept in this population (>= MIN_NAME_LENGTH)
  methodNote: string;   // method + blind spots (must name Object.keys, spread, dynamic, READ, src/)
}
// ENGINE: genome_schema.ts Zod keys, searched in src/*.ts ONLY.
export function analyzeEngineFieldReachability(): FieldReachabilityReport;
// CONTRACT: domain_types/ + core_types/ schema.properties, searched in agents/ + standards/ + evals/ + src/.
export function analyzeContractFieldReachability(): FieldReachabilityReport;
export const PINNED_UNREAD_ENGINE_FIELDS: number;   // hand-verified; may only decrease
export const PINNED_UNREAD_CONTRACT_FIELDS: number; // hand-verified; may only decrease
```

## Non-goals

Do not fix the unread fields either sweep names. Do not modify `domain_types/`, `core_types/`, or
`src/genome_schema.ts`. Do not weaken the fail-safe posture, `METHOD_NOTE`, the `Object.keys`
exclusion, or `MIN_NAME_LENGTH`. Do not rewrite or remove any of the existing seven laws — extend only.
Do not collapse the two populations back into one combined ratchet. Do not count `tests/` as a reader
corpus. No new dependency, no AST library, no network.
