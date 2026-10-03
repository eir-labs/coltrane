// A FURNISHED ROOM IS CLAIMED AND MOUNTED — the drain half of "a room furnishes its reach".
// (spec: wiki spec.one-write-path.a-room-furnishes-its-reach; founder's ruling R38, 3 Oct 2026)
//
// MEASURED, 3 Oct: the eir-labs-inc box declares no realizable rooms (nothing sets
// WorkerContext.realizableVenues on the drain path), so venueMayClaim would refuse EVERY gig that
// named a room — and a room that declares no servers and no substrate needs nothing stood up. A
// furnishings-only room (equipment, doors, connectors) is realizable by every box.
//
//   K1  a claim naming a room that declares no mcp_servers and no substrate is taken by a box with no
//       realizable set — the gig runs; nothing is released
//   K2  a claim naming a room that declares an mcp server is still refused by a box with no realizer:
//       released non-terminally, the refusal names the room and the reason
//   K3  a room whose github connector grants two repositories: the drain prepares exactly the grant,
//       in the room's order, and every seat's context carries both mounts; with no change-request
//       tree, no mount is the cwd. (The real clone — one root, a folder per tree, one credential per
//       tree — is tests/a_room_furnishes_its_trees; here the preparer is seamed so the room can grant
//       GitHub-shaped repositories without a network.)
//   K4  the change-request's `repository`, when it is among the grant, is the cwd mount (and the tree
//       a change-set is stamped from); a repository the input names beyond the grant is asked for too,
//       after the grant — the broker, not the engine, is the one that refuses an ungranted tree
//   K5  the room's genome is read ONCE for a room-named claim — the furnishing read is the run's read
//   K6  a room that declares a substrate is not a room that needs nothing
//   K7  a refused claim leaves the worker's credential as it was
//   K9  the input's .git spelling of a granted tree is that tree — once, the cwd
//   K10 a plain room (no servers, no connector) with a typed repository, on a box holding a docker
//       realizer: the drain's single-tree path runs and the realizer is never reached — the
//       connector-less room is the common case, and `!roomNeedsNothing` on roomWillPopulate decides it
//   K11 a room WITH an mcp server, in the box's realizable set, a realizer present: the drain furnishes
//       nothing (no second tree beside the room's) and defers to realization, as on main
//   K12 the finally cleans up and revokes a furnished room's workspace after the run
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { workOnce, type WorkOnceDeps } from "../src/worker.js";
import type { AgentInvoker, AgentInvocationContext } from "../src/runtime.js";
import { hostedStore, hostedEnv, venueCtx, claimFor, sealableSignal, settle, GENOME_ROWS } from "./gig_runs_once_fixtures.js";

const BROKER = "https://broker.example/api/git-credentials";
let env: ReturnType<typeof hostedEnv>;
let savedBroker: string | undefined;
afterEach(() => {
  env?.cleanup();
  if (savedBroker === undefined) delete process.env["COLTRANE_GIT_CREDENTIALS_URL"]; else process.env["COLTRANE_GIT_CREDENTIALS_URL"] = savedBroker;
  vi.unstubAllGlobals();
});
function withBroker() { savedBroker = process.env["COLTRANE_GIT_CREDENTIALS_URL"]; process.env["COLTRANE_GIT_CREDENTIALS_URL"] = BROKER; }

/** A room row the store would serve: furnishings only unless `servers` or `grant` say otherwise. */
function roomRow(slug: string, extra: { grant?: string[]; servers?: boolean; substrate?: string } = {}) {
  return {
    slug, version: 1, status: "active",
    definition: {
      slug, institution_slug: "demo", responsible_chair: "demo.chair.root",
      doors: { ingress: [], egress: [] }, credential_surface: [],
      equipment: { tools: [] }, lifecycle: { policy: "ephemeral", rebuild_cadence: "per-gig" },
      mcp_servers: extra.servers ? [{ slug: "notes", transport: "http", url: "https://notes.example/mcp", credential_names: [] }] : [],
      ...(extra.grant ? { connectors: [{ kind: "github", grant: { repositories: extra.grant } }] } : {}),
      ...(extra.substrate ? { substrate: extra.substrate } : {}),
    },
  };
}
const genomeWith = (...rooms: ReturnType<typeof roomRow>[]) => ({ ...GENOME_ROWS, venues: rooms });

