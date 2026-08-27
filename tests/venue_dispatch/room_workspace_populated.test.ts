// A REALIZED ROOM'S WORKSPACE IS POPULATED WITH A WORKING TREE — and the repository is named by the
// RUN, not the room. Driven HERMETICALLY (no live daemon).
//
// The realizer's docker steps run through the injected `run` seam as no-ops, and every tree is cloned
// from a LOCAL bare repository (no network) — the same pattern tests/workspace.test.ts uses. What is
// under test is the DECISION about a working tree, not docker.
//
// TWO FAMILIES:
//
//   REALIZER-DIRECT (b/c/f) — the tree comes from the run-supplied source and NEVER from the host's
//       cwd (b); population routes through prepareWorkspace, the drain's own function (c); a run
//       naming no source declines to populate and mints nothing (f). These call realize() directly.
//
//   DISPATCH / DRAIN — the RUN names the repository, not the venue:
//       • DISPATCH-PATH LAW  — runGig (the dispatch path, not realize() directly) with a run naming a
//                              repository populates the seat's workspace with that repository's tree.
//       • ONE-TO-MANY LAW    — two gigs naming DIFFERENT repositories against the SAME venue each get
//                              their own correct, disjoint tree. This is the property a venue-pinned
//                              repo_url could never express.
//       • NO-REPOSITORY LAW  — a run naming no repository declines to populate: the room's populate
//                              path is never reached, no clone, no cwd fallback.
//       • COLLISION LAW      — a Booker claim AND a populating room in play mint EXACTLY ONE git
//                              credential (one clone) per gig: the Booker's clone is suppressed when
//                              the room will populate.
//       • BOOKER-UNCHANGED   — a run naming a repository but NO room keeps the Booker's own clone: a
//                              false-positive suppression would leave the drain with no tree at all.
//
// venue.repo_url has been REMOVED: the repository is a per-RUN fact (one venue serves many
// repositories), so `flooredRoom()` no longer sets it and the schema now REJECTS it.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dockerComposeRealizer,
  type VenueRealizer,
  type RealizationHandle,
  type ComposeRunner,
  type WorkspacePreparer,
} from "../../src/venue_realizer.js";
import { VenueSchema } from "../../src/genome_schema.js";
import * as workspace from "../../src/workspace.js";
import {
  runGig,
  createRegistry,
  createOutputStore,
  MemoryLedger,
  type AgentInvoker,
  type AgentInvocationContext,
  type DomainType,
  type Standard,
  type Agent,
} from "../../src";
import type { Venue } from "../../src/chart.js";
import { TEST_BEHAVIOR } from "../_support/agents.js";
import { workOnce, type WorkerContext } from "../../src/worker.js";

afterEach(() => vi.unstubAllGlobals());

const noCredentials = async (): Promise<Record<string, string>> => ({});

/** A no-op ComposeRunner: the docker steps do nothing, so the realizer's DECISION about the workspace
 *  runs without a daemon. Records the argv it was handed for good measure. */
function noopRunner(): { run: (a: readonly string[], t: number) => void; calls: string[][] } {
  const calls: string[][] = [];
  return { run: (a) => { calls.push([...a]); }, calls };
}

/** A LOCAL bare repository with one committed marker file — no network. Returns the path (the run's
 *  `repoUrl`) and the marker committed into it. */
function seedBareRepo(marker: string): { origin: string; marker: string } {
  const origin = mkdtempSync(join(tmpdir(), "roomws-origin-"));
  execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", origin]);
  const seed = mkdtempSync(join(tmpdir(), "roomws-seed-"));
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", seed]);
  writeFileSync(join(seed, "TREE_MARKER"), marker);
  const g = (a: string[]): void => {
    execFileSync("git", ["-C", seed, ...a], {
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    });
  };
  g(["add", "-A"]); g(["commit", "--quiet", "-m", "seed"]);
  g(["remote", "add", "origin", origin]); g(["push", "--quiet", "origin", "HEAD:refs/heads/main"]);
  return { origin, marker };
}

