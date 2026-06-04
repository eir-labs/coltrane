// e2e — eval substrate (T19) fires on gig completion.
//
// CLAUDE.md names evals as the 5th definition class. Loader reads them as
// slug-keyed records ("no composer yet"). This test asks: does an eval
// actually fire when a gig completes?
//
// Expected behavior (per the class-claim): a standard can reference an eval;
// when a gig under that standard completes, the eval runs against the
// gig's output and produces a verdict written to the recorder.
//
// Bug-bash hypothesis: evals load but DO NOT fire. The 5th class is a stub.
// This test is RED-by-design until eval invocation is wired.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTempdirColtrane, type TempdirColtrane } from "./_harness.js";
import { dispatchTool, type ServerDeps, type AgentInvoker } from "../../src/index.js";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

describe("eval substrate (T19) — 5th-class claim", () => {
  let env: TempdirColtrane;
  let deps: ServerDeps;

  beforeAll(async () => {
    env = await setupTempdirColtrane();
    // Add an eval definition into the tempdir genome BEFORE bootstrap.
    const evalDir = join(env.tempDir, "evals");
    if (!existsSync(evalDir)) mkdirSync(evalDir);
    writeFileSync(
      join(evalDir, "gist-quality-check.json"),
      JSON.stringify(
        {
          slug: "gist-quality-check",
          domain: "demo",
          fires_on_gig_under: "summarize",
          checks: ["summary.gist is non-empty", "summary.gist length <= 200"],
        },
        null,
        2,
      ),
    );
    const { bootstrapServerDeps } = await import("../../src/index.js");
    deps = bootstrapServerDeps(env.tempDir);
  });
  afterAll(() => env?.cleanup());

  it("evals load as slug-keyed records (current claim from loader.ts)", async () => {
    // Direct surface check: the registry / outputs / etc don't expose evals
    // via dispatchTool today. The closest contract today is that loadGenome
    // populates an `evals` map. Confirm via type_browse (lists known kinds).
    const res = await dispatchTool("type_browse", {}, deps);
    expect(res.ok).toBe(true);
    // Today's contract: evals load but no tool surface exposes them. This
    // assertion holds the gap-state — eval slug is NOT discoverable through
    // the public MCP surface as a typed entity. Documents the stub status.
    const data = res.data as { types: Array<{ slug: string }> };
    const slugs = data.types.map((t) => t.slug);
    expect(slugs).not.toContain("gist-quality-check");
  });

  it("eval does NOT fire on gig completion (bug-bash RED — the stub finding)", async () => {
    // Run a gig under the 'summarize' standard. If eval fired, we'd see a
    // verdict-shape output in the gig's outputs.
    const invoke: AgentInvoker = ({ agent }) =>
      agent.slug === "sensor" ? { text: "the room is loud" } : { gist: "loud room" };
    const wired: ServerDeps = { ...deps, invoke };

    const dispatch = await dispatchTool(
      "gig_dispatch",
      { standard_slug: "summarize", input: { source: "stdin" } },
      wired,
    );
    expect(dispatch.ok).toBe(true);
    const dispatchData = dispatch.data as { gig_id: string };

    // After gig completes, query outputs. If eval fired, it'd write a verdict.
    const query = await dispatchTool("output_query", { gig_id: dispatchData.gig_id }, wired);
    const outputs = (query.data as { outputs: Array<{ domain_type: string }> }).outputs;
    const verdictOutputs = outputs.filter((o) => o.domain_type.includes("verdict"));

    // RED expectation: 0 verdicts. Once eval invocation is wired, this RED
    // will flip GREEN with verdictOutputs.length >= 1 — that's when the
    // 5th class becomes load-bearing instead of a placeholder.
    expect(verdictOutputs.length).toBe(0);
  });
});
