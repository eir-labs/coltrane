// RED — a field can be retired through the genome's mouth, not only added.
//
// type_extend merges `extension.schema.properties` / `fields_to_add` into the base properties
// (src/server.ts, case "type_extend": `{ ...baseProps, ...addProps }`), so no MCP verb can remove a
// field. src/type_versioning.ts already classifies a removal (change_class "breaking", approval
// required, a new version); the verb never lets one through. So the last reshaping of red-spec
// (30d1b48) was a hand edit of domain_types/, which CLAUDE.md forbids, and slice 1 of records-by-
// address (retiring red-spec.diffs and change-set.diffs) has no lawful way to land.
//
// `fields_to_retire: string[]` removes each named property, drops it from required_fields, versions
// the type as a breaking change, and refuses a name the type does not declare.
import { describe, it, expect } from "vitest";
import { dispatchTool, type ServerDeps } from "../src/server.js";
import { createRegistry } from "../src/registry.js";
import { createOutputStore } from "../src/outputs.js";
import { MemoryLedger } from "../src/ledger.js";

// In memory, as tests/a_mutation_that_changes_nothing_says_so.test.ts does: a law that pointed these
// verbs at the real genome_dir would rewrite domain_types/ while auditing it.
const PROBE = {
  slug: "probe-record", extends: "Artifact", domain: "test", version: 2,
  schema: { type: "object", properties: { diffs: { type: "array" }, coverage_map: { type: "array" } } },
  required_fields: ["diffs", "coverage_map"],
};

const deps = (): ServerDeps => {
  const registry = createRegistry([PROBE as never]);
  return { registry, outputs: createOutputStore(registry), ledger: new MemoryLedger(), gig_runs: new Map(), agents: new Map() } as unknown as ServerDeps;
};

const probe = (d: ServerDeps) => d.registry.listTypes().find((t) => t.slug === "probe-record")!;

describe("type_extend retires a field", () => {
  it("fields_to_retire removes the property and its requirement in the same breaking version that adds its replacement", async () => {
    const d = deps();
    const r = await dispatchTool("type_extend", {
      slug: "probe-record",
      fields_to_retire: ["diffs"],
      extension: { schema: { properties: { laws: { type: "array" } }, required: ["laws", "coverage_map"] } },
      reason: "records by address: laws replace diffs",
    }, d);
    expect(r.ok, `the retirement was refused: ${JSON.stringify(r)}`).toBe(true);
    const t = probe(d);
    expect(Object.keys((t.schema as { properties: Record<string, unknown> }).properties).sort(),
      "the retired field is still declared: type_extend can only ever add").toEqual(["coverage_map", "laws"]);
    expect([...t.required_fields].sort()).toEqual(["coverage_map", "laws"]);
    expect((r.data as { change_class?: string }).change_class, "removing a field is a breaking change").toBe("breaking");
    expect(r.requires_approval).toBe(true);
    expect(t.version).toBe(3);
  });

  it("retiring a field the type does not declare refuses, naming it", async () => {
    const d = deps();
    const r = await dispatchTool("type_extend", { slug: "probe-record", fields_to_retire: ["patches"], reason: "typo" }, d);
    expect(r.ok, "a retirement of a field that does not exist was reported as a change").toBe(false);
    expect(String(r.error ?? ""), "the refusal must name the field that is not declared").toContain("patches");
    expect(probe(d).version, "a refused retirement must not version the type").toBe(2);
  });

  it("a field cannot be retired while still required by the same call", async () => {
    const d = deps();
    const r = await dispatchTool("type_extend", {
      slug: "probe-record", fields_to_retire: ["diffs"],
      extension: { schema: { required: ["diffs", "coverage_map"] } }, reason: "contradiction",
    }, d);
    expect(r.ok, "a type was versioned requiring a field it no longer declares").toBe(false);
    expect(String(r.error ?? ""), "the refusal must name the field retired and required at once").toContain("diffs");
  });
});
