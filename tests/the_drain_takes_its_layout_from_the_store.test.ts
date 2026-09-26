// THE DRAIN TAKES ITS LAYOUT FROM THE ORG STORE, KEYED BY REPOSITORY — NEVER FROM ITS CLONE.
//
// The founder's ruling (26 Sep). The drain runs queued work against a freshly cloned repository. If the
// grant boundary were read from that clone, the repository being edited would author its own seat's
// authority: anyone who can push a coltrane.layout.json can widen every implementer that drains it. So
// a drained gig's layout is an ORG STORE ROW, keyed by the repository the gig works in, loaded through
// the GenomeStore port's ONE shared reconstruction (reconstructGenome, src/genome_store.ts). The files
// backing keeps its meaning: the tree's own coltrane.layout.json IS that tree's layout.
//
// THE CONTRACT (this repo's half):
//   GenomeRows.layouts?: { repository: string; definition: <layout file shape> }[]
//   reconstructGenome(rows).layouts: ReadonlyMap<repository, Layout> — each definition validated by
//     LayoutSchema; a row that fails is a load_error and is absent from the map.
//   workOnce: the run's layout = genome.layouts.get(resolveWorkingRepo(claim)), threaded through
//     assembleRunDeps → ctx.layout. No row → no layout (role tokens then fail closed). The clone's
//     coltrane.layout.json is never read.
// THE STORE'S HALF lives outside this repo and is NOT invented here (see the red-spec).
//
// The drain laws run workOnce against a mocked store (the harness of
// tests/venue_dispatch/room_workspace_populated.test.ts) and a LOCAL bare repository whose committed
// coltrane.layout.json is WIDER than the store row — so reading the clone is observable.
//
//   law                                           kind         drives                                    plant
//   files backing: the tree's file is its layout  behavioural  fileGenomeStore(root).load — src/genome_  never read coltrane.layout.json in the
//                                                              store.ts (→ resolveGenome)                files backing
//   reconstruction carries layouts by repository  behavioural  reconstructGenome — src/genome_store.ts   drop rows.layouts in reconstructGenome
//   a malformed row is a load_error               behavioural  same                                      admit a row LayoutSchema refuses
//   the drain's chair gets the STORE row          behavioural  workOnce — src/worker.ts (→ assembleRunDeps) read the clone's coltrane.layout.json
//                                                                                                         (resolveGenome(workspace.dir).layout)
//   no row → no layout, whatever the clone says   behavioural  same                                      fall back to the clone's file when the
//                                                                                                         store has no row
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileGenomeStore, reconstructGenome, type GenomeRows } from "../src/genome_store.js";
import { workOnce, type WorkerContext } from "../src/worker.js";
import type { AgentInvoker, AgentInvocationContext } from "../src/runtime.js";
import { genomeTree, LAYOUT_FILE, TS_LAYOUT, type Layout } from "./layout_grants_fixtures.js";

const STORE_ROW: Layout = { paths: { source: ["src/**"] }, commands: { laws: ["npx vitest run"] } };
const CLONE_FILE: Layout = { paths: { source: ["**"], scripts: ["scripts/**"] }, commands: { laws: ["npx vitest run"], ship_dry: ["npm publish"] } };

const layoutsOf = (g: unknown): ReadonlyMap<string, unknown> | undefined => (g as { layouts?: ReadonlyMap<string, unknown> }).layouts;

const BASE_ROWS = {
  core_types: [], domain_types: [],
  agents: [
    { slug: "scout", primitives: ["SENSE"], input_types: [], output_types: ["Signal"], domain: "demo",
      identity: "you are scout", method: "1. look 2. report 3. stop", constraints: [],
      behavioral_primitives: ["explorer", "critic"], permissions: {}, default_skills: [] },
  ],
  standards: [
    { slug: "wire-run-v0", domain: "demo", status: "active",
      phases: [{ name: "scan", chairs: [{ role: "scan", agent_slug: "scout", depends_on: [], input_contract: [], output_contract: ["Signal"], optional_outputs: [], required_skills: [] }] }],
      output_types: ["Signal"] },
  ],
  skills: [], evals: [], venues: [], charts: [],
};

