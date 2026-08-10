// e2e — chain_query primitives (T7).
//
// The v3.3 cost-discipline standard names backward-queryability as the read
// interface for substrate accountability:
//
//   chain_query.failure_rate(voice_id, time_window)
//   chain_query.cycle_lineage(event_hash)
//
// failure_rate answers: "of all verdicts this voice (agent) has emitted in the
// window, what fraction were pass=false?" — the proxy for inverted-kill hit-rate.
// cycle_lineage answers: "given an event (output) hash, walk the gig (cycle) it
// belonged to and return the ordered lineage of upstream events."
//
// This test BUILDS a chain of typed outputs that should be queryable both ways,
// then probes the tool surface for the primitives. If they're absent (which is
// the v0 truth), the test reports RED-honest: a mapping of (named primitive →
// closest functional equivalent currently shipped) so the next builder knows
// exactly what to add and what reads have to be plumbed.
//
// Mapping the v3.3 vocabulary onto coltrane-oss v0:
//   voice_id           ≈ agent_slug
//   verdict.failed     ≈ output with core_type='Verdict' and data.pass === false
//   cycle              ≈ gig_id
//   event_hash         ≈ output_id (or the content_hash if one is computed)
//   cycle_lineage      ≈ output_trace(output_id) restricted to one PERFORMANCE (a gig plus the
//                        movement gigs of its chart — see outputs.ts `performanceRoot`)

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTempdirColtrane, type TempdirColtrane } from "./_harness.js";
import { dispatchTool, type ServerDeps } from "../../src/index.js";
import { MCP_TOOLS } from "../../src/mcp.js";

interface OutputWriteResult {
  ok: boolean;
  data?: { output_id: string };
}

async function writeOutput(
  deps: ServerDeps,
  opts: {
    gig_id: string;
    domain_type: string;
    core_type: string;
    agent_slug: string;
    data: Record<string, unknown>;
    derived_from?: string[];
  },
): Promise<string> {
  const refs = (opts.derived_from ?? []).map((id) => ({ to: id, relation: "derived_from" }));
  const res = (await dispatchTool(
    "output_write",
    {
      gig_id: opts.gig_id,
      domain: "demo",
      agent_slug: opts.agent_slug,
      core_type: opts.core_type,
      domain_type: opts.domain_type,
      data: opts.data,
      refs,
    },
    deps,
  )) as OutputWriteResult & { error?: unknown };
  if (!res.ok || !res.data) {
    throw new Error(`output_write failed: ${JSON.stringify(res)}`);
  }
  return res.data.output_id;
}

// Every sealed output carries its CORE's substance floor (#227 ruling), enforced on every
// write regardless of domain type. The core each fixture declares is the one its domain type
// actually extends on disk: `soft-verdict` and `summary` are Interpretation-cored, `raw-note`
// is Signal-cored. This spec used to declare "Verdict" for soft-verdict and "Artifact" for
// summary — neither matched domain_types/*.json, and nothing checked until the seal did.
// The v3.3 mapping the file documents is unchanged: `verdict.failed` is still read off
// `overall_verdict_shade`, which is the field soft-verdict actually declares.
const NOTE = (text: string): Record<string, unknown> => ({ text, source: `fixture://demo/${text}` });
const SUMMARY = (gist: string): Record<string, unknown> => ({ gist, claims: [gist] });

