// RR-1 (engine half) — a seat-bearing room's floor can be named by digest, and the engine says whether it is
// (wiki spec.coltrane.the-red-pass-runs-in-its-room rev 2, Vör: "pin the floor by digest, not tag").
//
// A tag moves: two runs resolving `coltrane/floor:<tag>` to different images make a gate's determinism only as stable as that
// day's tag. A floor written as a digest (`sha256:<64 hex>`, or `<repository>@sha256:<64 hex>`) is used VERBATIM as the room's
// image, never prefixed into a tag. `floorIsPinned(venue)` answers whether a room's floor is a digest. Refusing a tag-only floor
// is the business of the standard that names the room (the drafting room is in-house); existing rooms keep their tags.
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { loadGenome } from "../src/loader.js";
import * as realizer from "../src/venue_realizer.js";
import { VenueSchema } from "../src/genome_schema.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const base = loadGenome(ROOT).venues.get("empty-room-v1")!;
const DIGEST = "sha256:" + "ab".repeat(32);
const room = (floor?: string) => VenueSchema.parse({ ...JSON.parse(JSON.stringify(base)), ...(floor === undefined ? {} : { floor }) });
const image = (floor?: string) => {
  const doc = realizer.renderComposeConfig(room(floor), { gigId: "77777777-7777-7777-7777-777777777777", realizationDir: "/realizations/gig-7" }) as { services: Record<string, { image: string }> };
  return Object.values(doc.services)[0]!.image;
};
const pinned = (realizer as unknown as { floorIsPinned?: (v: unknown) => boolean }).floorIsPinned;

describe("RR-1 — a floor named by digest is used verbatim, and the engine says whether a floor is pinned", () => {
  it("a bare digest floor is the room's image, verbatim (never coltrane/floor:sha256:…)", () => {
    expect(image(DIGEST)).toBe(DIGEST);
  });
  it("a repository@digest floor is the room's image, verbatim", () => {
    expect(image(`ghcr.io/eir-dev/chancery-drafting-floor@${DIGEST}`)).toBe(`ghcr.io/eir-dev/chancery-drafting-floor@${DIGEST}`);
  });
  it("control — a tag floor keeps today's image, coltrane/floor:<tag>", () => {
    expect(image("seat")).toBe("coltrane/floor:seat");
  });
  it("floorIsPinned: a digest floor is pinned; a tag floor, a short hash or no floor is not", () => {
    expect(typeof pinned, "src/venue_realizer.ts exports no floorIsPinned").toBe("function");
    expect(pinned!(room(DIGEST))).toBe(true);
    expect(pinned!(room(`ghcr.io/eir-dev/x@${DIGEST}`))).toBe(true);
    expect(pinned!(room("seat"))).toBe(false);
    expect(pinned!(room("sha256:abcd"))).toBe(false);
    expect(pinned!(room())).toBe(false);
  });
});
