// lease.ts — the hosted drain's lease, as ONE number and ONE pair of routes.
//
// The store leases a claimed row for HOSTED_LEASE_MS and hands it to the next claimer when the lease
// lapses. Two engine mechanisms depend on that number, and both are DERIVED from it here rather than
// restating it:
//   * the heartbeat renews every HOSTED_LEASE_MS / 3 (src/worker.ts), so two renewals can be lost in a
//     row before the lease lapses;
//   * the drain's default run timeout (drainTimeoutMs, src/run_deps.ts) stays under one lease, so a run
//     stops before its lease could lapse even if not one renewal ever landed.
// The engine used to hold this number as prose ("the store's lease is thirty minutes") while the store
// held sixty. A number in a comment cannot fail; this one is pinned by
// tests/gig_runs_once_lease_constant.test.ts, which moves it and watches both derivations follow.
//
// The lease RPCs are the drain SERVICE's doors (eir-labs/coltrane-ui, work/gig-runs-once). The route
// fills p_token from the bearer and p_instance from X-Coltrane-Instance, so the instance travels in ONE
// place: never also in a body. A store-side rename is a one-line change to DRAIN_LEASE_ROUTES.
import { drainServicePost, DrainWriteError } from "./output_mirror.js";

/** The store's lease on a claimed row: sixty minutes. */
export const HOSTED_LEASE_MS = 60 * 60 * 1000;

/** The drain service's lease doors. */
export const DRAIN_LEASE_ROUTES = {
  renew: "/rest/v1/rpc/coltrane_drain_renew",
  release: "/rest/v1/rpc/coltrane_drain_release",
} as const;

// The derivations are computed AT THEIR CALL SITES from the imported binding, never through a helper
// here: a helper in this module reads this module's own binding, so a consumer would follow a moved
// constant only by accident of how it was moved.

/** Raised (as an abort reason) when the store says this worker no longer holds the gig. */
export class LeaseLost extends Error {
  constructor(readonly gig_id: string, readonly detail: string) {
    super(`lease lost on gig ${gig_id}: ${detail} — the gig is another worker's now; this worker stops and writes nothing terminal`);
    this.name = "LeaseLost";
  }
}

/** Who is speaking to the lease doors: the venue credential and the instance it is bound to. */
export interface LeaseCredential {
  drainKey: string;
  instance: string | undefined;
}

export type RenewOutcome =
  | { ok: true }
  /** The store refused: the lease is not this worker's (403 / 42501), or the row is not running. */
  | { ok: false; lost: true; detail: string }
  /** A transport or 5xx failure: the lease may still be held; try again next beat. */
  | { ok: false; lost: false; detail: string };

/** Renew the lease on a running gig. Never throws. */
export async function renewLease(gig_id: string, cred: LeaseCredential): Promise<RenewOutcome> {
  try {
    await drainServicePost(DRAIN_LEASE_ROUTES.renew, cred.drainKey, { p_gig_id: gig_id }, cred.instance);
    return { ok: true };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    if (e instanceof DrainWriteError && e.refused) return { ok: false, lost: true, detail };
    return { ok: false, lost: false, detail };
  }
}

/**
 * Give a leased gig back. Non-terminal returns it to the queue for a box that can run it; terminal
 * fails it, carrying `reason` as its error. Speaks through the VENUE credential, the one the box always
 * holds, so it works exactly where a per-gig credential was never minted. Never throws: the answer is
 * whether the store recorded it, and why not.
 */
export async function releaseLease(
  gig_id: string,
  reason: string,
  terminal: boolean,
  cred: LeaseCredential,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  try {
    await drainServicePost(
      DRAIN_LEASE_ROUTES.release,
      cred.drainKey,
      { p_gig_id: gig_id, p_reason: reason, p_terminal: terminal },
      cred.instance,
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}
