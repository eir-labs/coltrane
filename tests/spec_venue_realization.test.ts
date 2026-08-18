// ════════════════════════════════════════════════════════════════════════════════════════════
// PENDING IMPLEMENTATION — this file is committed RED on purpose. See SPEC-worker-contract.md.
// A failure here is a feature not yet built. A failure in any file NOT named spec_* is a
// regression. Do not weaken these laws to make CI green; implement them.
// ════════════════════════════════════════════════════════════════════════════════════════════
//
// GAP 2 — A TOOL GRANTED IN A VENUE'S CONTRACT CAN BE ABSENT FROM THE SPAWN'S ACTUAL ENVIRONMENT,
// and nothing discovers it until use.
//
// MOST OF THE VENUE CONTRACT ALREADY EXISTS, and it is good. `VenueSchema`
// (src/genome_schema.ts:938, .strict()) declares equipment.tools as a deny-by-default allowlist,
// credential_surface as CLASSES rather than material, doors per direction, digest-pinned installs,
// lifecycle, and a responsible office. `venueEffectiveTools` (src/chart.ts:273) intersects
// allowed_tools ∩ equipment.tools so a room can only narrow a player; composeChart R10 refuses a
// chart whose room starves a seated agent. `resolveAndRealize` (src/venue_realize.ts) runs the
// ordered gauntlet and runGig calls it before the first chair (src/runtime.ts:924).
//
// THREE THINGS ARE MISSING, and together they are one defect:
//
//   1. A venue cannot declare an MCP SERVER. equipment.tools may name `mcp__<server>__<tool>`, and
//      nothing in the contract says what provides it. The schema says so itself: "Realization
//      (building the room from the contract) and verification by behavioural probe are a lower
//      layer and are not modelled here." True when written; it is now the hole.
//   2. Realization does not CONSTRUCT the spawn's MCP environment. The gauntlet returns no server
//      config, so --mcp-config still comes from the ambient map readMcpServerConfigs
//      (src/server.ts:3170) builds from `.mcp.json` at bootstrap — the environment, not the
//      contract. src/server.ts:1123 says it in one line: "dispatch preflight resolves against the
//      invoker's environment".
//   3. On a drain, NEITHER exists. workOnce passes `mcpServerConfigs: {}` and sets no venue at all
//      (src/worker.ts:936-943), so a drained gig realizes no room whatsoever.
//
// The consequence: a server named in equipment.tools passes R10 at compose time — R10 checks the
// tool-NAME intersection, which is a different question — and is then resolved against a map the
// venue never saw. Any standard granting `mcp__<server>__*` tools runs on the operator's own
// checkout and fails preflight everywhere else. The refusal is correct; the absence of any way to
// satisfy it is the defect.
//
// The laws below follow the existing VenueSchema grain and the existing realize vocabulary. They
// are not a parallel scheme: the contract stays the declaration surface, and the realizer is the
// layer beneath it that builds a room strictly and exclusively from what the contract declares.
//
// THE IMPORT OF `src/venue_realizer.ts` IS THE SPECIFICATION. It does not exist; each law loads it
// through a specifier held in a const so tsc stays clean (this repo's vitest globalSetup builds
// first, and one compile error would stop every band from running — at which point nobody could
// tell a pending spec from a regression).
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VenueSchema } from "../src/genome_schema.js";
import { assertToolGrantsResolvable, ENGINE_MCP_SERVER, type ToolProvider, type ToolProviderRegistry } from "../src/tool_providers.js";

const VENUE_REALIZER = "../src/venue_realizer.js";

/** What a deployment binds credential CLASSES to. The genome names classes; this returns values,
 *  and it is the ONLY door between the two — secrets never live in the genome. */
type CredentialResolver = (names: readonly string[]) => Promise<Record<string, string>>;

