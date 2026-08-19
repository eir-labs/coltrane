// lineage-pass — the formal ESTABLISH-LINEAGE standard. A lineage pass senses BOTH the external
// body of prior work (papers, precedent, who solved this and what they arrived at) AND the internal
// state (our repo/genome/wiki), and its core act is DRAWING THE CONNECTION between them — the edges
// that say "our X descends-from / aligns-with / diverges-from / supersedes / informed-by their Y",
// each grounded with a real external source and a real internal reference. The connection IS the
// lineage. The output is a formal lineage-record that, on human approval, becomes first-class
// lineage attached to an institution so every seated agent inherits it as grounding.
//
// RED-first: written against a genome that has none of the lineage-pass types, agents, or standard,
// and an InstitutionSchema with no lineage attachment. Every assertion is a SIDE EFFECT (a type
// validates/rejects an instance, a chair is seated with an exact grant, the schema parses a lineage
// ref), not a bare parse. The genome files + the one Zod source make it green; nothing else may.
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { loadGenome } from "../src/loader.js";
import { loadRegistry } from "../src/registry.js";
import {
  InstitutionSchema,
  LineageRecordRefSchema,
  institutionLineageGrounding,
  zodToMcpProps,
} from "../src/genome_schema.js";
import { FLOOR, RETRIEVAL, JUDGE_FAMILY, SHAPER, MAKER } from "./_support/behavioral_families.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const genome = loadGenome(REPO);
const registry = loadRegistry(genome);

// A sealed-genome expectation: the lineage files must load cleanly, exactly like every other
// committed genome class (bootstrap_genome.test.ts holds the whole genome to load_errors === []).
describe("lineage-pass — the genome loads it cleanly", () => {
  it("no load error touches any lineage file", () => {
    const lineageErrors = genome.load_errors.filter(
      (e) => typeof e.slug === "string" && e.slug.startsWith("lineage"),
    );
    expect(lineageErrors, JSON.stringify(lineageErrors)).toEqual([]);
  });
});

