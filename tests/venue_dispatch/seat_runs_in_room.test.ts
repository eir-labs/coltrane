// THE SEAT RUNS INSIDE THE ROOM — the invoker relocation, and the room still narrows it.
//
// These pin the two properties that DO NOT need a live daemon (the concurrency/reclamation proof is
// live and lives in tests/spec_venue_room_live.test.ts):
//
//  1. When the chair's ctx carries `seatExec` (the substrate stood up a SEAT-BEARING floor room),
//     the constructed spawn is `docker exec -i -w <workspace> <container> claude …` — the seat runs
//     INSIDE the room with the workspace as cwd, not on the host.
//  2. Moving the seat MUST NOT WIDEN it. A tool the agent grants but the venue's equipment does not
//     permit is absent from `--allowedTools` in BOTH the host arm and the in-room arm — the wrap
//     runs AFTER the confinement block, so the room's `agent.allowed_tools ∩ venue.equipment.tools`
//     ceiling is computed before the spawn is relocated and is byte-identical either way.
//
// The child-env seam captures the constructed (bin, args) without spawning a real process — the same
// injected-run seam the sibling property test uses.
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { venueEffectiveTools, type Venue } from "../../src/chart.js";
import { realize, type Realization } from "../../src/venue_realize.js";
import { makeClaudeInvoker } from "../../src/claude_invoker.js";
import { renderComposeConfig } from "../../src/venue_realizer.js";
import { VenueSchema } from "../../src/genome_schema.js";
import { testAgent } from "../_support/agents.js";
import type { Agent } from "../../src/composition.js";
import type { AgentInvocationContext } from "../../src/runtime.js";

const base = (g: string): string => g.split("(")[0]!;

const room = (tools: string[]): Venue =>
  ({ slug: "seat-room", institution_slug: "quartet", equipment: { tools },
     doors: { ingress: [], egress: [] }, installs: [], credential_surface: [],
     lifecycle: { policy: "ephemeral" } } as unknown as Venue);

const WORKSPACE = "/tmp/coltrane-realizations/gig-abcd1234/workspace";
const CONTAINER = "coltrane-gig-abcd1234-room-1";

/** Drive the invoker and capture the constructed (bin, args, env). `seatExec` present → the in-room
 *  arm; absent → the host arm. Neither spawns a real process (the `run` seam short-circuits). */
async function driveSpawn(
  agent: Agent,
  venue: Venue,
  seatExec?: { container: string; workspace: string },
): Promise<{ bin: string; args: string[]; allowedTools: string[] | undefined }> {
  let sawBin = "";
  let sawArgs: string[] = [];
  const invoke = makeClaudeInvoker({
    run: (bin, args) => {
      sawBin = bin;
      sawArgs = args;
      return '{"text":"ok"}';
    },
  });
  const realization: Realization = realize(venue, { seats: [{ agent }], ambientEnv: {}, gigId: "g1" });
  const ctx = {
    agent, gig_input: {}, inputs: [], realization, venue,
    ...(seatExec ? { seatExec } : {}),
  } as unknown as AgentInvocationContext;
  await invoke(ctx);
  const i = sawArgs.indexOf("--allowedTools");
  const allowedTools = i === -1 ? undefined : (sawArgs[i + 1]?.split(",") ?? []);
  return { bin: sawBin, args: sawArgs, allowedTools };
}

