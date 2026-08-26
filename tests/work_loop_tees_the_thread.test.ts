/**
 * The drain's own run path TEES the thread — not only the server's.
 *
 * The tee lived exclusively in the server's async-dispatch onProgress, so the
 * path every production gig takes (`coltrane work` → workOnce → runGig) wrote no
 * thread files at any engine version. Measured live: 0.24.17 box, env set, gig
 * running, no gigs/ dir. These laws pin the shared helper both paths now use.
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeGigLogTee } from "../src/gig_log_tee.js";

describe("the gig-log tee, shared by both run paths", () => {
  it("tees agent_event lines per role, append-only, under <base>/gigs/<gid>", () => {
    const base = mkdtempSync(join(tmpdir(), "tee-"));
    const tee = makeGigLogTee(base, "gid-1");
    tee({ type: "agent_event", role: "verify", event: { turn: 1, text: "checking" } });
    tee({ type: "agent_event", role: "verify", event: { turn: 2, tool: "Read" } });
    tee({ type: "phase_started", role: "verify", event: { ignored: true } });
    tee({ type: "agent_event", role: "judge", event: { turn: 1 } });

    const v = readFileSync(join(base, "gigs", "gid-1", "verify.jsonl"), "utf8").trim().split("\n");
    expect(v.length, "two turns for verify — the thread, appended in order").toBe(2);
    expect(JSON.parse(v[1]!), "turns are the child events verbatim").toEqual({ turn: 2, tool: "Read" });
    expect(existsSync(join(base, "gigs", "gid-1", "judge.jsonl")), "roles get their own files").toBe(true);
    expect(existsSync(join(base, "gigs", "gid-1", "phase_started.jsonl")), "non-agent events are not thread").toBe(false);
  });

  it("no base -> a no-op, never a throw (bare deployments byte-identical)", () => {
    const tee = makeGigLogTee(undefined, "gid-2");
    expect(() => tee({ type: "agent_event", role: "r", event: {} })).not.toThrow();
  });

  it("the WORKER wires it: workOnce's runGig deps carry an onProgress that tees", async () => {
    // The location law — the fix must live on the drain's path, not beside it.
    // Asserted structurally: worker.ts imports the helper and threads onProgress.
    const src = readFileSync(new URL("../src/worker.ts", import.meta.url), "utf8");
    expect(src.includes("makeGigLogTee"), "workOnce uses the shared tee").toBe(true);
    expect(src.includes("onProgress"), "the tee is threaded as runGig's onProgress").toBe(true);
  });
});
