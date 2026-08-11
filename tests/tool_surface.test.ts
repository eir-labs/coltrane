// createToolSurface — the engine's FULL MCP tool surface as a deps-injected, transport-
// agnostic registry. Governor ruling: there is no different thing — the hosted Coltrane MCP
// is the Coltrane MCP. A host (a Next.js route, the stdio entry, a test harness) mounts the
// same registry; hosted mode (deps.hosted) turns inherently local-process tools into honest
// typed errors instead of silently spawning or reading a filesystem that isn't there.
//
// RED-first: written against an engine with no createToolSurface export.
import { describe, it, expect, vi } from "vitest";
import { createToolSurface, dispatchTool, type ToolSurfaceDeps } from "../src/server.js";
import { MCP_TOOLS } from "../src/mcp.js";
import { createRegistry } from "../src/registry.js";
import { createOutputStore } from "../src/outputs.js";
import { MemoryLedger } from "../src/ledger.js";

function bareDeps(extra?: Partial<ToolSurfaceDeps>): ToolSurfaceDeps {
  const registry = createRegistry();
  return { registry, outputs: createOutputStore(registry), ledger: new MemoryLedger(), ...extra };
}

const VALID_AGENT = {
  slug: "scout", primitives: ["SENSE"], input_types: [], output_types: ["scan-report"],
  domain: "demo", identity: "you are scout", method: "1. look 2. report 3. stop",
  constraints: [], behavioral_primitives: ["explorer", "critic"],
};

describe("the surface is the FULL engine surface", () => {
  it("exposes every MCP tool, with the same generated input_schema", () => {
    const surface = createToolSurface(bareDeps());
    expect(surface.map((t) => t.name).sort()).toEqual(MCP_TOOLS.map((t) => t.slug).slice().sort());
    for (const t of surface) {
      const def = MCP_TOOLS.find((d) => d.slug === t.name)!;
      expect(t.input_schema).toBe(def.input_schema); // the same object — no hand-copied schema
      expect(t.description.length).toBeGreaterThan(0);
    }
  });

  it("call() routes to the real dispatcher — identical result to dispatchTool", async () => {
    const deps = bareDeps();
    const surface = createToolSurface(deps);
    const viaSurface = await surface.find((t) => t.name === "system_audit")!.call({});
    const direct = await dispatchTool("system_audit", {}, deps);
    expect(viaSurface).toEqual(direct);
  });
});