describe("chain_query primitives (T7) — failure_rate + cycle_lineage", () => {
  let env: TempdirColtrane;
  let deps: ServerDeps;

  beforeAll(async () => {
    env = await setupTempdirColtrane();
    const { bootstrapServerDeps } = await import("../../src/index.js");
    deps = bootstrapServerDeps(env.tempDir);
  });
  afterAll(() => env?.cleanup());

  // -----------------------------------------------------------------------
  // T7-A — surface check. Are the named primitives wired?
  // -----------------------------------------------------------------------
  it("chain_query.failure_rate is exposed on the MCP tool surface", () => {
    const slugs = MCP_TOOLS.map((t) => t.slug);
    const present = slugs.some((s) =>
      s === "chain_query.failure_rate" ||
      s === "chain_query_failure_rate" ||
      s === "failure_rate",
    );
    // RED-honest: not yet wired. The named v3.3 read primitive is absent from
    // the v0 surface. Leave this failing until the primitive is registered.
    expect(present).toBe(true);
  });

  it("chain_query.cycle_lineage is exposed on the MCP tool surface", () => {
    const slugs = MCP_TOOLS.map((t) => t.slug);
    const present = slugs.some((s) =>
      s === "chain_query.cycle_lineage" ||
      s === "chain_query_cycle_lineage" ||
      s === "cycle_lineage",
    );
    // RED-honest: not yet wired. The output_trace primitive walks ancestry but
    // does NOT scope to a single cycle (gig_id). Leave this failing until the
    // primitive is registered or output_trace gains a gig_id scope.
    expect(present).toBe(true);
  });

  // -----------------------------------------------------------------------
  // T7-B — functional check. Build the chain anyway, prove the substrate
  // can ANSWER these questions even if the named primitive isn't wired.
  // This is the "could-be-computed-from-output_query" diagnosis.
  // -----------------------------------------------------------------------
  it("the underlying data exists to compute failure_rate(voice_id) over a window", async () => {
    const voice = "judge-9";
    const gig = "00000000-0000-0000-0000-00000000aaaa";

    // Voice emits 5 verdicts: 3 ripened, 2 killed. Expected failure_rate = 0.4.
    const verdicts = [
      { pass: true },
      { pass: false },
      { pass: true },
      { pass: false },
      { pass: true },
    ];
    for (const v of verdicts) {
      await writeOutput(deps, {
        gig_id: gig,
        core_type: "Interpretation",
        domain_type: "soft-verdict",
        agent_slug: voice,
        data: {
          criteria: {},
          overall_verdict_shade: v.pass ? "pass" : "fail",
          claims: [v.pass ? "the candidate ripened" : "the candidate was killed"],
        },
      });
    }

    // Without chain_query.failure_rate, we fall back to output_query +
    // client-side reduction. This proves the substrate HAS the data; what's
    // missing is the named read primitive that v3.3 promises.
    const res = await dispatchTool("output_query", { agent_slug: voice }, deps);
    expect(res.ok).toBe(true);
    const outs = (res.data as { outputs: Array<{ data: Record<string, unknown> }> }).outputs;
    const total = outs.length;
    const failed = outs.filter((o) => o.data["overall_verdict_shade"] === "fail").length;
    const rate = total === 0 ? 0 : failed / total;
    expect(total).toBe(5);
    expect(failed).toBe(2);
    expect(rate).toBeCloseTo(0.4, 6);

    // Note for the next builder: output_query already supports agent_slug
    // filtering but NOT time-window slicing — chain_query.failure_rate's
    // `time_window` argument has no equivalent yet. The ledger has after/before
    // on gigs but outputs don't expose created_at in the query filter.
  });

  it("the underlying data exists to compute cycle_lineage(event_hash) for an output_id", async () => {
    const gig = "00000000-0000-0000-0000-00000000bbbb";
    const a = await writeOutput(deps, {
      gig_id: gig,
      core_type: "Signal",
      domain_type: "raw-note",
      agent_slug: "sensor-1",
      data: NOTE("root signal"),
    });
    const b = await writeOutput(deps, {
      gig_id: gig,
      core_type: "Signal",
      domain_type: "raw-note",
      agent_slug: "refiner-1",
      data: NOTE("intermediate"),
      derived_from: [a],
    });
    const c = await writeOutput(deps, {
      gig_id: gig,
      core_type: "Interpretation",
      domain_type: "summary",
      agent_slug: "summarizer-1",
      data: SUMMARY("summary leaf"),
      derived_from: [b],
    });

    // The named primitive (chain_query.cycle_lineage) is absent. The closest
    // shipped equivalent is output_trace, which walks ancestry but doesn't
    // surface the gig_id scope or a deterministic ordering. Probe it:
    const trace = await dispatchTool("output_trace", { output_id: c }, deps);
    expect(trace.ok).toBe(true);
    const nodes = (trace.data as { graph: { nodes: Array<{ id: string; gig_id: string }> } }).graph.nodes;
    const ids = nodes.map((n) => n.id);
    expect(ids).toContain(a);
    expect(ids).toContain(b);

    // RED-honest mapping: cycle_lineage promises (1) gig-scoped restriction
    // (2) deterministic ORDER (root → leaf). output_trace gives ancestor SET
    // but not a guaranteed order. Verify nodes all share the gig_id (so the
    // gig-scope guarantee happens to hold here only because no cross-gig edges
    // were authored — not because the primitive enforces it).
    for (const n of nodes) {
      expect(n.gig_id).toBe(gig);
    }
  });

  // -----------------------------------------------------------------------
  // T7-C — the gap that named-primitive landing has to close. Cross-gig
  // contamination would silently break cycle_lineage if not scoped.
  // -----------------------------------------------------------------------
  it("output_trace does NOT scope to a single gig — cross-gig ancestors leak in", async () => {
    const gigEarly = "00000000-0000-0000-0000-00000000cccc";
    const gigLater = "00000000-0000-0000-0000-00000000dddd";
    const earlyRoot = await writeOutput(deps, {
      gig_id: gigEarly,
      core_type: "Signal",
      domain_type: "raw-note",
      agent_slug: "sensor-2",
      data: NOTE("from an earlier gig"),
    });
    const laterLeaf = await writeOutput(deps, {
      gig_id: gigLater,
      core_type: "Interpretation",
      domain_type: "summary",
      agent_slug: "summarizer-2",
      data: SUMMARY("later gig pulls in earlier evidence"),
      derived_from: [earlyRoot],
    });

    const trace = await dispatchTool("output_trace", { output_id: laterLeaf }, deps);
    expect(trace.ok).toBe(true);
    const nodes = (trace.data as { graph: { nodes: Array<{ id: string; gig_id: string }> } }).graph.nodes;
    const otherGigNodes = nodes.filter((n) => n.gig_id !== gigLater);

    // GREEN: output_trace scopes the walk to the seed's PERFORMANCE — the gig, plus the sibling
    // movement gigs of the same chart (`<gig>.m.<movement>`), and nothing else. These two gig ids
    // are unrelated, so an ancestor across them stays out: cycle_lineage's scope guarantee is
    // enforced at the store layer (outputs.ts trace(), `performanceRoot`).
    expect(otherGigNodes.length).toBe(0);
  });
});
