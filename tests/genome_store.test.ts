// genome_store — the GenomeStore port. Governor ruling: genome is not local. The hosted
// Coltrane MCP is the Coltrane MCP — the full surface, functioning against the Supabase
// store. Two implementations of one port:
//   * fileGenomeStore(root)      — thin adapter over the existing loader/writer (local dev).
//   * postgrestGenomeStore(ctx)  — loads the five genome tables over PostgREST (RLS scopes
//     by the caller's bearer) and reconstructs the SAME in-memory genome shape the file
//     loader produces; upserts ride the coltrane_genome_upsert RPC.
//
// RED-first: written against an engine with no genome_store module.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fileGenomeStore,
  postgrestGenomeStore,
  postgrestQueueGig,
  type PostgrestContext,
} from "../src/genome_store.js";

const CTX: PostgrestContext = {
  baseUrl: "https://store.example",
  anonKey: "anon-key",
  bearer: "eyJx.eyJy.zzz",
};

// ── row fixtures — the round-tripped Supabase row shapes ─────────────────────────
const DOMAIN_TYPE_ROWS = [
  {
    slug: "scan-report", version: 1, extends: "Signal", domain: "demo", status: "active",
    schema: { type: "object", properties: { summary: { type: "string" } } },
    required_fields: ["summary"],
  },
  // a malformed row — version is not a number; must land in load_errors, not vanish
  {
    slug: "broken-type", version: "not-a-number", extends: "Signal", domain: "demo", status: "active",
    schema: { type: "object", properties: {} }, required_fields: [],
  },
];

const AGENT_ROWS = [
  {
    slug: "scout", version: 1, status: "active",
    primitives: ["SENSE"], input_types: [], output_types: ["scan-report"], domain: "demo",
    identity: "you are scout", method: "1. look 2. report 3. stop", constraints: [],
    depth_profile: "standard",
    permissions: { allowed_tools: ["Read"], model_tier: "economy", max_tool_calls: 5 },
    behavioral_primitives: ["explorer", "critic"],
    skill_slots: [], default_skills: ["tight-scan"],
  },
  // a malformed row — no identity/method; must land in load_errors, not vanish
  { slug: "hollow", version: 1, status: "active", primitives: ["SENSE"], permissions: {} },
];

const STANDARD_ROWS = [
  {
    slug: "scan-v1", version: 1, status: "active", domain: "demo",
    phases: [
      {
        name: "scan",
        chairs: [
          { role: "scout-seat", agent_slug: "scout", depends_on: [], input_contract: [], output_contract: ["scan-report"], required_skills: [] },
        ],
      },
    ],
    output_types: ["scan-report"],
  },
  // references an agent that failed to load — a load error, not a silent skip
  {
    slug: "hollow-v1", version: 1, status: "active", domain: "demo",
    phases: [
      { name: "p", chairs: [{ role: "seat", agent_slug: "hollow", depends_on: [], input_contract: [], output_contract: ["scan-report"], required_skills: [] }] },
    ],
  },
];

const SKILL_ROWS = [
  {
    slug: "tight-scan", name: "Tight scan", description: "scan tightly",
    skill_md: "# tight scan\nScan tightly.", tier: 0,
    input_type: "Signal", output_type: "Signal", status: "active",
  },
];

function routeFetch(url: string): unknown {
  if (url.includes("coltrane_core_types")) return []; // RLS may hide them — engine seeds the canonical 6
  if (url.includes("coltrane_domain_types")) return DOMAIN_TYPE_ROWS;
  if (url.includes("coltrane_agent_profiles")) return AGENT_ROWS;
  if (url.includes("coltrane_standards")) return STANDARD_ROWS;
  if (url.includes("coltrane_skills")) return SKILL_ROWS;
  return [];
}

