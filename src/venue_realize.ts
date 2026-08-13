// THE REALIZE BOUNDARY — a Venue contract turned into an observable, enforced performance space.
//
// A venue is a two-thirds-built control before this file exists: the DECLARATION (`VenueSchema`)
// and the COMPOSE-TIME check (`venueEffectiveTools` → `composeChart` R10) are real and tested, but
// nothing at runtime consults the room. `realize` is the single mediating boundary that closes the
// gap — it takes a `Venue` plus the seats/environment about to run in it and returns a `Realization`
// discriminated on `ok`: a success carrying the enforced surface (the intersected tool ceiling per
// seat, the credential allowlist, the door reachability predicates, per-gig isolation, lifecycle,
// and the accountable office) or a fail-closed `Refusal` naming exactly one breach.
//
// Deny-by-default is the posture at every optional field: absent doors reach nothing, an absent
// credential surface makes any present credential a breach, absent installs pin nothing. The tool
// ceiling flows through the EXISTING `venueEffectiveTools` (src/chart.ts) — never an inline
// intersection — so runtime enforcement and the compose-time R10 check share one oracle and cannot
// drift. The invariant is OBSERVABLE (canReach/canAccept), the mechanism (namespace vs proxy vs
// container) is left to a lower layer, exactly as the RED spec leaves it open.
import { venueEffectiveTools, type Venue } from "./chart.js";
import type { Agent } from "./composition.js";
import { venueDefect } from "./genome_schema.js";

/** The named failure modes. Each has exactly one construction site in `realize`; a breach yields a
 *  refusal, never a narrowed-but-proceeding realization. */
export type RefusalCode =
  | "ceiling-empty"
  | "credential-breach"
  | "install-digest-mismatch"
  | "standing-without-cadence"
  | "wildcard-door"
  | "unknown-venue"
  // THE VENUE'S WALLS — two new fail-closed breaches join the ordered gauntlet:
  //   `isolation-floor-unmet` when the host's declared capability profile cannot provide every
  //   capability the venue's isolation floor demands (never a silent downgrade wall→convention), and
  //   `port-exhausted` when the venue's declared port need cannot be satisfied against the ports
  //   already held (a collision is an allocation refusal, not a race).
  | "isolation-floor-unmet"
  | "port-exhausted";

/** One seat to realize in the room. */
export interface RealizeSeat {
  agent: Agent;
}

/** What a caller hands `realize`: the seats about to run, the ambient environment, and the runtime
 *  facts the room must check against (credentials/installs actually present) plus the gig identity
 *  that scopes isolation. Optional fields lean deny-by-default when absent. */
export interface RealizeOpts {
  seats: RealizeSeat[];
  ambientEnv: Record<string, string>;
  /** Credential CLASSES detected in the ambient environment (not material). */
  credentialsPresent?: string[];
  /** Installs actually present, each with the digest of what is there. */
  installsPresent?: { ref: string; digest: string }[];
  /** Scopes the per-gig isolation handle. */
  gigId: string;
  /** The declared capability profile of the host the realizer runs on (macOS dev host, Linux
   *  namespaces, Fly microVM). The realizer verifies the venue's isolation floor against THIS —
   *  it is a declared profile, not a runtime probe, so the suite stays host-independent. Absent =>
   *  a bare host that offers only the WORKTREE convention (no namespaces). */
  hostProfile?: HostCapabilityProfile;
  /** Ports already held by concurrent realizations. Allocation must be disjoint from these or refuse
   *  `port-exhausted`; absent => none held. */
  portsHeld?: number[];
}

/** One seat as realized: its slug, the tools the room actually advertises for it (grants ∩
 *  equipment), and the default-deny env it runs with. */
export interface SeatRealization {
  agent_slug: string;
  effective_tools: string[];
  env: Record<string, string>;
}

/** The lifecycle carried onto a realized record, verbatim from the contract. */
export interface RealizedLifecycle {
  policy: "ephemeral" | "standing";
  rebuild_cadence?: string;
}