describe("lineage domain types — extend the six, validate instances, reject malformed", () => {
  // Bare-slug lookup: lineage-record moved to @2 under lineage-record-typing-v1, so a hardcoded
  // @1 no longer resolves it. The bare slug resolves each type at its current version.
  const extendsOf = (slug: string) => genome.domain_types.get(slug)?.extends;

  it("the lineage types are registered, each extending the right core primitive", () => {
    expect(extendsOf("lineage-question")).toBe("Signal");
    expect(extendsOf("lineage-hit")).toBe("Signal");
    expect(extendsOf("internal-inventory")).toBe("Signal");
    expect(extendsOf("lineage-map")).toBe("Interpretation");
    expect(extendsOf("alignment-plan")).toBe("Plan");
    expect(extendsOf("lineage-record")).toBe("Artifact");
    expect(extendsOf("lineage-verdict")).toBe("Verdict");
  });

  it("lineage-question accepts a question+scopes signal and rejects one with no question", () => {
    expect(
      registry.validate({
        core_type: "Signal",
        domain_type: "lineage-question",
        data: { question: "Where does our sealing discipline descend from?", internal_scope: "genome", external_scope: "provenance literature" },
      }).valid,
    ).toBe(true);
    expect(
      registry.validate({ core_type: "Signal", domain_type: "lineage-question", data: { internal_scope: "genome" } }).valid,
    ).toBe(false);
  });

  it("lineage-hit is one EXTERNAL source: a source+claim, rejected without a claim", () => {
    expect(
      registry.validate({
        core_type: "Signal",
        domain_type: "lineage-hit",
        data: { source: "Merkle 1987", claim: "content-addressed hash trees seal tamper-evidence", attribution: "R. Merkle", url: "https://example.org/merkle" },
      }).valid,
    ).toBe(true);
    expect(
      registry.validate({ core_type: "Signal", domain_type: "lineage-hit", data: { source: "Merkle 1987" } }).valid,
    ).toBe(false);
  });

  it("internal-inventory carries our representations, each with a reference", () => {
    expect(
      registry.validate({
        core_type: "Signal",
        domain_type: "internal-inventory",
        data: { representations: [{ reference: "src/genome_schema.ts:LineageEdgeSchema", kind: "code", summary: "typed lineage edges" }] },
      }).valid,
    ).toBe(true);
    expect(
      registry.validate({ core_type: "Signal", domain_type: "internal-inventory", data: {} }).valid,
    ).toBe(false);
  });

  it("lineage-map IS the established lineage: grounded connection edges over a closed relation set", () => {
    const goodEdge = {
      internal_ref: "src/genome_schema.ts:LineageEdgeSchema",
      external_ref: "Merkle 1987",
      relation: "descends-from",
      grounding_internal: "the LineageEdgeSchema typed-edge vocabulary",
      grounding_external: "hash-tree tamper-evidence, Merkle 1987 §3",
      // v2 (lineage-record-typing-v1, O7): the weaver's edge now REQUIRES a closed-vocab grounding
      // strength. A well-formed edge carries it; the negatives below stay red for their own reasons.
      strength: "dereferenceable-both-sides",
    };
    expect(
      registry.validate({ core_type: "Interpretation", domain_type: "lineage-map", data: { edges: [goodEdge] } }).valid,
    ).toBe(true);
    // the connection relation is a CLOSED set — a relation outside it is not a lineage relation
    expect(
      registry.validate({
        core_type: "Interpretation",
        domain_type: "lineage-map",
        data: { edges: [{ ...goodEdge, relation: "vaguely-related-to" }] },
      }).valid,
    ).toBe(false);
    // an edge with no external grounding is a claim, not a lineage
    expect(
      registry.validate({
        core_type: "Interpretation",
        domain_type: "lineage-map",
        data: { edges: [{ internal_ref: "x", external_ref: "y", relation: "aligns-with", grounding_internal: "i" }] },
      }).valid,
    ).toBe(false);
  });

  it("lineage-map declares the full relation vocabulary the pass draws", () => {
    const dt = genome.domain_types.get("lineage-map@1");
    const relEnum = (((dt?.schema as any)?.properties?.edges?.items?.properties?.relation?.enum) ?? []) as string[];
    expect(new Set(relEnum)).toEqual(
      new Set(["descends-from", "aligns-with", "diverges-from", "supersedes", "informed-by"]),
    );
  });

  it("lineage-record is the formal publishable artifact: body + inventory + connections + gap + recommendation", () => {
    const full = {
      // v2 (lineage-record-typing-v1): external_body carries a closed reached|not-reached status,
      // each connection carries the map edge's full shape + a closed-vocab strength. The record
      // still validates when well-formed; the noGap negative below stays red for the missing gap.
      external_body: [{ source: "Merkle 1987", status: "reached", note: "hash trees" }],
      internal_inventory: [{ reference: "src/genome_schema.ts" }],
      connections: [{ internal_ref: "x", external_ref: "y", relation: "descends-from", grounding_internal: "i", grounding_external: "e", strength: "dereferenceable-both-sides" }],
      gap: "no explicit citation of Merkle in the genome",
      alignment_recommendation: "attribute the sealing discipline to the hash-tree lineage",
    };
    expect(registry.validate({ core_type: "Artifact", domain_type: "lineage-record", data: full }).valid).toBe(true);
    const { gap, ...noGap } = full;
    expect(registry.validate({ core_type: "Artifact", domain_type: "lineage-record", data: noGap }).valid).toBe(false);
  });

  it("lineage-verdict is the quality gate on the record", () => {
    expect(
      registry.validate({ core_type: "Verdict", domain_type: "lineage-verdict", data: { rationale: "every edge is grounded both sides" } }).valid,
    ).toBe(true);
    expect(
      registry.validate({ core_type: "Verdict", domain_type: "lineage-verdict", data: {} }).valid,
    ).toBe(false);
  });
});

