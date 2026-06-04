// e2e — eval substrate (T19) FIRES on gig completion.
//
// Counterpart to tests/e2e/eval_substrate_fires.spec.ts (PR #74): that test
// captured the bug-bash RED — the 5th class was a stub. This test holds the
// GREEN that lands when runtime wires eval scan-and-fire post-phases:
//
//   declare an eval (fires_on_standard + agent_slug) → dispatch a gig under
//   that standard → assert: a verdict-typed output appears in output_query
//   for that gig.
//
// The eval invocation IS itself an agent invocation against the gig's final
// output. The agent's returned shape ({passed, reason, checked}) is wrapped
// into a soft-verdict typed output (criteria + overall_verdict_shade required
// by the schema; passed/reason/checked carried as additional properties).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTempdirColtrane, type TempdirColtrane } from "./_harness.js";
import { dispatchTool, type ServerDeps, type AgentInvoker } from "../../src/index.js";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

describe("eval substrate (T19) — fires on gig completion (the GREEN flip)", () => {
  let env: TempdirColtrane;
  let deps: ServerDeps;

  beforeAll(async () => {
    env = await setupTempdirColtrane();

    // 1) Add an eval AGENT into the tempdir genome BEFORE bootstrap. The
    // eval-substrate runtime resolves the eval's agent_slug against the
    // loaded agents map, so the agent must exist on disk.
    writeFileSync(
      join(env.tempDir, "agents", "gist-quality-checker.json"),
      JSON.stringify(
        {
          slug: "gist-quality-checker",
          primitives: ["INTERPRET"],
          input_types: ["summary"],
          output_types: ["soft-verdict"],
          domain: "demo",
        },
        null,
        2,
      ),
    );

    // 2) Add the eval definition itself: fires_on_standard names the gig
    // whose completion triggers this eval; agent_slug names the agent the
    // runtime invokes against the gig's final output.
    const evalDir = join(env.tempDir, "evals");
    if (!existsSync(evalDir)) mkdirSync(evalDir);
    writeFileSync(
      join(evalDir, "gist-quality-check.json"),
      JSON.stringify(
        {
          slug: "gist-quality-check",
          domain: "demo",
          fires_on_standard: "summarize",
          agent_slug: "gist-quality-checker",
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

  it("eval fires on gig completion and writes a verdict-typed output", async () => {
    // The mock invoker returns:
    //   - sensor   → raw-note (schema: {text: string})
    //   - summarizer → summary (schema: {gist: string})
    //   - gist-quality-checker (eval phase) → {passed, reason, checked}
    //     — the runtime wraps this into a soft-verdict-typed output.
    const invoke: AgentInvoker = ({ agent, phase }) => {
      if (agent.slug === "sensor") return { text: "the room is loud" };
      if (agent.slug === "summarizer") return { gist: "loud room" };
      if (agent.slug === "gist-quality-checker") {
        // The eval-agent invocation. Phase prefix is "eval:<slug>" — the runtime
        // tags eval phases so a mock can route on it.
        expect(phase).toBe("eval:gist-quality-check");
        return {
          passed: true,
          reason: "gist is non-empty and within 200 chars",
          checked: [
            { name: "gist-non-empty", ok: true },
            { name: "gist-length-bound", ok: true },
          ],
        };
      }
      throw new Error(`unexpected agent: ${agent.slug}`);
    };
    const wired: ServerDeps = { ...deps, invoke };

    const dispatch = await dispatchTool(
      "gig_dispatch",
      { standard_slug: "summarize", input: { source: "stdin" } },
      wired,
    );
    expect(dispatch.ok).toBe(true);
    const dispatchData = dispatch.data as { gig_id: string };

    const query = await dispatchTool("output_query", { gig_id: dispatchData.gig_id }, wired);
    const outputs = (query.data as { outputs: Array<{ domain_type: string; data: Record<string, unknown> }> }).outputs;

    // GREEN: a verdict-typed output appears. PR #74's bug-bash test will flip
    // — its assertion (verdictOutputs.length == 0) now becomes incorrect.
    const verdictOutputs = outputs.filter((o) => o.domain_type.includes("verdict"));
    expect(verdictOutputs.length).toBeGreaterThanOrEqual(1);

    // Contract check: the verdict carries the eval's {passed, reason, checked}.
    const verdict = verdictOutputs[0]!;
    expect(verdict.domain_type).toBe("soft-verdict");
    expect(verdict.data["passed"]).toBe(true);
    expect(verdict.data["reason"]).toContain("non-empty");
    expect(Array.isArray(verdict.data["checked"])).toBe(true);
    expect((verdict.data["checked"] as unknown[]).length).toBe(2);
    expect(verdict.data["eval_slug"]).toBe("gist-quality-check");
  });
});
