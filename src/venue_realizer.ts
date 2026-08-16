// venue_realizer.ts — WHERE a room is realized, and WHAT it is realized on.
//
// This is the other half of Gap 2 (SPEC-worker-contract.md): a venue declares WHICH substrate it
// needs, a deployment declares WHICH substrates it provides, and this module refuses the mismatch
// rather than degrading silently. A venue that requires isolation, realized on a substrate that
// cannot provide it, RUNS and believes it is isolated — a false guarantee is strictly worse than a
// refusal, because a guarantee is exactly the thing a venue's author reasons against.
//
// The renderer is pinned from both directions: it EMITS only from a closed allowlist, so a forbidden
// setting cannot appear from contract data; and it REFUSES input that smuggles a forbidden value
// through an allowlisted FIELD, because an allowlist over field NAMES says nothing about what those
// fields CONTAIN. Rendering a runtime configuration from contract data is code generation from data,
// and if any part of the input is reachable by a gig, a permissive renderer is remote code execution
// with extra steps.
import { existsSync } from "node:fs";
import { VenueSchema, DEVICE_CLASSES, type VenueOutput } from "./genome_schema.js";
import { sha256Hex, canonStructuralJson } from "./canonical_form.js";

export { DEVICE_CLASSES };

/** Credentials reach the room ONLY through here: bound at realization time from `credential_names`,
 *  a subset of the venue's `credential_surface`. Injected the way the engine already injects one. */
export type CredentialResolver = (names: readonly string[]) => Promise<Record<string, string>>;

/** The properties a realizer may CLAIM — and may only claim if it can actually keep them. */
export type VenueGuarantee =
  | "withholds_capabilities"
  | "isolated_filesystem"
  | "network_policy_doors"
  | "reproducible_tool_surface"
  | "per_chair_isolation";

/** One thing a realizer created, LABELLED with both the gig it belongs to and the instance that made
 *  it — an unlabelled artifact is indistinguishable from something a human made on purpose, so
 *  nothing may safely collect it. */
export interface RealizedArtifact {
  kind: string;
  id: string;
  labels: { gig_id: string; instance: string };
}

/** A ceiling on what survives outside the per-gig lifecycle. The point is that a bound EXISTS. */
export interface RetentionPolicy {
  max_cached_build_artifacts: number;
  max_unreferenced_environments: number;
  cadence: string;
}

/** WHERE a room is stood up. Absent endpoint = the worker's own machine. The device map lives here,
 *  not in the contract: which nodes `serial` means, and which group owns them, are the machine's
 *  facts rather than the room's. */
export interface RealizationHost {
  endpoint?: string;
  architecture: string;
  devices: Readonly<Record<string, { nodes: readonly string[]; group: string }>>;
  /** Per gig, against a live lease — never held at boot. See src/workspace.ts:60-89. */
  credential?: (args: { gigId: string }) => Promise<string>;
}

export interface RealizationHandle {
  state: string;
  mcpServerConfigs: Readonly<Record<string, unknown>>;
  configPath: string;
  artifacts: readonly RealizedArtifact[];
  teardown(): Promise<void> | void;
  tornDown(): boolean;
}

export interface RealizeOpts {
  gigId: string;
  engineServers?: Readonly<Record<string, unknown>>;
  probe?: (s: { slug: string }) => Promise<string[]>;
  host?: RealizationHost;
  chairs?: number;
}

/** The seam. The engine ships the interface, the state machine, the probe and the drift guard; a
 *  deployment supplies the implementations it has. Two implementations or it is not a seam. */
export interface VenueRealizer {
  readonly substrate: string;
  readonly guarantees: readonly VenueGuarantee[];
  available(): boolean;
  readonly retention: RetentionPolicy;
  realize(venue: unknown, credentialResolver: CredentialResolver, opts: RealizeOpts): Promise<RealizationHandle>;
  sweep(opts: { liveGigs: readonly string[] }): Promise<readonly RealizedArtifact[]>;
}

// ── The refusals. Each NAMES the thing it refused, so a caller is not left to guess. ──────────────

/** A substrate no available realizer provides is a REFUSAL, never a downgrade — the whole reason
 *  this gap is written down. Names what was required and what this host can actually provide. */