describe("the GenomeStore port carries layouts", () => {
  it("(a) the FILES backing exposes the tree's coltrane.layout.json as that tree's layout", async () => {
    const g = await fileGenomeStore(genomeTree({ layout: TS_LAYOUT })).load();
    expect((g as unknown as { layout?: unknown }).layout, "the files backing did not carry the tree's layout").toEqual(TS_LAYOUT);
  });

  it("the shared reconstruction carries one layout per repository, validated", () => {
    const g = reconstructGenome({
      ...BASE_ROWS,
      layouts: [
        { repository: "https://github.com/eir-labs/coltrane", definition: STORE_ROW },
        { repository: "https://github.com/eir-labs/lighthouse-classic", definition: { paths: { source: ["ios/Sources/**"] } } },
      ],
    } as unknown as GenomeRows);
    const m = layoutsOf(g);
    expect(m, "the reconstruction dropped the store's layout rows").toBeDefined();
    expect(m!.get("https://github.com/eir-labs/coltrane")).toEqual(STORE_ROW);
    expect(m!.get("https://github.com/eir-labs/lighthouse-classic")).toEqual({ paths: { source: ["ios/Sources/**"] } });
  });

  it("a layout row LayoutSchema refuses is a load_error and is absent from the map", () => {
    const g = reconstructGenome({
      ...BASE_ROWS,
      layouts: [
        { repository: "https://github.com/eir-labs/good", definition: STORE_ROW },
        { repository: "https://github.com/eir-labs/bad", definition: { paths: { sources: ["src/**"] } } },
      ],
    } as unknown as GenomeRows);
    expect(layoutsOf(g)?.get("https://github.com/eir-labs/good"), "non-vacuity: the good row loads").toEqual(STORE_ROW);
    expect(layoutsOf(g)?.has("https://github.com/eir-labs/bad"), "a malformed layout row was admitted").toBe(false);
    expect(JSON.stringify(g.load_errors), "a malformed layout row loaded silently").toMatch(/eir-labs\/bad/);
  });
});

// ── the drain ────────────────────────────────────────────────────────────────────────────────────

/** A LOCAL bare repository whose committed tree carries a (WIDE) coltrane.layout.json. */
function bareRepoWithLayout(): string {
  const origin = mkdtempSync(join(tmpdir(), "layout-origin-"));
  execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", origin]);
  const seed = mkdtempSync(join(tmpdir(), "layout-seed-"));
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", seed]);
  writeFileSync(join(seed, LAYOUT_FILE), JSON.stringify(CLONE_FILE, null, 2));
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  for (const a of [["add", "-A"], ["commit", "--quiet", "-m", "seed"], ["remote", "add", "origin", origin], ["push", "--quiet", "origin", "HEAD:refs/heads/main"]]) {
    execFileSync("git", ["-C", seed, ...a], { env });
  }
  return origin;
}

const CRED_URL = "https://store.example/git-cred";
const CTX = (): WorkerContext => ({ baseUrl: "https://store.example", anonKey: "anon-key", agentToken: "ctk_test000", worker: "test-worker", drainKey: "dk", instance: "box" });

