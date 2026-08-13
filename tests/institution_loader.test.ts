// RED SPEC — institutions/ becomes a LOADED genome class.
//
// Today institutions/ has ZERO readers in src/: loadGenome returns a LoadedGenome that carries no
// institutions, and checkInstitutionAdmissibility is invoked only by tests. This suite states the
// loader contract as running assertions that FAIL because the reader and the gate-call are absent —
// not because a file fails to typecheck. loadGenome already carries an EMPTY `institutions` map (the
// compile seam in src/loader.ts) and src/institution_loader.ts ships the throwing `loadInstitutions`
// signature the GREEN change fills; every assertion below reds until that body reads institutions/*.json,
// validates each section, invokes the admissibility gate fail-closed, and drops a refused document into
// a load_error of kind "institution".
//
// Pins the LOADER half (INV1 totality, INV4 idempotence, INV5 carried, INV6 ordering, INV7 load_error
// representable, INV8 shipped-admitted, INV13 zero-regression, INV14 malformed drop-out). The GATE half
// is in tests/institution_load_gate.test.ts; the store envelope in tests/institution_store_seam.test.ts.
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
const LOADER_SRC = readFileSync(join(REPO_ROOT, "src/loader.ts"), "utf8");

/** Materialize a throwaway genome root whose institutions/ holds the given files. No core_types/ →
 *  loadGenome seeds the canonical six, so the root loads clean and only the institutions vary. A
 *  value may be an object (JSON-encoded) or a raw string (to inject malformed JSON on purpose). */
function writeGenome(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "coltrane-inst-"));
  const instDir = join(dir, "institutions");
  mkdirSync(instDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(instDir, name), typeof content === "string" ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}

/** A schema-valid, ADMISSIBLE institution document: no laws, no chairs → nothing to overclaim. */
function admissibleInstitution(slug: string): { institution: { slug: string; name: string; kind: string; laws: unknown[] } } {
  return { institution: { slug, name: slug, kind: "institution", laws: [] } };
}

/** A law that overclaims: an empty `or_else` (a rule with no stated consequence on breach) — the
 *  admissibility check refuses it. Pushed onto an admissible document to make it inadmissible. */
const OFFENDING_LAW = {
  attributes: "any actor",
  deontic: "obliged",
  aim: "an aim with no consequence",
  conditions: "at all times",
  or_else: "",
  check: { predicate: "(= a b)", inputs: { a: "t", b: "t" } },
  content_hash: "sha256:test",
};

const loadedSlugs = (dir: string): Set<string> => new Set((loadGenome(dir).institutions ?? new Map<string, unknown>()).keys());
const instErrors = (dir: string) => loadGenome(dir).load_errors.filter((e) => e.kind === "institution");

