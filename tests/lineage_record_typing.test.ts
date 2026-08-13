// RED SPEC — lineage-record-typing-v1 (Items 1-3): the published artifact of the lineage
// pass must be held to at least the bar the map one phase upstream already meets, PLUS a
// REQUIRED closed-vocabulary per-edge grounding strength that neither type carries yet.
//
// THE DEFECT (found by running the pass twice): domain_types/lineage-record.json declares
// external_body / internal_inventory / connections as bare {"type":"array"} with NO item
// shape, while domain_types/lineage-map.json ONE PHASE UPSTREAM fully specifies its edges
// (closed relation enum, both-side grounding, minItems 1). The pipeline is ENFORCED AT THE
// WEAVER and merely DECLARED AT THE SCRIBE — the map cannot hold an ungrounded edge; the
// record it composes into can seal `connections:[1,2,3]`.
//
// These tests load the REAL repo genome from disk (loadGenome/loadRegistry), so they run
// against the actual lineage-record type at the actual seal boundary (outputs.write →
// registry.validate at src/outputs.ts:567, closed-by-default Ajv from src/registry.ts:240).
// They are RED today because the loose v1 schema accepts what the contract forbids; they go
// GREEN when domain_types/lineage-record.json is tightened to v2. Every failure comes from an
// ASSERTION (a seal that should throw and does not), never from a type error — the base record
// below already carries a non-empty validation_criteria[] so the Artifact substance floor
// (src/output_validation.ts:81) is satisfied and cannot mask the shape defect under test.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  loadGenome,
  loadRegistry,
  createOutputStore,
  OutputStoreError,
  type OutputStore,
  type OutputWrite,
} from "../src";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const RECORD_TYPE_PATH = fileURLToPath(new URL("../domain_types/lineage-record.json", import.meta.url));
const MAP_TYPE_PATH = fileURLToPath(new URL("../domain_types/lineage-map.json", import.meta.url));

// The three closed grounding-strength tiers (Item 1 / O2). Ordinal, keyed to HOW an edge is
// grounded — the distinction record 03cacf6a invented as prose ("fully" vs "conceptual").
const STRENGTH = ["dereferenceable-both-sides", "structural-correspondence", "conceptual-analogy"] as const;
const RELATIONS = ["descends-from", "aligns-with", "diverges-from", "supersedes", "informed-by"] as const;
// The five fields lineage-map's edge already requires — the floor the connection item must meet
// or exceed. `strength` is the SIXTH, new field and is exercised separately by I3.
const MAP_EDGE_REQUIRED = ["internal_ref", "external_ref", "relation", "grounding_internal", "grounding_external"];

function realStore(): OutputStore {
  return createOutputStore(loadRegistry(loadGenome(REPO_ROOT)));
}

/** A connection at the v2 bar: >= lineage-map's edge, plus a closed-vocab grounding strength. */
function validConnection(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    internal_ref: "genome/InstitutionSchema.lineage",
    external_ref: "W3C PROV-DM section 2.1",
    relation: "aligns-with",
    grounding_internal: "src/genome_schema.ts:293",
    grounding_external: "https://www.w3.org/TR/prov-dm/",
    strength: "dereferenceable-both-sides",
    ...over,
  };
}

/** A lineage-record that seals under BOTH the loose v1 type and the tightened v2 type — so the
 *  positive assertions stay green across the change and only the perturbed negatives flip. */
function validRecord(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    external_body: [{ source: "W3C PROV-DM", status: "reached", note: "primary fetched and quoted" }],
    internal_inventory: [{ reference: "genome/InstitutionSchema.lineage", kind: "schema", summary: "institution lineage field" }],
    connections: [validConnection()],
    gap: "our lineage field carries no per-edge grounding strength",
    alignment_recommendation: "adopt a closed grounding-strength vocabulary drawn on the map edge",
    validation_criteria: ["every connection is grounded on both sides and carries a closed-vocab strength"],
    ...over,
  };
}

function recordWrite(over: Partial<OutputWrite> = {}): OutputWrite {
  const { data, ...rest } = over;
  return {
    core_type: "Artifact",
    domain_type: "lineage-record",
    domain: "lineage",
    gig_id: "lineage-typing-g1",
    agent_slug: "lineage-scribe",
    primitive: "CREATE",
    ...rest,
    data: (data ?? validRecord()) as Record<string, unknown>,
  };
}

describe("lineage-record typing — control: a fully-valid v2-shaped record still seals", () => {
  it("accepts a record whose connections carry the full edge shape + a legal grounding strength", () => {
    const store = realStore();
    const rec = store.write(recordWrite());
    expect(rec.id).toBeTruthy();
    expect(rec.domain_type).toBe("lineage-record");
  });
});

describe("I1 — connections must be typed objects, never a bag of scalars", () => {
  it("a lineage-record with connections:[1,2,3] fails to seal", () => {
    const store = realStore();
    expect(() => store.write(recordWrite({ data: validRecord({ connections: [1, 2, 3] }) }))).toThrow(OutputStoreError);
  });
});

describe("I2 — a connection is at least as strict as lineage-map's edge", () => {
  it("property: dropping any required connection field fails the seal", () => {
    const store = realStore();
    fc.assert(
      fc.property(fc.constantFrom(...MAP_EDGE_REQUIRED), (dropped) => {
        const c = validConnection();
        delete c[dropped];
        let threw = false;
        try {
          store.write(recordWrite({ data: validRecord({ connections: [c] }) }));
        } catch {
          threw = true;
        }
        return threw;
      }),
    );
  });

  it("property: a relation outside the closed enum fails the seal", () => {
    const store = realStore();
    fc.assert(
      fc.property(fc.string(), (rel) => {
        if ((RELATIONS as readonly string[]).includes(rel)) return true; // legal value — not under test
        let threw = false;
        try {
          store.write(recordWrite({ data: validRecord({ connections: [validConnection({ relation: rel })] }) }));
        } catch {
          threw = true;
        }
        return threw;
      }),
    );
  });
});

