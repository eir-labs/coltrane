// RED — institutions/coltrane.json must DECLARE the change-set branch as a legitimate red space,
// as a fourth ADICO law, composing with Law C rather than contradicting it.
//
// Covers I11 (a FOURTH law: deontic=permitted, predicate references target_branch != main-line,
// every input typed, content_hash recomputes), I12 (Laws A/B/C survive byte-for-byte with their
// original content_hashes and the lineage array stays empty), and I13 (the ONLY permitted edit to
// tests/coltrane_institution.test.ts is toHaveLength(3) -> toHaveLength(4)).
//
// RED because the institution ships three laws today: the length-4 assertions fail now and can go
// green only once the fourth law is authored WITHOUT disturbing the first three. Deterministic
// content-hash equality (the strongest, cheapest check) grounds I11/I12 — the same recompute the
// existing coltrane_institution gate performs. This suite is separate from that gate and does not
// modify it; I13 asserts, by reading it as text, that its single permitted edit was made.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { InstitutionSchema } from "../../src/genome_schema.js";
import { canonJson, sha256Hex } from "../../src/canonical_form.js";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const INSTITUTION_FILE = join(REPO_ROOT, "institutions", "coltrane.json");
const INSTITUTION_TEST = join(REPO_ROOT, "tests", "coltrane_institution.test.ts");

/** The three dev-loop laws' content_hashes, verbatim — they MUST survive the fourth law's addition. */
const LAW_A_HASH = "sha256:b6fc83599d08906b5a17c4df4fd62fc6613a8c6769de696e07f1822589c0edf4";
const LAW_B_HASH = "sha256:16a421955526178557f84c668a5f7f78df76bb6b63ddc2941b5640bae6ee1131";
const LAW_C_HASH = "sha256:c4c2b5fe59fdad6b299a43b60b4d61dfff9c848fe578d72ebf3d932fd5d15b13";

const doc = JSON.parse(readFileSync(INSTITUTION_FILE, "utf8")) as { institution: unknown };
const institution = InstitutionSchema.parse(doc.institution);
const laws = institution.laws;

describe("institutions/coltrane.json declares the change-set red space (I11, I12)", () => {
  it("I11 the red-space law is one of seven declared laws", () => {
    expect(
      laws,
      "the change-set branch is a deliberately-red space; an institution that permits red " +
        "somewhere and does not say where runs an undeclared rule. The count is seven: the three " +
        "dev-loop laws, this red-space law, and the three tool-routing laws that declare the " +
        "enforcement coltrane already performs.",
    ).toHaveLength(7);
  });

  it("I11 the red-space law is PERMITTED, scoped to target_branch != the protected main line", () => {
    const known = new Set([LAW_A_HASH, LAW_B_HASH, LAW_C_HASH]);
    const fourth = laws.find((l) => !known.has(l.content_hash));
    expect(fourth, "no law beyond the three dev-loop laws — the red-space law is missing").toBeDefined();
    expect(fourth!.deontic, "the red space is a PERMISSION, not an obligation or a prohibition").toBe("permitted");

    const predicate = fourth!.check.predicate;
    expect(predicate.length, "the red-space law has an empty predicate").toBeGreaterThan(0);
    expect(predicate, "the predicate must name target_branch").toMatch(/target_branch/);
    expect(predicate, "the predicate must reference the main line").toMatch(/main/i);
    expect(
      predicate,
      "the predicate must express NON-equality with main (red is permitted where target_branch != main)",
    ).toMatch(/not|!=|distinct|<>|≠/i);

    const inputs = Object.entries(fourth!.check.inputs);
    expect(inputs.length, "the red-space law declares no typed inputs").toBeGreaterThan(0);
    for (const [name, type] of inputs) {
      expect(name.length, "an input with no name").toBeGreaterThan(0);
      expect(typeof type === "string" && type.length > 0, `input "${name}" has no type`).toBe(true);
    }
  });

  it("I11 the red-space law's content_hash is REAL — recomputes over its own canonical ADICO", () => {
    const known = new Set([LAW_A_HASH, LAW_B_HASH, LAW_C_HASH]);
    const fourth = laws.find((l) => !known.has(l.content_hash));
    expect(fourth).toBeDefined();
    expect(fourth!.content_hash).toBe("sha256:" + sha256Hex(canonJson(fourth!)));
  });

  it("I12 Laws A, B, C survive byte-for-byte with their original content_hashes", () => {
    for (const hash of [LAW_A_HASH, LAW_B_HASH, LAW_C_HASH]) {
      const law = laws.find((l) => l.content_hash === hash);
      expect(law, `a dev-loop law with content_hash ${hash} is gone — the addition disturbed it`).toBeDefined();
      // and the surviving hash is genuinely the law's own canonical hash, not a stale label.
      expect(law!.content_hash).toBe("sha256:" + sha256Hex(canonJson(law!)));
    }
  });

  it("I12 the grounding lineage array stays empty", () => {
    expect(institution.lineage).toEqual([]);
  });
});

describe("the existing institution gate takes its single permitted edit (I13)", () => {
  const text = readFileSync(INSTITUTION_TEST, "utf8");

  // The literal moves with the census, and only with it. It read four when the laws were the three
  // dev-loop laws plus the red space; it reads seven now that the three tool-routing laws are
  // declared. The guard is not that the number never changes — it is that the count assertion is
  // the ONLY thing that changes in that gate, so nobody quietly loosens a neighbouring assertion
  // while updating a census.
  it("I13 tests/coltrane_institution.test.ts expects the current law count — and only that literal changed", () => {
    expect(text, "the law-count assertion does not match the declared census").toContain("toHaveLength(7)");
    expect(text, "a stale count remains — the count edit is the ONLY permitted change").not.toContain(
      "toHaveLength(4)",
    );
  });

  it("I13 every other assertion in that gate is untouched", () => {
    // The A/B/C finders and the real-content_hash check must remain, so the edit was ONLY the count.
    expect(text).toContain("Law A forbids a non-human seat from merging the protected main line");
    expect(text).toContain("Law B permits opening a pull request; Law C obliges a green CI result before merge");
    expect(text).toContain("every law's content_hash is REAL");
    expect(text).toContain("its grounding lineage is empty");
  });
});
