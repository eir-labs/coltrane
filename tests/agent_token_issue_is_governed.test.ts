// agent_token_issue — the verb that issues a STANDING agent token (ctk_) to an agent seated in an
// organization: the credential a reconciler holds BETWEEN sittings.
//
// WHY THE VERB EXISTS (3 Oct 2026, spec.order-lifecycle.transition-law R23). The transition law's
// force guard reads `chancery_work_order_reconciler_can_act`: seated, granted dispatch of the
// reconcile standard, holding a live token. Measured on the store, every token the reconciler had
// ever held was a `gig-token-<gig>` row — minted by the claim door for ONE sitting, revoked at
// release — and no verb issued a standing one. So the guard asked for a credential no door could
// issue, and the first force naming the reconciler was impossible by any lawful path. The store's
// mint (`coltrane_issue_agent_token`) already exists and gates on an authenticated HUMAN MEMBER;
// what was missing was the verb. This is its engine half, in the shape of org_hire and
// venue_credential_mint: the engine ships the schema and its refusals, a deployment wires the
// backend (deps.issueAgentToken).
//
// WHAT THE ENGINE DECIDES, AND WHAT IT DOES NOT. Who may issue is the store's question (auth.uid(),
// membership, the agent's naming) — the engine never answers it. The engine decides three
// structural facts before any backend is reached: an agent token may not issue an agent token
// (escalation: a one-sitting credential minting a standing one); a TTL the store cannot express is
// refused rather than rounded (the store takes INTEGER HOURS; rounding 15 minutes up to an hour
// quadruples the exposure silently — Envoy's issuer refuses the same way); and the token is
// returned ONCE, never read back, never sealed to the ledger (the store holds its hash and who
// issued it).
import { describe, it, expect, vi } from "vitest";
import { createToolSurface, type ToolSurfaceDeps, type SurfaceToolResult } from "../src/server.js";
import { MCP_TOOLS } from "../src/mcp.js";
import { createRegistry } from "../src/registry.js";
import { createOutputStore } from "../src/outputs.js";
import { MemoryLedger } from "../src/ledger.js";

const MODULE = "../src/agent_token.js";
interface AgentTokenModule {
  AGENT_TOKEN_REFUSALS: readonly string[];
  ttlHoursOrRefusal(raw: unknown): { ttl_hours: number } | { refusal: "bad_ttl"; error: string };
}
const agentTokenModule = async (): Promise<AgentTokenModule> =>
  (await import(MODULE)) as unknown as AgentTokenModule;

function surfaceDeps(extra?: Record<string, unknown>): ToolSurfaceDeps {
  const registry = createRegistry();
  const base = { registry, outputs: createOutputStore(registry), ledger: new MemoryLedger() };
  return { ...base, ...(extra ?? {}) } as ToolSurfaceDeps;
}
function issueTool(deps: ToolSurfaceDeps) {
  return createToolSurface(deps).find((t) => t.name === "agent_token_issue");
}
const props = (schema: object): Record<string, unknown> =>
  ((schema as { properties?: Record<string, unknown> }).properties ?? {});

type IssueArgs = { org_slug: string; agent_slug: string; may_dispatch: string[]; ttl_hours: number };
const okIssue = () =>
  vi.fn(async (a: IssueArgs) => ({
    ok: true as const,
    key_id: `agent-token-${a.org_slug}-${a.agent_slug}-20261003000000`,
    expires_at: "2026-10-06T00:00:00.000Z",
    agent_token: "ctk_" + "0".repeat(48),
  }));
const codeIssue = (code: "not_a_member" | "not_named") =>
  vi.fn(async (_a: IssueArgs) => ({ ok: false as const, code }));

const ORG = "example-org";
const AGENT = "example-reconciler";

