// RED-first — a schema class that implements published prior art must NAME it, resolvably.
//
// The repo already states the bar in another gate's failure message: "an uncited attribution is a
// claim, not a record" (default_genome_quartet.test.ts). But the only citation shapes in the genome
// are person-shaped (ForebearSchema) or untyped (LineageEdgeSchema.source is z.record(z.unknown()),
// so a check can pass on `{}`). Neither can say "InstitutionalLawSchema descends from this paper."
//
// So InstitutionalLawSchema — which IS Crawford & Ostrom's ADICO grammar — carried only a bare
// name-drop in a comment: no year, no venue, no identifier. NormPairSchema, which is I/O logic's
// (a,x) norm pair, named no source at all. Both gaps were already found and sealed by an approved
// lineage pass (lineage-record-invocable-law-2026-08-11), whose alignment step read: "CITING
// crawford-ostrom-1995-adico and io-logic-makinson-vandertorre-2000 as the grounding sources."
// The structural half of that step shipped; the citing half did not. This pins the citing half.
//
// The load-bearing invariant, and why it mirrors the thing it attributes: an institutional law is
// authorable here only if it reduces to an evaluable predicate over typed inputs. A citation is a
// citation only if it reduces to a resolvable identifier. Same refusal, same grounds — prose that
// cannot be checked does not get to stand as a record.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AttributionRelationSchema,
  CitationSchema,
  SchemaAttributionSchema,
  GENOME_ATTRIBUTIONS,
} from "../src/genome_schema.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const findFor = (subject: string) => GENOME_ATTRIBUTIONS.find((a) => a.subject === subject);

describe("CitationSchema — a citation is resolvable or it is prose", () => {
  const crawfordOstrom = {
    authors: ["Crawford, S.E.S.", "Ostrom, E."],
    year: 1995,
    title: "A Grammar of Institutions",
    venue: "American Political Science Review",
    locator: "89(3): 582–600",
    doi: "10.2307/2082975",
    evidence_grade: "archive" as const,
    // An archive grade CLAIMS a fetch, so the fixture must carry when that fetch happened —
    // this is the same date the GENOME_ATTRIBUTIONS row for Crawford & Ostrom records. Before
    // the CitationSchema refinement this fixture was itself an ungrounded archive claim: the
    // test guarding the grade used the illegal state as its example of a complete citation.
    retrieved_at: "2026-08-13",
  };

  it("parses a complete citation loss-free", () => {
    const parsed = CitationSchema.parse(crawfordOstrom) as Record<string, unknown>;
    for (const [k, v] of Object.entries(crawfordOstrom)) {
      expect(parsed[k], `authored field "${k}" did not survive the parse`).toEqual(v);
    }
  });

  it("REFUSES a citation carrying neither doi nor url — nothing to dereference", () => {
    const { doi: _doi, ...unresolvable } = crawfordOstrom;
    expect(
      () => CitationSchema.parse(unresolvable),
      "a citation with no resolvable identifier parsed — that is prose wearing a citation's shape",
    ).toThrow();
  });

  it("accepts a url as the resolvable identifier when no doi exists", () => {
    const { doi: _doi, ...rest } = crawfordOstrom;
    expect(() =>
      CitationSchema.parse({ ...rest, url: "https://example.org/grammar-of-institutions" }),
    ).not.toThrow();
  });

  it("REQUIRES evidence_grade — the archive/attestation split is data, not narration", () => {
    const { evidence_grade: _g, ...ungraded } = crawfordOstrom;
    expect(
      () => CitationSchema.parse(ungraded),
      "a citation parsed with no evidence grade — fetched primary and declared claim became " +
        "indistinguishable, which is exactly the laundering the discipline forbids",
    ).toThrow();
  });

  it("REFUSES an evidence_grade outside archive | attestation", () => {
    expect(() => CitationSchema.parse({ ...crawfordOstrom, evidence_grade: "probably-fine" })).toThrow();
  });

  it("is STRICT — an unknown field fails rather than riding along unvalidated", () => {
    expect(() => CitationSchema.parse({ ...crawfordOstrom, vibes: "good" })).toThrow();
  });
});