export class VenueSubstrateUnavailable extends Error {
  readonly required: string;
  readonly available: readonly string[];
  constructor(required: string, available: readonly string[]) {
    super(
      `no available realizer provides substrate "${required}" — this host provides only ` +
        `[${available.join(", ")}]; a missing substrate is a refusal, never a downgrade to a weaker realizer`,
    );
    this.name = "VenueSubstrateUnavailable";
    this.required = required;
    this.available = available;
  }
}

/** A HOST cannot host this venue: a device class it does not provide, an architecture it is not.
 *  Distinct from a substrate refusal — the fix is a different machine, not a different runtime. */
export class VenueHostUnsuitable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VenueHostUnsuitable";
  }
}

/** A realization would exceed the venue's declared concurrency ceiling. */
export class VenueConcurrencyRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VenueConcurrencyRefused";
  }
}

/** Input would render a setting the contract may not ask for. Carries `forbidden` so the refusal
 *  names the value, and `field` so it names where it arrived — "invalid venue" sends the author back
 *  to read the whole contract. */
export class VenueRenderRefusal extends Error {
  readonly forbidden: string;
  readonly field: string | undefined;
  constructor(args: { forbidden: string; field?: string; message?: string }) {
    super(
      args.message ??
        `the renderer refuses a forbidden value "${args.forbidden}"` +
          (args.field ? ` smuggled through the allowlisted field "${args.field}"` : ""),
    );
    this.name = "VenueRenderRefusal";
    this.forbidden = args.forbidden;
    this.field = args.field;
  }
}

/** The CLOSED allowlist of contract fields the renderer may substitute. Exact, not a floor: a field
 *  not on this list contributes nothing to the render whatever it is called, and widening the list
 *  is a line someone changes on purpose. */
export const COMPOSE_SUBSTITUTABLE_FIELDS = [
  "credential_names",
  "doors",
  "installs",
  "mcp_servers",
  "slug",
] as const;

// ── Identity: an environment is a function of the CONTRACT, so an unchanged contract rebuilds
//    nothing. floorIdentity isolates the shared base so N venues cost floor + Σ(deltas). ──────────

/** The identity of the environment built from a venue — a function of the parsed contract's content,
 *  so the same contract is the same environment and a changed one is a different environment. */
export function environmentIdentity(venue: unknown): string {
  const v = VenueSchema.parse(venue);
  return `env-${sha256Hex(canonStructuralJson(v))}`;
}

/** The identity of the shared floor a venue composes over. Two venues declaring the same floor
 *  resolve to the SAME floor identity — the precondition for sharing at all. */
export function floorIdentity(venue: unknown): string {
  const v = VenueSchema.parse(venue);
  return `floor-${sha256Hex(canonStructuralJson({ floor: v.floor ?? null }))}`;
}

// ── The renderer. Parsed input only; emits only from the closed allowlist; refuses a forbidden value
//    smuggled through an allowlisted field. ─────────────────────────────────────────────────────

/** Runtime sockets are the one-line escape: a container that can reach the runtime's own socket can
 *  start a second container with the host filesystem mounted. */
const RUNTIME_SOCKET = /docker\.sock|containerd\.sock|podman\.sock|\/var\/run\/docker/i;

/** A single value about to be emitted through an allowlisted field, checked for what an allowlist
 *  over field NAMES cannot see. A runtime socket anywhere, or an absolute host path not derived from
 *  the per-realization directory, is refused by NAME. */
function assertValueRenderable(field: string, value: string, realizationDir: string): void {
  if (RUNTIME_SOCKET.test(value)) {
    throw new VenueRenderRefusal({
      forbidden: value,
      field,
      message:
        `field "${field}" carries a container runtime socket path "${value}" — a runtime socket ` +
        `inside the room is the end of the room, allowlisted field or not`,
    });
  }
  // An absolute host path outside the realization dir has exactly one meaning — see the host —
  // whichever field it arrived in. Paths derived from the per-realization directory are the only
  // absolute paths a room may name.
  if (value.startsWith("/") && !value.startsWith(realizationDir)) {
    throw new VenueRenderRefusal({
      forbidden: value,
      field,
      message:
        `field "${field}" carries the absolute host path "${value}", which is outside the ` +
        `per-realization directory — an arbitrary host path chosen by whoever wrote the contract`,
    });
  }
}