describe("institution loader — institutions/ is read into the genome", () => {
  it("INV5 INSTITUTIONS CARRIED — after load the map is populated with the shipped slugs, and loader.ts reads institutions/", () => {
    const g = loadGenome(REPO_ROOT);
    const slugs = new Set((g.institutions ?? new Map<string, unknown>()).keys());
    expect(slugs.has("coltrane"), "institutions/coltrane.json is not carried — institutions/ still has no reader").toBe(true);
    expect(slugs.has("quartet"), "institutions/quartet.json is not carried — institutions/ still has no reader").toBe(true);
    // The reader itself: loadGenome must call loadInstitutions() or read the institutions/ directory.
    expect(
      /loadInstitutions\(/.test(LOADER_SRC) || /join\(root,\s*["']institutions["']\)/.test(LOADER_SRC),
      "src/loader.ts has no reader for institutions/ — the only reference is the empty-map compile seam",
    ).toBe(true);
  });

  it("INV6 LOAD ORDERING — institutions are read AFTER the agents/standards/venues/charts maps", () => {
    // Institutions reference agents/standards/orgs, so their reader must sit after those blocks (the
    // venues-before-charts ordering already in loadGenome). Structural, because cross-section
    // referential resolution is explicitly out of scope — only the READER's position is checkable here.
    const chartsIdx = LOADER_SRC.indexOf('kind: "chart"');
    const readerMatch = /loadInstitutions\(|join\(root,\s*["']institutions["']\)/.exec(LOADER_SRC);
    expect(readerMatch, "loadGenome does not read institutions/ yet — there is no reader to order").not.toBeNull();
    expect(readerMatch!.index, "the institutions reader must come AFTER the charts block").toBeGreaterThan(chartsIdx);
  });

  it("INV8 SHIPPED DOCUMENTS ADMITTED — coltrane.json and quartet.json load with zero institution load_errors", () => {
    // The gate admits both today (proves the GREEN target is reachable, not that the loader already runs it).
    for (const f of ["coltrane.json", "quartet.json"]) {
      const doc = JSON.parse(readFileSync(join(INST_DIR, f), "utf8")) as { institution: unknown; chairs?: unknown[] };
      expect(checkInstitutionAdmissibility({ institution: doc.institution, chairs: doc.chairs ?? [] }).admitted, `${f} must be admissible`).toBe(true);
    }
    const slugs = loadedSlugs(REPO_ROOT);
    expect(slugs.has("coltrane")).toBe(true);
    expect(slugs.has("quartet")).toBe(true);
    expect(loadGenome(REPO_ROOT).load_errors.filter((e) => e.kind === "institution")).toEqual([]);
  });

  it("INV4 IDEMPOTENCE — loading the same root twice yields identical, populated institutions + identical institution load_errors", () => {
    const a = loadGenome(REPO_ROOT);
    const b = loadGenome(REPO_ROOT);
    const keysA = [...(a.institutions ?? new Map<string, unknown>()).keys()].sort();
    const keysB = [...(b.institutions ?? new Map<string, unknown>()).keys()].sort();
    expect(keysA).toEqual(keysB); // identical → idempotent
    expect(keysA.length, "institutions must be populated — an empty map makes idempotence vacuous").toBeGreaterThan(0);
    const errA = a.load_errors.filter((e) => e.kind === "institution").map((e) => e.path).sort();
    const errB = b.load_errors.filter((e) => e.kind === "institution").map((e) => e.path).sort();
    expect(errA).toEqual(errB);
  });

  it("INV13 ZERO REGRESSION — the loader adds institutions without introducing new non-institution load_errors", () => {
    const g = loadGenome(REPO_ROOT);
    expect(g.load_errors.filter((e) => e.kind !== "institution"), "another class regressed — this change must be additive").toEqual([]);
    expect((g.institutions ?? new Map<string, unknown>()).size, "institutions not carried — loader still ignores institutions/").toBeGreaterThan(0);
  });
});

describe("institution loader — soft-fail per file (the loader's own two-tier idiom)", () => {
  it("INV1 TOTALITY — a malformed / schema-invalid institution soft-fails into a load_error, never throws", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant("{ this is not json"),
          fc.constant('{"institution": {"slug": "x"}}'), // missing name + kind → schema-invalid
          fc.constant('{"institution": {"slug":"x","name":"X","kind":"not-a-kind"}}'), // bad enum
        ),
        (body) => {
          const dir = writeGenome({ "bad.json": body });
          expect(() => loadGenome(dir)).not.toThrow();
          expect(
            instErrors(dir).length,
            "a malformed/invalid institution must soft-fail into an 'institution' load_error, not be silently ignored",
          ).toBeGreaterThan(0);
        },
      ),
      { numRuns: 20 },
    );
  });

  it("INV7 LOAD_ERROR REPRESENTABLE — a bad institution file emits a LoadError of kind 'institution'", () => {
    const dir = writeGenome({ "broken.json": "{ not valid json" });
    const inst = instErrors(dir);
    expect(inst.length, "no 'institution'-kind load_error was recorded for a broken institution file").toBeGreaterThan(0);
    expect(inst[0]!.path).toMatch(/broken\.json$/);
  });

  it("INV14 MALFORMED DROP-OUT — one bad file drops out (institution load_error) while sibling institutions still load", () => {
    const dir = writeGenome({ "good.json": admissibleInstitution("goodinst"), "bad.json": "{ broken" });
    const slugs = loadedSlugs(dir);
    expect(slugs.has("goodinst"), "the admissible sibling must still load — one bad document must not poison the class").toBe(true);
    expect(slugs.has("bad")).toBe(false);
    expect(
      instErrors(dir).some((e) => /bad\.json$/.test(e.path)),
      "the malformed file must be recorded as an 'institution' load_error and dropped out",
    ).toBe(true);
  });
});
