// ════════════════════════════════════════════════════════════════════════════════════════════
// PENDING IMPLEMENTATION — this file is committed RED on purpose. See SPEC-worker-contract.md.
// A failure here is a feature not yet built. A failure in any file NOT named spec_* is a
// regression. Do not weaken these laws to make CI green; implement them.
// ════════════════════════════════════════════════════════════════════════════════════════════
//
// GAP 6 — WHAT A VENUE IS REALIZED ON IS UNSPECIFIED, and that is the other half of Gap 2.
//
// Gap 2 says a venue cannot declare what provides its tools and that nothing builds the room from
// the contract. This is the rest of it: realization targets a node subprocess, the containerization
// question is explicitly deferred with "room left for a future field", and that room is not a NAMED
// INTERFACE. Nothing declares which substrate a venue needs, nothing declares which substrates a
// host provides, and so nothing can refuse the mismatch.
//
// THE FAILURE MODE IS SILENT DEGRADATION, and it is why this is spec'd now rather than later. A
// venue that requires isolation, realized on a substrate that cannot provide it, RUNS — and
// believes it is isolated. A false guarantee is strictly worse than a refusal: a refusal is visible,
// and a guarantee is the thing a venue's author reasons against.
//
// ── WHY THE RENDERER LAWS BELOW ARE THE MOST IMPORTANT IN THE SUITE ───────────────────────────
// Every other gap in this spec fails VISIBLY: a capability is missing, something refuses, someone
// notices. This one fails invisibly. A containerized realizer RENDERS A RUNTIME CONFIGURATION FROM
// CONTRACT DATA — code generation from data — and if any part of the input is reachable by a gig it
// is remote code execution with extra steps. A permissive realizer is worse than no realizer,
// because the venue still claims the guarantee.
//
// So the renderer is pinned from both directions:
//   * it EMITS only from a closed allowlist, so a forbidden setting cannot appear from contract
//     data (one law per forbidden setting, individually, so a partial implementation cannot pass);
//   * it REFUSES input that smuggles a forbidden value through an allowlisted FIELD, because an
//     allowlist over field names says nothing about what those fields contain.
//
// THE IMPORT OF `src/venue_realizer.ts` IS THE SPECIFICATION (the same module Gap 2 names). It does
// not exist; each law loads it through a specifier held in a const so tsc stays clean — this repo's
// vitest globalSetup builds first, and one compile error would stop every band from running, at
// which point nobody could tell a pending spec from a regression.
import { describe, it, expect, vi } from "vitest";
import { VenueSchema } from "../src/genome_schema.js";
import { ENGINE_MCP_SERVER } from "../src/tool_providers.js";

const VENUE_REALIZER = "../src/venue_realizer.js";

type CredentialResolver = (names: readonly string[]) => Promise<Record<string, string>>;

/** One thing a realizer created. LABELLED, because an unlabelled artifact is indistinguishable
 *  from something a human made on purpose and nothing may safely collect it. */
interface RealizedArtifact {
  kind: string;
  id: string;
  labels: { gig_id: string; instance: string };
}

interface RealizationHandle {
  state: string;
  mcpServerConfigs: Readonly<Record<string, unknown>>;
  configPath: string;
  /** Everything this realization created, so a sweep has something to reconcile against. */
  artifacts: readonly RealizedArtifact[];
  teardown(): Promise<void> | void;
  tornDown(): boolean;
}

/** A ceiling on what survives outside the per-gig lifecycle. A policy whose ceiling is unlimited is
 *  not a policy — the point is that a bound EXISTS, not that any number is right. */
interface RetentionPolicy {
  max_cached_build_artifacts: number;
  max_unreferenced_environments: number;
  /** How often the worker applies it. Never "never". */
  cadence: string;
}

/** The properties a realizer may CLAIM — and may only claim if it can keep them. */
type VenueGuarantee =
  | "withholds_capabilities"
  | "isolated_filesystem"
  | "network_policy_doors"
  | "reproducible_tool_surface"
  | "per_chair_isolation";

/**
 * WHERE a room is stood up. A venue is a PLACE, and the place need not be the worker's own machine
 * — a room may be realized on a host that has something this box does not: attached hardware, a
 * network position, a different architecture. The venue contract is byte-identical either way,
 * which is the strongest argument the venue abstraction has.
 *
 * The device map lives HERE and not in the contract: which nodes `serial` means, and which group
 * owns them, are properties of the machine rather than of the room.
 */
interface RealizationHost {
  /** absent = the worker's own machine. */
  endpoint?: string;
  architecture: string;
  /** device CLASS → the concrete nodes this host maps it to, and the group that owns them. */
  devices: Readonly<Record<string, { nodes: readonly string[]; group: string }>>;
  /** Per gig, against a live lease — never held at boot. See src/workspace.ts:60-89. */
  credential?: (args: { gigId: string }) => Promise<string>;
}

/** The seam. Injected exactly the way `CredentialResolver` already is: the engine ships the
 *  interface, the state machine, the probe and the drift guard; a deployment supplies the
 *  implementations it has. */
interface VenueRealizer {
  readonly substrate: string;
  readonly guarantees: readonly VenueGuarantee[];
  available(): boolean;
  readonly retention: RetentionPolicy;
  realize(
    venue: unknown,
    credentialResolver: CredentialResolver,
    opts: {
      gigId: string;
      engineServers?: Readonly<Record<string, unknown>>;
      probe?: (s: { slug: string }) => Promise<string[]>;
      host?: RealizationHost;
      /** How many chairs this realization is for — checked against the venue's ceiling. */
      chairs?: number;
    },
  ): Promise<RealizationHandle>;
  /** RECONCILIATION, not cleanup: collect every labelled artifact belonging to no live gig.
   *  `liveGigs` is HOST-WIDE, which is what makes an unconditional startup sweep safe. */
  sweep(opts: { liveGigs: readonly string[] }): Promise<readonly RealizedArtifact[]>;
}

interface SubstrateModule {
  localProcessRealizer(): VenueRealizer;
  dockerComposeRealizer(opts?: { run?: () => void }): VenueRealizer;
  /** Picks the realizer a venue requires from those a deployment supplies. Throws rather than
   *  returning a weaker one — the whole reason this gap is written down. */
  selectRealizer(venue: unknown, realizers: readonly VenueRealizer[]): VenueRealizer;
  VenueSubstrateUnavailable: new (...args: never[]) => Error;
  /** Thrown when a HOST cannot host this venue: a device class it does not provide, an architecture
   *  it is not. Distinct from a substrate refusal, because the fix is a different machine rather
   *  than a different runtime. */
  VenueHostUnsuitable: new (...args: never[]) => Error;
  /** Thrown when input would render a setting the contract may not ask for. Carries `forbidden`
   *  so the refusal names the thing, rather than being a bare throw a caller must guess at. */
  VenueRenderRefusal: new (...args: never[]) => Error;
  /** The CLOSED allowlist of contract fields the renderer may substitute. */
  COMPOSE_SUBSTITUTABLE_FIELDS: readonly string[];
  /** The CLOSED enumeration of device KINDS a venue may ask for. Never a path. */
  DEVICE_CLASSES: readonly string[];
  /** Thrown when a realization would exceed the venue's declared concurrency ceiling. */
  VenueConcurrencyRefused: new (...args: never[]) => Error;
  /** The identity of the environment built from a venue — a function of the CONTRACT'S hash, so an
   *  unchanged contract rebuilds nothing. The payoff of digest-pinned installs. */
  environmentIdentity(venue: unknown): string;
  /** The identity of the shared floor a venue composes over, so N venues cost floor + Σ(deltas). */
  floorIdentity(venue: unknown): string;
  /** Renders the runtime configuration from a PARSED venue. Never from raw input. */
  renderComposeConfig(
    venue: unknown,
    opts: { gigId: string; realizationDir: string; host?: RealizationHost },
  ): Record<string, unknown>;
}
const substrate = async (): Promise<SubstrateModule> =>
  (await import(VENUE_REALIZER)) as unknown as SubstrateModule;

