// ════════════════════════════════════════════════════════════════════════════════════════════
// PENDING IMPLEMENTATION — committed RED on purpose. See docs/specs/SPEC-local-queue-contract.md.
// A failure here is a feature not yet built (`src/local_queue.ts`); a failure in any file NOT named
// spec_* is a regression. Do not weaken these laws to make CI green; implement them.
// ════════════════════════════════════════════════════════════════════════════════════════════
//
// ENQUEUE, BACKING-SELECTION, and OFFLINE for the local file-backed gig queue.
//
// The asymmetry this closes (grounding c1): the genome port ships a LOCAL sibling
// (fileGenomeStore, genome_store.ts:77) but the QUEUE port ships only postgrestQueueGig
// (genome_store.ts:532) and rpcQueueGig (:493) — both HTTP. deps.queueGig (server.ts:3062) has no
// file backing to plug in, so hosted gig_dispatch with no seam returns the typed hosted_unsupported
// refusal at server.ts:3215. These laws pin the file sibling's SURFACE: its enqueue result is
// byte-indistinguishable from the HTTP seams', it persists a queued row, distinct enqueues never
// collide, the backing is chosen from a SINGLE selector by environment presence, and the whole path
// touches no network and reads none of the drain's five credential variables.
import { describe, it, expect, afterAll, vi } from "vitest";
import * as fs from "node:fs";
import { join } from "node:path";
import {
  loadLocalQueue,
  freshRoot,
  cleanupRoots,
  gigPayloadArb,
} from "./spec_local_queue_fixtures.js";
import fc from "fast-check";
import type { ToolSurfaceDeps } from "../src/server.js";

afterAll(cleanupRoots);

describe("local queue — enqueue is the file sibling of deps.queueGig (I1, I2, I15)", () => {
  // I1 — RETURN-SHAPE INDISTINGUISHABILITY. postgrestQueueGig and rpcQueueGig both return exactly
  // {gig_id, status:'queued'} (genome_store.ts:525,:568). A caller must not be able to tell which
  // backing answered, so the file seam returns the SAME two keys and nothing more.
  it("I1 returns exactly {gig_id, status:'queued'} for any well-formed payload", async () => {
    const { fileQueueGig } = await loadLocalQueue();
    const enqueue = fileQueueGig(freshRoot());
    await fc.assert(
      fc.asyncProperty(gigPayloadArb, async (payload) => {
        const out = await enqueue(payload);
        expect(Object.keys(out).sort(), "an extra field lets a caller discriminate the backing")
          .toEqual(["gig_id", "status"]);
        expect(typeof out["gig_id"]).toBe("string");
        expect((out["gig_id"] as string).length).toBeGreaterThan(0);
        expect(out["status"]).toBe("queued");
      }),
    );
  });

  // I1, wired — the file seam must be assignable exactly where deps.queueGig plugs in
  // (server.ts:3062). This is a TYPE-LEVEL law: if fileQueueGig's return type ever drifts from the
  // queueGig seam shape, tsc fails here, before the byte comparison ever runs.
  it("I1 the seam is assignable to ToolSurfaceDeps.queueGig", async () => {
    const { fileQueueGig } = await loadLocalQueue();
    const seam: ToolSurfaceDeps["queueGig"] = fileQueueGig(freshRoot());
    expect(seam, "the file seam must fit the same optional slot the HTTP seams do").toBeTypeOf("function");
  });

  // I2 — a returned gig_id names a row that actually exists in the queued state and reads back.
  it("I2 after enqueue the gig_id is a readable queued row", async () => {
    const { openLocalQueue } = await loadLocalQueue();
    const q = openLocalQueue(freshRoot());
    await fc.assert(
      fc.asyncProperty(gigPayloadArb, async (payload) => {
        const { gig_id } = await q.enqueue(payload);
        // read-back through the claim path is the only public reader; a claim of the just-enqueued
        // row must return THAT row (existence + readability in one assertion).
        const claimed = await q.claim("reader");
        expect(claimed, "an enqueued gig_id that no worker can claim is a row that does not exist")
          .not.toBeNull();
        expect(claimed!.gig_id).toBe(gig_id);
      }),
      { numRuns: 25 },
    );
  });

  // I15 — enqueue identity is unique-by-name (maildir time.pid.host lineage): N distinct enqueues
  // yield N distinct gig_ids and N distinct rows, never a collision.
  it("I15 distinct enqueues never collide on gig_id", async () => {
    const { openLocalQueue } = await loadLocalQueue();
    await fc.assert(
      fc.asyncProperty(fc.array(gigPayloadArb, { minLength: 2, maxLength: 12 }), async (payloads) => {
        const q = openLocalQueue(freshRoot());
        const ids = new Set<string>();
        for (const p of payloads) ids.add((await q.enqueue(p))["gig_id"] as string);
        expect(ids.size, "two enqueues collided on identity").toBe(payloads.length);
      }),
      { numRuns: 20 },
    );
  });
});