interface RealizationHandle {
  state: string;
  /** the realized per-gig map: the venue's declared servers, plus engine entries. Never ambient. */
  mcpServerConfigs: Readonly<Record<string, unknown>>;
  /** the per-gig mcp-config file the spawn is pointed at. */
  configPath: string;
  teardown(): Promise<void> | void;
  tornDown(): boolean;
}

interface RealizerModule {
  realizeVenue(
    venue: unknown,
    credentialResolver: CredentialResolver,
    opts: {
      gigId: string;
      engineServers?: Readonly<Record<string, unknown>>;
      /** the tools/list transport. Injected here; production spawns the declared command. A venue
       *  that declares no server must never call it — that is "zero child processes", expressed as
       *  a property a test can hold. */
      probe?: (server: { slug: string }) => Promise<string[]>;
    },
  ): Promise<RealizationHandle>;
  VenueRealizationError: new (...args: never[]) => Error;
  VenueContractViolation: new (...args: never[]) => Error;
}
const realizer = async (): Promise<RealizerModule> =>
  (await import(VENUE_REALIZER)) as unknown as RealizerModule;

/** The containerized realizer and the renderer live in the same module; the laws that assert the
 *  docker-exec channel and the room's holding command reach for them directly. */
interface ContainerModule {
  dockerComposeRealizer(opts?: { run?: () => void }): {
    realize(
      venue: unknown,
      credentialResolver: CredentialResolver,
      opts: {
        gigId: string;
        engineServers?: Readonly<Record<string, unknown>>;
        probe?: (s: { slug: string }) => Promise<string[]>;
      },
    ): Promise<RealizationHandle>;
  };
  renderComposeConfig(
    venue: unknown,
    opts: { gigId: string; realizationDir: string },
  ): Record<string, unknown>;
}
const containerModule = async (): Promise<ContainerModule> =>
  (await import(VENUE_REALIZER)) as unknown as ContainerModule;

const ENGINE_ENTRY = { command: "node", args: ["dist/src/server_entry.js"] };
const engineServers = { [ENGINE_MCP_SERVER]: ENGINE_ENTRY };

/** The empty room, in the shape venues/empty-room-v1.json already ships. */
const EMPTY_ROOM = {
  slug: "empty-room-v1",
  institution_slug: "quartet",
  equipment: { tools: [] },
  credential_surface: [],
  lifecycle: { policy: "ephemeral" as const },
};

/** A room that equips one external server's tools and declares what provides them. `notes` is a
 *  placeholder slug: this repo is public and no deployment's server belongs in a fixture. */
const NOTES_ROOM = {
  slug: "notes-room-v1",
  institution_slug: "quartet",
  equipment: { tools: ["mcp__notes__search", "mcp__notes__read"] },
  credential_surface: ["notes-token"],
  mcp_servers: [
    {
      slug: "notes",
      transport: "stdio" as const,
      command: ["notes-mcp", "--stdio"],
      credential_names: ["notes-token"],
    },
  ],
  lifecycle: { policy: "ephemeral" as const },
};

/** These laws are about what the realizer DECIDES — the shape it emits, the venue it refuses, the
 *  artifacts it records. None of that is a claim about docker, and CI has no daemon, so they run
 *  against a runner that records instead of executing. The liveness claim is not made here and
 *  cannot be: tests/spec_venue_room_live.test.ts takes the REAL default and runs the emitted
 *  transport verbatim against a standing room. */
const NO_DAEMON = { run: () => {} };

const noCredentials: CredentialResolver = async () => ({});