describe("K1/K2 — a room that needs nothing is realizable by every box; a room with servers is not", () => {
  it("K1 a claim naming a furnishings-only room is taken by a box with no realizable set, and runs", async () => {
    env = hostedEnv();
    const store = hostedStore({ claim: claimFor("one-chair-v0", { venue: "lineage-reading" }), genome: genomeWith(roomRow("lineage-reading")) });
    const invoke = vi.fn(async () => sealableSignal);
    const res = await workOnce(venueCtx(), { makeInvoke: () => invoke as unknown as AgentInvoker } as unknown as WorkOnceDeps);
    await settle();
    expect(res.claimed && res.status, "a room that declares no servers and no substrate was refused by a box that had nothing to stand up").toBe("complete");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(store.calls.some((c) => c.path.endsWith("/coltrane_drain_release")), "the claim was released — the room was treated as unrealizable").toBe(false);
  });

  it("K2 a claim naming a room with an mcp server is refused by a box with no realizer: released non-terminally, the room and the reason named", async () => {
    env = hostedEnv();
    const store = hostedStore({ claim: claimFor("one-chair-v0", { venue: "notes-room" }), genome: genomeWith(roomRow("notes-room", { servers: true })) });
    const invoke = vi.fn(async () => sealableSignal);
    let error = "";
    try {
      await workOnce(venueCtx(), { makeInvoke: () => invoke as unknown as AgentInvoker } as unknown as WorkOnceDeps);
    } catch (e) { error = e instanceof Error ? e.message : String(e); }
    await settle();
    expect(error).toMatch(/names venue "notes-room", which this worker cannot realize/);
    expect(error).toMatch(/declares servers or a substrate/);
    expect(invoke, "a chair ran in a room the box could not stand up").not.toHaveBeenCalled();
    const release = store.calls.find((c) => c.path.endsWith("/coltrane_drain_release"));
    expect(release, "the refused claim was not handed back — the row would sit leased for an hour").toBeDefined();
    expect(release!.body["p_terminal"]).toBe(false);
  });
});

