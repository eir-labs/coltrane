// RED — the BACKING SEAM: reside is platform-agnostic at the engine level, and local / hand-built /
// hosted are three doors selected by environment PRESENCE, never guessed between.
//
// This is selectQueueBacking's shape, one table over, and deliberately so (src/local_queue.ts:153):
// it reads the VALUE of no credential, it answers from presence alone, and when two backings are
// configured it REFUSES rather than picking a precedence order — which store owns a seat is not a
// thing to guess. The one addition is a third door: a module you wrote yourself.
//
// THE LOAD-BEARING LAW HERE IS THE AGNOSTICISM ONE. The engine ships the port, the selector, the
// local provider and the refusals — and NO eir-specific code. `hosted` resolves to a backing the
// DEPLOYMENT injects, the way deps.queueGig and deps.mintVenueCredential already work. If coltrane
// ever grows a residency.claim() call of its own, the last law in this file goes red.
import { describe, it, expect } from "vitest";
import { readFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DRAIN_VARS } from "../src/local_queue.js";
import { loadReside, type ResideModule } from "./spec_reside_loop_fixtures.js";

const SRC = new URL("../src/", import.meta.url).pathname;

/** The reside path — the files this law holds to the agnosticism standard. `work`'s older drain
 *  path (src/worker.ts) names coltrane_drain_claim directly and is deliberately NOT in scope: this
 *  law pins what reside is, it does not retroactively re-litigate the drain. */
const RESIDE_PATH = ["reside.ts", "reside_backing.ts"];

describe("the backing is SELECTED from presence, never guessed", () => {
  it("COLTRANE_RESIDENCY_DIR selects the local file backing", async () => {
    const R: ResideModule = await loadReside();
    const c = R.selectResidencyBacking({ COLTRANE_RESIDENCY_DIR: "/var/reside" });
    expect(c.backing).toBe("local");
    if (c.backing === "local") expect(c.root).toBe("/var/reside");
  });

  it("COLTRANE_RESIDENCY_MODULE selects a hand-built backing", async () => {
    const R: ResideModule = await loadReside();
    const c = R.selectResidencyBacking({ COLTRANE_RESIDENCY_MODULE: "./my-reside.js" });
    expect(c.backing).toBe("module");
    if (c.backing === "module") expect(c.spec).toBe("./my-reside.js");
  });

  it("the drain environment selects the hosted backing", async () => {
    const R: ResideModule = await loadReside();
    const env: Record<string, string> = {};
    for (const v of DRAIN_VARS) env[v] = "set";
    expect(R.selectResidencyBacking(env).backing).toBe("hosted");
  });

  it("two backings configured is a CONFLICT — it refuses rather than ordering them", async () => {
    const R: ResideModule = await loadReside();
    for (const pair of [
      { COLTRANE_RESIDENCY_DIR: "/var/reside", COLTRANE_RESIDENCY_MODULE: "./m.js" },
      { COLTRANE_RESIDENCY_DIR: "/var/reside", [String(DRAIN_VARS[0])]: "set" },
      { COLTRANE_RESIDENCY_MODULE: "./m.js", [String(DRAIN_VARS[0])]: "set" },
    ]) {
      const c = R.selectResidencyBacking(pair as Record<string, string>);
      expect(c.backing, `${Object.keys(pair).join(" + ")} picked a winner instead of refusing`).toBe("conflict");
      if (c.backing === "conflict") expect(c.why).toBeTruthy();
    }
  });

  it("no backing configured names ALL THREE doors, so the operator knows the choices", async () => {
    const R: ResideModule = await loadReside();
    const c = R.selectResidencyBacking({});
    expect(c.backing).toBe("none");
    if (c.backing === "none") {
      expect(c.why).toContain("COLTRANE_RESIDENCY_DIR");
      expect(c.why).toContain("COLTRANE_RESIDENCY_MODULE");
      expect(c.why.toLowerCase()).toContain("hosted");
    }
  });

  it("PRESENCE, not value — an empty string configures nothing", async () => {
    const R: ResideModule = await loadReside();
    expect(R.selectResidencyBacking({ COLTRANE_RESIDENCY_DIR: "" }).backing).toBe("none");
    expect(R.selectResidencyBacking({ COLTRANE_RESIDENCY_MODULE: "" }).backing).toBe("none");
  });
});