describe("agent_token_issue — a governed verb that issues a STANDING token to a seated agent", () => {
  it("INV-1 · agent_token_issue is on the engine's tool surface", () => {
    expect(MCP_TOOLS.find((t) => t.slug === "agent_token_issue"), "in MCP_TOOLS — the surface every transport mounts").toBeDefined();
    expect(issueTool(surfaceDeps()), "and therefore in createToolSurface").toBeDefined();
  });

  it("INV-2 · its input schema is exactly {org_slug, agent_slug, may_dispatch, ttl_hours} — the store's mint, no more", () => {
    const def = MCP_TOOLS.find((t) => t.slug === "agent_token_issue")!;
    expect(Object.keys(props(def.input_schema)).sort()).toEqual(["agent_slug", "may_dispatch", "org_slug", "ttl_hours"]);
    for (const forbidden of ["caps", "chair", "chair_id", "standards", "grant", "scopes"]) {
      expect(props(def.input_schema), `no capability travels on the mint: ${forbidden}`).not.toHaveProperty(forbidden);
    }
  });

  it("INV-3 · the refusal vocabulary is closed and named", async () => {
    const m = await agentTokenModule();
    expect([...m.AGENT_TOKEN_REFUSALS].sort()).toEqual(["bad_ttl", "no_backend", "not_a_human_member"]);
  });

  it("INV-4 · an agent token may not issue an agent token — gig, player, venue and absent callers are refused before any backend", async () => {
    for (const caller of [{ kind: "gig" as const, gig_id: "g1" }, { kind: "player" as const }, { kind: "venue" as const }, undefined]) {
      const backend = okIssue();
      const tool = issueTool(surfaceDeps({ caller, issueAgentToken: backend }));
      const res = (await tool!.call({ org_slug: ORG, agent_slug: AGENT, may_dispatch: [], ttl_hours: 72 })) as SurfaceToolResult;
      expect(res.ok, String(caller?.kind)).toBe(false);
      expect(res.refusal, String(caller?.kind)).toBe("not_a_human_member");
      expect(backend, "a refused issue never touches the backend").not.toHaveBeenCalled();
    }
  });

  it("INV-5 · a member caller with no backend wired is refused no_backend, naming the seam — and on a hosted surface too, ahead of the hosted check", async () => {
    for (const hosted of [false, true]) {
      const tool = issueTool(surfaceDeps({ hosted, caller: { kind: "member" } }));
      const res = (await tool!.call({ org_slug: ORG, agent_slug: AGENT, may_dispatch: [], ttl_hours: 72 })) as SurfaceToolResult;
      expect(res.ok).toBe(false);
      expect(res.refusal).toBe("no_backend");
      expect(res.error).toMatch(/issueAgentToken/);
      expect(res.hosted_unsupported).toBeFalsy();
    }
  });

  it("INV-6 · a TTL the store cannot express is refused, not rounded: 0, 1.5, -1, 'x', absent", async () => {
    const m = await agentTokenModule();
    for (const bad of [0, 1.5, -1, "x", undefined, null, 1e9]) {
      const r = m.ttlHoursOrRefusal(bad);
      expect("refusal" in r && r.refusal, `ttl ${String(bad)}`).toBe("bad_ttl");
    }
    expect(m.ttlHoursOrRefusal(72)).toEqual({ ttl_hours: 72 });
    expect(m.ttlHoursOrRefusal("24")).toEqual({ ttl_hours: 24 });
    const backend = okIssue();
    const tool = issueTool(surfaceDeps({ caller: { kind: "member" }, issueAgentToken: backend }));
    const res = (await tool!.call({ org_slug: ORG, agent_slug: AGENT, may_dispatch: [], ttl_hours: 1.5 })) as SurfaceToolResult;
    expect(res.ok).toBe(false);
    expect(res.refusal).toBe("bad_ttl");
    expect(res.error).toMatch(/1\.5/);
    expect(backend).not.toHaveBeenCalled();
  });

  it("INV-7 · the backend's typed refusals survive the seam: not_a_member, not_named", async () => {
    for (const code of ["not_a_member", "not_named"] as const) {
      const tool = issueTool(surfaceDeps({ caller: { kind: "member" }, issueAgentToken: codeIssue(code) }));
      const res = (await tool!.call({ org_slug: ORG, agent_slug: AGENT, may_dispatch: [], ttl_hours: 72 })) as SurfaceToolResult;
      expect(res.ok).toBe(false);
      expect(res.refusal).toBe(code);
    }
  });

  it("INV-8 · on success the token is returned ONCE with its key and expiry; may_dispatch defaults to []; nothing is sealed to the ledger", async () => {
    const backend = okIssue();
    const ledger = new MemoryLedger();
    const tool = issueTool(surfaceDeps({ caller: { kind: "member" }, issueAgentToken: backend, ledger }));
    const res = (await tool!.call({ org_slug: ORG, agent_slug: AGENT, ttl_hours: 72 })) as SurfaceToolResult & { data?: Record<string, unknown> };
    expect(res.ok).toBe(true);
    expect(backend).toHaveBeenCalledWith({ org_slug: ORG, agent_slug: AGENT, may_dispatch: [], ttl_hours: 72 });
    expect(Object.keys(res.data ?? {}).sort()).toEqual(["agent_slug", "agent_token", "expires_at", "key_id", "org_slug"]);
    expect(String(res.data?.agent_token)).toMatch(/^ctk_/);
    expect(ledger.query({}), "the token is the store's record (hash + issuer), never the ledger's").toHaveLength(0);
  });

  it("INV-9 · may_dispatch is passed through as a list of standard slugs, nothing else", async () => {
    const backend = okIssue();
    const tool = issueTool(surfaceDeps({ caller: { kind: "member" }, issueAgentToken: backend }));
    await tool!.call({ org_slug: ORG, agent_slug: AGENT, may_dispatch: ["reconcile-work-order-v0", 7, ""], ttl_hours: 72 });
    expect(backend).toHaveBeenCalledWith({ org_slug: ORG, agent_slug: AGENT, may_dispatch: ["reconcile-work-order-v0"], ttl_hours: 72 });
  });
});