describe("hosted mode — local-process tools fail honestly, nothing spawns", () => {
  const HOSTED_BLOCKED = ["server_restart", "skill_execute", "skill_evolve", "charter_read", "gig_logs", "genome_reload"];

  it("blocked tools still EXIST and return a typed hosted error", async () => {
    const surface = createToolSurface(bareDeps({ hosted: true }));
    for (const name of HOSTED_BLOCKED) {
      const tool = surface.find((t) => t.name === name);
      expect(tool, `${name} must stay in the surface`).toBeDefined();
      const res = await tool!.call({});
      expect(res.ok, name).toBe(false);
      expect(res.hosted_unsupported, name).toBe(true);
      expect(res.error, name).toBeTruthy();
    }
  });

  it("gig_dispatch without a queue seam is a typed error naming the queue RPC — it never spawns", async () => {
    const surface = createToolSurface(bareDeps({ hosted: true }));
    const res = await surface.find((t) => t.name === "gig_dispatch")!.call({ standard_slug: "scan-v1", input: {} });
    expect(res.ok).toBe(false);
    expect(res.hosted_unsupported).toBe(true);
    expect(res.error).toMatch(/queue|coltrane_gig_dispatch/i);
  });

  it("gig_dispatch with a queueGig seam queues through it", async () => {
    const queueGig = vi.fn(async () => ({ gig_id: "gig-1", status: "queued" }));
    const surface = createToolSurface(bareDeps({ hosted: true, queueGig }));
    const res = await surface.find((t) => t.name === "gig_dispatch")!.call({ standard_slug: "scan-v1", input: { a: 1 } });
    expect(queueGig).toHaveBeenCalledWith({ standard_slug: "scan-v1", input: { a: 1 } });
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ gig_id: "gig-1", status: "queued" });
  });

  it("a failed queue is a failed dispatch — the error surfaces", async () => {
    const queueGig = vi.fn(async () => { throw new Error("not on the may_dispatch list"); });
    const surface = createToolSurface(bareDeps({ hosted: true, queueGig }));
    const res = await surface.find((t) => t.name === "gig_dispatch")!.call({ standard_slug: "scan-v1", input: {} });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/may_dispatch/);
  });

  // ── gig_approve — the member approval act over MCP (engine seam, store authorizes) ──────────
  it("gig_approve is in the surface", () => {
    const surface = createToolSurface(bareDeps());
    expect(surface.find((t) => t.name === "gig_approve"), "gig_approve must be a mounted tool").toBeDefined();
    expect(MCP_TOOLS.find((t) => t.slug === "gig_approve")?.category).toBe("run");
  });

  it("gig_approve without an approve seam is a typed hosted error naming the member RPC", async () => {
    const surface = createToolSurface(bareDeps({ hosted: true }));
    const res = await surface.find((t) => t.name === "gig_approve")!.call({ gig_id: "gig-9", role: "approver", verdict: { criteria: ["ok"] } });
    expect(res.ok).toBe(false);
    expect(res.hosted_unsupported).toBe(true);
    expect(res.error).toMatch(/approve|coltrane_gig_approve|member/i);
  });

  it("gig_approve with a deps.approveGig seam routes through it and returns its result", async () => {
    const approveGig = vi.fn(async () => ({ gig_id: "gig-9", role: "approver", status: "approved", approved: true }));
    const surface = createToolSurface(bareDeps({ hosted: true, approveGig }));
    const verdict = { criteria: ["meets the bar"] };
    const res = await surface.find((t) => t.name === "gig_approve")!.call({ gig_id: "gig-9", role: "approver", verdict });
    expect(approveGig).toHaveBeenCalledWith({ gig_id: "gig-9", role: "approver", verdict });
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ gig_id: "gig-9", role: "approver", status: "approved", approved: true });
  });

  it("a failed approve surfaces the store's refusal (e.g. an agent token is not a member)", async () => {
    const approveGig = vi.fn(async () => { throw new Error("approval requires a member JWT"); });
    const surface = createToolSurface(bareDeps({ hosted: true, approveGig }));
    const res = await surface.find((t) => t.name === "gig_approve")!.call({ gig_id: "gig-9", role: "approver", verdict: {} });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/member JWT/);
  });

  it("non-hosted gig_approve is a typed no-op pointing at gig_dispatch's approvals", async () => {
    const surface = createToolSurface(bareDeps()); // not hosted → reaches dispatchTool
    const res = await surface.find((t) => t.name === "gig_approve")!.call({ gig_id: "gig-9", role: "approver", verdict: { criteria: ["ok"] } });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/approvals|hosted member seam/i);
  });

  it("hosted genome mutations persist through the injected GenomeStore, not the filesystem", async () => {
    const upsert = vi.fn(async () => undefined);
    const store = { load: vi.fn(), upsert } as unknown as NonNullable<ToolSurfaceDeps["store"]>;
    const surface = createToolSurface(bareDeps({ hosted: true, store }));
    const res = await surface.find((t) => t.name === "agent_define")!.call(VALID_AGENT);
    expect(res.ok).toBe(true);
    expect(upsert).toHaveBeenCalledTimes(1);
    const [cls, payload] = upsert.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(cls).toBe("agent");
    expect(payload["slug"]).toBe("scout");
  });

  it("a refused store upsert fails the mutation loudly", async () => {
    const upsert = vi.fn(async () => { throw new Error("not a governor"); });
    const store = { load: vi.fn(), upsert } as unknown as NonNullable<ToolSurfaceDeps["store"]>;
    const surface = createToolSurface(bareDeps({ hosted: true, store }));
    const res = await surface.find((t) => t.name === "agent_define")!.call(VALID_AGENT);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not a governor/);
  });
});