describe("K3/K4/K5 — a furnished room's trees are prepared, credentialed per tree, and told to every seat", () => {
  const A = "https://github.com/eir-labs/coltrane";
  const B = "https://github.com/eir-labs/coltrane-ui";
  const C = "https://github.com/eir-labs/chancery";

  /** The workspace preparer, seamed: records what the drain asked for, answers folders under one root. */
  function preparer() {
    const asked: Array<{ trees: readonly string[]; cwdRepo: string | null | undefined; base: unknown }> = [];
    const prepare: typeof import("../src/workspace.js").prepareWorkspaces = async (opts) => {
      asked.push({ trees: opts.trees, cwdRepo: opts.cwdRepo, base: opts.base });
      if (opts.trees.length === 0) return null;
      const root = mkdtempSync(join(tmpdir(), "room-ws-"));
      const mounts = opts.trees.map((repoUrl) => ({ repoUrl, dir: join(root, basename(repoUrl)) }));
      for (const m of mounts) mkdirSync(m.dir, { recursive: true });
      const cwd = opts.cwdRepo ? mounts.find((m) => m.repoUrl === opts.cwdRepo) : undefined;
      return { root, dir: cwd?.dir ?? root, mounts, cleanup: () => undefined, revoke: async () => undefined };
    };
    return { asked, prepare };
  }

  it("K3 two granted trees: the drain asks for exactly the grant, in the room's order, with no cwd tree; every seat is told both mounts and none is the cwd", async () => {
    env = hostedEnv(); withBroker();
    const pw = preparer();
    const seen: AgentInvocationContext[] = [];
    const store = hostedStore({
      claim: claimFor("two-chair-v0", { venue: "lineage-reading" }),
      genome: genomeWith(roomRow("lineage-reading", { grant: [A, B] })),
    });
    const invoke = vi.fn(async (ctx: AgentInvocationContext) => { seen.push(ctx); return sealableSignal; });
    const res = await workOnce(venueCtx(), { makeInvoke: () => invoke as unknown as AgentInvoker, prepareWorkspaces: pw.prepare } as unknown as WorkOnceDeps);
    await settle();
    expect(res.claimed && res.status, `the furnished run did not complete: ${JSON.stringify(res)}`).toBe("complete");
    expect(pw.asked.length, "the drain must prepare the furnished trees once").toBe(1);
    expect(pw.asked[0]!.trees, "the trees asked for are the room's grant, in its order").toEqual([A, B]);
    expect(pw.asked[0]!.cwdRepo ?? null, "no change-request tree → no cwd tree").toBeNull();
    expect(seen.length).toBe(2);
    for (const c of seen) {
      expect(c.mounts?.map((m) => m.repoUrl), `seat ${c.role} was not told both trees`).toEqual([A, B]);
      expect(c.mounts!.every((m) => m.cwd === false), "no change-request tree, so no mount is the cwd").toBe(true);
      expect(new Set(c.mounts!.map((m) => m.dir)).size, "each tree has its own folder").toBe(2);
    }
    expect(store.calls.filter((c) => c.path.endsWith("/coltrane_mcp_genome")).length, "K5: the room's genome is read once for a room-named claim").toBe(1);
  });

  it("K4 the change-request's repository, when granted, is the cwd mount; a tree the input names beyond the grant is asked for too, after the grant — the broker, not the engine, refuses it", async () => {
    env = hostedEnv(); withBroker();
    const pw = preparer();
    const seen: AgentInvocationContext[] = [];
    hostedStore({
      claim: claimFor("one-chair-v0", { venue: "change-room", input: { repository: B } }),
      genome: genomeWith(roomRow("change-room", { grant: [A, B] })),
    });
    // THE REAL DOOR holds a docker realizer (`coltrane work` always passes one). A server-less room
    // must never reach it: the grade at a3db254 measured a change gig routed into `docker compose`
    // and failing terminally on a box that had nothing to build.
    const realize = vi.fn(async () => { throw new Error("REALIZER CALLED for a room that needs nothing"); });
    const res = await workOnce(venueCtx(), { makeInvoke: () => vi.fn(async (ctx: AgentInvocationContext) => { seen.push(ctx); return sealableSignal; }) as unknown as AgentInvoker, prepareWorkspaces: pw.prepare, venueRealizer: { realize } } as unknown as WorkOnceDeps);
    await settle();
    expect(res.claimed && res.status, `the run did not complete: ${JSON.stringify(res)}`).toBe("complete");
    expect(realize, "a room that needs nothing stood up was handed to the realizer").not.toHaveBeenCalled();
    expect(pw.asked[0]!.cwdRepo, "the change lands in coltrane-ui, so it is the cwd tree").toBe(B);
    const m = seen[0]!.mounts!;
    expect(m.find((x) => x.repoUrl === B)?.cwd, "the change-request's tree is the cwd mount").toBe(true);
    expect(m.find((x) => x.repoUrl === A)?.cwd).toBe(false);

    hostedStore({
      claim: claimFor("one-chair-v0", { venue: "change-room", input: { repository: C } }),
      genome: genomeWith(roomRow("change-room", { grant: [A, B] })),
    });
    const res2 = await workOnce(venueCtx(), { makeInvoke: () => vi.fn(async () => sealableSignal) as unknown as AgentInvoker, prepareWorkspaces: pw.prepare } as unknown as WorkOnceDeps);
    await settle();
    expect(res2.claimed && res2.status).toBe("complete");
    expect(pw.asked[1]!.trees, "the input's tree is asked for after the grant; the engine re-derives no grant").toEqual([A, B, C]);
    expect(pw.asked[1]!.cwdRepo).toBe(C);
  });

  it("K6 a room that declares a substrate is not a room that needs nothing — refused by a box with no realizer", async () => {
    env = hostedEnv();
    hostedStore({ claim: claimFor("one-chair-v0", { venue: "floor-room" }), genome: genomeWith(roomRow("floor-room", { substrate: "docker-compose" })) });
    let error = "";
    try { await workOnce(venueCtx(), { makeInvoke: () => vi.fn(async () => sealableSignal) as unknown as AgentInvoker } as unknown as WorkOnceDeps); }
    catch (e) { error = e instanceof Error ? e.message : String(e); }
    await settle();
    expect(error).toMatch(/names venue "floor-room", which this worker cannot realize/);
  });

  it("K7 a refused claim leaves the worker's credential exactly as it was", async () => {
    env = hostedEnv();
    hostedStore({ claim: claimFor("one-chair-v0", { venue: "notes-room" }), genome: genomeWith(roomRow("notes-room", { servers: true })) });
    const ctx = venueCtx();
    const before = ctx.agentToken;
    try { await workOnce(ctx, { makeInvoke: () => vi.fn(async () => sealableSignal) as unknown as AgentInvoker } as unknown as WorkOnceDeps); } catch { /* the refusal */ }
    await settle();
    expect(ctx.agentToken, "a refused claim changed what this worker is").toBe(before);
  });

  it("K9 the input's .git spelling of a granted tree is that tree — cloned once, the cwd", async () => {
    env = hostedEnv(); withBroker();
    const pw = preparer();
    const seen: AgentInvocationContext[] = [];
    hostedStore({
      claim: claimFor("one-chair-v0", { venue: "change-room", input: { repository: `${B}.git` } }),
      genome: genomeWith(roomRow("change-room", { grant: [A, B] })),
    });
    const res = await workOnce(venueCtx(), { makeInvoke: () => vi.fn(async (ctx: AgentInvocationContext) => { seen.push(ctx); return sealableSignal; }) as unknown as AgentInvoker, prepareWorkspaces: pw.prepare } as unknown as WorkOnceDeps);
    await settle();
    expect(res.claimed && res.status).toBe("complete");
    expect(pw.asked[0]!.trees, "a .git spelling of a granted tree became a second tree").toEqual([A, B]);
    expect(seen[0]!.mounts!.find((m) => m.repoUrl === B)?.cwd, "the .git spelling names the cwd tree").toBe(true);
  });

  /** A real local origin with one commit on main, for the single-tree path. */
  function origin(name: string): string {
    const bare = mkdtempSync(join(tmpdir(), `room-${name}-origin-`));
    execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", bare]);
    const seed = mkdtempSync(join(tmpdir(), `room-${name}-seed-`));
    execFileSync("git", ["init", "--quiet", "--initial-branch=main", seed]);
    writeFileSync(join(seed, `${name}.md`), name);
    const g = (args: string[]) => execFileSync("git", ["-C", seed, ...args], {
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    });
    g(["add", "-A"]); g(["commit", "--quiet", "-m", "seed"]);
    g(["remote", "add", "origin", bare]); g(["push", "--quiet", "origin", "HEAD:refs/heads/main"]);
    return bare;
  }

  it("K10 a plain room with a typed repository, under a docker realizer: the single-tree path runs; the realizer is never reached", async () => {
    // The grade at 7c97437, plant K4a: drop `!roomNeedsNothing` from roomWillPopulate and this gig is
    // "deferred to room realization", gets no tree, and the realizer is never called either — it runs
    // with no working tree, silently. The connector-less room is the pre-R38 common case.
    env = hostedEnv(); withBroker();
    const repo = origin("plain");
    const brokerBodies: Record<string, unknown>[] = [];
    const logs: string[] = [];
    hostedStore({
      claim: claimFor("one-chair-v0", { venue: "plain-room", input: { "change-request": { repository: repo } } }),
      genome: genomeWith(roomRow("plain-room")),
      other: (u, body) => { if (u.host === "broker.example") { brokerBodies.push(body); return new Response(JSON.stringify({ ok: true, token: "tok-plain" }), { status: 200 }); } if (u.host === "api.github.com") return new Response(null, { status: 204 }); return undefined; },
    });
    const realize = vi.fn(async () => { throw new Error("REALIZER CALLED for a plain room"); });
    const pw = preparer();
    const seen: AgentInvocationContext[] = [];
    const res = await workOnce(venueCtx(), { makeInvoke: () => vi.fn(async (c: AgentInvocationContext) => { seen.push(c); return sealableSignal; }) as unknown as AgentInvoker, venueRealizer: { realize }, prepareWorkspaces: pw.prepare, log: (l: string) => { logs.push(l); } } as unknown as WorkOnceDeps);
    await settle();
    expect(res.claimed && res.status, JSON.stringify(res)).toBe("complete");
    expect(realize, "a plain room was handed to the realizer").not.toHaveBeenCalled();
    expect(pw.asked.length, "a plain room furnishes nothing — the furnished preparer must not run").toBe(0);
    expect(logs.some((l) => l.startsWith("working tree ready: ")), "the single-tree path did not run: the gig ran with no working tree").toBe(true);
    expect(brokerBodies.length, "the single-tree path asks the broker once").toBe(1);
    expect(brokerBodies[0]!["repository"], "the single-tree path sends the old body, with no repository field").toBeUndefined();
    expect(seen[0]!.mounts).toBeUndefined();
  });

  it("K11 a room WITH an mcp server, realizable by this box, a realizer present: the drain furnishes nothing and defers to realization, as on main", async () => {
    env = hostedEnv(); withBroker();
    const logs: string[] = [];
    hostedStore({
      claim: claimFor("one-chair-v0", { venue: "notes-room", input: { "change-request": { repository: B } } }),
      genome: genomeWith(roomRow("notes-room", { servers: true, grant: [B] })),
    });
    const realize = vi.fn(async (_v: unknown, _c: unknown, opts: { repoUrl?: string }) => { throw new Error(`REALIZER repoUrl=${opts.repoUrl}`); });
    const pw = preparer();
    const ctx = { ...venueCtx(), realizableVenues: ["notes-room"] };
    const res = await workOnce(ctx, { makeInvoke: () => vi.fn(async () => sealableSignal) as unknown as AgentInvoker, venueRealizer: { realize }, prepareWorkspaces: pw.prepare, log: (l: string) => { logs.push(l); } } as unknown as WorkOnceDeps);
    await settle();
    expect(realize, "a server room must reach the realizer").toHaveBeenCalledTimes(1);
    expect(pw.asked.length, "a server room's grant must NOT be furnished by the drain — that would be a second tree beside the room's").toBe(0);
    expect(logs.some((l) => l.includes("deferred to room realization"))).toBe(true);
    expect(res.claimed && res.status).toBe("failed");
    expect(res.claimed && res.status === "failed" ? String(res.error) : "").toMatch(/REALIZER repoUrl=https:\/\/github\.com\/eir-labs\/coltrane-ui/);
  });

  it("K12 the finally cleans up and revokes a furnished room's workspace after the run", async () => {
    env = hostedEnv(); withBroker();
    const cleanup = vi.fn(); const revoke = vi.fn(async () => undefined);
    hostedStore({ claim: claimFor("one-chair-v0", { venue: "r" }), genome: genomeWith(roomRow("r", { grant: [A] })) });
    const prepare = vi.fn(async () => { const root = mkdtempSync(join(tmpdir(), "k12-")); const d = join(root, "coltrane"); mkdirSync(d); return { root, dir: root, mounts: [{ repoUrl: A, dir: d }], cleanup, revoke }; });
    const res = await workOnce(venueCtx(), { makeInvoke: () => vi.fn(async () => sealableSignal) as unknown as AgentInvoker, prepareWorkspaces: prepare } as unknown as WorkOnceDeps);
    await settle();
    expect(res.claimed && res.status).toBe("complete");
    expect(cleanup, "the furnished workspace was not cleaned up after the run").toHaveBeenCalledTimes(1);
    expect(revoke, "the furnished workspace's credentials were not handed back after the run").toHaveBeenCalledTimes(1);
  });
});
