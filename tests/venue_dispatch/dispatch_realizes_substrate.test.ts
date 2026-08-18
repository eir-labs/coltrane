// The SUBSTRATE half of the venue → dispatch wire — RED until runGig realizes the room, not just
// the policy.
//
// The policy layer (src/venue_realize.ts) CONFINES a venue-named gig — it intersects the tool
// ceiling and refuses a breach — but stands up no room. The container substrate
// (src/venue_realizer.ts) writes the compose document, runs `docker compose up -d`, and serves
// coltrane's own MCP over `docker exec` into the room — but until this wire it was unreachable from
// dispatch: `dispatch_calls_realize.test.ts` proves the POLICY reaches the ctx; nothing proved the
// ROOM reached the SPAWN.
//
// These two laws pin that missing half, DAEMON-FREE: they hand runGig a real `dockerComposeRealizer`
// whose `docker` binary is replaced by an injected no-op `run` seam (the seam exists precisely so
// the realizer's DECISIONS can be proven on a host with no daemon — every CI runner). The seam
// replaces the binary, not the realizer logic, so what these laws observe is the real realized
// transport, not a stand-in.
//
//   Law A — the ROOM reaches the SPAWN. The AgentInvocationContext actually handed to invoke carries
//           an MCP server config whose command is `docker` and whose args `exec` into the realized
//           room container — proving the substrate reached the chair, not merely the policy layer.
//   Law B — BOTH layers tear down. After the gig ends, the substrate handle reports tornDown()===true
//           AND the policy realization reports tornDown()===true.
//
// The container name is derived through the SAME `roomContainerName` the realizer emits from (not
// recomputed by hand), so the law cannot pass against a container the realizer would never name.
import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEST_BEHAVIOR } from "../_support/agents.js";
import {
  runGig,
  createRegistry,
  createOutputStore,
  MemoryLedger,
  type AgentInvoker,
  type AgentInvocationContext,
  type DomainType,
  type Standard,
  type Agent,
} from "../../src";
import type { Venue } from "../../src/chart.js";
import type { Realization } from "../../src/venue_realize.js";
import {
  dockerComposeRealizer,
  roomContainerName,
  type VenueRealizer,
  type RealizationHandle,
  type ComposeRunner,
} from "../../src/venue_realizer.js";
import { VenueSchema } from "../../src/genome_schema.js";

const note: DomainType = {
  slug: "note", extends: "Signal", domain: "demo",
  schema: { properties: { text: { type: "string" } } }, required_fields: ["text"],
};

function setup() {
  const registry = createRegistry();
  registry.registerType(note);
  const outputs = createOutputStore(registry);
  const ledger = new MemoryLedger();
  return { outputs, ledger };
}

// A one-chair standard whose sole agent grants `grants` — enough for the policy ceiling to pass.
function oneChair(grants: string[]): Standard {
  const scout: Agent = {
    ...TEST_BEHAVIOR, slug: "scout", primitives: ["SENSE"], input_types: [], output_types: ["note"],
    domain: "demo", allowed_tools: grants,
  } as Agent;
  return {
    slug: "sense-only", domain: "demo", agents: [scout],
    phases: [{ name: "sense", chairs: [{ role: "sense", agent_slug: "scout", depends_on: [], input_contract: [], output_contract: ["note"], required_skills: [] }] }],
  };
}

// A VALID venue (parsed through VenueSchema, since the substrate realizer re-parses it) that DECLARES
// one stdio mcp_server — the trigger for substrate realization. equipment carries no `mcp__` tool, so
// the schema's granted-server cross-field rule is satisfied vacuously; the server needs a command
// (stdio) and no credentials (empty ⊆ surface).
function roomVenue(): Venue {
  return VenueSchema.parse({
    slug: "studio",
    institution_slug: "quartet",
    equipment: { tools: ["Read", "Bash"] },
    mcp_servers: [{ slug: "room-notes", transport: "stdio", command: ["node", "notes-server.js"] }],
    lifecycle: { policy: "ephemeral" },
  }) as unknown as Venue;
}

