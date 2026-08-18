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
  | "unknown-venue";

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
 * The env keys a seat may carry from the ambient environment — the minimum a process needs to
 * EXECUTE: PATH so the OS can locate its binary, HOME so the binary can resolve its own config. An
 * explicit ALLOWLIST, not a deny-list: a key absent from this list never reaches the seat, so a
 * credential added to the container later is excluded by default rather than by anyone remembering
 * to strip it. This is the deny-by-default posture held unconditionally — it does not depend on the
 * completeness of any strip-list (`withoutBoxCredentials`'s `BOX_CREDENTIAL_ENV` is a floor for the
 * paths that never reach here, not the control).
 *
 * Why it is not `[]`: the seat env was `{}` (deny EVERYTHING), which is airtight but unspawnable —
 * a `claude -p` child with no PATH cannot find its binary and dies with `spawn claude ENOENT`
 * (measured, gig 87cffa2c), so no venue-confined seat ever ran. `['PATH','HOME']` is the
 * minimum-viable widening: enough to start, no credential material.
 *
 * Why USER is admitted: on a macOS host with no `~/.claude/.credentials.json`, Claude auth is
 * keychain-backed (a `Claude Code-credentials` keychain entry), and the keychain lookup needs USER
 * to resolve the account. Measured: `claude -p` under {PATH,HOME} exits 1 with 'Not logged in ·
 * Please run /login'; under {PATH,HOME,USER} it exits 0 and reaches the MCP server (gig 4506b567).
 * On a Linux drain, credentials are file-based under HOME, so PATH+HOME already suffices and this
 * key is inert. USER is a USERNAME, not a credential — admitting it carries no secret material, so
 * the deny-by-default posture is unweakened; the allowlist grows by exactly one non-secret key.
 */
export const SEAT_ENV_ALLOWLIST = ["PATH", "HOME", "USER"] as const;

/**
 * Build a seat's env as the allowlisted subset of the ambient environment. Only keys in
 * `SEAT_ENV_ALLOWLIST` that are present with a defined value are carried; every other key — every
 * credential, every undeclared ambient var — is omitted. Never inherits `ambientEnv` wholesale.
 */
function seatEnv(ambientEnv: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of SEAT_ENV_ALLOWLIST) {
    const value = ambientEnv[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

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
    // env is the ALLOWLISTED subset of the ambient environment (SEAT_ENV_ALLOWLIST): the minimum a
    // process needs to EXECUTE, and nothing else. `env: {}` was the stricter posture but it is
    // UNSPAWNABLE — a child with no PATH dies with `spawn claude ENOENT` (measured, gig 87cffa2c),
    // so no venue-confined seat ever started. Every credential and undeclared ambient var stays out
    // by default; this widening only admits PATH/HOME.
    seats.push({ agent_slug: seat.agent.slug, effective_tools, env: seatEnv(opts.ambientEnv) });
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
