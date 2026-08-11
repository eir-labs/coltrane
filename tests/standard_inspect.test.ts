// standard_inspect — the single-record read for a standard.
//
// There was skill_inspect but no standard_inspect, so no MCP path to one standard's full record;
// standard_browse lists shallow rows only. This adds the missing read (mirroring skill_inspect)
// and confirms browse now carries `description` (a sibling thread saw it read back null).
//
// RED-first: written against an engine whose registry has no standard_inspect tool at all.
import { describe, it, expect } from "vitest";
import { createToolSurface, type ToolSurfaceDeps } from "../src/server.js";
import { MCP_TOOLS } from "../src/mcp.js";
import { createRegistry } from "../src/registry.js";
import { createOutputStore } from "../src/outputs.js";
import { MemoryLedger } from "../src/ledger.js";
import type { Agent, Standard } from "../src/composition.js";

function bareDeps(extra?: Partial<ToolSurfaceDeps>): ToolSurfaceDeps {
  const registry = createRegistry();
  return { registry, outputs: createOutputStore(registry), ledger: new MemoryLedger(), ...extra };
}

const agent = (slug: string, over?: Partial<Agent>): Agent =>
  ({
    slug, primitives: ["SENSE"], input_types: [], output_types: ["scan-report"],
    domain: "demo", identity: `you are ${slug}`, method: "1. look 2. report 3. stop",
    constraints: [], behavioral_primitives: ["explorer", "critic"], ...over,
  }) as unknown as Agent;

// Two phases: an agent chair that feeds a HUMAN approval chair — so inspect must project both seat
// shapes (agent_slug present / human true) and the contracts between them.
const summarize = (): Standard =>
  ({
    slug: "summarize", domain: "demo", status: "active",
    agents: [agent("summarize-scout")],
    phases: [
      { name: "scan", chairs: [{ role: "scout", agent_slug: "summarize-scout", depends_on: [], input_contract: [], output_contract: ["scan-report"], optional_outputs: [], required_skills: [] }] },
      { name: "sign-off", chairs: [{ role: "approver", human: true, depends_on: ["scout"], input_contract: ["scan-report"], output_contract: ["approval"], optional_outputs: [], required_skills: [] }] },
    ],
    input_types: ["brief"], output_types: ["scan-report", "approval"],
    eval_slugs: ["coverage-check"],
    description: "condense a brief, then a human signs off",
  }) as unknown as Standard;

const deps = () => bareDeps({ standards: new Map<string, Standard>([["summarize", summarize()]]) });

describe("standard_inspect — one standard's full record", () => {
  it("is registered as an understand-category tool advertising slug", () => {
    const def = MCP_TOOLS.find((t) => t.slug === "standard_inspect");
    expect(def, "standard_inspect must exist in the registry").toBeDefined();
    expect(def!.category).toBe("understand");
    expect(Object.keys((def!.input_schema as { properties: object }).properties)).toContain("slug");
  });

  it("returns the full record: phases with seat detail, type surface, evals, description", async () => {
    const surface = createToolSurface(deps());
    const res = await surface.find((t) => t.name === "standard_inspect")!.call({ slug: "summarize" });
    expect(res.ok).toBe(true);
    const d = res.data as {
      slug: string; domain: string; status: string; description: string | null;
      input_types: string[]; output_types: string[]; eval_slugs: string[];
      phases: Array<{ name: string; chairs: Array<Record<string, unknown>> }>;
    };
    expect(d.slug).toBe("summarize");
    expect(d.domain).toBe("demo");
    expect(d.status).toBe("active");
    expect(d.description).toBe("condense a brief, then a human signs off");
    expect(d.input_types).toEqual(["brief"]);
    expect(d.output_types).toEqual(["scan-report", "approval"]);
    expect(d.eval_slugs).toEqual(["coverage-check"]);
    // Phase + seat shape.
    expect(d.phases.map((p) => p.name)).toEqual(["scan", "sign-off"]);
    const scout = d.phases[0]!.chairs[0]!;
    expect(scout["role"]).toBe("scout");
    expect(scout["agent_slug"]).toBe("summarize-scout");
    expect(scout["human"]).toBe(false);
    expect(scout["output_contract"]).toEqual(["scan-report"]);
    const approver = d.phases[1]!.chairs[0]!;
    expect(approver["role"]).toBe("approver");
    expect(approver["human"]).toBe(true);
    expect(approver["agent_slug"]).toBeNull();
    expect(approver["input_contract"]).toEqual(["scan-report"]);
  });

  it("an unknown slug is an honest error, not a silent null", async () => {
    const surface = createToolSurface(deps());
    const res = await surface.find((t) => t.name === "standard_inspect")!.call({ slug: "nope" });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/unknown standard/);
  });

  it("without a standards map, says what bootstrap it needs (mirrors the browse handlers)", async () => {
    const surface = createToolSurface(bareDeps());
    const res = await surface.find((t) => t.name === "standard_inspect")!.call({ slug: "summarize" });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/standards map/);
  });

  it("standard_browse now carries description (the null-readback gap)", async () => {
    const surface = createToolSurface(deps());
    const res = await surface.find((t) => t.name === "standard_browse")!.call({});
    const rows = (res.data as { standards: Array<Record<string, unknown>> }).standards;
    const row = rows.find((s) => s["slug"] === "summarize")!;
    expect(row["description"]).toBe("condense a brief, then a human signs off");
    expect(row["eval_slugs"]).toEqual(["coverage-check"]);
  });
});
