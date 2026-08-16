// ════════════════════════════════════════════════════════════════════════════════════════════
// PENDING IMPLEMENTATION — this file is committed RED on purpose. See SPEC-worker-contract.md.
// A failure here is a feature not yet built. A failure in any file NOT named spec_* is a
// regression. Do not weaken these laws to make CI green; implement them.
// ════════════════════════════════════════════════════════════════════════════════════════════
//
// GAP 5 — THE CLAIM DOES NOT FILTER BY THE VENUE A GIG'S CHART ALREADY NAMES.
//
// The concept exists and is correct. `ChartSchema.venue` (src/genome_schema.ts:857) names the room
// a performance is held in, by slug; composeChart R10 refuses a dead slug or a room that starves a
// seated agent; runGig resolves and realizes it before the first chair (src/runtime.ts:924). A
// chart already says where it wants to be run.
//
// THE CLAIM DOES NOT READ IT. `claimNextGig` (src/worker.ts:319) takes ANY queued gig of the
// organization — selection is by org, well-formedness and age. There is no venue predicate on the
// row or in the claim. And the drained run does not realize the room either: workOnce passes no
// venue to runGig at all (src/worker.ts:936-943), which is Gap 2's third fact.
//
// `gig_dispatch` (src/mcp.ts:146) carries no venue, and neither queue seam
// (src/genome_store.ts:493, :527) forwards one — so even a store that WANTED to filter has nothing
// on the row to filter on until it loads and resolves the chart.
//
// THE CONSEQUENCE. A gig is claimed by a worker that cannot realize its venue. Once Gap 2 lands
// that worker fails at construction — correctly, loudly — while a worker that CAN realize the room
// sits idle. Today it is quieter and worse: the drain realizes nothing, so the room's ceiling,
// doors and credential surface are not applied to a drained run at all. Either way work cannot be
// routed, and the only way to make a gig run somewhere specific is to stop every other worker.
//
// WHAT MUST NOT HAPPEN: targeting becoming mandatory routing. A gig naming no venue stays claimable
// by anyone. The moment every dispatch needs one, a queue with no matching worker is a silently
// stalled queue — strictly worse than the state being fixed.
//
// THE IMPORT OF `venueMayClaim` IS THE SPECIFICATION. It does not exist yet; the laws that need it
// load it dynamically so they fail on their own line.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MCP_TOOLS } from "../src/mcp.js";
import { postgrestQueueGig, rpcQueueGig } from "../src/genome_store.js";
import { claimNextGig, type WorkerContext } from "../src/worker.js";

interface VenuePredicate {
  /** Total and pure, so the claim, the worker-side check and any store-side gate share ONE oracle
   *  rather than three implementations of one rule. */
  venueMayClaim?: (
    gigVenue: string | null | undefined,
    realizable: readonly string[] | undefined,
  ) => boolean;
}
const workerModule = async (): Promise<VenuePredicate> =>
  (await import("../src/worker.js")) as unknown as VenuePredicate;

const STORE = { baseUrl: "https://store.example", anonKey: "anon-key-placeholder", bearer: "eyJx.eyJy.zzz" };
const AGENT = { baseUrl: "https://store.example", anonKey: "anon-key-placeholder", agentToken: "ctk_placeholder" };

/** Venue SLUGS, in the vocabulary VenueSchema and ChartSchema.venue already use. */
const HERE = "ci-deploy-room-v1";
const ELSEWHERE = "notes-room-v1";

describe("GAP 5 — the venue a chart names travels onto the queued row", () => {
  // #234's law family: a control that is not advertised is a control nobody can set. `budget`
  // enforced a real spend ceiling and appeared in no schema, so it may as well not have existed. A
  // venue argument nothing advertises would be the same feature with the same hole. This is
  // SURFACING, not inventing — the value is a VenueSchema slug, the same one R10 already checks.
  it("gig_dispatch advertises the venue", () => {
    const def = MCP_TOOLS.find((t) => t.slug === "gig_dispatch")!;
    const input = (def.input_schema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(input), "a caller reads the schema to learn a gig can be aimed").toContain("venue");
  });

  describe("the queue seams forward it", () => {
    const fetchMock = vi.fn(async () => ({
      ok: true, status: 200, text: async () => JSON.stringify("11111111-1111-1111-1111-111111111111"),
    }) as unknown as Response);
    beforeEach(() => { vi.stubGlobal("fetch", fetchMock); fetchMock.mockClear(); });
    afterEach(() => vi.unstubAllGlobals());

    const body = (): Record<string, unknown> =>
      JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string) as Record<string, unknown>;

    // NULL, NOT ABSENT, when unnamed. An omitted key and an explicit null are different statements
    // to a store: one says "I have no opinion", the other says "this client is too old to have
    // one". `p_acting_for` is already passed this way (src/genome_store.ts:547) for exactly that
    // reason, and the argument that produced that line is the same one.
    it("the member seam sends p_venue, explicitly null when nothing names a room", async () => {
      await postgrestQueueGig(STORE)({ standard_slug: "summarize", venue: HERE });
      expect(body()["p_venue"]).toBe(HERE);
      fetchMock.mockClear();
      await postgrestQueueGig(STORE)({ standard_slug: "summarize" });
      expect(body()["p_venue"], "unnamed is a statement, not an omission").toBeNull();
    });

    // Both seams, because a host swaps them by bearer class (src/genome_store.ts:492) and a control
    // that exists on one bearer and not the other is a control whose behaviour depends on how you
    // logged in.
    it("the agent-token seam sends p_venue too", async () => {
      await rpcQueueGig(AGENT)({ standard_slug: "summarize", venue: HERE });
      expect(body()["p_venue"]).toBe(HERE);
      fetchMock.mockClear();
      await rpcQueueGig(AGENT)({ standard_slug: "summarize" });
      expect(body()["p_venue"]).toBeNull();
    });
  });
});