describe("GAP 2 — a venue declares what provides its tools", () => {
  // The declaration itself. VenueSchema is .strict(), so today this key is REJECTED rather than
  // merely unmodelled — which is the correct posture for a strict contract and exactly why the
  // field has to be added to the one Zod source rather than smuggled past it.
  it("VenueSchema accepts an mcp_servers declaration", () => {
    const parsed = VenueSchema.safeParse(NOTES_ROOM);
    expect(parsed.success, JSON.stringify(parsed.success ? {} : parsed.error.issues)).toBe(true);
  });

  // THE RULE THAT MAKES "GRANTED BUT UNPROVIDED" UNAUTHORABLE. Today a room may grant
  // mcp__notes__search with nothing anywhere saying what `notes` is, pass R10 (which checks the
  // tool-NAME intersection — a different question), and be discovered at use, mid-run, on a box
  // nobody is watching. Refusing at parse moves that discovery to the author's terminal.
  it("refuses a venue granting an mcp server it does not declare, naming the slug", () => {
    const undeclared = { ...NOTES_ROOM, mcp_servers: [] };
    const parsed = VenueSchema.safeParse(undeclared);
    expect(parsed.success, "a granted server with no declaration must not parse").toBe(false);
    if (!parsed.success) {
      expect(JSON.stringify(parsed.error.issues), "the refusal must name the undeclared slug")
        .toContain("notes");
    }
  });

  // A declaration that cannot be acted on is not a declaration. Each transport owes the one field
  // that makes it reachable, and the schema is where that is stated once for both doors into the
  // class (the loader and venue_define) rather than twice in two agreeing habits.
  it("requires the field its transport needs: a command for stdio, a url for sse", () => {
    const noCommand = { ...NOTES_ROOM, mcp_servers: [{ slug: "notes", transport: "stdio", credential_names: [] }] };
    expect(VenueSchema.safeParse(noCommand).success, "stdio owes a command").toBe(false);
    const sseNoUrl = { ...NOTES_ROOM, mcp_servers: [{ slug: "notes", transport: "sse", credential_names: [] }] };
    expect(VenueSchema.safeParse(sseNoUrl).success, "sse owes a url").toBe(false);
    // NON-VACUITY. A `.strict()` schema that has never heard of `mcp_servers` refuses all three of
    // these for one reason, and the law would read green while proving nothing. Pin the positive
    // case in the same law so it cannot.
    expect(
      VenueSchema.safeParse(NOTES_ROOM).success,
      "…and the well-formed declaration must parse, or the refusals above are vacuous",
    ).toBe(true);
  });

  // credential_names references credential_surface, and the reference is CHECKED. This is not
  // tidiness: realize() already treats a credential class present but undeclared as a
  // `credential-breach` refusal, so a server needing a credential the room never declared would
  // stand up a box that every room then refuses.
  it("refuses a credential_name the room's credential_surface does not declare", () => {
    const unlisted = {
      ...NOTES_ROOM,
      credential_surface: [],
      mcp_servers: [{ ...NOTES_ROOM.mcp_servers[0], credential_names: ["notes-token"] }],
    };
    const parsed = VenueSchema.safeParse(unlisted);
    expect(parsed.success, "a credential the surface does not declare is a breach, not a default").toBe(false);
    if (!parsed.success) {
      expect(JSON.stringify(parsed.error.issues)).toContain("notes-token");
    }
    // Same non-vacuity guard: the room that DOES declare it must parse.
    expect(VenueSchema.safeParse(NOTES_ROOM).success, "the declared case must parse").toBe(true);
  });
});