describe("a hand-built backing is shape-checked and FAILS CLOSED", () => {
  it("a module missing a seat member is refused BY NAME", async () => {
    const R: ResideModule = await loadReside();
    const partial = { claim: async () => null, heartbeat: async () => {} };
    const res = await R.resolveSeatBacking({ backing: "module", spec: "inline" }, { module: partial });
    expect(res.ok, "a partial hand-built backing was accepted").toBe(false);
    if (!res.ok) {
      expect(res.refusal).toBe("no_backend");
      // Naming the missing member is the whole difference between a usable refusal and a shrug.
      expect(res.seam).toMatch(/release|cursorAdvance/);
      expect(res.message).toBeTruthy();
    }
  });

  it("a complete hand-built backing resolves", async () => {
    const R: ResideModule = await loadReside();
    const whole = {
      claim: async () => null,
      heartbeat: async () => {},
      release: async () => {},
      cursorAdvance: async () => 0,
    };
    const res = await R.resolveSeatBacking({ backing: "module", spec: "inline" }, { module: whole });
    // The guard on the sabotage: if this went red too, the law above would be refusing everything.
    expect(res.ok).toBe(true);
  });
});

describe("THE AGNOSTICISM LAW — the engine ships no platform of its own", () => {
  it("hosted resolves to a backing the DEPLOYMENT injects, and refuses when it did not", async () => {
    const R: ResideModule = await loadReside();
    const res = await R.resolveSeatBacking({ backing: "hosted" }, {});
    expect(res.ok, "the engine produced a hosted backing out of thin air").toBe(false);
    if (!res.ok) {
      expect(res.refusal).toBe("no_backend");
      expect(res.seam).toBe("hosted");
      expect(res.message, "the refusal does not tell a deployment what to wire").toMatch(/inject|deployment|supplie/i);
    }
  });

  it("an injected hosted backing is used as given", async () => {
    const R: ResideModule = await loadReside();
    const hosted = {
      claim: async () => null,
      heartbeat: async () => {},
      release: async () => {},
      cursorAdvance: async () => 0,
    };
    const res = await R.resolveSeatBacking({ backing: "hosted" }, { hosted });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.seat.claim).toBe(hosted.claim);
  });

  it("the reside path names NO platform-specific store symbol", () => {
    // The structural half, and the one that catches the drift a year from now: if someone wires
    // eir's residency RPCs straight into the engine, this goes red and they have to put it behind
    // the injected seam instead.
    const forbidden = [
      "residency.claim", "residency.seat", "residency.heartbeat", "residency.release",
      "cursor_advance", "coltrane_drain_claim", "supabase", "postgrest", "x-coltrane-provisioner-key",
      "envoy.eir.sh", "slack",
    ];
    for (const file of RESIDE_PATH) {
      const text = readFileSync(join(SRC, file), "utf8").toLowerCase();
      for (const name of forbidden) {
        expect(text, `${file} names the platform-specific symbol "${name}" — put it behind the injected backing`)
          .not.toContain(name.toLowerCase());
      }
    }
  });
});

