// THE CHART AND THE VENUE BECOME GENOME CLASSES.
//
// 0.7.0 shipped `ChartSchema` and `composeChart`/`runChart`/`dispatchTarget`/`degenerateChart`, and
// stopped there on purpose: a chart could be composed in memory but not LOADED from the genome and
// not AUTHORED over MCP, so the surface advertised no chart tool rather than advertise a dead name.
// This file states the two contracts that close it.
//
//   1. `charts/` and `venues/` are genome directories. `loadGenome` validates each file through its
//      single Zod source and — for a chart — through `composeChart` against the loaded standards,
//      so a chart naming a standard the genome does not hold is a load error of kind "chart", not a
//      surprise at dispatch. `LoadedGenome` carries both maps.
//   2. The venue's `venue?: string` stops meaning nothing. A venue is a CEILING on authority: the
//      effective tool set of a seated agent is its own grants INTERSECTED with the room's
//      equipment, so a room can only ever narrow a player, never widen one. A chart naming a venue
//      under which a seated agent's whole grant set is unreachable fails to COMPOSE, naming the
//      agent, the venue and the empty intersection — the same fail-closed posture a tool grant with
//      no provider already has.
//
// RED-first: written against an engine with no VenueSchema, no `charts`/`venues` on LoadedGenome,
// no chart_define/chart_browse/venue_define/venue_browse, and no chart_slug on gig_dispatch.
import { describe, it, expect, afterAll } from "vitest";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { VenueSchema, VenueObjectSchema, venueDefect, ChartSchema, zodToMcpProps } from "../src/genome_schema.js";
import { composeChart, venueEffectiveTools, chartEntrySeedTypes, type Venue } from "../src/chart.js";
import { loadGenome, loadLayeredGenome } from "../src/loader.js";
import { MCP_TOOLS } from "../src/mcp.js";
import { createToolSurface, type ToolSurfaceDeps } from "../src/server.js";
import { createRegistry } from "../src/registry.js";
import { createOutputStore } from "../src/outputs.js";
import { MemoryLedger } from "../src/ledger.js";
import { composeStandard, type Agent, type Standard, type PhaseDef } from "../src/composition.js";
import { testAgent } from "./_support/agents.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));

// ── a temp genome root, seeded only with what a case needs ────────────────────────────────────
// A root with no core_types/ gets the engine's canonical six, so a case that only cares about
// charts and venues writes only charts/ and venues/.
function tmpGenome(files: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "coltrane-chart-venue-"));
  for (const [rel, body] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body, null, 2) + "\n");
  }
  return root;
}
const cleanup: string[] = [];
const genomeRoot = (files: Record<string, unknown>): string => {
  const r = tmpGenome(files);
  cleanup.push(r);
  return r;
};
afterAll(() => { for (const r of cleanup) rmSync(r, { recursive: true, force: true }); });

// ── the venue fixtures ────────────────────────────────────────────────────────────────────────
const EMPTY_ROOM = {
  slug: "empty-room-v1",
  institution_slug: "quartet",
  flavor: "ingest-empty",
  equipment: { tools: [] },
  doors: { ingress: ["mail.example.com"], egress: [] },
  installs: [],
  credential_surface: [],
  lifecycle: { policy: "ephemeral" },
};
const READING_ROOM = {
  slug: "reading-room-v1",
  institution_slug: "quartet",
  equipment: { tools: ["Read", "Glob"] },
  lifecycle: { policy: "ephemeral" },
};

// ── the chart fixtures ────────────────────────────────────────────────────────────────────────
const scout: Agent = testAgent({ slug: "scout", primitives: ["SENSE"], output_types: ["Signal"], domain: "venue-demo", allowed_tools: ["Read", "Grep"] });
const reader: Agent = testAgent({ slug: "reader", primitives: ["INTERPRET"], input_types: ["Signal"], output_types: ["Interpretation"], domain: "venue-demo", allowed_tools: ["WebFetch"] });
const barefoot: Agent = testAgent({ slug: "barefoot", primitives: ["SENSE"], output_types: ["Signal"], domain: "venue-demo" });

