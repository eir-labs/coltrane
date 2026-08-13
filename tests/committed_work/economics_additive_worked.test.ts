// The boundary guards, the worked example, and the additive/compile discipline.
//
// Covers contract INV30, INV33, INV35, INV36, INV37, INV38, INV39.
//
// TWO KINDS of assertion live here, and the difference is stated on purpose:
//  - RED (fails on absent enforcement, goes green when the change lands): INV33 (the shipped tour
//    passes tour-admissibility, which throws today), INV38 (the GASB/Singh attribution rows do not
//    exist yet), and the worked-tour round-trip half of INV39 (TourSchema is an unbuilt stub).
//  - DURABLE GUARDS (green before and after — regression/absence/compile guards, exactly as the
//    repo's own change-set spec ships I15/I16): INV30 (no economics field is present), INV35 (every
//    shipped file still loads and coltrane.json stays admissible), INV36/INV37 (the seam compiles as
//    real symbols), and the pre-existing-file half of INV39. A guard earns its place by FAILING the
//    moment the discipline is broken — a minted stake field, a broken shipped file, a missing seam.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as cw from "../../src/committed_work.js";
import { InstitutionSchema, GENOME_ATTRIBUTIONS } from "../../src/genome_schema.js";
import { checkInstitutionAdmissibility } from "../../src/institution_enforcement.js";
import { loadGenome } from "../../src/index.js";
import { booking } from "./_fixtures.js";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (...p: string[]) => readFileSync(join(REPO_ROOT, ...p), "utf8");

describe("NO stake, no economics — the absence IS the specification (INV30)", () => {
  const FORBIDDEN = ["stake", "payout", "heat_budget", "heat", "witness_tier", "witness", "currency_of_account", "currency"];

  it("INV30 no forbidden economics field name appears in the committed-work seam or the worked tour", () => {
    const surfaces = [read("src", "committed_work.ts"), read("tours", "coltrane.json")];
    for (const text of surfaces) {
      for (const term of FORBIDDEN) {
        // match a field-name usage: `"<term>"` in JSON or `<term>:`/`<term>?:` in the schema
        const asJsonKey = new RegExp(`"${term}"\\s*:`);
        const asTsField = new RegExp(`\\b${term}\\b\\s*\\??\\s*:`);
        expect(asJsonKey.test(text) || asTsField.test(text), `forbidden economics field "${term}" is present`).toBe(false);
      }
    }
  });

  it("INV30 the sole money field is `amount`, and it is optional on the Booking shape", () => {
    const seam = read("src", "committed_work.ts");
    expect(/amount\?\s*:\s*number/.test(seam), "amount must be the only money field, and optional").toBe(true);
    // RED anchor: a funded booking carries `amount` and nothing else money-shaped (parse throws today).
    const parsed = cw.BookingSchema.parse(booking({ amount: 4200 })) as unknown as Record<string, unknown>;
    expect(parsed.amount, "amount is a real, plain money field").toBe(4200);
  });
});

describe("the shipped worked example — Coltrane's own roadmap-as-tour (INV33)", () => {
  const raw = JSON.parse(read("tours", "coltrane.json")) as {
    tour: { bookings: Array<Record<string, unknown>> };
    resources: Array<Record<string, unknown>>;
  };
  const coltrane = JSON.parse(read("institutions", "coltrane.json")) as {
    institution: Record<string, unknown>;
    chairs: Array<Record<string, unknown>>;
  };

  it("INV33 every shipped commitment carries NO amount — the tour genuinely has none", () => {
    for (const b of raw.tour.bookings) {
      expect(b.amount, `booking "${String(b.slug)}" must ship without a fake number`).toBeUndefined();
    }
  });

  it("INV33 the shipped tour PASSES checkTourAdmissibility, amounts absent, against the real coltrane genome", () => {
    const result = cw.checkTourAdmissibility({
      tour: raw.tour,
      resources: raw.resources,
      institution: coltrane.institution,
      chairs: coltrane.chairs,
      northstars: [],
    });
    expect(
      result.admitted,
      `the worked example must be the tour that passes; offenders: ${JSON.stringify(result.offenders ?? [])}`,
    ).toBe(true);
  });

  it("INV33 the shipped tour parses loss-free through TourSchema", () => {
    const parsed = cw.TourSchema.parse(raw.tour) as unknown as Record<string, unknown>;
    expect(parsed.slug).toBe("coltrane-roadmap");
  });
});

