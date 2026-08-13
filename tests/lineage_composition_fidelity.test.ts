// RED SPEC — lineage-record-typing-v1 (Item 4): composition fidelity, which today is ONLY a
// promise. The standard says the compose seat "introduces no new source and draws no new edge"
// (standards/lineage-pass-v1.json:75, "Create only from upstream; introduce no new source").
// That is prose with no enforcement: a scribe that invented an edge or a source would seal
// successfully right now.
//
// This is the half JSON Schema CANNOT reach — a cross-input referential-integrity predicate:
//   connections(record) ⊆ edges(consumed lineage-map)
//   sources(external_body) ⊆ hits ∪ { entries explicitly marked status:not-reached }
// It is the classic subset metamorphic relation. It needs code AND a signature change at the
// seal boundary: checkWritable today receives only {core_type, domain_type, data} and never sees
// input_refs (src/outputs.ts:515,638), so it cannot resolve the consumed map/hits via
// outputs.get(). Wiring input_refs into the gate and rejecting any connection or source absent
// upstream is the load-bearing engineering of this spec.
//
// RED today: with no check, the record with an invented edge / an unbacked reached source SEALS.
// GREEN when the seal boundary resolves input_refs and rejects. Every input below is a REAL
// record written through the same store, so the seal has something real to be held against.
import { describe, it, expect } from "vitest";
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

function realStore(): OutputStore {
  return createOutputStore(loadRegistry(loadGenome(REPO_ROOT)));
}

function edge(over: Record<string, unknown> = {}): Record<string, unknown> {
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

/** Seat the consumed lineage-map (the weaver's associate output) into the store, return its id. */
function seedMap(store: OutputStore, edges: Record<string, unknown>[]): string {
  const rec = store.write({
    core_type: "Interpretation",
    domain_type: "lineage-map",
    domain: "lineage",
    gig_id: "lineage-typing-g2",
    agent_slug: "lineage-weaver",
    primitive: "INTERPRET",
    data: { claims: ["the lineage was drawn"], edges },
  });
  return rec.id;
}

/** Seat one external lineage-hit (an identify-external output) into the store, return its id. */
function seedHit(store: OutputStore, source: string): string {
  const rec = store.write({
    core_type: "Signal",
    domain_type: "lineage-hit",
    domain: "lineage",
    gig_id: "lineage-typing-g2",
    agent_slug: "lineage-scout-external",
    primitive: "SENSE",
    data: { source, claim: `read from ${source}` },
  });
  return rec.id;
}

/** A record consuming exactly the supplied inputs; `data` names the connections/external_body. */
function recordWrite(input_refs: string[], data: Record<string, unknown>): OutputWrite {
  return {
    core_type: "Artifact",
    domain_type: "lineage-record",
    domain: "lineage",
    gig_id: "lineage-typing-g2",
    agent_slug: "lineage-scribe",
    primitive: "CREATE",
    input_refs,
    data: {
      internal_inventory: [{ reference: "genome/InstitutionSchema.lineage" }],
      gap: "none material",
      alignment_recommendation: "cite PROV-DM",
      validation_criteria: ["every connection corresponds to an edge in the consumed map"],
      ...data,
    },
  };
}

describe("I7 — a connection absent from the consumed lineage-map fails to seal", () => {
  it("a record whose connection's (internal_ref, external_ref, relation) triple is not an edge in its input map is refused", () => {
    const store = realStore();
    const mapId = seedMap(store, [edge({ internal_ref: "A", external_ref: "B", relation: "aligns-with" })]);
    const invented = edge({ internal_ref: "GHOST", external_ref: "NOWHERE", relation: "supersedes" });
    expect(() =>
      store.write(recordWrite([mapId], { connections: [invented], external_body: [] })),
    ).toThrow(OutputStoreError);
  });

  it("control: a record whose every connection IS an edge in the consumed map seals", () => {
    const store = realStore();
    const drawn = edge({ internal_ref: "A", external_ref: "B", relation: "aligns-with" });
    const mapId = seedMap(store, [drawn]);
    const rec = store.write(recordWrite([mapId], { connections: [edge({ internal_ref: "A", external_ref: "B", relation: "aligns-with" })], external_body: [] }));
    expect(rec.id).toBeTruthy();
  });
});

describe("I8 — a status:reached external_body source with no backing lineage-hit fails to seal", () => {
  it("a reached source absent from the consumed hits is refused", () => {
    const store = realStore();
    const mapId = seedMap(store, [edge()]);
    const hitId = seedHit(store, "W3C PROV-DM");
    const body = { source: "FABRICATED SOURCE", status: "reached", note: "never actually fetched" };
    expect(() =>
      store.write(recordWrite([mapId, hitId], { connections: [edge()], external_body: [body] })),
    ).toThrow(OutputStoreError);
  });

  it("the SAME body marked status:not-reached is admissible (a named sweep boundary, not a fabricated source)", () => {
    const store = realStore();
    const mapId = seedMap(store, [edge()]);
    const hitId = seedHit(store, "W3C PROV-DM");
    const body = { source: "a body named but not reached", status: "not-reached", note: "out of scope this sweep" };
    const rec = store.write(recordWrite([mapId, hitId], { connections: [edge()], external_body: [body] }));
    expect(rec.id).toBeTruthy();
  });

  it("control: a reached source that IS one of the consumed hits seals", () => {
    const store = realStore();
    const mapId = seedMap(store, [edge()]);
    const hitId = seedHit(store, "W3C PROV-DM");
    const body = { source: "W3C PROV-DM", status: "reached", note: "primary fetched" };
    const rec = store.write(recordWrite([mapId, hitId], { connections: [edge()], external_body: [body] }));
    expect(rec.id).toBeTruthy();
  });
});

describe("I9 (composition half) — the carried strength equals the drawing edge's strength", () => {
  it("a connection whose strength disagrees with its matched map edge fails to seal", () => {
    const store = realStore();
    const mapId = seedMap(store, [edge({ internal_ref: "A", external_ref: "B", relation: "aligns-with", strength: "conceptual-analogy" })]);
    const louder = edge({ internal_ref: "A", external_ref: "B", relation: "aligns-with", strength: "dereferenceable-both-sides" });
    expect(() =>
      store.write(recordWrite([mapId], { connections: [louder], external_body: [] })),
    ).toThrow(OutputStoreError);
  });

  it("control: a connection carrying the drawing edge's strength unchanged seals", () => {
    const store = realStore();
    const mapId = seedMap(store, [edge({ internal_ref: "A", external_ref: "B", relation: "aligns-with", strength: "conceptual-analogy" })]);
    const carried = edge({ internal_ref: "A", external_ref: "B", relation: "aligns-with", strength: "conceptual-analogy" });
    const rec = store.write(recordWrite([mapId], { connections: [carried], external_body: [] }));
    expect(rec.id).toBeTruthy();
  });
});