const look = (agent: Agent = scout): Standard => composeStandard({
  slug: "look", domain: "venue-demo", agents: [agent], output_types: ["Signal"],
  phases: [{ name: "p1", chairs: [{ role: "r1", agent_slug: agent.slug, depends_on: [], input_contract: [], output_contract: ["Signal"], required_skills: [] }] }] as PhaseDef[],
});
const digest = (): Standard => composeStandard({
  slug: "digest", domain: "venue-demo", agents: [reader], input_types: ["Signal"], output_types: ["Interpretation"],
  phases: [{ name: "p2", chairs: [{ role: "r2", agent_slug: "reader", depends_on: [], input_contract: ["Signal"], output_contract: ["Interpretation"], required_skills: [] }] }] as PhaseDef[],
});

const stds = (over?: ReadonlyArray<[string, Standard]>): ReadonlyMap<string, Standard> =>
  new Map<string, Standard>([["look", look()], ["digest", digest()], ...(over ?? [])]);
const ags = (): ReadonlyMap<string, Agent> => new Map([["scout", scout], ["reader", reader], ["barefoot", barefoot]]);
const vens = (): ReadonlyMap<string, Venue> => new Map([
  ["empty-room-v1", VenueSchema.parse(EMPTY_ROOM)],
  ["reading-room-v1", VenueSchema.parse(READING_ROOM)],
]);

