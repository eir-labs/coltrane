# contract-post-time-gig-input-v1 — the hosted dispatch door validates the payload at POST time

**Status:** RED spec (laws written, enforcement unwritten). Publish nothing.
**Laws:** `tests/spec_post_time_gig_input.test.ts`
**Criteria:** the caller who can still fix the key is the one who is told; and when the engine cannot check, it says so rather than implying it did.

## The measured problem

`contract-unknown-gig-input-v1` (shipped at `5693588`) validates the dispatch payload in `runGig`'s
preflight — `src/runtime.ts` ~1613, the partition block that refuses a near-miss and names undeclared
keys. That path guards the **local** dispatch and the drain's worker.

The **hosted** door does not reach it. `callSurfaceTool` → the `gig_dispatch` branch
(`src/server.ts:3765`) hands `args` straight to `deps.queueGig(args)` and returns, before any standard is
resolved:

```ts
if (slug === "gig_dispatch") {
  if (deps.queueGig) {
    try {
      const data = await deps.queueGig(args);   // ← the payload is never partitioned
      return { ok: true, data };
    } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  }
  ...
}
```

`postgrestQueueGig` (`src/genome_store.ts` ~763) posts `p_standard` and `p_input` to the
`coltrane_gig_dispatch` RPC without consulting the standard. So a misspelled or undeclared key posted
through the hosted door is caught when the **worker** runs the gig, not when the caller posts it. In the
partner's doctor-facing product (Optimedge Grant Studio) a doctor uploads an RFP, the product posts a
dispatch, and the person who could still fix the key is told nothing — the failure surfaces later as a
run that did not do what they asked. A throw on this path also reaches the caller's surface as
`tool failed: <text>`, so the refusal must arrive as a **typed JSON refusal**, never an exception.

## Obligations, mechanisms, callsites

| ID | Obligation | Mechanism (unwritten) | Callsite | Law |
|----|------------|-----------------------|----------|-----|
| O1 | Before `deps.queueGig`, the hosted door partitions the payload exactly as the preflight does. A near miss returns `{ ok: false, refusal: "unknown_gig_input", error }` and NOTHING is queued; the engine never throws on this path. | Partition `args["input"]` against the standard's declared inputs at the head of the `gig_dispatch` hosted branch, before `deps.queueGig` is reached; return a typed refusal, do not throw. | `src/server.ts:3765` (hosted `gig_dispatch` branch) | O1 — near-miss refused, guarded queue never reached |
| O2 | The refusal's `error` is produced by the SAME builder the preflight uses — identical to the character. | Extract the preflight's collision message (`src/runtime.ts:1630`) into a shared builder in `src/runtime.ts`; both doors call it. | `src/runtime.ts` (shared builder), `src/server.ts:3765` | O2 — post-time refusal byte-identical to preflight |
| O3 | Other undeclared keys do not refuse: the gig is queued and the reply carries them, sorted, as `undeclared_input_keys`. | After the near-miss check, collect the remaining undeclared keys (sorted) and attach them to the `{ ok: true, data }` reply. | `src/server.ts:3765` | O3 — undeclared keys named, sorted, on the reply |
| O4 | Declared inputs read from `deps.standards` when the surface holds the standard; otherwise from an optional host-wired reader `deps.declaredGigInputs(standard_slug)`. Exactly one narrow read; no other genome class fetched. | Look up `deps.standards.get(standard_slug)`; on a miss, `await deps.declaredGigInputs?.(standard_slug)`. Add the `declaredGigInputs` seam to `ToolSurfaceDeps`, the same idiom as `queueGig`. | `src/server.ts:3765`, `ToolSurfaceDeps` (`src/server.ts:3530`) | O4 — deps.standards first, else exactly one reader call |

## Invariants

| ID | Invariant | Checkable | Law |
|----|-----------|-----------|-----|
| I1 | The preflight is not replaced. A gig queued by something other than this door is still validated when it runs. | The preflight laws stay green, and a payload the hosted door never saw still fails in `runGig`. | I1 — runGig backstop still fires + door adds a second gate |
| I2 | A clean payload is queued exactly as today. | A payload whose keys are exactly the declared inputs reaches `queueGig` with byte-identical arguments, and the reply carries no `undeclared_input_keys`. | I2 — byte-identical forward + non-vacuous annotation |

## Failure modes

| ID | Condition | Contract | Law |
|----|-----------|----------|-----|
| F1 | Neither `deps.standards` nor a wired reader can supply the declared inputs (unknown slug, no reader, or the read fails). | The engine does NOT guess and does not silently skip: the gig is queued as today and the reply carries `input_validated: false` with a `reason` naming why it could not be checked. The preflight remains the backstop. | F1 — queued + `input_validated:false` + reason |
| F2 | The payload is absent or is not an object. | Unchanged from today — this contract adds no new refusal for a shape the door already handles. | F2 — guard fires only on a present, object payload |

## Verification method

Example-based Vitest laws driving the REAL hosted door through `createToolSurface({ hosted: true, ... })`
and an injected `queueGig`:

- A **recording** queue witnesses "it was queued" by a non-empty call log with byte-identical args.
- A **guarded** queue (records THEN throws) is wired wherever the contract says nothing must be queued:
  an empty call log PROVES "refused before anything is queued", rather than asserting it. Today the door
  reaches the guarded queue (O1 fails first on `expected 1 to be +0`), which is the bug itself.
- O2 compares the post-time refusal `error` against the preflight's message for the same payload,
  character for character (`.toBe`), so the two doors cannot drift into two vocabularies.
- O4 uses `vi.fn` readers to prove `deps.standards` is consulted first (reader untouched) and, on a
  standards miss, the reader is called exactly once with the slug.

The new seams/fields (`deps.declaredGigInputs`, `res.undeclared_input_keys`, `res.input_validated`,
`res.reason`) are read through widening casts so an unwritten type is a RUNTIME failure, not a `tsc`
error — `tsc` (build_once's globalSetup) stays clean.

## Observed red (this run)

All 8 laws fail on the contract's assertion; the build (tsc) is clean, so the failures are runtime — the
enforcement does not exist yet:

- **O1** — `expected 1 to be +0` (the door queued before it could refuse — the guarded queue was reached).
- **O2** — `expected true to be false` (the door returned `ok: true` instead of the refusal).
- **O3** — `expected undefined to deeply equal [ 'alpha_x', 'zeta_x' ]` (no `undeclared_input_keys`).
- **O4** — `expected undefined to be 'unknown_gig_input'` (no refusal from `deps.standards`).
- **I1** — `expected undefined to be 'unknown_gig_input'` (the door adds no gate; the runGig backstop half is green).
- **I2** — `expected undefined to deeply equal [ 'harmless_x' ]` (the annotation mechanism never fires).
- **F1** — `expected undefined to be false` (no `input_validated: false`).
- **F2** — `expected undefined to be 'unknown_gig_input'` (the present near-miss is not refused).

Controls green this run: `tests/spec_unknown_gig_input.test.ts` (7) and `tests/tool_surface.test.ts` (19)
— the preflight is not weakened and the hosted-dispatch suite still passes.

## Out of scope

`src/**` (this is a red spec — enforcement is unwritten), `scripts/laws.sh`, `agents/**`, `standards/**`,
`domain_types/**`, strict mode, the queue RPC's own SQL and the store schema, whether a refused post is
recorded as an attempt (the caller's table semantics, not the engine's), committing or pushing.
