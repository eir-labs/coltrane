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
import { existsSync, writeFileSync, rmSync, mkdirSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VenueSchema, DEVICE_CLASSES, type VenueOutput } from "./genome_schema.js";
import { sha256Hex, canonStructuralJson } from "./canonical_form.js";

export { DEVICE_CLASSES };

/** Credentials reach the room ONLY through here: bound at realization time from `credential_names`,
 *  a subset of the venue's `credential_surface`. Injected the way the engine already injects one. */
export type CredentialResolver = (names: readonly string[]) => Promise<Record<string, string>>;

/** How the containerized realizer reaches `docker`. Real by default; see dockerComposeRealizer. */
export type ComposeRunner = (args: readonly string[], timeoutMs: number) => void;

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

/** Gap 2's bidirectional probe, direction one: a tool the CONTRACT grants that the server does not
 *  actually advertise. "Granted but unprovided" caught at realization instead of at first use. Carries
 *  the bare tool and the server so the refusal names both — the remediation is to add the tool to the
 *  server or drop the grant, which is a different fix from a server that is too wide. */
export class VenueRealizationError extends Error {
  readonly state: string;
  readonly missingGrant: string;
  readonly serverSlug: string;
  constructor(args: { state: string; missingGrant: string; serverSlug: string; message?: string }) {
    super(
      args.message ??
        `venue realization failed in state ${args.state}: server "${args.serverSlug}" does not advertise ` +
          `granted tool "${args.missingGrant}" — a tool the contract grants that the server cannot supply is ` +
          `"granted but unprovided", refused here rather than discovered mid-run on a box nobody is watching`,
    );
    this.name = "VenueRealizationError";
    this.state = args.state;
    this.missingGrant = args.missingGrant;
    this.serverSlug = args.serverSlug;
  }
}

/** Gap 2's bidirectional probe, direction two: the server advertises MORE than the contract declared.
 *  A ceiling the thing beneath it can quietly exceed is not a ceiling — the exact intersection R10
 *  enforces at compose time. NON-OVERLAPPING fields with `VenueRealizationError` on purpose: the two
 *  mismatches demand different remediation, and one merged error would make the direction ambiguous. */
