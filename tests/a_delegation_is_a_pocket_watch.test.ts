// A DELEGATION IS A POCKET WATCH — the engine half: a mint names its mainspring and its reason;
// the governor winds and extends by a verb; the seat never does.
// (spec.coltrane-ui.token-tenure-extends-not-reissues; Eugene, 4 Oct 2026: "i say build it")
//
// WHY. A standing ctk_ could only be issued or revoked; keeping a seated agent alive past TTL meant
// a new secret, carried into its environment, and a relaunch — Vör was re-minted twice by hand in
// one night. Eugene's shape: "the governor's act becomes set timer, and either extend it through a
// sovereign act within specific parameters, or it expires automatically after a timer"; "it has no
// default — it's like a pocket watch and must be wound to keep going". The engine ships the three
// verbs' schemas and refusals; a deployment wires the store's doors (coltrane_issue_agent_token with
// a ceiling and a reason; coltrane_extend_agent_token; coltrane_rewind_agent_token). The store and
// the laws that drive the real doors are the other two halves (coltrane-ui; the conformance lane).
//
//   W1  agent_token_issue's schema names the mainspring and the reason: {org_slug, agent_slug,
//       may_dispatch, ttl_hours, tenure_ceiling_hours, reason} — and NO DEFAULT: a mint without a
//       ceiling or a reason is refused by name before any backend (bad_ceiling, no_reason); a ceiling
//       shorter than the ttl is refused (the first expiry would already be past the mainspring)
//   W2  agent_token_extend is on the surface with {org_slug, key_id, hours, reason}; agent_token_rewind
//       with {org_slug, key_id, reason}; both refuse an agent-token caller (not_a_human_member) and an
//       absent backend (no_backend) before anything else — no holder winds or extends itself
//   W3  extend refuses bad hours and a missing reason by name; rewind refuses a missing reason;
//       both refuse a blank key_id
//   W4  the store's typed refusals survive the seam for both: not_found, revoked, lapsed, over_ceiling,
//       over_max (extend); not_found, revoked, lapsed, not_stopped (rewind)
//   W5  on success extend answers the new expires_at and the ceiling; rewind answers the key and the
//       act; neither returns a token — the secret never changes hands twice
//   W6  the refusal vocabulary is closed and named
import { describe, it, expect, vi } from "vitest";
import { createToolSurface, type ToolSurfaceDeps } from "../src/server.js";
import { MCP_TOOLS } from "../src/mcp.js";
import { createRegistry } from "../src/registry.js";
import { createOutputStore } from "../src/outputs.js";
import { MemoryLedger } from "../src/ledger.js";
import { AGENT_TOKEN_REFUSALS } from "../src/agent_token.js";

function surfaceDeps(extra?: Record<string, unknown>): ToolSurfaceDeps {
  const registry = createRegistry();
  const base = { registry, outputs: createOutputStore(registry), ledger: new MemoryLedger() };
  return { ...base, ...(extra ?? {}) } as ToolSurfaceDeps;
}
const tool = (deps: ToolSurfaceDeps, name: string) => createToolSurface(deps).find((t) => t.name === name);
const props = (schema: object): string[] => Object.keys(((schema as { properties?: Record<string, unknown> }).properties ?? {})).sort();
const member = { caller: { kind: "member", uid: "u-1" } };
const agent = { caller: { kind: "agent", agent_slug: "vor" } };

const okIssue = vi.fn(async (a: Record<string, unknown>) => ({ ok: true as const, key_id: `agent-token-${a["org_slug"]}-${a["agent_slug"]}-x`, expires_at: "2026-10-05T00:00:00.000Z", tenure_ceiling_at: "2026-10-11T00:00:00.000Z", agent_token: "ctk_" + "0".repeat(48) }));
const okExtend = vi.fn(async (_a: Record<string, unknown>) => ({ ok: true as const, key_id: "k1", expires_at: "2026-10-06T00:00:00.000Z", tenure_ceiling_at: "2026-10-11T00:00:00.000Z" }));
const okRewind = vi.fn(async (_a: Record<string, unknown>) => ({ ok: true as const, key_id: "k1", act_id: "a1", wound_at: "2026-10-04T06:00:00.000Z" }));

describe("W1 — a mint names its mainspring and its reason; no default", () => {
  it("W1 the schema carries tenure_ceiling_hours and reason", () => {
    const row = MCP_TOOLS.find((t) => t.slug === "agent_token_issue");
    expect(row).toBeDefined();
    expect(props(row!.input_schema)).toEqual(["agent_slug", "may_dispatch", "org_slug", "reason", "tenure_ceiling_hours", "ttl_hours"]);
  });
  it("W1 a mint without a ceiling, without a reason, or with a ceiling under the ttl is refused by name before the backend", async () => {
    const t = tool(surfaceDeps({ ...member, issueAgentToken: okIssue }), "agent_token_issue")!;
    const base = { org_slug: "o", agent_slug: "vor", ttl_hours: 24, tenure_ceiling_hours: 168, reason: "the conformance sitting through 10 Oct" };
    const r1 = await t.call({ ...base, tenure_ceiling_hours: undefined });
    expect((r1 as { refusal?: string }).refusal).toBe("bad_ceiling");
    const r2 = await t.call({ ...base, reason: "   " });
    expect((r2 as { refusal?: string }).refusal).toBe("no_reason");
    const r3 = await t.call({ ...base, tenure_ceiling_hours: 12 });
    expect((r3 as { refusal?: string }).refusal).toBe("bad_ceiling");
    expect(okIssue).not.toHaveBeenCalled();
    const ok = await t.call(base);
    expect((ok as { ok: boolean }).ok).toBe(true);
    expect(okIssue).toHaveBeenCalledWith(expect.objectContaining({ tenure_ceiling_hours: 168, reason: "the conformance sitting through 10 Oct" }));
  });
});