describe("local queue — backing is chosen from ONE selector by environment presence (I16, F2)", () => {
  const LOCAL = { COLTRANE_QUEUE_DIR: "/tmp/coltrane-queue" };
  const HOSTED = {
    COLTRANE_STORE_URL: "https://store.example",
    COLTRANE_STORE_ANON: "anon-placeholder",
    COLTRANE_DRAIN_URL: "https://coltrane.example",
    COLTRANE_DRAIN_KEY: "cdk_placeholder",
    COLTRANE_INSTANCE: "my-laptop",
  };

  // I16 — the local queue dir present, all five drain vars absent → the FILE backing.
  it("I16 local dir present, drain vars absent ⇒ file backing", async () => {
    const { selectQueueBacking, LOCAL_QUEUE_DIR_VAR } = await loadLocalQueue();
    const choice = selectQueueBacking({ [LOCAL_QUEUE_DIR_VAR]: "/tmp/coltrane-queue" });
    expect(choice.backing).toBe("file");
    expect((choice as { root: string }).root).toBe("/tmp/coltrane-queue");
  });

  // F2 — both a local dir AND a hosted environment present is AMBIGUOUS. Refuse typed; never
  // silently pick one, or the two front doors disagree about which backing owns the gig.
  it("F2 local dir AND hosted env present ⇒ typed conflict, not a silent pick", async () => {
    const { selectQueueBacking } = await loadLocalQueue();
    const choice = selectQueueBacking({ ...LOCAL, ...HOSTED });
    expect(choice.backing, "an ambiguous backing must refuse, not choose").toBe("conflict");
    expect((choice as { why: string }).why.length).toBeGreaterThan(20);
  });

  // The good hosted case, so the conflict law cannot pass by refusing everything.
  it("I16 hosted env present, no local dir ⇒ hosted backing", async () => {
    const { selectQueueBacking } = await loadLocalQueue();
    expect(selectQueueBacking(HOSTED).backing).toBe("hosted");
  });

  // Neither present ⇒ a refusal that says what is missing.
  it("F2 neither backing present ⇒ typed none with a reason", async () => {
    const { selectQueueBacking } = await loadLocalQueue();
    const choice = selectQueueBacking({});
    expect(choice.backing).toBe("none");
    expect((choice as { why: string }).why.length).toBeGreaterThan(20);
  });
});