/** The observable surface every realization carries — present on BOTH a success and a refusal.
 *  A caller holding an un-narrowed `Realization` (e.g. the model test's `Real = { r: Realization }`,
 *  which probes `canReach`/`teardown`/`tornDown` without discriminating on `ok`) can question the
 *  room and tear it down without first knowing whether it stood up. On a refusal the surface is
 *  DENY-BY-DEFAULT and inert: nothing is reachable, nothing is accepted, no seat exists, and the
 *  room is already (vacuously) torn down — so exposing the surface on a refusal cannot widen a
 *  grant, it only makes a refused room honestly answer "nothing here". The type widens; the room
 *  does not. */
export interface RealizationSurface {
  /** Egress probe: true iff `host ∈ doors.egress` and the room has not been torn down. */
  canReach(host: string): boolean;
  /** Ingress probe: true iff `origin ∈ doors.ingress`. */
  canAccept(origin: string): boolean;
  isolation_handle: string;
  seats: SeatRealization[];
  tornDown(): boolean;
  teardown(): void;
}

/** A successful realization — the enforced, observable performance space. Adds the success-only
 *  facts (provisioned credentials, the accountable office, the carried lifecycle) atop the surface. */
export interface RealizationOk extends RealizationSurface {
  ok: true;
  provisioned_credentials: string[];
  responsible_chair?: string;
  lifecycle: RealizedLifecycle;
  /** The private write boundary this gig holds: a path, the strategy that built it, and whether it
   *  is ephemeral. Deny-by-default — absent workspace on the contract still yields a private
   *  ephemeral WORKTREE here, never the host's cwd. Undefined until the walls seam is implemented. */
  workspace?: RealizedWorkspace;
  /** The concrete ports the realizer assigned this gig from the venue's declared need. Disjoint from
   *  any other concurrent gig's. Undefined until the walls seam is implemented. */
  ports?: number[];
}

/** A fail-closed refusal — one named breach, no partial room. Carries the same observable surface
 *  as a success (deny-by-default no-ops) so the union is uniform, plus the named breach. */
export interface RealizationRefusal extends RealizationSurface {
  ok: false;
  refusal: { code: RefusalCode; detail: string };
}

export type Realization = RealizationOk | RealizationRefusal;

/** Monotone per-process counter: makes `isolation_handle` distinct across every `realize` call, so
 *  two calls — even with the same gigId — never collide, which is the strongest reading of the
 *  per-gig isolation invariant (only inter-gigId distinctness is pinned; this cannot violate it). */
let realizeCounter = 0;

/** Build a refusal carrying the full observable surface as deny-by-default no-ops: a refused room
 *  reaches nothing, accepts nothing, seats no one, and is already torn down. `isolation_handle` is a
 *  stable sentinel — no test compares a refusal's handle; only OK realizations' handles are pinned
 *  for inter-gig distinctness (I13). Exposing the surface here keeps the union uniform for callers
 *  that hold it un-narrowed, without ever widening a grant. */
const refuse = (code: RefusalCode, detail: string): RealizationRefusal => ({
  ok: false,
  refusal: { code, detail },
  canReach: () => false,
  canAccept: () => false,
  isolation_handle: "venue:refused",
  seats: [],
  tornDown: () => true,
  teardown: () => {},
});

/**
 * Realize a Venue contract into an enforced, observable performance space.
 *
 * The failure modes are an ORDERED gauntlet: the first breach returns a refusal before any success
 * object is built. The order is deliberate — structural room defects (wildcard door, snowflake
 * standing, install digest, credential surface) are checked before the per-seat ceiling, so a room
 * that is itself unsound is refused for the room's reason, not a seat's.
 */