/** The per-gig credential mint prepareWorkspace calls before cloning. A local bare-repo clone never
 *  offers the token to git, so any token satisfies it; the returned vi.fn lets a law assert it was — or
 *  was NOT — called. */
function stubGitCredential(): ReturnType<typeof vi.fn> {
  const f = vi.fn(async () => new Response(JSON.stringify({ token: "ghs_hermetic_token" }), { status: 200 }));
  vi.stubGlobal("fetch", f);
  return f;
}

/** A floored venue (so the handle exposes `seat.workspace`, naming the clone root). It names NO
 *  repository — the repository is a per-RUN fact, threaded through `opts.repoUrl`. No mcp_servers, so
 *  nothing needs to stand up for the workspace decision. */
function flooredRoom(): unknown {
  return {
    slug: "populated-room-v1",
    institution_slug: "quartet",
    equipment: { tools: [] },
    credential_surface: [],
    floor: "seat",
    mcp_servers: [],
    lifecycle: { policy: "ephemeral" as const },
  };
}

describe("the repository is named on the RUN, not the room — repo_url is not a venue field", () => {
  it("VenueSchema rejects repo_url (a venue serves many repositories; the repository is per-run)", () => {
    // The removal, pinned. A venue that names no repository is the whole shape now; a venue that TRIES
    // to name one is rejected by `.strict()`, the same as any other undeclared key.
    expect(VenueSchema.parse(flooredRoom())).not.toHaveProperty("repo_url");
    expect(
      () => VenueSchema.parse({ ...(flooredRoom() as object), repo_url: "https://github.com/eir-labs/x.git" }),
      "a venue may not pin a repository — that would mint a venue per repository",
    ).toThrow();
    expect(() => VenueSchema.parse({ ...(flooredRoom() as object), not_a_field: 1 })).toThrow();
  });
});

describe("LAW (b): the source is explicit — the tree comes from the run's source, never from cwd", () => {
  it("populates from the run's repoUrl, and NOT from the host's working directory", async () => {
    const { run } = noopRunner();
    const { origin, marker } = seedBareRepo("came-from-the-declared-source");
    stubGitCredential();
    const gigId = "roomwsb1-0000-0000-0000-0000000000b1";
    const handle = await dockerComposeRealizer({ run }).realize(flooredRoom(), noCredentials, {
      gigId, repoUrl: origin, drainKey: "dk", instance: "box", gitCredentialsEndpoint: "https://x/api",
    });
    try {
      const ws = handle.seat!.workspace;
      // The tree came from THAT source: its committed marker is present with the source's content.
      expect(readFileSync(join(ws, "TREE_MARKER"), "utf8"), "the tree carries the run source's marker").toBe(marker);
      // …and NOT from process.cwd(): the coltrane checkout has a package.json at its root; the clone of
      // the bare repo does not. Its presence would mean the room populated from the operator's checkout.
      expect(existsSync(join(ws, "package.json")), "the room must not have populated from the host's cwd").toBe(false);
    } finally {
      await handle.teardown();
    }
  });

  it("a bogus run source FAILS ON THAT SOURCE — it does not silently substitute the host checkout", async () => {
    const { run } = noopRunner();
    stubGitCredential();
    const bogus = join(tmpdir(), "roomws-bogus-source-does-not-exist", String(process.pid));
    const gigId = "roomwsb2-0000-0000-0000-0000000000b2";
    // The refusal NAMES the source that failed (clone of <bogus> failed). It does not fall back to
    // cwd and return a handle — reaching into the operator's checkout is the failure this forecloses.
    await expect(
      dockerComposeRealizer({ run }).realize(flooredRoom(), noCredentials, {
        gigId, repoUrl: bogus, drainKey: "dk", instance: "box", gitCredentialsEndpoint: "https://x/api",
      }),
    ).rejects.toThrow(new RegExp(`clone of .*${String(process.pid)}.* failed`));
  });
});

