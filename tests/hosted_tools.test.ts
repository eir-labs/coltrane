// The hosted MCP tool surface — OSS functionality, defined ONCE in the engine and consumed
// by any host (the Vercel app, a self-hosted wrapper). The host owns transport and auth;
// the engine owns what the tools ARE: names, schemas, and store-facing behavior. Handlers
// are dependency-free (fetch against a PostgREST-shaped org store) and bearer-class aware:
// a ctk_ agent token routes through the security-definer RPCs; a session JWT rides
// PostgREST directly so RLS scopes the member.
//
// RED-first: written against an engine with no hosted_tools module.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { HOSTED_TOOLS, hostedToolByName, type HostedToolContext } from "../src/hosted_tools.js";

const CTX_JWT: HostedToolContext = {
  baseUrl: "https://store.example",
  anonKey: "anon-key",
  bearer: "eyJx.eyJy.zzz", // JWT-shaped
};
const CTX_CTK: HostedToolContext = { ...CTX_JWT, bearer: "ctk_abc123" };

describe("the surface", () => {
  it("defines exactly the seven hosted tools", () => {
    expect(HOSTED_TOOLS.map((t) => t.name).sort()).toEqual([
      "cancel_gig",
      "dispatch_gig",
      "gig_outputs",
      "gig_status",
      "list_gigs",
      "list_standards",
      "roster",
    ]);
  });

  it("every tool carries a title, description, and a JSON-schema params object", () => {
    for (const t of HOSTED_TOOLS) {
      expect(t.title.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.paramsJsonSchema["type"]).toBe("object");
    }
  });
});

describe("handler routing by bearer class", () => {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => [],
    text: async () => "[]",
  }) as unknown as Response);
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("an agent token dispatches through the definer RPC", async () => {
    await hostedToolByName("dispatch_gig").handler(
      { standard_slug: "summarize", mode: "studio", input: { text: "x" } },
      CTX_CTK,
    );
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://store.example/rest/v1/rpc/coltrane_mcp_dispatch");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body["p_bearer"]).toBe("ctk_abc123");
    expect(body["p_standard"]).toBe("summarize");
  });

  it("a member JWT dispatches through the governor-gated RPC, riding the caller's own token", async () => {
    await hostedToolByName("dispatch_gig").handler(
      { standard_slug: "summarize", mode: "studio", input: { text: "x" } },
      CTX_JWT,
    );
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://store.example/rest/v1/rpc/coltrane_gig_dispatch");
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${CTX_JWT.bearer}`);
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body["p_bearer"]).toBeUndefined(); // the JWT authenticates via the header, never the body
  });

  it("a member JWT reads the queue straight off PostgREST — RLS is the scope", async () => {
    await hostedToolByName("list_gigs").handler({ status: "queued", limit: 5 }, CTX_JWT);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("https://store.example/rest/v1/coltrane_gigs");
    expect(url).toContain("status=eq.queued");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(`Bearer ${CTX_JWT.bearer}`);
  });

  it("member-only surfaces refuse agent tokens honestly", async () => {
    const out = await hostedToolByName("roster").handler({}, CTX_CTK);
    expect(out.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an agent token cancels a queued gig through the definer RPC", async () => {
    await hostedToolByName("cancel_gig").handler({ gig_id: "g1" }, CTX_CTK);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://store.example/rest/v1/rpc/coltrane_mcp_gig_cancel");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body["p_bearer"]).toBe("ctk_abc123");
    expect(body["p_gig"]).toBe("g1");
  });

  it("a member JWT cancels a queued gig through coltrane_gig_cancel, riding its own token", async () => {
    await hostedToolByName("cancel_gig").handler({ gig_id: "g1" }, CTX_JWT);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://store.example/rest/v1/rpc/coltrane_gig_cancel");
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${CTX_JWT.bearer}`);
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body["p_gig"]).toBe("g1");
    expect(body["p_bearer"]).toBeUndefined(); // the JWT authenticates via the header
  });
});
