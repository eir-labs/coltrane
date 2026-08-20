// `coltrane work` CAN CLAIM FROM THE LOCAL QUEUE.
//
// `coltrane enqueue` gave the local queue a door in, and it filled a queue nothing local drained:
// claimNextGig opens with workerCredentialMode, which answers `none` when no drain key and no agent
// token are present — and `none` THROWS. So a box with a local queue and no credentials could write
// a row it could never claim. Half a mechanism reads as a whole one right up until someone runs it.
//
// These laws pin the other half. A local claim needs NO credential, because there is no store to
// authenticate to: the queue is a directory. What it must NOT do is invent a credential-shaped
// nothing — the local path is selected BEFORE credentials are considered, so `none` keeps throwing
// for every caller who genuinely meant to reach a store.
//
// The mapping is not a translation layer: ClaimedLocalGig is a SUPERSET of ClaimedGig (it adds
// `worker` and `lease`), so a local claim already IS the shape the runner consumes. W5 pins that a
// local claim carries no repo_url and no venue by default, which is what makes the downstream
// workspace and git-credential path naturally absent rather than stubbed with empty values.
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { claimNextGig, type WorkerContext } from "../src/worker.js";
import { openLocalQueue, LOCAL_QUEUE_DIR_VAR } from "../src/local_queue.js";

const roots: string[] = [];
const freshRoot = (): string => { const r = mkdtempSync(join(tmpdir(), "coltrane-claim-")); roots.push(r); return r; };
afterAll(() => { for (const r of roots) { try { rmSync(r, { recursive: true, force: true }); } catch { /* best effort */ } } });

const DRAINISH = ["COLTRANE_DRAIN_KEY", "COLTRANE_DRAIN_URL", "COLTRANE_INSTANCE", "COLTRANE_STORE_ANON", "COLTRANE_STORE_URL", LOCAL_QUEUE_DIR_VAR];
async function withEnv<T>(over: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prior = new Map(DRAINISH.map((k) => [k, process.env[k]] as const));
  for (const k of DRAINISH) delete process.env[k];
  for (const [k, v] of Object.entries(over)) if (v !== undefined) process.env[k] = v;
  try { return await fn(); }
  finally { for (const [k, v] of prior) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

/** A context with NO credentials — the honest shape of a local box. */
const bareCtx = (): WorkerContext => ({ baseUrl: "", anonKey: "", agentToken: "" } as unknown as WorkerContext);

describe("`work` claims from the local queue", () => {
  it("W0 the seam and the queue both exist — the law is not vacuous", () => {
    expect(typeof claimNextGig).toBe("function");
    expect(typeof openLocalQueue).toBe("function");
  });

  it("W1 a locally enqueued gig is what a local claim returns — round trip", async () => {
    const root = freshRoot();
    const { gig_id } = await openLocalQueue(root).enqueue({
      standard_slug: "demo-standard", input: { q: "claimed-locally" }, acting_for: "somebody",
    });
    const claim = await withEnv({ [LOCAL_QUEUE_DIR_VAR]: root }, () => claimNextGig(bareCtx()));
    expect(claim, "a row was enqueued locally and no local claim could reach it").not.toBeNull();
    expect(claim!.gig_id).toBe(gig_id);
    expect(claim!.standard_slug).toBe("demo-standard");
    expect((claim!.input as { q?: string }).q).toBe("claimed-locally");
  });

  it("W2 a local claim needs NO credential — it does not reach the credential gate", async () => {
    const root = freshRoot();
    await openLocalQueue(root).enqueue({ standard_slug: "demo-standard", input: {}, acting_for: "a" });
    // With no drain key and no agent token, workerCredentialMode answers `none` and THROWS.
    // A local claim must be selected before that, because a directory needs no bearer.
    await expect(
      withEnv({ [LOCAL_QUEUE_DIR_VAR]: root }, () => claimNextGig(bareCtx())),
      "a local claim demanded a credential for a queue that is a directory",
    ).resolves.not.toBeNull();
  });

  it("W3 an empty local queue claims NOTHING, and does not throw", async () => {
    const root = freshRoot();
    const claim = await withEnv({ [LOCAL_QUEUE_DIR_VAR]: root }, () => claimNextGig(bareCtx()));
    expect(claim, "an empty local queue produced a claim out of nowhere").toBeNull();
  });

  it("W4 with NO local queue dir the credential gate still refuses — local mode is opt-in", async () => {
    await expect(
      withEnv({}, () => claimNextGig(bareCtx())),
      "a box with no queue dir and no credentials silently claimed something",
    ).rejects.toThrow();
  });

  it("W5 both backings configured is REFUSED, not resolved by precedence", async () => {
    const root = freshRoot();
    await expect(
      withEnv({ [LOCAL_QUEUE_DIR_VAR]: root, COLTRANE_DRAIN_URL: "https://example.invalid" },
        () => claimNextGig(bareCtx())),
      "a box with both backings set was silently given one of them",
    ).rejects.toThrow(/both|conflict/i);
  });

  it("W6 a local claim carries no repo_url and no venue — the workspace path stays absent", async () => {
    const root = freshRoot();
    await openLocalQueue(root).enqueue({ standard_slug: "demo-standard", input: {}, acting_for: "a" });
    const claim = await withEnv({ [LOCAL_QUEUE_DIR_VAR]: root }, () => claimNextGig(bareCtx()));
    expect(claim).not.toBeNull();
    expect(claim!.repo_url ?? null, "a local claim named a repository nobody supplied").toBeNull();
    expect(claim!.venue ?? null, "a local claim named a venue nobody supplied").toBeNull();
  });
});
