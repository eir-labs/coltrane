// "Did this producer get better, and what did it cost?"
//
// That is the question the whole typed-and-sealed design exists to make answerable, and until
// now the engine could not answer it. `learning_synthesize` returns `review_count` and
// `evidence_sufficient` — a COUNT. It can say "you have five reviews". It cannot say "quality
// went from 11.2 to 14.6 while mean cost fell 22%".
//
// Every input was already sealed and nothing joined them: outputs carry `agent_slug`,
// `cost_usd` and `created_at`; reviews carry `quality_scores` against a specific `output_id`
// and `agent_version`. The join is arithmetic over records the engine already writes — which
// is exactly why a consumer cannot compute it from a provider bill.
//
// The discipline these tests mostly enforce: an UNMEASURED quantity is `null`, never `0`.
// Zero cost reads as "free" and zero quality reads as "worthless"; both would be fabricated
// numbers, which is the defect class this release spent its time removing.
import { describe, it, expect } from "vitest";
import { dispatchTool, type ServerDeps } from "../src/server.js";
import { createRegistry, createOutputStore, MemoryLedger, type DomainType } from "../src/index.js";

const note: DomainType = {
  slug: "note", extends: "Signal", domain: "demo",
  schema: { properties: { t: { type: "string" } } }, required_fields: [],
};

function bench(): ServerDeps {
  const registry = createRegistry();
  registry.registerType(note);
  return { registry, outputs: createOutputStore(registry), ledger: new MemoryLedger() } as unknown as ServerDeps;
}

/** Seal an output for `agent`, optionally with a cost, and return its id. */
async function seal(d: ServerDeps, agent: string, cost?: number): Promise<string> {
  const r = await dispatchTool("output_write", {
    core_type: "Signal", domain_type: "note", domain: "demo",
    gig_id: "g1", agent_slug: agent,
    data: { t: "x", source: "fixture://demo" },
    ...(cost !== undefined ? { cost_usd: cost } : {}),
  }, d);
  if (!r.ok) throw new Error(String(r.error));
  return (r.data as { output_id: string }).output_id;
}

/** Record a review of `outputId`, attributing it to a producer version. */
async function review(d: ServerDeps, agent: string, outputId: string, version: number, score: number): Promise<void> {
  const r = await dispatchTool("session_review_write", {
    gig_id: "g1", output_id: outputId, agent_slug: agent,
    agent_version: version, quality_scores: { overall: score },
  }, d);
  if (!r.ok) throw new Error(String(r.error));
}

const report = (d: ServerDeps, agent: string, extra: Record<string, unknown> = {}) =>
  dispatchTool("improvement_report", { agent_slug: agent, ...extra }, d);

describe("improvement_report measures the change across producer versions", () => {
  it("reports better-and-cheaper when that is what happened", async () => {
    const d = bench();
    await review(d, "drafter", await seal(d, "drafter", 0.40), 1, 11);
    await review(d, "drafter", await seal(d, "drafter", 0.40), 1, 11.4);
    await review(d, "drafter", await seal(d, "drafter", 0.30), 2, 14.4);
    await review(d, "drafter", await seal(d, "drafter", 0.30), 2, 14.8);

    const r = await report(d, "drafter");
    expect(r.ok, r.error).toBe(true);
    const got = r.data as { comparable: boolean; deltas: Array<{ from_version: number; to_version: number; quality_delta: number; cost_delta_usd: number; verdict: string }> };
    expect(got.comparable).toBe(true);
    const delta = got.deltas[0]!;
    expect(delta.from_version).toBe(1);
    expect(delta.to_version).toBe(2);
    expect(delta.quality_delta).toBeCloseTo(3.4, 5);
    expect(delta.cost_delta_usd).toBeCloseTo(-0.10, 5);
    expect(delta.verdict, "the sentence a person acts on").toBe("better and cheaper");
  });

  it("does not flatter a regression", async () => {
    const d = bench();
    await review(d, "a", await seal(d, "a", 0.10), 1, 15);
    await review(d, "a", await seal(d, "a", 0.50), 2, 9);
    const got = (await report(d, "a")).data as { deltas: Array<{ verdict: string }> };
    expect(got.deltas[0]!.verdict).toBe("worse and more expensive");
  });

  it("names the tradeoff when one axis moved each way", async () => {
    const d = bench();
    await review(d, "a", await seal(d, "a", 0.50), 1, 10);
    await review(d, "a", await seal(d, "a", 0.20), 2, 8);
    expect(((await report(d, "a")).data as { deltas: Array<{ verdict: string }> }).deltas[0]!.verdict).toBe("cheaper, and worse");
  });
});

