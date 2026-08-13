// RED-first spec for the ADDITIVE obligation-tier field and closing the findings on our own
// institution (items 2 & 3). The schema change is additive-only: the new obligation-tier mark is an
// optional field that defaults to absent-parses-fine, so every shipped file still loads. These
// assertions run against the REAL schemas (src/genome_schema.ts) and the REAL institution file
// (institutions/coltrane.json).
//
// RED because: NormPairSchema is `.strict()` and does not yet carry the `tier` field (so a marked
// obligation is rejected today), and coltrane.json's obligations are not yet marked. It is NOT red
// for a type error — `.parse` accepts unknown input, so this compiles. The GREEN change adds the
// optional field to NormPairSchema and marks coltrane.json's obligations declared-tier.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadGenome } from "../src";
import { InstitutionSchema, InstitutionalChairSchema, NormPairSchema } from "../src/genome_schema.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

interface RawColtrane {
  institution: unknown;
  chairs: Array<{ role: string; obligations?: Array<Record<string, unknown>> }>;
}
function loadColtrane(): { raw: string; parsed: RawColtrane } {
  const raw = readFileSync(join(REPO_ROOT, "institutions", "coltrane.json"), "utf8");
  return { raw, parsed: JSON.parse(raw) as RawColtrane };
}

describe("the obligation-tier field is additive, and the findings on coltrane.json are closed", () => {
  it("I17 ADDITIVE-OPTIONAL-FIELD: a declared-tier obligation parses loss-free", () => {
    const marked = { attributes: "the change-author", aim: "open every change as a pull request", deontic: "obliged", tier: "declared" };
    const parsed = NormPairSchema.parse(marked) as Record<string, unknown>;
    expect(parsed.tier, "the additive obligation-tier mark did not survive the parse").toBe("declared");
    expect(parsed.aim).toBe(marked.aim); // the rest of the pair still round-trips
  });

  it("I18 LOADS-AND-COMPOSES-UNCHANGED: the genome loads, and a declared-tier-marked institution loads loss-free", () => {
    // Guard: every shipped agent/standard/chart/venue file still loads and composes.
    const genome = loadGenome(REPO_ROOT);
    expect(
      genome.load_errors.map((e) => `${e.kind} ${e.slug ?? e.path}: ${e.error}`),
      "a shipped definition stopped composing after the schema change",
    ).toEqual([]);
    // The additive mark round-trips through a REAL shipped chair — proving the change is additive.
    const { parsed } = loadColtrane();
    const chairRaw = structuredClone(parsed.chairs[0]) as { obligations: Array<Record<string, unknown>> };
    chairRaw.obligations = chairRaw.obligations.map((o) => ({ ...o, tier: "declared" }));
    const chair = InstitutionalChairSchema.parse(chairRaw) as { obligations: Array<Record<string, unknown>> };
    expect(
      chair.obligations.every((o) => o.tier === "declared"),
      "the declared-tier mark did not survive the chair parse — the field is not additive yet",
    ).toBe(true);
  });

  it("I24 COLTRANE-OBLIGATIONS-MARKED: coltrane.json's chair obligations carry the declared-tier mark", () => {
    const { parsed } = loadColtrane();
    const chairsWithObligations = parsed.chairs.filter((c) => (c.obligations ?? []).length > 0);
    expect(chairsWithObligations.length, "coltrane.json has no chair obligations to mark").toBeGreaterThan(0);
    for (const chair of parsed.chairs) {
      for (const o of chair.obligations ?? []) {
        expect(
          o.tier,
          `obligation "${String(o.aim)}" on chair "${chair.role}" is unmarked — silence lets a norm pass for a rule`,
        ).toBe("declared");
      }
    }
  });

  it("I25 LINEAGE-UNTOUCHED: marking the obligations did not touch or leak the private grounding lineage", () => {
    const { raw, parsed } = loadColtrane();
    // Guard: lineage stays deliberately empty — the grounding record is private and cannot live in OSS.
    expect(InstitutionSchema.parse(parsed.institution).lineage).toEqual([]);
    // Guard: no private lineage-record identifier leaked into the OSS file.
    expect(raw).not.toContain("03cacf6a");
    // Red-now: the marking work landed on the obligations, proving the change stayed in its lane.
    const anyMarked = parsed.chairs.some((c) => (c.obligations ?? []).some((o) => o.tier === "declared"));
    expect(anyMarked, "no obligation carries the declared-tier mark — the marking edit has not been applied").toBe(true);
  });
});
