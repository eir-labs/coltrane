// RR-1(c2) — a floored room is never "a room that needs nothing" (wiki spec.coltrane.the-red-pass-runs-in-its-room; Vör, round 7).
//
// R38 exempts a room that is "furnishings only — a box builds nothing to run in it" from the realizable-venues gate. The predicate
// read mcp_servers and substrate and never floor, so a floored, server-less room — exactly a projected drafting room — was admitted
// to every box as needing nothing, and its chairs would run on the host. A floor is something a box must build. The predicate is
// also ONE expression, shared by the claim gate and the run path (it was written twice).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as worker from "../src/worker.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const needsNothing = (worker as unknown as { aRoomNeedsNothing?: (room: unknown) => boolean }).aRoomNeedsNothing;
const room = (over: Record<string, unknown> = {}) => ({ slug: "r", mcp_servers: [], ...over });

describe("RR-1(c2) — a floored room needs something", () => {
  it("the predicate is exported as one expression", () => {
    expect(typeof needsNothing, "src/worker.ts exports no aRoomNeedsNothing").toBe("function");
  });
  it("plant: a floored, server-less room does NOT need nothing (a box must build its floor)", () => {
    expect(needsNothing!(room({ floor: "sha256:" + "ab".repeat(32) }))).toBe(false);
  });
  it("plant: a room with servers needs something", () => {
    expect(needsNothing!(room({ mcp_servers: [{ slug: "s" }] }))).toBe(false);
  });
  it("plant: a room with a substrate needs something", () => {
    expect(needsNothing!(room({ substrate: { kind: "x" } }))).toBe(false);
  });
  it("plant: no room at all is not a room that needs nothing", () => {
    expect(needsNothing!(undefined)).toBe(false);
  });
  it("twin: furnishings only — no servers, no substrate, no floor — needs nothing (R38 unchanged)", () => {
    expect(needsNothing!(room())).toBe(true);
  });
  it("both sites use it: the claim gate and the run path spell the predicate nowhere else", () => {
    const src = readFileSync(`${ROOT}src/worker.ts`, "utf8");
    expect(src.match(/mcp_servers\.length === 0/g)?.length ?? 0, "the predicate is written out more than once").toBe(1);
  });
});
