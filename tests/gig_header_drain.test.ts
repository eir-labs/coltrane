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
    fetchMock.mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env["COLTRANE_DRAIN_URL"];
    delete process.env["COLTRANE_DRAIN_KEY"];
  });

  it("POSTs the header to the sink's gig table path with merge semantics", async () => {
    await drainGigHeader(REC);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://drain.example/rest/v1/coltrane_gigs");
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer cdk_test");
    expect(headers["Prefer"]).toContain("merge-duplicates");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body["id"]).toBe(REC.gig_id);
    expect(body["status"]).toBe("completed");
  });

  it("is a silent no-op when the drain is not configured", async () => {
    delete process.env["COLTRANE_DRAIN_KEY"];
    await drainGigHeader(REC);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