describe("it refuses to invent the numbers it does not have", () => {
  it("reports an unmeasured cost as NULL, not zero", async () => {
    // Zero would read as "free". The output below carries no cost at all.
    const d = bench();
    await review(d, "a", await seal(d, "a"), 1, 12);
    const got = (await report(d, "a")).data as { versions: Array<{ mean_cost_usd: number | null; cost_basis: string }> };
    expect(got.versions[0]!.mean_cost_usd).toBeNull();
    expect(got.versions[0]!.cost_basis).toMatch(/no output carried a cost/);
  });

  it("reports unreviewed quality as NULL, not zero", async () => {
    // Zero would read as "worthless".
    const d = bench();
    await seal(d, "a", 0.25);
    const got = (await report(d, "a")).data as { versions: Array<{ mean_quality: number | null; quality_basis: string }> };
    expect(got.versions[0]!.mean_quality).toBeNull();
    expect(got.versions[0]!.quality_basis).toMatch(/no output was reviewed/);
  });

  it("says when a cost figure is PARTIAL rather than averaging over a hole", async () => {
    const d = bench();
    await review(d, "a", await seal(d, "a", 0.40), 1, 10);
    await review(d, "a", await seal(d, "a"), 1, 10); // no cost on this one
    const got = (await report(d, "a")).data as { versions: Array<{ cost_basis: string }> };
    expect(got.versions[0]!.cost_basis).toMatch(/partial: 1 of 2/);
  });

  it("emits NO delta when either end is unmeasured", async () => {
    // A delta against an unmeasured version is a number with nothing behind it.
    const d = bench();
    await review(d, "a", await seal(d, "a", 0.40), 1, 10);
    await seal(d, "a", 0.20); // v2 outputs exist but were never reviewed
    const got = (await report(d, "a")).data as { deltas: Array<{ quality_delta: number | null }>; comparable: boolean };
    expect(got.comparable).toBe(false);
    for (const dl of got.deltas) expect(dl.quality_delta).toBeNull();
  });

  it("says plainly that it is not comparable yet, rather than returning an empty result", async () => {
    // An empty `deltas` array reads as "no change". It is not the same as "cannot tell".
    const d = bench();
    await seal(d, "a", 0.10);
    const got = (await report(d, "a")).data as { comparable: boolean; basis: string };
    expect(got.comparable).toBe(false);
    expect(got.basis).toMatch(/not comparable yet/);
    expect(got.basis, "and it must say what would make it comparable").toMatch(/session_review_write/);
  });
});

describe("scoping", () => {
  it("counts only the named producer", async () => {
    const d = bench();
    await seal(d, "a", 0.10);
    await seal(d, "b", 0.10);
    expect(((await report(d, "a")).data as { total_outputs: number }).total_outputs).toBe(1);
  });

  it("honours a window", async () => {
    const d = bench();
    await seal(d, "a", 0.10);
    const future = (await report(d, "a", { window: "0h" }));
    // A malformed window is refused rather than silently ignored, same as the health surfaces.
    expect(future.ok).toBe(false);
    expect(String(future.error)).toMatch(/window/i);
  });

  it("requires an agent_slug", async () => {
    expect((await dispatchTool("improvement_report", {}, bench())).ok).toBe(false);
  });
});