describe("W2 — the governor's two verbs; the seat never winds itself", () => {
  it("W2 both verbs are on the surface with their schemas", () => {
    const ext = MCP_TOOLS.find((t) => t.slug === "agent_token_extend");
    const rew = MCP_TOOLS.find((t) => t.slug === "agent_token_rewind");
    expect(props(ext!.input_schema)).toEqual(["hours", "key_id", "org_slug", "reason"]);
    expect(props(rew!.input_schema)).toEqual(["key_id", "org_slug", "reason"]);
  });
  it("W2 an agent-token caller is refused not_a_human_member on both, before any backend; a member with no backend is refused no_backend", async () => {
    const ext = vi.fn(okExtend); const rew = vi.fn(okRewind);
    for (const [name, args] of [["agent_token_extend", { org_slug: "o", key_id: "k1", hours: 24, reason: "r" }], ["agent_token_rewind", { org_slug: "o", key_id: "k1", reason: "r" }]] as const) {
      const r = await tool(surfaceDeps({ ...agent, extendAgentToken: ext, rewindAgentToken: rew }), name)!.call({ ...args });
      expect((r as { refusal?: string }).refusal, `${name} by an agent token`).toBe("not_a_human_member");
      const n = await tool(surfaceDeps({ ...member }), name)!.call({ ...args });
      expect((n as { refusal?: string }).refusal, `${name} with no backend`).toBe("no_backend");
    }
    expect(ext).not.toHaveBeenCalled(); expect(rew).not.toHaveBeenCalled();
  });
});

describe("W3–W5 — refusals by name, the store's codes, and no token in any answer", () => {
  it("W3 extend refuses bad hours and no reason; rewind refuses no reason; both refuse a blank key_id", async () => {
    const e = tool(surfaceDeps({ ...member, extendAgentToken: okExtend }), "agent_token_extend")!;
    expect((await e.call({ org_slug: "o", key_id: "k1", hours: 0, reason: "r" }) as { refusal?: string }).refusal).toBe("bad_hours");
    expect((await e.call({ org_slug: "o", key_id: "k1", hours: 1.5, reason: "r" }) as { refusal?: string }).refusal).toBe("bad_hours");
    expect((await e.call({ org_slug: "o", key_id: "k1", hours: 24, reason: "" }) as { refusal?: string }).refusal).toBe("no_reason");
    expect((await e.call({ org_slug: "o", key_id: " ", hours: 24, reason: "r" }) as { refusal?: string }).refusal).toBe("bad_key_id");
    const w = tool(surfaceDeps({ ...member, rewindAgentToken: okRewind }), "agent_token_rewind")!;
    expect((await w.call({ org_slug: "o", key_id: "k1", reason: "" }) as { refusal?: string }).refusal).toBe("no_reason");
    expect((await w.call({ org_slug: "o", key_id: "", reason: "r" }) as { refusal?: string }).refusal).toBe("bad_key_id");
  });
  it("W4 the store's typed refusals survive the seam", async () => {
    for (const code of ["not_found", "revoked", "lapsed", "over_ceiling", "over_max"] as const) {
      const e = tool(surfaceDeps({ ...member, extendAgentToken: vi.fn(async () => ({ ok: false as const, code })) }), "agent_token_extend")!;
      expect((await e.call({ org_slug: "o", key_id: "k1", hours: 24, reason: "r" }) as { refusal?: string }).refusal).toBe(code);
    }
    for (const code of ["not_found", "revoked", "lapsed", "not_stopped"] as const) {
      const w = tool(surfaceDeps({ ...member, rewindAgentToken: vi.fn(async () => ({ ok: false as const, code })) }), "agent_token_rewind")!;
      expect((await w.call({ org_slug: "o", key_id: "k1", reason: "r" }) as { refusal?: string }).refusal).toBe(code);
    }
  });
  it("W5 success answers carry the watch's state and never a token", async () => {
    const e = await tool(surfaceDeps({ ...member, extendAgentToken: okExtend }), "agent_token_extend")!.call({ org_slug: "o", key_id: "k1", hours: 24, reason: "r" }) as { ok: boolean; data: Record<string, unknown> };
    expect(e.ok).toBe(true);
    expect(e.data).toEqual({ key_id: "k1", org_slug: "o", expires_at: "2026-10-06T00:00:00.000Z", tenure_ceiling_at: "2026-10-11T00:00:00.000Z" });
    const w = await tool(surfaceDeps({ ...member, rewindAgentToken: okRewind }), "agent_token_rewind")!.call({ org_slug: "o", key_id: "k1", reason: "r" }) as { ok: boolean; data: Record<string, unknown> };
    expect(w.ok).toBe(true);
    expect(w.data).toEqual({ key_id: "k1", org_slug: "o", act_id: "a1", wound_at: "2026-10-04T06:00:00.000Z" });
    expect(JSON.stringify(e.data) + JSON.stringify(w.data)).not.toMatch(/ctk_/);
  });
  it("W6 the refusal vocabulary is closed and named", () => {
    expect([...AGENT_TOKEN_REFUSALS].sort()).toEqual(["bad_ceiling", "bad_hours", "bad_key_id", "bad_may_dispatch", "bad_ttl", "no_backend", "no_reason", "not_a_human_member"]);
  });
});