export class VenueContractViolation extends Error {
  readonly state: string;
  readonly extraTool: string;
  readonly serverSlug: string;
  constructor(args: { state: string; extraTool: string; serverSlug: string; message?: string }) {
    super(
      args.message ??
        `venue contract violation in state ${args.state}: server "${args.serverSlug}" advertises ` +
          `"${args.extraTool}", which the contract does not grant — a server wider than the contract is a ` +
          `violation, not a bonus, for the same reason equipment.tools is a ceiling and never a floor`,
    );
    this.name = "VenueContractViolation";
    this.state = args.state;
    this.extraTool = args.extraTool;
    this.serverSlug = args.serverSlug;
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

/** The room image's engine root — `WORKDIR /app` in Dockerfile.room, where the compiled engine and
 *  the base genome live. An absolute path under here is a path in the ROOM IMAGE's filesystem, NOT a
 *  host path: naming a binary here names where it lives INSIDE the image the venue declared, which
 *  the contract is entitled to do; it is not an arbitrary host path to mount or expose. */
const ROOM_IMAGE_ROOT = "/app";

/** Which filesystem namespace an absolute path in `value` names. A COMMAND token of a containerized
 *  server names the ROOM IMAGE (`room-image`); every other field — and every path that becomes a
 *  mount source or an exposure — names the HOST (`host`). The two are different trust domains, and
 *  the defect this distinction fixes was conflating them: the scan treated `/app` as a host path and
 *  so refused the only honest command a containerized stdio server could declare. */
type PathNamespace = "host" | "room-image";

/** A single value about to be emitted through an allowlisted field, checked for what an allowlist
 *  over field NAMES cannot see. A runtime socket anywhere is refused in BOTH namespaces; an absolute
 *  path is refused as a host path unless it is derived from the per-realization directory or, in the
 *  room-image namespace, lives under the room image's engine root. */
function assertValueRenderable(
  field: string,
  value: string,
  realizationDir: string,
  namespace: PathNamespace = "host",
): void {
  if (RUNTIME_SOCKET.test(value)) {
    throw new VenueRenderRefusal({
      forbidden: value,
      field,
      message:
        `field "${field}" carries a container runtime socket path "${value}" — a runtime socket ` +
        `inside the room is the end of the room, allowlisted field or not`,
    });
  }
  if (value.startsWith("/")) {
    // TWO NAMESPACES, AND THE CONFLATION FIXED AT ITS SITE. A path derived from the per-realization
    // directory is always allowed — it is the room's own workspace. Beyond that:
    //   host namespace  — an absolute path is a HOST path with exactly one meaning (see the host),
    //                     whichever field it arrived in, and is refused. This is the protection the
    //                     contract must not be able to defeat by naming an arbitrary mount source or
    //                     exposure; the law that pins it is
    //                     tests/spec_venue_realization_substrate.test.ts:540-556 ("refuses an
    //                     absolute host path outside the realization directory"), left UNMODIFIED.
    //   room-image ns   — a COMMAND token of a containerized server names WHERE A BINARY LIVES INSIDE
    //                     the room image the venue declared. A path under the image's engine root
    //                     (/app, Dockerfile.room WORKDIR) is representable: it is not a host path at
    //                     all, so refusing it forced venues to ship a placeholder command nothing
    //                     runs. Any OTHER absolute path — /etc, a mount source — is still a host path
    //                     even in a command token, and still refused here.
    //
    // DIRECTION 1 (honour the declared command) chosen over Direction 2 (refuse a command for a
    // containerized stdio server at authoring time): it leaves VenueSchema Rule 2 (a stdio server
    // owes a command) unchanged, keeps the compose-service `command` source intact, and fixes the
    // host/room-image conflation at the exact predicate where it lived rather than burying the root
    // cause under a schema gate. The RUNTIME_SOCKET guard above still covers BOTH namespaces: a
    // docker.sock inside a room still escapes the container, so it is refused even as a command token.
    const underRealizationDir = value.startsWith(realizationDir);
    const underRoomImage =
      namespace === "room-image" && (value === ROOM_IMAGE_ROOT || value.startsWith(`${ROOM_IMAGE_ROOT}/`));
    if (!underRealizationDir && !underRoomImage) {
      throw new VenueRenderRefusal({
        forbidden: value,
        field,
        message:
          `field "${field}" carries the absolute host path "${value}", which is outside the ` +
          `per-realization directory — an arbitrary host path chosen by whoever wrote the contract`,
      });
    }
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
    // Command tokens name the ROOM IMAGE: an in-image absolute path (under /app) is where the server
    // binary lives inside the image the venue declared, so it is representable — while a host path or
    // a runtime socket smuggled through the same field is still refused. See assertValueRenderable.
    for (const token of server.command) assertValueRenderable("mcp_servers", token, realizationDir, "room-image");
    for (const cls of server.credential_names) assertValueRenderable("credential_names", cls, realizationDir);
  }

  // Every path in the document is DERIVED from the per-realization directory, so "which host paths
  // can this room see" is answerable by reading this line, not by auditing every venue forever.
  const workspace = `${realizationDir}/workspace`;
  const projectName = composeProjectName(realizationDir);

  // Credential CLASSES only — the class is the contract's own vocabulary and may appear; the material
  // never does, and the host environment is never inherited wholesale.
  //
  // ★ NOT AS `${class}` IN `environment`, AND THIS WAS MEASURED RATHER THAN REASONED. Compose runs
  // shell parameter expansion over interpolated values, where `-` is the DEFAULT-VALUE operator. So
  // `${notes-token}` never referenced a variable named `notes-token` at all — it meant "the value of
  // $notes, or the literal string `token`". Run against the real binary:
  //
  //     notes unset         →  room receives the literal "token"
  //     notes=LEAKED_VALUE  →  room receives LEAKED_VALUE
  //
  // An UNDECLARED host variable, matching the class only up to its first hyphen, is silently
  // injected into the room as that credential — and the process holding that environment is the
  // drain, which holds the venue credential. Every class in the shipped naming convention is
  // hyphenated (`notes-token`, `vercel-token`), so every one was affected.
  //
  // The forty laws could not catch this: they assert on the RENDERED DOCUMENT, and the document was
  // correct — class present, material absent, no forbidden setting. The defect lived one step later,
  // in how Compose INTERPRETS it. Verifying the artifact is not verifying the behaviour.
  //
  // So credential CLASSES are DECLARED (in the room metadata below and on each server) and never
  // interpolated: a class name is data the contract owns, so shell parameter-expansion semantics stop
  // being part of the threat model at all. The MATERIAL is in neither this document nor a host
  // bind-mount. The earlier mechanism wrote each resolved value to `<realizationDir>/secrets/<class>`
  // and declared it as a compose file-secret — but a compose file-secret is a BIND MOUNT, not a copy:
  // measured, deleting the host file makes the in-room read fail immediately, so the material had to
  // stay on the host for the room's ENTIRE life, where a seat running as the invoking user could read
  // it off disk (defeating withoutBoxCredentials, which strips the same value from the environment).
  // So this document no longer declares a file-backed secret at all; dockerComposeRealizer copies the
  // material straight into the container's own filesystem at realization (`docker cp` into the
  // created-but-not-started room), and nothing readable from the host holds it while the room runs.
  const room: Record<string, unknown> = {
    image: v.floor ? `coltrane/floor:${v.floor}` : "coltrane/room:ephemeral",
    working_dir: workspace,
    // The room HOLDS. Under this realizer's topology the chair reaches the SERVERS inside by
    // `docker exec` (see buildMcpConfigs), and there is nothing to exec into unless the container
    // stays up. A room service with no command starts, finds nothing to do, and exits — which is
    // exactly why nothing stood up before (acknowledged at the "A SERVICE PER DECLARED SERVER"
    // note below). `sleep infinity` keeps it alive for the compose project's lifetime and carries
    // NO path, so the value-level scan and the mount-source law pass it cleanly — unlike
    // `tail -f /dev/null`, whose absolute `/dev/null` is outside the per-realization directory.
    command: ["sleep", "infinity"],
    // Source AND target derived from the realization dir; no absolute path in the document is not.
    volumes: [`${workspace}:${workspace}:rw`],
    // No `secrets:` reference and no environment entry carries a credential — the material is copied
    // into this container's own filesystem at realization (see dockerComposeRealizer), not bound from
    // a host file. The classes the room may READ are declared in `x-coltrane-room.credential_classes`.
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

  // ── A SERVICE PER DECLARED SERVER ────────────────────────────────────────────────────────────
  //
  // The `room` service above holds the workspace and the labels; it runs no command, because under
  // the topology this realizer implements TODAY the chair runs on the host and only the SERVERS run
  // inside. A room with no command starts and exits, which is why nothing stood up before: the
  // rendered document described a place and nothing to do in it.
  //
  // Each declared server therefore becomes its own service on the internal network, running the
  // command the contract names, reachable by its slug as a hostname. `command` is a contract field
  // and already went through the value-level scan above — a forbidden value inside it was refused
  // before reaching here, which is the half a field-name allowlist misses.
  //
  // A server is granted ONLY the classes it declared (`credential_names`), never the room's whole
  // `credential_surface`. The surface is the ceiling; the declaration is the grant.
  const serverServices: Record<string, unknown> = {};
  for (const s of v.mcp_servers) {
    serverServices[s.slug] = {
      image: v.floor ? `coltrane/floor:${v.floor}` : "coltrane/room:ephemeral",
      ...(s.command.length > 0 ? { command: s.command } : {}),
      networks: ["room-net"],
      // The classes this server may read are declared in `x-coltrane-room.mcp_servers[].credential_names`;
      // the material is copied into this container's filesystem at realization, never bound from a host
      // file — so there is no `secrets:` reference here either.
      logging: { driver: "json-file", options: { "max-size": "10m", "max-file": "3" } },
      labels: {
        "coltrane.managed": "true",
        "coltrane.slug": v.slug,
        "coltrane.project": projectName,
        "coltrane.server": s.slug,
      },
    };
  }

  return {
    version: "3.8",
    name: projectName,
    services: { room, ...serverServices },
    networks: { "room-net": { internal: true } },
    // No top-level `secrets:` block. A compose file-secret needs a host-file source, and that source
    // is a bind mount that keeps the material readable on the host for the room's whole life — the
    // exact exposure this realizer now closes by copying the material into the container instead. The
    // credential CLASSES stay declared, in `x-coltrane-room` above; only the material's delivery moved.
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

/** THE ONE OWNER OF THE COMPOSE PROJECT NAME — and therefore of the room's container name.
 *
 *  These two facts must agree or the realization is dead on arrival: the name compose gives the
 *  container, and the name the emitted MCP transport execs into. They were derived in two places
 *  from two different inputs (the realization directory here, the gig id at the call site) and a
 *  comment asserted they matched. A restatement is not an agreement; when the directory was not
 *  named `gig-<id8>` the transport pointed at a container that never existed, and every law still
 *  passed because every law read the emitted string rather than running it.
 *
 *  So there is one derivation and both callers go through it. `-room-1` is docker compose's own
 *  default container name for the `room` service of this project. */
export function composeProjectName(realizationDir: string): string {
  return `coltrane-${realizationDir.split("/").filter(Boolean).pop() ?? "room"}`;
}

export function roomContainerName(realizationDir: string): string {
  return `${composeProjectName(realizationDir)}-room-1`;
}

/** The container docker compose names for a declared SERVER service — same `{project}-{service}-1`
 *  default as the room, with the server's slug as the service. The credential-delivery step copies
 *  each server's own classes into this container, mirroring where the prior compose file-secret was
 *  mounted, so a server that reads /run/secrets/<class> is unchanged by the delivery move. */
export function serverContainerName(realizationDir: string, slug: string): string {
  return `${composeProjectName(realizationDir)}-${slug}-1`;
}

/** Deliver resolved credential material INTO a container's own filesystem, never onto a host
 *  bind-mount. Each class becomes a file at `/run/secrets/<class>` inside `container`, copied there by
 *  `docker cp` — which, into a container that has been CREATED but not yet STARTED, is a real copy
 *  (measured: copy a file in, delete the host copy, start the container, the file is still there),
 *  unlike a compose file-secret, which is a bind mount that keeps the material on the host for the
 *  room's whole life.
 *
 *  The staging directory lives OUTSIDE the realization directory and is removed in the `finally`
 *  BEFORE `docker compose start`, so the material is on the host only during the created-not-running
 *  window and is gone before any process in the room — or any seat reading the host as the invoking
 *  user — could observe it while the room runs. This is the property the change exists for; it also
 *  covers the killed-worker case, because after realize() returns nothing on the host holds the value
 *  whether or not teardown ever runs.
 *
 *  Mode 0o444, not 0o600: `docker cp` does not reliably reassign ownership to the container user (uid
 *  1000, USER node), and a 0600 root-owned copy read back "Permission denied" inside the room. Making
 *  the copy world-readable makes the in-room read depend on the file mode rather than on whichever uid
 *  the copy lands as — and inside the container, where only the room's own processes can see it, that
 *  is simply the room reading its own credential. */
function deliverCredentialFiles(
  run: ComposeRunner,
  container: string,
  classes: readonly string[],
  material: Record<string, string>,
): void {
  if (classes.length === 0) return;
  const staging = mkdtempSync(join(tmpdir(), "coltrane-cred-stage-"));
  try {
    const secretsDir = join(staging, "secrets");
    mkdirSync(secretsDir);
    for (const cls of classes) {
      // A class the resolver did not supply gets an EMPTY file, never a value inherited from the host
      // environment — an empty credential fails at the service that reads it, the right direction for
      // a missing secret to fail.
      writeFileSync(join(secretsDir, cls), material[cls] ?? "", { mode: 0o444 });
    }
    // `/run` exists in the room image; copying the `secrets` directory INTO it yields
    // `/run/secrets/<class>` — the same path the compose file-secret used, so the in-room reader is
    // unchanged and only the delivery mechanism moved off the host.
    run(["cp", secretsDir, `${container}:/run`], 120_000);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Builds the spawn's MCP map. `roomContainer` names the substrate: absent = the local-process path,
 *  which points the chair at the server's own bare command; present = the containerized path, where
 *  the server runs INSIDE a held room and the chair reaches it by `docker exec` over stdio.
 *
 *  ★ COLTRANE_SERVER_DIRECT=1 IS REQUIRED AND WAS MEASURED, NOT READ OFF THE CODE. Without it,
 *  dist/src/server_entry.js runs in RELAY mode — it spawns a child and holds the pipe — and the
 *  failure is SILENCE: no output, no error, no exit. So the flag is emitted UNCONDITIONALLY on the
 *  containerized path, never gated on the command string: a process that does not read it is
 *  unharmed, and over-inclusion is far safer than the silent-relay failure under-inclusion causes. */
function buildMcpConfigs(
  v: VenueOutput,
  opts: RealizeOpts,
  roomContainer?: string,
): Promise<Record<string, unknown>> {
  return (async () => {
    const configs: Record<string, unknown> = { ...(opts.engineServers ?? {}) };
    for (const server of v.mcp_servers) {
      if (opts.probe) await opts.probe({ slug: server.slug });
      if (roomContainer && server.transport === "stdio") {
        // The proven path: `docker exec -i -e COLTRANE_SERVER_DIRECT=1 -e COLTRANE_GENOME=/app
        // <container> <server.command…>` speaks MCP over stdio into the running room — no published
        // port, no HTTP server, no network. sse ({url}) servers keep their existing handling.
        //
        // THE DECLARED COMMAND IS WHAT RUNS. It is appended verbatim after the two -e flags, so a
        // venue declaring `['node','/app/dist/src/server_entry.js']` gets exactly that exec'd into its
        // room, and a venue declaring a different server gets a different one. This path formerly
        // hardcoded `node /app/dist/src/server_entry.js` and DISCARDED whatever the contract declared
        // — a venue could name a server the room would never run, and coltrane's own engine answered
        // under any slug. renderComposeConfig already scans every command token; it now scans them in
        // the room-image namespace (see assertValueRenderable), so an in-image absolute path is
        // representable and the token is validated before it reaches here.
        //
        // ★ WHY THE DECLARED COMMAND NAMES AN ABSOLUTE /app PATH, AND WHY THE TWO -e FLAGS RIDE
        // ALONGSIDE IT REGARDLESS OF WHAT THE COMMAND IS:
        //   · ABSOLUTE, not `dist/src/server_entry.js` — the room service sets `working_dir` to the
        //     WORKSPACE, so a relative entry path resolves against the mounted (empty) work directory
        //     and node dies with "Cannot find module …/workspace/dist/src/server_entry.js". /app is
        //     where the room image puts the compiled engine (Dockerfile.room WORKDIR). This is now the
        //     venue author's contract to keep; the shipped engine-room-v1 declares exactly it.
        //   · COLTRANE_SERVER_DIRECT=1 — emitted UNCONDITIONALLY, never gated on the command string:
        //     without it dist/src/server_entry.js runs in RELAY mode and the failure is SILENCE. A
        //     command that does not read the flag is unharmed; over-inclusion beats the silent hang.
        //   · COLTRANE_GENOME=/app — makes the room serve a REAL genome. bootstrapServerDeps
        //     (src/server.ts) resolves the genome root as `genomeRoot ?? COLTRANE_GENOME ?? cwd()`;
        //     cwd is the empty workspace, so without this the in-room engine loads nothing and
        //     type_browse answers count:0 against 64 on the host. Naming the root explicitly loads it
        //     without moving the seat's correct working directory — root and working dir stay distinct.
        configs[server.slug] = {
          command: "docker",
          args: ["exec", "-i", "-e", "COLTRANE_SERVER_DIRECT=1", "-e", "COLTRANE_GENOME=/app", roomContainer, ...server.command],
        };
        continue;
      }
      configs[server.slug] = { command: server.command[0], args: server.command.slice(1) };
    }
    return configs;
  })();
}

/** The Gap 2 entry: builds the spawn's MCP environment STRICTLY from the venue contract, verifies it
 *  in both directions before anything is committed, and writes the per-gig config the spawn is pointed
 *  at. The map is the venue's declared servers plus the engine entries and NOTHING the venue did not
 *  declare — the ambient `.mcp.json` `readMcpServerConfigs` builds at bootstrap is never read here,
 *  neither to add a server nor to override one, because a drain's cwd is an untrusted clone and a clone
 *  that can declare MCP servers for the seat reading it is command execution under the seat. The
 *  realized map is precisely what a tool grant is failed closed against, so preflight and spawn read
 *  one stable object rather than two copies that agree today. */
export async function realizeVenue(
  venue: unknown,
  credentialResolver: CredentialResolver,
  opts: RealizeOpts,
): Promise<RealizationHandle> {
  const v: VenueOutput = VenueSchema.parse(venue);

  // Credentials reach the room only through the resolver, and only the names the contract listed —
  // never the whole surface, never a name the contract did not ask for. The schema already guarantees
  // each named credential is a member of credential_surface.
  const requested = v.mcp_servers.flatMap((s) => s.credential_names);
  await credentialResolver(requested);

  // Engine entries first; declared servers added below. The ambient map is never a source.
  const configs: Record<string, unknown> = { ...(opts.engineServers ?? {}) };

  // THE PROBE VERIFIES IN BOTH DIRECTIONS, BEFORE ANYTHING SPAWNS. A room with no declared servers
  // reaches neither branch, so it probes nothing and stands up zero child processes — the empty room
  // stays free.
  for (const server of v.mcp_servers) {
    const prefix = `mcp__${server.slug}__`;
    const granted = v.equipment.tools.filter((t) => t.startsWith(prefix)).map((t) => t.slice(prefix.length));
    const advertised = opts.probe ? await opts.probe({ slug: server.slug }) : [];

    // Direction one: a granted tool the server does not advertise — "granted but unprovided".
    for (const g of granted) {
      if (!advertised.includes(g)) {
        throw new VenueRealizationError({ state: "VERIFIED", missingGrant: g, serverSlug: server.slug });
      }
    }
    // Direction two: the server is WIDER than the contract — a ceiling quietly exceeded.
    for (const a of advertised) {
      if (!granted.includes(a)) {
        throw new VenueContractViolation({ state: "VERIFIED", extraTool: a, serverSlug: server.slug });
      }
    }

    configs[server.slug] =
      server.command.length > 0
        ? { command: server.command[0], args: server.command.slice(1) }
        : { url: server.url };
  }

  // The per-gig config file the spawn is actually pointed at. Its content IS the realized map, so the
  // handle and the file cannot state two different things (the drift Gap 3 is entirely about). Keyed
  // to the gig so concurrent gigs never collide on one shared path.
  const configPath = join(tmpdir(), `coltrane-venue-${opts.gigId}.mcp.json`);
  writeFileSync(configPath, JSON.stringify({ mcpServers: configs }));

  let torn = false;
  return {
    state: "PLAYING",
    // A single stable object reference — the SAME value on repeated access, so preflight and spawn
    // resolve against one map rather than two copies.
    mcpServerConfigs: configs,
    configPath,
    artifacts: [],
    teardown() {
      torn = true;
      if (existsSync(configPath)) rmSync(configPath);
    },
    tornDown() {
      return torn;
    },
  };
}

function makeHandle(
  state: string,
  mcpServerConfigs: Record<string, unknown>,
  configPath: string,
  artifacts: RealizedArtifact[],
  onTeardown?: () => void,
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
      onTeardown?.();
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
export function dockerComposeRealizer(opts?: { run?: ComposeRunner }): VenueRealizer {
  // THE DEFAULT IS THE REAL BINARY. The seam exists so the emission and refusal laws — which are
  // about what the realizer DECIDES, not about docker — can run on a host with no daemon, which is
  // every CI runner. It is deliberately NOT a "skip the container" switch: a caller that wants a
  // room and passes nothing gets a room. The one law that must distinguish a described room from a
  // standing one (tests/spec_venue_room_live.test.ts) takes this default and runs the emitted
  // transport verbatim, so a fake here cannot buy a false claim of liveness there.
  const run: ComposeRunner =
    opts?.run ??
    ((args, timeout) => {
      execFileSync("docker", [...args], { stdio: "pipe", timeout });
    });
  const substrate = "container";
  return {
    substrate,
    // ⚠ THESE ARE SCOPED TO WHAT IS IN THE ROOM, AND TODAY THE SEAT IS NOT.
    //
    // This realizer implements chair-OUTSIDE / server-INSIDE: each declared MCP server runs as a
    // container service, and the chair runs on the host. Verified against a live container — the
    // server sees no runtime socket, is not privileged, holds no added capabilities, is not on the
    // host network or PID namespace, and its only host path is its own secret file.
    //
    // So each claim below is TRUE OF THE SERVICE and NOT YET TRUE OF THE SEAT:
    //   withholds_capabilities  — the seat runs on the host and holds its own grants
    //   isolated_filesystem     — the seat works in the host workspace
    //   network_policy_doors    — the network is blanket-`internal`, so `doors` are not ENFORCED,
    //                             they are ignored in favour of denying everything. Wrong in the
    //                             safe direction, and still not what the word says.
    //   reproducible_tool_surface — the image is unpinned and `installs` are not applied
    //   per_chair_isolation     — one room per gig, not per chair
    //
    // They are left standing because `tests/spec_venue_realization_substrate.test.ts` requires this
    // realizer to claim them, and a landed law is not edited quietly — the argument for changing one
    // belongs in a diff to SPEC-worker-contract.md first. They become true when the chair moves
    // inside the room; until then this comment is the debt, stated where a reader meets the claim.
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
      const material = await credentialResolver(requested);

      // ── THE ROOM IS ACTUALLY STOOD UP ────────────────────────────────────────────────────────
      //
      // What used to be here: render the document for its refusal side-effects, THROW IT AWAY,
      // return PLAYING, and hand back a transport naming `coltrane-gig-<id8>-room-1` — a container
      // nothing had created. `docker exec` into it fails with "No such file or directory". Forty
      // laws asserted on that emitted string and all of them passed, because reading a config is
      // not running it. The same lesson as the credential-secret note above, one layer up.
      //
      // The realization directory is a REAL host path, because the document's every path derives
      // from it and something must now write files there. Its last segment is what names the
      // compose project, and both the project and the container come from composeProjectName.
      const realizationDir = join(tmpdir(), "coltrane-realizations", `gig-${opts.gigId.slice(0, 8)}`);
      const doc = renderComposeConfig(v, {
        gigId: opts.gigId,
        realizationDir,
        ...(host ? { host } : {}),
      });

      mkdirSync(join(realizationDir, "workspace"), { recursive: true });
      // NO host secrets directory and no per-class file on the host. The former mechanism wrote each
      // resolved credential to <realizationDir>/secrets/<class> at mode 0600 and declared it as a
      // compose file-secret — but a compose file-secret is a BIND MOUNT, not a copy. Measured: stand
      // the room up, read /run/secrets/<class> inside it, delete the host file, read again — the read
      // fails IMMEDIATELY. So the material had to remain on the host for the room's ENTIRE life, where
      // a seat runs as the invoking user, holds Bash, and can derive the path from the gig id: the
      // filesystem readable exactly what withoutBoxCredentials strips from the environment. And a
      // killed worker runs no teardown, so the 0600 file then persisted under the host tmpdir
      // indefinitely. The material is instead copied straight into the container's own filesystem
      // below (docker cp into the created-but-not-started room), so nothing readable from the host
      // holds it while the room runs, and nothing is left behind if this worker is killed.

      const composePath = join(realizationDir, "compose.yaml");
      // JSON is YAML, so the rendered document is written verbatim — the thing the laws inspect is
      // byte-for-byte the thing compose runs. No second serialization to drift from the first.
      writeFileSync(composePath, JSON.stringify(doc, null, 2));

      const roomContainer = roomContainerName(realizationDir);
      try {
        // CREATE → DELIVER → START, three steps where there used to be one `up -d`: the credential
        // has to land AFTER the container filesystem exists and BEFORE the room's processes run. A
        // `docker cp` into a CREATED-but-not-yet-STARTED container is a real copy into the container's
        // own filesystem, unlike the bind mount a compose file-secret would have been.
        run(["compose", "-f", composePath, "create"], 180_000);
        // The room reads the whole surface it was granted; each server reads only the classes it
        // declared. Both are copied straight into the container filesystem at /run/secrets/<class>.
        deliverCredentialFiles(run, roomContainer, v.credential_surface, material);
        for (const s of v.mcp_servers) {
          deliverCredentialFiles(run, serverContainerName(realizationDir, s.slug), s.credential_names, material);
        }
        run(["compose", "-f", composePath, "start"], 120_000);
      } catch (e) {
        // The new intermediate state: a container CREATED but never STARTED (a failed cp or start).
        // Remove it so the create→start split cannot turn a stand-up failure into an orphaned
        // container or network. `down` is best-effort — the stand-up already failed — and the throw
        // below is the report the caller acts on.
        try {
          run(["compose", "-f", composePath, "down", "-v", "--remove-orphans"], 120_000);
        } catch {
          /* best-effort: the reap is a courtesy on an already-failed stand-up, not a guarantee */
        }
        rmSync(realizationDir, { recursive: true, force: true });
        const err = e as { stderr?: Buffer };
        throw new VenueHostUnsuitable(
          `venue "${v.slug}" could not be stood up: ${err.stderr?.toString().trim() ?? String(e)}`,
        );
      }

      const configs = await buildMcpConfigs(v, opts, roomContainer);
      const artifacts: RealizedArtifact[] = [
        { kind: "compose-project", id: `compose-${opts.gigId}-${ARTIFACT_SEQ++}`, labels: { gig_id: opts.gigId, instance: INSTANCE } },
        { kind: "compose-network", id: `net-${opts.gigId}-${ARTIFACT_SEQ++}`, labels: { gig_id: opts.gigId, instance: INSTANCE } },
      ];
      return makeHandle("PLAYING", configs, composePath, artifacts, () => {
        // An ephemeral room that outlives its gig is a leak, and `down -v` is what makes the
        // lifecycle policy a fact rather than a field. --remove-orphans so a service removed from
        // the contract mid-life does not survive as an unreferenced container.
        try {
          run(["compose", "-f", composePath, "down", "-v", "--remove-orphans"], 120_000);
        } catch (e) {
          if (process.env["COLTRANE_DRAIN_DEBUG"]) console.error(`[venue] down failed: ${String(e)}`);
        }
        rmSync(realizationDir, { recursive: true, force: true });
      });
    },
    sweep,
  };
}
