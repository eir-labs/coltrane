// Discoverability parity — every genome class you can AUTHOR over MCP, you can LIST over MCP.
//
// The gap this closes (found live, first hosted deploy): the registry had standard_compose /
// standard_simulate / standard_promote and NOTHING to list standards; agents likewise — the
// only agent read was charter_read, which reads a FILE PATH and is hosted_unsupported. The
// registry grew up in a working tree where `ls standards/` was free, so browse tools were only
// minted where file reads were awkward (types, skills). Mount the same registry on a host with
// no filesystem and the local assumption becomes a hole with no error message: a caller cannot
// discover a slug to dispatch. Compose-without-browse passed every suite because suites only
// check the tools that exist — this test states the invariant so absence itself goes red.
//
// RED-first: written against an engine with no agent_browse / standard_browse.
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

const standard = (slug: string, over?: Partial<Standard>): Standard =>
  ({
    slug, domain: "demo", status: "active",
    agents: [agent(`${slug}-scout`)],
    phases: [{ name: "scan", chairs: [{ role: "scout", agent_slug: `${slug}-scout`, depends_on: [], input_contract: [], output_contract: ["scan-report"], optional_outputs: [], required_skills: [] }] }],
    output_types: ["scan-report"],
    ...over,
  }) as unknown as Standard;

describe("discoverability parity — authoring tool implies browse tool", () => {
  // class → [authoring tool that proves the class is MCP-authorable, browse tool owed for it]
  const PARITY: Array<[string, string, string]> = [
    ["types", "type_register", "type_browse"],
    ["skills", "skill_define", "skill_browse"],
    ["agents", "agent_define", "agent_browse"],
    ["standards", "standard_compose", "standard_browse"],
    // The chart and the venue join the table the moment they become authorable: 0.7.0 shipped
    // ChartSchema with no MCP surface at all, which kept the invariant vacuously true. A class
    // that can be authored and not listed is a slug no caller can discover.
    ["charts", "chart_define", "chart_browse"],
    ["venues", "venue_define", "venue_browse"],
  ];

  it("every authorable genome class has a browse tool in the registry", () => {
    const slugs = new Set(MCP_TOOLS.map((t) => t.slug));
    for (const [cls, author, browse] of PARITY) {
      expect(slugs.has(author), `${cls}: ${author} must exist (test premise)`).toBe(true);
      expect(slugs.has(browse), `${cls}: authorable over MCP but not listable — ${browse} missing`).toBe(true);
    }
  });

  it("browse tools are understand-category free reads", () => {
    for (const [, , browse] of PARITY) {
      const def = MCP_TOOLS.find((t) => t.slug === browse);
      expect(def?.category, browse).toBe("understand");
    }
  });
});

describe("standard_browse — lists what a gig can be", () => {
  const deps = () =>
    bareDeps({
      standards: new Map<string, Standard>([
        ["summarize", standard("summarize")],
        ["deep-audit", standard("deep-audit", { domain: "audit", status: "deprecated" } as Partial<Standard>)],
      ]),
    });

  it("lists every standard with the fields a dispatcher needs", async () => {
    const surface = createToolSurface(deps());
    const res = await surface.find((t) => t.name === "standard_browse")!.call({});
    expect(res.ok).toBe(true);
    const data = res.data as { standards: Array<Record<string, unknown>>; count: number };
    expect(data.count).toBe(2);
    expect(data.standards.map((s) => s["slug"])).toEqual(["deep-audit", "summarize"]);
    const summarize = data.standards.find((s) => s["slug"] === "summarize")!;
    expect(summarize["domain"]).toBe("demo");
    expect(summarize["status"]).toBe("active");
    expect(summarize["phases"]).toEqual(["scan"]);
    expect(summarize["phase_count"]).toBe(1);
    expect(summarize["chair_count"]).toBe(1);
    expect(summarize["output_types"]).toEqual(["scan-report"]);
  });

  it("filters by domain and status", async () => {
    const surface = createToolSurface(deps());
    const tool = surface.find((t) => t.name === "standard_browse")!;
    const byDomain = await tool.call({ domain: "audit" });
    expect((byDomain.data as { count: number }).count).toBe(1);
    const byStatus = await tool.call({ status: "active" });
    const rows = (byStatus.data as { standards: Array<{ slug: string }> }).standards;
    expect(rows.map((s) => s.slug)).toEqual(["summarize"]);
  });

  it("without a standards map, says what bootstrap it needs (not a crash)", async () => {
    const surface = createToolSurface(bareDeps());
    const res = await surface.find((t) => t.name === "standard_browse")!.call({});
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/standards map/);
  });

  it("works hosted — this is the tool the hosted gap was about", async () => {
    const surface = createToolSurface(bareDeps({ hosted: true, standards: new Map([["summarize", standard("summarize")]]) }));
    const res = await surface.find((t) => t.name === "standard_browse")!.call({});
    expect(res.ok).toBe(true);
    expect(res.hosted_unsupported).toBeUndefined();
  });
});

describe("agent_browse — the seatable players, without a filesystem", () => {
  const deps = () =>
    bareDeps({
      agents: new Map<string, Agent>([
        ["scout", agent("scout")],
        ["judge", agent("judge", { primitives: ["JUDGE"], domain: null, skill_slugs: ["diamond-cutting"] } as Partial<Agent>)],
      ]),
    });

  it("lists every agent with seat-relevant fields", async () => {
    const surface = createToolSurface(deps());
    const res = await surface.find((t) => t.name === "agent_browse")!.call({});
    expect(res.ok).toBe(true);
    const data = res.data as { agents: Array<Record<string, unknown>>; count: number };
    expect(data.count).toBe(2);
    expect(data.agents.map((a) => a["slug"])).toEqual(["judge", "scout"]);
    const judge = data.agents.find((a) => a["slug"] === "judge")!;
    expect(judge["primitives"]).toEqual(["JUDGE"]);
    expect(judge["domain"]).toBeNull();
    expect(judge["skill_slugs"]).toEqual(["diamond-cutting"]);
    expect(judge["behavioral_primitives"]).toEqual(["explorer", "critic"]);
  });

  it("filters by domain and primitive", async () => {
    const surface = createToolSurface(deps());
    const tool = surface.find((t) => t.name === "agent_browse")!;
    const byDomain = await tool.call({ domain: "demo" });
    expect((byDomain.data as { agents: Array<{ slug: string }> }).agents.map((a) => a.slug)).toEqual(["scout"]);
    const byPrimitive = await tool.call({ primitive: "JUDGE" });
    expect((byPrimitive.data as { agents: Array<{ slug: string }> }).agents.map((a) => a.slug)).toEqual(["judge"]);
  });

  it("works hosted", async () => {
    const surface = createToolSurface(bareDeps({ hosted: true, agents: new Map([["scout", agent("scout")]]) }));
    const res = await surface.find((t) => t.name === "agent_browse")!.call({});
    expect(res.ok).toBe(true);
    expect(res.hosted_unsupported).toBeUndefined();
  });
});
