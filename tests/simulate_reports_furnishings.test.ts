// SIMULATION REPORTS A ROOM'S FURNISHINGS — the grants are read before anything is queued.
// (spec: wiki spec.one-write-path.a-room-furnishes-its-reach; founder's ruling R38, 3 Oct 2026:
// "part of simulation should be to test the grants of those repos … furnish and tear down need to be
// cheap otherwise we'll catch gigs halfway after queue.")
//
//   S1  standard_simulate with `venue` names the room's furnishings: its connectors, the github grant
//       (normalized repositories + permission), its mcp servers and equipment
//   S2  without `venue` the report carries no furnishings (byte-identical to before)
//   S3  an unknown venue is refused by name — a gig dispatched there would be refused too, and
//       simulation says so first
//   S4  a room with no github connector reports furnishings without a github grant, never an empty one
import { describe, it, expect } from "vitest";
import { dispatchTool, type ServerDeps } from "../src/server.js";
import { createRegistry } from "../src/registry.js";
import { createOutputStore } from "../src/outputs.js";
import { MemoryLedger } from "../src/ledger.js";
import { composeStandard, type PhaseDef } from "../src/composition.js";
import { VenueSchema } from "../src/genome_schema.js";
import { testAgent } from "./_support/agents.js";
import type { DomainType } from "../src/registry.js";

const note: DomainType = { slug: "furn-note", extends: "Signal", domain: "demo", schema: { properties: { t: { type: "string" } } }, required_fields: ["t"] };
const reader = testAgent({ slug: "furn-reader", primitives: ["SENSE"], input_types: [], output_types: ["furn-note"], domain: "demo" });
const phases: PhaseDef[] = [{ name: "read", chairs: [{ role: "read", agent_slug: "furn-reader", depends_on: [], input_contract: [], output_contract: ["furn-note"], required_skills: [] }] }];

const roomDef = (extra: Record<string, unknown>) => VenueSchema.parse({
  slug: "lineage-reading",
  institution_slug: "eir-labs",
  responsible_chair: "eir-labs.chair.root",
  doors: { ingress: [], egress: ["github.com"] },
  credential_surface: [],
  equipment: { tools: ["Read", "Glob", "Grep"] },
  mcp_servers: [],
  lifecycle: { policy: "ephemeral", rebuild_cadence: "per-gig" },
  ...extra,
});

function bench(room?: ReturnType<typeof roomDef>) {
  const registry = createRegistry();
  registry.registerType(note);
  const std = composeStandard({ slug: "furn-std", domain: "demo", agents: [reader], phases });
  const deps: ServerDeps = {
    registry, outputs: createOutputStore(registry), ledger: new MemoryLedger(),
    standards: new Map([[std.slug, std]]),
    ...(room ? { venues: new Map([[room.slug, room]]) } : {}),
  };
  return deps;
}

const FOUR = ["https://github.com/eir-labs/coltrane", "https://github.com/eir-labs/coltrane-ui", "https://github.com/eir-labs/chancery", "https://github.com/eir-labs/coltrane-conformance"];

describe("simulation reports a room's furnishings", () => {
  it("S1 with `venue`, the report names the room's connectors, github grant, servers and equipment", async () => {
    const deps = bench(roomDef({ connectors: [{ kind: "github", grant: { repositories: [...FOUR.slice(0, 3), FOUR[3] + ".git"] } }] }));
    const r = await dispatchTool("standard_simulate", { standard_slug: "furn-std", mock_input: {}, depth: "standard", venue: "lineage-reading" }, deps);
    expect(r.ok, r.error).toBe(true);
    const f = (r.data as { furnishings?: Record<string, unknown> }).furnishings;
    expect(f, "no furnishings reported for a named room").toBeDefined();
    expect(f!["venue"]).toBe("lineage-reading");
    expect(f!["connectors"]).toEqual([{ kind: "github", slug: "github" }]);
    expect(f!["github"], "the github grant is reported normalized, with its permission").toEqual({ repositories: FOUR, permissions: "contents:read" });
    expect(f!["equipment"]).toEqual(["Read", "Glob", "Grep"]);
    expect(f!["mcp_servers"]).toEqual([]);
  });

  it("S2 without `venue` the report carries no furnishings", async () => {
    const deps = bench(roomDef({}));
    const r = await dispatchTool("standard_simulate", { standard_slug: "furn-std", mock_input: {}, depth: "standard" }, deps);
    expect(r.ok, r.error).toBe(true);
    expect((r.data as Record<string, unknown>)["furnishings"]).toBeUndefined();
  });

  it("S3 an unknown venue is refused by name, before anything would be queued", async () => {
    const deps = bench(roomDef({}));
    const r = await dispatchTool("standard_simulate", { standard_slug: "furn-std", mock_input: {}, depth: "standard", venue: "no-such-room" }, deps);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unknown venue "no-such-room"/);
  });

  it("S4 a room with no github connector reports furnishings without a github grant", async () => {
    const deps = bench(roomDef({}));
    const r = await dispatchTool("standard_simulate", { standard_slug: "furn-std", mock_input: {}, depth: "standard", venue: "lineage-reading" }, deps);
    expect(r.ok, r.error).toBe(true);
    const f = (r.data as { furnishings?: Record<string, unknown> }).furnishings!;
    expect(f["connectors"]).toEqual([]);
    expect("github" in f, "no connector → no github key, never an empty grant").toBe(false);
  });
});
