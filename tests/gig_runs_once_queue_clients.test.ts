// Q1/Q2 — THE ENGINE'S OWN QUEUE CLIENTS NEVER DROP WHAT THE HOSTED DOOR COMPUTED.
// (docs/specs/gig-runs-once.red-spec.json)
//
// The hosted gig_dispatch door now forwards `resumes` (G4, H1) and `budget_micro_usd` (H5,
// coltrane-ui #253) to deps.queueGig. coltrane-ui's own host wires queueGig to its app-side
// dispatchGig (src/lib/dispatch.ts at work/host-carries-the-gig). That function takes `resumes` and
// `budget_micro_usd` verbatim and writes coltrane_gigs directly. But the engine ships two queue
// clients of its own, for any engine-hosted surface: postgrestQueueGig and rpcQueueGig
// (src/genome_store.ts). They build a fixed p_* body for the coltrane_gig_dispatch /
// coltrane_mcp_dispatch RPCs and carry neither field. So through them, the link and the ceiling the
// door just computed are dropped silently: a fresh, unlinked, unbounded gig.
//
// WHAT THE STORE ACCEPTS, read at work/host-carries-the-gig: NEITHER RPC takes a resumes or a budget
// parameter. No migration there touches either signature, and coltrane-ui's dispatch.ts calls both
// "left in place, simply off the path". PostgREST resolves an RPC by its exact set of argument names,
// so an extra p_ key does not reach a function that lacks it: that was the 0.24.12 p_venue outage. The
// law therefore does not demand one wire shape. It demands NO SILENT DROP. A client handed `resumes`
// or `budget_micro_usd` either
//   (a) sends it to the store (p_resumes / p_budget_micro_usd, the store's parameter spelling), or
//   (b) refuses by name, before sending anything, because its RPC cannot carry it,
// and never posts a dispatch without it. When the field is absent, no key is sent, so a plain
// dispatch keeps the exact argument set the deployed RPCs resolve.
import { describe, it, expect, afterEach, vi } from "vitest";
import { postgrestQueueGig, rpcQueueGig } from "../src/genome_store.js";

type Client = (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
const CLIENTS: Array<[string, () => Client]> = [
  ["postgrestQueueGig (member JWT → coltrane_gig_dispatch)", () => postgrestQueueGig({ baseUrl: "https://store.example", anonKey: "anon-key", bearer: "eyJx.eyJy.zzz" })],
  ["rpcQueueGig (agent token → coltrane_mcp_dispatch)", () => rpcQueueGig({ baseUrl: "https://store.example", anonKey: "anon-key", agentToken: "ctk_agent" })],
];

function recordFetch(): Array<Record<string, unknown>> {
  const bodies: Array<Record<string, unknown>> = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return new Response(JSON.stringify("new-gig-uuid"), { status: 200 });
  }));
  return bodies;
}

afterEach(() => vi.unstubAllGlobals());

const FIELDS: Array<[string, unknown, string, RegExp]> = [
  ["resumes", "abababab-1111-2222-3333-cdcdcdcdcdcd", "p_resumes", /resumes/],
  ["budget_micro_usd", 12_000_000, "p_budget_micro_usd", /budget/],
];

describe("Q1 — a queue client handed `resumes` / `budget_micro_usd` sends it or refuses it by name; it never drops it", () => {
  for (const [clientName, make] of CLIENTS) {
    for (const [field, value, param, named] of FIELDS) {
      it(`Q1 ${clientName}: \`${field}\` reaches the store as ${param}, or the client refuses by name before sending`, async () => {
        const bodies = recordFetch();
        const outcome = await make()({ standard_slug: "scan-v1", input: {}, [field]: value }).then(
          () => ({ sent: true as const }),
          (e: unknown) => ({ sent: false as const, error: e instanceof Error ? e.message : String(e) }),
        );
        if (outcome.sent) {
          expect(bodies.length).toBe(1);
          expect(bodies[0]![param], `${clientName} posted the dispatch WITHOUT \`${field}\`: a silent drop`).toEqual(value);
        } else {
          expect(outcome.error, `${clientName} refused, but not by naming \`${field}\``).toMatch(named);
          expect(bodies.length, `${clientName} refused only after posting a dispatch without \`${field}\``).toBe(0);
        }
      });
    }
  }
});

describe("Q2 — absent means no key: a plain dispatch keeps the argument set the deployed RPCs resolve", () => {
  for (const [clientName, make] of CLIENTS) {
    it(`Q2 ${clientName}: no resumes and no budget → neither p_resumes nor p_budget_micro_usd is sent`, async () => {
      const bodies = recordFetch();
      await make()({ standard_slug: "scan-v1", input: {} });
      expect(bodies.length).toBe(1);
      expect(Object.keys(bodies[0]!).filter((k) => k === "p_resumes" || k === "p_budget_micro_usd"),
        "an absent field was sent as a key; PostgREST would then look for a signature the store does not have").toEqual([]);
    });
  }
});