describe("GAP 2 — realizeVenue builds the environment from the contract and nothing else", () => {
  // THE BARE CASE MUST STAY FREE. venues/empty-room-v1.json declares no servers, so preparation
  // writes only engine entries and verification probes nothing — zero child processes. Expressed
  // here as "the probe is never called", which is the property "no spawn" reduces to once the
  // transport is injectable. A room that costs a subprocess to stand up empty is a tax on every
  // venue-less gig in the system.
  it("the empty room traverses the machine with no probe and no declared servers", async () => {
    const { realizeVenue } = await realizer();
    expect(realizeVenue, "the import is the specification").toBeTypeOf("function");
    const probe = vi.fn(async () => []);
    const handle = await realizeVenue(EMPTY_ROOM, noCredentials, {
      gigId: "11111111-1111-1111-1111-111111111111",
      engineServers,
      probe,
    });
    expect(probe, "an empty room probes nothing, so it spawns nothing").not.toHaveBeenCalled();
    expect(Object.keys(handle.mcpServerConfigs), "engine entries only").toEqual([ENGINE_MCP_SERVER]);
    expect(handle.state).toBe("PLAYING");
    await handle.teardown();
    expect(handle.tornDown()).toBe(true);
    expect(existsSync(handle.configPath), "teardown removes the per-gig config").toBe(false);
  });

  // The declared server reaches the spawn, the engine's own is ADDITIVE on top, and the credential
  // resolver is called with exactly the names the contract listed — never with the whole surface,
  // and never with names the contract did not ask for.
  it("writes the declared server plus engine entries, resolving the declared credentials", async () => {
    const { realizeVenue } = await realizer();
    expect(realizeVenue, "the import is the specification").toBeTypeOf("function");
    const resolve = vi.fn(async () => ({ "notes-token": "placeholder" }));
    const handle = await realizeVenue(NOTES_ROOM, resolve, {
      gigId: "22222222-2222-2222-2222-222222222222",
      engineServers,
      probe: async () => ["search", "read"],
    });
    expect(Object.keys(handle.mcpServerConfigs).sort()).toEqual([ENGINE_MCP_SERVER, "notes"].sort());
    expect(resolve).toHaveBeenCalledWith(["notes-token"]);
    // The file the spawn is actually pointed at says the same thing the handle does. Two statements
    // of one fact that can disagree is the whole subject of Gap 3, one layer down.
    const onDisk = JSON.parse(readFileSync(handle.configPath, "utf8")) as { mcpServers: Record<string, unknown> };
    expect(onDisk.mcpServers).toEqual(handle.mcpServerConfigs);
    await handle.teardown();
  });

  // THE SECURITY LAW. Deny-by-default: the ambient `.mcp.json` is NEVER merged into the per-gig
  // config. This is the property, not a consequence of however the implementation turns out — if
  // the config is ever built by merging maps, the merge DIRECTION is the entire security posture,
  // and src/run_deps.ts:19-25 already explains what is at stake: a drain's cwd is a freshly cloned,
  // untrusted repository, and a clone that can declare MCP servers for the seat reading it
  // reintroduces exactly what `--setting-sources user` was added to close.
  it("never merges an ambient .mcp.json, whether it introduces a server or overrides one", async () => {
    const clone = mkdtempSync(join(tmpdir(), "coltrane-clone-"));
    writeFileSync(
      join(clone, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          notes: { command: "notes-mcp", args: ["--from-the-clone"] },
          rogue: { command: "rogue-mcp", args: ["--introduced-by-the-clone"] },
        },
      }),
    );
    // The fixture must be real or the law is vacuous: this is the exact shape readMcpServerConfigs
    // (src/server.ts:3170) honours on the local path, and must not on this one.
    const declared = JSON.parse(readFileSync(join(clone, ".mcp.json"), "utf8")) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(declared.mcpServers).sort()).toEqual(["notes", "rogue"]);

    const saved = process.env["COLTRANE_GENOME"];
    process.env["COLTRANE_GENOME"] = clone;
    try {
      const { realizeVenue } = await realizer();
      expect(realizeVenue, "the import is the specification").toBeTypeOf("function");
      const handle = await realizeVenue(NOTES_ROOM, noCredentials, {
        gigId: "33333333-3333-3333-3333-333333333333",
        engineServers,
        probe: async () => ["search", "read"],
      });
      expect(handle.mcpServerConfigs["rogue"], "a clone must not INTRODUCE a server").toBeUndefined();
      expect(
        JSON.stringify(handle.mcpServerConfigs),
        "and must not OVERRIDE one — a clone that can repoint an approved name has command execution under it",
      ).not.toContain("from-the-clone");
      await handle.teardown();
    } finally {
      if (saved === undefined) delete process.env["COLTRANE_GENOME"]; else process.env["COLTRANE_GENOME"] = saved;
    }
  });

  // THE DRIFT GUARD, in its observable form: the map preflight resolves against IS the realized
  // map. `resolveAgentGrants` (src/tool_providers.ts:138) exists one layer down for exactly this
  // reason — a preflight resolving against a different environment than the chair actually gets
  // either refuses a runnable gig or waves a doomed one through.
  it("the realized map is what fails a grant closed — and it holds nothing the venue did not declare", async () => {
    const { realizeVenue } = await realizer();
    expect(realizeVenue, "the import is the specification").toBeTypeOf("function");
    const handle = await realizeVenue(NOTES_ROOM, noCredentials, {
      gigId: "44444444-4444-4444-4444-444444444444",
      engineServers,
      probe: async () => ["search", "read"],
    });
    const registry: ToolProviderRegistry = new Map<string, ToolProvider>();
    // A declared server's grant resolves against the realized map…
    expect(() =>
      assertToolGrantsResolvable("scout", ["mcp__notes__search"], registry, handle.mcpServerConfigs),
    ).not.toThrow();
    // …and a server the venue did not declare is still a dead name. Widening the source must never
    // widen what counts as resolvable.
    expect(() =>
      assertToolGrantsResolvable("scout", ["mcp__rogue__exfiltrate"], registry, handle.mcpServerConfigs),
    ).toThrow(/mcp__rogue__exfiltrate|no provider/i);
    // The handle hands back the SAME object each time, so preflight and spawn cannot be configured
    // from two copies that agree today.
    expect(handle.mcpServerConfigs).toBe(handle.mcpServerConfigs);
    await handle.teardown();
  });
});

