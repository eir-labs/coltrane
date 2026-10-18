// A REALIZATION IS RELEASED AND SWEPT ACROSS PROCESSES — what a realizer brought up is found again by a realizer that did not.
//
// THE GAP. realize() returns a handle whose teardown() is a closure over the compose file it wrote; nothing exported brings a room
// down once that process is gone. And sweep() said "HOST-WIDE observed state, so a sweep reconciles against what EXISTS … the only
// model that survives a killed worker", while it read a per-process Map: a fresh process swept nothing. A downstream that books a
// room in one process and closes it in another (chancery-os's facility, conformance die-package DP-0) could only reach for docker
// itself, the second realizer DP-0 refuses. Found 18 Oct 2026, building that facility; Vör ruled the cure into its own PR.
//
// R1  release(gig) from a FRESH realizer brings down a realization another instance made: by its compose project, exactly
// R2  sweep from a fresh realizer returns a standing project it never made, and leaves out the live gigs
// R3  release of a gig nothing stands for is a named no-op: it says so, and brings nothing down
// R4  sweep never returns a project not labelled coltrane.managed=true, and release never brings one down (a foreign container survives)
// R5  the local-process realizer implements release too (a seam has two implementations): a named no-op with nothing standing
//
// The runner is the realizer's own seam (ComposeRunner): it records every argv and answers `docker ps` with canned rows, so the law
// is about what the realizer DECIDES, on a host with no daemon. The rows are what Coltrane's own render labels a room with.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeProjectName, dockerComposeRealizer, localProcessRealizer } from "../src/venue_realizer.js";

const EMPTY_ROOM = JSON.parse(readFileSync(new URL("../venues/empty-room-v1.json", import.meta.url), "utf8"));
const noCredentials = async () => ({});
const projectOf = (gig: string) => composeProjectName(join(tmpdir(), "coltrane-realizations", `gig-${gig.slice(0, 8)}`));

type Row = { managed?: string; project: string };
/** a recording runner; `ps` answers with the rows given, in the format the realizer asks for */
function recorder(rows: Row[] = []) {
  const calls: string[][] = [];
  const run = (args: readonly string[]) => {
    calls.push([...args]);
    if (args[0] === "ps") return rows.map((r) => [r.managed ?? "", r.project].join("\t")).join("\n");
    return "";
  };
  return { calls, run };
}
const downs = (calls: string[][]) => calls.filter((c) => c[0] === "compose" && c.includes("down"));

describe("a realization is released and swept across processes", () => {
  it("R1 — release from a fresh realizer brings down a realization another instance made, by its compose project", async () => {
    const gig = "a1a1a1a1-0000-4000-8000-000000000001";
    const maker = recorder();
    await dockerComposeRealizer({ run: maker.run }).realize(EMPTY_ROOM, noCredentials, { gigId: gig });
    // a NEW realizer, as a later process would make one: it holds no handle, and finds the room by what stands on the host
    const fresh = recorder([{ managed: "true", project: projectOf(gig) }]);
    const r = await dockerComposeRealizer({ run: fresh.run }).release(gig);
    expect(r.released, r.said).toBe(true);
    expect(downs(fresh.calls)).toEqual([["compose", "-p", projectOf(gig), "down", "-v", "--remove-orphans"]]);
  });

  it("R2 — sweep from a fresh realizer returns a standing project it never made, and leaves out the live gigs", async () => {
    const stray = "b2b2b2b2-0000-4000-8000-000000000002", live = "c3c3c3c3-0000-4000-8000-000000000003";
    const fresh = recorder([{ managed: "true", project: projectOf(stray) }, { managed: "true", project: projectOf(live) }]);
    const swept = await dockerComposeRealizer({ run: fresh.run }).sweep({ liveGigs: [live] });
    // a fresh process knows a standing room as the host labels it: its compose project, and its gig's first eight. (What this test
    // process realized itself is swept too, by the remembered half; this law is about the half read from the host.)
    const fromHost = swept.filter((a) => a.labels.instance === "host");
    expect(fromHost.map((a) => [a.id, a.labels.gig_id])).toEqual([[projectOf(stray), stray.slice(0, 8)]]);
    expect(swept.some((a) => a.labels.gig_id.startsWith(live.slice(0, 8))), "a live gig is spared").toBe(false);
  });

  it("R3 — release of a gig nothing stands for is a named no-op, and brings nothing down", async () => {
    const fresh = recorder([]);
    const r = await dockerComposeRealizer({ run: fresh.run }).release("d4d4d4d4-0000-4000-8000-000000000004");
    expect(r.released).toBe(false);
    expect(r.said).toMatch(/no realization of gig d4d4d4d4-0000-4000-8000-000000000004 stands/);
    expect(downs(fresh.calls)).toEqual([]);
  });

  it("R4 — sweep never returns a project not labelled coltrane.managed=true, and release never brings one down", async () => {
    const foreign = "e5e5e5e5-0000-4000-8000-000000000005", unlabelled = "f6f6f6f6-0000-4000-8000-000000000006";
    // the runner answers with rows the realizer did not ask for, as a host with other containers would
    const rows = [{ managed: "false", project: projectOf(foreign) }, { project: projectOf(unlabelled) }, { managed: "true", project: "someone-elses-project" }];
    const a = recorder(rows);
    const swept = await dockerComposeRealizer({ run: a.run }).sweep({ liveGigs: [] });
    expect(swept.filter((x) => x.labels.instance === "host"), "nothing read from the host but what is labelled ours").toEqual([]);
    expect(swept.some((x) => [projectOf(foreign), projectOf(unlabelled), "someone-elses-project"].includes(x.id))).toBe(false);
    const b = recorder(rows);
    const r = await dockerComposeRealizer({ run: b.run }).release(foreign);
    expect(r.released).toBe(false);
    expect(downs(b.calls)).toEqual([]);
  });

  it("R5 — the local-process realizer implements release too: with nothing standing, a named no-op", async () => {
    const r = await localProcessRealizer().release("a7a7a7a7-0000-4000-8000-000000000007");
    expect(r.released).toBe(false);
    expect(r.said).toMatch(/no realization of gig a7a7a7a7-0000-4000-8000-000000000007 stands/);
  });
});