/** Renders the runtime configuration from a PARSED venue. Never from raw input: re-parsing through
 *  `VenueSchema` (which is `.strict()`) is the enforcement point, so an unparsed object carrying an
 *  extra key is refused at the door rather than trusted to have been parsed by every future caller. */
export function renderComposeConfig(
  venue: unknown,
  opts: { gigId: string; realizationDir: string; host?: RealizationHost },
): Record<string, unknown> {
  // PARSED INPUT ONLY. `.strict()` rejects an object carrying a key the contract never declared, so
  // handing the renderer unparsed input cannot walk around it. A parsed venue re-parses idempotently.
  const v: VenueOutput = VenueSchema.parse(venue);
  const { realizationDir } = opts;

  // Scan the CONTENT of every allowlisted field before emitting any of it — the half a naive
  // allowlist misses.
  assertValueRenderable("slug", v.slug, realizationDir);
  for (const dir of ["ingress", "egress"] as const) {
    for (const host of v.doors?.[dir] ?? []) assertValueRenderable("doors", host, realizationDir);
  }
  for (const install of v.installs) assertValueRenderable("installs", install, realizationDir);
  for (const cls of v.credential_surface) assertValueRenderable("credential_names", cls, realizationDir);
  for (const server of v.mcp_servers) {
    assertValueRenderable("mcp_servers", server.slug, realizationDir);
    assertValueRenderable("mcp_servers", server.transport, realizationDir);
    for (const token of server.command) assertValueRenderable("mcp_servers", token, realizationDir);
    for (const cls of server.credential_names) assertValueRenderable("credential_names", cls, realizationDir);
  }

  // Every path in the document is DERIVED from the per-realization directory, so "which host paths
  // can this room see" is answerable by reading this line, not by auditing every venue forever.
  const workspace = `${realizationDir}/workspace`;
  const projectName = `coltrane-${(realizationDir.split("/").filter(Boolean).pop() ?? "room")}`;

  // Credential CLASSES only — the class is the contract's own vocabulary and may appear; the material
  // never does, and the host environment is never inherited wholesale. Each class is a named
  // reference the resolver binds at realization, not a value read here.
  const credentialEnv: Record<string, string> = {};
  for (const cls of v.credential_surface) credentialEnv[cls] = `\${${cls}}`;

  const room: Record<string, unknown> = {
    image: v.floor ? `coltrane/floor:${v.floor}` : "coltrane/room:ephemeral",
    working_dir: workspace,
    // Source AND target derived from the realization dir; no absolute path in the document is not.
    volumes: [`${workspace}:${workspace}:rw`],
    environment: credentialEnv,
    // An internal network, never host networking: the room's network boundary stays the room's.
    networks: ["room-net"],
    // A log bound from the realizer, NOT a venue-substitutable field — a room may not raise its own
    // ceiling. A rendered configuration with no log bound is a defect.
    logging: { driver: "json-file", options: { "max-size": "10m", "max-file": "3" } },
    labels: { "coltrane.managed": "true", "coltrane.slug": v.slug, "coltrane.project": projectName },
    // The allowlisted contract fields, substituted verbatim after the value-level scan above.
    "x-coltrane-room": {
      slug: v.slug,
      doors: v.doors ?? { ingress: [], egress: [] },
      installs: v.installs,
      credential_classes: v.credential_surface,
      mcp_servers: v.mcp_servers.map((s) => ({
        slug: s.slug,
        transport: s.transport,
        command: s.command,
        credential_names: s.credential_names,
      })),
    },
  };

  // Devices: map EXACTLY the declared class's nodes and the owning group, and widen nothing — no
  // privileged mode, no capabilities, no wildcard device rule. Only when a host maps the class.
  if (opts.host && v.devices.length > 0) {
    const deviceMounts: string[] = [];
    const groups = new Set<string>();
    for (const cls of v.devices) {
      const mapped = opts.host.devices[cls];
      if (!mapped) continue; // a class the host does not provide is refused in realize(), not here
      for (const node of mapped.nodes) deviceMounts.push(`${node}:${node}:rw`);
      groups.add(mapped.group);
    }
    if (deviceMounts.length > 0) {
      room["devices"] = deviceMounts;
      room["group_add"] = [...groups];
    }
  }

  return {
    version: "3.8",
    name: projectName,
    services: { room },
    networks: { "room-net": { internal: true } },
  };
}