describe("GAP 5 — a worker claims only rooms it can realize", () => {
  // ONE ORACLE. The store decides which row a claim returns — it holds the queue and it is the only
  // thing that can. But the same rule is checked worker-side, and a rule with two implementations
  // is a rule that will be enforced two ways. `resolveAgentGrants` (src/tool_providers.ts:138)
  // exists one layer down for precisely this reason.
  it("venueMayClaim: unnamed is open to anyone, named is open to whoever can build it", async () => {
    const { venueMayClaim } = await workerModule();
    expect(venueMayClaim, "the import is the specification").toBeTypeOf("function");

    // Unnamed: any worker, including one that declares no realizable rooms at all. This is the law
    // that stops targeting from becoming mandatory routing.
    expect(venueMayClaim!(null, [HERE])).toBe(true);
    expect(venueMayClaim!(undefined, [HERE])).toBe(true);
    expect(venueMayClaim!(null, undefined)).toBe(true);
    expect(venueMayClaim!(null, [])).toBe(true);

    // Named: only a worker that can realize that room.
    expect(venueMayClaim!(HERE, [HERE])).toBe(true);
    expect(venueMayClaim!(HERE, [ELSEWHERE, HERE])).toBe(true);
    expect(venueMayClaim!(HERE, [ELSEWHERE])).toBe(false);
    // A worker that declares nothing can build nothing beyond the default, so a named room is not
    // its to take. Deny-by-default, the same way an absent venue field means the empty room.
    expect(venueMayClaim!(HERE, undefined)).toBe(false);
    expect(venueMayClaim!(HERE, [])).toBe(false);
  });

  describe("at the claim itself", () => {
    const claims: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async () => ({
      ok: true, status: 200, text: async () => JSON.stringify(claims.shift() ?? null),
    }) as unknown as Response);
    beforeEach(() => { vi.stubGlobal("fetch", fetchMock); fetchMock.mockClear(); claims.length = 0; });
    afterEach(() => vi.unstubAllGlobals());

    /** A venue-mode worker that can stand up exactly one room. */
    const ctx = (): WorkerContext => ({
      baseUrl: "https://store.example",
      anonKey: "anon-key-placeholder",
      agentToken: "",
      drainKey: "cdk_placeholder",
      instance: "my-laptop",
      realizableVenues: [HERE],
    } as WorkerContext);

    // ALL THREE CASES IN ONE LAW, deliberately. A worker that refuses a foreign room but also
    // refuses an unnamed gig has replaced one defect with a worse one — a queue nothing claims. The
    // three outcomes only mean anything together; split apart, a naive implementation satisfies each
    // in isolation and routes nothing correctly.
    //
    // The refusal is LOUD. The store deciding correctly is the primary control; this is the worker
    // declining to act on a decision it can see is wrong, and it names both sides so the operator
    // learns which is misconfigured. The consequence is the one already accepted at
    // src/worker.ts:330-339: the row stays leased until its lease expires. Stalling one row for one
    // lease window is the correct price for not running work in a room this box cannot stand up.
    it("takes an unnamed gig and one it can host, and refuses one for a room it cannot", async () => {
      claims.push({ gig_id: "g-unnamed", token: "ctk_minted", standard_slug: "summarize", venue: null });
      const unnamed = await claimNextGig(ctx());
      expect(unnamed, "an unnamed gig stays claimable by anyone").not.toBeNull();
      expect(unnamed!.gig_id).toBe("g-unnamed");

      claims.push({ gig_id: "g-mine", token: "ctk_minted", standard_slug: "summarize", venue: HERE });
      const mine = await claimNextGig(ctx());
      expect(mine, "a gig aimed at a room this worker can build is the point of aiming it").not.toBeNull();
      // The venue travels on the claim payload, so the run can realize the room the dispatch named
      // rather than inferring it from the fact that nothing refused.
      expect((mine as unknown as { venue?: string | null }).venue).toBe(HERE);

      claims.push({ gig_id: "g-foreign", token: "ctk_minted", standard_slug: "summarize", venue: ELSEWHERE });
      await expect(claimNextGig(ctx())).rejects.toThrow(
        new RegExp(`${ELSEWHERE}[\\s\\S]*${HERE}|${HERE}[\\s\\S]*${ELSEWHERE}`),
      );
    });
  });
});