describe("GAP 2 — the probe verifies the room in both directions, before anything spawns", () => {
  // Direction one: a granted tool the server does not actually advertise. Without this, "granted
  // but unprovided" is merely moved from the ambient map to the declaration — still discovered at
  // use, just later in the file.
  it("a granted tool the server does not advertise fails realization, naming grant and server", async () => {
    const { realizeVenue, VenueRealizationError } = await realizer();
    expect(realizeVenue, "the import is the specification").toBeTypeOf("function");
    expect(VenueRealizationError, "the import is the specification").toBeTypeOf("function");
    let caught: unknown;
    try {
      await realizeVenue(NOTES_ROOM, noCredentials, {
        gigId: "55555555-5555-5555-5555-555555555555",
        engineServers,
        probe: async () => ["search"], // `read` is granted and absent
      });
    } catch (e) { caught = e; }
    expect(caught, "a room that cannot supply what it grants must not reach PLAYING").toBeInstanceOf(
      VenueRealizationError,
    );
    const err = caught as Error & { state?: string; missingGrant?: string; serverSlug?: string };
    expect(err.state, "the failure names the state it failed in").toBe("VERIFIED");
    expect(err.missingGrant).toContain("read");
    expect(err.serverSlug).toBe("notes");
  });

  // Direction two, and the one a naive implementation omits: the server advertises MORE than the
  // room declared. A ceiling that the thing beneath it can quietly exceed is not a ceiling, and R10
  // spent its whole existence enforcing that intersection at compose time.
  it("a server wider than the contract is a violation, not a bonus", async () => {
    const { realizeVenue, VenueContractViolation } = await realizer();
    expect(realizeVenue, "the import is the specification").toBeTypeOf("function");
    expect(VenueContractViolation, "the import is the specification").toBeTypeOf("function");
    let caught: unknown;
    try {
      await realizeVenue(NOTES_ROOM, noCredentials, {
        gigId: "66666666-6666-6666-6666-666666666666",
        engineServers,
        probe: async () => ["search", "read", "delete_everything"],
      });
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(VenueContractViolation);
    const err = caught as Error & { state?: string; extraTool?: string; serverSlug?: string };
    expect(err.state).toBe("VERIFIED");
    expect(err.extraTool).toContain("delete_everything");
    expect(err.serverSlug).toBe("notes");
  });
});

describe("GAP 2 — a chair reaches a tool inside the containerized room", () => {
  // The gig whose first eight characters name the room container, per docker compose's default
  // {projectName}-{serviceName}-1 convention: projectName is coltrane-gig-<gigId8>, the service is
  // the fixed 'room'.
  const CONTAINERIZED_GIG = "aaaaaaaa-1111-2222-3333-444444444444";
  const ROOM_CONTAINER = `coltrane-gig-${CONTAINERIZED_GIG.slice(0, 8)}-room-1`;

  // THE CHANNEL INTO THE ROOM. On the containerized realizer a declared stdio server no longer
  // resolves to its bare host command — it resolves to `docker exec` over stdio into the held room,
  // the exact shape proven by measurement against a --network none container. Nothing is published,
  // nothing is on the network; the chair reaches the tool through the runtime it already holds.
  it("the containerized realizer emits the docker-exec stdio shape for a declared server", async () => {
    const { dockerComposeRealizer } = await containerModule();
    expect(dockerComposeRealizer, "the import is the specification").toBeTypeOf("function");
    const handle = await dockerComposeRealizer(NO_DAEMON).realize(NOTES_ROOM, noCredentials, {
      gigId: CONTAINERIZED_GIG,
      engineServers,
      probe: async () => ["search", "read"],
    });
    expect(handle.mcpServerConfigs["notes"]).toEqual({
      command: "docker",
      // ABSOLUTE. The room service's working_dir is the workspace, so a relative entry path
      // resolves under the mount and node cannot find it — measured against a live room, not read.
      args: ["exec", "-i", "-e", "COLTRANE_SERVER_DIRECT=1", ROOM_CONTAINER, "node", "/app/dist/src/server_entry.js"],
    });
    await handle.teardown();
  });

  // ★ THE SILENT-RELAY GUARD. Without COLTRANE_SERVER_DIRECT=1, dist/src/server_entry.js runs in
  // relay mode — it spawns a child and holds the pipe — and the failure is SILENCE: no output, no
  // error, no exit. It cost a debugging cycle to find. Every containerized emission must carry the
  // flag, so this law holds the presence of the exact string on the path that would otherwise hang.
  it("every containerized emission carries COLTRANE_SERVER_DIRECT=1", async () => {
    const { dockerComposeRealizer } = await containerModule();
    expect(dockerComposeRealizer, "the import is the specification").toBeTypeOf("function");
    const handle = await dockerComposeRealizer(NO_DAEMON).realize(NOTES_ROOM, noCredentials, {
      gigId: CONTAINERIZED_GIG,
      engineServers,
      probe: async () => ["search", "read"],
    });
    const notes = handle.mcpServerConfigs["notes"] as { args?: readonly string[] };
    expect(notes.args ?? [], "omitting the flag selects relay mode, whose failure is silence").toContain(
      "COLTRANE_SERVER_DIRECT=1",
    );
    await handle.teardown();
  });

  // THE ROOM HOLDS. A room service with no command starts, finds nothing to do, and exits — leaving
  // nothing to `docker exec` into. `sleep infinity` keeps the container up for the lifetime of the
  // compose project so the channel above has something live to reach.
  it("the rendered room service runs a holding command", async () => {
    const { renderComposeConfig } = await containerModule();
    expect(renderComposeConfig, "the import is the specification").toBeTypeOf("function");
    const doc = renderComposeConfig(VenueSchema.parse(NOTES_ROOM), {
      gigId: CONTAINERIZED_GIG,
      realizationDir: `/realizations/gig-${CONTAINERIZED_GIG.slice(0, 8)}`,
    });
    const services = doc["services"] as Record<string, { command?: unknown }>;
    expect(services["room"], "the compose document has a room service").toBeDefined();
    expect(services["room"]!.command, "a room with no command exits, and nothing can exec into it").toEqual([
      "sleep",
      "infinity",
    ]);
  });
});