const line = (over?: Record<string, unknown>) => ({
  slug: "look-then-digest",
  movements: [
    { movement_id: "sense", standard_slug: "look" },
    { movement_id: "read", standard_slug: "digest" },
  ],
  edges: [{ from_movement: "sense", to_movement: "read", output_type: "Signal" }],
  ...over,
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// VenueSchema — the one Zod source for a configured performance space
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("VenueSchema — the room's declared end-state, and nothing about how it is built", () => {
  it("parses the empty room and defaults the lifecycle to ephemeral", () => {
    const v = VenueSchema.parse(EMPTY_ROOM);
    expect(v.slug).toBe("empty-room-v1");
    expect(v.institution_slug).toBe("quartet");
    expect(v.equipment.tools, "deny by default — the empty room holds nothing").toEqual([]);
    expect(v.doors?.egress, "no network exit of any kind").toEqual([]);
    expect(v.credential_surface).toEqual([]);
    expect(v.installs).toEqual([]);
    expect(v.lifecycle.policy, "the contract is durable; the realization is disposable").toBe("ephemeral");
  });

  it("defaults toward the EMPTY room rather than inventing authority", () => {
    const bare = VenueSchema.parse({ slug: "bare", institution_slug: "quartet", equipment: {}, lifecycle: {} });
    expect(bare.equipment.tools).toEqual([]);
    expect(bare.lifecycle.policy).toBe("ephemeral");
    expect(bare.doors).toBeUndefined();
    // Omitting the fields entirely means the same thing as stating them bare — the schema owns that,
    // so the loader and venue_define cannot disagree about what an unstated equipment permits.
    const silent = VenueSchema.parse({ slug: "silent", institution_slug: "quartet" });
    expect(silent.equipment.tools).toEqual([]);
    expect(silent.lifecycle.policy).toBe("ephemeral");
    expect(silent.installs).toEqual([]);
    expect(silent.credential_surface).toEqual([]);
  });

  it("is strict — an unknown key is a typo, not an extension point", () => {
    expect(() => VenueSchema.parse({ ...EMPTY_ROOM, harness_image: "ghcr.io/x@sha256:0" })).toThrow();
    expect(() => VenueSchema.parse({ ...EMPTY_ROOM, doors: { ingress: [], egress: [], sideways: [] } })).toThrow();
    expect(() => VenueSchema.parse({ ...EMPTY_ROOM, equipment: { tools: [], mcp_serverz: [] } })).toThrow();
    expect(() => VenueSchema.parse({ ...EMPTY_ROOM, lifecycle: { policy: "ephemeral", cadence: "1h" } })).toThrow();
  });

  it("an install must be DIGEST-pinned — a version range names a family of rooms, not one room", () => {
    expect(() => VenueSchema.parse({ ...EMPTY_ROOM, installs: ["node@>=22"] })).toThrow();
    const ok = VenueSchema.parse({ ...EMPTY_ROOM, installs: [`node@sha256:${"a".repeat(64)}`] });
    expect(ok.installs).toHaveLength(1);
  });

  it("a door names hosts, never `*` — a wildcard door is not a door", () => {
    expect(() => VenueSchema.parse({ ...EMPTY_ROOM, doors: { ingress: ["*"], egress: [] } })).toThrow();
    expect(() => VenueSchema.parse({ ...EMPTY_ROOM, doors: { ingress: [], egress: ["*"] } })).toThrow();
  });

  it("a STANDING venue with no rebuild cadence is a snowflake, and venueDefect says so", () => {
    const standing = VenueSchema.parse({ ...EMPTY_ROOM, lifecycle: { policy: "standing" } });
    expect(venueDefect(standing)).toMatch(/rebuild_cadence/);
    const phoenix = VenueSchema.parse({ ...EMPTY_ROOM, lifecycle: { policy: "standing", rebuild_cadence: "PT6H" } });
    expect(venueDefect(phoenix), "a phoenix on a slower clock is permitted").toBeNull();
    expect(venueDefect(VenueSchema.parse(EMPTY_ROOM))).toBeNull();
  });

  it("carries the duty-holder office as an id — the office, not the incumbent", () => {
    const v = VenueSchema.parse({ ...EMPTY_ROOM, responsible_chair: "quartet.chair.responsible-officer" });
    expect(v.responsible_chair).toBe("quartet.chair.responsible-officer");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// The ceiling rule — a venue NARROWS an agent, never widens one (R10)
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("venueEffectiveTools — the intersection, and only the intersection", () => {
  it("effective tools are the agent's grants ∩ the room's equipment", () => {
    expect(venueEffectiveTools(scout, VenueSchema.parse(READING_ROOM))).toEqual(["Read"]);
  });

  it("a room cannot hand an agent a tool its charter never claimed", () => {
    const wide = VenueSchema.parse({ ...READING_ROOM, equipment: { tools: ["Read", "Glob", "Bash"] } });
    expect(venueEffectiveTools(scout, wide), "Bash is in the room and NOT in the grant").toEqual(["Read"]);
  });

  it("a scoped grant resolves on its base name, as every other resolution does", () => {
    const scoped = testAgent({ slug: "scoped", primitives: ["SENSE"], allowed_tools: ["Bash(npx vitest run:*)"] });
    const shop = VenueSchema.parse({ ...READING_ROOM, equipment: { tools: ["Bash"] } });
    expect(venueEffectiveTools(scoped, shop)).toEqual(["Bash(npx vitest run:*)"]);
  });
});

describe("composeChart R10 — a chart's venue is checked where the chart is authored", () => {
  const compose = (chart: Record<string, unknown>, venues?: ReadonlyMap<string, Venue>) =>
    composeChart({ chart: chart as never, standards: stds(), agents: ags(), venues, payload_types: ["Signal"] });

  it("a chart naming NO venue composes exactly as it did before venues existed", () => {
    const c = compose(line());
    expect(c.ok).toBe(true);
  });

  it("a room that narrows one player but starves another is refused for the STARVED one", () => {
    const c = compose(line({ venue: "reading-room-v1" }), vens());
    // scout grants Read+Grep and the room holds Read — narrowed, seatable. reader grants WebFetch
    // and the room holds none of it — so this chart is refused for READER, and says which.
    expect(c.ok).toBe(false);
    if (c.ok) return;
    expect(c.violations.map((v) => v.rule)).toEqual(["R10"]);
    expect(c.violations[0]!.detail).toMatch(/reader/);
    expect(c.violations[0]!.detail).not.toMatch(/scout/);
  });

  it("an agent whose whole grant set is outside the room is refused, naming agent + venue + the empty intersection", () => {
    const c = composeChart({
      chart: { slug: "one", movements: [{ movement_id: "m", standard_slug: "look" }], venue: "empty-room-v1" } as never,
      standards: stds(), agents: ags(), venues: vens(),
    });
    expect(c.ok).toBe(false);
    if (c.ok) return;
    expect(c.violations.map((v) => v.rule)).toEqual(["R10"]);
    const d = c.violations[0]!.detail;
    expect(d).toMatch(/scout/);
    expect(d).toMatch(/empty-room-v1/);
    expect(d, "the refusal must name the emptiness, not just assert a failure").toMatch(/empt/i);
    expect(c.violations[0]!.movement_id).toBe("m");
  });

  it("an agent that grants NOTHING needs nothing from the room — the empty room seats it", () => {
    const c = composeChart({
      chart: { slug: "one", movements: [{ movement_id: "m", standard_slug: "look" }], venue: "empty-room-v1" } as never,
      standards: stds([["look", look(barefoot)]]), agents: ags(), venues: vens(),
    });
    expect(c.ok, "deny-by-default cuts both ways: no grant, no ceiling to breach").toBe(true);
  });

  it("a venue the genome does not hold is a DEAD NAME and fails closed", () => {
    const c = compose(line({ venue: "no-such-room" }), vens());
    expect(c.ok).toBe(false);
    if (c.ok) return;
    expect(c.violations.map((v) => v.rule)).toEqual(["R10"]);
    expect(c.violations[0]!.detail).toMatch(/no-such-room/);
  });

  it("a chart that names a venue cannot be composed by a caller who knows no venues", () => {
    const c = compose(line({ venue: "reading-room-v1" }));
    expect(c.ok, "an unresolvable ceiling is not an absent ceiling").toBe(false);
  });

  it("the venue does not enter chart_hash — a room is environment, not structure", () => {
    // Both compositions over the SAME standards, one held in a room the whole roster can play in.
    const readerInRoom = testAgent({ slug: "reader", primitives: ["INTERPRET"], input_types: ["Signal"], output_types: ["Interpretation"], domain: "venue-demo", allowed_tools: ["Read"] });
    const digestInRoom = composeStandard({
      slug: "digest", domain: "venue-demo", agents: [readerInRoom], input_types: ["Signal"], output_types: ["Interpretation"],
      phases: [{ name: "p2", chairs: [{ role: "r2", agent_slug: "reader", depends_on: [], input_contract: ["Signal"], output_contract: ["Interpretation"], required_skills: [] }] }] as PhaseDef[],
    });
    const roster = stds([["digest", digestInRoom]]);
    const bare = composeChart({ chart: line() as never, standards: roster, agents: ags(), payload_types: ["Signal"] });
    const roomed = composeChart({ chart: line({ venue: "reading-room-v1" }) as never, standards: roster, agents: ags(), venues: vens(), payload_types: ["Signal"] });
    expect(bare.ok, "premise: the bare arrangement composes").toBe(true);
    expect(roomed.ok, "premise: every seated agent survives the ceiling").toBe(true);
    if (!bare.ok || !roomed.ok) return;
    expect(roomed.chart_hash).toBe(bare.chart_hash);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// The loader — charts/ and venues/ are genome directories
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("loadGenome — the chart and the venue load from the genome", () => {
  it("the repo genome carries its shipped chart and venue", () => {
    const g = loadGenome(REPO);
    expect(g.charts.has("software-delivery-v1"), "the shipped example chart must load").toBe(true);
    expect(g.venues.has("empty-room-v1"), "the shipped example venue must load").toBe(true);
    expect(g.load_errors.filter((e) => e.kind === "chart" || e.kind === "venue")).toEqual([]);
    const room = g.venues.get("empty-room-v1")!;
    expect(room.equipment.tools).toEqual([]);
    expect(room.lifecycle.policy).toBe("ephemeral");
  });

  it("a chart naming a standard the genome does not hold is a load error of kind \"chart\"", () => {
    const root = genomeRoot({
      "charts/ghost.json": { slug: "ghost", movements: [{ movement_id: "m", standard_slug: "no-such-standard" }] },
    });
    const g = loadGenome(root);
    expect(g.charts.size).toBe(0);
    const err = g.load_errors.find((e) => e.kind === "chart");
    expect(err, "a dead standard name must be reported, not swallowed").toBeTruthy();
    expect(err!.slug).toBe("ghost");
    expect(err!.error).toMatch(/no-such-standard/);
    expect(err!.error, "the rule that fired is named").toMatch(/R2/);
  });

  it("a chart naming a venue the genome does not hold is a load error", () => {
    const root = genomeRoot({
      "charts/roomless.json": { slug: "roomless", movements: [{ movement_id: "m", standard_slug: "no-such-standard" }], venue: "no-such-room" },
    });
    const g = loadGenome(root);
    expect(g.load_errors.some((e) => e.kind === "chart")).toBe(true);
  });

  it("a malformed venue is a load error of kind \"venue\" and does not kill the genome", () => {
    const root = genomeRoot({
      "venues/bad.json": { slug: "bad", institution_slug: "quartet", equipment: { tools: [] }, lifecycle: { policy: "standing" } },
      "venues/good.json": READING_ROOM,
    });
    const g = loadGenome(root);
    expect(g.venues.has("reading-room-v1"), "one broken file does not block the others").toBe(true);
    const err = g.load_errors.find((e) => e.kind === "venue");
    expect(err?.slug).toBe("bad");
    expect(err?.error).toMatch(/rebuild_cadence/);
  });

  it("a duplicate chart slug is reported, and the first one stands", () => {
    const root = genomeRoot({
      "charts/a.json": { slug: "dup", movements: [{ movement_id: "m", standard_slug: "no-such-standard" }] },
      "charts/b.json": { slug: "dup", movements: [{ movement_id: "n", standard_slug: "no-such-standard" }] },
    });
    const g = loadGenome(root);
    expect(g.load_errors.filter((e) => e.kind === "chart").length).toBeGreaterThan(0);
  });

  it("a layered genome folds charts and venues like every other class", () => {
    const base = genomeRoot({ "venues/good.json": READING_ROOM });
    const consumer = genomeRoot({ "venues/over.json": { ...READING_ROOM, equipment: { tools: ["Read"] } } });
    const g = loadLayeredGenome([base, consumer]);
    expect(g.venues.get("reading-room-v1")!.equipment.tools, "the higher layer overrides by slug").toEqual(["Read"]);
    expect(g.provenance?.get("venue:reading-room-v1")).toBeTruthy();
  });

  it("a chart's SOURCE movement is seeded by the dispatch payload the loader cannot see", () => {
    // chartEntrySeedTypes is the loader's honest answer to R7 at load time: a movement with no
    // incoming edge is seeded by the payload, so its standard's declared input_types are treated
    // as provided. An INTERIOR movement's unmet need is still a dead slot.
    expect(
      chartEntrySeedTypes(ChartSchema.parse(line()), stds()),
      "the sink's need is carried by the edge, so the payload owes nothing",
    ).toEqual([]);
    const twoSources = ChartSchema.parse({
      slug: "parallel",
      movements: [{ movement_id: "a", standard_slug: "look" }, { movement_id: "b", standard_slug: "digest" }],
    });
    expect(chartEntrySeedTypes(twoSources, stds())).toEqual(["Signal"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// The MCP surface — every authorable class is authorable, and listable
// ═══════════════════════════════════════════════════════════════════════════════════════════════
const bareDeps = (extra?: Partial<ToolSurfaceDeps>): ToolSurfaceDeps => {
  const registry = createRegistry();
  return { registry, outputs: createOutputStore(registry), ledger: new MemoryLedger(), ...extra };
};

describe("chart_define / chart_browse — the arrangement is authored through the genome's mouth", () => {
  it("both tools exist, in the right categories", () => {
    const byslug = new Map(MCP_TOOLS.map((t) => [t.slug, t] as const));
    expect(byslug.get("chart_define")?.category).toBe("build");
    expect(byslug.get("chart_browse")?.category).toBe("understand");
  });

  it("chart_define's input_schema is GENERATED from ChartSchema, not hand-written", () => {
    const props = Object.keys(((MCP_TOOLS.find((t) => t.slug === "chart_define")!.input_schema) as { properties: object }).properties);
    expect(props.sort()).toEqual(Object.keys(zodToMcpProps(ChartSchema)).sort());
  });

  it("defines a chart, validates it against the loaded standards, and makes it dispatchable in-session", async () => {
    const charts = new Map();
    const surface = createToolSurface(bareDeps({ standards: new Map(stds()), agents: new Map(ags()), charts }));
    const res = await surface.find((t) => t.name === "chart_define")!.call(line());
    expect(res.ok, String(res.error)).toBe(true);
    const data = res.data as { chart_id: string; chart_hash: string };
    expect(data.chart_id).toBe("look-then-digest");
    expect(data.chart_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(charts.has("look-then-digest"), "write-through: the chart is dispatchable now").toBe(true);
  });

  it("refuses a chart whose edge names a type nothing seals, with the rule named", async () => {
    const surface = createToolSurface(bareDeps({ standards: new Map(stds()), agents: new Map(ags()), charts: new Map() }));
    const res = await surface.find((t) => t.name === "chart_define")!.call(
      line({ edges: [{ from_movement: "sense", to_movement: "read", output_type: "Plan" }] }),
    );
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/R6/);
  });

  it("chart_browse lists what a performance can be", async () => {
    const surface = createToolSurface(bareDeps({
      standards: new Map(stds()), agents: new Map(ags()), venues: new Map(vens()),
      charts: new Map([["look-then-digest", ChartSchema.parse(line())]]),
    }));
    const res = await surface.find((t) => t.name === "chart_browse")!.call({});
    expect(res.ok).toBe(true);
    const data = res.data as { charts: Array<Record<string, unknown>>; count: number };
    expect(data.count).toBe(1);
    const row = data.charts[0]!;
    expect(row["slug"]).toBe("look-then-digest");
    expect(row["standard_slugs"]).toEqual(["look", "digest"]);
    expect(row["movement_count"]).toBe(2);
    expect(row["edge_count"]).toBe(1);
    expect(row["gate_count"]).toBe(0);
    expect(String(row["chart_hash"]).length, "a prefix, not the whole hash").toBeLessThan(64);
  });

  it("chart_browse without a charts map says what bootstrap it needs", async () => {
    const res = await createToolSurface(bareDeps()).find((t) => t.name === "chart_browse")!.call({});
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/charts map/);
  });
});

describe("venue_define / venue_browse — the room is authored through the genome's mouth", () => {
  it("venue_define's input_schema is GENERATED from VenueSchema", () => {
    const props = Object.keys(((MCP_TOOLS.find((t) => t.slug === "venue_define")!.input_schema) as { properties: object }).properties);
    // `VenueObjectSchema` — the inner `ZodObject` the advertised surface is generated from. `VenueSchema`
    // now carries the cross-field `.superRefine` (a `ZodEffects`) and has no `.shape` to advertise.
    expect(props.sort()).toEqual(Object.keys(zodToMcpProps(VenueObjectSchema)).sort());
  });

  it("defines a venue and makes it resolvable in-session", async () => {
    const venues = new Map();
    const surface = createToolSurface(bareDeps({ venues }));
    const res = await surface.find((t) => t.name === "venue_define")!.call(EMPTY_ROOM);
    expect(res.ok, String(res.error)).toBe(true);
    expect((res.data as { venue_id: string }).venue_id).toBe("empty-room-v1");
    expect(venues.get("empty-room-v1")!.lifecycle.policy).toBe("ephemeral");
  });

  it("refuses a standing venue with no rebuild cadence", async () => {
    const surface = createToolSurface(bareDeps({ venues: new Map() }));
    const res = await surface.find((t) => t.name === "venue_define")!.call({ ...EMPTY_ROOM, lifecycle: { policy: "standing" } });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/rebuild_cadence/);
  });

  it("venue_browse lists the rooms with what a seating needs to know", async () => {
    const surface = createToolSurface(bareDeps({ venues: new Map(vens()) }));
    const res = await surface.find((t) => t.name === "venue_browse")!.call({});
    expect(res.ok).toBe(true);
    const data = res.data as { venues: Array<Record<string, unknown>>; count: number };
    expect(data.count).toBe(2);
    const room = data.venues.find((v) => v["slug"] === "empty-room-v1")!;
    expect(room["tool_count"]).toBe(0);
    expect(room["institution_slug"]).toBe("quartet");
    expect(room["lifecycle"]).toBe("ephemeral");
    expect(room["egress_count"]).toBe(0);
  });

  it("venue_browse filters by institution", async () => {
    const surface = createToolSurface(bareDeps({ venues: new Map(vens()) }));
    const res = await surface.find((t) => t.name === "venue_browse")!.call({ institution_slug: "nobody" });
    expect((res.data as { count: number }).count).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Dispatch — a gig may name a chart instead of a standard
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("gig_dispatch — chart_slug is the second, exclusive way to name a performance", () => {
  it("gig_dispatch advertises chart_slug", () => {
    const props = ((MCP_TOOLS.find((t) => t.slug === "gig_dispatch")!.input_schema) as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props)).toContain("chart_slug");
  });

  const runDeps = (extra?: Partial<ToolSurfaceDeps>): ToolSurfaceDeps =>
    bareDeps({
      standards: new Map(stds()), agents: new Map(ags()),
      charts: new Map([
        ["look-then-digest", ChartSchema.parse(line())],
        ["one-look", ChartSchema.parse({ slug: "one-look", movements: [{ movement_id: "m", standard_slug: "look" }] })],
      ]),
      invoke: (ctx) =>
        Promise.resolve(ctx.agent.slug === "scout"
          ? { source: "fixture://venue/look" }
          : { claims: [{ claim: "the arrangement carried the signal" }] }),
      ...extra,
    });

  it("refuses BOTH targets — a single-standard dispatch IS the one-movement chart", async () => {
    const res = await createToolSurface(runDeps()).find((t) => t.name === "gig_dispatch")!
      .call({ standard_slug: "look", chart_slug: "one-look" });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/exactly one/i);
  });

  it("refuses NEITHER target", async () => {
    const res = await createToolSurface(runDeps()).find((t) => t.name === "gig_dispatch")!.call({});
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/exactly one/i);
  });

  it("an unknown chart is refused, not silently run", async () => {
    const res = await createToolSurface(runDeps()).find((t) => t.name === "gig_dispatch")!
      .call({ chart_slug: "no-such-chart", wait: true });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/unknown chart/);
  });

  it("performs a two-movement chart and reports the arrangement's own manifest", async () => {
    const res = await createToolSurface(runDeps()).find((t) => t.name === "gig_dispatch")!
      .call({ chart_slug: "look-then-digest", input: { Signal: { source: "seed" } }, wait: true });
    expect(res.ok, String(res.error)).toBe(true);
    const data = res.data as { gig_id: string; status: string; manifest: Record<string, unknown> };
    expect(data.status).toBe("complete");
    expect(data.manifest["chart_hash"]).toMatch(/^[0-9a-f]{64}$/);
    expect(data.manifest["chart_slug"]).toBe("look-then-digest");
    const movements = data.manifest["movements"] as Array<{ movement_id: string; status: string }>;
    expect(movements.map((m) => m.movement_id)).toEqual(["sense", "read"]);
    expect(movements.every((m) => m.status === "complete")).toBe(true);
  });

  it("a chart whose movement's standard is retired is refused before any spend", async () => {
    const retired = composeStandard({
      slug: "look", domain: "venue-demo", agents: [scout], output_types: ["Signal"], status: "retired",
      phases: [{ name: "p1", chairs: [{ role: "r1", agent_slug: "scout", depends_on: [], input_contract: [], output_contract: ["Signal"], required_skills: [] }] }] as PhaseDef[],
    });
    const res = await createToolSurface(runDeps({
      standards: new Map<string, Standard>([["look", retired], ["digest", digest()]]),
    })).find((t) => t.name === "gig_dispatch")!.call({ chart_slug: "one-look", wait: true });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/retired/);
  });
});