// ── selectRealizer: picks the realizer a venue requires from those a deployment supplies. Throws
//    rather than returning a weaker one. ──────────────────────────────────────────────────────

/** Picks the realizer a venue requires from those a deployment supplies. A required substrate no
 *  AVAILABLE realizer provides is a `VenueSubstrateUnavailable`, never a downgrade. A venue naming no
 *  substrate is realizable by whatever the deployment supplies — deny-by-default is on capability,
 *  not on portability. */
export function selectRealizer(venue: unknown, realizers: readonly VenueRealizer[]): VenueRealizer {
  const v = VenueSchema.parse(venue);
  const provided = realizers.map((r) => r.substrate);
  const available = realizers.filter((r) => r.available());

  const required = v.substrate;
  if (!required) {
    const pick = available[0];
    if (!pick) throw new VenueSubstrateUnavailable("(any)", provided);
    return pick;
  }
  const match = available.find((r) => r.substrate === required);
  if (!match) throw new VenueSubstrateUnavailable(required, provided);
  return match;
}

// ── The two implementations. ──────────────────────────────────────────────────────────────────

/** HOST-WIDE observed state, so a sweep reconciles against what EXISTS rather than against anything
 *  this process remembers — the only model that survives a killed worker running no `finally`. */
const HOST_ARTIFACTS = new Map<string, RealizedArtifact>();
/** Who this process is, so a reconciled artifact says which instance created it. */
const INSTANCE = `instance-${process.pid}`;
let ARTIFACT_SEQ = 0;

function buildMcpConfigs(v: VenueOutput, opts: RealizeOpts): Promise<Record<string, unknown>> {
  return (async () => {
    const configs: Record<string, unknown> = { ...(opts.engineServers ?? {}) };
    for (const server of v.mcp_servers) {
      if (opts.probe) await opts.probe({ slug: server.slug });
      configs[server.slug] = { command: server.command[0], args: server.command.slice(1) };
    }
    return configs;
  })();
}

function makeHandle(
  state: string,
  mcpServerConfigs: Record<string, unknown>,
  configPath: string,
  artifacts: RealizedArtifact[],
): RealizationHandle {
  let torn = false;
  for (const a of artifacts) HOST_ARTIFACTS.set(a.id, a);
  return {
    state,
    mcpServerConfigs,
    configPath,
    artifacts,
    teardown() {
      torn = true;
      for (const a of artifacts) HOST_ARTIFACTS.delete(a.id);
    },
    tornDown() {
      return torn;
    },
  };
}

async function sweep(opts: { liveGigs: readonly string[] }): Promise<readonly RealizedArtifact[]> {
  const live = new Set(opts.liveGigs);
  return [...HOST_ARTIFACTS.values()].filter((a) => !live.has(a.labels.gig_id));
}

/** The baseline. Runs seats as subprocesses of a host that holds the git binary, the remote and the
 *  network — so it CANNOT withhold capabilities and CANNOT enforce `doors` at a network boundary,
 *  and it claims neither. src/workspace.ts:44-56 is already candid that process-level protection is
 *  not a security control and must not be described as one, so claiming those guarantees would be a
 *  false contract a caller would rely on. Must work on a host with no container runtime and no
 *  daemon installed. */
export function localProcessRealizer(): VenueRealizer {
  const substrate = "local-process";
  return {
    substrate,
    // Claims ONLY what a subprocess of the host can actually keep: the tool surface is reproducible
    // from the contract regardless of substrate. NOT withholds_capabilities, NOT network_policy_doors.
    guarantees: ["reproducible_tool_surface"],
    available: () => true, // the baseline may not require a daemon
    retention: { max_cached_build_artifacts: 32, max_unreferenced_environments: 8, cadence: "PT30M" },
    async realize(venue, _credentialResolver, opts) {
      const v = VenueSchema.parse(venue);
      if (v.substrate && v.substrate !== substrate) {
        // Refuse a venue that names a substrate this realizer is not — before probing anything.
        throw new VenueSubstrateUnavailable(v.substrate, [substrate]);
      }
      const configs = await buildMcpConfigs(v, opts);
      const artifacts: RealizedArtifact[] = [
        { kind: "local-process-group", id: `lpg-${opts.gigId}-${ARTIFACT_SEQ++}`, labels: { gig_id: opts.gigId, instance: INSTANCE } },
      ];
      return makeHandle("PLAYING", configs, `${opts.gigId}.local`, artifacts);
    },
    sweep,
  };
}

