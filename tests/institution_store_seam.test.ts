// RED SPEC — the GenomeStore institution row SHAPE (specified, not built).
//
// The hosted org store already models chancery_institution (canonical since coltrane-ui migration
// 20260825000000 renamed the governance tables; the coltrane_* shims drop) and its six adjacent tables, but the
// GenomeStore port (src/genome_store.ts) has a fixed class list with NO institution row. Left
// unspecified, the file backing and a future store backing drift — the concrete failure the
// dashboard audit documents on other classes (input_types, carried_skills, hydration). This suite
// pins the row shape so they cannot: the institution row is the SAME {slug, definition} envelope
// charts and venues already ride, where `definition` IS the multi-section document the loader
// validates. Building the store backing / institution_define / institution_browse is out of scope —
// this asserts the SHAPE only, and reds because the shape is not declared yet.
//
// Pins INV12 store/file envelope parity.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const STORE_SRC = readFileSync(join(REPO_ROOT, "src/genome_store.ts"), "utf8");

describe("INV12 STORE/FILE ENVELOPE PARITY — the institution row shape cannot drift from the file document", () => {
  it("GenomeClass includes 'institution' so the class is addressable through the port", () => {
    const m = /export type GenomeClass\s*=([^;]+);/.exec(STORE_SRC);
    expect(m, "GenomeClass union not found in src/genome_store.ts").not.toBeNull();
    expect(m![1], "GenomeClass must gain an 'institution' member — a class the file backing loads but the port cannot name is a drift seam").toMatch(/"institution"/);
  });

  it("the PostgREST institution select rides the same {slug, definition} envelope as charts/venues", () => {
    // Premise: charts/venues already use {slug, definition}. The institution row must match that
    // envelope exactly — a bespoke column set is precisely how file and store drift.
    expect(STORE_SRC, "charts {slug, definition} envelope premise").toMatch(/coltrane_charts\?select=slug,definition/);
    expect(STORE_SRC, "venues {slug, definition} envelope premise").toMatch(/coltrane_venues\?select=slug,definition/);
    expect(
      STORE_SRC,
      "the institution store row must be the {slug, definition} envelope where definition IS the validated file document — not a bespoke shape",
    ).toMatch(/chancery_institution\?select=slug,definition/);
  });
});
