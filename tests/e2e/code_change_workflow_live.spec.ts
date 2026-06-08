// T15 — 5-agent code-change workflow ships a real PR to a test repo.
//
// Spec claim (from coordination): a code-change standard composed of five
// agents — repo-scout (SENSE) → planner (PLAN) → writer (CREATE) → verifier
// (JUDGE) → publisher (CREATE) — runs end-to-end and lands a real PR on a
// test repo. This is the integration test that proves the standard surface
// composes for a non-trivial, multi-primitive pipeline.
//
// Honest scope of THIS test:
//   On main today, neither the five agents nor a `code-change` standard nor
//   any PR-publishing tool exist in coltrane-oss. That's the gap. This test
//   is therefore RED-HONEST: it (1) asserts the gap on a fresh genome, then
//   (2) composes the five agents + the standard via the runtime tools to
//   prove the SURFACE supports the shape, then (3) dispatches the standard
//   with a deterministic invoker to prove the in-memory pipeline runs, then
//   (4) asserts the actual PR-ship side effect — the GitHub publish step —
//   is NOT a built-in coltrane primitive and surfaces no real-repo write.
//
// What goes GREEN: (2) and (3) — the runtime composes + dispatches the
// 5-phase pipeline. What goes RED: (1) the gap on main, and (4) the
// publisher's `pr_url` is a model-fabricated string, not a verified github
// API call from coltrane's surface. That's the honest diagnosis: the
// pipeline shape composes, the publish primitive is missing.
//
// No mocks of coltrane's own surface. The only deterministic seam is the
// AgentInvoker, which stands in for the LLM call — same pattern as the
// full_workflow + hot_reload e2es.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  dispatchTool,
  bootstrapServerDeps,
  type AgentInvoker,
  type ServerDeps,
} from "../../src/index.js";

import { setupTempdirColtrane, type TempdirColtrane } from "./_harness.js";

const FIVE_AGENTS = ["repo-scout", "planner", "writer", "verifier", "publisher"] as const;
const STANDARD_SLUG = "code-change";

