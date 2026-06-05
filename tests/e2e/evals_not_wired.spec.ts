// e2e: evals declared on a standard should populate run_fingerprint.eval_scores
// (RED — N3 eirmath-calibrated measurement gap).
//
// Pre-reg
// =======
// predict        — a standard that declares `eval_slugs: ["gist-present"]` will,
//                  after `runGig`, expose `eval_scores` keyed by each declared
//                  eval slug, computed against the produced outputs.
// playwright/vitest_test_path — this file.
// kill_condition — none; the test should hold the contract until the wire exists.
// apoha          — this is NOT a test that evals MUST always run. Standards without
//                  evals declared keep `eval_scores: {}`. The gap is: declared evals
//                  are silently ignored. CLAUDE.md lists evals as a first-class
//                  definition class ("verdict-substrates that judge gig outputs");
//                  the runtime hardcodes `eval_scores: {}` at src/runtime.ts:115.
// run_protocol   — vitest runs against current main. Expected RED today.
// verdict        — RED expected; that's the finding.
//
// What this test answers
// ======================
// CLAUDE.md (the canonical OSS protocol the user sees on clone) declares 5
// definition classes: types, players, standards, skills, evals. Four of them are
// wired through the runtime. Evals are loaded by `loadGenome` (loader.ts:160) but
// no path connects loaded evals → standard.eval_slugs → runGig execution →
// `run_fingerprint.eval_scores`. The comment at runtime.ts:115 admits this
// honestly ("v0 is un-tempered — no behavioral evals yet"), but the surface still
// PROMISES evals to the user.
//
// Skills had the same gap until PR #102/#103 wired them. This test is the
// analogous adversarial probe for evals.
//
// The contract under test
// =======================
//   1. `composeStandard` must accept `eval_slugs: string[]` on the input.
//   2. The composed `Standard` must expose `eval_slugs`.
//   3. `runGig` must execute each declared eval against the produced outputs.
//   4. `GigResult` (or `run_fingerprint`'s pre-image) must expose `eval_scores`
//      keyed by eval slug.
//
// One of these will fail RED. That's the finding.

import { describe, it, expect } from "vitest";
import {
  createRegistry,
  createOutputStore,
  MemoryLedger,
  defineAgent,
  composeStandard,
  runGig,
  type AgentInvoker,
} from "../../src/index.js";