export function realize(venue: Venue, opts: RealizeOpts): Realization {
  const egress = venue.doors?.egress ?? [];
  const ingress = venue.doors?.ingress ?? [];

  // (a) wildcard-door — checked at the realize layer independent of schema parse, because a Venue
  //     can be constructed in memory without re-parsing (I16 smuggles '*' past VenueSchema). Both
  //     directions are guarded: the schema forbids '*' in either, so the realize layer mirrors it.
  for (const h of [...egress, ...ingress]) {
    if (h.trim() === "*") {
      return refuse("wildcard-door", `venue "${venue.slug}" carries a wildcard door ("*") — a wildcard door is not a door`);
    }
  }

  // (b) standing-without-cadence — delegate to venueDefect rather than re-encode the standing rule,
  //     so the realize layer and the schema's cross-field check share one statement of it.
  const defect = venueDefect(venue);
  if (defect !== null) {
    return refuse("standing-without-cadence", defect);
  }

  // (c) install-digest-mismatch — every pin must be matched exactly by some present digest, else the
  //     room's identity is not what it claims. Absence is a mismatch, not a pass.
  const present = opts.installsPresent ?? [];
  for (const pin of venue.installs) {
    if (!present.some((p) => p.digest === pin)) {
      return refuse(
        "install-digest-mismatch",
        `venue "${venue.slug}" pins install ${pin} but no present install carries that digest`,
      );
    }
  }

  // (d) credential-breach — any present class outside the declared surface is a breach; refuse, do
  //     NOT strip. A stripped credential would make the breach pass as a narrowed realization.
  const credentialsPresent = opts.credentialsPresent ?? [];
  const surface = new Set(venue.credential_surface);
  const undeclared = credentialsPresent.filter((c) => !surface.has(c));
  if (undeclared.length > 0) {
    return refuse(
      "credential-breach",
      `venue "${venue.slug}" surface admits [${venue.credential_surface.join(", ")}] but [${undeclared.join(", ")}] is present and undeclared`,
    );
  }

  // (e) ceiling — apply the equipment ceiling through the shared oracle, per seat. An agent that
  //     grants something but whose grants ∩ equipment is empty refuses fail-closed; an agent that
  //     grants nothing realizes with an empty tool set (deny-by-default, not a breach).
  const seats: SeatRealization[] = [];
  for (const seat of opts.seats) {
    const grants = seat.agent.allowed_tools ?? [];
    const effective_tools = venueEffectiveTools(seat.agent, venue);
    if (grants.length > 0 && effective_tools.length === 0) {
      return refuse(
        "ceiling-empty",
        `agent "${seat.agent.slug}" grants [${grants.join(", ")}] but none lie within venue "${venue.slug}" equipment — the room narrows it to nothing`,
      );
    }
    // env is a default-deny map: nothing from the ambient environment leaks into a seat. No test
    // pins seat.env values; the strictest posture is the safe one until a spec names otherwise.
    seats.push({ agent_slug: seat.agent.slug, effective_tools, env: {} });
  }

  // The room is sound. Build the observable realization with per-call isolation and idempotent
  // teardown. `torn` is closed over this call alone, so tearing one gig's room down cannot touch
  // another's.
  const isolation_handle = `venue:${venue.slug}:gig:${opts.gigId}:${++realizeCounter}`;
  let torn = false;

  const lifecycle: RealizedLifecycle =
    venue.lifecycle.rebuild_cadence !== undefined
      ? { policy: venue.lifecycle.policy, rebuild_cadence: venue.lifecycle.rebuild_cadence }
      : { policy: venue.lifecycle.policy };

  const ok: RealizationOk = {
    ok: true,
    seats,
    provisioned_credentials: [...credentialsPresent],
    canReach: (host: string): boolean => !torn && egress.includes(host),
    canAccept: (origin: string): boolean => ingress.includes(origin),
    isolation_handle,
    lifecycle,
    tornDown: (): boolean => torn,
    teardown: (): void => {
      torn = true;
    },
    ...(venue.responsible_chair !== undefined ? { responsible_chair: venue.responsible_chair } : {}),
  };
  return ok;
}

/**
 * Resolve a venue by slug from the caller's map, then realize it. A slug the map does not hold is a
 * dead name — it fails closed with `unknown-venue`, never a default-open room, exactly as an
 * unresolvable tool grant fails closed rather than confabulating a provider.
 */