describe("non-hosted mode is byte-identical to the old dispatch path", () => {
  it("server_restart keeps its relay-misconfiguration error (not a hosted error)", async () => {
    const surface = createToolSurface(bareDeps());
    const res = await surface.find((t) => t.name === "server_restart")!.call({});
    expect(res.ok).toBe(false);
    expect(res.hosted_unsupported).toBeUndefined();
    expect(res.error).toMatch(/relay/);
  });

  it("agent_define with no store persists nothing extra and stays a validation-path success", async () => {
    const surface = createToolSurface(bareDeps());
    const res = await surface.find((t) => t.name === "agent_define")!.call(VALID_AGENT);
    expect(res.ok).toBe(true);
  });
});

describe("hosted authoring — no org rides the call; evolve works store-backed", () => {
  const VALID_AGENT2 = { ...VALID_AGENT, slug: "scout2" };

  it("agent_define upserts with NO org argument — the store resolves the working org", async () => {
    const upserts: Array<{ cls: string; payload: Record<string, unknown>; org?: string }> = [];
    const deps = bareDeps({
      hosted: true,
      store: {
        load: async () => { throw new Error("unused"); },
        upsert: async (cls: string, payload: Record<string, unknown>, org_slug?: string) => {
          upserts.push({ cls, payload, ...(org_slug ? { org: org_slug } : {}) });
        },
      } as never,
    });
    const surface = createToolSurface(deps);
    const r = await surface.find((t) => t.name === "agent_define")!.call({ ...VALID_AGENT2 });
    expect(r.ok).toBe(true);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.cls).toBe("agent");
    // the caller never tracks the org: nothing rides the call; the store's resolver
    // (org_use preference > sole membership) supplies it
    expect(upserts[0]!.org).toBeUndefined();
    expect(upserts[0]!.payload["org_slug"]).toBeUndefined();
  });

  it("agent_evolve (slug, changes) works hosted from the agents map and upserts the merged def", async () => {
    const upserts: Array<{ cls: string; payload: Record<string, unknown>; org?: string }> = [];
    const { defineAgent } = await import("../src/composition.js");
    const deps = bareDeps({
      hosted: true,
      agents: new Map([["scout", defineAgent(VALID_AGENT as never)]]),
      store: {
        load: async () => { throw new Error("unused"); },
        upsert: async (cls: string, payload: Record<string, unknown>, org_slug?: string) => {
          upserts.push({ cls, payload, ...(org_slug ? { org: org_slug } : {}) });
        },
      } as never,
    });
    const surface = createToolSurface(deps);
    const r = await surface.find((t) => t.name === "agent_evolve")!.call(
      { slug: "scout", changes: { output_types: ["scan-report", "design-brief"] }, reason: "seat widening" },
    );
    expect(r.ok, String(r.error)).toBe(true);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.cls).toBe("agent");
    expect(upserts[0]!.org).toBeUndefined();
    expect(upserts[0]!.payload["slug"]).toBe("scout");
    expect(upserts[0]!.payload["output_types"]).toEqual(["scan-report", "design-brief"]);
  });
});


describe("org_use — the formal switch, set once", () => {
  it("wires through deps.orgUse and reports what it set", async () => {
    const calls: string[] = [];
    const deps = bareDeps({ hosted: true, orgUse: async (slug: string) => { calls.push(slug); return slug; } });
    const surface = createToolSurface(deps);
    const r = await surface.find((t) => t.name === "org_use")!.call({ org_slug: "eugene-studio" });
    expect(r.ok).toBe(true);
    expect((r.data as { org_slug: string }).org_slug).toBe("eugene-studio");
    expect(calls).toEqual(["eugene-studio"]);
  });

  it("on a file genome, says plainly that the working tree IS the org", async () => {
    const r = await createToolSurface(bareDeps()).find((t) => t.name === "org_use")!.call({ org_slug: "x" });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/file genome/);
  });
});
