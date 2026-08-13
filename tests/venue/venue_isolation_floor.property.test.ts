// RED — THE VENUE'S WALLS: a declared ISOLATION FLOOR the realizer verifies and FAILS CLOSED on
// (INV4 floor-unmet refuses, never a silent downgrade; INV5 an ok:true strategy provides every
// demanded capability; INV14 host-independence — a strategy the host cannot provide is asserted as a
// REFUSAL, never a skipped test). The floor is an ORTHOGONAL capability set; the host is a DECLARED
// capability profile (never a runtime probe), so these run on any OS. RED because `realize` ignores
// the floor and `hostProfile` today, and `selectStrategy`/`strategyCapabilities` are throwing stubs.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { type Venue } from "../../src/chart.js";
import {
  realize, strategyCapabilities,
  type IsolationCapability, type HostCapabilityProfile, type RealizeOpts,
} from "../../src/venue_realize.js";

const CAPS: IsolationCapability[] = ["filesystem-boundary", "network-namespace", "pid-namespace", "distinct-credential-surface"];

// Declared host profiles — the divergence the venue makes a property, not a surprise at 2am.
const MACOS_DIR: HostCapabilityProfile = { id: "macos-dir", capabilities: ["filesystem-boundary"], strategies: ["worktree"] };
const LINUX_NS: HostCapabilityProfile = { id: "linux-namespaces", capabilities: ["filesystem-boundary", "network-namespace", "pid-namespace"], strategies: ["worktree", "sandboxed-process"] };
const FLY_MICROVM: HostCapabilityProfile = { id: "fly-microvm", capabilities: CAPS, strategies: ["worktree", "sandboxed-process", "container"] };

const roomWithFloor = (floor: IsolationCapability[]): Venue =>
  ({ slug: "floor-room", institution_slug: "quartet", equipment: { tools: [] },
     doors: { ingress: [], egress: [] }, installs: [], credential_surface: [],
     workspace: { isolation_floor: floor }, lifecycle: { policy: "ephemeral" } } as unknown as Venue);

const opts = (host: HostCapabilityProfile, over: Partial<RealizeOpts> = {}): RealizeOpts =>
  ({ seats: [], ambientEnv: {}, gigId: "g", hostProfile: host, ...over });

const meets = (host: HostCapabilityProfile, floor: IsolationCapability[]): boolean =>
  floor.every((c) => host.capabilities.includes(c));

describe("venue walls — the isolation floor fails closed, never downgrades (INV4,INV5)", () => {
  it("INV4 floor-unmet: a floor the host cannot meet REFUSES with 'isolation-floor-unmet' — never ok:true downgraded", () => {
    fc.assert(fc.property(fc.subarray(CAPS, { minLength: 1 }), fc.constantFrom(MACOS_DIR, LINUX_NS, FLY_MICROVM), (floor, host) => {
      fc.pre(!meets(host, floor)); // only the cases the host genuinely cannot satisfy
      const r = realize(roomWithFloor(floor), opts(host));
      expect(r.ok, `floor [${floor}] unmet by ${host.id} must not realize a room`).toBe(false);
      if (!r.ok) expect(r.refusal.code).toBe("isolation-floor-unmet");
    }));
  });

  it("INV5 satisfies-or-exceeds: any ok:true realization's strategy provides EVERY capability the floor demands", () => {
    fc.assert(fc.property(fc.subarray(CAPS), fc.constantFrom(MACOS_DIR, LINUX_NS, FLY_MICROVM), (floor, host) => {
      fc.pre(meets(host, floor)); // the host can build a satisfying strategy
      const r = realize(roomWithFloor(floor), opts(host));
      expect(r.ok, `floor [${floor}] met by ${host.id} must realize`).toBe(true);
      if (!r.ok) return;
      expect(r.workspace, "an ok realization must name the strategy that met the floor").toBeDefined();
      const provided = new Set(strategyCapabilities(r.workspace!.strategy));
      for (const c of floor) expect(provided.has(c), `strategy ${r.workspace!.strategy} must provide ${c}`).toBe(true);
    }));
  });
});

describe("venue walls — host-independence: divergence is asserted, never skipped (INV14)", () => {
  it("INV14 a hard floor on a macOS-dir host is a REFUSAL we assert; the SAME venue on a Fly microVM realizes", () => {
    // Asserted logically from a DECLARED profile — no real namespace is probed, nothing is `it.skip`-ed.
    const hardFloor = roomWithFloor(["network-namespace", "pid-namespace"]);

    const local = realize(hardFloor, opts(MACOS_DIR)); // "works locally" — the cheap host cannot meet it
    expect(local.ok, "a macOS-dir host cannot provide namespaces — it must REFUSE, not downgrade or skip").toBe(false);
    if (!local.ok) expect(local.refusal.code).toBe("isolation-floor-unmet");

    const drain = realize(hardFloor, opts(FLY_MICROVM)); // "works on drain" — the microVM meets the floor
    expect(drain.ok, "a Fly microVM meets the hard floor — the same venue realizes here").toBe(true);
  });
});