describe("local queue — the local path reads NO drain credential (F8, c2)", () => {
  // F8 — the whole point of the third backing is zero credentials. The selector must reach for NONE
  // of the drain's five variables. Asserted with a throwing Proxy env: if selection so much as READS
  // one of the five, the getter throws; a correct selector returns the file backing without touching
  // them. (RED today because the module is absent, not because the proxy fired.)
  it("F8 selectQueueBacking never reads any of the five drain variables", async () => {
    const { selectQueueBacking, LOCAL_QUEUE_DIR_VAR, DRAIN_VARS } = await loadLocalQueue();
    const forbidden = new Set(DRAIN_VARS);
    const touched: string[] = [];
    const env = new Proxy(
      { [LOCAL_QUEUE_DIR_VAR]: "/tmp/coltrane-queue" } as Record<string, string | undefined>,
      {
        get(target, prop) {
          if (typeof prop === "string" && forbidden.has(prop)) {
            touched.push(prop);
            throw new Error(`the local path must not read the drain variable ${prop}`);
          }
          return target[prop as string];
        },
      },
    );
    const choice = selectQueueBacking(env);
    expect(touched, "the local path read a drain credential variable").toEqual([]);
    expect(choice.backing).toBe("file");
  });

  // The five names are the drain contract, unchanged (drain_preflight.ts:55-61). Pin the set so a
  // future edit that renames one cannot silently let the local path start depending on it.
  it("F8 DRAIN_VARS is exactly the drain's five-variable contract", async () => {
    const { DRAIN_VARS } = await loadLocalQueue();
    expect([...DRAIN_VARS].sort()).toEqual(
      [
        "COLTRANE_DRAIN_KEY",
        "COLTRANE_DRAIN_URL",
        "COLTRANE_INSTANCE",
        "COLTRANE_STORE_ANON",
        "COLTRANE_STORE_URL",
      ],
    );
  });
});

describe("local queue — the whole path is offline (I17)", () => {
  // I17 — no enqueue/claim/heartbeat/park/approve/cancel/complete performs any network IO. Asserted
  // by stubbing fetch to THROW: a full lifecycle against a real tmpdir must never call it. This is
  // what keeps the subsystem inside the suite's no-remote posture with zero credentials.
  it("I17 a full lifecycle touches fetch zero times", async () => {
    const { openLocalQueue } = await loadLocalQueue();
    const fetchMock = vi.fn(() => {
      throw new Error("the local queue must never reach the network");
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const q = openLocalQueue(freshRoot());
      const { gig_id } = await q.enqueue({ standard_slug: "s", input: {}, acting_for: "a" });
      const claimed = await q.claim("w1");
      expect(claimed).not.toBeNull();
      await q.heartbeat("w1", gig_id);
      await q.complete("w1", gig_id, { data: { ok: true } });
      const { gig_id: g2 } = await q.enqueue({ standard_slug: "s", input: {}, acting_for: "a" });
      await q.cancel({ gig_id: g2 });
      expect(fetchMock, "an offline subsystem that called fetch is not offline").not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("local queue — enqueue fails closed (F1, F10)", () => {
  // F1 — the environment says local but the root cannot be persisted to. Refuse; NEVER report
  // success for a gig that was not written, and never fall back to another backing.
  it("F1 an unwritable root refuses rather than reporting a phantom queued gig", async () => {
    const { fileQueueGig } = await loadLocalQueue();
    // A regular file where a directory must be: mkdir/rename under it fails with ENOTDIR.
    const base = freshRoot();
    const notADir = join(base, "occupied");
    fs.writeFileSync(notADir, "x");
    const enqueue = fileQueueGig(join(notADir, "queue"));
    await expect(
      enqueue({ standard_slug: "s", input: {}, acting_for: "a" }),
      "a gig that could not be persisted must not report success",
    ).rejects.toThrow();
  });

  // F10 — a payload missing the fields a worker needs to run is unrunnable. Refuse and persist
  // nothing, rather than enqueue a row that can only fail thirty minutes later on a drain.
  it("F10 a malformed payload refuses and persists no row", async () => {
    const { openLocalQueue } = await loadLocalQueue();
    const q = openLocalQueue(freshRoot());
    await expect(
      q.enqueue({ input: {} }), // no standard_slug — nothing to run
      "an unrunnable gig must be refused at enqueue, not enqueued",
    ).rejects.toThrow(/standard/i);
    const claimed = await q.claim("w1");
    expect(claimed, "a refused enqueue must leave the queue empty").toBeNull();
  });
});