describe("the seat runs inside the room — the invoker relocation", () => {
  it("with seatExec, the spawn is `docker exec -i -w <workspace> <container> claude …`", async () => {
    // The whole change: a seat that used to run on the host now runs inside the room, cwd = the
    // room's per-realization workspace. Pre-change the invoker ignored any seat descriptor and
    // spawned `claude` directly on the host with no cwd — so this FAILS against current code.
    const agent = testAgent({ slug: "p", primitives: ["SENSE"], allowed_tools: ["Read"] });
    const { bin, args } = await driveSpawn(agent, room(["Read"]), { container: CONTAINER, workspace: WORKSPACE });
    expect(bin, "the leaf spawn is wrapped as a docker exec").toBe("docker");
    expect(args.slice(0, 6), "exec -i -w <workspace> <container> claude — the seat's cwd IS the room's workspace").toEqual(
      ["exec", "-i", "-w", WORKSPACE, CONTAINER, "claude"],
    );
    // Everything the invoker built for the leaf `claude` follows the container name, unchanged.
    expect(args.includes("--allowedTools"), "the invoker's own args ride after the leaf binary").toBe(true);
  });

  it("without seatExec, the spawn stays on the host (unchanged) — the wire is additive", async () => {
    // The paired regression guard: a room with no seat-bearing floor keeps the chair on the host. A
    // wire that relocated every seat would turn this RED.
    const agent = testAgent({ slug: "p", primitives: ["SENSE"], allowed_tools: ["Read"] });
    const { bin, args } = await driveSpawn(agent, room(["Read"]));
    expect(bin, "no seatExec → the leaf binary spawns directly").toBe("claude");
    expect(args.includes("exec"), "no docker-exec wrapper without a seat-bearing room").toBe(false);
  });

  it("IN ROOM, --mcp-config carries the config's JSON, never a host path the container cannot see (29 Oct, gig 3ba295b5)", async () => {
    // The red pass's draft chair ran inside the drafting room and exited 1: "MCP config file not found: /var/folders/…/coltrane-mcp-….json".
    // The invoker writes the config to the HOST's tmpdir and passes its path; a seat spawned by docker exec reads the container's
    // filesystem, where that path is not. The claude CLI takes --mcp-config as a file OR a JSON string, so the in-room arm passes the JSON.
    const agent = testAgent({ slug: "p", primitives: ["SENSE"], allowed_tools: ["Read"] });
    const { args } = await driveSpawn(agent, room(["Read"]), { container: CONTAINER, workspace: WORKSPACE });
    const i = args.indexOf("--mcp-config");
    expect(i, "the in-room spawn passes an MCP config").toBeGreaterThan(-1);
    const v = args[i + 1]!;
    expect(v.startsWith("/") || v.includes("coltrane-mcp-"), `a host path rode into the room: ${v}`).toBe(false);
    expect(() => JSON.parse(v), "the in-room --mcp-config is the config's JSON").not.toThrow();
    expect(JSON.parse(v)).toHaveProperty("mcpServers");
  });

  it("ON THE HOST, --mcp-config still names the written file (unchanged)", async () => {
    const agent = testAgent({ slug: "p", primitives: ["SENSE"], allowed_tools: ["Read"] });
    const { args } = await driveSpawn(agent, room(["Read"]));
    const v = args[args.indexOf("--mcp-config") + 1]!;
    expect(v.includes("coltrane-mcp-") && v.endsWith(".json"), `the host spawn lost its config file: ${v}`).toBe(true);
  });

  it("IN ROOM, the seat's ENGINE server is the room's own engine, at a run genome copied into the room; no host env rides (gig 9fbcfa3c, 29 Oct)", async () => {
    // The drafter ran inside the drafting room and reached its model, then "sealed no output through its write boundary": the engine MCP
    // server entry named the HOST's node and dist path and a host tmp run genome, none of which exist in the container, so output_write
    // never reached the seat. In the room, the entry is the floor's own engine at /app, with COLTRANE_GENOME at the run genome copied in.
    const agent = testAgent({ slug: "p", primitives: ["SENSE"], allowed_tools: ["Read"] });
    const copies: string[][] = [];
    let sawArgs: string[] = [];
    const invoke = makeClaudeInvoker({
      run: (_bin: string, args: string[]) => { sawArgs = args; return '{"text":"ok"}'; },
      sealVia: "output_write",
      engineServer: { command: "/usr/local/bin/node", args: ["/host/coltrane/dist/src/server_entry.js"], env: { COLTRANE_GENOME: "/var/folders/xx/T/coltrane-run-genome-abc123", COLTRANE_SERVER_DIRECT: "1", HOST_ONLY_VALUE: "must-not-ride" } },
      roomCopy: (src: string, container: string, dest: string) => { copies.push([src, container, dest]); },
    } as never);
    const realization = realize(room(["Read"]), { seats: [{ agent }], ambientEnv: {}, gigId: "g1" });
    await (invoke as unknown as (c: unknown) => Promise<unknown>)({ agent, gig_input: {}, inputs: [], realization, venue: room(["Read"]), seatExec: { container: CONTAINER, workspace: WORKSPACE } }).catch(() => undefined);
    const cfg = JSON.parse(sawArgs[sawArgs.indexOf("--mcp-config") + 1]!);
    const eng = cfg.mcpServers.coltrane;
    expect(eng.command).toBe("node");
    expect(eng.args).toEqual(["/app/dist/src/server_entry.js"]);
    expect(eng.env.COLTRANE_GENOME).toBe("/tmp/coltrane-run-genome-abc123");
    expect(eng.env.COLTRANE_SERVER_DIRECT).toBe("1");
    expect(JSON.stringify(eng)).not.toContain("must-not-ride");
    expect(JSON.stringify(eng)).not.toContain("/host/");
    expect(copies).toEqual([["/var/folders/xx/T/coltrane-run-genome-abc123", CONTAINER, "/tmp"]]);
  });

  it("ON THE HOST, the engine server entry is unchanged and nothing is copied", async () => {
    const agent = testAgent({ slug: "p", primitives: ["SENSE"], allowed_tools: ["Read"] });
    const copies: string[][] = [];
    let sawArgs: string[] = [];
    const host = { command: "/usr/local/bin/node", args: ["/host/coltrane/dist/src/server_entry.js"], env: { COLTRANE_GENOME: "/var/folders/xx/T/coltrane-run-genome-abc123" } };
    let cfgText = "";
    const invoke = makeClaudeInvoker({ run: (_b: string, args: string[]) => { sawArgs = args; cfgText = readFileSync(args[args.indexOf("--mcp-config") + 1]!, "utf-8"); return '{"text":"ok"}'; }, sealVia: "output_write", engineServer: host, roomCopy: (s: string, c: string, d: string) => { copies.push([s, c, d]); } } as never);
    const realization = realize(room(["Read"]), { seats: [{ agent }], ambientEnv: {}, gigId: "g1" });
    await (invoke as unknown as (c: unknown) => Promise<unknown>)({ agent, gig_input: {}, inputs: [], realization, venue: room(["Read"]) }).catch(() => undefined);
    expect(sawArgs.includes("--mcp-config")).toBe(true);
    const cfg = JSON.parse(cfgText);
    expect(cfg.mcpServers.coltrane.args).toEqual(host.args);
    expect(copies).toEqual([]);
  }, 30_000);

  it("moving the seat does NOT widen it — a granted-but-unequipped tool is absent in BOTH arms", async () => {
    // THE LAW THAT MATTERS for relocation safety. Agent grants Read+Bash; the room equips only Read.
    // The ceiling is agent.allowed_tools ∩ venue.equipment.tools, computed BEFORE the spawn is
    // relocated — so the in-room arm advertises exactly what the host arm does, and Bash (granted,
    // unequipped) appears in neither. If the wrap ever moved ahead of the confinement block, the
    // in-room arm would widen; asserting equality across arms is what catches that.
    const agent = testAgent({ slug: "p", primitives: ["SENSE"], allowed_tools: ["Read", "Bash"] });
    const venue = room(["Read"]); // equips Read, NOT Bash
    const oracle = new Set(venueEffectiveTools(agent, venue).map(base));

    const host = await driveSpawn(agent, venue);
    const inRoom = await driveSpawn(agent, venue, { container: CONTAINER, workspace: WORKSPACE });

    const hostAdvertised = new Set((host.allowedTools ?? []).map(base));
    const roomAdvertised = new Set((inRoom.allowedTools ?? []).map(base));

    expect(hostAdvertised, "host arm advertises the intersected ceiling").toEqual(oracle);
    expect(roomAdvertised, "the in-room arm advertises the SAME ceiling — relocation did not widen it").toEqual(oracle);
    expect(roomAdvertised.has("Bash"), "a granted-but-unequipped tool is absent inside the room too").toBe(false);
    expect(roomAdvertised.has("Read"), "the equipped tool survives inside the room").toBe(true);
  });
});

