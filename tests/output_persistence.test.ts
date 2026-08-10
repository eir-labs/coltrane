// Gig OUTPUTS must be reliably persisted AND retrievable — the bug this file pins.
//
// A CLI-dispatched gig seals outputs into the shared on-disk store, but a long-lived MCP
// server that had already hydrated once never re-scanned the directory (the `fullyHydrated`
// latch in outputs.ts), so `output_query`/`output_trace` returned an EMPTY set for a gig whose
// payload jsonl sat right there on disk. The two stores were "disconnected" only in the sense
// that one process held a stale in-memory snapshot.
//
// Plus Eugene's two-tier spec: every sealed output persists (1) a compact, queryable Tier-1
// metadata row ALWAYS and (2) the full payload as a content-addressed artifact fetched on a
// deeper second pass — both mirrored to a local, gitignored `.coltrane/` store that MCP
// traverses seamlessly with no remote configured.
import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRegistry,
  createOutputStore,
  createOutputMirror,
  MemoryLedger,
  type DomainType,
  type OutputStore,
} from "../src/index.js";
import { dispatchTool, type ServerDeps } from "../src/server.js";

const sig: DomainType = {
  slug: "page-model", extends: "Signal", domain: "eirtests",
  schema: { properties: { url: { type: "string" } } }, required_fields: ["url"],
};
const SOURCE = { source: "https://eirtests.example" };

function reg() {
  const r = createRegistry();
  r.registerType(sig);
  return r;
}

function seedRow(gig_id: string) {
  return {
    core_type: "Signal", domain_type: "page-model", domain: "eirtests",
    gig_id, agent_slug: "scout", primitive: "SENSE", data: { url: "/", ...SOURCE },
  } as const;
}

// ── A. cross-process staleness — the reported bug ────────────────────────────────────────────
describe("output persistence — a second store sees a gig the first sealed after it hydrated", () => {
  it("output_query finds a CLI-sealed gig even after the MCP-store already hydrated", () => {
    const persistDir = mkdtempSync(join(tmpdir(), "coltrane-outputs-"));
    const registry = reg();

    // The "MCP server" store and the "CLI" store share one on-disk persistDir.
    const server: OutputStore = createOutputStore(registry, { persistDir });
    const cli: OutputStore = createOutputStore(registry, { persistDir });

    // Server hydrates once at startup (CLAUDE.md: run system_health first thing).
    expect(server.all().length).toBe(0);

    // CLI dispatches a gig in its own process, sealing an output to the shared dir.
    cli.write(seedRow("cli-gig"));

    // Before the fix: the server's `fullyHydrated` latch means it never re-scans, so this is [].
    const seen = server.all().filter((o) => o.gig_id === "cli-gig");
    expect(seen.length, "the MCP store must re-scan and see the CLI-sealed gig").toBe(1);
    expect(seen[0]!.data["url"]).toBe("/");
  });
});

// ── B. two-tier local mirror ─────────────────────────────────────────────────────────────────
describe("output persistence — two-tier local mirror (Tier-1 metadata + Tier-2 artifact)", () => {
  it("seals a Tier-1 metadata row (queryable, with preview + storage_ref) and a Tier-2 payload artifact", () => {
    const mirrorRoot = mkdtempSync(join(tmpdir(), "coltrane-mirror-"));
    const registry = reg();
    const mirror = createOutputMirror(mirrorRoot);
    const store = createOutputStore(registry, { mirror });

    const rec = store.write(seedRow("g-mirror"));

    // Tier 1 — compact metadata row, ALWAYS, queryable without loading payloads.
    const meta = mirror.queryMeta({ gig_id: "g-mirror" });
    expect(meta.length).toBe(1);
    expect(meta[0]!.id).toBe(rec.id);
    expect(meta[0]!.content_sha).toBe(rec.content_sha);
    expect(meta[0]!.agent_slug).toBe("scout");
    expect(meta[0]!.preview.length).toBeGreaterThan(0);
    expect(meta[0]!.storage_ref.length).toBeGreaterThan(0);
    // A metadata row is compact — it does NOT carry the full payload.
    expect((meta[0] as unknown as Record<string, unknown>)["data"]).toBeUndefined();

    // Tier 2 — the full payload, fetched on the deeper second pass, by id or content_sha.
    const byId = mirror.readPayload({ id: rec.id });
    expect(byId?.data?.["url"]).toBe("/");
    const bySha = mirror.readPayload({ content_sha: rec.content_sha });
    expect(bySha?.data?.["url"]).toBe("/");

    // A local, content-addressed payload file exists on disk (gitignored `.coltrane/` in prod).
    const artifactsDir = join(mirrorRoot, "outputs", "artifacts");
    expect(existsSync(artifactsDir)).toBe(true);
    expect(readdirSync(artifactsDir).some((f) => f.includes(rec.content_sha))).toBe(true);
  });
});

// ── C. MCP retrieval through the router ───────────────────────────────────────────────────────
describe("output persistence — MCP output_query retrieves CLI + mirror-backed outputs", () => {
  function wired(): { deps: ServerDeps; persistDir: string; mirrorRoot: string } {
    const persistDir = mkdtempSync(join(tmpdir(), "coltrane-outputs-"));
    const mirrorRoot = mkdtempSync(join(tmpdir(), "coltrane-mirror-"));
    const registry = reg();
    const mirror = createOutputMirror(mirrorRoot);
    const outputs = createOutputStore(registry, { persistDir, mirror });
    const deps: ServerDeps = { registry, outputs, ledger: new MemoryLedger(), output_mirror: mirror };
    return { deps, persistDir, mirrorRoot };
  }

  it("returns a CLI-sealed gig's outputs and can fetch a single full payload as a second pass", async () => {
    const { deps, persistDir } = wired();

    // Server hydrates first, THEN a separate CLI process seals into the shared dir.
    await dispatchTool("output_query", {}, deps);
    const cli = createOutputStore(deps.registry, { persistDir });
    const rec = cli.write(seedRow("cli-gig-2"));

    // Tier-1 traversal: the metadata row is retrievable.
    const q = await dispatchTool("output_query", { gig_id: "cli-gig-2" }, deps);
    const outs = (q.data as { outputs: Array<{ id: string; content_sha: string }>; total_count: number }).outputs;
    expect(outs.length).toBe(1);
    expect(outs[0]!.id).toBe(rec.id);

    // Second pass: fetch the full payload for one output by id.
    const deep = await dispatchTool("output_query", { output_id: rec.id, include_data: true }, deps);
    const deepOuts = (deep.data as { outputs: Array<{ data?: { url?: string } }> }).outputs;
    expect(deepOuts[0]!.data?.url).toBe("/");
  });
});