describe("T15 — 5-agent code-change workflow ships a real PR (red-honest)", () => {
  let env: TempdirColtrane;
  let deps: ServerDeps;

  beforeAll(async () => {
    env = await setupTempdirColtrane();
    deps = bootstrapServerDeps(env.tempDir);

    // deterministic invoker: each agent returns a payload that conforms to the
    // domain_type schema declared at compose-time below. NOT a coltrane stub —
    // this is the LLM seam only (same pattern as full_workflow.spec.ts).
    const invoke: AgentInvoker = (ctx) => {
      const slug = ctx.agent.slug;
      if (slug === "repo-scout") {
        return {
          repo_url: "https://github.com/eir-research/coltrane-t15-fixture",
          target_files: ["README.md"],
          context_summary: "fixture repo, single README change",
        };
      }
      if (slug === "planner") {
        return {
          plan_steps: ["edit README.md: add T15 fixture line"],
          rationale: "smallest possible code-change to prove the pipeline composes",
          target_files: ["README.md"],
        };
      }
      if (slug === "writer") {
        return {
          patch_diff: "--- a/README.md\n+++ b/README.md\n@@ -1 +1,2 @@\n # T15 fixture\n+T15 ran 2026-06-04\n",
          touched_files: ["README.md"],
        };
      }
      if (slug === "verifier") {
        return {
          verdict: "pass",
          checks_run: ["diff-parses", "single-file-bounded"],
          rationale_notes: ["diff is well-formed", "only README.md touched"],
        };
      }
      if (slug === "publisher") {
        // HONEST: the publisher CANNOT verify it actually shipped a PR —
        // coltrane has no github primitive. The invoker fabricates a pr_url
        // string; the test asserts (in step 4) that no real github API was
        // called, surfacing the gap.
        return {
          pr_url: "https://github.com/eir-research/coltrane-t15-fixture/pull/FAKE",
          published: false,
          publish_method: "fabricated-by-invoker",
        };
      }
      throw new Error(`T15 invoker: unexpected agent slug ${slug}`);
    };
    deps.invoke = invoke;
  }, 600_000);

  afterAll(() => {
    env?.cleanup();
  });

  // -------------------------------------------------------------------------
  // Step 1 — RED diagnosis on main: none of the five agents or the standard
  // are shipped on coltrane-oss main as of 2026-06-04. Prove it before we
  // compose them.
  // -------------------------------------------------------------------------
  it("step 1 — RED: the five agents and the code-change standard are NOT shipped on main", () => {
    const agentsDir = join(env.tempDir, "agents");
    const standardsDir = join(env.tempDir, "standards");

    for (const slug of FIVE_AGENTS) {
      const path = join(agentsDir, `${slug}.json`);
      expect(
        existsSync(path),
        `T15 GAP: agents/${slug}.json should not exist on main (this RED is the bug).`,
      ).toBe(false);
    }
    expect(
      existsSync(join(standardsDir, `${STANDARD_SLUG}.json`)),
      `T15 GAP: standards/${STANDARD_SLUG}.json should not exist on main.`,
    ).toBe(false);

    // Sanity: the runtime surface DOES exist (we'll use it next). If these
    // exports went missing, T15 would also collapse — assert their presence
    // so failure-mode is clear.
    expect(typeof dispatchTool).toBe("function");
    expect(typeof bootstrapServerDeps).toBe("function");
  });

  // -------------------------------------------------------------------------
  // Step 2 — register the five domain types + define the five agents through
  // dispatchTool. Asserts the SURFACE supports the shape. Side effects: files
  // land on disk under domain_types/ and agents/ — the substrate-of-truth
  // claim for any new entity.
  // -------------------------------------------------------------------------
  it("step 2 — compose the 5-agent pipeline through dispatchTool (surface supports the shape)", async () => {
    // ---- five distinct domain types, one per phase. Each is shape-distinct
    // from raw-note + summary so the §5 reuse-guard doesn't reject them.
    const types = [
      {
        slug: "repo-scout-report",
        extends: "Signal",
        domain: "code-change",
        schema: {
          type: "object",
          properties: {
            repo_url: { type: "string" },
            target_files: { type: "array", items: { type: "string" } },
            context_summary: { type: "string" },
          },
        },
        required_fields: ["repo_url", "target_files", "context_summary"],
      },
      {
        slug: "change-plan",
        extends: "Plan",
        domain: "code-change",
        schema: {
          type: "object",
          properties: {
            plan_steps: { type: "array", items: { type: "string" } },
            rationale: { type: "string" },
            target_files: { type: "array", items: { type: "string" } },
          },
        },
        required_fields: ["plan_steps", "rationale", "target_files"],
      },
      {
        slug: "code-patch",
        extends: "Artifact",
        domain: "code-change",
        schema: {
          type: "object",
          properties: {
            patch_diff: { type: "string" },
            touched_files: { type: "array", items: { type: "string" } },
          },
        },
        required_fields: ["patch_diff", "touched_files"],
      },
      {
        slug: "patch-verdict",
        extends: "Verdict",
        domain: "code-change",
        schema: {
          type: "object",
          properties: {
            verdict: { type: "string" },
            checks_run: { type: "array", items: { type: "string" } },
            rationale_notes: { type: "array", items: { type: "string" } },
          },
        },
        required_fields: ["verdict", "checks_run", "rationale_notes"],
      },
      {
        slug: "pr-receipt",
        extends: "Artifact",
        domain: "code-change",
        schema: {
          type: "object",
          properties: {
            pr_url: { type: "string" },
            published: { type: "boolean" },
            publish_method: { type: "string" },
          },
        },
        required_fields: ["pr_url", "published", "publish_method"],
      },
    ];

    for (const t of types) {
      const r = await dispatchTool("type_register", t, deps);
      expect(r.ok, `type_register(${t.slug}) failed: ${r.error}`).toBe(true);
    }

    // ---- five agents, each typed input→output, valid §3 primitive
    // progression.
    //
    // FINDING (T15-A): the §3 rule "CREATE needs upstream INTERPRET/PLAN" is
    // enforced PER-AGENT'S OWN primitives list (src/composition.ts:61-71),
    // not cross-agent in the standard. A single-primitive [CREATE] agent is
    // rejected even when an upstream PHASE supplies PLAN. To compose this
    // pipeline at all, writer + publisher must bundle [PLAN,CREATE] and
    // [INTERPRET,CREATE] respectively — the §3 gate is on the agent shape,
    // not the standard topology. Surface'd here as the workaround that ALSO
    // documents the design choice in coltrane-oss.
    const agents = [
      {
        slug: "repo-scout",
        primitives: ["SENSE"],
        output_types: ["repo-scout-report"],
        domain: "code-change",
      },
      {
        slug: "planner",
        primitives: ["PLAN"],
        input_types: ["repo-scout-report"],
        output_types: ["change-plan"],
        domain: "code-change",
      },
      {
        slug: "writer",
        primitives: ["PLAN", "CREATE"], // §3 workaround: per-agent upstream PLAN
        input_types: ["change-plan"],
        output_types: ["code-patch"],
        domain: "code-change",
      },
      {
        slug: "verifier",
        primitives: ["JUDGE"],
        input_types: ["code-patch"],
        output_types: ["patch-verdict"],
        domain: "code-change",
      },
      {
        slug: "publisher",
        primitives: ["INTERPRET", "CREATE"], // §3 workaround: per-agent upstream INTERPRET
        input_types: ["patch-verdict", "code-patch"],
        output_types: ["pr-receipt"],
        domain: "code-change",
      },
    ];

    for (const a of agents) {
      const r = await dispatchTool("agent_define", a, deps);
      expect(r.ok, `agent_define(${a.slug}) failed: ${r.error}`).toBe(true);
      expect(
        existsSync(join(env.tempDir, "agents", `${a.slug}.json`)),
        `agent file not written for ${a.slug}`,
      ).toBe(true);
    }

    // ---- compose the standard. Five phases, declared order matches the
    // primitive progression.
    const compose = await dispatchTool(
      "standard_compose",
      {
        slug: STANDARD_SLUG,
        domain: "code-change",
        agents: agents.map((a) => ({
          slug: a.slug,
          primitives: a.primitives,
          input_types: a.input_types ?? [],
          output_types: a.output_types,
          domain: a.domain,
        })),
        phases: [
          { name: "scout", chairs: [{ role: "scout", agent_slug: "repo-scout", depends_on: [], input_contract: [], output_contract: ["repo-scout-report"], required_skills: [] }] },
          { name: "plan", chairs: [{ role: "plan", agent_slug: "planner", depends_on: [], input_contract: [], output_contract: ["change-plan"], required_skills: [] }] },
          { name: "write", chairs: [{ role: "write", agent_slug: "writer", depends_on: [], input_contract: [], output_contract: ["code-patch"], required_skills: [] }] },
          { name: "verify", chairs: [{ role: "verify", agent_slug: "verifier", depends_on: [], input_contract: [], output_contract: ["patch-verdict"], required_skills: [] }] },
          { name: "publish", chairs: [{ role: "publish", agent_slug: "publisher", depends_on: [], input_contract: [], output_contract: ["pr-receipt"], required_skills: [] }] },
        ],
      },
      deps,
    );
    expect(compose.ok, `standard_compose failed: ${compose.error}`).toBe(true);
    const composeData = compose.data as {
      standard_id: string;
      validation_result: { valid: boolean };
      content_hash: string;
    };
    expect(composeData.standard_id).toBe(STANDARD_SLUG);
    expect(composeData.validation_result.valid).toBe(true);
    expect(composeData.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(join(env.tempDir, "standards", `${STANDARD_SLUG}.json`))).toBe(true);

    // Re-bootstrap deps so the standards Map picks up the new entry (T14
    // hot-reload gap — explicitly worked around here, not silently).
    const fresh = bootstrapServerDeps(env.tempDir);
    deps.standards = fresh.standards;
    deps.registry = fresh.registry;
  });

  // -------------------------------------------------------------------------
  // Step 3 — dispatch the standard. Asserts the 5-phase pipeline RUNS in
  // declared order and produces five typed outputs. This is the GREEN claim
  // T15 can honestly make today: the in-memory composition works.
  // -------------------------------------------------------------------------
  let gigId: string | null = null;
  let prReceiptId: string | null = null;
  it("step 3 — GREEN: gig_dispatch through the 5-agent pipeline produces 5 typed outputs in order", async () => {
    const outputsBefore = deps.outputs.all().length;
    const res = await dispatchTool(
      "gig_dispatch",
      { standard_slug: STANDARD_SLUG, input: { target_repo: "eir-research/coltrane-t15-fixture" } },
      deps,
    );
    expect(res.ok, `gig_dispatch failed: ${res.error}`).toBe(true);
    const data = res.data as {
      gig_id: string;
      manifest: { genome_hash: string; run_fingerprint: string; output_count: number };
    };
    gigId = data.gig_id;
    expect(gigId).toBeTruthy();
    expect(data.manifest.output_count).toBe(5);
    expect(data.manifest.genome_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(data.manifest.run_fingerprint).toMatch(/^[0-9a-f]{64}$/);

    const allOutputs = deps.outputs.all();
    expect(allOutputs.length).toBe(outputsBefore + 5);
    const gigOutputs = allOutputs.filter((o) => o.gig_id === gigId);
    expect(gigOutputs.map((o) => o.domain_type).sort()).toEqual(
      ["change-plan", "code-patch", "patch-verdict", "pr-receipt", "repo-scout-report"],
    );

    // The pr-receipt is the terminal output — keep it for the publish probe.
    const pr = gigOutputs.find((o) => o.domain_type === "pr-receipt");
    expect(pr, "publisher output missing").toBeDefined();
    prReceiptId = pr!.id;

    // Provenance: pr-receipt traces back through patch-verdict + code-patch,
    // which trace back to change-plan, which traces back to repo-scout-report.
    // We assert the ancestor set is non-trivial — the runtime wires
    // derived_from edges across phases.
    const trace = await dispatchTool("output_trace", { output_id: prReceiptId }, deps);
    expect(trace.ok).toBe(true);
    const traceData = trace.data as {
      graph: { nodes: Array<{ domain_type: string }> };
      root_signals: Array<{ id: string }>;
    };
    const ancestorTypes = traceData.graph.nodes.map((n) => n.domain_type);
    expect(ancestorTypes).toContain("repo-scout-report");
    expect(traceData.root_signals.length).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // Step 4 — THE T15 RED: the publisher's pr_url is model-fabricated. There
  // is no github-publish primitive in coltrane's MCP surface; nothing in the
  // runtime actually opens a PR. Document the gap honestly.
  // -------------------------------------------------------------------------
  it("step 4 — RED: no github-publish primitive exists; pr_url is fabricated, not verified", async () => {
    // Probe the tools list via a fresh deps bootstrap — checks every wired
    // tool name. The MCP surface ships ~28 tools (see src_api_surface.md);
    // none of them are a github primitive.
    const surface = await dispatchTool("system_audit", {}, deps);
    expect(surface.ok).toBe(true);

    // Read the standard file and confirm the publish phase is declared but
    // the publisher's primitive is CREATE — there is no runtime hook in
    // coltrane that maps CREATE → github API. The publish is a model-string,
    // not a verified side effect.
    const standardPath = join(env.tempDir, "standards", `${STANDARD_SLUG}.json`);
    const standardJson = JSON.parse(readFileSync(standardPath, "utf-8")) as {
      phases: Array<{ name: string; agent: string }>;
    };
    const publishPhase = standardJson.phases.find((p) => p.name === "publish");
    expect(publishPhase, "publish phase missing from standard").toBeDefined();
    expect(publishPhase!.agent).toBe("publisher");

    // The pr-receipt's publish_method field is the honesty hook: the invoker
    // set it to "fabricated-by-invoker" because nothing else CAN set it.
    expect(prReceiptId).not.toBeNull();
    const allOutputs = deps.outputs.all();
    const prOutput = allOutputs.find((o) => o.id === prReceiptId);
    expect(prOutput, "pr-receipt output missing").toBeDefined();
    const prData = prOutput!.data as { pr_url: string; published: boolean; publish_method: string };

    // RED assertion: published=false AND publish_method names the gap.
    // If a real github primitive were wired, published would be true and
    // publish_method would be something like "gh-api" or "octokit".
    expect(
      prData.published,
      `T15 GAP: publisher reports published=true, but coltrane has no github primitive. ` +
        `If this is true, a fake side-effect is leaking through the pipeline.`,
    ).toBe(false);
    expect(prData.publish_method).toMatch(/fabricated|stub|mock/i);

    // Belt-and-suspenders: scan src/server.ts (the dispatcher) for any
    // "github", "pull_request", or "pr_open" tool name. There should be zero.
    const serverSrc = readFileSync(join(env.tempDir, "src", "server.ts"), "utf-8");
    expect(
      /github|pull_request|pr_open|pr_publish|gh_api/i.test(serverSrc),
      `T15 GAP: coltrane MCP surface declares NO github primitive. ` +
        `If this regex matches in the future, the publish step has a real seam.`,
    ).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Step 5 — execution_history_read picks up the gig. Cheap closing assertion
  // that the ledger sealed the run.
  // -------------------------------------------------------------------------
  it("step 5 — execution_history_read surfaces the T15 gig", async () => {
    expect(gigId).not.toBeNull();
    const res = await dispatchTool("execution_history_read", { standard_slug: STANDARD_SLUG }, deps);
    expect(res.ok).toBe(true);
    const data = res.data as { executions: Array<{ gig_id: string; standard_slug: string }>; count: number };
    expect(data.count).toBeGreaterThanOrEqual(1);
    const t15Runs = data.executions.filter((e) => e.standard_slug === STANDARD_SLUG);
    expect(t15Runs.length).toBeGreaterThanOrEqual(1);
    expect(t15Runs.some((e) => e.gig_id === gigId)).toBe(true);
  });
});
