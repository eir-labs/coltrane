// The loader learns the bearing-law kind (Chancery bootstrap, owed fix #1).
//
// An org genome's standards/ may hold ADICO bearing-laws — sealable canon documents
// (kind: "bearing-law", NO phases) recording an obligation a legal person bears, not an
// executable workflow. The real files live in eir-labs-genome/standards/; byte-copies are
// the fixtures under tests/fixtures/bearing_laws/. Before this fix the loader fed them to
// composeStandard, which died on `def.phases is not iterable` and `coltrane validate`
// went red on a lawful genome.
//
// The contract this suite pins:
//  - a bearing-law file VALIDATES against a law shape (BearingLawSchema: slug, kind, law
//    (ADICO), source, subject_ref, bearer, instrument, provenance) and loads with zero errors
//  - it is NEVER an executable standard: it does not enter the standards map, so dispatch
//    (which resolves standard_slug against that map) cannot seat it — non-dispatchable by
//    construction, not by a runtime guard
//  - a phases-bearing standard in the same genome still composes exactly as before
//  - a malformed bearing-law is a per-file load_error (soft), never a silent admit
//  - seal-genome's content identity for these files does not move: the sha256(canonJson)
//    hashes are pinned, so a change to loading can never quietly re-hash sealed canon
//
// RED-first: LoadedGenome.bearing_laws and the loader branch do not exist yet.
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEST_BEHAVIOR } from "./_support/agents.js";
import { loadGenome, loadLayeredGenome } from "../src/loader.js";
import { canonJson, sha256Hex } from "../src/canonical_form.js";

const FIXTURES = join(__dirname, "fixtures", "bearing_laws");
const BEARING_LAW_SLUGS = [
  "lighthouse-sow-delivery-v0",
  "price-note-payment-v0",
  "safe-portfolio-honor-v0",
] as const;

function writeJson(dir: string, sub: string, name: string, obj: unknown): void {
  const d = join(dir, sub);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, name), JSON.stringify(obj));
}

/** A genome whose standards/ holds the three real bearing-laws PLUS one ordinary
 *  phases-bearing standard seated by one ordinary agent. */
function writeMixedGenome(root: string): void {
  writeJson(root, "agents", "base-scout.json", {
    ...TEST_BEHAVIOR,
    slug: "base-scout",
    primitives: ["SENSE"],
    output_types: ["Signal"],
  });
  writeJson(root, "standards", "widget-flow.json", {
    slug: "widget-flow",
    domain: "widgetco",
    agent_slugs: ["base-scout"],
    phases: [
      {
        name: "sense",
        chairs: [
          {
            role: "sense",
            agent_slug: "base-scout",
            depends_on: [],
            input_contract: [],
            output_contract: ["Signal"],
            required_skills: [],
          },
        ],
      },
    ],
  });
  cpSync(FIXTURES, join(root, "standards"), { recursive: true });
}

describe("the loader learns the bearing-law kind", () => {
  it("loads a genome whose standards/ holds real bearing-laws with zero errors — and never as executable standards", () => {
    const root = mkdtempSync(join(tmpdir(), "coltrane-bearing-"));
    try {
      writeMixedGenome(root);
      const g = loadGenome(root);

      // Zero load errors: bearing-laws are lawful genome content, not broken standards.
      expect(g.load_errors).toEqual([]);

      // The phases-bearing standard still composes exactly as before.
      expect(g.standards.has("widget-flow")).toBe(true);
      expect(g.standards.get("widget-flow")?.phases.map((p) => p.name)).toEqual(["sense"]);

      // NEVER dispatchable: dispatch resolves standard_slug against the standards map,
      // so absence from that map IS non-dispatchability — no bearing-law enters it.
      for (const slug of BEARING_LAW_SLUGS) {
        expect(g.standards.has(slug)).toBe(false);
      }

      // Admitted as bearing-laws, validated against the law shape.
      for (const slug of BEARING_LAW_SLUGS) {
        expect(g.bearing_laws?.has(slug)).toBe(true);
      }
      const safe = g.bearing_laws?.get("safe-portfolio-honor-v0");
      expect(safe?.kind).toBe("bearing-law");
      expect(safe?.subject_ref).toBe("org:eir-labs-inc");
      expect(safe?.law.deontic).toBe("obliged");
      expect(safe?.law.check.predicate.length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a malformed bearing-law is one soft per-file load_error, not a throw and not a silent admit", () => {
    const root = mkdtempSync(join(tmpdir(), "coltrane-bearing-bad-"));
    try {
      // `law` missing entirely: canon with no ADICO content is not a bearing-law.
      writeJson(root, "standards", "hollow-law.json", {
        slug: "hollow-law",
        kind: "bearing-law",
        source: "charter",
        subject_ref: "org:example",
        bearer: "Example Corp",
        instrument: { name: "nothing" },
        provenance: { extracted_from: "nowhere" },
      });
      const g = loadGenome(root);
      expect(g.bearing_laws?.has("hollow-law")).toBe(false);
      expect(g.standards.has("hollow-law")).toBe(false);
      const errs = g.load_errors.filter((e) => e.slug === "hollow-law");
      expect(errs).toHaveLength(1);
      expect(errs[0]!.kind).toBe("standard");
      expect(errs[0]!.error).toMatch(/law/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("survives the layered load — a consumer genome extending a base carries its bearing-laws through the fold", () => {
    // eir-labs-genome extends the coltrane base via genome.json, so the REAL validate
    // path is loadLayeredGenome; the fold must carry bearing-laws, not drop them.
    const base = mkdtempSync(join(tmpdir(), "coltrane-bearing-base-"));
    const consumer = mkdtempSync(join(tmpdir(), "coltrane-bearing-consumer-"));
    try {
      writeJson(base, "agents", "base-scout.json", {
        ...TEST_BEHAVIOR,
        slug: "base-scout",
        primitives: ["SENSE"],
        output_types: ["Signal"],
      });
      cpSync(FIXTURES, join(consumer, "standards"), { recursive: true });

      const g = loadLayeredGenome([base, consumer]);
      expect(g.load_errors).toEqual([]);
      for (const slug of BEARING_LAW_SLUGS) {
        expect(g.bearing_laws?.has(slug)).toBe(true);
        expect(g.standards.has(slug)).toBe(false);
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
      rmSync(consumer, { recursive: true, force: true });
    }
  });

  it("seal-genome content identity is UNMOVED: the pinned sha256(canonJson) of each real bearing-law file", () => {
    // seal-genome hashes `sha256Hex(canonJson(def))` (src/seal_genome.ts:81). These values
    // were computed from the byte-copied real files BEFORE the loader learned the kind;
    // the loader change must not move them. If this pins red, sealing behavior drifted.
    const pinned: Record<string, string> = {
      "lighthouse-sow-delivery-v0.json": "18c6aec18e3459401cedc6626d3b76b824dfbf19235b54f68e90eebb6e42a1e9",
      "price-note-payment-v0.json": "58dc72eff4841d3b2e041a1c50df4089587ce5626cd835cf2c8a0dcfe81126ae",
      "safe-portfolio-honor-v0.json": "e41b26da0a670d6bef51f5cd6f473650d99c4e4ba3e8d786df281f4a2740ca55",
    };
    const files = readdirSync(FIXTURES).filter((f) => f.endsWith(".json")).sort();
    expect(files).toEqual(Object.keys(pinned).sort());
    for (const f of files) {
      const def = JSON.parse(readFileSync(join(FIXTURES, f), "utf-8"));
      expect(sha256Hex(canonJson(def)), f).toBe(pinned[f]);
    }
  });
});
