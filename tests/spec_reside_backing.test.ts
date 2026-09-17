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
    // ORG-INTERNAL NAMES ARE DELIBERATELY ABSENT from this list. The repository already has a
    // publishing gate whose term list arrives from a secret and is never committed
    // (.github/workflows/boundary.yml); restating those terms here would republish in a public test
    // exactly what that gate protects, and would be a second mechanism for one rule besides. This
    // law covers what is left: store-shaped call patterns the engine must not grow.
    const forbidden = [
      "residency.claim", "residency.seat", "residency.heartbeat", "residency.release",
      "cursor_advance", "coltrane_drain_claim", "/rest/v1", "provisioner-key",
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

    const grip = String(claim.fence);
    await seat.heartbeat(claim.residency_id, grip);
    const moved = await seat.cursorAdvance(claim.residency_id, grip, 3);
    expect(moved).toBe(3);
    await seat.release(claim.residency_id, grip, "hibernated");

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
    const held = await seat.claim("any");
    const grip = String(held?.fence);
    await seat.cursorAdvance(id, grip, 5);
    // Both halves exist for a reason: the store cannot see a seal, and the engine cannot see another
    // box. A local backing that skipped this would be laxer than the hosted one it stands in for.
    await expect(seat.cursorAdvance(id, grip, 3)).rejects.toThrow(/cursor_regression/);
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

describe("the seam a deployment MUST implement is reachable from outside", () => {
  // FILED BY THE WI-2 SEAT after building against it: the engine defines SeatBacking in
  // dist/src/reside_backing.d.ts, the root index re-exports nothing from the reside path, and the
  // exports map publishes no subpath — so a deployment cannot import the interface it is required
  // to implement. It had to hand-copy the shape.
  //
  // THE RATCHET COULD NOT SEE THIS, and the reason is worth keeping. exported_symbols_are_reachable
  // asks whether a symbol is called from somewhere INSIDE src/ or named on a public entrypoint.
  // `resolveSeatBacking` is called by reside.ts, so it passes — while remaining unreachable to the
  // one audience that has to satisfy it. Reachable-within and importable-from-outside are different
  // properties; only the first had a law. Same shape as lossless-vs-legal, one boundary out.
  it("the public entrypoint carries the backing seam", () => {
    const index = readFileSync(join(SRC, "index.ts"), "utf8");
    expect(index, "src/index.ts re-exports nothing from the reside path").toMatch(
      /export \* from "\.\/reside(_backing)?\.js"/,
    );
  });

  it("the members a hand-built backing must supply are namable by a consumer", async () => {
    // The positive: not "the file exists" but "the names a deployment codes against are exported".
    const mod = (await import("../src/index.js")) as Record<string, unknown>;
    expect(mod["SEAT_MEMBERS"], "a deployment cannot enumerate what it must implement").toBeDefined();
    expect(mod["resolveSeatBacking"]).toBeTypeOf("function");
    expect(mod["selectResidencyBacking"]).toBeTypeOf("function");
  });
});

describe("a hand-built backing may be async — the factory is awaited", () => {
  // ALSO FILED BY THE WI-2 SEAT, from a box that would have refused at boot. resolveSeatBacking
  // called `mod.residencyBacking()` without awaiting it, so an async factory — the obvious way to
  // write one, since a backing opens connections — yielded a Promise, and the shape check then
  // reported `no_backend at seam claim: the hand-built backing has no claim()`.
  //
  // The refusal was well-formed, typed, named a seam, and was WRONG: the backing had a claim, and
  // the engine could not see it through the promise. A precise refusal about the wrong thing is
  // worse than a vague one, because it sends the reader to the wrong file.
  it("an async residencyBacking() resolves rather than refusing", async () => {
    const R: ResideModule = await loadReside();
    const whole = {
      claim: async () => null,
      heartbeat: async () => {},
      release: async () => {},
      cursorAdvance: async () => 0,
    };
    const res = await R.resolveSeatBacking(
      { backing: "module", spec: "inline" },
      { module: Promise.resolve(whole) as never },
    );
    expect(res.ok, "an async backing was refused for being a promise").toBe(true);
  });

  it("a partial async backing is still refused BY NAME — awaiting does not weaken the check", async () => {
    const R: ResideModule = await loadReside();
    const res = await R.resolveSeatBacking(
      { backing: "module", spec: "inline" },
      { module: Promise.resolve({ claim: async () => null }) as never },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.seam).toMatch(/heartbeat|release|cursorAdvance/);
  });
});

describe("THE CONSUMER PATH — stand where a deployment stands", () => {
  // THE TEST I SHOULD HAVE WRITTEN FIRST. Two defects were filed against this seam by the first
  // seat that built on it — the interface was not importable, and an async factory (the natural way
  // to write one, since a backing opens connections) refused at boot naming the wrong seam. Both
  // were invisible from inside: every law here imported from relative paths and passed objects in
  // directly, so nothing ever stood where a deployment stands.
  //
  // A seam's audience is not this repo. Testing it only from inside is the same substitution as a
  // law that proves a mechanism works without asking whether anything reaches it — which is the
  // defect this whole branch exists to close, committed against my own deliverable.
  it("a deployment can import, implement and run the seam from the package root alone", async () => {
    const pkg = (await import("../src/index.js")) as Record<string, unknown>;

    // 1. Everything a deployment must NAME is on the root export.
    for (const sym of [
      "SEAT_MEMBERS", "resolveSeatBacking", "selectResidencyBacking", "fileSeatBacking",
      "createResidency", "RESIDE_REFUSALS", "RESIDENCY_DIR_VAR", "RESIDENCY_MODULE_VAR",
    ]) {
      expect(pkg[sym], `a deployment cannot reach "${sym}" from the package root`).toBeDefined();
    }

    // 2. A hand-built backing written the natural way — async factory, async members — resolves.
    const resolve = pkg["resolveSeatBacking"] as (c: unknown, i: unknown) => Promise<{ ok: boolean; seat?: unknown; refusal?: string; seam?: string }>;
    const factory = async () => ({
      claim: async () => null, heartbeat: async () => {}, release: async () => {}, cursorAdvance: async () => 0,
    });
    const seat = await resolve({ backing: "module", spec: "inline" }, { module: factory() });
    expect(seat.ok, `an async hand-built backing was refused: ${seat.refusal} at ${seat.seam}`).toBe(true);

    // 3. And the loop it would construct refuses for a REASON THAT NAMES THE NEXT MISSING SEAM —
    //    not for the seat it just supplied. A refusal pointing at the wrong file is worse than a
    //    vague one, because it sends the reader somewhere there is nothing to find.
    const create = pkg["createResidency"] as (o: unknown, d: unknown) => { boot: () => Promise<{ ok: boolean; seam?: string }> };
    const booted = await create({ residency: "any" }, { ...(seat.seat as object) }).boot();
    expect(booted.ok).toBe(false);
    expect(booted.seam, "the refusal blamed a seam the deployment had already supplied").toBe("channelListener");
  });
});