describe("LAW (c): one mechanism — population routes through prepareWorkspace, not a second clone path", () => {
  it("the room's tree is prepared by prepareWorkspace (the drain's own function), targeted at the room's workspace", async () => {
    const { run } = noopRunner();
    const { origin } = seedBareRepo("one-mechanism");
    stubGitCredential();

    // Observe the routing without weakening it: the seam DEFAULTS to the real prepareWorkspace, and here
    // we wrap that SAME real function so its call is recorded. It is the drain's function
    // (src/workspace.ts, called at src/worker.ts) — not a parallel implementation in the realizer.
    const seen: Array<{ repoUrl: string | null | undefined; target: string | undefined }> = [];
    const prepareSpy: typeof workspace.prepareWorkspace = (o) => {
      seen.push({ repoUrl: o.repoUrl, target: o.target });
      return workspace.prepareWorkspace(o);
    };

    const gigId = "roomwsc1-0000-0000-0000-0000000000c1";
    const handle = await dockerComposeRealizer({ run, prepareWorkspace: prepareSpy }).realize(
      flooredRoom(),
      noCredentials,
      { gigId, repoUrl: origin, drainKey: "dk", instance: "box", gitCredentialsEndpoint: "https://x/api" },
    );
    try {
      // Population went through prepareWorkspace exactly once, pointed at the run source and THIS room's
      // workspace as its clone target.
      expect(seen, "prepareWorkspace is the single named mechanism the room populates through").toHaveLength(1);
      expect(seen[0]!.repoUrl, "…handed the run's source").toBe(origin);
      expect(seen[0]!.target, "…and targeted at the room's own workspace, the seat's cwd").toBe(handle.seat!.workspace);
      // And the mechanism's signature effect is present: a real clone leaves a .git directory. A second,
      // hand-rolled clone path in the realizer would not be observable on this spy.
      expect(existsSync(join(handle.seat!.workspace, ".git")), "the shared function actually cloned the tree").toBe(true);
    } finally {
      await handle.teardown();
    }
  });
});

