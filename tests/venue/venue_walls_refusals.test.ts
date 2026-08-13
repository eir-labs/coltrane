// RED — THE VENUE'S WALLS: refusal discipline for the two new breaches (INV9 teardown residue-free
// & non-interfering across gigs' workspaces/ports; INV10 every RefusalCode carries a deny-by-default
// inert surface, INCLUDING the two new codes; INV11 the new checks join the ORDERED gauntlet — one
// breach named per refusal, existing codes retain precedence, floor and port checks sit BEFORE the
// per-seat ceiling). RED because `realize` does not yet produce the new refusals nor stamp
// workspace/ports — an absent enforcement, not a type error.
import { describe, it, expect } from "vitest";
import { type Venue } from "../../src/chart.js";
import { realize, type Realization, type RealizeOpts, type HostCapabilityProfile } from "../../src/venue_realize.js";
import { testAgent } from "../_support/agents.js";

const MACOS_DIR: HostCapabilityProfile = { id: "macos-dir", capabilities: ["filesystem-boundary"], strategies: ["worktree"] };

const room = (over: Partial<Venue> = {}): Venue =>
  ({ slug: "walls-room", institution_slug: "quartet", equipment: { tools: [] },
     doors: { ingress: [], egress: [] }, installs: [], credential_surface: [],
     lifecycle: { policy: "ephemeral" }, ...over } as unknown as Venue);

const opts = (over: Partial<RealizeOpts> = {}): RealizeOpts =>
  ({ seats: [], ambientEnv: {}, gigId: "g", ...over });

const assertInert = (r: Realization): void => {
  // Deny-by-default inert surface: a refused room grants nothing and is already torn down.
  expect(r.canReach("anything")).toBe(false);
  expect(r.canAccept("anything")).toBe(false);
  expect(r.tornDown()).toBe(true);
  expect(typeof r.teardown).toBe("function");
};

describe("venue walls — teardown is residue-free and non-interfering across gigs (INV9)", () => {
  it("INV9 tearing gig A down leaves gig B's workspace and ports intact, and A inert", () => {
    const v = room({ ports: { count: 1 } as Venue["ports"] });
    const a = realize(v, opts({ gigId: "gig-A" }));
    const b = realize(v, opts({ gigId: "gig-B", portsHeld: [] }));
    if (!a.ok || !b.ok) throw new Error("realize refused a sound room");
    expect(a.workspace, "each gig holds its own workspace").toBeDefined();
    expect(b.workspace).toBeDefined();
    expect(b.ports, "each gig holds its own assigned ports").toBeDefined();
    const bPathBefore = b.workspace!.path;
    const bPortsBefore = [...b.ports!];
    a.teardown();
    expect(a.tornDown()).toBe(true);
    expect(a.canReach("x")).toBe(false); // A's residue is gone
    expect(b.tornDown()).toBe(false);    // B untouched
    expect(b.workspace!.path).toBe(bPathBefore);
    expect(b.ports).toEqual(bPortsBefore);
  });
});

describe("venue walls — every refusal is inert, including the new codes (INV10)", () => {
  const cases: { code: string; make: () => Realization }[] = [
    { code: "wildcard-door", make: () => realize(room({ doors: { ingress: [], egress: ["*"] } }), opts()) },
    { code: "standing-without-cadence", make: () => realize(room({ lifecycle: { policy: "standing" } as Venue["lifecycle"] }), opts()) },
    { code: "install-digest-mismatch", make: () => realize(room({ installs: ["sha256:" + "a".repeat(64)] as Venue["installs"] }), opts()) },
    { code: "credential-breach", make: () => realize(room({ credential_surface: [] }), opts({ credentialsPresent: ["aws-root-key"] })) },
    { code: "ceiling-empty", make: () => realize(room({ equipment: { tools: ["Read"] } }), opts({ seats: [{ agent: testAgent({ slug: "p", primitives: ["SENSE"], allowed_tools: ["Bash"] }) }] })) },
    // The two NEW breaches — RED today because realize does not yet produce them:
    { code: "isolation-floor-unmet", make: () => realize(room({ workspace: { isolation_floor: ["network-namespace"] } as Venue["workspace"] }), opts({ hostProfile: MACOS_DIR })) },
    { code: "port-exhausted", make: () => realize(room({ ports: { range: [3000, 3001], count: 5 } as Venue["ports"] }), opts()) },
  ];

  for (const c of cases) {
    it(`INV10 refusal '${c.code}' carries a deny-by-default inert surface`, () => {
      const r = c.make();
      expect(r.ok, `venue breach '${c.code}' must refuse`).toBe(false);
      if (!r.ok) {
        expect(r.refusal.code).toBe(c.code);
        assertInert(r);
      }
    });
  }
});

describe("venue walls — the new checks join the ordered gauntlet (INV11)", () => {
  it("INV11 existing precedence retained: a wildcard door OUTRANKS an unmet floor — one breach, wildcard-door", () => {
    const both = room({ doors: { ingress: [], egress: ["*"] }, workspace: { isolation_floor: ["network-namespace"] } as Venue["workspace"] });
    const r = realize(both, opts({ hostProfile: MACOS_DIR }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.code).toBe("wildcard-door"); // structural room defect precedes the floor check
  });

  it("INV11 floor precedes the per-seat ceiling: floor-unmet AND ceiling-empty ⇒ isolation-floor-unmet", () => {
    const v = room({
      equipment: { tools: ["Read"] },
      workspace: { isolation_floor: ["network-namespace"] } as Venue["workspace"],
    });
    const seat = { agent: testAgent({ slug: "p", primitives: ["SENSE"], allowed_tools: ["Bash"] }) }; // ceiling-empty too
    const r = realize(v, opts({ seats: [seat], hostProfile: MACOS_DIR }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.code).toBe("isolation-floor-unmet"); // the ROOM is unsound before a seat's ceiling is judged
  });

  it("INV11 port need precedes the per-seat ceiling: port-exhausted AND ceiling-empty ⇒ port-exhausted", () => {
    const v = room({
      equipment: { tools: ["Read"] },
      ports: { range: [3000, 3001], count: 5 } as Venue["ports"],
    });
    const seat = { agent: testAgent({ slug: "p", primitives: ["SENSE"], allowed_tools: ["Bash"] }) };
    const r = realize(v, opts({ seats: [seat] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.code).toBe("port-exhausted");
  });
});
