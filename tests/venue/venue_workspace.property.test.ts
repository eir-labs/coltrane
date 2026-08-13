// RED — THE VENUE'S WALLS: a declared, deny-by-default WORKSPACE and its containment boundary
// (INV1 private-ephemeral default, INV2 containment, INV3 worktree-by-default, INV8 cross-gig
// disjointness, INV16 seal-containment). These assert the REAL callsites in src/venue_realize.ts:
// `realize` must stamp a `workspace` onto its OK object, and `isContained` /
// `sealTouchesOnlyWorkspace` are the containment predicates. RED because the walls seam is a set of
// throwing stubs and `realize` does not yet populate `workspace` — every red here is an ABSENT
// enforcement, not a type error (tsc --noEmit is clean) and not a skip.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { type Venue } from "../../src/chart.js";
import { realize, isContained, sealTouchesOnlyWorkspace, type RealizeOpts } from "../../src/venue_realize.js";

// A sound, empty room. `over` sets the workspace/ports/floor under test.
const room = (over: Partial<Venue> = {}): Venue =>
  ({ slug: "ws-room", institution_slug: "quartet", equipment: { tools: [] },
     doors: { ingress: [], egress: [] }, installs: [], credential_surface: [],
     lifecycle: { policy: "ephemeral" }, ...over } as unknown as Venue);

const opts = (over: Partial<RealizeOpts> = {}): RealizeOpts =>
  ({ seats: [], ambientEnv: {}, gigId: "g", ...over });

describe("venue walls — a declared, deny-by-default workspace (INV1,INV3,INV8)", () => {
  it("INV1 deny-by-default: a venue with NO workspace field realizes a private ephemeral tree, never the host cwd", () => {
    const r = realize(room(), opts());
    if (!r.ok) throw new Error(`realize refused a sound bare room: ${JSON.stringify(r.refusal)}`);
    expect(r.workspace, "an absent workspace must still yield a private tree, not undefined").toBeDefined();
    expect(r.workspace!.path).not.toBe(process.cwd()); // never the host's working tree
    expect(r.workspace!.path.length).toBeGreaterThan(0);
    expect(r.workspace!.ephemeral).toBe(true);
  });

  it("INV3 absent workspace ⇒ the WORKTREE strategy is selected (the deny-by-default cheapest private tree)", () => {
    const r = realize(room(), opts());
    if (!r.ok) throw new Error("realize refused a sound bare room");
    expect(r.workspace, "the realized room must name the strategy that built it").toBeDefined();
    expect(r.workspace!.strategy).toBe("worktree");
  });

  it("INV8 cross-gig disjointness: two gigs' workspaces are distinct and neither nests the other", () => {
    fc.assert(fc.property(fc.string({ minLength: 1 }), fc.string({ minLength: 1 }), (gigA, gigB) => {
      fc.pre(gigA !== gigB);
      const a = realize(room(), opts({ gigId: gigA }));
      const b = realize(room(), opts({ gigId: gigB }));
      if (!a.ok || !b.ok) throw new Error("realize refused a sound bare room");
      expect(a.workspace).toBeDefined();
      expect(b.workspace).toBeDefined();
      const pa = a.workspace!.path, pb = b.workspace!.path;
      expect(pa).not.toBe(pb);                       // distinct
      expect(pa.startsWith(pb + "/")).toBe(false);   // b does not contain a
      expect(pb.startsWith(pa + "/")).toBe(false);   // a does not contain b
    }));
  });
});

describe("venue walls — workspace containment is a boundary (INV2,INV16)", () => {
  // A workspace root and paths that are inside it vs adversarially outside it. isContained must
  // reject `../` traversal, absolute escapes, and symlink-as-string escapes — never a prefix match.
  const WS = "/work/gig-1";
  const inside = fc.constantFrom("/work/gig-1/src/a.ts", "/work/gig-1/pkg/b/c.md", "/work/gig-1/deep/nested/x");
  const outside = fc.constantFrom(
    "/work/gig-1/../gig-2/secret.ts",     // traversal escape
    "/work/gig-2/other.ts",               // sibling
    "/etc/passwd",                        // absolute escape
    "/work/gig-1-evil/x",                 // prefix-collision, NOT contained
    "/work/gig-1/../../root",             // double traversal
  );

  it("INV2 containment: isContained(ws, p) is true IFF p resolves within ws — traversal/absolute/prefix escapes refused", () => {
    fc.assert(fc.property(inside, (p) => {
      expect(isContained(WS, p)).toBe(true);
    }));
    fc.assert(fc.property(outside, (p) => {
      expect(isContained(WS, p)).toBe(false);
    }));
  });

  it("INV16 seal-containment: a change-set whose diff touches any path outside the workspace is refused", () => {
    const cleanDiff = ["/work/gig-1/a.ts", "/work/gig-1/b/c.ts"];
    const dirtyDiff = ["/work/gig-1/a.ts", "/work/gig-2/leaked.ts"]; // one path escapes the workspace
    expect(sealTouchesOnlyWorkspace(WS, cleanDiff), "a fully-contained diff seals").toBe(true);
    expect(sealTouchesOnlyWorkspace(WS, dirtyDiff), "one out-of-bounds path refuses the whole seal").toBe(false);
  });
});
