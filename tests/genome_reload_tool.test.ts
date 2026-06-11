// genome_reload MCP tool. Issue #130.
//
// Intent: dispatching `genome_reload` against a live deps re-reads the genome
// dir, mutates deps.standards / deps.skills / deps.evals / deps.registry
// IN PLACE, and returns a diff (added / modified / removed) plus load_errors.
//
// Non-goals: not changing the underlying genome contract — same loadGenome shape
// is re-invoked. Not swapping deps wholesale — captured references
// (OutputStore keeps its registry pointer) keep working because the
// registry mutates in place. Not a hot-reload of agent invokers or
// running gigs.
// verdict: green expected post-fix

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TEST_BEHAVIOR } from "./_support/agents.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapServerDeps, dispatchTool, type ServerDeps } from "../src/server.js";

const REQUIRED_CORE_TYPES = [
  { slug: "Signal", primitive: "SENSE", description: "", schema: {} },
  { slug: "Interpretation", primitive: "INTERPRET", description: "", schema: {} },
  { slug: "Judgment", primitive: "JUDGE", description: "", schema: {} },
  { slug: "Plan", primitive: "PLAN", description: "", schema: {} },
  { slug: "Artifact", primitive: "CREATE", description: "", schema: {} },
  { slug: "Verdict", primitive: "VERIFY", description: "", schema: {} },
];

function writeJson(dir: string, name: string, body: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify(body, null, 2));
}

function seedCoreTypes(root: string): void {
  for (const c of REQUIRED_CORE_TYPES) writeJson(join(root, "core_types"), `${c.slug}.json`, c);
}

describe("genome_reload MCP tool (Rob #130)", () => {
  let root: string;
  let deps: ServerDeps;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "coltrane-genome-reload-"));
    seedCoreTypes(root);
    writeJson(join(root, "agents"), "scout.json", { ...TEST_BEHAVIOR,
      slug: "scout",
      primitives: ["SENSE"],
      output_types: ["raw-note"],
      domain: "demo",
    });
    writeJson(join(root, "domain_types"), "raw-note.json", {
      slug: "raw-note",
      version: 1,
      extends: "Signal",
      domain: "demo",
      status: "active",
      schema: { type: "object", properties: { text: { type: "string" } } },
      required_fields: ["text"],
    });
    deps = bootstrapServerDeps(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("adding new agents/types/standards on disk + reload makes them visible without restart", async () => {
    expect(deps.standards?.size ?? 0).toBe(0);

    writeJson(join(root, "agents"), "summarizer.json", { ...TEST_BEHAVIOR,
      slug: "summarizer",
      primitives: ["INTERPRET"],
      input_types: ["raw-note"],
      output_types: ["summary"],
      domain: "demo",
    });
    writeJson(join(root, "domain_types"), "summary.json", {
      slug: "summary",
      version: 1,
      extends: "Interpretation",
      domain: "demo",
      status: "active",
      schema: { type: "object", properties: { gist: { type: "string" } } },
      required_fields: ["gist"],
    });
    writeJson(join(root, "standards"), "summarize.json", {
      slug: "summarize",
      domain: "demo",
      agent_slugs: ["scout", "summarizer"],
      phases: [{ name: "sense", chairs: [{ role: "sense", agent_slug: "scout", depends_on: [], input_contract: [], output_contract: ["raw-note"], required_skills: [] }] }, { name: "interpret", chairs: [{ role: "interpret", agent_slug: "summarizer", depends_on: [], input_contract: [], output_contract: ["summary"], required_skills: [] }] }],
    });

    const res = await dispatchTool("genome_reload", {}, deps);
    expect(res.ok).toBe(true);
    const data = res.data as { reloaded: boolean; changes: { added: any; modified: any; removed: any }; load_errors: unknown[] };

    expect(data.reloaded).toBe(true);
    expect(data.changes.added.standards).toContain("summarize");
    expect(data.changes.added.domain_types).toContain("summary");
    expect(data.changes.added.agents).toContain("summarizer");

    expect(deps.standards?.has("summarize")).toBe(true);
    const types = deps.registry.listTypes().map((t) => t.slug);
    expect(types).toContain("summary");
    expect(types).toContain("raw-note");

    expect(data.load_errors).toEqual([]);
  });

  it("modifying a domain type on disk + reload reflects in registry validation", async () => {
    writeJson(join(root, "domain_types"), "raw-note.json", {
      slug: "raw-note",
      version: 1,
      extends: "Signal",
      domain: "demo",
      status: "active",
      schema: { type: "object", properties: { text: { type: "string" }, source: { type: "string" } } },
      required_fields: ["text", "source"],
    });

    const res = await dispatchTool("genome_reload", {}, deps);
    const data = res.data as { changes: { added: any; modified: any; removed: any } };
    expect(data.changes.modified.domain_types).toContain("raw-note");

    // Type now requires "source" — validating without it should fail
    const validation = deps.registry.validate({
      core_type: "Signal",
      domain_type: "raw-note",
      data: { text: "hi" },
    });
    expect(validation.valid).toBe(false);
  });

  it("removing a file on disk + reload reports the removal and drops from deps", async () => {
    rmSync(join(root, "agents", "scout.json"));

    const res = await dispatchTool("genome_reload", {}, deps);
    const data = res.data as { changes: { added: any; modified: any; removed: any } };
    expect(data.changes.removed.agents).toContain("scout");
  });

  it("reload surfaces load_errors from the new genome", async () => {
    writeJson(join(root, "standards"), "broken.json", {
      slug: "broken",
      domain: "demo",
      agent_slugs: ["ghost"],
      phases: [{ name: "x", chairs: [{ role: "x", agent_slug: "ghost", depends_on: [], input_contract: [], output_contract: ["Interpretation"], required_skills: [] }] }],
    });

    const res = await dispatchTool("genome_reload", {}, deps);
    const data = res.data as { load_errors: Array<{ kind: string; slug: string | null; error: string }> };
    expect(data.load_errors.length).toBeGreaterThanOrEqual(1);
    const err = data.load_errors.find((e) => e.slug === "broken");
    expect(err).toBeDefined();
    expect(err!.kind).toBe("standard");
  });

  it("system_health surfaces load_errors so operators see what's broken", async () => {
    writeJson(join(root, "standards"), "broken.json", {
      slug: "broken",
      domain: "demo",
      agent_slugs: ["ghost"],
      phases: [{ name: "x", chairs: [{ role: "x", agent_slug: "ghost", depends_on: [], input_contract: [], output_contract: ["Interpretation"], required_skills: [] }] }],
    });
    await dispatchTool("genome_reload", {}, deps);
    const res = await dispatchTool("system_health", {}, deps);
    const data = res.data as { load_errors?: unknown[] };
    expect(Array.isArray(data.load_errors)).toBe(true);
    expect((data.load_errors as unknown[]).length).toBeGreaterThanOrEqual(1);
  });

  it("genome_reload without genome_dir returns ok=false (honest gap)", async () => {
    const noGenomeDeps: ServerDeps = { ...deps };
    delete (noGenomeDeps as { genome_dir?: string }).genome_dir;
    const res = await dispatchTool("genome_reload", {}, noGenomeDeps);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/genome_dir/);
  });
});
