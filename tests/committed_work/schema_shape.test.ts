// RED — the committed-work OBJECTS themselves: Tour, Booking, Resource and the draw VECTOR.
//
// Covers contract INV1, INV2, INV4, INV13, INV14, INV32. Each schema is an UNBUILT stub whose
// `.parse` throws (src/committed_work.ts), so every assertion below is RED because the object does
// not exist yet — the binding middle place is unbuilt — NOT because of a type error (the suite
// compiles clean; the schema symbols are real z.ZodType values). The GREEN change promotes these
// three schemas into the single Zod source in src/genome_schema.ts and re-exports them here.
//
// The anchor of each test is the POSITIVE parse of a well-formed fixture: that is what fails for the
// right reason (the schema does not exist), and it makes the whole test red rather than any negative
// assertion passing tautologically against the throwing stub.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TourSchema, BookingSchema, ResourceSchema } from "../../src/committed_work.js";
import { InstitutionSchema } from "../../src/genome_schema.js";
import { tour, booking, resource } from "./_fixtures.js";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

describe("TourSchema — the institution-visible aggregation (INV1, INV4)", () => {
  it("INV1 parses a well-formed tour loss-free and keeps its slug cross-refs", () => {
    const t = tour();
    const parsed = TourSchema.parse(t) as unknown as Record<string, unknown>;
    expect(parsed.institution_slug).toBe("coltrane");
    expect(parsed.org_slug).toBe("org.house");
    expect(parsed.responsible_chair).toBe("chair.governor");
    expect(Array.isArray(parsed.bookings)).toBe(true);
    expect(parsed.northstar_slugs).toEqual(["ns.enforce-the-laws"]);
  });

  it("INV1 is strict — a tour carrying an unknown key is refused", () => {
    const t = { ...tour(), rogue_field: "smuggled" };
    expect(() => TourSchema.parse(t)).toThrow();
  });

  it("INV1 requires institution_slug — a tour that omits it is refused", () => {
    const { institution_slug: _drop, ...missing } = tour();
    expect(() => TourSchema.parse(missing)).toThrow();
  });

  it("INV4 a Tour is top-level: InstitutionSchema gains NO bookings/tours field", () => {
    // RED anchor: the Tour is its OWN top-level schema (parse throws today — unbuilt).
    expect(() => TourSchema.parse(tour())).not.toThrow();
    // The whole layer rests on institution (constraint) / organization (player) / committed work
    // being three distinct things. An institution parsed with a nested bookings array must DROP it
    // (a Zod object silently strips undeclared keys), proving bookings do not live inside the
    // institution. This runs against the REAL, already-shipped InstitutionSchema.
    const withBookings = {
      slug: "coltrane",
      name: "Coltrane",
      kind: "institution" as const,
      laws: [],
      bookings: [booking()],
    };
    const parsed = InstitutionSchema.parse(withBookings) as Record<string, unknown>;
    expect(parsed.bookings, "bookings must NOT be a field on the institution").toBeUndefined();
  });
});

describe("BookingSchema — one commitment in the binding middle place (INV2, INV14, INV32)", () => {
  it("INV2 parses a well-formed booking carrying all four load-bearing fields plus acceptance", () => {
    const b = booking();
    const parsed = BookingSchema.parse(b) as unknown as Record<string, unknown>;
    expect(parsed.aim).toBe("ship the acceptance evaluator");
    expect(parsed.accountable_office).toBe("chair.builder");
    expect(parsed.period).toBe("2026-Q3");
    expect(parsed.acceptance).toMatchObject({ predicate: expect.any(String), inputs: expect.any(Object) });
  });

  it("INV2 requires the accountable_office — a booking with no accountable party is refused", () => {
    const { accountable_office: _drop, ...missing } = booking();
    expect(() => BookingSchema.parse(missing)).toThrow();
  });

  it("INV32 amount is OPTIONAL — a booking with no amount is valid (it simply has no numerator)", () => {
    const { amount: _drop, ...noAmount } = booking({ amount: 5000 });
    const parsed = BookingSchema.parse(noAmount) as unknown as Record<string, unknown>;
    expect(parsed.amount, "an amountless booking must parse").toBeUndefined();
    expect(parsed.aim).toBe("ship the acceptance evaluator");
  });

  it("INV14 draws is a VECTOR of unit-tagged entries — a scalar draw is refused", () => {
    const vector = booking({
      draws: [
        { resource_slug: "res.compute-seat", unit: "max-seat-hours", quantity: 3 },
        { resource_slug: "res.review-seat", unit: "review-hours", quantity: 2 },
      ],
    });
    const parsed = BookingSchema.parse(vector) as { draws: unknown[] };
    expect(Array.isArray(parsed.draws)).toBe(true);
    expect(parsed.draws).toHaveLength(2);
    // a scalar in the draws slot is not a unit-tagged vector entry
    const scalar = { ...booking(), draws: 3 as unknown };
    expect(() => BookingSchema.parse(scalar)).toThrow();
  });
});

describe("ResourceSchema — capacity as its own class (INV13)", () => {
  it("INV13 parses a well-formed holding: holder, quantity, unit, period, transferable", () => {
    const r = resource();
    const parsed = ResourceSchema.parse(r) as unknown as Record<string, unknown>;
    expect(parsed.holder).toBe("org.house");
    expect(parsed.unit).toBe("max-seat-hours");
    expect(parsed.transferable).toBe(true);
    expect(parsed.quantity).toBe(100);
  });

  it("INV13 requires unit and transferable — a holding omitting either is refused", () => {
    const { unit: _u, ...noUnit } = resource();
    expect(() => ResourceSchema.parse(noUnit)).toThrow();
    const { transferable: _t, ...noTransferable } = resource();
    expect(() => ResourceSchema.parse(noTransferable)).toThrow();
  });

  it("INV13 the worked-example tour file, once shipped, has resources with a stated unit", () => {
    // Bound to the shipped worked example so the schema and the fixture land together.
    const file = join(REPO_ROOT, "tours", "coltrane.json");
    const raw = JSON.parse(readFileSync(file, "utf8")) as { resources?: Array<Record<string, unknown>> };
    for (const r of raw.resources ?? []) {
      expect(typeof r.unit, "every declared resource states a unit").toBe("string");
      expect(typeof r.transferable, "every declared resource states transferability").toBe("boolean");
    }
  });
});
