// A Claude thread runs a coltrane STANDARD via MCP, and we validate the run.
//
// This is the missing diagonal of the e2e surface: user_drives_claude_with_coltrane.spec.ts
// drives single tool calls; coltrane_full_workflow.spec.ts dispatches a whole standard but
// in-process. Here the OPERATOR (a Claude thread, in the live block) dispatches a whole
// standard over MCP, validates its own run, and THEN the outer harness validates that
// invocation.
//
// Two layers, two channels — kept SEPARATE on purpose:
//
//   Block A — DETERMINISTIC SEAM (always runs, CI-safe, no model, no network)
//     gig_dispatch in-process with an injected deterministic invoker. Proves the wiring:
//     dispatch → runGig → typed sealing → ledger → provenance → byte-reproducible fingerprint.
//     A failure here localizes to the SEAMS, not the cognition.
//
//   Block B — LIVE COGNITION (gated behind COLTRANE_LIVE=1)
//     A real `claude -p` operator thread calls mcp__coltrane__gig_dispatch over MCP; the MCP
//     server's runGig spawns a real per-chair claude (makeClaudeInvoker). Proves the agents
//     actually run the model. Validated by the transcript-surfaced manifest + the operator's
//     own output_trace (INNER), never by byte-equality (that's the hollow-green trap).
//
// Run:
//   deterministic:  npx vitest run --config tests/e2e/vitest.config.ts \
//                     tests/e2e/operator_dispatches_standard.spec.ts
//   live:           COLTRANE_LIVE=1 npx vitest run --config tests/e2e/vitest.config.ts \
//                     tests/e2e/operator_dispatches_standard.spec.ts

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTempdirColtrane,
  spawnClaudeSubthread,
  parseStreamJson,
  assistantText,
  type TempdirColtrane,
} from "./_harness.js";
import {
  dispatchTool,
  bootstrapServerDeps,
  type ServerDeps,
  type AgentInvoker,
} from "../../src/index.js";

// The seed `summarize` standard: sensor (SENSE → raw-note{text}) → summarizer (INTERPRET → summary{gist}).
// The deterministic invoker stands in for the one non-deterministic seam (the LLM), keyed by slug;
// it returns schema-valid payloads so the typed sealing path runs for real.
const detInvoke: AgentInvoker = (ctx) => {
  switch (ctx.agent.slug) {
    case "sensor":
      return { text: "the q3 latency report: p99 fell from 410ms to 190ms after the index change" };
    case "summarizer":
      return { gist: "p99 latency roughly halved after the index change" };
    default:
      throw new Error(`unexpected agent slug in deterministic invoker: ${ctx.agent.slug}`);
  }
};

// Dispatch the `summarize` standard through a freshly-bootstrapped, deterministic-invoker deps.
// Each call is hermetic (its own deps) so output accumulation can't confound the fingerprint check.
async function dispatchSummarizeDeterministically(tempDir: string) {
  const deps: ServerDeps = bootstrapServerDeps(tempDir);
  deps.invoke = detInvoke;
  const res = await dispatchTool(
    "gig_dispatch",
    { standard_slug: "summarize", input: { topic: "q3-latency" } },
    deps,
  );
  return { deps, res };
}

