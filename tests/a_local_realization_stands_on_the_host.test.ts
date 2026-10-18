// A LOCAL REALIZATION STANDS ON THE HOST — what a local-process realizer brought up is found, released and swept by a realizer that did
// not bring it up, and the room's seat goes down with it.
//
// THE GAP. VenueRealizer.release says it "brings down the realization of a gig, found as it stands on the host, NOT through a handle: the
// process that realized it may be gone". localProcessRealizer kept what it realized in a module-level list inside the realizing process,
// and ran no seat: realize() recorded a "local-process-group" and started nothing. Driven by conformance the-die-e2e E2E-7 (the Chancery OS
// die, his standing goal of 19 Oct), `up` in one process and `down` in another: release answered "no realization … stands on this
// host", sweep found nothing, and the room's seat kept running until the die killed it and named the leak. His word, 19 Oct: "if you
// need coltrane engine changes then make a dev branch and tarball locally so engine changes can unblock chancery os".
//
// L1  release from a FRESH realizer brings down a realization another instance made, and the room's seat with it
// L2  sweep from a fresh realizer collects an orphan (its seat gone) and spares a live gig (its seat still running)
// L3  release of a gig nothing stands for is a named no-op
// L4  a realization made in another process, with no seat, stands on the host, and this process releases it
// L5  the registry is the realizer's root: a realizer on another root neither sees nor releases it
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localProcessRealizer as realizerOf } from "../src/venue_realizer.js";

// the realizer on a host registry root, a seat in its options: called through `any` so the law compiles against a realizer without them
// and fails on what it asserts, never on a type
const localProcessRealizer = (o: { root: string }) => (realizerOf as any)(o) as { realize: (v: unknown, r: unknown, o: any) => Promise<any>; release: (g: string) => Promise<{ released: boolean; said: string }>; sweep: (o: { liveGigs: string[] }) => Promise<any[]> };

const EMPTY_ROOM = JSON.parse(readFileSync(new URL("../venues/empty-room-v1.json", import.meta.url), "utf8"));
const noCredentials = async () => ({});
const roots: string[] = [];
const root = () => { const r = mkdtempSync(join(tmpdir(), "coltrane-host-")); roots.push(r); return r; };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const seat = (r: string) => ({ command: "/bin/sleep", args: ["60"], env: { PATH: process.env.PATH ?? "" }, log: join(r, "seat.log") });
const pidOf = (h: any): number => h.artifacts.find((a: any) => a.kind === "local-process" && /^pid-/.test(a.id))?.id.slice(4) * 1;
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

describe("a local realization stands on the host", () => {
  it("L1 — release from a fresh realizer brings down another instance's realization, and its seat", async () => {
    const r = root(), gig = "a1a1a1a1-0000-4000-8000-0000000000l1";
    const h = await localProcessRealizer({ root: r }).realize(EMPTY_ROOM, noCredentials, { gigId: gig, seat: seat(r) });
    const pid = pidOf(h);
    expect(pid > 0 && alive(pid), "the room's seat runs").toBe(true);
    const out = await localProcessRealizer({ root: r }).release(gig);   // a new realizer, as a later process makes one
    expect(out.released, out.said).toBe(true);
    expect(alive(pid), "the seat is down").toBe(false);
  });

  it("L2 — sweep from a fresh realizer collects an orphan (its seat gone) and spares a live gig", async () => {
    const r = root(), orphan = "b2b2b2b2-0000-4000-8000-0000000000l2", live = "c3c3c3c3-0000-4000-8000-0000000000l2";
    const maker = localProcessRealizer({ root: r });
    const ho = await maker.realize(EMPTY_ROOM, noCredentials, { gigId: orphan, seat: seat(r) });
    const hl = await maker.realize(EMPTY_ROOM, noCredentials, { gigId: live, seat: seat(r) });
    const swept = await localProcessRealizer({ root: r }).sweep({ liveGigs: [live] });
    expect(swept.some((a) => a.labels.gig_id === orphan), "the orphan is collected").toBe(true);
    expect(swept.some((a) => a.labels.gig_id === live), "the live gig is spared").toBe(false);
    expect(alive(pidOf(ho)), "the orphan's seat is down").toBe(false);
    expect(alive(pidOf(hl)), "the live gig's seat still runs").toBe(true);
    await localProcessRealizer({ root: r }).release(live);
    expect(alive(pidOf(hl))).toBe(false);
  });

  it("L3 — release of a gig nothing stands for is a named no-op", async () => {
    const out = await localProcessRealizer({ root: root() }).release("d4d4d4d4-0000-4000-8000-0000000000l3");
    expect(out.released).toBe(false);
    expect(out.said).toMatch(/no realization of gig d4d4d4d4-0000-4000-8000-0000000000l3 stands on this host/);
  });

  it("L4 — a realization made in ANOTHER process, with no seat, stands on the host, and this process releases it", async () => {
    const r = root(), gig = "e5e5e5e5-0000-4000-8000-0000000000l4";
    // the realizing process is a real other process (the dist the suite's global setup built from this source): a module-level memory
    // shared inside one process is not what this law is about
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `import { localProcessRealizer } from ${JSON.stringify(new URL("../dist/src/venue_realizer.js", import.meta.url).href)};
      const v = ${JSON.stringify(EMPTY_ROOM)}; await localProcessRealizer({ root: ${JSON.stringify(r)} }).realize(v, async () => ({}), { gigId: ${JSON.stringify(gig)} }); console.log("realized");`], { encoding: "utf8" });
    expect(child.stdout.trim(), child.stderr).toBe("realized");
    const out = await localProcessRealizer({ root: r }).release(gig);
    expect(out.released, out.said).toBe(true);
  });

  it("L5 — a realizer on another root neither sees nor releases it", async () => {
    const r = root(), other = root(), gig = "f6f6f6f6-0000-4000-8000-0000000000l5";
    const h = await localProcessRealizer({ root: r }).realize(EMPTY_ROOM, noCredentials, { gigId: gig, seat: seat(r) });
    expect((await localProcessRealizer({ root: other }).sweep({ liveGigs: [] })).length).toBe(0);
    expect((await localProcessRealizer({ root: other }).release(gig)).released).toBe(false);
    expect(alive(pidOf(h)), "untouched by the other root").toBe(true);
    await localProcessRealizer({ root: r }).release(gig);
  });
});
