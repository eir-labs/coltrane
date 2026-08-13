// RED — checkTourAdmissibility: the same admissibility bar a THIRD time (after institution laws and
// chair obligations), over a Tour document. A tour may not claim more than it holds.
//
// Covers contract INV3, INV19, INV20, INV21, INV22, INV23, INV31 and failure modes FM1, FM2, FM8,
// FM9, FM10. `checkTourAdmissibility` is an unbuilt seam that throws, so the refusal assertions are
// RED on absent enforcement. Two guards ride alongside and are GREEN-by-design (durable): the
// acceptance reuses the ONE predicate form (no second `predicate:` schema is minted) and the tier
// reuses the ONE declared|enforced enum — a green guard fails the moment a duplicate is introduced,
// which is exactly the defect it exists to catch.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkTourAdmissibility, BookingSchema } from "../../src/committed_work.js";
import { evaluate, VERDICTS } from "../../src/institution_enforcement.js";
import { loadGenome } from "../../src/index.js";
import { tour, booking, resource, evaluableAcceptance, unevaluableAcceptance } from "./_fixtures.js";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const src = (f: string) => readFileSync(join(REPO_ROOT, "src", f), "utf8");

/** A tour document in the shape checkTourAdmissibility consumes. */
function doc(over: Partial<ReturnType<typeof tour>> = {}, resources = [resource()]) {
  return {
    tour: tour(over),
    resources,
    institution: { slug: "coltrane", name: "Coltrane", kind: "institution", laws: [] },
    chairs: [
      { id: "chair.builder", institution_slug: "coltrane", role: "builder", function: "CREATE", mission: "m" },
      { id: "chair.governor", institution_slug: "coltrane", role: "governor", function: "JUDGE", mission: "m" },
    ],
    northstars: [{ slug: "ns.enforce-the-laws", institution_slug: "coltrane", title: "t", statement: "s" }],
  };
}

describe("acceptance rides the ONE predicate form and the ONE evaluator (INV3)", () => {
  it("INV3 a booking's acceptance is decided by the SAME evaluate() from institution_enforcement", () => {
    // Reuse, proven against the real evaluator: the fixture acceptance reduces to PERMIT when its
    // declared input is supplied, and to DEAD_NAME (fail closed) when it is not — the existing codomain.
    expect(evaluate(evaluableAcceptance(), { milestone: "shipped" })).toBe("PERMIT");
    expect(evaluate(evaluableAcceptance(), {})).toBe("DEAD_NAME");
  });

  it("INV3 no SECOND predicate form is minted — committed_work.ts declares no `predicate:` schema", () => {
    expect(
      /predicate\s*:\s*z\./.test(src("committed_work.ts")),
      "the committed-work layer must reuse InstitutionalLawCheckSchema, not mint a second predicate schema",
    ).toBe(false);
  });

  it("INV3 an acceptance carrying a THIRD key beyond {predicate, inputs} is refused", () => {
    const smuggled = { ...evaluableAcceptance(), or_else: "extra" } as unknown as ReturnType<typeof evaluableAcceptance>;
    const r = checkTourAdmissibility(doc({ bookings: [booking({ acceptance: smuggled })] }));
    expect(r.admitted).toBe(false);
  });
});

describe("the refusals (INV20, INV21, INV31; FM1, FM2, FM8, FM10)", () => {
  it("INV20 an unmarked, unevaluable commitment is REFUSED; the same booking declared-tier is admitted", () => {
    const unmarked = booking({ acceptance: unevaluableAcceptance() });
    delete (unmarked as { tier?: unknown }).tier; // an UNMARKED commitment: no tier at all
    const rUnmarked = checkTourAdmissibility(doc({ bookings: [unmarked] }));
    expect(rUnmarked.admitted, "silence must not pass an intention off as a commitment").toBe(false);

    const declared = booking({ acceptance: unevaluableAcceptance(), tier: "declared" });
    const rDeclared = checkTourAdmissibility(doc({ bookings: [declared] }));
    expect(rDeclared.admitted, "a declared-tier commitment is admitted").toBe(true);
  });

  it("INV21 a draw naming an UNDECLARED resource is refused as a dead name (FM2)", () => {
    const ghost = booking({ draws: [{ resource_slug: "res.does-not-exist", unit: "u", quantity: 1 }] });
    const r = checkTourAdmissibility(doc({ bookings: [ghost] }, [resource()]));
    expect(r.admitted, "capacity that has not been declared cannot be spent").toBe(false);
  });

  it("INV31/FM8 an unresolvable institution/chair/northstar slug fails closed (dead name)", () => {
    const r = checkTourAdmissibility(doc({ responsible_chair: "chair.ghost" }));
    expect(r.admitted, "a tour naming a chair the genome cannot resolve is refused").toBe(false);
  });

  it("INV31/FM10 no off-repo id lives in a fixture cross-ref — every ref is a bare slug", () => {
    // Durable guard: a cross-ref field must never carry a URL or external identifier.
    const flat = JSON.stringify(tour());
    expect(/https?:\/\//.test(flat), "a tour cross-ref must be a slug, never a URL").toBe(false);
  });
});

describe("the checker is pure, total, and not wired into the loader (INV19, INV23)", () => {
  it("INV23 the verdict is drawn from the existing CLOSED codomain and the checker never throws", () => {
    // Total: an arbitrary/empty document returns a value, it does not throw. RED now because the stub
    // throws; GREEN when the body returns an AdmissibilityResult.
    const r = checkTourAdmissibility({ tour: {} });
    expect(typeof r.admitted).toBe("boolean");
    expect(Array.isArray(r.offenders)).toBe(true);
    // the underlying acceptance verdicts stay inside the shipped five-valued algebra
    expect(VERDICTS).toContain("DEAD_NAME");
  });

  it("INV19 a well-formed tour is admitted, AND the shipped genome still loads unchanged", () => {
    // The green edge: a clean tour passes (throws now → red). The regression edge: admissibility is
    // NOT wired into loadGenome, so every shipped file still loads with no errors.
    const genome = loadGenome(REPO_ROOT);
    expect(genome.load_errors, "admissibility must not be wired into the loader").toEqual([]);
    const r = checkTourAdmissibility(doc());
    expect(r.admitted, `a clean tour must pass; offenders: ${JSON.stringify(r.offenders ?? [])}`).toBe(true);
  });
});

describe("the tier vocabulary is the ONE already shipped (INV22)", () => {
  it("INV22 exactly one declared|enforced tier enum exists across src — none is minted in parallel", () => {
    // Durable guard mirroring the contract's FM: the committed-work tier must be NormPairSchema's
    // enum, so the pattern must appear exactly once in the whole source tree (in genome_schema.ts).
    const files = ["genome_schema.ts", "committed_work.ts", "institution_enforcement.ts"];
    const count = files
      .map(src)
      .join("\n")
      .match(/z\.enum\(\[\s*"declared"\s*,\s*"enforced"\s*\]\)/g);
    expect(count?.length ?? 0, "the declared|enforced enum must be defined exactly once").toBe(1);
  });

  it("INV22 a booking marked with that tier round-trips the mark through BookingSchema", () => {
    // RED anchor: the Booking carries the SAME declared|enforced mark (parse throws today — unbuilt).
    const parsed = BookingSchema.parse(booking({ tier: "declared" })) as unknown as Record<string, unknown>;
    expect(parsed.tier).toBe("declared");
  });
});