describe("LAW (f): no repository declines to populate — an empty workspace, and no credential minted", () => {
  it("a run naming no source gets an empty workspace and mints nothing — the read-only room still works", async () => {
    const { run } = noopRunner();
    const fetchSpy = stubGitCredential();
    const gigId = "roomwsf1-0000-0000-0000-0000000000f1";
    const handle = await dockerComposeRealizer({ run }).realize(flooredRoom(), noCredentials, { gigId });
    try {
      const ws = handle.seat!.workspace;
      // The workspace still EXISTS (a read-only seat, e.g. room-prober, has a cwd) but is EMPTY: no
      // clone, so no .git and no marker.
      expect(existsSync(ws), "an unpopulated room still has a workspace directory").toBe(true);
      expect(existsSync(join(ws, ".git")), "…but it is empty — no tree was cloned in").toBe(false);
      // And NO credential was minted: prepareWorkspace was never reached, so the mint endpoint was never
      // called. Declining is not refusing, and it is certainly not an ambient fallback.
      expect(fetchSpy, "no repository → no git credential is minted").not.toHaveBeenCalled();
    } finally {
      await handle.teardown();
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// DISPATCH-PATH FAMILY — the RUN names the repository, driven through runGig (not realize() directly).
// ════════════════════════════════════════════════════════════════════════════════════════════════

const note: DomainType = {
  slug: "note", extends: "Signal", domain: "demo",
  schema: { properties: { text: { type: "string" } } }, required_fields: ["text"],
};

function dispatchSetup(): { outputs: ReturnType<typeof createOutputStore>; ledger: MemoryLedger } {
  const registry = createRegistry();
  registry.registerType(note);
  const outputs = createOutputStore(registry);
  const ledger = new MemoryLedger();
  return { outputs, ledger };
}

// A one-chair standard whose sole agent grants `grants` — enough for the policy ceiling to pass.
function oneChair(grants: string[]): Standard {
  const scout: Agent = {
    ...TEST_BEHAVIOR, slug: "scout", primitives: ["SENSE"], input_types: [], output_types: ["note"],
    domain: "demo", allowed_tools: grants,
  } as Agent;
  return {
    slug: "sense-only", domain: "demo", agents: [scout],
    phases: [{ name: "sense", chairs: [{ role: "sense", agent_slug: "scout", depends_on: [], input_contract: [], output_contract: ["note"], required_skills: [] }] }],
  };
}

function capturingInvoke(): { invoke: AgentInvoker; ctx: () => AgentInvocationContext | undefined } {
  let last: AgentInvocationContext | undefined;
  const invoke: AgentInvoker = (ctx) => { last = ctx; return { text: "a note", source: "test" }; };
  return { invoke, ctx: () => last };
}

// A floored venue whose equipment ceiling admits the chair's grant. `withServer` decides whether it
// declares an mcp_server: WITH one, realize() runs on the pre-loosening gate too (so a pre-fix run
// reaches realize and observably populates NOTHING); WITHOUT one, only the loosened gate (a run
// supplying a repository) admits it — exercising the gate change itself.
function studioVenue(withServer: boolean): Venue {
  return VenueSchema.parse({
    slug: "studio", institution_slug: "quartet",
    equipment: { tools: ["Read", "Bash"] }, credential_surface: [],
    floor: "seat",
    mcp_servers: withServer
      ? [{ slug: "room-notes", transport: "stdio", command: ["node", "notes-server.js"] }]
      : [],
    lifecycle: { policy: "ephemeral" },
  }) as unknown as Venue;
}

/** A real dockerComposeRealizer (daemon-free `run` seam) whose workspace preparer clones the LOCAL
 *  bare repo directly — no credential mint needed on the hermetic dispatch path. Records, per populate,
 *  the source, the clone target, and the marker content actually landed there; and holds every handle
 *  so a law can read `seat.workspace`. */
function capturingRealizer(): {
  venueRealizer: VenueRealizer;
  handles: () => RealizationHandle[];
  populated: () => Array<{ repoUrl: string | null | undefined; target: string | undefined; marker: string | null }>;
} {
  const run: ComposeRunner = () => {};
  const populated: Array<{ repoUrl: string | null | undefined; target: string | undefined; marker: string | null }> = [];
  const seam: WorkspacePreparer = async (o) => {
    if (!o.repoUrl) return null; // no repository named → decline, exactly as prepareWorkspace does
    const ws = workspace.cloneInto(o.repoUrl, "hermetic-unused-token", o.target);
    const markerPath = join(ws.dir, "TREE_MARKER");
    populated.push({ repoUrl: o.repoUrl, target: o.target, marker: existsSync(markerPath) ? readFileSync(markerPath, "utf8") : null });
    return ws;
  };
  const base = dockerComposeRealizer({ run, prepareWorkspace: seam });
  const handles: RealizationHandle[] = [];
  const venueRealizer: VenueRealizer = {
    ...base,
    realize: async (v, cr, o) => { const h = await base.realize(v, cr, o); handles.push(h); return h; },
  };
  return { venueRealizer, handles: () => handles, populated: () => populated };
}

describe("DISPATCH-PATH LAW: runGig with a run naming a repository populates the seat's workspace", () => {
  it("the seat's workspace carries the RUN's repository — observed empty until the dispatch path is wired", async () => {
    const { outputs, ledger } = dispatchSetup();
    const cap = capturingInvoke();
    const { venueRealizer, handles, populated } = capturingRealizer();
    const { origin, marker } = seedBareRepo("dispatched-from-the-run");
    const gigId = "d1a70000-0000-4000-8000-0000000000d1";

    const res = await runGig(oneChair(["Read"]), {}, {
      outputs, ledger, invoke: cap.invoke,
      venue: "studio", venues: new Map([["studio", studioVenue(true)]]),
      venueRealizer, repoUrl: origin, gig_id: gigId,
    });
    expect(res.status).toBe("complete");

    // PRE-FIX (RunDeps.repoUrl declared inert, but runtime.ts:1033 not yet passing it): realize() runs
    // (the venue declares a server) but populates NOTHING — `populated` stays empty, and this assertion
    // FAILS by OBSERVING an empty workspace, not by failing to typecheck. POST-FIX it holds.
    const p = populated();
    expect(p, "the room populated through prepareWorkspace exactly once for the run's repository").toHaveLength(1);
    expect(p[0]!.marker, "the seat's workspace carries the run repository's committed marker").toBe(marker);
    expect(p[0]!.repoUrl, "…from the source the RUN named").toBe(origin);
    expect(p[0]!.target, "…cloned INTO the seat's own workspace").toBe(handles()[0]!.seat!.workspace);
  });
});

describe("ONE-TO-MANY LAW: two gigs, different repositories, the SAME venue — each its own tree", () => {
  it("each gig's seat workspace carries ITS repository, and the two trees are disjoint", async () => {
    const { outputs, ledger } = dispatchSetup();
    const { venueRealizer, populated } = capturingRealizer();
    const venues = new Map([["studio", studioVenue(false)]]); // ZERO mcp_servers → only the loosened gate admits these
    const a = seedBareRepo("repository-A");
    const b = seedBareRepo("repository-B");

    const resA = await runGig(oneChair(["Read"]), {}, {
      outputs, ledger, invoke: capturingInvoke().invoke,
      venue: "studio", venues, venueRealizer, repoUrl: a.origin,
      gig_id: "a0a70000-0000-4000-8000-00000000000a",
    });
    const resB = await runGig(oneChair(["Read"]), {}, {
      outputs, ledger, invoke: capturingInvoke().invoke,
      venue: "studio", venues, venueRealizer, repoUrl: b.origin,
      gig_id: "b0b70000-0000-4000-8000-00000000000b",
    });
    expect(resA.status).toBe("complete");
    expect(resB.status).toBe("complete");

    const p = populated();
    // The property a venue-pinned repo_url cannot express: ONE venue, TWO repositories, TWO trees.
    expect(p, "each of the two gigs populated its own tree").toHaveLength(2);
    expect(p[0]!.marker, "the first gig's tree came from repository A").toBe(a.marker);
    expect(p[1]!.marker, "the second gig's tree came from repository B").toBe(b.marker);
    expect(p[0]!.target).not.toBe(p[1]!.target); // disjoint working trees, per-gig realization dirs
  });
});

describe("NO-REPOSITORY LAW (dispatch): a run naming no repository declines to populate", () => {
  it("the room's populate path is never reached — no clone, no cwd fallback", async () => {
    const { outputs, ledger } = dispatchSetup();
    const { venueRealizer, populated } = capturingRealizer();

    const res = await runGig(oneChair(["Read"]), {}, {
      outputs, ledger, invoke: capturingInvoke().invoke,
      venue: "studio", venues: new Map([["studio", studioVenue(true)]]),
      venueRealizer, gig_id: "c0c70000-0000-4000-8000-00000000000c", // NO repoUrl
    });
    expect(res.status).toBe("complete");
    // realize() ran (the venue declares a server) but the populate branch was never entered — the seam
    // clones ONLY when a source is named, so nothing was cloned and nothing fell back to the host cwd.
    expect(populated(), "no repository named → the room declines to populate").toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// DRAIN FAMILY — a Booker claim in play, driven through workOnce with a mocked store.
// ════════════════════════════════════════════════════════════════════════════════════════════════

const ENGINE_ROOM_DEF = {
  slug: "engine-room-v1", institution_slug: "demo",
  equipment: { tools: [] }, credential_surface: [],
  mcp_servers: [{ slug: "engine", transport: "stdio", command: ["engine-mcp"], credential_names: [] }],
  lifecycle: { policy: "ephemeral" },
};

const GENOME_ROWS = {
  core_types: [], domain_types: [],
  agents: [
    { slug: "scout", primitives: ["SENSE"], input_types: [], output_types: ["Signal"], domain: "demo",
      identity: "you are scout", method: "1. look 2. report 3. stop", constraints: [],
      behavioral_primitives: ["explorer", "critic"], permissions: {}, default_skills: [] },
  ],
  standards: [
    { slug: "wire-run-v0", domain: "demo", status: "active",  // the drain runs ACTIVE standards; a draft is not dispatchable
      phases: [{ name: "scan", chairs: [{ role: "scan", agent_slug: "scout", depends_on: [], input_contract: [], output_contract: ["Signal"], optional_outputs: [], required_skills: [] }] }],
      output_types: ["Signal"] },
  ],
  skills: [], evals: [],
  venues: [{ slug: "engine-room-v1", definition: ENGINE_ROOM_DEF }],
  charts: [],
};

const sealableSignal = { id: "sig-1", source: "test", data: { seen: true }, completeness: 1, acquisition_cost: 0 };

const CRED_URL = "https://store.example/git-cred";

/** Mock the org store AND the git-credential mint. Returns a counter of mints: one call to CRED_URL is
 *  one credential minted, and (per this gig's one repository) one clone. Everything else answers the
 *  drain's RPCs; the GitHub revoke DELETE on teardown falls through and is swallowed by revoke(). */
function mockStoreAndCred(claim: unknown): { mints: () => number } {
  let mints = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u === CRED_URL) { mints++; return new Response(JSON.stringify({ token: "ghs_hermetic_token" }), { status: 200 }); }
    // THE DRAIN CLAIMS THROUGH coltrane_drain_claim, NOT coltrane_mcp_claim. Which RPC workOnce calls
    // is decided by credential MODE (src/worker.ts:383): with COLTRANE_DRAIN_KEY and COLTRANE_INSTANCE
    // set — which this suite's beforeEach does, because realize()'s populate needs them — the mode is
    // "venue" and the claim goes through coltrane_drain_claim. The response must carry a `token`: the
    // store mints the bearer as part of leasing the row, and a claim without one is refused loudly at
    // worker.ts:400 rather than proceeding unauthenticated.
    if (u.endsWith("/rest/v1/rpc/coltrane_drain_claim")) {
      return new Response(JSON.stringify({ ...(claim as Record<string, unknown>), token: "ctk_drain_test" }), { status: 200 });
    }
    if (u.endsWith("/rest/v1/rpc/coltrane_mcp_gig_park")) return new Response(JSON.stringify(true), { status: 200 });
    if (u.endsWith("/rest/v1/rpc/coltrane_mcp_claim")) return new Response(JSON.stringify(claim), { status: 200 });
    if (u.endsWith("/rest/v1/rpc/coltrane_mcp_gig_outputs")) return new Response(JSON.stringify([]), { status: 200 });
    if (u.endsWith("/rest/v1/rpc/coltrane_mcp_gig_status")) return new Response(JSON.stringify(null), { status: 200 });
    if (u.endsWith("/rest/v1/rpc/coltrane_mcp_genome")) return new Response(JSON.stringify(GENOME_ROWS), { status: 200 });
    if (u.endsWith("/rest/v1/rpc/coltrane_mcp_gig_fail")) return new Response(JSON.stringify(true), { status: 200 });
    return new Response(`unexpected url ${u}`, { status: 500 });
  }));
  return { mints: () => mints };
}

// A realizer that RECORDS which rooms it was asked to build — used by the Booker-unchanged law to
// prove a venue-less claim never even reaches the room.
function recordingRealizer(): { realizer: VenueRealizer; built: () => string[] } {
  const built: string[] = [];
  const handle: RealizationHandle = { state: "PLAYING", mcpServerConfigs: {}, configPath: "", artifacts: [], teardown: () => {}, tornDown: () => true };
  const realizer = {
    substrate: "test", guarantees: [], available: () => true,
    retention: { max_cached_build_artifacts: 0, max_unreferenced_environments: 0, cadence: "gig" },
    realize: async (venue: unknown) => { built.push((venue as Venue).slug); return handle; },
  } as unknown as VenueRealizer;
  return { realizer, built: () => built };
}

const CTX = (): WorkerContext => ({
  baseUrl: "https://store.example", anonKey: "anon-key", agentToken: "ctk_test000",
  worker: "test-worker", realizableVenues: ["engine-room-v1"],
  drainKey: "dk", instance: "box",
});

describe("DRAIN — one clone / one mint per gig, and the Booker's clone kept where the room won't populate", () => {
  let stateRoot: string;
  const savedEnv: Record<string, string | undefined> = {};
  beforeEach(() => {
    vi.unstubAllGlobals();
    stateRoot = mkdtempSync(join(tmpdir(), "coltrane-roomws-drain-"));
    process.env["COLTRANE_WORKER_CHECKPOINTS"] = stateRoot;
    // realize()'s populate reads the git-credential plumbing from the ambient env — the same discipline
    // the drain uses for its own clone; the repository SOURCE is the explicit, per-run fact.
    for (const k of ["COLTRANE_DRAIN_KEY", "COLTRANE_INSTANCE", "COLTRANE_GIT_CREDENTIALS_URL"]) savedEnv[k] = process.env[k];
    process.env["COLTRANE_DRAIN_KEY"] = "dk";
    process.env["COLTRANE_INSTANCE"] = "box";
    process.env["COLTRANE_GIT_CREDENTIALS_URL"] = CRED_URL;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env["COLTRANE_WORKER_CHECKPOINTS"];
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(stateRoot, { recursive: true, force: true });
  });

  it("COLLISION LAW: a Booker claim AND a populating room mint EXACTLY ONE git credential per gig", async () => {
    // Baseline note (the owed honest caveat): the two-mint collision cannot be shown against the base
    // commit, because there the room never clones. Its two-mint baseline exists only at the INTERMEDIATE
    // state — after the room is wired to clone through realize() and BEFORE the Booker's clone at
    // worker.ts:927 is suppressed. This law pins the RESOLVED state: exactly one mint.
    const { origin } = seedBareRepo("drain-collision");
    const claim = {
      gig_id: "11111111-2222-3333-4444-555555555555", standard_slug: "wire-run-v0",
      standard_version: null, mode: "rehearsal", input: { subject: "the wire" }, acting_for: "steve-1",
      venue: "engine-room-v1", repo_url: origin,
    };
    const { mints } = mockStoreAndCred(claim);
    const { run } = noopRunner();
    const invoke = vi.fn(async () => sealableSignal);
    const res = await workOnce(CTX(), {
      makeInvoke: () => invoke as unknown as AgentInvoker,
      venueRealizer: dockerComposeRealizer({ run }),
    });
    expect(res.claimed).toBe(true);
    if (!res.claimed) throw new Error("unreachable");
    expect(res.status).toBe("complete");
    // The room populated its own tree; the Booker's clone was suppressed. One gig, one credential, one
    // clone, one live tree — not two.
    expect(mints(), "one gig → one credential mint (room populates, Booker suppressed)").toBe(1);
  });

  it("BOOKER-UNCHANGED LAW: a run naming a repository but NO room keeps the Booker's own clone", async () => {
    // A false-positive suppression would leave the drain with no tree at all — so this law drives a
    // gig with a repository and NO venue and proves the Booker still clones (one mint) and the room is
    // never even reached.
    const { origin } = seedBareRepo("booker-still-clones");
    const claim = {
      gig_id: "99999999-8888-7777-6666-555555555555", standard_slug: "wire-run-v0",
      standard_version: null, mode: "rehearsal", input: { subject: "the wire" }, acting_for: "steve-1",
      venue: null, repo_url: origin,
    };
    const { mints } = mockStoreAndCred(claim);
    const { realizer, built } = recordingRealizer();
    const invoke = vi.fn(async () => sealableSignal);
    const res = await workOnce(CTX(), {
      makeInvoke: () => invoke as unknown as AgentInvoker,
      venueRealizer: realizer,
    });
    expect(res.claimed).toBe(true);
    if (!res.claimed) throw new Error("unreachable");
    expect(res.status).toBe("complete");
    // The Booker cloned exactly once (the drain has its tree), and no room was ever built.
    expect(mints(), "no room → the Booker clones once, exactly as before this change").toBe(1);
    expect(built(), "a venue-less claim reaches no room").toEqual([]);
  });
});