describe("lineage-pass-v1 — the standard's phase/chair graph", () => {
  const std = genome.standards.get("lineage-pass-v1");
  const chairOf = (role: string) =>
    std?.phases.flatMap((p) => p.chairs).find((c) => c.role === role);

  it("the standard composed and seeds on a lineage-question", () => {
    expect(std, "lineage-pass-v1 must load and compose").toBeTruthy();
    expect(std?.input_types).toContain("lineage-question");
    expect(std?.output_types).toEqual(expect.arrayContaining(["lineage-record", "lineage-verdict"]));
  });

  it("identify is ONE phase with TWO parallel entry chairs — external and internal senses", () => {
    const identify = std?.phases.find((p) => p.name === "identify");
    expect(identify?.chairs).toHaveLength(2);
    const roles = identify!.chairs.map((c) => c.role).sort();
    expect(roles).toEqual(["identify-external", "identify-internal"]);
    // both are entry chairs (no upstream) reading the gig's lineage-question
    for (const c of identify!.chairs) {
      expect(c.depends_on).toEqual([]);
      expect(c.input_contract).toContain("lineage-question");
    }
  });

  it("the external sense seals lineage-hits; the internal sense seals an internal-inventory", () => {
    expect(chairOf("identify-external")?.agent_slug).toBe("lineage-scout-external");
    expect(chairOf("identify-external")?.output_contract).toEqual(["lineage-hit"]);
    expect(chairOf("identify-internal")?.agent_slug).toBe("lineage-scout-internal");
    expect(chairOf("identify-internal")?.output_contract).toEqual(["internal-inventory"]);
  });

  it("least authority: each identifier holds ONLY its own sensing tools — the grants are disjoint", () => {
    const ext = genome.agents.get("lineage-scout-external")!;
    const int = genome.agents.get("lineage-scout-internal")!;
    // external senses the web
    expect(ext.allowed_tools).toEqual(expect.arrayContaining(["WebSearch", "WebFetch"]));
    expect((ext.allowed_tools ?? []).some((t) => t.startsWith("mcp__eir-wiki"))).toBe(false);
    expect(ext.allowed_tools).not.toContain("Read");
    // internal senses the FILE STORE only (OSS: no eir-wiki — it is not open source). Read/Glob/Grep
    // resolve in any execution environment; the wiki server does not.
    expect(int.allowed_tools).toEqual(
      expect.arrayContaining(["Read", "Glob", "Grep"]),
    );
    expect((int.allowed_tools ?? []).some((t) => t.startsWith("mcp__eir-wiki"))).toBe(false);
    expect(int.allowed_tools).not.toContain("WebSearch");
    expect(int.allowed_tools).not.toContain("WebFetch");
  });

  it("associate is the core act — no external tools, reasons over both senses, draws the lineage-map", () => {
    const assoc = chairOf("associate")!;
    expect(assoc.agent_slug).toBe("lineage-weaver");
    expect(assoc.depends_on).toEqual(expect.arrayContaining(["identify-external", "identify-internal"]));
    expect(assoc.input_contract).toEqual(expect.arrayContaining(["lineage-hit", "internal-inventory"]));
    expect(assoc.output_contract).toEqual(["lineage-map"]);
    expect(genome.agents.get("lineage-weaver")!.allowed_tools ?? []).toEqual([]);
  });

  it("assess judges the gap + alignment recommendation off the drawn lineage", () => {
    const assess = chairOf("assess")!;
    expect(assess.depends_on).toContain("associate");
    expect(assess.input_contract).toContain("lineage-map");
    expect(assess.output_contract).toEqual(["alignment-plan"]);
  });

  it("compose creates the formal lineage-record", () => {
    const compose = chairOf("compose")!;
    expect(compose.agent_slug).toBe("lineage-scribe");
    expect(compose.output_contract).toEqual(["lineage-record"]);
  });

  it("approve is a HUMAN chair that seals the lineage-verdict and parks the run on an absent yes", () => {
    const approve = chairOf("approve")!;
    expect(approve.human).toBe(true);
    expect(approve.agent_slug ?? "").toBe("");
    expect(approve.output_contract).toEqual(["lineage-verdict"]);
  });
});

describe("the lineage agents clear the behavioral floor for what they do", () => {
  it("both scouts owe retrieval discipline (external substrate) and carry it verbatim", () => {
    for (const slug of ["lineage-scout-external", "lineage-scout-internal"]) {
      const a = genome.agents.get(slug)!;
      for (const s of [...FLOOR, ...RETRIEVAL]) expect(a.constraints, `${slug} missing "${s.slice(0, 40)}…"`).toContain(s);
    }
  });
  it("the weaver reshapes (SHAPER) and adjudicates (JUDGE); the scribe makes (MAKER)", () => {
    const weaver = genome.agents.get("lineage-weaver")!;
    for (const s of [...JUDGE_FAMILY, ...SHAPER]) expect(weaver.constraints).toContain(s);
    const scribe = genome.agents.get("lineage-scribe")!;
    for (const s of MAKER) expect(scribe.constraints).toContain(s);
  });
});

describe("the institution-lineage seam — approved lineage becomes first-class grounding", () => {
  it("an institution defaults to no lineage, and carries lineage-record references when granted", () => {
    const bare = InstitutionSchema.parse({ slug: "coltrane", name: "Coltrane", kind: "institution" });
    expect(bare.lineage).toEqual([]);
    const grounded = InstitutionSchema.parse({
      slug: "coltrane",
      name: "Coltrane",
      kind: "institution",
      lineage: [{ record_ref: "sha256:deadbeef", question: "where does sealing descend from?" }],
    });
    expect(grounded.lineage).toHaveLength(1);
    expect(grounded.lineage[0]!.record_ref).toBe("sha256:deadbeef");
    // unapproved until a human seals it — the approve chair's verdict fills approved_by
    expect(grounded.lineage[0]!.approved_by).toBeNull();
  });

  it("a lineage reference with no record to point at does not parse — it references nothing", () => {
    expect(() => LineageRecordRefSchema.parse({ question: "orphan" })).toThrow();
  });

  it("the seam is MCP-surfaceable as an array, and the surfacing helper reads an institution's lineage", () => {
    expect(zodToMcpProps(InstitutionSchema)["lineage"]).toBe("array");
    const inst = InstitutionSchema.parse({
      slug: "coltrane",
      name: "Coltrane",
      kind: "institution",
      lineage: [{ record_ref: "sha256:cafe" }],
    });
    // every agent seated in the institution inherits these refs as formal grounding
    expect(institutionLineageGrounding(inst).map((r) => r.record_ref)).toEqual(["sha256:cafe"]);
  });
});
