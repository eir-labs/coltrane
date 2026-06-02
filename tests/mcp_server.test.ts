// MCP server dispatcher — the stdio entry wires MCP_TOOLS → dispatchTool → store/registry.
// Tests the pure (async) dispatcher: routing, the context-free wired tools, honest
// not_implemented for tools needing unbuilt deps, approval surfacing, unknown-slug.
import { describe, it, expect } from "vitest";
import {
  dispatchTool,
  createColtraneServer,
  createRegistry,
  createOutputStore,
  MemoryLedger,
  MCP_TOOLS,
  type ServerDeps,
  type DomainType,
} from "../src";

function deps(): ServerDeps {
  const registry = createRegistry();
  return { registry, outputs: createOutputStore(registry), ledger: new MemoryLedger() };
}

const findingType: DomainType = {
  slug: "finding",
  extends: "Verdict",
  domain: "eirtests",
  schema: { properties: { title: { type: "string" } } },
  required_fields: ["title"],
};

describe("MCP dispatcher: routing", () => {
  it("rejects an unknown tool slug", async () => {
    const r = await dispatchTool("not_a_tool", {}, deps());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unknown tool/);
  });

  it("every tool dispatches to a defined result (ok or honest not_implemented), never a throw", async () => {
    const d = deps();
    for (const t of MCP_TOOLS) {
      const r = await dispatchTool(t.slug, {}, d);
      expect(typeof r.ok).toBe("boolean");
      if (!r.ok) expect(r.error).toBeTruthy();
    }
  });
});

describe("MCP dispatcher: context-free tools are wired", () => {
  it("type_register registers a domain type", async () => {
    const d = deps();
    const r = await dispatchTool("type_register", { ...findingType, reason: "seed" }, d);
    expect(r.ok).toBe(true);
    expect(d.registry.listTypes().map((t) => t.slug)).toContain("finding");
  });

  it("type_resolve returns a resolution action", async () => {
    const d = deps();
    await dispatchTool("type_register", { ...findingType, reason: "seed" }, d);
    const r = await dispatchTool("type_resolve", { core_type: "Verdict", domain: "eirtests", required_fields: ["title"] }, d);
    expect(r.ok).toBe(true);
    expect((r.data as { action: string }).action).toBeTruthy();
  });

  it("type_browse lists registered types, filterable by domain", async () => {
    const d = deps();
    await dispatchTool("type_register", { ...findingType, reason: "seed" }, d);
    const r = await dispatchTool("type_browse", { domain: "eirtests" }, d);
    expect(r.ok).toBe(true);
    expect((r.data as { types: unknown[] }).types.length).toBe(1);
  });

  it("standard_simulate returns an estimate", async () => {
    const r = await dispatchTool("standard_simulate", { standard_slug: "readiness-scan", mock_input: {}, depth: "standard" }, deps());
    expect(r.ok).toBe(true);
  });
});

describe("MCP dispatcher: honest gaps + approval", () => {
  it("the once-stubbed tools are now wired — never not_implemented (regression guard)", async () => {
    // these were honest gaps; all are wired against real in-repo impl now. a bare
    // {} call may fail validation honestly, but it must NOT report not_implemented.
    for (const slug of ["output_write", "agent_define", "gig_abort", "execution_history_read", "agent_evolve", "access_grant_check", "system_audit", "system_health", "health_check", "capability_research", "proposal_create", "tool_propose", "tool_deprecate_propose"]) {
      const r = await dispatchTool(slug, {}, deps());
      expect(r.not_implemented).toBeFalsy();
    }
  });

  it("gig_dispatch is not_implemented on a bare server (no standards/invoke wired)", async () => {
    const r = await dispatchTool("gig_dispatch", { standard_slug: "x" }, deps());
    expect(r.ok).toBe(false);
    expect(r.not_implemented).toBe(true);
  });

  it("surfaces approval requirement on always-approval tools", async () => {
    const r = await dispatchTool("tool_propose", { slug: "x", type: "mcp", spec: {}, reason: "y" }, deps());
    expect(r.requires_approval).toBe(true);
  });

  it("type_register surfaces no approval for an additive change", async () => {
    const r = await dispatchTool("type_register", { ...findingType, change_class: "additive", reason: "seed" }, deps());
    expect(r.requires_approval).toBe(false);
  });
});

describe("MCP server: construction", () => {
  it("builds a server without connecting a transport", () => {
    const server = createColtraneServer(deps());
    expect(server).toBeDefined();
  });
});

describe("MCP dispatcher: newly-wired tools (impl existed, now routed)", () => {
  const scout = { slug: "scout", primitives: ["SENSE"], input_types: [], output_types: ["page-model"], domain: "eirtests" };
  const analyst = { slug: "analyst", primitives: ["INTERPRET"], input_types: ["page-model"], output_types: ["finding"], domain: "eirtests" };
  const goodPhases = [{ name: "p1", agent: "scout" }, { name: "p2", agent: "analyst" }];

  it("tool_registry_browse lists tools, filterable by category", async () => {
    const all = await dispatchTool("tool_registry_browse", {}, deps());
    expect(all.ok).toBe(true);
    const run = await dispatchTool("tool_registry_browse", { category: "run" }, deps());
    const tools = (run.data as { tools: { category: string }[] }).tools;
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every((t) => t.category === "run")).toBe(true);
  });

  it("standard_compose composes a valid standard", async () => {
    const r = await dispatchTool("standard_compose", { slug: "scan", domain: "eirtests", agents: [scout, analyst], phases: goodPhases }, deps());
    expect(r.ok).toBe(true);
    expect((r.data as { standard_id: string }).standard_id).toBe("scan");
  });

  it("standard_compose rejects a phase referencing an undefined agent", async () => {
    const r = await dispatchTool("standard_compose", { slug: "scan", domain: "eirtests", agents: [scout], phases: [{ name: "p", agent: "ghost" }] }, deps());
    expect(r.ok).toBe(false);
    expect((r.data as { validation_result: { valid: boolean } }).validation_result.valid).toBe(false);
  });

  it("agent_validate_pipeline returns valid for a sound pipeline, illegal_progressions for a broken one", async () => {
    const ok = await dispatchTool("agent_validate_pipeline", { domain: "eirtests", agents: [scout, analyst], phases: goodPhases }, deps());
    expect((ok.data as { valid: boolean }).valid).toBe(true);
    const bad = await dispatchTool("agent_validate_pipeline", { domain: "eirtests", agents: [scout], phases: [{ name: "p", agent: "ghost" }] }, deps());
    expect((bad.data as { valid: boolean }).valid).toBe(false);
    expect((bad.data as { illegal_progressions: string[] }).illegal_progressions.length).toBeGreaterThan(0);
  });

  it("type_extend proposes an additive change off a registered type", async () => {
    const d = deps();
    await dispatchTool("type_register", { slug: "finding", extends: "Verdict", domain: "eirtests", schema: { properties: { title: { type: "string" } } }, required_fields: ["title"], reason: "seed" }, d);
    const r = await dispatchTool("type_extend", { slug: "finding", domain: "eirtests", fields_to_add: { evidence: { type: "string" } }, reason: "richer" }, d);
    expect(r.ok).toBe(true);
    expect((r.data as { change_class: string }).change_class).toBe("additive");
    expect((r.data as { new_version: number }).new_version).toBe(2);
  });

  it("type_extend rejects an unknown base type", async () => {
    const r = await dispatchTool("type_extend", { slug: "ghost-type", domain: "eirtests", fields_to_add: {} }, deps());
    expect(r.ok).toBe(false);
  });
});
