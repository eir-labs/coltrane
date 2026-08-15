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
    // NOTE WHAT IS ABSENT: no COLTRANE_STORE_ANON. The write path must need the venue credential
    // and nothing else, so the fixture withholds the second one rather than supplying it.
    process.env["COLTRANE_DRAIN_URL"] = "https://coltrane.example";
    process.env["COLTRANE_DRAIN_KEY"] = "cdk_test";
    fetchMock.mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env["COLTRANE_DRAIN_URL"];
    delete process.env["COLTRANE_DRAIN_KEY"];
  });

  // THIS LAW HAS PINNED THE WRONG THING TWICE, in opposite directions, and the second time is the
  // instructive one.
  //
  // It first asserted a POST to /rest/v1/coltrane_gigs with `Authorization: Bearer <drain key>`.
  // In production that answered 401 — so it was rewritten to assert the definer RPC at
  // /rest/v1/rpc/coltrane_drain_upsert_gig, carrying the project's anon key as `apikey`.
  //
  // That diagnosis was wrong, and this law then DEFENDED the wrong architecture. The 401 was not
  // the shape; it was the HOST. The request was being sent to the Supabase project, which has never
  // heard of a cdk_ key. The Coltrane app serves that exact path and accepts that exact bearer —
  // and it is the only place that can also write the artifact, because Postgres cannot reach the
  // Storage API. Rewriting the client to satisfy the database bought a passing row-write, a second
  // credential on an unattended box, and a permanently 401ing artifact upload.
  //
  // Both versions passed by mocking fetch and asserting a URL, which is why neither could tell the
  // difference. The law below therefore pins the property that actually distinguishes them: the
  // request carries ONE credential, as a bearer, to a service that is not the database.
  it("presents one credential, as a bearer, to the service", async () => {
    await drainGigHeader(REC);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://coltrane.example/rest/v1/coltrane_gigs");
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer cdk_test");
    // The box holds no project credential. If one ever appears in this header the venue design has
    // been undone, whatever the URL says.
    expect(headers["apikey"]).toBeUndefined();
    const gig = JSON.parse(init.body as string) as Record<string, unknown>;
    // The row itself, not an RPC envelope — the service unwraps nothing.
    expect(gig["id"]).toBe(REC.gig_id);
    expect(gig["status"]).toBe("completed");
  });

  // The failure this whole change exists to make impossible. A drain pointed at the project 401s on
  // the artifact and SUCCEEDS on the rows, so the only symptom is a missing blob — which reads like
  // a Storage permissions problem and sent one investigation down a credential rabbit hole for two
  // days. Refuse before the first request instead.
  it("refuses a COLTRANE_DRAIN_URL that names the database rather than the service", async () => {
    process.env["COLTRANE_DRAIN_URL"] = "https://abcdefgh.supabase.co";
    await expect(drainGigHeader(REC)).rejects.toThrow(/points at the Supabase project/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Secrets outlive deploys: boxes provisioned before this change carry the suffixed form. Tolerate
  // it, and build from the origin either way — appending to it is what produced /rest/v1/rest/v1.
  it("tolerates the legacy /rest/v1 suffix without doubling it", async () => {
    process.env["COLTRANE_DRAIN_URL"] = "https://coltrane.example/rest/v1";
    await drainGigHeader(REC);
    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://coltrane.example/rest/v1/coltrane_gigs");
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
    process.env["COLTRANE_DRAIN_URL"] = "https://coltrane.example";
    process.env["COLTRANE_DRAIN_KEY"] = "cdk_test";
    fetchMock.mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env["COLTRANE_DRAIN_URL"];
    delete process.env["COLTRANE_DRAIN_KEY"];
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
    const call = calls.find(([u]) => String(u).endsWith("/rest/v1/coltrane_gigs"));
    expect(call, "failed run must drain a header").toBeDefined();
    const gig = JSON.parse(call![1].body as string) as Record<string, unknown>;
    expect(gig["id"]).toBe("22222222-2222-2222-2222-222222222222");
    expect(gig["status"]).toBe("failed");
    expect((gig["manifest"] as Record<string, unknown>)["error"]).toMatch(/boom in the chair/);
  });
});