describe("additive-only and compile discipline (INV35, INV36, INV37, INV39)", () => {
  it("INV35 the whole shipped genome still loads with no errors — the change broke no file", () => {
    const genome = loadGenome(REPO_ROOT);
    expect(
      genome.load_errors.map((e) => `${e.kind} ${e.slug ?? e.path}: ${e.error}`),
      "a load error means a shipped agent/standard/chart/venue/institution no longer composes",
    ).toEqual([]);
  });

  it("INV35 institutions/coltrane.json still passes checkInstitutionAdmissibility", () => {
    const coltrane = JSON.parse(read("institutions", "coltrane.json")) as {
      institution: Record<string, unknown>;
      chairs: Array<Record<string, unknown>>;
    };
    const r = checkInstitutionAdmissibility({ institution: coltrane.institution, chairs: coltrane.chairs });
    expect(r.admitted, `coltrane.json must stay admissible; offenders: ${JSON.stringify(r.offenders)}`).toBe(true);
  });

  it("INV36/INV37 every seam the red tests call exists as a real symbol — red is a thrown stub, not a missing one", () => {
    for (const fn of [
      "applyCommitmentOp",
      "checkTourCapacity",
      "checkTourAdmissibility",
      "computeVariance",
      "unpromisedGigs",
      "undispatchedBookings",
      "northstarsWithNoBooking",
      "bookingsServingNoNorthstar",
      "tallyDrawsPerUnit",
    ] as const) {
      expect(typeof (cw as Record<string, unknown>)[fn], `seam function "${fn}" is not a function`).toBe("function");
    }
    for (const schema of ["TourSchema", "BookingSchema", "ResourceSchema", "DrawSchema"] as const) {
      expect(typeof (cw[schema] as { parse?: unknown }).parse, `${schema}.parse must exist`).toBe("function");
    }
    // the closed state set and party-alive set are authored seam data
    expect(cw.COMMITMENT_STATES).toContain("cancelled");
    expect(cw.COMMITMENT_STATES).toContain("released");
  });

  it("INV39 a pre-existing genome file still round-trips loss-free (regression guard)", () => {
    const coltrane = JSON.parse(read("institutions", "coltrane.json")) as { institution: Record<string, unknown> };
    const parsed = InstitutionSchema.parse(coltrane.institution) as Record<string, unknown>;
    for (const [k, v] of Object.entries(coltrane.institution)) {
      expect(parsed[k], `authored field "${k}" did not survive the parse`).toEqual(v);
    }
  });
});

describe("prior art is sealed as parseable attribution rows (INV38)", () => {
  it("INV38 GENOME_ATTRIBUTIONS gains a GASB 54 encumbrance row and a Singh commitment-algebra row", () => {
    const titles = GENOME_ATTRIBUTIONS.map((a) => a.citation.title + " " + a.citation.authors.join(" "));
    const hasGasb = titles.some((t) => /GASB|encumbrance|fund balance/i.test(t));
    const hasSingh = titles.some((t) => /Singh|commitment/i.test(t));
    expect(hasGasb, "the GASB 54 encumbrance-leg attribution is missing").toBe(true);
    expect(hasSingh, "the Singh commitment-algebra attribution is missing").toBe(true);
    // each attribution row still validates against the shipped shape (subject/relation/what_taken/citation)
    for (const a of GENOME_ATTRIBUTIONS) {
      expect(typeof a.subject).toBe("string");
      expect(typeof a.citation.evidence_grade).toBe("string");
    }
  });
});