/** The containerized realizer. Names a real boundary and may claim the guarantees it provides. MUST
 *  NOT throw on construction — the out-of-scope laws call `.realize()` with mocks, and a construction
 *  throw would contaminate the seam family's shared setup. Host suitability (architecture, device
 *  classes) and the concurrency ceiling are answered BEFORE probing anything. */
export function dockerComposeRealizer(): VenueRealizer {
  const substrate = "container";
  return {
    substrate,
    guarantees: [
      "withholds_capabilities",
      "isolated_filesystem",
      "network_policy_doors",
      "reproducible_tool_surface",
      "per_chair_isolation",
    ],
    // Best-effort: a container runtime socket present on this host. Not consulted by selectRealizer
    // in the P1 laws (they inject availability), but honest for a deployment that does.
    available: () => existsSync("/var/run/docker.sock"),
    retention: { max_cached_build_artifacts: 16, max_unreferenced_environments: 8, cadence: "PT15M" },
    async realize(venue, credentialResolver, opts) {
      const v = VenueSchema.parse(venue);
      if (v.substrate && v.substrate !== substrate) {
        throw new VenueSubstrateUnavailable(v.substrate, [substrate]);
      }
      const host = opts.host;
      // Architecture: knowable at construction, so answered at construction rather than as a
      // confusing run-time failure on someone else's machine. Absent means any.
      if (v.architectures.length > 0 && host && !v.architectures.includes(host.architecture)) {
        throw new VenueHostUnsuitable(
          `venue "${v.slug}" supports [${v.architectures.join(", ")}], but host is "${host.architecture}"`,
        );
      }
      // Device classes: a class the host does not provide is a refusal, not a silent omission.
      for (const cls of v.devices) {
        if (!host || !host.devices[cls]) {
          throw new VenueHostUnsuitable(
            `venue "${v.slug}" needs device class "${cls}", which this host does not provide`,
          );
        }
      }
      // Concurrency ceiling: a phase wider than the room may hold is refused, not quietly served.
      if (typeof v.max_concurrent_chairs === "number" && typeof opts.chairs === "number" && opts.chairs > v.max_concurrent_chairs) {
        throw new VenueConcurrencyRefused(
          `venue "${v.slug}" holds ${v.max_concurrent_chairs} chair(s); a phase of ${opts.chairs} exceeds it`,
        );
      }
      // A remote realization obtains an administrative host credential PER GIG, against a live lease,
      // never at boot — the discipline src/workspace.ts:60-89 documents for the git credential. A
      // local realization asks for none.
      if (host?.endpoint && host.credential) {
        await host.credential({ gigId: opts.gigId });
      }
      // Bind credentials only through the resolver, from names ⊆ surface. Never inherit host env.
      const requested = v.mcp_servers.flatMap((s) => s.credential_names).filter((n) => v.credential_surface.includes(n));
      await credentialResolver(requested);

      const configs = await buildMcpConfigs(v, opts);
      // Render for its refusal side-effects too: a container realize refuses a smuggled venue for the
      // same reason the renderer does, before anything reaches PLAYING.
      renderComposeConfig(v, {
        gigId: opts.gigId,
        realizationDir: `/realizations/gig-${opts.gigId.slice(0, 8)}`,
        ...(host ? { host } : {}),
      });
      const artifacts: RealizedArtifact[] = [
        { kind: "compose-project", id: `compose-${opts.gigId}-${ARTIFACT_SEQ++}`, labels: { gig_id: opts.gigId, instance: INSTANCE } },
        { kind: "compose-network", id: `net-${opts.gigId}-${ARTIFACT_SEQ++}`, labels: { gig_id: opts.gigId, instance: INSTANCE } },
      ];
      return makeHandle("PLAYING", configs, `/realizations/gig-${opts.gigId.slice(0, 8)}/compose.json`, artifacts);
    },
    sweep,
  };
}
