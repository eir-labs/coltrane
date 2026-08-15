// WHERE A DRAIN SENDS ITS WORK, and how many credentials it needs to get there.
//
// A drain is an unattended box. Its whole credential posture is one issued, org-scoped,
// instance-bound `cdk_` key — an APPLICATION credential, resolved inside a SECURITY DEFINER
// function. Supabase has never heard of it. So the box cannot address the project directly, and
// every attempt to make it ends by handing the box a SECOND credential.
//
// That is exactly what happened. The remote write POSTed to the Supabase project; the row half was
// made to work by adding the project's anon key as `apikey`; the artifact half had no equivalent
// (Postgres cannot reach the Storage API, so there is no definer function to call) and answered 401
// for days. The visible symptom was a missing blob, which reads like a Storage permissions problem.
//
// The Coltrane app already served both paths, in PostgREST and Storage shapes, accepting exactly
// the bearer the box holds. Nothing needed inventing — the requests were going to the wrong host.
//
// These laws pin the property that distinguishes the two architectures, which asserting a URL alone
// never could: ONE credential, as a bearer, to a service that is not the database.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRegistry, createOutputStore, createOutputMirror, type DomainType } from "../src/index.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sig: DomainType = {
  slug: "page-model", extends: "Signal", domain: "eirtests",
  schema: { properties: { url: { type: "string" } } }, required_fields: ["url"],
};

const GIG = "33333333-3333-3333-3333-333333333333";

/** Seal one output through the real mirror, then let the fire-and-forget drain run. */
async function sealOne(): Promise<{ content_sha: string }> {
  const registry = createRegistry();
  registry.registerType(sig);
  const mirror = createOutputMirror(mkdtempSync(join(tmpdir(), "coltrane-drain-")));
  const store = createOutputStore(registry, { mirror });
  const rec = store.write({
    core_type: "Signal", domain_type: "page-model", domain: "eirtests",
    gig_id: GIG, agent_slug: "scout", primitive: "SENSE",
    data: { url: "/", source: "https://eirtests.example" },
  });
  await new Promise((r) => setImmediate(r));
  return { content_sha: rec.content_sha };
}

describe("the drain writes to the service, holding one credential", () => {
  const fetchMock = vi.fn(
    async (_url?: unknown, _init?: unknown) =>
      ({ ok: true, status: 201, text: async () => "" }) as unknown as Response,
  );
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    // NOTE WHAT IS ABSENT: no COLTRANE_STORE_ANON. Withheld on purpose — if the write path ever
    // needs it again, that is the venue design coming undone, and this fixture is where it shows.
    process.env["COLTRANE_DRAIN_URL"] = "https://coltrane.example";
    process.env["COLTRANE_DRAIN_KEY"] = "cdk_test";
    fetchMock.mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env["COLTRANE_DRAIN_URL"];
    delete process.env["COLTRANE_DRAIN_KEY"];
    delete process.env["COLTRANE_INSTANCE"];
  });

  // The store's output sinks resolve a token hash and check a scope, and stop — so any live drain
  // key can currently write outputs for any gig of its org, including gigs it never claimed. The
  // git-credential path already checks key + instance + live lease, so the store knows how; the
  // write path never asked. Naming ourselves on every write is the half a client can do, and it
  // ships AHEAD of the gate so the gate needs no second engine release.
  it("names the instance it is, so the store can gate on a live lease", async () => {
    process.env["COLTRANE_INSTANCE"] = "coltrane-drain-eirlabs";
    await sealOne();
    for (const [, init] of fetchMock.mock.calls as unknown as [string, RequestInit][]) {
      expect((init.headers as Record<string, string>)["X-Coltrane-Instance"]).toBe(
        "coltrane-drain-eirlabs",
      );
    }
  });

  it("claims no instance when it is not one — a local run holds no lease", async () => {
    await sealOne();
    for (const [, init] of fetchMock.mock.calls as unknown as [string, RequestInit][]) {
      expect((init.headers as Record<string, string>)["X-Coltrane-Instance"]).toBeUndefined();
    }
  });

  it("sends the row and the artifact to the service, each as a bearer and nothing else", async () => {
    const { content_sha } = await sealOne();
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect(calls.length).toBe(2);

    for (const [url, init] of calls) {
      expect(String(url).startsWith("https://coltrane.example/")).toBe(true);
      const headers = init.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer cdk_test");
      // A project key on an unattended box is the thing this design removes. If one appears here,
      // the second credential is back regardless of what the URL says.
      expect(headers["apikey"]).toBeUndefined();
    }

    expect(calls[0]![0]).toBe("https://coltrane.example/rest/v1/coltrane_outputs");
    expect(calls[1]![0]).toBe(
      `https://coltrane.example/storage/v1/object/coltrane-artifacts/${GIG}/${content_sha}.json`,
    );
  });

  // THE SPECIFIC DEFECT. The artifact URL was built from a base that already ended in `/rest/v1`,
  // yielding `/rest/v1/storage/v1/object/…`. Storage is a SIBLING of the REST surface, not a child.
  // Boxes provisioned before this change still carry the suffixed form, so tolerating it is not
  // politeness — it is the difference between a redeploy working and a redeploy 404ing.
  it("puts the artifact beside the REST surface, not underneath it, even on a legacy suffixed URL", async () => {
    process.env["COLTRANE_DRAIN_URL"] = "https://coltrane.example/rest/v1";
    await sealOne();
    const urls = (fetchMock.mock.calls as unknown as [string, RequestInit][]).map(([u]) => String(u));
    expect(urls.some((u) => u.includes("/rest/v1/storage/v1"))).toBe(false);
    expect(urls.some((u) => u.includes("/rest/v1/rest/v1"))).toBe(false);
    expect(urls[1]!.startsWith("https://coltrane.example/storage/v1/object/")).toBe(true);
  });

  // The row carries `data` inline, so it is the record. Writing it first means a later artifact
  // failure cannot leave a gig that ran, cost money, and left nothing behind.
  it("writes the row before the artifact", async () => {
    await sealOne();
    const urls = (fetchMock.mock.calls as unknown as [string, RequestInit][]).map(([u]) => String(u));
    expect(urls[0]).toContain("/rest/v1/coltrane_outputs");
    expect(urls[1]).toContain("/storage/v1/object/");
  });

  it("treats an already-present artifact as success — the sha names the bytes", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockImplementation(async (url: unknown) =>
      (String(url).includes("/storage/v1/")
        ? { ok: false, status: 409, text: async () => "duplicate" }
        : { ok: true, status: 201, text: async () => "" }) as unknown as Response,
    );
    await sealOne();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("refuses a COLTRANE_DRAIN_URL that names the database rather than the service", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env["COLTRANE_DRAIN_URL"] = "https://abcdefgh.supabase.co";
    await sealOne();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn.mock.calls.flat().join(" ")).toMatch(/points at the Supabase project/);
    warn.mockRestore();
  });
});
