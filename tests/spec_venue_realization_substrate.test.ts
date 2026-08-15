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

interface RealizationHandle {
  state: string;
  mcpServerConfigs: Readonly<Record<string, unknown>>;
  configPath: string;
  teardown(): Promise<void> | void;
  tornDown(): boolean;
}

/** The properties a realizer may CLAIM — and may only claim if it can keep them. */
type VenueGuarantee =
  | "withholds_capabilities"
  | "isolated_filesystem"
  | "network_policy_doors"
  | "reproducible_tool_surface"
  | "per_chair_isolation";

/** The seam. Injected exactly the way `CredentialResolver` already is: the engine ships the
 *  interface, the state machine, the probe and the drift guard; a deployment supplies the
 *  implementations it has. */
interface VenueRealizer {
  readonly substrate: string;
  readonly guarantees: readonly VenueGuarantee[];
  available(): boolean;
  realize(
    venue: unknown,
    credentialResolver: CredentialResolver,
    opts: { gigId: string; engineServers?: Readonly<Record<string, unknown>>; probe?: (s: { slug: string }) => Promise<string[]> },
  ): Promise<RealizationHandle>;
}

interface SubstrateModule {
  localProcessRealizer(): VenueRealizer;
  dockerComposeRealizer(): VenueRealizer;
  /** Picks the realizer a venue requires from those a deployment supplies. Throws rather than
   *  returning a weaker one — the whole reason this gap is written down. */
  selectRealizer(venue: unknown, realizers: readonly VenueRealizer[]): VenueRealizer;
  VenueSubstrateUnavailable: new (...args: never[]) => Error;
  /** Thrown when input would render a setting the contract may not ask for. Carries `forbidden`
   *  so the refusal names the thing, rather than being a bare throw a caller must guess at. */
  VenueRenderRefusal: new (...args: never[]) => Error;
  /** The CLOSED allowlist of contract fields the renderer may substitute. */
  COMPOSE_SUBSTITUTABLE_FIELDS: readonly string[];
  /** Renders the runtime configuration from a PARSED venue. Never from raw input. */
  renderComposeConfig(
    venue: unknown,
    opts: { gigId: string; realizationDir: string },
  ): Record<string, unknown>;
}
const substrate = async (): Promise<SubstrateModule> =>
  (await import(VENUE_REALIZER)) as unknown as SubstrateModule;

const engineServers = { [ENGINE_MCP_SERVER]: { command: "node", args: ["dist/src/server_entry.js"] } };
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

const REALIZATION_DIR = "/realizations/gig-77777777";
const GIG = "77777777-7777-7777-7777-777777777777";

/** Render a parsed room, for the laws that assert on OUTPUT. */
const renderParsed = async (room: unknown = CONTAINED_ROOM): Promise<Record<string, unknown>> => {
  const { renderComposeConfig } = await substrate();
  expect(renderComposeConfig, "the import is the specification").toBeTypeOf("function");
  return renderComposeConfig(VenueSchema.parse(room), { gigId: GIG, realizationDir: REALIZATION_DIR });
};

/** Every string anywhere in the rendered document — the only honest way to ask "did this leak". A
 *  forbidden setting only has to appear once, anywhere, to be the whole boundary. */
const flat = (doc: unknown): string => JSON.stringify(doc);

describe("GAP 6 — the substrate is a named, injectable seam with two implementations", () => {
  // TWO IMPLEMENTATIONS OR IT IS NOT A SEAM. A one-implementation interface is a hardcoded strategy
  // with extra indirection; the second implementation is what demonstrates nothing leaked into the
  // contract. Both are asserted against the SAME shape here, which is the whole test.
  it("both realizers satisfy one interface, and each names its own substrate", async () => {
    const { localProcessRealizer, dockerComposeRealizer } = await substrate();
    expect(localProcessRealizer, "the import is the specification").toBeTypeOf("function");
    expect(dockerComposeRealizer, "the import is the specification").toBeTypeOf("function");
    const local = localProcessRealizer();
    const contained = dockerComposeRealizer();
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
    const g = dockerComposeRealizer().guarantees;
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
    const contained = dockerComposeRealizer();
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
    const doc = flat(await renderParsed());
    expect(doc, "a runtime socket inside the room is the end of the room").not.toMatch(/docker\.sock/i);
    expect(doc).not.toMatch(/containerd\.sock|podman\.sock|\/var\/run\/docker/i);
  });

  // Host networking erases `doors` completely: a room whose network boundary it does not control has
  // no boundary, and `network_policy_doors` would be a guarantee claimed and not kept.
  it("never emits host networking", async () => {
    const doc = flat(await renderParsed());
    expect(doc).not.toMatch(/"network_mode"\s*:\s*"host"/i);
    expect(doc).not.toMatch(/--network[= ]host/i);
  });

  // Host PID namespace makes every process on the box visible and signalable from inside the room —
  // including the drain holding the venue credential this gig was minted against.
  it("never emits the host PID namespace", async () => {
    const doc = flat(await renderParsed());
    expect(doc).not.toMatch(/"pid"\s*:\s*"host"/i);
  });

  // Privileged mode: the room asks for authority the contract never declared. `equipment` is a
  // CEILING (src/chart.ts:273) — a realizer that quietly hands back more than the ceiling has
  // inverted the one property the venue class exists to provide.
  it("never emits privileged mode", async () => {
    const doc = flat(await renderParsed());
    expect(doc).not.toMatch(/"privileged"\s*:\s*true/i);
  });

  // Added capabilities are the same defect at a finer granularity, and the finer one is the one that
  // survives review because it looks specific and modest.
  it("never emits added capabilities", async () => {
    const doc = flat(await renderParsed());
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
    const doc = flat(await renderParsed());
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
      const doc = flat(await renderParsed());
      expect(doc, "a host environment passthrough hands the room the drain's own credentials")
        .not.toContain("sentinel-value-that-must-not-be-rendered");
      expect(doc).not.toContain(SENTINEL);
    } finally {
      if (saved === undefined) delete process.env[SENTINEL]; else process.env[SENTINEL] = saved;
    }
  });
});