describe("I3 — a required per-edge grounding strength from a CLOSED vocabulary", () => {
  it("a connection with no grounding strength fails to seal", () => {
    const store = realStore();
    const noStrength = validConnection();
    delete noStrength.strength;
    expect(() => store.write(recordWrite({ data: validRecord({ connections: [noStrength] }) }))).toThrow(OutputStoreError);
  });

  it("a connection whose strength is free prose ('fully') fails to seal", () => {
    const store = realStore();
    // record 03cacf6a invented "fully — dereferenceable internal citation on both sides" as a
    // SENTENCE; a closed vocabulary makes that unrepresentable.
    expect(() => store.write(recordWrite({ data: validRecord({ connections: [validConnection({ strength: "fully" })] }) }))).toThrow(
      OutputStoreError,
    );
  });

  it("property: every legal strength value seals; every out-of-vocabulary value refuses", () => {
    const store = realStore();
    fc.assert(
      fc.property(fc.oneof(fc.constantFrom(...STRENGTH), fc.string()), (value) => {
        const legal = (STRENGTH as readonly string[]).includes(value);
        let threw = false;
        try {
          store.write(recordWrite({ data: validRecord({ connections: [validConnection({ strength: value })] }) }));
        } catch {
          threw = true;
        }
        return legal ? !threw : threw;
      }),
    );
  });
});

describe("I4 — grounding strength is SEPARATE from CitationSchema.evidence_grade (orthogonality pinned in the type)", () => {
  it("the connection item declares `strength` with the closed enum and does NOT declare evidence_grade", () => {
    const type = JSON.parse(readFileSync(RECORD_TYPE_PATH, "utf8")) as {
      schema: { properties: { connections: { items?: { properties?: Record<string, { enum?: string[] }> } } } };
    };
    const item = type.schema.properties.connections.items;
    expect(item, "connections must declare an item shape").toBeDefined();
    const props = item!.properties ?? {};
    expect(Object.keys(props)).toContain("strength");
    expect(props.strength?.enum).toEqual([...STRENGTH]);
    // evidence_grade grades the SOURCE's fetch status; it must NOT be smuggled onto the edge.
    expect(Object.keys(props)).not.toContain("evidence_grade");
  });

  it("the strength field carries a $comment forbidding the future merge with evidence_grade", () => {
    // A closed grounding-strength vocabulary and CitationSchema.evidence_grade (archive|attestation,
    // src/genome_schema.ts:293-309) are orthogonal: both endpoints can be archive-grade while the
    // edge between them is a loose conceptual analogy. Collapsing them is the obvious future
    // "simplification" and it would destroy the distinction that made record 03cacf6a legible.
    const raw = readFileSync(RECORD_TYPE_PATH, "utf8");
    const type = JSON.parse(raw) as {
      schema: { properties: { connections: { items?: { properties?: Record<string, { $comment?: string }> } } } };
    };
    const comment = type.schema.properties.connections.items?.properties?.strength?.$comment ?? "";
    expect(comment).toMatch(/evidence_grade/);
    expect(comment).toMatch(/orthogonal/i);
    expect(comment).toMatch(/genome_schema\.ts/);
  });
});

describe("I5 — external_body carries a CLOSED status vocabulary so an unreached body cannot hide as prose", () => {
  it("property: only {reached, not-reached} seal; any other or absent status refuses", () => {
    const store = realStore();
    fc.assert(
      fc.property(fc.oneof(fc.constant(undefined), fc.constantFrom("reached", "not-reached"), fc.string()), (status) => {
        const legal = status === "reached" || status === "not-reached";
        const entry: Record<string, unknown> = { source: "some prior body", note: "a note" };
        if (status !== undefined) entry.status = status;
        let threw = false;
        try {
          store.write(recordWrite({ data: validRecord({ external_body: [entry] }) }));
        } catch {
          threw = true;
        }
        return legal ? !threw : threw;
      }),
    );
  });

  it("an external_body entry missing its status fails to seal", () => {
    const store = realStore();
    expect(() => store.write(recordWrite({ data: validRecord({ external_body: [{ source: "x", note: "n" }] }) }))).toThrow(
      OutputStoreError,
    );
  });
});

describe("I6 — internal_inventory is shaped: each entry carries a checkable reference", () => {
  it("an internal_inventory entry missing its reference fails to seal", () => {
    const store = realStore();
    expect(() =>
      store.write(recordWrite({ data: validRecord({ internal_inventory: [{ kind: "schema", summary: "no locator" }] }) })),
    ).toThrow(OutputStoreError);
  });
});

describe("I9 (static half) — grounding strength is drawn on the map edge, not minted by the scribe", () => {
  it("lineage-map's edge item requires a closed-vocab `strength` field", () => {
    // The seat that DRAWS the edge (the weaver) is the seat that knows how firmly; the scribe
    // carries it through. So the field lands on lineage-map's edge item too.
    const type = JSON.parse(readFileSync(MAP_TYPE_PATH, "utf8")) as {
      schema: { properties: { edges: { items: { properties?: Record<string, { enum?: string[] }>; required?: string[] } } } };
    };
    const item = type.schema.properties.edges.items;
    expect(Object.keys(item.properties ?? {})).toContain("strength");
    expect(item.properties?.strength?.enum).toEqual([...STRENGTH]);
    expect(item.required ?? []).toContain("strength");
  });
});
