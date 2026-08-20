// A terminal gig should say WHAT it produced, without anyone opening the ledger — and should say it
// by POINTING, never by copying.
//
// THE GAP. `list()` reports `complete` and stops there. An operator watching a local drain sees a
// finished gig and still cannot tell what the work concluded; the only way to find out is to go read
// the sealed outputs somewhere else. `status` answers "did the machine finish", and nothing on the
// row answers "what did the work determine".
//
// WHY NOT JUST PUT THE VERDICT ON THE ROW. Because those are two different axes and collapsing them
// destroys the distinction that matters most:
//
//     status  = did the machine finish?      queued · claimed · complete · failed
//     verdict = what did the work conclude?  pass · fail
//
// A gig that runs perfectly and concludes "this change is bad" is status:complete, verdict:fail.
// Fold them together and "the drain broke" becomes indistinguishable from "the reviewer said no" —
// and those demand opposite responses (page someone / merge nothing). So `state` keeps meaning the
// lifecycle, and the outcome arrives as a SEPARATE field.
//
// AND IT IS A POINTER, NOT A COPY. `content_sha` is already computed by complete() and already the
// identity of the sealed output. Restating the judgment on the row would be a second statement of
// one fact — the exact defect class that cost this repo twice in one day: package.json vs
// src/version.ts (a version nobody bumped), and coltrane_organization.repo_url vs the typed input (a
// repo the gig already carried). A pointer cannot drift from what it points at.
import { describe, it, expect, afterAll } from "vitest";
import { loadLocalQueue, freshRoot, cleanupRoots } from "./spec_local_queue_fixtures.js";

afterAll(cleanupRoots);
const LEASE_MS = 1000;

describe("a terminal gig points at the output it sealed", () => {
  it("O1 — a completed gig's view carries the SAME content_sha complete() returned", async () => {
    const { openLocalQueue } = await loadLocalQueue();
    const q = openLocalQueue(freshRoot(), { leaseMs: LEASE_MS });
    const { gig_id } = await q.enqueue({ standard_slug: "s", input: {}, acting_for: "a" });
    await q.claim("w1");
    const sealed = await q.complete("w1", gig_id, { verdict: "fail", why: "the laws are red" });

    const view = q.list().find((v) => v.gig_id === gig_id)!;
    expect(view.state).toBe("complete");
    // The identity of the seal, not a re-derivation of it: same value the seal returned.
    expect(view.content_sha).toBe(sealed.content_sha);
  });

  it("O2 — `complete` does NOT mean `passed`: the two axes stay separate", async () => {
    // The whole reason the outcome is a separate field. This gig ran perfectly and concluded FAIL.
    // An operator must be able to tell that from a gig whose DRAIN broke — they need opposite
    // responses. If `state` alone had to carry both, one of them would be unrepresentable.
    const { openLocalQueue } = await loadLocalQueue();
    const q = openLocalQueue(freshRoot(), { leaseMs: LEASE_MS });
    const ran = await q.enqueue({ standard_slug: "s", input: {}, acting_for: "a" });
    await q.claim("w1");
    await q.complete("w1", ran.gig_id, { verdict: "fail" });

    const broke = await q.enqueue({ standard_slug: "s", input: {}, acting_for: "a" });
    await q.claim("w1");
    await q.fail("w1", broke.gig_id, "the drain threw");

    const ranView = q.list().find((v) => v.gig_id === ran.gig_id)!;
    const brokeView = q.list().find((v) => v.gig_id === broke.gig_id)!;
    expect(ranView.state).toBe("complete"); // the work finished…
    expect(ranView.content_sha).toBeDefined(); // …and sealed something to point at
    expect(brokeView.state).toBe("failed"); // the machine did not finish…
    expect(brokeView.content_sha).toBeUndefined(); // …so there is nothing to point at
  });

  it("O3 — a gig still in flight points at nothing: absent, never a placeholder", async () => {
    // "Absent must mean DECLINE, never quietly stand in." A default sha here would be a pointer to
    // an output that does not exist — worse than no answer, because it reads like one.
    const { openLocalQueue } = await loadLocalQueue();
    const q = openLocalQueue(freshRoot(), { leaseMs: LEASE_MS });
    const { gig_id } = await q.enqueue({ standard_slug: "s", input: {}, acting_for: "a" });
    expect(q.list().find((v) => v.gig_id === gig_id)!.content_sha).toBeUndefined();
    await q.claim("w1");
    expect(q.list().find((v) => v.gig_id === gig_id)!.content_sha).toBeUndefined();
  });

  it("O4 — the pointer survives a re-completion and never forks", async () => {
    // Re-completing with the same output dedups (I14); the row must still point at the one seal.
    const { openLocalQueue } = await loadLocalQueue();
    const q = openLocalQueue(freshRoot(), { leaseMs: LEASE_MS });
    const { gig_id } = await q.enqueue({ standard_slug: "s", input: {}, acting_for: "a" });
    await q.claim("w1");
    const output = { verdict: "pass" };
    const first = await q.complete("w1", gig_id, output);
    const second = await q.complete("w1", gig_id, output);
    expect(second.duplicated).toBe(true);
    expect(q.list().find((v) => v.gig_id === gig_id)!.content_sha).toBe(first.content_sha);
  });

  it("O5 — the sha is the seal's own identity, so identical outputs point identically", async () => {
    // Not a per-row random id: two gigs sealing the same output carry the same pointer, which is
    // what makes the pointer a content address rather than a label.
    const { openLocalQueue } = await loadLocalQueue();
    const q = openLocalQueue(freshRoot(), { leaseMs: LEASE_MS });
    const output = { verdict: "pass", n: 1 };
    const a = await q.enqueue({ standard_slug: "s", input: {}, acting_for: "a" });
    await q.claim("w1");
    const sa = await q.complete("w1", a.gig_id, output);
    const b = await q.enqueue({ standard_slug: "s", input: {}, acting_for: "a" });
    await q.claim("w1");
    const sb = await q.complete("w1", b.gig_id, output);
    expect(sb.content_sha).toBe(sa.content_sha);
    const views = q.list().filter((v) => v.content_sha !== undefined);
    expect(new Set(views.map((v) => v.content_sha)).size).toBe(1);
  });
});
