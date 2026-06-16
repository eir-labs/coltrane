// Audit follow-up — the write-path restatements (the MCP handler + the on-disk persist format)
// must carry what the schema declares, verified on the REAL path: dispatchTool(handler) → persist
// → loadGenome(reload). The bug class this pins: a field the schema/constructor preserve, but the
// HANDLER drops (standard_compose) or the PERSIST FORMAT can't reload (skill_define wrote a flat
// file the package-loader skips). Unit tests on the constructor missed both — only the handler+
// reload path shows them. See the consolidation audit in docs/genome-schema-consolidation.md.
import { describe, it, expect } from "vitest";
import { TEST_BEHAVIOR } from "./_support/agents.js";
import { dispatchTool, type ServerDeps } from "../src/server.js";
import { loadGenome } from "../src/loader.js";
import { createRegistry } from "../src/registry.js";
import { createOutputStore } from "../src/outputs.js";
import { MemoryLedger } from "../src/ledger.js";
import type { Agent } from "../src/composition.js";
import { mkdtempSync, cpSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const REPO = process.cwd();
const sensor: Agent = { ...TEST_BEHAVIOR, slug: "sensor", primitives: ["SENSE"], input_types: [], output_types: ["raw-note"], domain: "demo" };

function seedGenome(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  for (const d of ["core_types", "domain_types", "agents", "standards", "skills", "evals"]) {
    const src = join(REPO, d);
    if (existsSync(src)) cpSync(src, join(dir, d), { recursive: true });
  }
  return dir;
}

function deps(dir: string): ServerDeps {
  const registry = createRegistry();
  return { registry, outputs: createOutputStore(registry), ledger: new MemoryLedger(), standards: new Map(), skills: new Map(), genome_dir: dir };
}

// ── Standard · D — the handler must thread every passthrough field, not just eval_slugs ──────────
describe("standard_compose handler threads the full gig contract (audit D)", () => {
  it("max_examine_rounds / input_types / output_types survive compose → persist → reload", async () => {
    const dir = seedGenome("coltrane-stdrt-");
    const r = await dispatchTool("standard_compose", {
      slug: "contract-rt",
      domain: "demo",
      agents: [sensor],
      phases: [{ name: "sense", chairs: [{ role: "sense", agent_slug: "sensor", depends_on: [], input_contract: [], output_contract: ["raw-note"], required_skills: [] }] }],
      input_types: ["seed-input"],
      output_types: ["raw-note"],
      max_examine_rounds: 3,
      description: "a standard authored via the tool carrying the full contract",
    }, deps(dir));
    expect(r.ok, JSON.stringify(r)).toBe(true);

    // persisted file carries the fields the handler used to drop
    const onDisk = JSON.parse(readFileSync(join(dir, "standards", "contract-rt.json"), "utf8"));
    expect(onDisk.max_examine_rounds, "max_examine_rounds dropped by the handler/persist").toBe(3);
    expect(onDisk.output_types, "output_types dropped").toEqual(["raw-note"]);
    expect(onDisk.input_types, "input_types dropped").toEqual(["seed-input"]);
    expect(onDisk.description, "description dropped").toBeTruthy();

    // and a fresh load preserves them (the loader → composeStandard path is loss-free)
    const g = loadGenome(dir);
    const std = g.standards.get("contract-rt") as Record<string, unknown> | undefined;
    expect(std?.["max_examine_rounds"]).toBe(3);
    expect(std?.["output_types"]).toEqual(["raw-note"]);
  });
});

// ── Skill · E — skill_define must write a LOADABLE PACKAGE, not a flat file the loader skips ─────
describe("skill_define persists a loadable package (audit E)", () => {
  it("a skill defined via the handler reloads (write format == loader's read format)", async () => {
    const dir = seedGenome("coltrane-skillrt-");
    const r = await dispatchTool("skill_define", {
      slug: "roundtrip-skill",
      description: "defined via the handler; must survive reload",
      determinism_ratio: 1,
      permission: { tier: 0 },
      code: "export default ({x}) => ({y: x + 1});",
      fixtures: [{ id: "fx1", input: { x: 1 }, expected_output: { y: 2 } }],
    }, deps(dir));
    expect(r.ok, JSON.stringify(r)).toBe(true);

    // wrote the package layout (meta.json + skill.mjs + fixtures/), not a flat skills/<slug>.json
    expect(existsSync(join(dir, "skills", "roundtrip-skill", "meta.json")), "no meta.json — not a package").toBe(true);
    expect(existsSync(join(dir, "skills", "roundtrip-skill", "skill.mjs")), "code half not written").toBe(true);
    expect(existsSync(join(dir, "skills", "roundtrip-skill.json")), "wrote the retired flat file").toBe(false);

    // the roundtrip the flat format broke: a fresh load carries the skill (was `removed` on reload)
    const g = loadGenome(dir);
    const sk = g.skills.get("roundtrip-skill") as Record<string, unknown> | undefined;
    expect(sk, "skill vanished on reload — write format ≠ loader's package format").toBeTruthy();
    expect(sk?.["determinism_ratio"]).toBe(1);
    expect(g.load_errors.filter((e) => e.kind === "skill"), "skill package failed to load").toEqual([]);
  });

  it("refuses an incomplete package the loader would reject (no fixtures)", async () => {
    const dir = seedGenome("coltrane-skillbad-");
    const r = await dispatchTool("skill_define", {
      slug: "no-fixtures",
      code: "export default () => ({});",
    }, deps(dir));
    expect(r.ok, "should refuse a fixtureless package rather than crash the next load").toBe(false);
    expect(String(r.error)).toMatch(/fixture/i);
    expect(existsSync(join(dir, "skills", "no-fixtures")), "wrote a package that can't load").toBe(false);
  });
});

// ── DomainType · E — type_register persists a record the loader validates against DomainTypeSchema ──
describe("type_register persists a schema-valid record that reloads (audit DomainType)", () => {
  it("a registered type reloads with version + status, validated against DomainTypeSchema", async () => {
    const dir = seedGenome("coltrane-typert-");
    const r = await dispatchTool("type_register", {
      slug: "roundtrip-type",
      extends: "Signal",
      domain: "demo",
      schema: { properties: { note: { type: "string" } } },
      required_fields: ["note"],
      reason: "audit roundtrip",
    }, deps(dir));
    expect(r.ok, JSON.stringify(r)).toBe(true);

    // persisted with the server-assigned fields the authored surface omits
    const onDisk = JSON.parse(readFileSync(join(dir, "domain_types", "roundtrip-type.json"), "utf8"));
    expect(onDisk.version).toBe(1);
    expect(onDisk.status).toBe("active");

    // a fresh load validates it against DomainTypeSchema (status enum + version) — no load error
    const g = loadGenome(dir);
    expect(g.load_errors.filter((e) => e.kind === "domain_type"), "type failed schema validation on load").toEqual([]);
    expect(g.domain_types.get("roundtrip-type@1"), "type vanished on reload").toBeTruthy();
  });
});
