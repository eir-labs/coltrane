// A RESIDENCY'S TOKEN IS MINTED INTO ITS VAULT; THE VALUE NEVER LEAVES THE STORE (conformance SF-3 A1 —
// the engine half; the store door is coltrane-ui 20261004100000).
//
// Every path that existed for a resident's standing token put the value in a hand it does not name: the
// hosted mint returns the ctk_ once to its caller; the vault's member door is a dashboard; the system
// door is service_role-only. This tool is the one door: a MEMBER act, served on the hosted surface,
// whose backend runs the governed mint and writes the vault in one transaction and answers the key and
// the watch's times — never the token. The surface refuses a backend answer that carries one.
//
//   VT1  residency_token_into_vault is a member act: an agent-token caller is refused not_a_human_member
//        before any backend; a member without the seam gets no_backend by name
//   VT2  the watch's argument rules hold at the door: a non-integer ttl → bad_ttl; a ceiling under the ttl
//        → bad_ceiling; no reason → no_reason; a bad secret name → bad_args — nothing reaches the backend
//   VT3  with the seam: the backend receives the seven arguments (secret_name defaulting to
//        RESIDENCY_AGENT_TOKEN), and the answer carries key_id, the times and the name — no token field
//   VT4  THE VALUE NEVER LEAVES THE STORE: a backend that answers with a token (a ctk_ value, or a field
//        named like one) is refused, not relayed; a store refusal rides back in its words
//   VT5  postgrestResidencyTokenIntoVault POSTs public.coltrane_mint_residency_token_into_vault under the
//        MEMBER's bearer with the door's seven parameters and answers the four fields
//   VT6  the advertised row names exactly the arguments the surface reads (advertised_args_are_read holds)
import { describe, it, expect, afterEach, vi } from "vitest";
import { createRegistry, createOutputStore, MemoryLedger } from "../src/index.js";
import { createToolSurface, type ToolSurfaceDeps } from "../src/server.js";
import { postgrestResidencyTokenIntoVault } from "../src/genome_store.js";
import { MCP_TOOLS } from "../src/mcp.js";

const ARGS = { org_slug: "org-under-test", agent_slug: "resident", ttl_hours: 24, tenure_ceiling_hours: 720, reason: "a residency sitting, signed off" };
const ANSWER = { key_id: "agent-token-org-resident-20261004100000000", expires_at: "2026-10-05T10:00:00Z", tenure_ceiling_at: "2026-11-03T10:00:00Z", secret_name: "RESIDENCY_AGENT_TOKEN" };

function surface(extra: Partial<ToolSurfaceDeps>) {
  const registry = createRegistry();
  const d: ToolSurfaceDeps = { registry, outputs: createOutputStore(registry), ledger: new MemoryLedger(), hosted: true, ...extra };
  return (args: Record<string, unknown>) => createToolSurface(d).find((t) => t.name === "residency_token_into_vault")!.call(args) as unknown as Promise<Record<string, unknown>>;
}
afterEach(() => vi.restoreAllMocks());

