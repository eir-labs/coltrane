# Red-spec — an agent can require an input it cannot work without

**Gig:** d048e2fa-7ee2-496e-b931-5d82fa112bba · **Phase:** draft-laws · **Base:** main

## The gap

`Agent.input_types` is a **capability envelope**, deliberately: `src/composition.ts:530` checks
"what THIS PLACEMENT actually consumes, not the agent's GLOBAL input_types (its capability envelope
across all roles)", and the runtime floor at `src/runtime.ts:2315` is `.some`, not `.every`.
`Chair.input_contract` is what a placement consumes. Nothing lets an agent say **"I REQUIRE X in
every placement"**, so nothing checks it. `code-implementer` declares
`input_types: ["change-plan","red-spec"]` yet composed and ran for weeks on a chair whose
`input_contract` was `["change-plan"]` only — the RED-spec its whole method depends on was never
guaranteed to reach it.

## The obligations (each with its mechanism, callsite, and RED test)

The enforcement does not exist yet; these are the laws it must satisfy. Tests live in
`tests/an_agent_can_require_an_input.test.ts`.

### 1. An agent can declare `required_inputs`

- **Mechanism:** add an optional field `required_inputs: z.array(z.string()).readonly().default([])`
  to `AgentSchema` in `src/genome_schema.ts` — the ONE Zod source, from which the TS type
  (`z.infer`), the MCP `input_schema` (`zodToMcpProps(AgentSchema)`), and the loader validation all
  derive. No hand-edit of the TS type or the MCP schema. Optional + `default([])` so every existing
  agent JSON round-trips byte-equivalent (a Zod object drops an undeclared key, so the field must be
  declared here to be retained).
- **Callsite:** `AgentSchema` at `src/genome_schema.ts:92`.
- **Guarded by:** `INV-SCHEMA-OPTIONAL` (an agent with no `required_inputs` still parses).

### 2. `required_inputs ⊆ input_types` — the cross-field rule (schema layer)

- **Mechanism:** a `superRefine` (or object-level `.refine`) on `AgentSchema` asserting every entry
  of `required_inputs` also appears in `input_types`, with a Zod message naming the offending type.
  Fails at parse/define/load time — an agent requiring an input outside its own capability envelope
  is malformed, not merely un-composable.
- **Callsite:** `AgentSchema` at `src/genome_schema.ts:92`; parsed through `defineAgent`
  (`src/composition.ts:204`) and the loader.
- **Verified by:** `INV-SCHEMA-SUBSET` (parse throws when an entry is absent from `input_types`) —
  **RED**. Controlled by `INV-SCHEMA-SUBSET-OK` (a genuine subset parses).

### 3. composeStandard refuses a chair that omits a seated agent's `required_inputs`

- **Mechanism:** inside the chair-level validation loop in `composeStandard`
  (`src/composition.ts:310-360`, the `if (!isSkillChair && !isHumanChair)` branch — same scope as the
  `required_skills` and hydration dead-slot checks), for each entry of the seated agent's
  `required_inputs` not present in `ch.input_contract`, throw a `CompositionError`. Model the message
  on the dead-slot refusal at `src/composition.ts:352-358`: name the **standard** (`def.slug`), the
  **chair** (`ch.role`), the **agent** (`ag.slug`), the **missing type**, and the **fix** (add the
  type to this chair's `input_contract`, or drop it from the agent's `required_inputs`). Checked
  against `ch.input_contract` — the placement's consumption — not the standard's gig `input_types`.
- **Callsite:** the chair loop at `src/composition.ts:310`; the model message at
  `src/composition.ts:352-358`.
- **Verified by:** `INV-COMPOSE-REFUSES-OMITTED` (a chair omitting the required input throws
  `CompositionError`) and `INV-MESSAGE-NAMES-ALL` (the message names standard/chair/agent/type/fix) —
  both **RED**. Controlled by `INV-COMPOSE-ACCEPTS-SATISFIED` (the chair composes once its
  `input_contract` carries the required input) and `INV-NO-OVER-REFUSAL` (an agent declaring no
  `required_inputs` is never refused for omitting an envelope input).

### 4. Nothing changes at runtime

- **Mechanism:** the `.some` floor at `src/runtime.ts:2315` is untouched. `required_inputs` is a
  compose-time mandate; the runtime envelope semantics are frozen.
- **Guarded by:** no test asserts a runtime change; the calibration gate exercises the real loader
  end-to-end without touching runtime.

### 5. Calibration — the shipped genome still composes GREEN

- **Mechanism:** `agents/code-implementer.json` declares `required_inputs: ["red-spec"]`. `red-spec`
  is already in its `input_types`, so the cross-field rule (obligation 2) is satisfied with no change
  to `input_types`. Both standards that seat `code-implementer`
  (`standards/software-change-pr-v1.json`, `standards/software-change-red-first-v0.json`) already list
  `red-spec` in the `write-change` chair's `input_contract`, so both compose GREEN under obligation 3.
  If either did NOT compose, the analysis is wrong — **stop**, do not widen a chair's `input_contract`
  to fit.
- **Verified by:** `INV-CALIBRATION-GREEN` (`loadGenome(REPO_ROOT)` reports zero `standard`
  `load_errors` and both standards are present).

## Non-goals

No change to `input_types` envelope semantics; no change to the runtime `.some` check;
`required_inputs` optional everywhere; no new dependency; no weakening of existing compose-time laws.

## Testing method

Example-based (Vitest), asserting the specific compose-time and parse-time behaviours against the
real callsites — `composeStandard`, `AgentSchema.parse`, and `loadGenome`. See the coverage map in
the sealed red-spec for the invariant → test mapping.
