// The gig-HEADER drain — outputs drained but the gig row didn't, so the sink's queue table
// held service-fabricated stubs (`standard_slug: "demo"… stub: true`) for every real run.
// A consumer reading the sink saw sealed outputs hanging off a header that said nothing
// true about the run: no standard, no status, no spend, no fingerprint. This seam drains
// the header itself on completion, so the stub is replaced by the run's own record.
//
// RED-first: written against an output_mirror with no gig-header surface.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { gigHeaderBody, drainGigHeader, type GigHeaderRecord } from "../src/output_mirror.js";

const REC: GigHeaderRecord = {
  gig_id: "11111111-1111-1111-1111-111111111111",
  standard_slug: "steve-onboarding-v0",
  status: "complete",
  genome_hash: "aaaa",
  run_fingerprint: "bbbb",
  started_at: "2026-08-10T06:00:00.000Z",
  finished_at: "2026-08-10T06:34:00.000Z",
  outputs_count: 3,
  usage: { total_cost_usd: 4.05, input_tokens: 100, output_tokens: 900 },
};

describe("gigHeaderBody — the sink row derived from the run's own record", () => {
  it("maps the engine's terminal state onto the sink's gig columns", () => {
    const body = gigHeaderBody(REC);
    expect(body["id"]).toBe(REC.gig_id);
    expect(body["standard_slug"]).toBe("steve-onboarding-v0");
    // engine says "complete"; the sink's enum says "completed"
    expect(body["status"]).toBe("completed");
    expect(body["genome_hash"]).toBe("aaaa");
    expect(body["run_fingerprint"]).toBe("bbbb");
    expect(body["started_at"]).toBe(REC.started_at);
    expect(body["completed_at"]).toBe(REC.finished_at);
    expect(body["total_cost_usd"]).toBe(4.05);
    expect(body["total_tokens"]).toBe(1000);
    // duration derived from the timestamps the run actually recorded
    expect(body["total_duration_ms"]).toBe(34 * 60 * 1000);
    const manifest = body["manifest"] as Record<string, unknown>;
    expect(manifest["output_count"]).toBe(3);
    expect(manifest["stub"]).toBeUndefined();
  });

  it("maps failed and aborted terminal states without inventing spend", () => {
    expect(gigHeaderBody({ ...REC, status: "failed", usage: undefined })["status"]).toBe("failed");
    expect(gigHeaderBody({ ...REC, status: "aborted", usage: undefined })["total_cost_usd"]).toBeNull();
  });
});

describe("drainGigHeader — fire-and-forget to the drain service", () => {
  const fetchMock = vi.fn(async () => ({ ok: true, status: 201 }) as Response);
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    process.env["COLTRANE_DRAIN_URL"] = "https://drain.example";
    process.env["COLTRANE_DRAIN_KEY"] = "cdk_test";
    process.env["COLTRANE_STORE_ANON"] = "anon_test";
    fetchMock.mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env["COLTRANE_DRAIN_URL"];
    delete process.env["COLTRANE_DRAIN_KEY"];
    delete process.env["COLTRANE_STORE_ANON"];
  });

  // THIS LAW USED TO PIN THE WRONG THING. It asserted a direct POST to
  // /rest/v1/coltrane_gigs with `Authorization: Bearer <drain key>` — which is precisely the request
  // PostgREST answers 401, because a drain key is an application credential and PostgREST has never
  // heard of it. The law passed for years by mocking fetch and checking the URL, so it could not
  // have caught the auth failure it was encoding.
  //
  // The write path is the definer RPC, which authenticates the drain key against coltrane_drain_key
  // and needs the PROJECT key as `apikey` — two credentials, each in its own place.
  it("goes through coltrane_drain_upsert_gig, with each credential in its proper place", async () => {
    await drainGigHeader(REC);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://drain.example/rest/v1/rpc/coltrane_drain_upsert_gig");
    const headers = init.headers as Record<string, string>;
    // The PROJECT key opens PostgREST. The drain key is not one and must not be sent as one.
    expect(headers["apikey"]).toBe("anon_test");
    expect(headers["Authorization"]).toBeUndefined();
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    // The drain key rides in the body, where the definer function reads it.
    expect(body["p_token"]).toBe("cdk_test");
    const gig = body["p_gig"] as Record<string, unknown>;
    expect(gig["id"]).toBe(REC.gig_id);
    expect(gig["status"]).toBe("completed");
  });

  it("refuses to reach the store without a project key, instead of sending the drain key as one", async () => {
    delete process.env["COLTRANE_STORE_ANON"];
    await expect(drainGigHeader(REC)).rejects.toThrow(/COLTRANE_STORE_ANON is required/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is a silent no-op when the drain is not configured", async () => {
    delete process.env["COLTRANE_DRAIN_KEY"];
    delete process.env["COLTRANE_STORE_ANON"];
    await drainGigHeader(REC);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// A FAILED run must drain its header too. Found live (drain worker, first day): the local
// success path drained "completed" and the failure path drained nothing, so a failed local
// run left the sink's row stale forever — the stuck-"running" stub problem, one layer up.
describe("runGig drains a FAILED header — the sink learns the truth either way", () => {
  const fetchMock = vi.fn(async () => ({ ok: true, status: 201 }) as Response);
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    process.env["COLTRANE_DRAIN_URL"] = "https://drain.example";
    process.env["COLTRANE_DRAIN_KEY"] = "cdk_test";
    process.env["COLTRANE_STORE_ANON"] = "anon_test";
    fetchMock.mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env["COLTRANE_DRAIN_URL"];
    delete process.env["COLTRANE_DRAIN_KEY"];
    delete process.env["COLTRANE_STORE_ANON"];
  });

  it("a chair failure produces one failed-header POST carrying the error", async () => {
    const { composeStandard, defineAgent } = await import("../src/composition.js");
    const { runGig } = await import("../src/runtime.js");
    const { createRegistry } = await import("../src/registry.js");
    const { createOutputStore } = await import("../src/outputs.js");
    const { MemoryLedger } = await import("../src/ledger.js");
    const agent = defineAgent({
      slug: "doomed", primitives: ["SENSE"], input_types: [], output_types: ["Signal"],
      domain: "test", identity: "you are doomed", method: "1. try 2. die 3. stop",
      constraints: [], behavioral_primitives: ["explorer", "critic"],
    });
    const std = composeStandard({
      slug: "doomed-v0", domain: "test", agents: [agent],
      phases: [{ name: "sense", chairs: [{ role: "s", agent_slug: "doomed", depends_on: [], input_contract: [], output_contract: ["Signal"], optional_outputs: [], required_skills: [] }] }],
    });
    const registry = createRegistry();
    await expect(
      runGig(std, {}, {
        outputs: createOutputStore(registry),
        ledger: new MemoryLedger(),
        invoke: async () => { throw new Error("boom in the chair"); },
        gig_id: "22222222-2222-2222-2222-222222222222",
      }),
    ).rejects.toThrow(/boom in the chair/);
    // fire-and-forget: give the drained header its microtask
    await new Promise((r) => setImmediate(r));
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    const call = calls.find(([u]) => String(u).includes("coltrane_drain_upsert_gig"));
    expect(call, "failed run must drain a header").toBeDefined();
    const body = JSON.parse(call![1].body as string) as Record<string, unknown>;
    const gig = body["p_gig"] as Record<string, unknown>;
    expect(gig["id"]).toBe("22222222-2222-2222-2222-222222222222");
    expect(gig["status"]).toBe("failed");
    expect((gig["manifest"] as Record<string, unknown>)["error"]).toMatch(/boom in the chair/);
  });
});
