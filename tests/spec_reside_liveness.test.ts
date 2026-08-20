// RED — cortex liveness is a CONTINUING heartbeat-visible fact; a dead-hibernated residency has a
// NAMED reader; hibernation loses nothing; a presence cannot witness itself.
//
// Closes defect (6) — no_cortex was a boot check only: an hour-six cortex death leaves a presence
// that acks in reflex and never answers. Closes defect (2) — "the status makes it legible" names no
// reader; the reaper IS that reader.
//
// Covers I13 (every heartbeat carries a cortex-alive proof; a false proof fails to a visible state),
// I14 (the reaper forces a dead-hibernated residency to unseated, and the reader symbol EXISTS),
// I15 (hibernate preserves session_id/cursor/private memory; thaw resumes them), I16 (the rolodex
// split — a self-read of own impressions returns no content).
//
// RED because applyResidencyOp / reapResidency / readOwnImpressions live in the not-yet-authored
// src/residency.ts (loadResidency rejects until it exists).
import { describe, it, expect, beforeAll } from "vitest";
import fc from "fast-check";
import {
  loadResidency,
  resIn,
  canonicalOp,
  RESIDENCY_STATES,
  LIVE_STATES,
  type ResidencyModule,
} from "./spec_reside_fixtures.js";

let R: ResidencyModule;
beforeAll(async () => {
  R = await loadResidency();
});

const liveState = fc.constantFrom(...RESIDENCY_STATES.filter((s) => LIVE_STATES.has(s)));

describe("cortex liveness is proven at EVERY heartbeat, not just at boot (I13)", () => {
  it("I13 a heartbeat with a false/absent cortex proof does not succeed silently", () => {
    fc.assert(
      fc.property(liveState, (state) => {
        const rec = resIn(state);
        const r = R.applyResidencyOp(rec, { ...canonicalOp("heartbeat", rec), cortex_alive: false });
        // Either the heartbeat is refused dead_cortex, or it forces a visible-failure transition —
        // never an ok heartbeat that leaves the presence looking healthy while it cannot answer.
        if (r.ok) {
          expect(["drained", "unseated"], `an hour-six cortex death stayed invisible in ${state}`).toContain(
            r.next.status,
          );
        } else {
          expect(r.reason).toBe("dead_cortex");
        }
      }),
    );
  });

  it("I13 an hour-six death surfaces on the very next heartbeat, like an hour-zero one would", () => {
    const alive = resIn("listening");
    const ok = R.applyResidencyOp(alive, { ...canonicalOp("heartbeat", alive), cortex_alive: true });
    expect(ok.ok).toBe(true); // hour five: healthy
    const from = ok.ok ? ok.next : alive;
    const dead = R.applyResidencyOp(from, { ...canonicalOp("heartbeat", from), cortex_alive: false });
    const surfaced = dead.ok ? ["drained", "unseated"].includes(dead.next.status) : dead.reason === "dead_cortex";
    expect(surfaced, "an hour-six cortex death did not surface on the next heartbeat").toBe(true);
  });
});

describe("the reaper is the named reader for the one failure hibernation cannot hide (I14)", () => {
  it("I14 the reaper reader symbol EXISTS and is invokable", () => {
    // A dead-hibernated residency must not read as healthy because NOTHING queries it — the reader
    // must exist, the same shape defect (2) demanded be named.
    expect(typeof R.reapResidency).toBe("function");
  });

  it("I14 a hibernated residency whose heartbeat lapsed past its lease is reaped to unseated", () => {
    const dead = resIn("hibernated", { heartbeat_at: 100, lease_until: 500 });
    const now = 10_000; // well past lease_until — the heartbeat has plainly lapsed
    const r = R.reapResidency(dead, now);
    expect(r.ok, "the reaper failed to transition a dead-hibernated residency").toBe(true);
    if (r.ok) expect(r.next.status).toBe("unseated");
  });

  it("I14 a hibernated residency still within its lease is NOT reaped (reaping the living)", () => {
    const alive = resIn("hibernated", { heartbeat_at: 9_500, lease_until: 10_000 });
    const now = 9_800; // before lease_until — the seat is parked-and-cheap, not abandoned
    const r = R.reapResidency(alive, now);
    // Left untouched: either an explicit ok-with-unchanged-status, or a refusal — never unseated.
    if (r.ok) expect(r.next.status).toBe("hibernated");
  });
});

describe("hibernate loses nothing; thaw resumes the same life (I15)", () => {
  it("I15 hibernate→thaw preserves session_id, cursor, and private memory", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 99 }), (cursor) => {
        const before = resIn("listening", { cursor, session_id: "sess-keep", private_memory: { k: cursor } });
        const hib = R.applyResidencyOp(before, canonicalOp("hibernate", before));
        expect(hib.ok).toBe(true);
        if (!hib.ok) return;
        expect(hib.next.status).toBe("hibernated");
        // The durable heap survives the discarded cortex.
        expect(hib.next.session_id).toBe("sess-keep");
        expect(hib.next.cursor).toBe(cursor);
        expect(hib.next.private_memory).toEqual({ k: cursor });
        const thaw = R.applyResidencyOp(hib.next, canonicalOp("thaw", hib.next));
        expect(thaw.ok).toBe(true);
        if (thaw.ok) {
          expect(thaw.next.session_id, "thaw resumed a different session").toBe("sess-keep");
          expect(thaw.next.cursor, "thaw lost the inbox cursor").toBe(cursor);
        }
      }),
    );
  });
});

describe("the rolodex split keeps impressions private (I16)", () => {
  it("I16 a presence cannot read its OWN impressions as content — the self-read is scoped out", () => {
    const rec = resIn("listening", { private_memory: { impression_of_steve: "warm but exacting" } });
    const seen = R.readOwnImpressions(rec);
    // Sealing/reading an impression as evidence would let a presence witness itself; the self-read
    // must return no impression content.
    expect((seen as { content: unknown }).content ?? null, "a presence read its own impressions").toBeNull();
  });
});