export function resolveAndRealize(
  slug: string,
  opts: RealizeOpts & { venues: Map<string, Venue> },
): Realization {
  const venue = opts.venues.get(slug);
  if (venue === undefined) {
    return refuse("unknown-venue", `no venue is registered under slug "${slug}" — a dead name fails closed`);
  }
  return realize(venue, opts);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE VENUE'S WALLS — the realization SEAM (RED). A venue declares WHAT MUST BE TRUE of the room; the
// realizer decides HOW to build it and VERIFIES it, with more than one strategy behind the one
// contract. These signatures/return types are authored so the tree COMPILES (tsc --noEmit clean);
// the bodies THROW so every RED assertion reds because the enforcement is ABSENT — never because a
// symbol is missing or a type mismatches, exactly as src/institution_enforcement.ts staged its seam.
// A later implementation gig fills the bodies (and threads workspace + ports into `realize`'s OK
// object and onto the gig ctx in src/runtime.ts); OUT OF SCOPE here: the CONTAINER and microVM
// realizers, and network-namespace egress enforcement (named as the follow-on).
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** One orthogonal isolation capability a floor may demand. Mirrors `IsolationCapabilitySchema`. */
export type IsolationCapability =
  | "filesystem-boundary"
  | "network-namespace"
  | "pid-namespace"
  | "distinct-credential-surface";

/** The strategies behind the one contract. WORKTREE and SANDBOXED-PROCESS are the two this repo can
 *  honestly exercise; CONTAINER (and, later, microVM) are the specified-but-stubbed seam. */
export type RealizationStrategy = "worktree" | "sandboxed-process" | "container" | "microvm";

/** The declared capability profile of the host the realizer runs on — a DECLARED profile, not a
 *  runtime probe, so the suite stays host-independent. `capabilities` is what walls this host can
 *  provide; `strategies` is which strategies it can build. */
export interface HostCapabilityProfile {
  /** e.g. "macos-dir" | "linux-namespaces" | "fly-microvm". */
  id: string;
  capabilities: IsolationCapability[];
  strategies: RealizationStrategy[];
}

/** A realized private write boundary: the path the gig may write within, the strategy that built the
 *  wall, and whether it is ephemeral. */
export interface RealizedWorkspace {
  path: string;
  strategy: RealizationStrategy;
  ephemeral: boolean;
}

/** A venue's declared bind-port need, mirrored from `VenuePortsSchema`. */
export interface PortNeed {
  count?: number;
  range?: [number, number];
  named?: string[];
}

/** The isolation capabilities a strategy provides. WORKTREE provides none of the hard walls (it is
 *  isolation by convention); SANDBOXED-PROCESS provides filesystem/network/pid boundaries via Linux
 *  namespaces; CONTAINER adds a distinct credential surface. RED: unimplemented. */
export function strategyCapabilities(_strategy: RealizationStrategy): IsolationCapability[] {
  throw new Error(
    "NOT IMPLEMENTED: strategyCapabilities — the strategy→capability map is the venue-walls seam (RED)",
  );
}

/** Choose the cheapest strategy the host can build whose capabilities are a superset of the declared
 *  floor. Returns null when NO available strategy satisfies the floor — the caller must then refuse
 *  `isolation-floor-unmet`, never downgrade. RED: unimplemented. */
export function selectStrategy(
  _floor: IsolationCapability[],
  _host: HostCapabilityProfile,
): RealizationStrategy | null {
  throw new Error(
    "NOT IMPLEMENTED: selectStrategy — floor-vs-host strategy selection is the venue-walls seam (RED)",
  );
}

/** True IFF `writePath` resolves strictly within `workspacePath` — the containment predicate that
 *  makes a workspace a boundary. Must reject `../` traversal, absolute escapes, and symlink-as-string
 *  escapes, not just prefix-match. RED: unimplemented. */
export function isContained(_workspacePath: string, _writePath: string): boolean {
  throw new Error(
    "NOT IMPLEMENTED: isContained — workspace containment is the venue-walls seam (RED)",
  );
}

/** A sealed change-set's diff may touch ONLY paths within the declared workspace — the best-effort
 *  post-run guard that makes files a produced artifact bounded by the workspace rather than an
 *  ambient side effect (the WORKTREE strategy's convention made checkable). True IFF every touched
 *  path is contained. RED: unimplemented. */
export function sealTouchesOnlyWorkspace(_workspacePath: string, _touchedPaths: string[]): boolean {
  throw new Error(
    "NOT IMPLEMENTED: sealTouchesOnlyWorkspace — seal-containment is the venue-walls seam (RED)",
  );
}

/** Assign concrete ports for a declared need, disjoint from `held`. Refuses (ok:false) on exhaustion
 *  — a collision is an allocation refusal, not a race. RED: unimplemented. */
export function allocatePorts(
  _need: PortNeed,
  _held: number[],
): { ok: true; ports: number[] } | { ok: false } {
  throw new Error(
    "NOT IMPLEMENTED: allocatePorts — port allocation is the venue-walls seam (RED)",
  );
}