describe("a residency's token is minted into its vault", () => {
  it("VT1 a member act: an agent token is refused first; a member without the seam gets no_backend", async () => {
    const agent = await surface({ caller: { kind: "gig" }, residencyTokenIntoVault: async () => ANSWER })(ARGS);
    expect(agent["ok"]).toBe(false);
    expect(agent["refusal"]).toBe("not_a_human_member");
    const unwired = await surface({ caller: { kind: "member" } })(ARGS);
    expect(unwired["refusal"]).toBe("no_backend");
    expect(String(unwired["error"])).toMatch(/residencyTokenIntoVault/);
  });

  it("VT2 the watch's rules hold at the door before any backend", async () => {
    let reached = 0;
    const call = surface({ caller: { kind: "member" }, residencyTokenIntoVault: async () => { reached++; return ANSWER; } });
    expect((await call({ ...ARGS, ttl_hours: 1.5 }))["refusal"]).toBe("bad_ttl");
    expect((await call({ ...ARGS, tenure_ceiling_hours: 12 }))["refusal"]).toBe("bad_ceiling");
    expect((await call({ ...ARGS, reason: "  " }))["refusal"]).toBe("no_reason");
    expect((await call({ ...ARGS, secret_name: "../other" }))["refusal"]).toBe("bad_args");
    expect((await call({ ...ARGS, agent_slug: "" }))["refusal"]).toBe("bad_args");
    expect(reached).toBe(0);
  });

  it("VT3 with the seam: seven arguments reach the backend; the answer carries the key, the times and the name — no token", async () => {
    const seen: unknown[] = [];
    const call = surface({ caller: { kind: "member" }, residencyTokenIntoVault: async (a) => { seen.push(a); return ANSWER; } });
    const r = await call({ ...ARGS, may_dispatch: ["a-standard"] });
    expect(r["ok"]).toBe(true);
    expect(seen[0]).toEqual({ org_slug: "org-under-test", agent_slug: "resident", ttl_hours: 24, tenure_ceiling_hours: 720, reason: "a residency sitting, signed off", secret_name: "RESIDENCY_AGENT_TOKEN", may_dispatch: ["a-standard"] });
    expect(r["data"]).toEqual({ key_id: ANSWER.key_id, org_slug: "org-under-test", agent_slug: "resident", secret_name: "RESIDENCY_AGENT_TOKEN", expires_at: ANSWER.expires_at, tenure_ceiling_at: ANSWER.tenure_ceiling_at });
    expect(JSON.stringify(r)).not.toMatch(/ctk_|agent_token/);
    const named = await call({ ...ARGS, secret_name: "RESIDENT_TOKEN" });
    expect((named["data"] as Record<string, unknown>)["secret_name"]).toBe("RESIDENCY_AGENT_TOKEN"); // the backend's name wins; a seam that renames is the store's business
  });

  it("VT4 a backend that answers a token value is refused, not relayed; a store refusal rides back", async () => {
    const leaky = surface({ caller: { kind: "member" }, residencyTokenIntoVault: async () => ({ ...ANSWER, agent_token: "ctk_0123456789abcdef" }) as unknown as typeof ANSWER });
    const r1 = await leaky(ARGS);
    expect(r1["ok"]).toBe(false);
    expect(String(r1["error"])).toMatch(/never leaves the store/);
    expect(JSON.stringify(r1)).not.toContain("ctk_0123456789abcdef");
    const leaky2 = surface({ caller: { kind: "member" }, residencyTokenIntoVault: async () => ({ ...ANSWER, secret_name: "ctk_0123456789abcdef" }) });
    expect((await leaky2(ARGS))["ok"]).toBe(false);
    const refused = surface({ caller: { kind: "member" }, residencyTokenIntoVault: async () => { throw new Error("coltrane_mint_residency_token_into_vault 400: agent resident is proposed — a capability token may only be issued to an agent that has been through the naming ceremony"); } });
    const r2 = await refused(ARGS);
    expect(r2["ok"]).toBe(false);
    expect(String(r2["error"])).toMatch(/naming ceremony/);
  });

  it("VT5 postgrestResidencyTokenIntoVault POSTs the door under the member's bearer with its seven parameters", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify([ANSWER]), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    const r = await postgrestResidencyTokenIntoVault({ baseUrl: "https://store.test", anonKey: "anon", bearer: "eyJmember" })(ARGS);
    expect(r).toEqual(ANSWER);
    // the reader is the FIRST wall: a store row carrying anything beyond the four fields comes back as exactly four
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([{ ...ANSWER, agent_token: "ctk_0123456789abcdef", extra: "x" }]), { status: 200, headers: { "Content-Type": "application/json" } })));
    const stripped = await postgrestResidencyTokenIntoVault({ baseUrl: "https://store.test", anonKey: "anon", bearer: "eyJmember" })(ARGS);
    expect(Object.keys(stripped).sort()).toEqual(["expires_at", "key_id", "secret_name", "tenure_ceiling_at"]);
    expect(JSON.stringify(stripped)).not.toContain("ctk_");
    expect(calls[0]!.url).toBe("https://store.test/rest/v1/rpc/coltrane_mint_residency_token_into_vault");
    expect((calls[0]!.init.headers as Record<string, string>)["Authorization"]).toBe("Bearer eyJmember");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ p_org_slug: "org-under-test", p_agent_slug: "resident", p_ttl_hours: 24, p_tenure_ceiling_hours: 720, p_reason: "a residency sitting, signed off", p_secret_name: "RESIDENCY_AGENT_TOKEN", p_may_dispatch: [] });
  });

  it("VT6 the advertised row names exactly the seven arguments", () => {
    const row = MCP_TOOLS.find((t) => t.slug === "residency_token_into_vault")!;
    expect(row).toBeTruthy();
    const props = Object.keys((row.input_schema as { properties: Record<string, unknown> }).properties).sort();
    expect(props).toEqual(["agent_slug", "may_dispatch", "org_slug", "reason", "secret_name", "tenure_ceiling_hours", "ttl_hours"]);
  });
});