describe("the local backing is REACHABLE — the defect this file nearly shipped", () => {
  // FOUND ON THE REAL BINARY, not in a test. `reside` demanded COLTRANE_STORE_URL + _ANON up front,
  // and both are themselves DRAIN_VARS — so the moment an operator set COLTRANE_RESIDENCY_DIR the
  // selector saw local AND hosted and refused a conflict. The local backing could not be selected
  // by any environment at all: a provider with laws, a file format and no way to reach it. Exactly
  // the defect this whole change exists to close, one level further down.
  it("COLTRANE_RESIDENCY_DIR alone selects local and needs NO store credential", async () => {
    const R: ResideModule = await loadReside();
    const root = mkdtempSync(join(tmpdir(), "reside-"));
    const choice = R.selectResidencyBacking({ COLTRANE_RESIDENCY_DIR: root });
    expect(choice.backing, "a local roster is not selectable on its own").toBe("local");
  });

  it("the VERB runs a local roster without any store variable set", async () => {
    const R: ResideModule = await loadReside();
    const root = mkdtempSync(join(tmpdir(), "reside-"));
    await R.fileSeatSeed(root, { agent_slug: "a", org: "o", venue_slug: "v", channel_id: "c" });
    const errs: string[] = [];
    // No COLTRANE_STORE_URL, no COLTRANE_STORE_ANON — a local residency has no store to point at.
    const code = await R.runReside(["reside", "--any"], { err: (x: string) => errs.push(x), env: { COLTRANE_RESIDENCY_DIR: root } });
    const said = errs.join("");
    expect(said, "a local run was refused for want of a store it does not use").not.toContain("backing_conflict");
    expect(said, "the local seat was not reached").not.toContain("seam: backing");
    // It still refuses — the channel and cortex are per-deployment on every backing — but it must
    // refuse for THAT reason, having gotten past the seat.
    expect(said).toContain("channelListener");
    expect(code).toBe(2);
  });
});

describe("the local file backing is a real seat, not a stub", () => {
  it("round-trips claim -> heartbeat -> cursorAdvance -> release on disk", async () => {
    const R: ResideModule = await loadReside();
    const root = mkdtempSync(join(tmpdir(), "reside-"));
    const seat = R.fileSeatBacking(root);

    const seeded = await R.fileSeatSeed(root, { agent_slug: "agent.viola", org: "org.house", venue_slug: "venue.studio", channel_id: "chan.parlor" });
    expect(seeded).toBeTruthy();

    const claim = await seat.claim("any");
    expect(claim, "a seeded local roster claimed nothing").toBeTruthy();
    if (!claim) return;
    expect(claim.residency_id).toBe(seeded);
    // A local seat is not a gig token and must not read as one.
    expect(claim.gig_id ?? null).toBe(null);

    await seat.heartbeat(claim.residency_id);
    const moved = await seat.cursorAdvance(claim.residency_id, 3);
    expect(moved).toBe(3);
    await seat.release(claim.residency_id, "hibernated");

    // The seat is genuinely on disk — a second process could read it.
    const rows = JSON.parse(readFileSync(join(root, `${claim.residency_id}.json`), "utf8")) as { status: string; cursor: number };
    expect(rows.status).toBe("hibernated");
    expect(rows.cursor).toBe(3);
  });

  it("a cursor regression is refused locally, exactly as the store refuses it", async () => {
    const R: ResideModule = await loadReside();
    const root = mkdtempSync(join(tmpdir(), "reside-"));
    const seat = R.fileSeatBacking(root);
    const id = await R.fileSeatSeed(root, { agent_slug: "a", org: "o", venue_slug: "v", channel_id: "c" });
    await seat.claim("any");
    await seat.cursorAdvance(id, 5);
    // Both halves exist for a reason: the store cannot see a seal, and the engine cannot see another
    // box. A local backing that skipped this would be laxer than the hosted one it stands in for.
    await expect(seat.cursorAdvance(id, 3)).rejects.toThrow(/cursor_regression/);
  });

  it("a claimed seat is not claimable twice while its lease holds", async () => {
    const R: ResideModule = await loadReside();
    const root = mkdtempSync(join(tmpdir(), "reside-"));
    const seat = R.fileSeatBacking(root);
    await R.fileSeatSeed(root, { agent_slug: "a", org: "o", venue_slug: "v", channel_id: "c" });
    expect(await seat.claim("any")).toBeTruthy();
    expect(await seat.claim("any"), "two boxes both hold the same local seat").toBe(null);
  });
});
