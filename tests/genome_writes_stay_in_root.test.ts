// NO PATH THE ENGINE DERIVES LEAVES THE ROOT IT BELONGS TO — genome writes, reads and appends.
//
// FOUNDER RULING (Eugene, verbatim): "SLUGS ARE NOT IDENTIFIERS".
//
// The boundary is NOT a slug grammar. It is that no path the engine derives from a caller's value
// can ever leave the root it belongs to. A slug grammar may be added later as hygiene; not one law
// below relies on one — every hostile value here is refused because of WHERE ITS PATH LANDS (or
// because it cannot be a portable path at all: a NUL byte, a backslash), never because of what
// characters a "good slug" has. That is also why the fixtures include a value no grammar-shaped
// check thinks about: `../../g-sibling/x`, which lands in a directory whose NAME starts with the
// root's name. A containment check written as `resolved.startsWith(root)` passes it; only a check
// that compares whole path segments refuses it.
//
// THE HOLE (verified at e6c89ff): the file genome store and the genome writer join caller-supplied
// slugs into paths with no check. path.join normalises `../`, so slug `../../x` writes OUTSIDE the
// genome root, a skill slug `../..` creates directories and writes files outside it, agent_evolve
// READS `agents/${slug}.json` from wherever that lands and echoes it back, and two appenders do the
// same for .jsonl files. Every site, and the door each is reached through:
//
//   site                                      reached through (driven here)
//   src/genome_writer.ts:36  <slug>.json      type_register · standard_compose · chart_define ·
//                                             venue_define · agent_define · agent_evolve (surface)
//   src/genome_writer.ts:42  history/<slug>   the same writer, when the target already exists
//   src/genome_writer.ts:216 skills/<slug>/   skill_define (surface)
//   src/genome_store.ts:92-113 upsert         the HOSTED surface (genome_upsert → store.upsert),
//                                             and the port itself for every GenomeClass
//   src/server.ts:2780-2781  agents/<slug>    agent_evolve — a traversal READ, echoed in next_def
//   src/lineage_persist.ts:44 institutions/   persistLineageAdoption (no MCP door yet — driven
//                                             directly; the read AND the write-back)
//   src/skills.ts:199        <slug>.jsonl     resolveSkill → the chain APPEND (no MCP door —
//                                             driven directly)
//   src/skills.ts:225        <slug>.jsonl     skillChainEvents / computeDeterminismRatio READ
//   src/outputs.ts:892       <gig_id>.jsonl   output_write — the gig id is a caller argument
//   src/server.ts:1753-1761  gigs/<gig_id>/   gig_logs — the gig id is a caller argument, and the
//                                             handler readdir()s and returns every .jsonl there
//
// THE CONTRACT EACH LAW HOLDS, for every hostile value:
//   1. the call is REFUSED, and the refusal NAMES THE BOUNDARY (the word "root");
//   2. NOTHING is created, modified or removed anywhere in the arena — the root, the root's
//      parent, the prefix-sharing sibling — byte-for-byte, snapshot before vs after;
//   3. a refused genome write seals NO identity (the ledger is unchanged: a sealed row naming a
//      definition nothing wrote is the defect #218 exists to prevent);
//   4. for a read, a SENTINEL planted outside the root never appears in anything returned.
// A control per door: a normal slug still writes, INSIDE the root, where it always did.
//
// THE ARENA: base/d1/d2/g is the root; base/d1/d2/g-sibling is a sibling whose name shares the
// root's prefix. Nesting the root two levels down keeps every hostile path this file uses INSIDE
// base, so a hole is observed in the snapshot rather than written into the host's temp directory.
import { describe, it, expect, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { createToolSurface, type ToolSurfaceDeps } from "../src/server.js";
import { fileGenomeStore, type GenomeClass } from "../src/genome_store.js";
import { writeGenomeFileVersioned, sealDefinition, sealAgentDefinition, sealSkillPackage } from "../src/genome_writer.js";
import { persistLineageAdoption } from "../src/lineage_persist.js";
import { resolveSkill, skillChainEvents, computeDeterminismRatio } from "../src/skills.js";
import { createRegistry } from "../src/registry.js";
import { createOutputStore } from "../src/outputs.js";
import { MemoryLedger } from "../src/ledger.js";
import { composeStandard, type Agent, type Standard, type PhaseDef } from "../src/composition.js";
import type { LineageRecordRefOutput } from "../src/genome_schema.js";
import { TEST_BEHAVIOR, testAgent } from "./_support/agents.js";

// ── the arena ──────────────────────────────────────────────────────────────────────────────────
interface Arena { base: string; root: string; parent: string; sibling: string }
const cleanup: string[] = [];
afterAll(() => { for (const d of cleanup) rmSync(d, { recursive: true, force: true }); });

function arena(): Arena {
  const base = mkdtempSync(join(tmpdir(), "contain-"));
  cleanup.push(base);
  const parent = join(base, "d1", "d2");
  const root = join(parent, "g");
  const sibling = join(parent, "g-sibling");
  for (const d of ["agents", "standards", "domain_types", "skills", "charts", "venues", "institutions", "outputs", "gigs", "chain"]) {
    mkdirSync(join(root, d), { recursive: true });
  }
  mkdirSync(sibling, { recursive: true });
  writeFileSync(join(sibling, "keep.txt"), "the sibling's own bytes\n");
  writeFileSync(join(parent, "keep.txt"), "the parent's own bytes\n");
  return { base, root, parent, sibling };
}

/** Every path under `dir` → "dir" or the sha256 of its bytes. Byte-for-byte, directories included. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const rel = relative(dir, p);
      if (statSync(p).isDirectory()) { out[rel + "/"] = "dir"; walk(p); }
      else out[rel] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

/** The hostile values. Each is refused for where its path lands (or for not being a portable path
 *  at all), never for failing a slug grammar. `abs` is built per arena: an absolute path whose
 *  target is the sibling, so the snapshot can SEE where it would land. */
const hostile = (a: Arena): Array<[string, string]> => [
  ["../../x", "climbs two levels out of the class directory, into the root's parent"],
  ["../..", "names the root's parent itself"],
  ["a/../../x", "descends then climbs past where it started"],
  [join(a.sibling, "x"), "an absolute path"],
  ["a\u0000b", "a NUL byte"],
  ["a\\..\\..\\x", "a backslash (a separator on Windows, a trap on posix)"],
  ["../../g-sibling/x", "lands in a directory whose NAME shares the root's prefix"],
];

const SENTINEL = "SENTINEL-7f3c-outside-the-root-never-returned";

const expectRefusedByName = (r: { ok: boolean; error?: string | undefined }, what: string): void => {
  expect.soft(r.ok, `${what} was ACCEPTED: ${JSON.stringify(r).slice(0, 400)}`).toBe(false);
  expect.soft(String(r.error), `${what} was refused, but the refusal does not name the boundary (the root): ${String(r.error).slice(0, 300)}`).toMatch(/root/i);
};

// ── the surface and its doors ──────────────────────────────────────────────────────────────────
const sensor: Agent = testAgent({ slug: "sensor", primitives: ["SENSE"], output_types: ["raw-note"], domain: "demo" });
const scout: Agent = testAgent({ slug: "scout", primitives: ["SENSE"], output_types: ["Signal"], domain: "venue-demo", allowed_tools: ["Read"] });
const reader: Agent = testAgent({ slug: "reader", primitives: ["INTERPRET"], input_types: ["Signal"], output_types: ["Interpretation"], domain: "venue-demo" });
const look = (): Standard => composeStandard({
  slug: "look", domain: "venue-demo", agents: [scout], output_types: ["Signal"],
  phases: [{ name: "p1", chairs: [{ role: "r1", agent_slug: "scout", depends_on: [], input_contract: [], output_contract: ["Signal"], required_skills: [] }] }] as PhaseDef[],
});
const digest = (): Standard => composeStandard({
  slug: "digest", domain: "venue-demo", agents: [reader], input_types: ["Signal"], output_types: ["Interpretation"],
  phases: [{ name: "p2", chairs: [{ role: "r2", agent_slug: "reader", depends_on: [], input_contract: ["Signal"], output_contract: ["Interpretation"], required_skills: [] }] }] as PhaseDef[],
});

interface Built { deps: ToolSurfaceDeps; ledger: MemoryLedger; call: (tool: string, args: Record<string, unknown>) => Promise<{ ok: boolean; error?: string | undefined; data?: unknown }> }

function surface(extra: Partial<ToolSurfaceDeps>): Built {
  const registry = createRegistry();
  const ledger = new MemoryLedger();
  const deps: ToolSurfaceDeps = {
    registry, outputs: createOutputStore(registry), ledger,
    standards: new Map([["look", look()], ["digest", digest()]]),
    agents: new Map<string, Agent>([["sensor", sensor], ["scout", scout], ["reader", reader]]),
    skills: new Map(), charts: new Map(), venues: new Map(),
    ...extra,
  };
  const tools = createToolSurface(deps);
  return {
    deps, ledger,
    call: async (tool, args) => {
      const t = tools.find((x) => x.name === tool);
      if (!t) throw new Error(`no ${tool} on the surface`);
      return t.call(args) as Promise<{ ok: boolean; error?: string; data?: unknown }>;
    },
  };
}

let seq = 0;
/** One door: the tool, the args it takes for a given slug, and where a NORMAL slug lands. */
const DOORS: Array<{ tool: string; site: string; args: (slug: string) => Record<string, unknown>; lands: (root: string, slug: string) => string }> = [
  {
    tool: "type_register", site: "src/genome_writer.ts:36 via sealDefinition (server.ts:650)",
    args: (slug) => ({ slug, extends: "Artifact", domain: "demo", schema: { type: "object", properties: { [`f${++seq}_${Math.random().toString(36).slice(2, 8)}`]: { type: "string" } } }, required_fields: [] }),
    lands: (root, slug) => join(root, "domain_types", `${slug}.json`),
  },
  {
    tool: "standard_compose", site: "src/genome_writer.ts:36 via sealDefinition (server.ts:1824)",
    args: (slug) => ({ slug, domain: "demo", agents: [sensor], output_types: ["raw-note"],
      phases: [{ name: "sense", chairs: [{ role: "sense", agent_slug: "sensor", depends_on: [], input_contract: [], output_contract: ["raw-note"], required_skills: [] }] }] }),
    lands: (root, slug) => join(root, "standards", `${slug}.json`),
  },
  {
    tool: "chart_define", site: "src/genome_writer.ts:36 via sealDefinition (server.ts:1868)",
    args: (slug) => ({ slug, movements: [{ movement_id: "sense", standard_slug: "look" }, { movement_id: "read", standard_slug: "digest" }],
      edges: [{ from_movement: "sense", to_movement: "read", output_type: "Signal" }] }),
    lands: (root, slug) => join(root, "charts", `${slug}.json`),
  },
  {
    tool: "venue_define", site: "src/genome_writer.ts:36 via sealDefinition (server.ts:1931)",
    args: (slug) => ({ slug, institution_slug: "quartet", equipment: { tools: [] }, lifecycle: { policy: "ephemeral" } }),
    lands: (root, slug) => join(root, "venues", `${slug}.json`),
  },
  {
    tool: "agent_define", site: "src/genome_writer.ts:36 via sealAgentDefinition (server.ts:2653)",
    args: (slug) => ({ ...TEST_BEHAVIOR, slug, primitives: ["SENSE"], input_types: [], output_types: ["raw-note"], domain: "demo" }),
    lands: (root, slug) => join(root, "agents", `${slug}.json`),
  },
  {
    tool: "skill_define", site: "src/genome_writer.ts:216 sealSkillPackage (server.ts:2896)",
    args: (slug) => ({ slug, description: "a skill", determinism_ratio: 1, permission: { tier: 0 },
      code: "export default ({x}) => ({y: x + 1});", fixtures: [{ id: "fx1", input: { x: 1 }, expected_output: { y: 2 } }] }),
    lands: (root, slug) => join(root, "skills", slug, "meta.json"),
  },
];

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 1. The local surface: every genome-writing door, with a working genome_dir.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("every genome-writing door refuses a slug whose path leaves the root — and writes nothing, seals nothing", () => {
  for (const door of DOORS) {
    describe(`${door.tool} (${door.site})`, () => {
      it("control: a normal slug still writes, inside the root, and nowhere else", async () => {
        const a = arena();
        const s = surface({ genome_dir: a.root });
        const outsideBefore = snapshot(a.base);
        const slug = `plain-${door.tool.replace(/_/g, "-")}`;
        const r = await s.call(door.tool, door.args(slug));
        expect(r.ok, `the control failed — the door itself is broken, not contained: ${JSON.stringify(r).slice(0, 400)}`).toBe(true);
        expect(existsSync(door.lands(a.root, slug)), `${door.tool} did not write ${door.lands(a.root, slug)}`).toBe(true);
        const after = snapshot(a.base);
        const rootRel = relative(a.base, a.root) + "/";
        const outside = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).filter(([k]) => !k.startsWith(rootRel)));
        expect(outside(after), "a NORMAL slug changed something outside the root").toEqual(outside(outsideBefore));
      });

      it("a slug whose path would leave the root (or cannot be a portable path) is refused by name; nothing in the arena moves; no identity is sealed", async () => {
        const a = arena();
        for (const [slug, why] of hostile(a)) {
          const s = surface({ genome_dir: a.root });
          const before = snapshot(a.base);
          const r = await s.call(door.tool, door.args(slug));
          expectRefusedByName(r, `${door.tool} with slug ${JSON.stringify(slug)} (${why})`);
          expect.soft(snapshot(a.base), `${door.tool} with slug ${JSON.stringify(slug)} (${why}) changed the filesystem`).toEqual(before);
          expect.soft(s.ledger.query().length, `${door.tool} with slug ${JSON.stringify(slug)} sealed an identity for a write it refused`).toBe(0);
        }
      });
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 2. agent_evolve: the traversal READ (server.ts:2780-2781) and the write-back.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("agent_evolve (server.ts:2780-2781 read, :2832 write) never reads or writes outside the root", () => {
  const sentinelAgent = (slug: string) => JSON.stringify({ ...TEST_BEHAVIOR, slug, identity: SENTINEL, primitives: ["SENSE"], input_types: [], output_types: ["raw-note"], domain: "demo" }, null, 2) + "\n";

  it("control: a normal slug evolves the agent inside the root", async () => {
    const a = arena();
    writeFileSync(join(a.root, "agents", "plain.json"), sentinelAgent("plain").replace(SENTINEL, "inside"));
    const s = surface({ genome_dir: a.root });
    const r = await s.call("agent_evolve", { slug: "plain", changes: { method: "a changed method" } });
    expect(r.ok, JSON.stringify(r).slice(0, 400)).toBe(true);
    expect(JSON.parse(readFileSync(join(a.root, "agents", "plain.json"), "utf8")).method).toBe("a changed method");
  });

  it("a hostile slug is refused by name; the agent file planted OUTSIDE the root is neither echoed nor rewritten", async () => {
    const a = arena();
    // What each hostile slug's `agents/<slug>.json` resolves to, planted with the sentinel so a
    // traversal read has something to find and echo.
    writeFileSync(join(a.parent, "x.json"), sentinelAgent("../../x"));
    writeFileSync(join(a.sibling, "x.json"), sentinelAgent("../../g-sibling/x"));
    for (const [slug, why] of hostile(a)) {
      const s = surface({ genome_dir: a.root });
      const before = snapshot(a.base);
      const r = await s.call("agent_evolve", { slug, changes: { method: "evolved through a traversal" } });
      expectRefusedByName(r, `agent_evolve with slug ${JSON.stringify(slug)} (${why})`);
      expect.soft(JSON.stringify(r), `agent_evolve with slug ${JSON.stringify(slug)} returned bytes read from OUTSIDE the root`).not.toContain(SENTINEL);
      expect.soft(snapshot(a.base), `agent_evolve with slug ${JSON.stringify(slug)} (${why}) changed the filesystem`).toEqual(before);
      expect.soft(s.ledger.query().length, `agent_evolve with slug ${JSON.stringify(slug)} sealed an identity`).toBe(0);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 3. The history writer (genome_writer.ts:42): a prior version's bytes are snapshotted under
//    genome/history/<subdir>/<slug>/ — a second path derived from the same slug.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("writeGenomeFileVersioned's history snapshot (genome_writer.ts:42) stays in the root", () => {
  it("control: overwriting a normal slug snapshots its prior bytes under genome/history, inside the root", () => {
    const a = arena();
    writeGenomeFileVersioned(a.root, "agents", "plain", "{\"v\":1}\n");
    const r = writeGenomeFileVersioned(a.root, "agents", "plain", "{\"v\":2}\n");
    expect(r.overwritten).toBe(true);
    expect(existsSync(join(a.root, "genome", "history", "agents", "plain", `${r.prior_content_hash}.json`))).toBe(true);
  });

  it("a slug whose target exists OUTSIDE the root is refused by name before either path is touched", () => {
    const a = arena();
    // Four `..` from root/agents climb to root, d2, d1, base: the file lands at base/x.json. Plant a
    // prior version there, so an unchecked writer ALSO derives a history dir at
    // root/genome/history/agents/../../../../x = base/d1/d2/x — outside the root, inside the arena.
    const slug = "../../../../x";
    writeFileSync(join(a.base, "x.json"), `{"prior":"${SENTINEL}"}\n`);
    const before = snapshot(a.base);
    let thrown: unknown;
    try { writeGenomeFileVersioned(a.root, "agents", slug, "{\"v\":2}\n"); } catch (e) { thrown = e; }
    expect(thrown, `writeGenomeFileVersioned accepted slug ${JSON.stringify(slug)}`).toBeInstanceOf(Error);
    expect(String((thrown as Error | undefined)?.message), "the refusal must name the boundary").toMatch(/root/i);
    expect(snapshot(a.base), "the file or its history snapshot was written outside the root").toEqual(before);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 3b. The three blessed writers, each on its own. A check at a DOOR alone would pass section 1 and
//     leave every other caller of these writers open (seal_genome.ts:87 is one such caller today):
//     each writer must hold the boundary itself, and refuse BEFORE it seals an identity (#218's
//     seal-before-write order is exactly what makes a late refusal leave an orphan ledger row).
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("the blessed writers hold the boundary themselves, and refuse before sealing", () => {
  const writers: Array<[string, (slug: string, root: string, ledger: MemoryLedger) => unknown]> = [
    ["sealDefinition", (slug, root, ledger) => sealDefinition("type_register", slug, { slug, v: 1 }, ledger, root, "domain_types")],
    ["sealDefinition (file slug)", (slug, root, ledger) => sealDefinition("type_extend", "plain@v2", { slug: "plain", v: 2 }, ledger, root, "domain_types", undefined, slug)],
    ["sealAgentDefinition", (slug, root, ledger) => sealAgentDefinition({ ...TEST_BEHAVIOR, slug, primitives: ["SENSE"], input_types: [], output_types: ["raw-note"], domain: "demo" }, ledger, root)],
    ["sealSkillPackage", (slug, root, ledger) => sealSkillPackage({ slug, code: "export default () => ({})", fixtures: [{ id: "f", input: {} }] }, ledger, root)],
  ];
  for (const [name, write] of writers) {
    it(`${name}: a normal slug writes inside the root; a hostile one throws naming the root, writes nothing, seals nothing`, () => {
      const a = arena();
      const control = new MemoryLedger();
      write("plain", a.root, control);
      expect(control.query().length, `${name} control sealed nothing`).toBe(1);
      for (const [slug, why] of hostile(a)) {
        const ledger = new MemoryLedger();
        const before = snapshot(a.base);
        let thrown: unknown;
        try { write(slug, a.root, ledger); } catch (e) { thrown = e; }
        expect.soft(thrown, `${name} accepted slug ${JSON.stringify(slug)} (${why})`).toBeInstanceOf(Error);
        expect.soft(String((thrown as Error | undefined)?.message), `${name} refused ${JSON.stringify(slug)} without naming the boundary`).toMatch(/root/i);
        expect.soft(snapshot(a.base), `${name} with slug ${JSON.stringify(slug)} (${why}) changed the filesystem`).toEqual(before);
        expect.soft(ledger.query().length, `${name} sealed an identity for slug ${JSON.stringify(slug)} it did not write`).toBe(0);
      }
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 4. The hosted surface: genome_upsert → store.upsert (server.ts:4094 → genome_store.ts:92-113).
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("the hosted surface's store upsert (server.ts:4094 → genome_store.ts:92-113) refuses a slug whose path leaves the store root", () => {
  const HOSTED_DOORS = [...DOORS.map((d) => d.tool), "agent_evolve"];
  for (const tool of HOSTED_DOORS) {
    it(`${tool}, hosted over fileGenomeStore: control writes inside the root; every hostile slug is refused by name, nothing moves`, async () => {
      const a = arena();
      const hostedArgs = (slug: string): Record<string, unknown> =>
        tool === "agent_evolve" ? { slug, changes: { method: "evolved while hosted" } } : DOORS.find((d) => d.tool === tool)!.args(slug);
      const hostedDeps = (slug: string): Partial<ToolSurfaceDeps> => ({
        hosted: true, store: fileGenomeStore(a.root),
        ...(tool === "agent_evolve" ? { agents: new Map<string, Agent>([[slug, testAgent({ slug, primitives: ["SENSE"], output_types: ["raw-note"], domain: "demo" })]]) } : {}),
      });
      // control
      const plain = `hosted-${tool.replace(/_/g, "-")}`;
      const c = await surface(hostedDeps(plain)).call(tool, hostedArgs(plain));
      expect(c.ok, `the hosted control failed: ${JSON.stringify(c).slice(0, 400)}`).toBe(true);
      const cls = tool === "skill_define" ? join(a.root, "skills", plain, "meta.json")
        : join(a.root, { type_register: "domain_types", standard_compose: "standards", chart_define: "charts", venue_define: "venues", agent_define: "agents", agent_evolve: "agents" }[tool]!, `${plain}.json`);
      expect(existsSync(cls), `the hosted control did not land ${cls}`).toBe(true);
      // hostile
      for (const [slug, why] of hostile(a)) {
        const before = snapshot(a.base);
        const r = await surface(hostedDeps(slug)).call(tool, hostedArgs(slug));
        expectRefusedByName(r, `hosted ${tool} with slug ${JSON.stringify(slug)} (${why})`);
        expect.soft(snapshot(a.base), `hosted ${tool} with slug ${JSON.stringify(slug)} (${why}) changed the filesystem`).toEqual(before);
      }
    });
  }

  it("the port itself: fileGenomeStore(root).upsert refuses a hostile slug for EVERY genome class, by name, and writes nothing", async () => {
    const classes: GenomeClass[] = ["agent", "standard", "skill", "domain_type", "chart", "venue", "institution"];
    const a = arena();
    const store = fileGenomeStore(a.root);
    for (const cls of classes) {
      await store.upsert(cls, { slug: `plain-${cls.replace(/_/g, "-")}`, code: "export default () => ({})", fixtures: [] });
      for (const [slug, why] of hostile(a)) {
        const before = snapshot(a.base);
        let thrown: unknown;
        try { await store.upsert(cls, { slug, code: "export default () => ({})", md: "# m", fixtures: [{ id: "f", input: {} }] }); } catch (e) { thrown = e; }
        expect.soft(thrown, `fileGenomeStore.upsert(${cls}) accepted slug ${JSON.stringify(slug)} (${why})`).toBeInstanceOf(Error);
        expect.soft(String((thrown as Error | undefined)?.message), `fileGenomeStore.upsert(${cls}) refused ${JSON.stringify(slug)} without naming the boundary`).toMatch(/root/i);
        expect.soft(snapshot(a.base), `fileGenomeStore.upsert(${cls}) with slug ${JSON.stringify(slug)} (${why}) changed the filesystem`).toEqual(before);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 5. persistLineageAdoption (lineage_persist.ts:44): reads institutions/<slug>.json and writes it back.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("persistLineageAdoption (lineage_persist.ts:44) never reads or rewrites an institution outside the root", () => {
  const ref = { record_ref: "sha-a", approved_by: "eugene", sealed_at: "2026-09-27T00:00:00.000Z" } as LineageRecordRefOutput;
  const outsideDoc = JSON.stringify({ institution: { slug: "outside", note: SENTINEL, lineage: [] }, chairs: [] }, null, 2) + "\n";

  it("control: a normal institution slug adopts inside the root", () => {
    const a = arena();
    writeFileSync(join(a.root, "institutions", "studio.json"), JSON.stringify({ institution: { slug: "studio", lineage: [] } }) + "\n");
    expect(persistLineageAdoption(a.root, "studio", ref).written).toBe(true);
  });

  it("a hostile institution slug is refused by name; the outside document is neither rewritten nor echoed", () => {
    const a = arena();
    writeFileSync(join(a.parent, "x.json"), outsideDoc);                    // institutions/../../x.json
    writeFileSync(join(a.sibling, "x.json"), outsideDoc);                   // institutions/../../g-sibling/x.json
    writeFileSync(join(a.root, "x.json"), `not json: ${SENTINEL}\n`);       // institutions/a/../../x.json — a parse error would echo it
    for (const [slug, why] of hostile(a)) {
      const before = snapshot(a.base);
      let result: unknown; let thrown: unknown;
      try { result = persistLineageAdoption(a.root, slug, ref); } catch (e) { thrown = e; }
      const said = thrown instanceof Error ? thrown.message : JSON.stringify(result);
      const refused = thrown instanceof Error || (result as { written?: boolean } | undefined)?.written === false;
      expect.soft(refused, `persistLineageAdoption accepted slug ${JSON.stringify(slug)} (${why}): ${said}`).toBe(true);
      expect.soft(said, `persistLineageAdoption refused ${JSON.stringify(slug)} (${why}) without naming the boundary: ${said}`).toMatch(/root/i);
      expect.soft(said, `persistLineageAdoption echoed bytes read from ${JSON.stringify(slug)}`).not.toContain(SENTINEL);
      expect.soft(snapshot(a.base), `persistLineageAdoption with ${JSON.stringify(slug)} (${why}) changed the filesystem`).toEqual(before);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 6. The skill chain (skills.ts:199 append, :225 read): <chainDir>/<slug>.jsonl.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("the skill chain (skills.ts:199 append, :225 read) stays in its chain directory", () => {
  const pkg = (a: Arena, slug: string): string => {
    const dir = mkdtempSync(join(a.root, "skills", "pkg-"));
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ slug, version: 1, permission: { tier: 0 } }) + "\n");
    writeFileSync(join(dir, "skill.md"), "# reasoning half only — no code, so nothing spawns\n");
    return dir;
  };

  it("control: a normal slug's resolution appends inside the chain directory, and reads back", async () => {
    const a = arena();
    const chainDir = join(a.root, "chain");
    await resolveSkill(pkg(a, "plain"), {}, () => ({}), { chainDir });
    expect(existsSync(join(chainDir, "plain.jsonl"))).toBe(true);
    expect(skillChainEvents("plain", undefined, { chainDir })).toHaveLength(1);
  });

  it("APPEND: a package whose slug's chain file leaves the chain directory is refused by name, and nothing is appended anywhere", async () => {
    const a = arena();
    const chainDir = join(a.root, "chain");
    for (const [slug, why] of hostile(a)) {
      const dir = pkg(a, slug);
      const before = snapshot(a.base);
      let thrown: unknown;
      try { await resolveSkill(dir, {}, () => ({}), { chainDir }); } catch (e) { thrown = e; }
      expect.soft(thrown, `resolveSkill appended a chain event for slug ${JSON.stringify(slug)} (${why})`).toBeInstanceOf(Error);
      expect.soft(String((thrown as Error | undefined)?.message), `the chain append refused ${JSON.stringify(slug)} without naming the boundary`).toMatch(/root/i);
      expect.soft(snapshot(a.base), `resolveSkill with slug ${JSON.stringify(slug)} (${why}) changed the filesystem`).toEqual(before);
    }
  });

  it("READ: skillChainEvents / computeDeterminismRatio refuse a slug whose chain file leaves the chain directory, and return nothing from it", () => {
    const a = arena();
    const chainDir = join(a.root, "chain");
    const line = JSON.stringify({ slug: SENTINEL, version: 1, code_hash: SENTINEL, tier: 0, duration_ms: 0, permission_violations: [], field_origins: { a: "code" } }) + "\n";
    writeFileSync(join(a.root, "x.jsonl"), line);       // chain/../x.jsonl — and the a/../../x landing is root/x.jsonl too
    writeFileSync(join(a.parent, "x.jsonl"), line);     // chain/../../x.jsonl
    writeFileSync(join(a.sibling, "x.jsonl"), line);    // chain/../../g-sibling/x.jsonl
    for (const [slug, why] of hostile(a)) {
      for (const [name, read] of [
        ["skillChainEvents", () => skillChainEvents(slug, undefined, { chainDir })],
        ["computeDeterminismRatio", () => computeDeterminismRatio(slug, 1, { chainDir })],
      ] as const) {
        let result: unknown; let thrown: unknown;
        try { result = read(); } catch (e) { thrown = e; }
        expect.soft(thrown, `${name} READ the chain for slug ${JSON.stringify(slug)} (${why}) and returned ${JSON.stringify(result)?.slice(0, 200)}`).toBeInstanceOf(Error);
        expect.soft(String((thrown as Error | undefined)?.message), `${name} refused ${JSON.stringify(slug)} without naming the boundary`).toMatch(/root/i);
        expect.soft(String((thrown as Error | undefined)?.message), `${name} echoed bytes read from outside the chain directory`).not.toContain(SENTINEL);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 7. Found beyond the brief: two MCP doors that derive a path from a caller's gig id.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("output_write (outputs.ts:892) appends <gig_id>.jsonl only inside the persist root", () => {
  const args = (gig_id: string) => ({ core_type: "Signal", domain_type: "", domain: "demo", gig_id, agent_slug: "parser", data: { t: "x", source: "fixture://demo/note" } });

  it("control: a normal gig id appends inside the root's outputs/", async () => {
    const a = arena();
    const registry = createRegistry();
    const s = surface({ registry, outputs: createOutputStore(registry, { persistDir: a.root }) });
    const r = await s.call("output_write", args("plain-gig"));
    expect(r.ok, JSON.stringify(r).slice(0, 400)).toBe(true);
    expect(existsSync(join(a.root, "outputs", "plain-gig.jsonl"))).toBe(true);
  });

  it("a hostile gig id is refused by name and nothing is appended anywhere", async () => {
    const a = arena();
    for (const [gid, why] of hostile(a)) {
      const registry = createRegistry();
      const s = surface({ registry, outputs: createOutputStore(registry, { persistDir: a.root }) });
      const before = snapshot(a.base);
      const r = await s.call("output_write", args(gid));
      expectRefusedByName(r, `output_write with gig_id ${JSON.stringify(gid)} (${why})`);
      expect.soft(snapshot(a.base), `output_write with gig_id ${JSON.stringify(gid)} (${why}) changed the filesystem`).toEqual(before);
    }
  });
});

describe("gig_logs (server.ts:1753-1761) reads gigs/<gig_id>/ only inside the log root", () => {
  const plant = (dir: string): void => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "leak.jsonl"), JSON.stringify({ type: "text", text: SENTINEL }) + "\n");
  };

  it("control: a normal gig id's logs are served", async () => {
    const a = arena();
    plant(join(a.root, "gigs", "plain-gig"));
    const r = await surface({ gig_log_base: a.root }).call("gig_logs", { gig_id: "plain-gig" });
    expect(r.ok).toBe(true);
    expect((r.data as { count: number }).count).toBe(1);
  });

  it("a hostile gig id is refused by name and no log planted outside the root is returned", async () => {
    const a = arena();
    plant(join(a.parent, "x"));          // gigs/../../x
    plant(a.parent);                     // gigs/../..
    plant(join(a.root, "x"));            // gigs/a/../../x
    plant(join(a.sibling, "x"));         // gigs/../../g-sibling/x (and the absolute value's target)
    for (const [gid, why] of hostile(a)) {
      const r = await surface({ gig_log_base: a.root }).call("gig_logs", { gig_id: gid });
      expect.soft(JSON.stringify(r), `gig_logs with gig_id ${JSON.stringify(gid)} (${why}) returned a log from OUTSIDE its root`).not.toContain(SENTINEL);
      expectRefusedByName(r, `gig_logs with gig_id ${JSON.stringify(gid)} (${why})`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 8. charter_read (server.ts:2123) — CONDUCTOR'S DECISION: a charter may be read only from INSIDE
//    the genome root. A caller-supplied path that resolves outside it — by the same whole-segment
//    check as every other site in #559 — is refused by name, and nothing it points at is returned.
//    With no genome root there is no inside, so the read is refused (absent means decline).
//    Not lawed here: a layout-declared charter path outside the genome root (#553's extension).
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("charter_read (server.ts:2123) reads a charter only from inside the genome root", () => {
  const charter = (subject_name: string) => JSON.stringify({
    subject_name, subject_type: "solo", charter: "build the tool", north_stars: [], products: [],
    pain_points: [], tech_stack: [], existing_tools: [], access_grants: [],
  }) + "\n";

  it("control: a charter inside the genome root still reads", async () => {
    const a = arena();
    mkdirSync(join(a.root, "charters"), { recursive: true });
    writeFileSync(join(a.root, "charters", "c.json"), charter("inside-the-root"));
    const r = await surface({ genome_dir: a.root }).call("charter_read", { path: join(a.root, "charters", "c.json") });
    expect(r.ok, JSON.stringify(r).slice(0, 400)).toBe(true);
    expect((r.data as { subject_name: string }).subject_name).toBe("inside-the-root");
  });

  it("a path that resolves outside the genome root is refused by name, and nothing it points at is returned", async () => {
    const a = arena();
    // Charter-shaped sentinels where each hostile path lands, so an unchecked read would VALIDATE and
    // echo them — plus a non-JSON sentinel, so a parse error that quotes its input would leak it too.
    mkdirSync(join(a.base, "d1", "etc"), { recursive: true });
    writeFileSync(join(a.base, "d1", "etc", "passwd"), charter(SENTINEL));   // root/../../etc/passwd
    writeFileSync(join(a.sibling, "charter.json"), charter(SENTINEL));       // the prefix-sharing sibling
    writeFileSync(join(a.parent, "secret.txt"), `root:x:0:0:${SENTINEL}\n`); // not JSON
    const cases: Array<[string, string]> = [
      ["../../etc/passwd", "a relative path that climbs out of the root"],
      [join(a.parent, "secret.txt"), "an absolute path outside the root"],
      [join(a.sibling, "charter.json"), "an absolute path into a directory whose NAME shares the root's prefix"],
      ["../g-sibling/charter.json", "a relative path into the prefix-sharing sibling"],
      [`${a.root}/../g-sibling/charter.json`, "an absolute path that starts with the root, then climbs out"],
      [join(a.root, "a\u0000b.json"), "a NUL byte"],
    ];
    for (const [path, why] of cases) {
      const before = snapshot(a.base);
      const r = await surface({ genome_dir: a.root }).call("charter_read", { path });
      expectRefusedByName(r, `charter_read of ${JSON.stringify(path)} (${why})`);
      expect.soft(JSON.stringify(r), `charter_read of ${JSON.stringify(path)} (${why}) returned bytes from OUTSIDE the root`).not.toContain(SENTINEL);
      expect.soft(snapshot(a.base), `charter_read of ${JSON.stringify(path)} changed the filesystem`).toEqual(before);
    }
  });

  it("with no genome root there is no inside: charter_read refuses by name rather than reading an arbitrary path", async () => {
    const a = arena();
    writeFileSync(join(a.sibling, "charter.json"), charter(SENTINEL));
    const r = await surface({}).call("charter_read", { path: join(a.sibling, "charter.json") });
    expectRefusedByName(r, "charter_read with no genome root");
    expect(JSON.stringify(r), "charter_read with no genome root returned the file's contents").not.toContain(SENTINEL);
  });
});
