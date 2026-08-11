// The Coltrane institution's first laws — the dev-loop stated as invocable ADICO contracts.
//
// RED-first: written against a repo with no institutions/coltrane.json. Every assertion below
// is about THAT file specifically (the quartet gate in default_genome_quartet.test.ts already
// holds every institution doc to the shared structural bar; this suite pins what makes the
// Coltrane institution the Coltrane institution — its three governing laws and their shape).
//
// The load-bearing law it encodes: a change lands in the institution only through a green-CI
// pull request a human governor merges. Law A forbids a non-human seat from merging main;
// Law B permits it to open a PR; Law C obliges a green CI result before any merge. The genome
// class InstitutionalLawSchema (0.8.0) is the shape; this file is the first real instance.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { InstitutionSchema } from "../src/genome_schema.js";
import { canonJson, sha256Hex } from "../src/canonical_form.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const FILE = join(REPO_ROOT, "institutions", "coltrane.json");

describe("institutions/coltrane.json — the Coltrane institution's first laws", () => {
  it("the file exists", () => {
    expect(
      existsSync(FILE),
      "institutions/coltrane.json is the Coltrane institution — its absence means the dev-loop " +
        "law ships as prose, not as an invocable contract.",
    ).toBe(true);
  });

  const doc = existsSync(FILE)
    ? (JSON.parse(readFileSync(FILE, "utf8")) as { institution: Record<string, unknown> })
    : { institution: {} };

  it("the institution parses loss-free through InstitutionSchema", () => {
    const parsed = InstitutionSchema.parse(doc.institution) as Record<string, unknown>;
    for (const [k, v] of Object.entries(doc.institution)) {
      expect(parsed[k], `authored field "${k}" did not survive the parse`).toEqual(v);
    }
    expect(parsed.slug).toBe("coltrane");
    expect(parsed.sovereign).toBe(true);
  });

  it("its grounding lineage is empty — the grounding record is private and cannot live in OSS", () => {
    const inst = InstitutionSchema.parse(doc.institution);
    expect(inst.lineage).toEqual([]);
  });

  const laws = InstitutionSchema.parse(doc.institution).laws;

  it("carries exactly the three dev-loop laws", () => {
    expect(laws).toHaveLength(3);
  });

  it("every law's check is machine-invocable: a non-empty predicate over typed inputs", () => {
    for (const law of laws) {
      expect(law.check.predicate.length, `law "${law.aim}" has an empty predicate`).toBeGreaterThan(0);
      const inputs = Object.entries(law.check.inputs);
      expect(inputs.length, `law "${law.aim}" declares no typed inputs`).toBeGreaterThan(0);
      for (const [name, type] of inputs) {
        expect(name.length, "an input with no name").toBeGreaterThan(0);
        expect(typeof type === "string" && type.length > 0, `input "${name}" has no type`).toBe(true);
      }
    }
  });

  it("every law's content_hash is REAL — sha256 over the law's own canonical ADICO content", () => {
    for (const law of laws) {
      const recomputed = "sha256:" + sha256Hex(canonJson(law));
      expect(
        law.content_hash,
        `law "${law.aim}" carries a placeholder or stale content_hash`,
      ).toBe(recomputed);
    }
  });

  it("Law A forbids a non-human seat from merging the protected main line", () => {
    const merge = laws.filter((l) => /merge/i.test(l.aim) && /main/i.test(l.aim));
    expect(merge.length, "no law governs merging main").toBeGreaterThanOrEqual(1);
    const lawA = merge.find((l) => l.deontic === "forbidden");
    expect(lawA, "no FORBIDDEN law governs merging main — law A is missing").toBeDefined();
    expect(lawA!.attributes).toMatch(/not a human governor|non-human|agent/i);
  });

  it("NO law permits a non-human agent to merge main", () => {
    const permitsMerge = laws.filter(
      (l) => l.deontic === "permitted" && /merge/i.test(l.aim) && /main/i.test(l.aim),
    );
    expect(
      permitsMerge,
      "a law permits merging main — that is exactly what the dev-loop forbids to a model seat",
    ).toEqual([]);
  });

  it("Law B permits opening a pull request; Law C obliges a green CI result before merge", () => {
    const b = laws.find((l) => l.deontic === "permitted" && /pull request/i.test(l.aim));
    expect(b, "no PERMITTED law about opening a pull request — law B is missing").toBeDefined();
    const c = laws.find((l) => l.deontic === "obliged" && /continuous-integration|continuous integration/i.test(l.aim));
    expect(c, "no OBLIGED law about a green CI result — law C is missing").toBeDefined();
  });
});
