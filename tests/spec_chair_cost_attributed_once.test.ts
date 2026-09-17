// RED — a chair invocation's settled cost is attributed ONCE across the records it seals.
// Contract: contract-chair-cost-once-v1.
//
// THE DEFECT (coltrane-ui#242, found 2026-09-17). runGig's seal loop stamps the chair's settled
// `cost_usd` and `tokens_used` (chairReport, src/runtime.ts:3401-3412) onto EACH record the chair
// seals. So a chair sealing N outputs reports its spend N TIMES, and any sum of OutputMeta.cost_usd
// over a gig double-counts. coltrane-ui had to warn readers never to sum per-output cost within a
// chair — a warning that is the shape of a spec claiming A while the code does B.
//
// THE CONTRACT these laws pin:
//   O1 — of the records one chair invocation seals, exactly the FIRST carries cost_usd and
//        tokens_used; every OTHER record omits both and carries `cost_on`: the id of the record
//        that carries them.
//   O2 — a single-output chair is UNCHANGED: its one record carries cost_usd and tokens_used and
//        no cost_on. (Its meaning is a boundary — the once-rule reshapes ONLY multi-output seals —
//        so the law proves that boundary against a multi-output chair in the same gig, which is
//        the clause that fails today.)
//   I1 — the sum of cost_usd over a completed gig's sealed records equals the sum of its settled
//        chair costs for the chairs that sealed.
//
// VERIFICATION METHOD. Every law runs the REAL runGig path with a real in-memory OutputStore and a
// stubbed invoker whose `result` event reports settled usage exactly as the CLI's stream-json does
// (total_cost_usd + usage) — the template shared by tests/runtime_accounting_integrity.test.ts. No
// `claude` subprocess is ever spawned. O1 and I1 are UNIVERSAL properties ("for ANY number of
// records", "for ANY pair of settled costs") and are pinned with fast-check; each also carries the
// contract's own worked example so a reader sees the concrete number the property generalises. O2 is
// a specific behaviour and is example-based.
//
// The cost fields these laws read (`cost_usd`, `tokens_used`) are real OutputRecord fields today;
// `cost_on` is the field the enforcement must add and populate. RED today because the seal stamps
// cost on every record and never writes cost_on.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  createRegistry, createOutputStore, MemoryLedger, runGig,
  type AgentInvoker, type DomainType, type Standard, type OutputRecord,
} from "../src/index.js";
import { testAgent } from "./_support/agents.js";

// ── core substance floors every sealed output owes by virtue of its core (src/output_validation.ts).
// Omitting them aborts the CHAIR before the seal the law is about, so they are named constants: a
// broken fixture fails loudly here rather than silently inside the assertion.
const SIGNAL = { source: "fixture://demo/chair-cost-once" };
const CRITERIA = { criteria: ["fixture: the chair evaluated this"] };

// A record's own cost as the SEALED record carries it. `cost_on` is the field the enforcement adds;
// it is not on the OutputRecord type yet, so it is read through an index cast rather than a property.
const costOf = (r: OutputRecord): number | undefined => r.cost_usd;
const tokensOf = (r: OutputRecord): number | undefined => r.tokens_used;
const costOnOf = (r: OutputRecord): string | undefined =>
  (r as unknown as Record<string, unknown>)["cost_on"] as string | undefined;

// The records ONE chair sealed, in seal order (from_role identifies the chair; produced/res.outputs
// preserve the order the seal loop wrote them, so index 0 is the first record of that invocation).
const sealedBy = (outs: readonly OutputRecord[], role: string): OutputRecord[] =>
  outs.filter((o) => o.from_role === role);