// ── Block A — deterministic seam ────────────────────────────────────────────────
describe("an operator dispatches a standard — deterministic seam (the wiring)", () => {
  let env: TempdirColtrane;

  beforeAll(async () => {
    env = await setupTempdirColtrane();
  }, 300_000);

  afterAll(() => env?.cleanup());

  it("gig_dispatch runs the whole standard end-to-end and seals both phases' outputs", async () => {
    const { deps, res } = await dispatchSummarizeDeterministically(env.tempDir);

    expect(res.ok, `gig_dispatch failed: ${res.error}`).toBe(true);
    const data = res.data as {
      gig_id: string;
      manifest: { genome_hash: string; run_fingerprint: string; output_count: number };
    };
    // the manifest — the run's content-addressed identity
    expect(data.gig_id).toBeTruthy();
    expect(data.manifest.genome_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(data.manifest.run_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(data.manifest.output_count, "two phases → two sealed outputs").toBe(2);

    // OUTER channel 1 — sealed state: both typed outputs landed, ledger grew
    const gigOutputs = deps.outputs.all().filter((o) => o.gig_id === data.gig_id);
    expect(gigOutputs.map((o) => o.domain_type).sort()).toEqual(["raw-note", "summary"]);
    expect(deps.ledger.count()).toBeGreaterThanOrEqual(1);
  });

  it("the run's provenance links downstream summary back to the upstream raw-note", async () => {
    const { deps, res } = await dispatchSummarizeDeterministically(env.tempDir);
    const gigId = (res.data as { gig_id: string }).gig_id;
    const summary = deps.outputs.all().find((o) => o.gig_id === gigId && o.domain_type === "summary");
    expect(summary, "summary output missing").toBeDefined();

    // OUTER channel 2 — trace walks BACKWARD: the ancestor closure of the summary is the raw-note Signal
    const trace = await dispatchTool("output_trace", { output_id: summary!.id }, deps);
    expect(trace.ok, `output_trace failed: ${trace.error}`).toBe(true);
    const g = trace.data as { graph: { nodes: Array<{ domain_type: string }> }; root_signals: unknown[] };
    expect(g.graph.nodes.map((n) => n.domain_type)).toContain("raw-note");
    expect(g.root_signals.length).toBeGreaterThanOrEqual(1);
  });

  it("the run is byte-reproducible — same genome + standard + input → identical fingerprint", async () => {
    // The litmus from CLAUDE.md: the run_fingerprint is a pure function of the run, not the clock
    // or a session id. Two hermetic dispatches must agree, or the seam cached something it shouldn't.
    const a = await dispatchSummarizeDeterministically(env.tempDir);
    const b = await dispatchSummarizeDeterministically(env.tempDir);
    const ma = (a.res.data as { manifest: { genome_hash: string; run_fingerprint: string } }).manifest;
    const mb = (b.res.data as { manifest: { genome_hash: string; run_fingerprint: string } }).manifest;
    expect(mb.genome_hash).toBe(ma.genome_hash);
    expect(mb.run_fingerprint).toBe(ma.run_fingerprint);
  });
});

// ── Block B — live cognition (gated) ─────────────────────────────────────────────
// Spawns a real operator thread + real per-chair claude inside the MCP server. Needs auth and
// costs real tokens, so it only runs under COLTRANE_LIVE=1. Validation is by transcript + the
// operator's own trace, NOT byte-equality — the model's prose is judged, not pinned.
const LIVE = process.env["COLTRANE_LIVE"] === "1";
const SKIP_PERMS = "--dangerously-skip-permissions";

describe.skipIf(!LIVE)("an operator dispatches a standard — live cognition (the agents run)", () => {
  let env: TempdirColtrane;

  beforeAll(async () => {
    env = await setupTempdirColtrane();
  }, 300_000);

  afterAll(() => env?.cleanup());

  it("a Claude thread dispatches `summarize` over MCP, traces it, and we validate the invocation", async () => {
    const r = await spawnClaudeSubthread(
      [
        "-p",
        [
          "You are operating the coltrane MCP server in this repo.",
          "Do exactly two calls:",
          "1. Call mcp__coltrane__gig_dispatch with standard_slug='summarize' and",
          "   input={ \"topic\": \"q3-latency\" }.",
          "2. Take the gig_id it returns, and call mcp__coltrane__output_trace on the",
          "   summary output id from that gig (find it via mcp__coltrane__output_query if needed).",
          "Then reply with one line: the gist of the summary, and whether the trace links it to a raw-note.",
        ].join(" "),
        SKIP_PERMS,
      ],
      { mcpConfigPath: env.mcpConfigPath, cwd: env.tempDir, timeoutMs: 600_000 },
    );

    expect(r.exitCode, `claude stderr:\n${r.stderr.slice(0, 800)}`).toBe(0);

    const events = parseStreamJson(r.stdout);
    const toolCalls: Array<{ name: string; input: Record<string, unknown> }> = [];
    for (const ev of events) {
      if (ev.type !== "assistant") continue;
      const msg = ev.message as { content?: Array<{ type?: string; name?: string; input?: Record<string, unknown> }> } | undefined;
      for (const b of msg?.content ?? []) {
        if (b.type === "tool_use" && typeof b.name === "string") toolCalls.push({ name: b.name, input: b.input ?? {} });
      }
    }

    // OUTER channel 1 — transcript: the operator actually dispatched THIS standard
    const dispatch = toolCalls.find((c) => c.name === "mcp__coltrane__gig_dispatch");
    expect(dispatch, "operator never called gig_dispatch").toBeDefined();
    expect(dispatch!.input["standard_slug"]).toBe("summarize");

    // OUTER channel 2 — the manifest surfaced in the gig_dispatch tool_result (two phases → output_count 2,
    // 64-hex content hashes). The live MCP server's ledger is in-memory, so we read the run's identity from
    // the transcript, not from a shared store — that's the honest seam for a cross-process live run.
    const blob = JSON.stringify(events);
    expect(blob).toMatch(/"output_count":\s*2/);
    expect(blob).toMatch(/"run_fingerprint":\s*"[0-9a-f]{64}"/);
    expect(toolCalls.some((c) => c.name === "mcp__coltrane__output_trace"), "operator never traced the run").toBe(true);

    // INNER channel — the operator's own verdict over its run (model judging the model)
    const reply = assistantText(events).toLowerCase();
    expect(reply, `operator reply:\n${reply}`).toMatch(/raw-note|latency|gist|summary/);
  }, 660_000);
});
