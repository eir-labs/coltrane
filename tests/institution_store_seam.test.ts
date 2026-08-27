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

  it("the PostgREST institution select carries `definition` whole, as charts and venues do", () => {
    // RE-STATED, not retired (A1+A2). This law's SUBJECT is chancery_institution, and that
    // is unchanged and still asserted below. What changed is a PREMISE it cited: the venues
    // envelope is no longer the literal string `select=slug,definition`, because
    // coltrane_venues is VERSIONED and STATUSED and the loader must see those facts — reading
    // slug+definition handed it every superseded row, and a repaired room reported as broken
    // forever. That is not the drift this law guards against; it is the store's real shape.
    //
    // So the premise is restated as the PROPERTY it always meant rather than the spelling it
    // happened to have: `definition` is selected WHOLE and is the validated file document. A
    // venue may also carry the columns that identify WHICH definition is current; what it may
    // not do is shred the document into bespoke columns, which is the actual drift seam.
    expect(STORE_SRC, "charts carry definition whole").toMatch(/coltrane_charts\?select=[^"]*\bdefinition\b/);
    expect(STORE_SRC, "venues carry definition whole").toMatch(/coltrane_venues\?select=[^"]*\bdefinition\b/);
    // and the fields that made the restatement necessary are really there, so this premise
    // cannot be satisfied by quietly reverting the envelope
    for (const f of ["status", "version"]) {
      expect(STORE_SRC, `venues select ${f} — the facts that distinguish a live room from history`)
        .toMatch(new RegExp(`coltrane_venues\\?select=[^"]*\\b${f}\\b`));
    }
    expect(
      STORE_SRC,
      "the institution store row must be the {slug, definition} envelope where definition IS the validated file document — not a bespoke shape",
    ).toMatch(/chancery_institution\?select=slug,definition/);
  });
});
