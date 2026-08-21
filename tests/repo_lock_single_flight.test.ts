// SINGLE-FLIGHT IS LAW — a per-repo dispatch lock with REJECTION as the failure mode.
//
// Today nothing stops two host-seat gigs from being dispatched against the same working tree.
// Each derives its sealed change-set from `git diff` of a tree the other is mutating, so two
// concurrent runs corrupt each other's change-set silently — the worst failure a clearing
// mechanism can have, because a participant cannot even observe that clearing failed.
//
// The contract (change c1d0c2e0): at dispatch time the engine acquires an exclusive per-repo lock
// keyed on the resolved genome root BEFORE any chair runs. A second dispatch against an
// already-held tree is REFUSED immediately with a structured error naming the holder — it does not
// queue, does not wait, does not proceed. The lock releases on every terminal outcome (complete,
// failed, aborted) and is retained through awaiting_approval.
//
// RED-first: written against an engine with NO per-repo lock (john's grep found no mutex keyed to
// the genome root), so every second dispatch below proceeds and mints a gig where the contract
// demands a refusal.
import { describe, it, expect } from "vitest";
import { dispatchTool } from "../src/server.js";
import {
  freshGenomeDir, depsFor, gate, heldInvoke, fastInvoke, pollSettled, SIGNAL, READING, twoPhaseStandard,
} from "./_support/repo_lock_fixtures.js";
import type { AgentInvoker } from "../src/index.js";

const dispatch = (deps: Parameters<typeof dispatchTool>[2], args: Record<string, unknown> = {}) =>
  dispatchTool("gig_dispatch", { standard_slug: "lock-demo", input: {}, ...args }, deps);

describe("single-flight — a second dispatch against a held tree is REFUSED, naming the holder", () => {
  it("refuses the second dispatch, names the holding gig, and never runs its chair", async () => {
    const root = freshGenomeDir();
    const g = gate();
    const dA = depsFor(root, heldInvoke(g));
    let bInvoked = 0;
    const dB = depsFor(root, async () => { bInvoked++; return { t: "hi", ...SIGNAL }; });

    const rA = await dispatch(dA);
    expect(rA.ok, String(rA.error)).toBe(true);
    const gidA = (rA.data as { gig_id: string }).gig_id;
    // A is now running against `root` (its only chair is gated) — the tree is held.

    const rB = await dispatch(dB);
    expect(rB.ok, "a second dispatch against a held tree must be refused, not run").toBe(false);
    expect(String(rB.error), "the refusal must NAME the holding gig so the operator knows who holds the tree").toContain(gidA);
    expect((rB.data as { gig_id?: string } | undefined)?.gig_id, "a refused dispatch must not mint a gig id").toBeUndefined();

    g.open();
    await pollSettled(dA, gidA);
    // The whole point: B never ran a chair, so it never touched — never git-diffed — A's tree.
    expect(bInvoked, "the refused dispatch must never run a chair; A's change-set is untouched").toBe(0);
  });
});

describe("single-flight — the lock is PER-REPO, not global", () => {
  it("refuses a same-root dispatch while a different genome root proceeds unaffected", async () => {
    const rootX = freshGenomeDir();
    const rootY = freshGenomeDir();
    const g = gate();
    const dA = depsFor(rootX, heldInvoke(g));
    const rA = await dispatch(dA);
    const gidA = (rA.data as { gig_id: string }).gig_id;

    // Same tree → refused, naming the holder.
    const rX = await dispatch(depsFor(rootX, fastInvoke));
    expect(rX.ok, "the same genome root is held — refuse").toBe(false);
    expect(String(rX.error)).toContain(gidA);

    // A DIFFERENT tree → proceeds. Unrelated repos must never block each other.
    const dY = depsFor(rootY, fastInvoke);
    const rY = await dispatch(dY);
    expect(rY.ok, "a dispatch against a DIFFERENT genome root is unaffected — the lock is per-repo").toBe(true);
    const doneY = await pollSettled(dY, (rY.data as { gig_id: string }).gig_id);
    expect(doneY["status"]).toBe("complete");

    g.open();
    await pollSettled(dA, gidA);
  });
});

describe("single-flight — a running tree is refused; every terminal outcome frees it", () => {
  it("refuses while running, then re-admits after complete, failed, and aborted", async () => {
    const root = freshGenomeDir();

    // ── while RUNNING: refused ──
    const g = gate();
    const dA = depsFor(root, heldInvoke(g));
    const rA = await dispatch(dA);
    const gidA = (rA.data as { gig_id: string }).gig_id;
    const busy = await dispatch(depsFor(root, fastInvoke));
    expect(busy.ok, "a running gig holds the tree — a second dispatch is refused").toBe(false);
    expect(String(busy.error)).toContain(gidA);
    g.open();
    expect((await pollSettled(dA, gidA))["status"]).toBe("complete");

    // ── after COMPLETE: the tree is free ──
    const dC = depsFor(root, fastInvoke);
    const rC = await dispatch(dC);
    expect(rC.ok, "a completed gig releases the tree").toBe(true);
    expect((await pollSettled(dC, (rC.data as { gig_id: string }).gig_id))["status"]).toBe("complete");

    // ── after FAILED: the tree is free ──
    const dF = depsFor(root, async () => { throw new Error("chair blew up"); });
    const rF = await dispatch(dF);
    expect((await pollSettled(dF, (rF.data as { gig_id: string }).gig_id))["status"]).toBe("failed");
    const dAfterFail = depsFor(root, fastInvoke);
    const rAfterFail = await dispatch(dAfterFail);
    expect(rAfterFail.ok, "a failed gig releases the tree").toBe(true);
    await pollSettled(dAfterFail, (rAfterFail.data as { gig_id: string }).gig_id);

    // ── after ABORTED: the tree is free ──
    const started = gate();
    const released = gate();
    const abInvoke: AgentInvoker = async (ctx) => {
      if (ctx.agent.slug === "sensor") { started.open(); await released.promise; return { t: "hi", ...SIGNAL }; }
      return { v: "read", ...READING };
    };
    const dAb = depsFor(root, abInvoke, twoPhaseStandard());
    const rAb = await dispatchTool("gig_dispatch", { standard_slug: "lock-demo-2", input: {} }, dAb);
    const gidAb = (rAb.data as { gig_id: string }).gig_id;
    await started.promise;
    await dispatchTool("gig_abort", { gig_id: gidAb, reason: "stop" }, dAb);
    released.open();
    expect((await pollSettled(dAb, gidAb))["status"]).toBe("aborted");
    const dAfterAbort = depsFor(root, fastInvoke);
    const rAfterAbort = await dispatch(dAfterAbort);
    expect(rAfterAbort.ok, "an aborted gig releases the tree").toBe(true);
    await pollSettled(dAfterAbort, (rAfterAbort.data as { gig_id: string }).gig_id);
  });
});