// A `result` event carrying settled usage, exactly as the CLI's stream-json result does.
const reportUsage = (ctx: Parameters<AgentInvoker>[0], usd: number, inTok: number, outTok: number): void => {
  ctx.onEvent?.({ type: "result", raw: { type: "result", total_cost_usd: usd, usage: { input_tokens: inTok, output_tokens: outTok } } });
};

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// O1 — one chair invocation attributes its settled cost to exactly ONE sealed record.
//
// A universal property: for ANY number of records a chair seals (n ≥ 2) and ANY settled cost, the
// FIRST record carries the whole cost + tokens and no cost_on, and every OTHER record carries NO
// cost/tokens and a cost_on pointing at that first record. One hand-picked n could pass by luck; the
// double-count is a per-record multiplier, so the law has to hold for every width.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("O1 — a chair's settled cost lands on exactly the first record it seals", () => {
  // A pool of STRUCTURALLY DISTINCT types (one per core), so a chair can seal up to five records
  // whose types the registry accepts as genuinely different — a pool of same-shaped subtypes trips
  // the registry's near-duplicate guard, which is a fixture problem, not the contract. Each carries
  // its core's substance floor (src/output_validation.ts) in its slice.
  const POOL: Array<{ type: DomainType; slice: Record<string, unknown>; primitive: string }> = [
    { type: { slug: "wide-sig", extends: "Signal", domain: "demo", schema: { properties: { alpha: { type: "string" } } }, required_fields: ["alpha"] } as DomainType, slice: { alpha: "a", ...SIGNAL }, primitive: "SENSE" },
    { type: { slug: "wide-interp", extends: "Interpretation", domain: "demo", schema: { properties: { beta: { type: "string" } } }, required_fields: ["beta"] } as DomainType, slice: { beta: "b", claims: ["fixture: extracted meaning"] }, primitive: "INTERPRET" },
    { type: { slug: "wide-judg", extends: "Judgment", domain: "demo", schema: { properties: { gamma: { type: "string" } } }, required_fields: ["gamma"] } as DomainType, slice: { gamma: "g", ...CRITERIA }, primitive: "JUDGE" },
    { type: { slug: "wide-plan", extends: "Plan", domain: "demo", schema: { properties: { delta: { type: "string" } } }, required_fields: ["delta"] } as DomainType, slice: { delta: "d", steps: ["fixture: one step"] }, primitive: "PLAN" },
    { type: { slug: "wide-art", extends: "Artifact", domain: "demo", schema: { properties: { epsilon: { type: "string" } } }, required_fields: ["epsilon"] } as DomainType, slice: { epsilon: "e", validation_criteria: ["fixture: the artifact matches its type"] }, primitive: "CREATE" },
  ];

  // Build a standard whose single chair seals `n` records of `n` distinct-core types (n ≤ 5).
  const buildWide = (n: number) => {
    const registry = createRegistry();
    const chosen = POOL.slice(0, n);
    for (const p of chosen) registry.registerType(p.type);
    const outputs = createOutputStore(registry);
    const ledger = new MemoryLedger();
    const slugs = chosen.map((p) => p.type.slug);
    const std: Standard = {
      slug: "wide-seal", domain: "demo",
      agents: [testAgent({ slug: "wide", primitives: ["SENSE", "INTERPRET", "JUDGE", "PLAN", "CREATE"], input_types: [], output_types: slugs, domain: "demo" })],
      phases: [{ name: "p", chairs: [{ role: "w", agent_slug: "wide", depends_on: [], input_contract: [], output_contract: slugs, required_skills: [] }] }],
    };
    const keyed = Object.fromEntries(chosen.map((p) => [p.type.slug, p.slice]));
    return { registry, outputs, ledger, std, slugs, keyed };
  };

  it("for ANY width n≥2, exactly the first record carries the cost; the rest carry cost_on and no cost", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 5 }),
        fc.double({ min: 0.01, max: 5, noNaN: true, noDefaultInfinity: true }),
        fc.integer({ min: 1, max: 4000 }),
        fc.integer({ min: 1, max: 4000 }),
        async (n, usd, inTok, outTok) => {
          const { outputs, ledger, std, keyed } = buildWide(n);
          const invoke: AgentInvoker = (ctx) => {
            reportUsage(ctx, usd, inTok, outTok);
            // A multi-output chair returns its records keyed by domain_type.
            return keyed;
          };
          const res = await runGig(std, {}, { outputs, ledger, invoke });

          const recs = sealedBy(res.outputs, "w");
          expect(recs.length, "the chair seals one record per declared type").toBe(n);

          const carrier = recs[0]!;
          const rest = recs.slice(1);

          // Exactly the first record carries the settled cost and tokens — ONCE.
          expect(costOf(carrier), "the first record carries the chair's whole settled cost").toBeCloseTo(usd, 8);
          expect(tokensOf(carrier), "the first record carries the chair's whole token count").toBe(inTok + outTok);
          expect(costOnOf(carrier), "the record that CARRIES the cost points at no other").toBeUndefined();

          // Every other record omits cost + tokens and points at the carrier.
          for (const r of rest) {
            expect(costOf(r), `a non-first record of the same invocation carries NO cost_usd (${r.domain_type})`).toBeUndefined();
            expect(tokensOf(r), `a non-first record of the same invocation carries NO tokens_used (${r.domain_type})`).toBeUndefined();
            expect(costOnOf(r), `a non-first record points cost_on at the carrier (${r.domain_type})`).toBe(carrier.id);
          }

          // The property that #242 is about: the chair's cost appears once across its records.
          const summed = recs.reduce((acc, r) => acc + (costOf(r) ?? 0), 0);
          expect(summed, "summing cost_usd over one chair's records equals its settled cost, not a multiple").toBeCloseTo(usd, 8);
        },
      ),
      { numRuns: 30 },
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// I1 — a completed gig's sealed cost_usd sums to its settled chair costs.
//
// The contract's checkable, verbatim: a two-output chair reporting $0.40 and a one-output chair
// reporting $0.10 → the sealed records sum to $0.50, not $0.90. Pinned as the worked example AND as
// a property over ANY two settled costs, because "sums to the settled total" is a universal claim
// and the double-count is worst exactly where a chair is widest.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("I1 — the gig's sealed cost_usd sums to its settled chair costs, never a per-record multiple", () => {
  const TYPES: DomainType[] = [
    { slug: "cost-a", extends: "Signal", domain: "demo", schema: { properties: { a: { type: "string" } } }, required_fields: ["a"] } as DomainType,
    { slug: "cost-b", extends: "Judgment", domain: "demo", schema: { properties: { b: { type: "string" } } }, required_fields: ["b"] } as DomainType,
    { slug: "cost-note", extends: "Signal", domain: "demo", schema: { properties: { t: { type: "string" } } }, required_fields: ["t"] } as DomainType,
  ];
  // A gig: one two-output chair ("dual" → cost-a + cost-b) and one one-output chair ("solo" → cost-note).
  const std: Standard = {
    slug: "cost-sum", domain: "demo",
    agents: [
      testAgent({ slug: "dual", primitives: ["SENSE", "JUDGE"], input_types: [], output_types: ["cost-a", "cost-b"], domain: "demo" }),
      testAgent({ slug: "solo", primitives: ["SENSE"], input_types: [], output_types: ["cost-note"], domain: "demo" }),
    ],
    phases: [
      { name: "p1", chairs: [{ role: "dual", agent_slug: "dual", depends_on: [], input_contract: [], output_contract: ["cost-a", "cost-b"], required_skills: [] }] },
      { name: "p2", chairs: [{ role: "solo", agent_slug: "solo", depends_on: [], input_contract: [], output_contract: ["cost-note"], required_skills: [] }] },
    ],
  };
  const store = () => {
    const registry = createRegistry();
    for (const t of TYPES) registry.registerType(t);
    return { outputs: createOutputStore(registry), ledger: new MemoryLedger() };
  };
  const invokeWith = (dualUsd: number, soloUsd: number): AgentInvoker => (ctx) => {
    if (ctx.agent.slug === "dual") {
      reportUsage(ctx, dualUsd, 30, 10);
      return { "cost-a": { a: "x", ...SIGNAL }, "cost-b": { b: "y", ...CRITERIA } };
    }
    reportUsage(ctx, soloUsd, 8, 2);
    return { "cost-note": { t: "z", ...SIGNAL } };
  };
  const sumSealed = (outs: readonly OutputRecord[]): number =>
    outs.reduce((acc, r) => acc + (costOf(r) ?? 0), 0);

  it("the contract's checkable: $0.40 (two-output) + $0.10 (one-output) → records sum to $0.50, not $0.90", async () => {
    const { outputs, ledger } = store();
    const res = await runGig(std, {}, { outputs, ledger, invoke: invokeWith(0.4, 0.1) });
    // THE DEFECT: the two-output chair stamps $0.40 on BOTH of its records, so the sealed set sums
    // to $0.40 + $0.40 + $0.10 = $0.90 — the double-count coltrane-ui#242 had to warn readers about.
    expect(
      sumSealed(res.outputs),
      "one settled cost, one record carrying it: the gig's sealed cost_usd sums to the settled $0.50",
    ).toBeCloseTo(0.5, 8);
  });

  it("for ANY two settled costs, the sealed cost_usd sums to their total, not a per-record multiple", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.double({ min: 0.01, max: 9, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0.01, max: 9, noNaN: true, noDefaultInfinity: true }),
        async (dualUsd, soloUsd) => {
          const { outputs, ledger } = store();
          const res = await runGig(std, {}, { outputs, ledger, invoke: invokeWith(dualUsd, soloUsd) });
          expect(
            sumSealed(res.outputs),
            "the sum of sealed cost_usd equals the sum of the two chairs' settled costs",
          ).toBeCloseTo(dualUsd + soloUsd, 8);
        },
      ),
      { numRuns: 30 },
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// O2 — a single-output chair is UNCHANGED.
//
// Its one record carries cost_usd and tokens_used and no cost_on. That behaviour is already correct
// today, so the law's teeth are in the BOUNDARY the obligation draws: the once-rule reshapes only
// MULTI-output seals. The law runs a single-output chair and a two-output chair in one gig and
// asserts the single chair keeps its full cost with no cost_on (the "unchanged" guarantee) WHILE the
// two-output chair redistributes — the second clause is what fails today, because today the
// two-output chair stamps its cost on every record and writes no cost_on.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("O2 — a single-output chair keeps its whole cost on its one record, no cost_on", () => {
  const TYPES: DomainType[] = [
    { slug: "cost-a", extends: "Signal", domain: "demo", schema: { properties: { a: { type: "string" } } }, required_fields: ["a"] } as DomainType,
    { slug: "cost-b", extends: "Judgment", domain: "demo", schema: { properties: { b: { type: "string" } } }, required_fields: ["b"] } as DomainType,
    { slug: "cost-note", extends: "Signal", domain: "demo", schema: { properties: { t: { type: "string" } } }, required_fields: ["t"] } as DomainType,
  ];
  const std: Standard = {
    slug: "single-unchanged", domain: "demo",
    agents: [
      testAgent({ slug: "dual", primitives: ["SENSE", "JUDGE"], input_types: [], output_types: ["cost-a", "cost-b"], domain: "demo" }),
      testAgent({ slug: "solo", primitives: ["SENSE"], input_types: [], output_types: ["cost-note"], domain: "demo" }),
    ],
    phases: [
      { name: "p1", chairs: [{ role: "dual", agent_slug: "dual", depends_on: [], input_contract: [], output_contract: ["cost-a", "cost-b"], required_skills: [] }] },
      { name: "p2", chairs: [{ role: "solo", agent_slug: "solo", depends_on: [], input_contract: [], output_contract: ["cost-note"], required_skills: [] }] },
    ],
  };

  it("the single chair's one record carries its full $0.10 and no cost_on, while a multi-output chair redistributes", async () => {
    const registry = createRegistry();
    for (const t of TYPES) registry.registerType(t);
    const outputs = createOutputStore(registry);
    const ledger = new MemoryLedger();
    const invoke: AgentInvoker = (ctx) => {
      if (ctx.agent.slug === "dual") {
        reportUsage(ctx, 0.4, 30, 10);
        return { "cost-a": { a: "x", ...SIGNAL }, "cost-b": { b: "y", ...CRITERIA } };
      }
      reportUsage(ctx, 0.1, 8, 2);
      return { "cost-note": { t: "z", ...SIGNAL } };
    };
    const res = await runGig(std, {}, { outputs, ledger, invoke });

    // The single-output chair is the UNCHANGED case: its one record carries the whole cost + tokens,
    // and it carries no cost_on because there is no other record to point at.
    const soloRecs = sealedBy(res.outputs, "solo");
    expect(soloRecs.length, "the single-output chair seals exactly one record").toBe(1);
    const solo = soloRecs[0]!;
    expect(costOf(solo), "the single chair's record carries its whole settled $0.10").toBeCloseTo(0.1, 8);
    expect(tokensOf(solo), "the single chair's record carries its whole token count").toBe(10);
    expect(costOnOf(solo), "a single-output chair's record carries no cost_on — it IS the carrier").toBeUndefined();

    // The boundary that gives O2 its meaning: the once-rule touches ONLY multi-output seals. The
    // two-output chair's SECOND record must omit cost and point cost_on at the first — which is the
    // clause that fails today, proving the single chair above is the deliberately-unchanged case.
    const dualRecs = sealedBy(res.outputs, "dual");
    expect(dualRecs.length, "the two-output chair seals two records").toBe(2);
    const [first, second] = dualRecs as [OutputRecord, OutputRecord];
    expect(costOnOf(second), "the multi-output chair's non-first record points cost_on at the carrier").toBe(first.id);
    expect(costOf(second), "the multi-output chair's non-first record carries no cost_usd").toBeUndefined();
  });
});