describe("e2e: evals declared on a standard must populate eval_scores (RED — N3 measurement gap)", () => {
  it("a standard declaring eval_slugs propagates them through composition", () => {
    const sensor = defineAgent({ slug: "sensor", primitives: ["SENSE"], output_types: ["raw-note"], domain: "demo" });
    const summarizer = defineAgent({
      slug: "summarizer",
      primitives: ["INTERPRET"],
      input_types: ["raw-note"],
      output_types: ["summary"],
      domain: "demo",
    });

    // ATTEMPT to declare evals on the standard. Currently `StandardDef` has
    // no `eval_slugs` field, so this cast surfaces the schema-level gap.
    const standard = composeStandard({
      slug: "summarize-with-eval",
      domain: "demo",
      agents: [sensor, summarizer],
      phases: [
        { name: "sense", agent: "sensor" },
        { name: "interpret", agent: "summarizer" },
      ],
      eval_slugs: ["gist-present"],
    } as unknown as Parameters<typeof composeStandard>[0]);

    // The composed Standard must expose the declared evals.
    expect((standard as unknown as { eval_slugs?: readonly string[] }).eval_slugs).toEqual(["gist-present"]);
  });

  it("running a gig against a standard with declared evals populates eval_scores", async () => {
    const registry = createRegistry();
    registry.registerType({
      slug: "raw-note",
      extends: "Signal",
      domain: "demo",
      schema: { type: "object", properties: { text: { type: "string" } } },
      required_fields: ["text"],
    });
    registry.registerType({
      slug: "summary",
      extends: "Interpretation",
      domain: "demo",
      schema: { type: "object", properties: { gist: { type: "string" } } },
      required_fields: ["gist"],
    });

    const sensor = defineAgent({ slug: "sensor", primitives: ["SENSE"], output_types: ["raw-note"], domain: "demo" });
    const summarizer = defineAgent({
      slug: "summarizer",
      primitives: ["INTERPRET"],
      input_types: ["raw-note"],
      output_types: ["summary"],
      domain: "demo",
    });

    const standard = composeStandard({
      slug: "summarize-with-eval",
      domain: "demo",
      agents: [sensor, summarizer],
      phases: [
        { name: "sense", agent: "sensor" },
        { name: "interpret", agent: "summarizer" },
      ],
      eval_slugs: ["gist-present"],
    } as unknown as Parameters<typeof composeStandard>[0]);

    const invoke: AgentInvoker = (ctx) =>
      ctx.agent.slug === "sensor" ? { text: "the room is loud" } : { gist: "loud room" };

    const result = await runGig(
      standard,
      { topic: "noise" },
      {
        outputs: createOutputStore(registry),
        ledger: new MemoryLedger(),
        invoke,
        model_version: "deterministic-eval-probe",
      },
    );

    expect(result).toBeDefined();
    expect(result.run_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(result.outputs).toHaveLength(2);

    // The critical assertion: a standard declaring `eval_slugs: ["gist-present"]`
    // must produce a non-empty `eval_scores` after the gig completes.
    //
    // Today the runtime hardcodes `eval_scores: {}` (src/runtime.ts:115), and
    // `GigResult` does not expose eval_scores at all — so this assertion fails
    // at the type-of-property level, which is the RED that proves the gap.
    expect(result).toHaveProperty("eval_scores");
    expect((result as unknown as { eval_scores: Record<string, number> }).eval_scores).toHaveProperty("gist-present");
  });

  it("ledger entry for a gig with evals records the same eval_scores as the GigResult", async () => {
    // Bonus assertion: even when eval_scores does get wired, the run_fingerprint
    // is computed OVER eval_scores. The ledger entry's run_fingerprint must
    // reflect the eval result. Two gigs with the same standard + same outputs
    // but DIFFERENT eval results must produce DIFFERENT run_fingerprints.
    //
    // For now this is the placeholder for the post-wire green-state assertion.
    // Today, every gig produces the same fingerprint regardless of declared evals
    // because evals never run. That equality-of-fingerprints across distinct
    // declared-eval standards is itself a green-masks-unbuilt-loops smell.

    const registry = createRegistry();
    registry.registerType({
      slug: "raw-note",
      extends: "Signal",
      domain: "demo",
      schema: { type: "object", properties: { text: { type: "string" } } },
      required_fields: ["text"],
    });
    registry.registerType({
      slug: "summary",
      extends: "Interpretation",
      domain: "demo",
      schema: { type: "object", properties: { gist: { type: "string" } } },
      required_fields: ["gist"],
    });

    const sensor = defineAgent({ slug: "sensor", primitives: ["SENSE"], output_types: ["raw-note"], domain: "demo" });
    const summarizer = defineAgent({
      slug: "summarizer",
      primitives: ["INTERPRET"],
      input_types: ["raw-note"],
      output_types: ["summary"],
      domain: "demo",
    });

    const standardA = composeStandard({
      slug: "summarize-with-eval-a",
      domain: "demo",
      agents: [sensor, summarizer],
      phases: [
        { name: "sense", agent: "sensor" },
        { name: "interpret", agent: "summarizer" },
      ],
      eval_slugs: ["gist-present"],
    } as unknown as Parameters<typeof composeStandard>[0]);

    const standardB = composeStandard({
      slug: "summarize-with-eval-b",
      domain: "demo",
      agents: [sensor, summarizer],
      phases: [
        { name: "sense", agent: "sensor" },
        { name: "interpret", agent: "summarizer" },
      ],
      // NO eval declared.
    });

    const invoke: AgentInvoker = (ctx) =>
      ctx.agent.slug === "sensor" ? { text: "the room is loud" } : { gist: "loud room" };

    const ledgerA = new MemoryLedger();
    const ledgerB = new MemoryLedger();

    const resultA = await runGig(standardA, { topic: "noise" }, {
      outputs: createOutputStore(registry),
      ledger: ledgerA,
      invoke,
      model_version: "deterministic-eval-probe",
    });
    const resultB = await runGig(standardB, { topic: "noise" }, {
      outputs: createOutputStore(registry),
      ledger: ledgerB,
      invoke,
      model_version: "deterministic-eval-probe",
    });

    // Two standards differ ONLY in declared evals. After fix, their
    // run_fingerprints should differ because eval_scores differ. Today,
    // they may differ only by the standard slug — eval_slugs are
    // structurally invisible to the fingerprint.
    //
    // Adjacent finding: even the standard slug is part of genome_hash but not
    // canonical_form. So if the two standards had the SAME slug, fingerprints
    // would be identical. The eval-as-dial implication is that evals must enter
    // the fingerprint domain to make their effect observable.
    expect(resultA.run_fingerprint).not.toBe(resultB.run_fingerprint);

    // Stronger contract once wired: eval_scores on the fingerprint pre-image
    // for A should be non-empty; for B should be empty.
    expect((resultA as unknown as { eval_scores: Record<string, number> }).eval_scores).toHaveProperty("gist-present");
    expect((resultB as unknown as { eval_scores: Record<string, number> }).eval_scores).toEqual({});
  });
});
