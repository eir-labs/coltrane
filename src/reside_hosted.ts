// reside_hosted.ts — THE HOSTED SEAT IS A DOOR (WI-9 M1; conformance lib-caps RS-5).
//
// The `SeatBacking` port (reside_backing.ts) has a local file roster and a module seam; the hosted
// backing was "supplied by the deployment" and no deployment ever supplied one — nothing in the engine
// called residency.* (measured 4 Oct 2026). This is that provider: the four box doors of the residency
// schema, reached over PostgREST through their PUBLIC wrappers (coltrane-ui migration 20261004090000 —
// the `residency` schema itself is not exposed over the wire), under the box's venue credential:
// COLTRANE_DRAIN_KEY (the cdk_ the sovereign minted for this instance) + COLTRANE_INSTANCE. The wall is
// the store's: the doors check the key and the instance themselves and refuse by name (not_holder,
// stale_fence, gig_scoped_token…); this module carries their words up unchanged and never flattens a
// refusal into a null claim.
//
// THE FENCE crosses the seam as the store's type. The engine carries `fence` as an opaque string
// (ResidencyClaim.fence: "carried unread … never parses, orders, or prints it"); the store's doors take
// `p_fence bigint`. The conversion happens HERE and nowhere else: a fence that is not a whole number is
// refused by name (bad_fence) before any call — the engine never guesses what the store meant.
import type { ResidencyClaim } from "./reside.js";
import type { SeatBacking } from "./reside_backing.js";

export interface HostedSeatContext {
  baseUrl: string;
  anonKey: string;
  /** The venue credential (cdk_…) minted for this instance — never a member JWT, never an agent token. */
  key: string;
  /** The instance the key is bound to (COLTRANE_INSTANCE; FLY_APP_NAME is its legacy alias). */
  instance: string;
}

/** The public doors, by name. One place: a renamed wrapper is a one-line edit here and a red law. */
export const HOSTED_SEAT_DOORS = {
  claim: "coltrane_residency_claim",
  heartbeat: "coltrane_residency_heartbeat",
  release: "coltrane_residency_release",
  cursorAdvance: "coltrane_residency_cursor_advance",
} as const;

function fenceOrRefuse(fence: string): number {
  if (!/^\d+$/.test(fence)) {
    throw new Error(`bad_fence: the fence "${fence}" is not a whole number — the store's doors take a bigint fence; claim again rather than guess`);
  }
  return Number(fence);
}

async function door(ctx: HostedSeatContext, name: string, body: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${ctx.baseUrl}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { apikey: ctx.anonKey, Authorization: `Bearer ${ctx.anonKey}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ p_key: ctx.key, p_instance: ctx.instance, ...body }),
  });
  const text = await res.text();
  if (!res.ok) {
    let message = text || `store error ${res.status}`;
    try {
      const parsed = JSON.parse(text) as { message?: string };
      if (parsed.message) message = parsed.message;
    } catch { /* keep the raw text */ }
    // the store's refusal names lead the message ("not_holder: …", "stale_fence: …"); they ride up as-is
    throw new Error(`${name} ${res.status}: ${message}`);
  }
  return text ? (JSON.parse(text) as unknown) : null;
}

/** The store's claim row → the engine's ResidencyClaim. Keys as 20260904120000's claim returns them. */
export function claimFromRow(row: Record<string, unknown>): ResidencyClaim {
  const str = (k: string): string => (typeof row[k] === "string" ? (row[k] as string) : String(row[k] ?? ""));
  const list = (k: string): string[] => (Array.isArray(row[k]) ? (row[k] as unknown[]).map(String) : []);
  const claim: ResidencyClaim = {
    residency_id: str("residency_id"),
    agent_slug: str("agent_slug"),
    org: str("org_id"),
    venue_slug: str("venue_slug"),
    channel_id: str("channel_id"),
    session_id: typeof row["session_id"] === "string" ? (row["session_id"] as string) : null,
    cursor: Number(row["cursor"] ?? 0),
    lease_token: str("token"),
    hands: list("hands"),
    may_dispatch: list("may_dispatch"),
  };
  if (row["fence"] !== undefined && row["fence"] !== null) claim.fence = String(row["fence"]);
  if (row["gig_id"] !== undefined) claim.gig_id = row["gig_id"] === null ? null : String(row["gig_id"]);
  return claim;
}

/** The hosted SeatBacking: four doors, one credential, the store's words. */
export function postgrestSeatBacking(ctx: HostedSeatContext): SeatBacking {
  return {
    claim: async (which) => {
      const out = await door(ctx, HOSTED_SEAT_DOORS.claim, { p_residency_id: which === "any" ? null : which });
      if (out === null || typeof out !== "object") return null;
      const row = out as Record<string, unknown>;
      if (!row["residency_id"]) return null;
      return claimFromRow(row);
    },
    heartbeat: async (residencyId, fence) => {
      await door(ctx, HOSTED_SEAT_DOORS.heartbeat, { p_residency_id: residencyId, p_fence: fenceOrRefuse(fence) });
    },
    release: async (residencyId, fence, status) => {
      await door(ctx, HOSTED_SEAT_DOORS.release, { p_residency_id: residencyId, p_fence: fenceOrRefuse(fence), p_status: status });
    },
    cursorAdvance: async (residencyId, fence, n) => {
      const out = await door(ctx, HOSTED_SEAT_DOORS.cursorAdvance, { p_residency_id: residencyId, p_fence: fenceOrRefuse(fence), p_cursor: n });
      return typeof out === "number" ? out : Number(out ?? n);
    },
  };
}

/** The hosted backing from the drain environment, or the reason there is none. The same five names
 *  DRAIN_VARS marks as "hosted" (local_queue.ts); FLY_APP_NAME is COLTRANE_INSTANCE's legacy alias. */
export function hostedSeatBackingFromEnv(env: Record<string, string | undefined>): { ok: true; seat: SeatBacking } | { ok: false; missing: string[] } {
  const baseUrl = env["COLTRANE_STORE_URL"];
  const anonKey = env["COLTRANE_STORE_ANON"];
  const key = env["COLTRANE_DRAIN_KEY"];
  const instance = env["COLTRANE_INSTANCE"] ?? env["FLY_APP_NAME"];
  const missing = [
    !baseUrl ? "COLTRANE_STORE_URL" : null,
    !anonKey ? "COLTRANE_STORE_ANON" : null,
    !key ? "COLTRANE_DRAIN_KEY" : null,
    !instance ? "COLTRANE_INSTANCE" : null,
  ].filter((x): x is string => x !== null);
  if (missing.length) return { ok: false, missing };
  return { ok: true, seat: postgrestSeatBacking({ baseUrl: baseUrl!, anonKey: anonKey!, key: key!, instance: instance! }) };
}