describe("a seat-bearing floor keeps the room's posture — moving the seat widens nothing", () => {
  // A floored venue renders the SAME locked-down posture as an unfloored room: only the image string
  // changes (coltrane/floor:<floor> vs coltrane/room:ephemeral). This proves the seat-bearing path
  // did not relax the render-layer guards the posture suite already pins.
  const FLOORED = {
    slug: "seat-room-v1",
    institution_slug: "quartet",
    substrate: "container",
    floor: "seat",
    equipment: { tools: ["mcp__notes__search"] },
    credential_surface: ["notes-token"],
    mcp_servers: [
      { slug: "notes", transport: "stdio" as const, command: ["node", "/app/dist/src/server_entry.js"], credential_names: ["notes-token"] },
    ],
    // No egress door: these laws are about the floor's image and posture. The door this fixture once declared was never enforced (the
    // pre-egress room was blanket-internal); now egress doors are enforced by a proxy whose consumer is a seat on a floor pinned by
    // digest, and a tag floor with doors is refused by name (EP-9, the_room_reaches_only_its_doors).
    doors: { ingress: [], egress: [] },
    lifecycle: { policy: "ephemeral" as const },
  };
  const REALIZATION_DIR = "/realizations/gig-88888888";
  const GIG = "88888888-8888-8888-8888-888888888888";
  const render = (): string =>
    JSON.stringify(renderComposeConfig(VenueSchema.parse(FLOORED), { gigId: GIG, realizationDir: REALIZATION_DIR }));

  it("selects the seat-bearing floor image, not the production room image", () => {
    expect(render(), "a floor selects coltrane/floor:<floor>").toContain("coltrane/floor:seat");
    expect(render(), "…and not the production-only room image").not.toContain("coltrane/room:ephemeral");
  });

  it("no docker socket, not privileged, no cap_add, no host network — posture unchanged by the floor", () => {
    const doc = render();
    expect(doc, "a runtime socket inside the room is the end of the room").not.toMatch(/docker\.sock|containerd\.sock|podman\.sock|\/var\/run\/docker/i);
    expect(doc).not.toMatch(/"privileged"\s*:\s*true/i);
    expect(doc).not.toMatch(/"cap_add"/i);
    expect(doc).not.toMatch(/"network_mode"\s*:\s*"host"/i);
    expect(doc).not.toMatch(/"pid"\s*:\s*"host"/i);
    // The network stays internal — the room is egress-less; doors.egress is DECLARED, not enforced.
    expect(doc, "the room network stays internal").toMatch(/"internal"\s*:\s*true/);
  });

  it("no credential MATERIAL renders into the document — delivery is docker cp, never a host bind", () => {
    // The credential class name is the contract's own vocabulary and may appear (declared in
    // x-coltrane-room); the MATERIAL never does, and there is no top-level `secrets:` block that
    // would bind it from a host file for the room's whole life.
    const doc = render();
    expect(doc, "credential class names are declared").toContain("notes-token");
    expect(doc, "no host-bound compose secret block").not.toMatch(/"secrets"\s*:\s*\{/);
  });
});

describe("the seat's tree is the room's workspace (gig 726754eb, 29 Oct)", () => {
  // The in-room drafter SEALED its red-spec, and the seal refused tree_root_unknown: with the working tree deferred to room realization,
  // the drain named no tree_root, so `laws` could not be stamped from git. The room's workspace is a git checkout bind-mounted at the
  // SAME path on the host, so when no tree root was named and the room has a seat, the tree is that workspace.
  it("effectiveTreeRoot: a named tree wins; else the seat's workspace; else none", async () => {
    const { effectiveTreeRoot } = await import("../../src/runtime.js");
    expect(effectiveTreeRoot("/named", { container: "c", workspace: "/ws" })).toBe("/named");
    expect(effectiveTreeRoot(undefined, { container: "c", workspace: "/ws" })).toBe("/ws");
    expect(effectiveTreeRoot(undefined, undefined)).toBeUndefined();
  });
  it("REACHED: runGig applies it right after the substrate is realized", () => {
    const src = readFileSync(new URL("../../src/runtime.ts", import.meta.url), "utf-8");
    const at = src.indexOf("gigSubstrate = await deps.venueRealizer.realize(");
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 2500)).toMatch(/effectiveTreeRoot\(deps\.tree_root, gigSubstrate\.seat\)/);
  });
});
