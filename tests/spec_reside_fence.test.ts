// RED — THE FENCE: a held seat is gripped by a monotonic token, and the loop actually PRESENTS it.
//
// THE FINDING BEHIND THIS FILE, and it is the more valuable half of WI-3. The engine has declared a
// fence since the state machine landed: `fence` is a residency row field (src/residency.ts:131),
// applyResidencyOp refuses `stale_fence` (:268), and law I9 covers it with a case literally named
// "a GC-paused old host resuming post-lease presents a stale token". Two things were true anyway:
//
//   1. THE STORE NEVER HAD THE COLUMN. residency.coltrane_residency carried no `fence` at all
//      (measured by the WI-2 lane on its own schema). The engine has been refusing stale_fence
//      against a field nothing persisted.
//   2. THE LOOP NEVER PRESENTED ONE. Every applyResidencyOp call in src/reside.ts omitted op.fence,
//      and the check reads `if (op.fence !== undefined && op.fence < rec.fence)` — so it
//      short-circuited on undefined at all six call sites. I9 could not fire on the live path.
//
// Neither side could have found this alone: one had the invariant and no schema, the other had the
// schema and had never read the invariant. A law with eleven passing cases and nothing setting the
// field it gates is this repo's named defect, and it survived two green suites.
import { describe, it, expect } from "vitest";
import { readFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadReside, recordingDeps, leaseClaim, msg, type ResideModule } from "./spec_reside_loop_fixtures.js";
import { loadResidency, resIn } from "./spec_reside_fixtures.js";

const SEED = { agent_slug: "agent.viola", org: "org.house", venue_slug: "venue.studio", channel_id: "chan.parlor" };
const RESIDE_SRC = readFileSync(join(new URL("../src/", import.meta.url).pathname, "reside.ts"), "utf8");

describe("claim mints the fence; the three doors carry it", () => {
  it("a claim hands back a fence, and the doors accept it", async () => {
    const R: ResideModule = await loadReside();
    const root = mkdtempSync(join(tmpdir(), "fence-"));
    const seat = R.fileSeatBacking(root);
    const id = await R.fileSeatSeed(root, SEED);
    const claim = await seat.claim("any");
    const fence = String(claim?.fence);
    expect(fence, "a claim handed back no fence").toBeTruthy();

    await seat.heartbeat(id, fence);
    expect(await seat.cursorAdvance(id, fence, 2)).toBe(2);
    await seat.release(id, fence, "hibernated");
  });

  it("a LOWER fence is refused stale_fence on all three doors — same box, same name", async () => {
    const R: ResideModule = await loadReside();
    const root = mkdtempSync(join(tmpdir(), "fence-"));
    const seat = R.fileSeatBacking(root);
    const id = await R.fileSeatSeed(root, SEED);
    await seat.claim("any");
    await seat.release(id, "1", "hibernated");
    await seat.claim("any"); // fence is now 2; "1" is a resurrected host

    // Nothing but the token can tell these apart — the instance name is identical, which is exactly
    // the collision the fence exists to make fail rather than resolve.
    await expect(seat.heartbeat(id, "1")).rejects.toThrow(/stale_fence/);
    await expect(seat.cursorAdvance(id, "1", 9)).rejects.toThrow(/stale_fence/);
    await expect(seat.release(id, "1", "hibernated")).rejects.toThrow(/stale_fence/);
  });

  it("a release does NOT reset the fence — zeroing it revives the token it exists to kill", async () => {
    const R: ResideModule = await loadReside();
    const root = mkdtempSync(join(tmpdir(), "fence-"));
    const seat = R.fileSeatBacking(root);
    const id = await R.fileSeatSeed(root, SEED);
    const first = await seat.claim("any");
    await seat.release(id, String(first?.fence), "hibernated");
    const second = await seat.claim("any");

    // The bug this catches is real and was found in the store's own implementation of the mechanism
    // this one replaced: clearing the token on release is correct for a SECRET and a defect for a
    // FENCE, because it makes a resurrected host's old token valid again.
    expect(Number(second?.fence), "the fence did not outrank the grant before it")
      .toBeGreaterThan(Number(first?.fence));
    await expect(seat.heartbeat(id, String(first?.fence))).rejects.toThrow(/stale_fence/);
  });
});

describe("THE LOOP PRESENTS THE FENCE — I9 is reachable on the live path", () => {
  it("every applyResidencyOp the loop issues carries a fence", () => {
    // Structural, and it has to be: applyResidencyOp reads `op.fence !== undefined` first, so an op
    // that omits the field is not gated at all. Six call sites shipped without one, and no
    // behavioural test could see it, because the loop's own record was the only thing it compared
    // against. This law counts the call sites and requires every one to present a token.
    const calls = [...RESIDE_SRC.matchAll(/applyResidencyOp\(\s*rec,\s*\{([^}]*)\}/g)].map((m) => m[1]!);
    expect(calls.length, "no applyResidencyOp call sites found — the regex missed the loop").toBeGreaterThan(3);
    const unfenced = calls.filter((args) => !/\bfence\s*:/.test(args)).map((a) => a.trim().slice(0, 48));
    expect(unfenced, "an op reaches the state machine with no fence, so I9 cannot gate it").toEqual([]);
  });

  it("the loop carries the claim's fence onto its record, not a zero", async () => {
    const R: ResideModule = await loadReside();
    const { deps, calls } = recordingDeps({ claim: async () => leaseClaim({ fence: "7" }) });
    const r = R.createResidency({ residency: "any" }, deps);
    await r.boot();
    await r.beat();
    // The seat resumed at fence 7; a loop that reset to 0 would present a stale token on its very
    // first heartbeat and be refused by a store that is working correctly.
    expect(String(calls.heartbeatArgs[0]?.[1]), "the loop presented a fence the claim did not give it").toBe("7");
  });

  it("I9 itself still refuses a resurrected host (the law the field was always for)", async () => {
    const Res = await loadResidency();
    const rec = resIn("listening", { fence: 5 });
    const stale = Res.applyResidencyOp(rec, { kind: "heartbeat", fence: 3, cortex_alive: true });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.reason).toBe("stale_fence");
  });
});