const engineServers = { [ENGINE_MCP_SERVER]: { command: "node", args: ["dist/src/server_entry.js"] } };
/** These laws are about what the realizer DECIDES — the shape it emits, the venue it refuses, the
 *  artifacts it records. None of that is a claim about docker, and CI has no daemon, so they run
 *  against a runner that records instead of executing. The liveness claim is not made here and
 *  cannot be: tests/spec_venue_room_live.test.ts takes the REAL default and runs the emitted
 *  transport verbatim against a standing room. */
const NO_DAEMON = { run: () => {} };

const noCredentials: CredentialResolver = async () => ({});

/** The empty room, in the shape venues/empty-room-v1.json already ships. */
const EMPTY_ROOM = {
  slug: "empty-room-v1",
  institution_slug: "quartet",
  equipment: { tools: [] },
  credential_surface: [],
  lifecycle: { policy: "ephemeral" as const },
};

/** A room that REQUIRES a container substrate, and declares one server plus one credential class. */
const CONTAINED_ROOM = {
  slug: "contained-room-v1",
  institution_slug: "quartet",
  substrate: "container",
  equipment: { tools: ["mcp__notes__search"] },
  credential_surface: ["notes-token"],
  mcp_servers: [
    { slug: "notes", transport: "stdio" as const, command: ["notes-mcp", "--stdio"], credential_names: ["notes-token"] },
  ],
  doors: { ingress: [], egress: ["notes.example"] },
  lifecycle: { policy: "ephemeral" as const },
};

/** A room that needs one CLASS of hardware. It names a kind, never a path — the path is the
 *  machine's business, and a contract that could name one could name the raw memory device. */
const SERIAL_ROOM = {
  ...CONTAINED_ROOM,
  slug: "serial-room-v1",
  devices: ["serial"],
  architectures: ["arm64"],
};

const REALIZATION_DIR = "/realizations/gig-77777777";
const GIG = "77777777-7777-7777-7777-777777777777";

/** A host that provides one device class, on one architecture. The nodes and the owning group are
 *  the machine's facts, supplied here the way a deployment would supply them. */
const HOST: RealizationHost = {
  architecture: "arm64",
  devices: { serial: { nodes: ["/dev/ttyPLACEHOLDER0"], group: "dialout" } },
};

/** Render a parsed room, for the laws that assert on OUTPUT. */
const renderParsed = async (
  room: unknown = CONTAINED_ROOM,
  host?: RealizationHost,
): Promise<Record<string, unknown>> => {
  const { renderComposeConfig } = await substrate();
  expect(renderComposeConfig, "the import is the specification").toBeTypeOf("function");
  return renderComposeConfig(VenueSchema.parse(room), {
    gigId: GIG,
    realizationDir: REALIZATION_DIR,
    ...(host ? { host } : {}),
  });
};

/** Every string anywhere in the rendered document — the only honest way to ask "did this leak". A
 *  forbidden setting only has to appear once, anywhere, to be the whole boundary. */
const flat = (doc: unknown): string => JSON.stringify(doc);

/**
 * ★ THE NON-VACUITY ANCHOR, and it is not decoration.
 *
 * Every escape law below asserts an ABSENCE, and an absence is satisfied by a document containing
 * nothing at all. MEASURED, not theorised: with `renderComposeConfig` stubbed to `return {}`, this
 * file reported 32 passed / 8 failed — a renderer that emits nothing satisfied EIGHTY PERCENT of
 * its own laws, including every single one of the six escape laws this section calls the sharpest
 * in the suite. The absence checks were real and the thing they checked was not.
 *
 * So each such law now pins that a REAL document was rendered before asking what is missing from
 * it. The anchor is structural rather than a string match: a compose document has services, and a
 * room is one of them. `slug` is on `COMPOSE_SUBSTITUTABLE_FIELDS`, so a renderer that emits
 * nothing cannot produce it, and a renderer that emits the wrong thing does not name this room.
 *
 * This is the same argument the section already makes about field-name allowlists — an allowlist
 * over names says nothing about values — turned one level outward: an assertion over a document
 * says nothing until something asserts the document exists.
 */
const renderedDoc = async (
  room: unknown = CONTAINED_ROOM,
  host?: RealizationHost,
): Promise<string> => {
  const doc = await renderParsed(room, host);
  const services = (doc as { services?: Record<string, unknown> }).services;
  expect(services, "non-vacuity: a rendered configuration has services, or nothing below is a test").toBeDefined();
  expect(Object.keys(services ?? {}).length, "…and at least one of them is the room").toBeGreaterThan(0);
  const s = flat(doc);
  expect(s, "non-vacuity: the rendered document must name THIS room").toContain(
    (room as { slug: string }).slug,
  );
  return s;
};