// A call-counting invoker that captures the ctx it was handed (to read ctx.substrateMcpConfigs).
function capturingInvoke(): { invoke: AgentInvoker; ctx: () => AgentInvocationContext | undefined } {
  let last: AgentInvocationContext | undefined;
  const invoke: AgentInvoker = (ctx) => { last = ctx; return { text: "a note", source: "test" }; };
  return { invoke, ctx: () => last };
}

// A real dockerComposeRealizer with the docker binary replaced by a no-op seam (daemon-free), wrapped
// so the test can also hold the RealizationHandle it returns — needed to observe substrate tornDown().
function capturingRealizer(): { venueRealizer: VenueRealizer; handle: () => RealizationHandle | undefined } {
  const run: ComposeRunner = () => {}; // no daemon: the seam replaces the binary, not the logic
  const base = dockerComposeRealizer({ run });
  let handle: RealizationHandle | undefined;
  const venueRealizer: VenueRealizer = {
    ...base,
    realize: async (v, cr, o) => (handle = await base.realize(v, cr, o)),
  };
  return { venueRealizer, handle: () => handle };
}

describe("dispatch realizes the SUBSTRATE, threads it to the spawn, and tears BOTH layers down", () => {
  it("Law A — the realized room reaches the SPAWN: ctx carries a docker-exec transport for the room", async () => {
    const { outputs, ledger } = setup();
    const cap = capturingInvoke();
    const { venueRealizer } = capturingRealizer();
    const gigId = "e5879346-e056-4a9a-a738-00000000000a";

    const res = await runGig(oneChair(["Read"]), {}, {
      outputs, ledger, invoke: cap.invoke,
      venue: "studio", venues: new Map([["studio", roomVenue()]]),
      venueRealizer, gig_id: gigId,
    });
    expect(res.status).toBe("complete");

    // The ctx the invoker actually saw must carry the substrate transports — the room, not the policy.
    const ctx = cap.ctx();
    expect(ctx, "the chair ctx must be captured").toBeDefined();
    const sub = ctx!.substrateMcpConfigs as Record<string, { command: string; args: string[] }> | undefined;
    expect(sub, "ctx must carry substrateMcpConfigs once the room was stood up").toBeDefined();

    const cfg = sub!["room-notes"];
    expect(cfg, "the realized transport for the declared server must be present").toBeDefined();
    // The proof it reached the SPAWN as a room transport: command `docker`, args `exec` into the
    // container the realizer itself names (derived through roomContainerName, never recomputed).
    expect(cfg!.command).toBe("docker");
    expect(cfg!.args).toContain("exec");
    const realizationDir = join(tmpdir(), "coltrane-realizations", `gig-${gigId.slice(0, 8)}`);
    expect(cfg!.args).toContain(roomContainerName(realizationDir));
  });

  it("Law B — the gig ends: BOTH the substrate handle AND the policy realization report tornDown()", async () => {
    const { outputs, ledger } = setup();
    const cap = capturingInvoke();
    const { venueRealizer, handle } = capturingRealizer();

    await runGig(oneChair(["Read"]), {}, {
      outputs, ledger, invoke: cap.invoke,
      venue: "studio", venues: new Map([["studio", roomVenue()]]),
      venueRealizer, gig_id: "e5879346-e056-4a9a-a738-00000000000b",
    });

    // The substrate half: the room handle was created and torn down at gig end.
    const substrate = handle();
    expect(substrate, "the substrate handle must have been created").toBeDefined();
    expect(substrate!.tornDown(), "the room must be torn down when the gig ends").toBe(true);

    // The policy half: the realization threaded onto the ctx is also torn down (as before this wire).
    const realization = (cap.ctx() as unknown as { realization?: Realization }).realization;
    expect(realization, "ctx must carry the policy realization").toBeDefined();
    expect(realization!.tornDown(), "the policy layer must be torn down too").toBe(true);
  });
});