describe("attribution relations must be able to say what a lineage pass FINDS", () => {
  // The defect this pins, found by running the thing: a lineage pass over the institutional layer
  // drew 10 edges — 1 descends-from, 7 aligns-with, 1 informed-by, 1 diverges-from — and only the
  // single descends-from could be written into GENOME_ATTRIBUTIONS, because `relation` reused
  // LineageEdgeTypeSchema ("anchored-in" | "produced-by" | "evolved-from" | "descends-from").
  //
  // That enum is the CAPABILITY vocabulary — its own comment reads "Caps grant these" — so widening
  // it to fit scholarship would widen what a capability grant can scope. The two are different acts:
  // "anchored-in" is meaningless for a paper, "diverges-from" is meaningless as a permission. They
  // get different enums, and this is the invariant that keeps the scholarly one adequate.
  const lineageMapRelations = (): string[] => {
    const doc = JSON.parse(readFileSync(join(REPO_ROOT, "domain_types", "lineage-map.json"), "utf8")) as unknown;
    const found: string[] = [];
    const walk = (n: unknown): void => {
      if (Array.isArray(n)) return n.forEach(walk);
      if (n && typeof n === "object") {
        for (const [k, v] of Object.entries(n as Record<string, unknown>)) {
          if (k === "enum" && Array.isArray(v) && v.includes("descends-from")) found.push(...(v as string[]));
          else walk(v);
        }
      }
    };
    walk(doc);
    return found;
  };

  it("every relation the lineage-map type can emit is expressible as an attribution", () => {
    const emitted = lineageMapRelations();
    expect(emitted.length, "lineage-map declares no relation enum — this guard is reading the wrong field").toBeGreaterThan(0);
    const expressible = new Set(AttributionRelationSchema.options as readonly string[]);
    const unexpressible = emitted.filter((r) => !expressible.has(r));
    expect(
      unexpressible,
      `a lineage pass can find ${JSON.stringify(unexpressible)} and the genome has no way to record it. ` +
        "Findings that cannot be written down are findings the next reader has to rediscover.",
    ).toEqual([]);
  });

  it("attribution relations are NOT the capability vocabulary", () => {
    // Pinned so a later tidy-up does not "simplify" these back into one enum. The first version of
    // this comment gave a CATEGORY reason — "anchored-in says nothing about a paper, diverges-from
    // says nothing as a permission" — which is a matter of taste a future reader may reasonably
    // disagree with. The real reason is PRIVILEGE, verified against the production store:
    //
    //   `coltrane_caps_cover` matches a capability grant on `cap->>'edge_type' = p_edge_type`, and
    //   `coltrane_can_traverse` gates authority through it. edge_type IS the key a grant is scoped
    //   by. Merging the vocabularies therefore makes `{"grant": "informed-by"}` an expressible
    //   capability scope — the vocabulary describing how one idea relates to another would extend
    //   the vocabulary deciding what an agent may traverse.
    //
    // So this is an access-control boundary wearing the shape of a naming preference. LineageEdgeTypeSchema
    // stays the grant vocabulary; AttributionRelationSchema stays scholarly; and the store-side
    // `chancery_lineage_edge.edge_type` CHECK constraint must NOT be widened to admit the scholarly
    // terms either — it needs a separate column or table, for this reason and not for tidiness.
    const attribution = new Set(AttributionRelationSchema.options as readonly string[]);
    expect(attribution.has("aligns-with"), "attribution cannot express a non-descent alignment").toBe(true);
    expect(attribution.has("anchored-in"), "the capability term leaked into the scholarly vocabulary").toBe(false);
    expect(attribution.has("produced-by"), "the capability term leaked into the scholarly vocabulary").toBe(false);
  });
});

describe("GENOME_ATTRIBUTIONS — every attributed schema names its source", () => {
  it("every entry parses loss-free through SchemaAttributionSchema", () => {
    expect(GENOME_ATTRIBUTIONS.length).toBeGreaterThan(0);
    for (const a of GENOME_ATTRIBUTIONS) {
      const parsed = SchemaAttributionSchema.parse(a) as Record<string, unknown>;
      for (const [k, v] of Object.entries(a)) {
        expect(parsed[k], `attribution field "${k}" did not survive the parse`).toEqual(v);
      }
    }
  });

  it("every attribution states what was taken — a bare pointer is not an attribution", () => {
    for (const a of GENOME_ATTRIBUTIONS) {
      expect(a.what_taken.length, `attribution for "${a.subject}" takes nothing`).toBeGreaterThan(0);
    }
  });

  it("InstitutionalLawSchema descends from Crawford & Ostrom (1995), archive-grade", () => {
    const a = findFor("InstitutionalLawSchema");
    expect(a, "InstitutionalLawSchema IS the ADICO grammar and cites no source").toBeDefined();
    expect(a!.relation).toBe("descends-from");
    expect(a!.citation.year).toBe(1995);
    expect(a!.citation.title).toBe("A Grammar of Institutions");
    expect(a!.citation.venue).toBe("American Political Science Review");
    expect(a!.citation.doi).toBe("10.2307/2082975");
    expect(a!.citation.authors.join(" ")).toMatch(/Crawford/);
    expect(a!.citation.authors.join(" ")).toMatch(/Ostrom/);
    expect(a!.citation.evidence_grade).toBe("archive");
  });

  it("NormPairSchema descends from Makinson & van der Torre (2000), archive-grade", () => {
    const a = findFor("NormPairSchema");
    expect(a, "NormPairSchema is an I/O-logic norm pair and cites no source").toBeDefined();
    expect(a!.relation).toBe("descends-from");
    expect(a!.citation.year).toBe(2000);
    expect(a!.citation.title).toBe("Input/Output Logics");
    expect(a!.citation.venue).toBe("Journal of Philosophical Logic");
    expect(a!.citation.doi).toBe("10.1023/A:1004748624537");
    expect(a!.citation.authors.join(" ")).toMatch(/Makinson/);
    expect(a!.citation.authors.join(" ")).toMatch(/van der Torre/);
    expect(a!.citation.evidence_grade).toBe("archive");
  });

  it("an archive-grade citation records WHEN it was retrieved — the grade is a claim about a fetch", () => {
    for (const a of GENOME_ATTRIBUTIONS.filter((x) => x.citation.evidence_grade === "archive")) {
      expect(
        a.citation.retrieved_at,
        `"${a.subject}" claims archive grade with no retrieval date — an ungrounded grade claim`,
      ).toBeTruthy();
      expect(new Date(a.citation.retrieved_at!).toString()).not.toBe("Invalid Date");
    }
  });

  it("no attribution smuggles an unresolvable citation past the bar", () => {
    for (const a of GENOME_ATTRIBUTIONS) {
      expect(
        Boolean(a.citation.doi || a.citation.url),
        `attribution for "${a.subject}" cannot be dereferenced`,
      ).toBe(true);
    }
  });
});