describe("postgrestGenomeStore.load", () => {
  const fetchMock = vi.fn(async (url: string) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(routeFetch(url)),
  }) as unknown as Response);
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("reconstructs the loader's genome shape from the five tables", async () => {
    const genome = await postgrestGenomeStore(CTX).load();

    // core types: rows were empty (RLS), so the engine's canonical immutable 6 are seeded —
    // exactly what the file loader does for a root with no core_types/ of its own.
    expect(genome.core_types.size).toBe(6);
    expect(genome.core_types.has("Signal")).toBe(true);

    // domain types keyed slug@version, validated through the single Zod source
    expect(genome.domain_types.has("scan-report@1")).toBe(true);

    // agents run through defineAgent — permissions jsonb unpacked to the flat engine fields
    const scout = genome.agents.get("scout");
    expect(scout).toBeDefined();
    expect(scout!.allowed_tools).toEqual(["Read"]);
    expect(scout!.model_tier).toBe("economy");
    expect(scout!.max_tool_calls).toBe(5);
    expect(scout!.skill_slugs).toEqual(["tight-scan"]); // default_skills → skill_slugs

    // standards composed via composeStandard, agents resolved from the chairs' agent_slugs
    const std = genome.standards.get("scan-v1");
    expect(std).toBeDefined();
    expect(std!.phases[0]!.chairs[0]!.role).toBe("scout-seat");
    expect((std as { status?: string }).status).toBe("active");

    // skills: skill_md becomes the loaded reasoning half
    const skill = genome.skills.get("tight-scan");
    expect(skill).toBeDefined();
    expect(skill!.md).toContain("Scan tightly");

    // evals: no hosted table today — present and empty, same shape as a genome without evals/
    expect(genome.evals.size).toBe(0);
  });

  it("reports rows that fail validation as load errors — never a silent skip", async () => {
    const genome = await postgrestGenomeStore(CTX).load();
    const kinds = genome.load_errors.map((e) => `${e.kind}:${e.slug}`);
    expect(kinds).toContain("domain_type:broken-type");
    expect(kinds).toContain("agent:hollow");
    // the standard that composed the broken agent fails too, loudly
    expect(kinds).toContain("standard:hollow-v1");
    expect(genome.domain_types.has("broken-type@1")).toBe(false);
    expect(genome.agents.has("hollow")).toBe(false);
    expect(genome.standards.has("hollow-v1")).toBe(false);
  });

  it("rides the caller's bearer on every table read (RLS is the scope)", async () => {
    await postgrestGenomeStore(CTX).load();
    for (const call of fetchMock.mock.calls) {
      const [url, init] = call as unknown as [string, RequestInit];
      expect(url.startsWith("https://store.example/rest/v1/")).toBe(true);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers["apikey"]).toBe(CTX.anonKey);
      expect(headers["Authorization"]).toBe(`Bearer ${CTX.bearer}`);
    }
  });

  it("a failed table read is a load failure, not an empty genome", async () => {
    fetchMock.mockImplementationOnce(async () => ({
      ok: false, status: 401, text: async () => "permission denied",
    }) as unknown as Response);
    await expect(postgrestGenomeStore(CTX).load()).rejects.toThrow(/401|permission denied/);
  });
});

describe("postgrestGenomeStore.upsert", () => {
  const fetchMock = vi.fn(async () => ({
    ok: true, status: 200, text: async () => "null",
  }) as unknown as Response);
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs the coltrane_genome_upsert RPC riding the caller's bearer", async () => {
    await postgrestGenomeStore(CTX).upsert("agent", { slug: "scout", primitives: ["SENSE"] });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://store.example/rest/v1/rpc/coltrane_genome_upsert");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${CTX.bearer}`);
    expect(headers["apikey"]).toBe(CTX.anonKey);
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body["p_class"]).toBe("agent");
    expect(body["p_payload"]).toEqual({ slug: "scout", primitives: ["SENSE"] });
  });

  it("a refused upsert throws — never a silent success", async () => {
    fetchMock.mockImplementationOnce(async () => ({
      ok: false, status: 403, text: async () => JSON.stringify({ message: "not a governor" }),
    }) as unknown as Response);
    await expect(postgrestGenomeStore(CTX).upsert("standard", { slug: "x" })).rejects.toThrow(/not a governor/);
  });
});

describe("postgrestQueueGig", () => {
  const fetchMock = vi.fn(async () => ({
    ok: true, status: 200, text: async () => JSON.stringify("gig-uuid-1"),
  }) as unknown as Response);
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("queues via the governor-gated dispatch RPC as the caller", async () => {
    const queue = postgrestQueueGig(CTX);
    const out = await queue({ standard_slug: "scan-v1", input: { url: "https://x" }, mode: "live" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://store.example/rest/v1/rpc/coltrane_gig_dispatch");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(`Bearer ${CTX.bearer}`);
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body["p_standard"]).toBe("scan-v1");
    expect(body["p_mode"]).toBe("live");
    expect(body["p_input"]).toEqual({ url: "https://x" });
    expect(out).toEqual({ gig_id: "gig-uuid-1", status: "queued" });
  });
});

describe("fileGenomeStore (local dev — the file loader/writer, unchanged behavior)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "coltrane-genome-store-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("upsert writes the loadable file; load reads it back through the real loader", async () => {
    const store = fileGenomeStore(dir);
    await store.upsert("agent", {
      slug: "scout", primitives: ["SENSE"], input_types: [], output_types: ["scan-report"],
      domain: "demo", identity: "you are scout", method: "1. look 2. report 3. stop",
      constraints: [], behavioral_primitives: ["explorer", "critic"],
    });
    expect(existsSync(join(dir, "agents", "scout.json"))).toBe(true);
    const genome = await store.load();
    expect(genome.agents.has("scout")).toBe(true);
    expect(genome.core_types.size).toBe(6); // canonical seed, same as loadGenome
  });

  it("upsert refuses a payload with no slug", async () => {
    await expect(fileGenomeStore(dir).upsert("agent", { primitives: ["SENSE"] })).rejects.toThrow(/slug/);
  });
});