function mockStore(claim: Record<string, unknown>, rows: Record<string, unknown>): void {
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u === CRED_URL) return new Response(JSON.stringify({ token: "ghs_hermetic_token" }), { status: 200 });
    if (u.endsWith("/rest/v1/rpc/coltrane_drain_claim")) return new Response(JSON.stringify({ ...claim, token: "ctk_drain_test" }), { status: 200 });
    if (u.endsWith("/rest/v1/rpc/coltrane_mcp_claim")) return new Response(JSON.stringify(claim), { status: 200 });
    if (u.endsWith("/rest/v1/rpc/coltrane_mcp_gig_outputs")) return new Response(JSON.stringify([]), { status: 200 });
    if (u.endsWith("/rest/v1/rpc/coltrane_mcp_gig_status")) return new Response(JSON.stringify(null), { status: 200 });
    if (u.endsWith("/rest/v1/rpc/coltrane_mcp_genome")) return new Response(JSON.stringify(rows), { status: 200 });
    if (u.endsWith("/rest/v1/rpc/coltrane_mcp_gig_park")) return new Response(JSON.stringify(true), { status: 200 });
    if (u.endsWith("/rest/v1/rpc/coltrane_mcp_gig_fail")) return new Response(JSON.stringify(true), { status: 200 });
    return new Response(`unexpected url ${u}`, { status: 500 });
  }));
}

const sealableSignal = { id: "sig-1", source: "test", data: { seen: true }, completeness: 1, acquisition_cost: 0 };

describe("the drain seats its chairs under the STORE's layout for the gig's repository", () => {
  let stateRoot: string;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    vi.unstubAllGlobals();
    stateRoot = mkdtempSync(join(tmpdir(), "layout-drain-"));
    for (const k of ["COLTRANE_WORKER_CHECKPOINTS", "COLTRANE_DRAIN_KEY", "COLTRANE_INSTANCE", "COLTRANE_GIT_CREDENTIALS_URL"]) saved[k] = process.env[k];
    process.env["COLTRANE_WORKER_CHECKPOINTS"] = stateRoot;
    process.env["COLTRANE_DRAIN_KEY"] = "dk";
    process.env["COLTRANE_INSTANCE"] = "box";
    process.env["COLTRANE_GIT_CREDENTIALS_URL"] = CRED_URL;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(stateRoot, { recursive: true, force: true });
  });

  async function drain(origin: string, layouts: unknown[]): Promise<AgentInvocationContext[]> {
    const claim = {
      gig_id: "1a1a1a1a-2b2b-4c3c-8d4d-5e5e5e5e5e5e", standard_slug: "wire-run-v0", standard_version: null,
      mode: "rehearsal", input: { subject: "the wire" }, acting_for: "steve-1", venue: null, repo_url: origin,
    };
    mockStore(claim, { ...BASE_ROWS, layouts });
    const seen: AgentInvocationContext[] = [];
    const invoke: AgentInvoker = (ctx) => { seen.push(ctx); return sealableSignal; };
    const res = await workOnce(CTX(), { makeInvoke: () => invoke });
    expect(res.claimed, "the mocked claim was not taken — the law would observe nothing").toBe(true);
    expect(seen.length, `the drain never reached the chair: ${JSON.stringify(res).slice(0, 300)}`).toBeGreaterThan(0);
    return seen;
  }

  it("(b)+(c) the chair's ctx.layout is the store row for the gig's repository — not the WIDER file committed in the clone", async () => {
    const origin = bareRepoWithLayout();
    const seen = await drain(origin, [
      { repository: origin, definition: STORE_ROW },
      { repository: "https://github.com/eir-labs/some-other-repo", definition: { paths: { source: ["**"] } } },
    ]);
    const layout = (seen[0] as unknown as { layout?: unknown }).layout;
    expect(layout, "the drain seated the chair under the clone's own layout file — the repository authored its seat's authority").not.toEqual(CLONE_FILE);
    expect(layout, "the drain did not carry the store's row for this repository to the chair").toEqual(STORE_ROW);
  });

  it("(c) no store row for the repository → the chair has NO layout, whatever the clone's file says", async () => {
    const origin = bareRepoWithLayout();
    const seen = await drain(origin, [{ repository: "https://github.com/eir-labs/some-other-repo", definition: STORE_ROW }]);
    expect((seen[0] as unknown as { layout?: unknown }).layout, "absent a store row, the drain fell back to a layout (the clone's, or another repository's)").toBeUndefined();
  });
});
