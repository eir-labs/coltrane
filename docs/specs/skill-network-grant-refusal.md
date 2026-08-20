# Spec: refuse an unenforceable `permission.network` at load time

**Status:** RED spec (laws written, enforcement not yet implemented)
**Change request:** close the false-assurance gap where a skill declares a network
permission that nothing reads, enforces, or refuses.
**Decision:** REFUSE fail-closed at load time (miles-change-decision-c63b88b1).

## The defect, measured

`src/genome_schema.ts:36-45` declares:

```ts
export const NetworkGrantSchema = z.object({
  allow: z.array(z.string()).default([]),
  methods: z.array(z.string()).optional(),
  max_requests: z.number().optional(),
  max_bytes: z.number().optional(),
});
export const SkillPermissionSchema = z.object({
  tier: z.number().optional(),
  network: NetworkGrantSchema.optional(),
});
```

`SkillSchema.permission` (`src/genome_schema.ts:77`) carries it. A well-formed
`permission.network` passes `SkillSchema.safeParse` at `src/loader.ts:438` and is
stored in the `SkillRecord` at `src/loader.ts:449`. **No code path outside
`genome_schema.ts` reads `permission.network`, `max_requests`, `max_bytes` or
`methods`** — verified by grep over `src/`. A skill declaring `max_requests: 100`
gets no request limit; `methods: ["GET"]` may issue any verb; `allow: [...]`
constrains no origin. This is a *false assurance*, worse than a missing feature.

## Which network chokepoints exist in the execution path (AC5, stated plainly)

**None.** The skill execution path is `src/skill_subprocess.ts` →
`src/skill_runner.mjs` under Node's `--permission` sandbox:

- `src/skill_subprocess.ts:177,185` and `:239,247` read only `meta.permission?.tier`
  and emit only `tierFlags(tier, dir)` — filesystem/child-process tier flags. No
  network flag is ever emitted.
- Node's `--permission` model has **no `--allow-net` flag** — it governs the
  filesystem and child processes, not the network.
- `src/skill_runner.mjs:12-15` states it outright: *"It CAN still reach the
  network: Node's permission model has no network gate … A real network gate needs
  a runtime that has one."*

So ENFORCE is impossible without infrastructure that does not exist (a proxy/
interceptor), which is out of scope. The honest answer is REFUSE.

## The rule this repo already applies to the identical defect

`src/tool_providers.ts:169-185`, `assertToolGrantsResolvable`: a granted tool with
no resolvable provider is a *dead name* and dispatch **throws** naming the agent and
the grant — it is not warned or logged. A network grant the runtime cannot back is
the same defect one layer over, and gets the same treatment: refusal with a named
error.

## Obligations → mechanism → callsite → verifying law

| # | Obligation (invariant) | Mechanism / callsite | Verifying law |
|---|---|---|---|
| INV-REFUSE-LOAD | A skill whose parsed `permission.network` is present and non-null is refused at **load** time — `loadGenome` throws, fail-closed, before the `SkillRecord` is stored. | After `SkillSchema.safeParse` succeeds at `src/loader.ts:438-442` and before `skills.set(...)` at `:449`, inspect `metaCheck.data.permission?.network`; if present, `throw new SkillLoadError(...)`. | `RED: refuses at load a skill declaring a well-formed permission.network` |
| INV-ERROR-NAMES-SLUG-AND-FIELD | The thrown message names the skill **slug** and the field **`permission.network`**, in the shape of `assertToolGrantsResolvable` (`tool_providers.ts:180-183`) — not a warning, not a log line. | Same throw; message includes `pkg.meta.slug` and the literal `permission.network`, with the dead-name framing. | `RED: the refusal names the skill slug and the field 'permission.network'` |
| INV-REFUSE-ANY-NONNULL | Refusal triggers on **any** non-null network, including an empty `{}` (which `NetworkGrantSchema` parses to `{ allow: [] }`) — presence, not content, is the trigger. | The check is `permission?.network !== undefined` on the *parsed* object, not a per-field inspection. | `RED: any non-null network is refused — even an empty {} object` |
| INV-BASELINE-TIER-ONLY | A skill declaring `permission.tier` but no `network` loads unchanged and preserves `tier`. | The gate does nothing when `permission?.network` is absent; the existing `skills.set` path at `:449` is untouched. | `GREEN control: a skill declaring no network (permission.tier only) loads and preserves its tier` |
| INV-BASELINE-NO-PERMISSION | A skill declaring no `permission` at all loads unchanged. | Same — `permission?.network` is `undefined`, gate is inert. | `GREEN control: a skill declaring NO permission at all loads unchanged` |

`NetworkGrantSchema` / `SkillPermissionSchema` remain in `genome_schema.ts`
untouched; the spawn path (`skill_subprocess.ts`) is untouched. Only *loading* a
skill that declares `permission.network` is refused.

## Test method

Example-based laws over the real load gate (`loadGenome`, `src/loader.ts`), in
`tests/skill_package_loading.test.ts`. The refusal laws are RED — the loader stores
the record and throws nothing today; they flip GREEN when the gate lands. The two
baseline laws are GREEN controls proving the change does not narrow a skill that
declares no network permission.

## Rollback

Revert the `src/loader.ts` gate and the five added laws in a single commit. Nothing
downstream ever read `permission.network`, so restoring load-accepts-network is
complete and side-effect-free; `NetworkGrantSchema` was never modified.