describe("GAP 6 — the substrate is a named, injectable seam with two implementations", () => {
  // TWO IMPLEMENTATIONS OR IT IS NOT A SEAM. A one-implementation interface is a hardcoded strategy
  // with extra indirection; the second implementation is what demonstrates nothing leaked into the
  // contract. Both are asserted against the SAME shape here, which is the whole test.
  it("both realizers satisfy one interface, and each names its own substrate", async () => {
    const { localProcessRealizer, dockerComposeRealizer } = await substrate();
    expect(localProcessRealizer, "the import is the specification").toBeTypeOf("function");
    expect(dockerComposeRealizer, "the import is the specification").toBeTypeOf("function");
    const local = localProcessRealizer();
    const contained = dockerComposeRealizer(NO_DAEMON);
    for (const r of [local, contained]) {
      expect(typeof r.substrate, "a realizer names what it builds on").toBe("string");
      expect(r.substrate.length).toBeGreaterThan(0);
      expect(Array.isArray(r.guarantees), "and what it promises").toBe(true);
      expect(r.available, "and whether this host can run it").toBeTypeOf("function");
      expect(r.realize).toBeTypeOf("function");
    }
    expect(local.substrate, "two realizers, two substrate names").not.toBe(contained.substrate);
  });

  // A REALIZER MAY ONLY CLAIM WHAT IT CAN KEEP. The local realizer runs seats as subprocesses of a
  // host that holds the git binary, the remote and the network — so it cannot withhold capabilities
  // and cannot enforce `doors` at a network boundary. src/workspace.ts:44-56 is already candid about
  // exactly this: the revoke step "is not a security control and must not be described as one: a
  // compromised drain simply declines to call this." A claimed guarantee is what a venue author
  // reasons against, so an unkeepable claim is worse than no claim at all.
  it("the local realizer claims no guarantee it cannot keep", async () => {
    const { localProcessRealizer } = await substrate();
    expect(localProcessRealizer, "the import is the specification").toBeTypeOf("function");
    const g = localProcessRealizer().guarantees;
    expect(g, "a subprocess of the host cannot withhold what the host holds").not.toContain(
      "withholds_capabilities",
    );
    expect(g, "doors at the MCP layer are cooperation, not a network boundary").not.toContain(
      "network_policy_doors",
    );
  });

  // …and the containerized one may claim them, or the seam buys nothing. Stated as a law so the two
  // realizers are distinguishable by what they PROMISE, not merely by their names.
  it("the containerized realizer claims the guarantees a real boundary provides", async () => {
    const { dockerComposeRealizer } = await substrate();
    expect(dockerComposeRealizer, "the import is the specification").toBeTypeOf("function");
    const g = dockerComposeRealizer(NO_DAEMON).guarantees;
    expect(g).toContain("withholds_capabilities");
    expect(g).toContain("network_policy_doors");
    expect(g).toContain("isolated_filesystem");
  });

  // THE BASELINE MUST STAY FREE. The local realizer is what runs on a laptop, in CI, and on any box
  // with no container runtime and no daemon installed. Its availability cannot depend on either, and
  // the empty room must still traverse the machine with ZERO child processes — Gap 2's guarantee,
  // restated here because introducing a substrate seam is exactly where it would quietly stop being
  // true. ("No probe call" is "no spawn", expressed as a property a test can hold.)
  it("the local realizer needs no runtime installed, and the empty room still spawns nothing", async () => {
    const { localProcessRealizer } = await substrate();
    expect(localProcessRealizer, "the import is the specification").toBeTypeOf("function");
    const local = localProcessRealizer();
    expect(local.available(), "the baseline may not require a daemon").toBe(true);
    const probe = vi.fn(async () => []);
    const handle = await local.realize(EMPTY_ROOM, noCredentials, { gigId: GIG, engineServers, probe });
    expect(probe, "an empty room probes nothing, so it spawns nothing").not.toHaveBeenCalled();
    expect(Object.keys(handle.mcpServerConfigs), "engine entries only").toEqual([ENGINE_MCP_SERVER]);
    expect(handle.state).toBe("PLAYING");
    await handle.teardown();
    expect(handle.tornDown()).toBe(true);
  });

  // The venue says which substrate it needs. Absent means the deployment's default; present means
  // this room is not the same room somewhere else, and the contract should be able to say so.
  it("VenueSchema accepts the substrate a room requires", () => {
    const parsed = VenueSchema.safeParse(CONTAINED_ROOM);
    expect(parsed.success, JSON.stringify(parsed.success ? {} : parsed.error.issues)).toBe(true);
  });

  // ★ THE SILENT-DEGRADATION LAW, and the reason Gap 6 exists at all.
  //
  // A venue requiring a substrate no available realizer provides must fail loudly, naming what it
  // needed and what exists. It must NOT quietly hand back the local realizer: a room that believes
  // it is isolated and is not is the one outcome worse than not running. So the law asserts BOTH
  // halves — the specific error, and that nothing reached PLAYING.
  it("refuses a venue whose substrate no available realizer provides, and reaches no room", async () => {
    const { localProcessRealizer, selectRealizer, VenueSubstrateUnavailable } = await substrate();
    expect(selectRealizer, "the import is the specification").toBeTypeOf("function");
    expect(VenueSubstrateUnavailable, "the import is the specification").toBeTypeOf("function");
    const local = localProcessRealizer();
    const room = VenueSchema.parse(CONTAINED_ROOM);

    let selected: VenueRealizer | undefined;
    let caught: unknown;
    try { selected = selectRealizer(room, [local]); } catch (e) { caught = e; }

    expect(caught, "a missing substrate is a refusal, never a downgrade").toBeInstanceOf(
      VenueSubstrateUnavailable,
    );
    expect(selected, "and nothing may be handed back — a weaker realizer is the defect").toBeUndefined();
    expect((caught as Error).message, "the refusal names what was required").toContain("container");
    expect((caught as Error).message, "…and what this host can actually provide").toContain(local.substrate);

    // NOTHING REACHED PLAYING. The refusal has to happen before a room exists, not after one stood
    // up on the wrong substrate and was then disowned.
    const probe = vi.fn(async () => ["search"]);
    await expect(
      local.realize(room, noCredentials, { gigId: GIG, engineServers, probe }),
      "a realizer must refuse a venue that does not name its substrate",
    ).rejects.toThrow();
    expect(probe, "and refuse before probing anything").not.toHaveBeenCalled();
  });

  // The other half of the same rule: a realizer that is PRESENT but unavailable on this host is not
  // a candidate. Installed-but-not-running is the ordinary case for a daemon, and it must read as
  // "cannot", never as "will". The second half keeps the law from passing by refusing always.
  it("an unavailable realizer is not a candidate, and an available one is selected", async () => {
    const { localProcessRealizer, dockerComposeRealizer, selectRealizer, VenueSubstrateUnavailable } =
      await substrate();
    expect(selectRealizer, "the import is the specification").toBeTypeOf("function");
    const local = localProcessRealizer();
    const contained = dockerComposeRealizer(NO_DAEMON);
    const room = VenueSchema.parse(CONTAINED_ROOM);
    const down: VenueRealizer = { ...contained, available: () => false };
    expect(() => selectRealizer(room, [local, down])).toThrow(VenueSubstrateUnavailable);
    const up: VenueRealizer = { ...contained, available: () => true };
    expect(selectRealizer(room, [local, up]).substrate).toBe(contained.substrate);
  });

  // A room naming no substrate runs anywhere. Deny-by-default belongs on CAPABILITY, not on
  // portability — the moment every venue must name a substrate, every venue that exists today stops
  // running, which is the same mistake as making venue targeting mandatory in Gap 5.
  it("a venue naming no substrate is realizable by whatever the deployment supplies", async () => {
    const { localProcessRealizer, selectRealizer } = await substrate();
    expect(selectRealizer, "the import is the specification").toBeTypeOf("function");
    const local = localProcessRealizer();
    expect(selectRealizer(VenueSchema.parse(EMPTY_ROOM), [local]).substrate).toBe(local.substrate);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// THE RENDERER — one law per forbidden setting, asserted on the rendered OUTPUT, so a partial
// implementation that closes four of five escapes cannot pass.
// ══════════════════════════════════════════════════════════════════════════════════════════════
describe("GAP 6 — the renderer emits only from a closed allowlist", () => {
  // THE ALLOWLIST IS EXACT, NOT A FLOOR. A field not on this list contributes nothing to the render
  // whatever it is called, and widening the list is a line someone changed on purpose — the same
  // reason tests/hosted_tools.test.ts pins its tool names exactly rather than asserting a minimum.
  it("substitutable fields are an exact, closed list", async () => {
    const { COMPOSE_SUBSTITUTABLE_FIELDS } = await substrate();
    expect(COMPOSE_SUBSTITUTABLE_FIELDS, "the import is the specification").toBeDefined();
    expect([...COMPOSE_SUBSTITUTABLE_FIELDS].sort()).toEqual(
      ["credential_names", "doors", "installs", "mcp_servers", "slug"].sort(),
    );
  });

  // PARSED INPUT ONLY. VenueSchema is already `.strict()` — that IS the enforcement point, and
  // handing the renderer unparsed input walks straight around it. Refuse, rather than trusting that
  // every future caller remembers to parse first.
  //
  // NON-VACUITY MATTERS HERE: `.strict()` would reject this object anyway, so a renderer that threw
  // on everything would pass the first assertion for the wrong reason. The second assertion pins the
  // legitimate case in the same law.
  it("refuses raw input, so an extra key can never render", async () => {
    const { renderComposeConfig } = await substrate();
    expect(renderComposeConfig, "the import is the specification").toBeTypeOf("function");
    // Never went through VenueSchema, and carries a key that would render into the configuration.
    const raw = { ...CONTAINED_ROOM, privileged: true, volumes: ["/:/host"] };
    expect(
      () => renderComposeConfig(raw, { gigId: GIG, realizationDir: REALIZATION_DIR }),
      "unparsed input must be refused at the door",
    ).toThrow();
    const rendered = await renderParsed();
    expect(rendered, "…and the parsed room must render, or the refusal above proves nothing").toBeTruthy();
    expect(flat(rendered), "no unparsed key may survive by any route").not.toContain("/:/host");
  });

  // ★ THE ONE-LINE ESCAPE, and the single most common way this design fails. A container that can
  // reach the runtime's own socket can start a second container with the host filesystem mounted —
  // this is not "a risky option", it is the end of the boundary.
  it("never emits a container runtime socket", async () => {
    const doc = await renderedDoc();
    expect(doc, "a runtime socket inside the room is the end of the room").not.toMatch(/docker\.sock/i);
    expect(doc).not.toMatch(/containerd\.sock|podman\.sock|\/var\/run\/docker/i);
  });

  // Host networking erases `doors` completely: a room whose network boundary it does not control has
  // no boundary, and `network_policy_doors` would be a guarantee claimed and not kept.
  it("never emits host networking", async () => {
    const doc = await renderedDoc();
    expect(doc).not.toMatch(/"network_mode"\s*:\s*"host"/i);
    expect(doc).not.toMatch(/--network[= ]host/i);
  });

  // Host PID namespace makes every process on the box visible and signalable from inside the room —
  // including the drain holding the venue credential this gig was minted against.
  it("never emits the host PID namespace", async () => {
    const doc = await renderedDoc();
    expect(doc).not.toMatch(/"pid"\s*:\s*"host"/i);
  });

  // Privileged mode: the room asks for authority the contract never declared. `equipment` is a
  // CEILING (src/chart.ts:273) — a realizer that quietly hands back more than the ceiling has
  // inverted the one property the venue class exists to provide.
  it("never emits privileged mode", async () => {
    const doc = await renderedDoc();
    expect(doc).not.toMatch(/"privileged"\s*:\s*true/i);
  });

  // Added capabilities are the same defect at a finer granularity, and the finer one is the one that
  // survives review because it looks specific and modest.
  it("never emits added capabilities", async () => {
    const doc = await renderedDoc();
    expect(doc).not.toMatch(/"cap_add"/i);
    expect(doc).not.toMatch(/"capabilities"\s*:\s*\{\s*"add"/i);
    expect(doc).not.toMatch(/SYS_ADMIN|CAP_SYS_/i);
  });

  // EVERY MOUNT SOURCE IS DERIVED, NOT CARRIED. A bind mount whose source came from contract text is
  // an arbitrary host path chosen by whoever wrote the contract. Deriving every source from the
  // per-realization directory makes "which host paths can this room see" answerable by reading one
  // line of the renderer, instead of auditing every venue in the genome forever.
  it("every mount source is derived from the per-realization directory", async () => {
    const doc = await renderParsed();
    const sources: string[] = [];
    const walk = (node: unknown): void => {
      if (typeof node === "string") {
        // compose-shaped volume entries are "<source>:<target>[:mode]"
        if (node.startsWith("/") || /^[^:]+:\/.+/.test(node)) sources.push(node.split(":")[0]!);
        return;
      }
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (node && typeof node === "object") { Object.values(node).forEach(walk); }
    };
    walk(doc);
    // NON-VACUITY, and this law is the sharpest instance of the problem in the file: the assertion
    // below lives INSIDE a loop, so a renderer emitting no mounts at all runs the body zero times
    // and passes without ever being examined. Measured under a `return {}` stub, it did exactly
    // that. A room mounts its own workspace, so the collection is never legitimately empty.
    expect(sources.length, "a rendered room mounts its workspace — an empty set proves nothing").toBeGreaterThan(0);
    for (const s of sources) {
      expect(
        s.startsWith(REALIZATION_DIR),
        `mount source "${s}" is not derived from the realization dir — an arbitrary host path in a room`,
      ).toBe(true);
    }
  });
});

describe("GAP 6 — the renderer refuses a forbidden value smuggled through an allowed field", () => {
  // AN ALLOWLIST OVER FIELD NAMES SAYS NOTHING ABOUT WHAT THOSE FIELDS CONTAIN. `mcp_servers` is on
  // the list and it carries a command; a command is a place a path goes. So the value-level check is
  // not belt-and-braces, it is the other half of the control — and the refusal must NAME the thing
  // it refused, because "invalid venue" sends the author back to read the whole contract.
  it("refuses a runtime socket path named inside an allowlisted field, naming it", async () => {
    const { renderComposeConfig, VenueRenderRefusal } = await substrate();
    expect(renderComposeConfig, "the import is the specification").toBeTypeOf("function");
    expect(VenueRenderRefusal, "the import is the specification").toBeTypeOf("function");
    const smuggled = VenueSchema.parse({
      ...CONTAINED_ROOM,
      mcp_servers: [
        {
          slug: "notes",
          transport: "stdio" as const,
          command: ["notes-mcp", "--socket", "/var/run/docker.sock"],
          credential_names: ["notes-token"],
        },
      ],
    });
    let caught: unknown;
    try { renderComposeConfig(smuggled, { gigId: GIG, realizationDir: REALIZATION_DIR }); } catch (e) { caught = e; }
    expect(caught, "a forbidden value in an allowed field is still forbidden").toBeInstanceOf(
      VenueRenderRefusal,
    );
    expect((caught as Error & { forbidden?: string }).forbidden, "the refusal names what it refused")
      .toMatch(/docker\.sock/i);
    // Non-vacuity: the same room WITHOUT the smuggled path renders.
    expect(await renderParsed(), "the legitimate room must still render").toBeTruthy();
  });

  // The same rule for a host path anywhere else a value can reach the configuration. An absolute
  // host path outside the realization dir has exactly one meaning — see the host — whichever field
  // it arrived in.
  it("refuses an absolute host path outside the realization directory", async () => {
    const { renderComposeConfig, VenueRenderRefusal } = await substrate();
    expect(renderComposeConfig, "the import is the specification").toBeTypeOf("function");
    const smuggled = VenueSchema.parse({
      ...CONTAINED_ROOM,
      mcp_servers: [
        {
          slug: "notes",
          transport: "stdio" as const,
          command: ["notes-mcp", "--root", "/etc"],
          credential_names: ["notes-token"],
        },
      ],
    });
    expect(() => renderComposeConfig(smuggled, { gigId: GIG, realizationDir: REALIZATION_DIR }))
      .toThrow(VenueRenderRefusal);
  });
});

describe("GAP 6 — credentials reach the room only through the resolver", () => {
  // CLASSES IN THE FILE, MATERIAL NEVER. Credentials are bound at realization time through
  // CredentialResolver, from credential_names ⊆ credential_surface. The rendered document may name
  // the CLASS — that is precisely what credential_surface is for — and must never carry the value,
  // for the same reason src/genome_schema.ts defines the surface as a list of names and never a
  // field material could occupy.
  it("renders the credential class, never the credential", async () => {
    const doc = await renderedDoc();
    expect(doc, "the class is the contract's own vocabulary and may appear").toContain("notes-token");
    // The resolver has not been called at render time, so no value can legitimately be present.
    // Asserted on value SHAPES rather than one string, so the law survives a rename of the fixture.
    expect(doc, "no resolved secret may be rendered").not.toMatch(/"[A-Za-z0-9_-]{32,}"/);
  });

  // NEVER THE HOST ENVIRONMENT, WHOLESALE. This is the quiet version of the same defect: a rendered
  // configuration that passes the host's environment through hands the room every credential the
  // DRAIN holds — including the venue credential itself, which src/claude_invoker.ts:839-845 already
  // identifies as the clearest case of a value a seat must never see. A sentinel proves it.
  it("never inherits the host environment wholesale", async () => {
    const SENTINEL = "COLTRANE_SPEC_SENTINEL";
    const saved = process.env[SENTINEL];
    process.env[SENTINEL] = "sentinel-value-that-must-not-be-rendered";
    try {
      const doc = await renderedDoc();
      expect(doc, "a host environment passthrough hands the room the drain's own credentials")
        .not.toContain("sentinel-value-that-must-not-be-rendered");
      expect(doc).not.toContain(SENTINEL);
    } finally {
      if (saved === undefined) delete process.env[SENTINEL]; else process.env[SENTINEL] = saved;
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// DEVICE ACCESS IS A CAPABILITY GRANT WEARING THE COSTUME OF CONFIGURATION.
//
// A realizer may need to give a room a serial port, a GPIO or I2C bus, a camera. That is the same
// shape as `doors`: the venue declares what it needs, the realizer maps exactly that, everything
// else is absent. And it carries the same danger as the runtime-socket rule one section up — a
// venue that can name an arbitrary device PATH can name the raw memory device or a whole block
// device, which is a host compromise submitted as a hardware request.
//
// So the contract names a CLASS and never a path, and the machine's own facts — which nodes, which
// owning group — stay with the machine.
// ══════════════════════════════════════════════════════════════════════════════════════════════
describe("GAP 6 — a venue asks for a KIND of device, never a path", () => {
  // The closed enumeration, exact rather than a floor, for the same reason the substitutable-field
  // allowlist is exact: widening what a room may ask the host for is a line someone changed on
  // purpose.
  it("device classes are a closed enumeration", async () => {
    const { DEVICE_CLASSES } = await substrate();
    expect(DEVICE_CLASSES, "the import is the specification").toBeDefined();
    expect([...DEVICE_CLASSES].sort()).toEqual(
      ["audio", "gpio", "i2c", "serial", "spi", "video"].sort(),
    );
  });

  it("VenueSchema accepts a device class and an architecture list", () => {
    const parsed = VenueSchema.safeParse(SERIAL_ROOM);
    expect(parsed.success, JSON.stringify(parsed.success ? {} : parsed.error.issues)).toBe(true);
  });

  // ★ A RAW PATH IS REFUSED AS A VALUE, not as an unknown key — and the distinction is the law.
  //
  // `.strict()` would reject `{ device_path: "/dev/mem" }` for the wrong reason: it does not know
  // the key. That refusal proves nothing about the dangerous case, which is a path arriving through
  // the field that legitimately exists. So the fixture uses the REAL field, and the assertion pins
  // the branch: the issue must be on `devices`, and must name the offending value.
  it("refuses a raw device path in the devices field — on the value, not on an unknown key", () => {
    const parsed = VenueSchema.safeParse({ ...SERIAL_ROOM, devices: ["/dev/mem"] });
    expect(parsed.success, "a path where a class belongs is the whole danger").toBe(false);
    if (!parsed.success) {
      const issues = parsed.error.issues;
      expect(
        issues.some((i) => i.path.includes("devices")),
        `the refusal must be about devices, not an unrecognized key — got ${JSON.stringify(issues)}`,
      ).toBe(true);
      expect(JSON.stringify(issues), "and it must name what was refused").toContain("/dev/mem");
    }
    // Non-vacuity: the same room asking for a CLASS parses.
    expect(VenueSchema.safeParse(SERIAL_ROOM).success, "the class form must parse").toBe(true);
  });
});

describe("GAP 6 — a device grant maps exactly what was declared, and widens nothing", () => {
  // Exactly the declared class's nodes and NO OTHER. "No other" is the half that matters: a mapping
  // that quietly includes a sibling node is the same defect as a mount source that was carried
  // rather than derived.
  it("maps exactly the declared class's nodes, and no other device", async () => {
    const doc = await renderParsed(SERIAL_ROOM, HOST);
    const text = flat(doc);
    for (const node of HOST.devices["serial"]!.nodes) {
      expect(text, "the declared class must actually be mapped").toContain(node);
    }
    // Every /dev path anywhere in the document must be one the host mapped for a DECLARED class.
    const granted = new Set(HOST.devices["serial"]!.nodes);
    for (const m of text.matchAll(/\/dev\/[A-Za-z0-9_.-]+/g)) {
      expect(granted.has(m[0]), `"${m[0]}" was rendered but no declared class maps it`).toBe(true);
    }
  });

  // GROUP MEMBERSHIP IS PART OF THE GRANT, and this law exists to close the escalation path rather
  // than to describe a nicety. In practice the node is mapped, the process still cannot open it
  // because it is not in the owning group, and the reflexive fix is to escalate the whole room to
  // privileged — undoing every boundary above to solve a permissions problem. Granting the
  // least-privilege membership is what makes that escalation unnecessary, so it is spec'd.
  it("grants the owning group, so escalating to privileged is never the easy fix", async () => {
    const doc = flat(await renderParsed(SERIAL_ROOM, HOST));
    expect(doc, "the least-privilege membership the device actually needs").toContain(
      HOST.devices["serial"]!.group,
    );
  });

  // ★ AND IT WIDENS NOTHING ELSE. Asserted for ABSENCE on the realized configuration, because the
  // failure here is something EXTRA appearing — privileged mode, a capability, or a device rule
  // broad enough to cover devices nobody declared. A room that got its serial port and root with it
  // has satisfied the request and destroyed the contract.
  it("a device grant produces no privileged mode, no capabilities, and no broad device rule", async () => {
    // Anchored: every assertion here is an ABSENCE, and a room that rendered nothing satisfies all
    // of them while granting no device either. The mapping must be present for its non-widening to
    // mean anything.
    const doc = await renderedDoc(SERIAL_ROOM, HOST);
    expect(doc, "the grant must actually be present for its narrowness to be a finding").toContain(
      HOST.devices["serial"]!.nodes[0]!,
    );
    expect(doc, "the reflexive escalation this whole grant exists to avoid").not.toMatch(
      /"privileged"\s*:\s*true/i,
    );
    expect(doc).not.toMatch(/"cap_add"/i);
    // A wildcard cgroup rule ("c *:* rwm") or the whole device tree is the escape under another name.
    expect(doc, "a wildcard device rule grants every device, declared or not").not.toMatch(
      /[abc]\s+\*:\*\s+r?w?m?/i,
    );
    expect(doc, "mapping the whole device tree is the same escape").not.toMatch(/"\/dev:\/dev"|\/dev:\/dev/);
  });

  // A class the host does not provide is a REFUSAL, not a silent omission. Identical principle to
  // the substrate-mismatch law: a venue that believes it has a device and does not is worse than
  // one that is told no, because the belief is what the author reasoned against.
  it("refuses a device class the host does not provide, and reaches no room", async () => {
    const { dockerComposeRealizer, VenueHostUnsuitable } = await substrate();
    expect(dockerComposeRealizer, "the import is the specification").toBeTypeOf("function");
    expect(VenueHostUnsuitable, "the import is the specification").toBeTypeOf("function");
    const room = VenueSchema.parse({ ...SERIAL_ROOM, devices: ["gpio"] });
    const probe = vi.fn(async () => ["search"]);
    await expect(
      dockerComposeRealizer(NO_DAEMON).realize(room, noCredentials, { gigId: GIG, engineServers, probe, host: HOST }),
      "a host without the device cannot host this room",
    ).rejects.toThrow(VenueHostUnsuitable);
    expect(probe, "and it must refuse before probing anything").not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// A VENUE NEED NOT BE REALIZED WHERE THE WORKER RUNS. A room may be stood up on a machine that has
// something this box does not — attached hardware, a network position, an architecture — while the
// contract stays identical. That is the strongest argument the venue abstraction has, and it comes
// with two obligations.
// ══════════════════════════════════════════════════════════════════════════════════════════════
describe("GAP 6 — realizing somewhere else weakens nothing", () => {
  const REMOTE: RealizationHost = {
    ...HOST,
    endpoint: "realization-host.example",
    credential: async () => "placeholder-host-credential",
  };

  // ★ EVERY REFUSAL HOLDS REGARDLESS OF WHICH HOST EXECUTES. Written as its own law because "it is
  // on their machine, not ours" is exactly the reasoning that would relax it — and a privileged
  // container on someone else's host is not less privileged, only less visible.
  it("every forbidden setting stays forbidden when the host is remote", async () => {
    const doc = flat(await renderParsed(SERIAL_ROOM, REMOTE));
    expect(doc).not.toMatch(/docker\.sock|containerd\.sock|podman\.sock/i);
    expect(doc).not.toMatch(/"network_mode"\s*:\s*"host"/i);
    expect(doc).not.toMatch(/"pid"\s*:\s*"host"/i);
    expect(doc).not.toMatch(/"privileged"\s*:\s*true/i);
    expect(doc).not.toMatch(/"cap_add"/i);
    // …and the venue-derived content is the SAME room it would be locally. The contract does not
    // change because the place did.
    expect(doc, "the declared server travels unchanged").toContain("notes");
    expect(doc, "so does the declared credential class").toContain("notes-token");
  });

  // ★ THE HIGHEST-VALUE CREDENTIAL IN THE SYSTEM. A credential that drives a remote realization host
  // is typically administrative ON that host — higher value than the venue credential, because it is
  // authority over a machine rather than over an organization's queue. So it follows the discipline
  // src/workspace.ts:60-89 already documents for the per-gig git credential: obtained per gig,
  // against a live lease, never held at boot and never the same one twice.
  it("obtains a remote host credential per gig, never at boot, and never renders it", async () => {
    const { dockerComposeRealizer } = await substrate();
    expect(dockerComposeRealizer, "the import is the specification").toBeTypeOf("function");
    const credential = vi.fn(async () => "placeholder-host-credential");
    const realizer = dockerComposeRealizer(NO_DAEMON);
    const room = VenueSchema.parse(SERIAL_ROOM);
    const host: RealizationHost = { ...HOST, endpoint: "realization-host.example", credential };
    const probe = async () => ["search"];

    const first = await realizer.realize(room, noCredentials, { gigId: GIG, engineServers, probe, host });
    expect(credential, "the credential is fetched for the gig, not read at boot").toHaveBeenCalledTimes(1);
    expect(credential).toHaveBeenCalledWith({ gigId: GIG });
    await first.teardown();

    const secondGig = "88888888-8888-8888-8888-888888888888";
    const second = await realizer.realize(room, noCredentials, { gigId: secondGig, engineServers, probe, host });
    expect(credential, "a second gig gets its own, never the first one again").toHaveBeenCalledTimes(2);
    expect(credential).toHaveBeenLastCalledWith({ gigId: secondGig });
    await second.teardown();

    // And it never lands in the rendered configuration, for the same reason no other credential does.
    expect(flat(await renderParsed(SERIAL_ROOM, host)), "host authority must not be written to a file")
      .not.toContain("placeholder-host-credential");
  });

  // A LOCAL realization asks for no host credential at all. Otherwise the "per gig" law above could
  // be satisfied by a realizer that always fetches one, which would put an administrative credential
  // on the path of every run that never needed one.
  it("asks for no host credential when the room is realized here", async () => {
    const { dockerComposeRealizer } = await substrate();
    expect(dockerComposeRealizer, "the import is the specification").toBeTypeOf("function");
    const credential = vi.fn(async () => "placeholder-host-credential");
    // No endpoint: this IS the worker's own machine.
    const local: RealizationHost = { ...HOST, credential };
    const handle = await dockerComposeRealizer(NO_DAEMON).realize(VenueSchema.parse(SERIAL_ROOM), noCredentials, {
      gigId: GIG, engineServers, probe: async () => ["search"], host: local,
    });
    expect(credential, "no remote host, no administrative credential").not.toHaveBeenCalled();
    await handle.teardown();
  });
});

describe("GAP 6 — architecture is part of the contract", () => {
  // A venue realized on a host of the wrong architecture fails at run time, confusingly, and usually
  // on someone else's machine on their first attempt. The mismatch is knowable at construction, so
  // it is answered at construction — the same shape as the substrate and device refusals.
  it("refuses a host whose architecture the venue does not support, before PLAYING", async () => {
    const { dockerComposeRealizer, VenueHostUnsuitable } = await substrate();
    expect(dockerComposeRealizer, "the import is the specification").toBeTypeOf("function");
    const room = VenueSchema.parse(SERIAL_ROOM); // supports arm64
    const wrong: RealizationHost = { ...HOST, architecture: "amd64" };
    const probe = vi.fn(async () => ["search"]);
    await expect(
      dockerComposeRealizer(NO_DAEMON).realize(room, noCredentials, { gigId: GIG, engineServers, probe, host: wrong }),
    ).rejects.toThrow(VenueHostUnsuitable);
    expect(probe, "refuse before standing anything up").not.toHaveBeenCalled();
    // Non-vacuity: the matching host realizes, or the law passes by refusing always.
    const ok = await dockerComposeRealizer(NO_DAEMON).realize(room, noCredentials, {
      gigId: GIG, engineServers, probe: async () => ["search"], host: HOST,
    });
    expect(ok.state).toBe("PLAYING");
    await ok.teardown();
  });

  // A venue naming no architecture runs anywhere. Deny-by-default belongs on CAPABILITY, not on
  // portability — the same reason an unnamed venue stays claimable in Gap 5, and the same reason a
  // venue naming no substrate is realizable by whatever the deployment supplies.
  it("a venue naming no architecture is realizable on any host", async () => {
    const { dockerComposeRealizer } = await substrate();
    expect(dockerComposeRealizer, "the import is the specification").toBeTypeOf("function");
    const anywhere = VenueSchema.parse(CONTAINED_ROOM); // declares no architectures
    const handle = await dockerComposeRealizer(NO_DAEMON).realize(anywhere, noCredentials, {
      gigId: GIG, engineServers, probe: async () => ["search"], host: { ...HOST, architecture: "amd64" },
    });
    expect(handle.state).toBe("PLAYING");
    await handle.teardown();
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// TEARDOWN IS NOT ENOUGH. `finally` does not run when the process is KILLED — SIGKILL, the OOM
// killer, a host that dies — so every crash leaks everything the worker realized, and on a
// long-lived box the leak accumulates until something fills.
//
// The engine already knows this shape: src/worker.ts:330 accepts a row stranded by a store that
// leased without minting and says so rather than pretending otherwise, and reapWorkerState
// (src/worker.ts:181) exists because local checkpoint state outlives the process that wrote it.
// Realized environments are the same debris with a larger blast radius.
//
// So the model is RECONCILIATION, not cleanup: label everything, then collect what belongs to no
// live gig — reconciling against observed state rather than a list the dead process was holding.
// ══════════════════════════════════════════════════════════════════════════════════════════════
describe("GAP 6 — realization is reconciled, because a killed worker runs no finally", () => {
  const realizeFor = async (gigId: string, host: RealizationHost = HOST) => {
    const { dockerComposeRealizer } = await substrate();
    expect(dockerComposeRealizer, "the import is the specification").toBeTypeOf("function");
    return dockerComposeRealizer(NO_DAEMON).realize(VenueSchema.parse(SERIAL_ROOM), noCredentials, {
      gigId, engineServers, probe: async () => ["search"], host,
    });
  };

  // Everything, labelled with both. The GIG says what it belongs to; the INSTANCE says who made it,
  // which is what lets a human tell a leaked artifact from a deliberate one — and an unlabelled
  // artifact is indistinguishable from something somebody made on purpose, so nothing may collect it.
  it("every realized artifact carries the gig and the instance that created it", async () => {
    const handle = await realizeFor(GIG);
    expect(handle.artifacts.length, "a realization that records nothing cannot be reconciled")
      .toBeGreaterThan(0);
    for (const a of handle.artifacts) {
      expect(a.labels.gig_id, `${a.kind} must say which gig it belongs to`).toBe(GIG);
      expect(a.labels.instance, `${a.kind} must say who created it`).toBeTruthy();
    }
    await handle.teardown();
  });

  // THE CRASH-RECOVERY CASE, and the whole reason a sweep exists. An artifact whose gig is over —
  // including one a PRIOR instance of this worker left behind when it was killed — is collected.
  // Reconciling against the live set rather than against anything this process remembers is what
  // makes that possible, because the process that created it is precisely the one that died.
  it("a sweep collects an artifact whose gig is not live, including a dead instance's", async () => {
    const { dockerComposeRealizer } = await substrate();
    expect(dockerComposeRealizer, "the import is the specification").toBeTypeOf("function");
    const realizer = dockerComposeRealizer(NO_DAEMON);
    const dead = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    await realizer.realize(VenueSchema.parse(SERIAL_ROOM), noCredentials, {
      gigId: dead, engineServers, probe: async () => ["search"], host: HOST,
    });
    // No teardown: this is the killed-worker case, which is the only case that matters here.
    const collected = await realizer.sweep({ liveGigs: [] });
    expect(
      collected.some((a) => a.labels.gig_id === dead),
      "an artifact belonging to no live gig is exactly what a sweep is for",
    ).toBe(true);
  });

  // ★ AND IT SPARES A LIVE GIG'S WORK, INCLUDING A PEER'S. Two workers sharing a host must never
  // garbage-collect each other. This is the law that makes an unconditional startup sweep SAFE —
  // and without it the feature is a footgun that deletes a peer's running work, which is strictly
  // worse than leaking. The live set is host-wide for exactly this reason.
  it("a sweep spares a live gig, even one realized by a different instance on the same host", async () => {
    const { dockerComposeRealizer } = await substrate();
    expect(dockerComposeRealizer, "the import is the specification").toBeTypeOf("function");
    const realizer = dockerComposeRealizer(NO_DAEMON);
    const peerGig = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
    const peer = await realizer.realize(VenueSchema.parse(SERIAL_ROOM), noCredentials, {
      gigId: peerGig, engineServers, probe: async () => ["search"], host: HOST,
    });
    // Sweeping as somebody else, with the peer's gig live.
    const collected = await realizer.sweep({ liveGigs: [peerGig] });
    expect(
      collected.some((a) => a.labels.gig_id === peerGig),
      "collecting a peer's live work is worse than leaking; the sweep must spare it",
    ).toBe(false);
    await peer.teardown();
  });

  // A BOUND EXISTS. Build cache, unreferenced build artifacts and logs are not per-gig, so no
  // teardown covers them — and the build cache is typically the largest consumer on the box. The
  // argument is DEFAULT_DRAIN_OPENING's (src/run_deps.ts:47): an unattended box that can consume
  // without limit is the one thing it must not be. The point is that a ceiling exists, not that any
  // particular number is right.
  it("a realizer declares a retention policy with real ceilings and a real cadence", async () => {
    const { dockerComposeRealizer, localProcessRealizer } = await substrate();
    expect(dockerComposeRealizer, "the import is the specification").toBeTypeOf("function");
    for (const r of [localProcessRealizer(), dockerComposeRealizer(NO_DAEMON)]) {
      const p = r.retention;
      for (const n of [p.max_cached_build_artifacts, p.max_unreferenced_environments]) {
        expect(Number.isFinite(n), `${r.substrate}: "unlimited" is not a retention policy`).toBe(true);
        expect(n, `${r.substrate}: a ceiling of zero would collect what is in use`).toBeGreaterThan(0);
      }
      expect(p.cadence, `${r.substrate}: a policy applied never is not applied`).toBeTruthy();
    }
  });

  // LOGS ARE BOUNDED IN THE RENDERED CONFIGURATION. Unbounded by default is the common case, so one
  // talkative process fills a disk and takes the worker with it — and a worker that dies of a full
  // disk has failed at its one job.
  //
  // NOTE THE SOURCING, which is deliberate: the bound comes from the realizer's retention policy and
  // is NOT a venue-substitutable field. Putting it on COMPOSE_SUBSTITUTABLE_FIELDS would let a room
  // raise its own ceiling, which is the one thing a ceiling must not permit — the same posture
  // `equipment` already takes as a ceiling rather than a grant.
  it("every rendered configuration carries a log bound", async () => {
    const doc = flat(await renderParsed(SERIAL_ROOM, HOST));
    expect(doc, "a rendered configuration with no log bound is a defect").toMatch(
      /"(logging|log_driver|log_opt|max-size|max_size)"/i,
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// RESOURCE DISCIPLINE IS A CONTRACT PROPERTY, not an optimisation pass.
//
// With no venue contract in force a worker needs exactly ONE prepared environment, so that
// environment must be the union of everything any gig might need — every tool, every runtime, every
// heavyweight dependency of every skill — because nothing tells it which subset THIS work requires.
// Every gig then pays for every capability it never invokes. That is not a packaging mistake; it is
// the only design reachable when nothing declares what a piece of work needs.
//
// The venue contract is what makes minimality possible at all, which makes it one of the strongest
// arguments for Gap 2: smaller environments are a CONSEQUENCE of the contract, not a separate effort.
// ══════════════════════════════════════════════════════════════════════════════════════════════
describe("GAP 6 — the environment is a function of the contract", () => {
  // BUILDING IS THE EXPENSIVE PART, and content addressing is what amortises it: if the identity of
  // a built environment is a function of the CONTRACT'S hash, an unchanged contract rebuilds
  // nothing. This is the payoff of the digest-pinned `installs` already in the design — pinning is
  // what makes the hash mean something, and the hash is what makes the rebuild unnecessary. They
  // were always one mechanism.
  it("environment identity follows the contract: unchanged rebuilds nothing, changed rebuilds", async () => {
    const { environmentIdentity } = await substrate();
    expect(environmentIdentity, "the import is the specification").toBeTypeOf("function");
    const a = VenueSchema.parse(SERIAL_ROOM);
    const b = VenueSchema.parse({ ...SERIAL_ROOM });
    expect(environmentIdentity(a), "the same contract is the same environment").toBe(environmentIdentity(b));
    const changed = VenueSchema.parse({
      ...SERIAL_ROOM,
      mcp_servers: [{ ...SERIAL_ROOM.mcp_servers[0]!, command: ["notes-mcp", "--stdio", "--verbose"] }],
    });
    expect(environmentIdentity(changed), "a changed contract is a different environment")
      .not.toBe(environmentIdentity(a));
  });

  // SHARED FLOORS, SMALL DELTAS. Composed so the shared portion is large and the venue-specific part
  // small, N venues over a common floor cost floor + Σ(deltas) rather than N × environment. The
  // law-able form of that is the precondition for it: two venues declaring the same floor must
  // resolve to the SAME floor identity — otherwise sharing is not possible at all — while their own
  // identities differ, or they are not two venues.
  it("two venues on one floor share a floor identity, and differ in their deltas", async () => {
    const { floorIdentity, environmentIdentity } = await substrate();
    expect(floorIdentity, "the import is the specification").toBeTypeOf("function");
    expect(environmentIdentity, "the import is the specification").toBeTypeOf("function");
    const one = VenueSchema.parse({ ...SERIAL_ROOM, slug: "one-room-v1", floor: "base-v1" });
    const two = VenueSchema.parse({
      ...SERIAL_ROOM, slug: "two-room-v1", floor: "base-v1", devices: [], architectures: ["arm64"],
    });
    expect(floorIdentity(one), "a shared floor is what makes sharing possible").toBe(floorIdentity(two));
    expect(environmentIdentity(one), "…and the deltas are still two different rooms")
      .not.toBe(environmentIdentity(two));
  });

  // THE MEMORY LEVER, and it is not the same lever as the storage one. Storage and cold-start
  // acquisition scale with environment SIZE; memory scales with the number of running PROCESSES. An
  // environment of any size running one process holds roughly that one process's memory — so
  // shrinking environments does not reduce memory pressure and must not be sold as if it does.
  //
  // Per-chair realization multiplies substrate resources by the WIDTH of a phase, so the ceiling
  // belongs in the contract, where an author sets it deliberately rather than discovering it with
  // the first wide DAG on the first box that runs it.
  it("a venue declares a concurrency ceiling, and exceeding it is refused", async () => {
    const { dockerComposeRealizer, VenueConcurrencyRefused } = await substrate();
    expect(dockerComposeRealizer, "the import is the specification").toBeTypeOf("function");
    expect(VenueConcurrencyRefused, "the import is the specification").toBeTypeOf("function");
    const bounded = VenueSchema.safeParse({ ...SERIAL_ROOM, max_concurrent_chairs: 2 });
    expect(bounded.success, "the ceiling belongs in the contract").toBe(true);
    const realizer = dockerComposeRealizer(NO_DAEMON);
    const room = bounded.success ? bounded.data : undefined;
    await expect(
      realizer.realize(room, noCredentials, { gigId: GIG, engineServers, probe: async () => ["search"], host: HOST, chairs: 3 }),
      "a phase wider than the room may hold is refused, not quietly served",
    ).rejects.toThrow(VenueConcurrencyRefused);
    // Non-vacuity: at the ceiling it realizes.
    const ok = await realizer.realize(room, noCredentials, {
      gigId: GIG, engineServers, probe: async () => ["search"], host: HOST, chairs: 2,
    });
    expect(ok.state).toBe("PLAYING");
    await ok.teardown();
  });
});
