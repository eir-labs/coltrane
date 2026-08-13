// RED SPEC — checkInstitutionAdmissibility moves from CI-only to the LOAD PATH.
//
// The gate is a green pure function (src/institution_enforcement.ts) that nothing on the runtime
// path invokes. CI (tests/institution_admissibility_gate.test.ts — untouched) catches a bad document
// at merge; this suite pins the RUNTIME gate: an overclaiming institution is refused at LOAD, fails
// closed (never enters LoadedGenome.institutions), and its offenders are recorded as a load_error.
// The refusal MEANING is chosen and defended in docs/specs/institution-loader-admissibility-gate.md:
// the inadmissible document drops out, the rest of the genome loads (soft-fail per file), NOT a
// whole-genome throw.
//
// Every assertion reds because loadGenome does not yet CALL the gate — the loaded-institutions map is
// empty. The oracle side (checkInstitutionAdmissibility) is real and green; the load side is the seam.
//
// Pins INV2 agreement, INV3 isolation, INV9 differential, INV10 additive-monotone, INV11 collect-all.
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { loadGenome } from "../src/loader.js";
import { checkInstitutionAdmissibility } from "../src/institution_enforcement.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const INST_DIR = join(REPO_ROOT, "institutions");

function writeGenome(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "coltrane-gate-"));
  const instDir = join(dir, "institutions");
  mkdirSync(instDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(instDir, name), typeof content === "string" ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}

function admissibleInstitution(slug: string): { institution: { slug: string; name: string; kind: string; laws: unknown[] } } {
  return { institution: { slug, name: slug, kind: "institution", laws: [] } };
}

const OFFENDING_LAW = {
  attributes: "any actor",
  deontic: "obliged",
  aim: "an aim with no consequence",
  conditions: "at all times",
  or_else: "",
  check: { predicate: "(= a b)", inputs: { a: "t", b: "t" } },
  content_hash: "sha256:test",
};

const loaded = (dir: string): Set<string> => new Set((loadGenome(dir).institutions ?? new Map<string, unknown>()).keys());

describe("institution admissibility gate on the load path", () => {
  it("INV2 ADMISSIBILITY-LOAD AGREEMENT — a schema-valid institution loads IFF the gate admits it", () => {
    fc.assert(
      fc.property(fc.boolean(), (offend) => {
        const doc = admissibleInstitution("agree");
        if (offend) doc.institution.laws.push(OFFENDING_LAW);
        const dir = writeGenome({ "agree.json": doc });
        const isLoaded = loaded(dir).has("agree");
        const admitted = checkInstitutionAdmissibility({ institution: doc.institution, chairs: [] }).admitted;
        expect(isLoaded, `loaded(${isLoaded}) must equal gate-admitted(${admitted}) — the load gate is exactly the CI predicate`).toBe(admitted);
      }),
      { numRuns: 20 },
    );
  });

  it("INV3 PER-DOCUMENT ISOLATION — an inadmissible/malformed doc never removes an unrelated admissible one", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom<"good" | "bad" | "broken">("good", "bad", "broken"), { minLength: 0, maxLength: 6 }), (kinds) => {
        const files: Record<string, unknown> = { "always-good.json": admissibleInstitution("alwaysgood") };
        const expectedGood = ["alwaysgood"];
        kinds.forEach((k, i) => {
          if (k === "good") {
            files[`g${i}.json`] = admissibleInstitution(`good${i}`);
            expectedGood.push(`good${i}`);
          } else if (k === "bad") {
            const d = admissibleInstitution(`bad${i}`);
            d.institution.laws.push(OFFENDING_LAW);
            files[`b${i}.json`] = d;
          } else {
            files[`x${i}.json`] = "{ not json";
          }
        });
        const got = loaded(writeGenome(files));
        for (const slug of expectedGood) expect(got.has(slug), `admissible ${slug} was dropped by an unrelated bad sibling`).toBe(true);
      }),
      { numRuns: 25 },
    );
  });

  it("INV9 GATE DIFFERENTIAL — the CI gate's admitted set equals the loaded-institutions set over the shipped documents", () => {
    const got = loaded(REPO_ROOT);
    for (const f of readdirSync(INST_DIR).filter((f) => f.endsWith(".json"))) {
      const doc = JSON.parse(readFileSync(join(INST_DIR, f), "utf8")) as { institution: { slug: string }; chairs?: unknown[] };
      const admitted = checkInstitutionAdmissibility({ institution: doc.institution, chairs: doc.chairs ?? [] }).admitted;
      if (admitted) expect(got.has(doc.institution.slug), `${f} is CI-admitted but not loaded — the two enforcement points disagree`).toBe(true);
    }
  });

  it("INV10 ADDITIVE-MONOTONE — adding an offending law to an admitted institution drops it from the loaded map", () => {
    const base = admissibleInstitution("mono");
    expect(loaded(writeGenome({ "mono.json": base })).has("mono"), "an admissible institution must load").toBe(true);
    const worse = admissibleInstitution("mono");
    worse.institution.laws.push(OFFENDING_LAW);
    expect(loaded(writeGenome({ "mono.json": worse })).has("mono"), "adding an offender must not leave it admitted+loaded").toBe(false);
    // oracle: the mutation only ever grows the offender set (never shrinks it back to admitted)
    const before = checkInstitutionAdmissibility({ institution: base.institution, chairs: [] }).offenders.length;
    const after = checkInstitutionAdmissibility({ institution: worse.institution, chairs: [] }).offenders.length;
    expect(after).toBeGreaterThan(before);
  });

  it("INV11 COLLECT-ALL — a document with N independent defects drops out and its load_error surfaces every offender", () => {
    const law1 = { ...OFFENDING_LAW }; // defect 1: empty or_else
    const law2 = {
      attributes: "a",
      deontic: "obliged",
      aim: "references a name it never declares",
      conditions: "c",
      or_else: "a stated consequence",
      check: { predicate: "(= a missing)", inputs: { a: "t" } }, // defect 2: undeclared variable "missing"
      content_hash: "sha256:test",
    };
    const doc = {
      institution: { slug: "multi", name: "M", kind: "institution", laws: [law1, law2] },
      chairs: [{ institution_slug: "multi", role: "r", function: "SENSE", mission: "m", obligations: [{ attributes: "a", aim: "b" }] }], // defect 3: unmarked obligation
    };
    const oracle = checkInstitutionAdmissibility({ institution: doc.institution, chairs: doc.chairs });
    expect(oracle.admitted).toBe(false);
    expect(oracle.offenders.length, "test premise: three independent defects").toBeGreaterThanOrEqual(3);

    const g = loadGenome(writeGenome({ "multi.json": doc }));
    expect(new Set((g.institutions ?? new Map<string, unknown>()).keys()).has("multi"), "an inadmissible document must not enter the map").toBe(false);
    const err = g.load_errors.find((e) => e.kind === "institution" && /multi\.json$/.test(e.path));
    expect(err, "no 'institution' load_error was recorded for the inadmissible document — the gate is not invoked at load").toBeDefined();
    for (const o of oracle.offenders) {
      expect(err!.error, `the load_error must surface every offender (collect-all); missing: ${o.ref}`).toContain(o.ref);
    }
  });
});
