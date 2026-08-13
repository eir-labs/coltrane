// RED-first spec for the institutional-law predicate EVALUATOR (item 1 of "Coltrane enforces the
// laws it declares"). Every assertion below runs against the REAL callsite —
// `evaluate(check, facts)` in src/institution_enforcement.ts — and the REAL shipped predicates in
// institutions/coltrane.json. It is RED because that evaluator is an unimplemented stub that
// throws; it is not red for a type error (the signature and the closed `Verdict` codomain are
// authored, so `tsc --noEmit` is clean). The GREEN change fills the body.
//
// Fact-record convention this spec fixes (documented in docs/specs/coltrane-enforces-its-laws.md):
//   - a `principal` fact (e.g. `actor`) is an object; `(is-agent x)` reads `x.is_agent === true`
//     and `(human-governor x)` reads `x.human_governor === true`.
//   - `action`, `source`, `ci-status` and the like are supplied as their literal string values.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { InstitutionSchema, type InstitutionalLawOutput } from "../src/genome_schema.js";
import { evaluate, VERDICTS, type LawCheck, type Verdict } from "../src/institution_enforcement.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const coltrane = JSON.parse(
  readFileSync(join(REPO_ROOT, "institutions", "coltrane.json"), "utf8"),
) as { institution: unknown };

const laws: InstitutionalLawOutput[] = InstitutionSchema.parse(coltrane.institution).laws;
const lawA = laws.find((l) => l.deontic === "forbidden")!; // non-governor forbidden to merge main
const lawB = laws.find((l) => l.deontic === "permitted")!; // permitted to open a pull request
const lawC = laws.find((l) => l.deontic === "obliged")!; // green CI obliged before any merge

/** A superset fact record covering every input any of the three laws declares. */
function fullValidFacts(): FactRecordish {
  return {
    actor: { is_agent: true, human_governor: false },
    action: "merge-main",
    target_branch: "main",
    source: "feature-x",
    "ci-status": "green",
  };
}
type FactRecordish = Record<string, unknown>;

/** Arbitrary, ill-shaped fact records — the evaluator must be TOTAL over all of them. */
const arbFacts = fc.dictionary(
  fc.string(),
  fc.oneof(fc.string(), fc.boolean(), fc.integer(), fc.constant(null)),
);

describe("the institutional-law evaluator — safety axioms (property-based)", () => {
  it("I1 TOTALITY: evaluate returns one closed verdict and never throws", () => {
    fc.assert(
      fc.property(arbFacts, (facts) => {
        for (const law of laws) {
          expect(() => evaluate(law.check, facts)).not.toThrow();
          expect(VERDICTS).toContain(evaluate(law.check, facts));
        }
      }),
    );
  });

  it("I2 DETERMINISM: same (check, facts) yields the same verdict", () => {
    fc.assert(
      fc.property(arbFacts, (facts) => {
        for (const law of laws) {
          const a = evaluate(law.check, facts);
          const b = evaluate(law.check, facts);
          expect(a).toBe(b);
        }
      }),
    );
  });

  it("I3 FAIL-CLOSED-ON-MISSING-INPUT: a missing declared input is never PERMIT (DEAD_NAME)", () => {
    for (const law of laws) {
      for (const missing of Object.keys(law.check.inputs)) {
        fc.assert(
          fc.property(arbFacts, (extra) => {
            const facts: FactRecordish = { ...fullValidFacts(), ...extra };
            delete facts[missing];
            const v = evaluate(law.check, facts);
            expect(v).toBe("DEAD_NAME");
            expect(v).not.toBe("PERMIT");
          }),
        );
      }
    }
  });

  it("I4 NON-COERCION: NOT_APPLICABLE and UNDECIDED are never rewritten to a decision", () => {
    // A guard that does not fire → NOT_APPLICABLE, not a decision.
    const notApplicable = evaluate(lawA.check, {
      actor: { is_agent: true, human_governor: true },
      action: "merge-main",
      target_branch: "main",
    });
    expect(notApplicable).toBe("NOT_APPLICABLE");
    expect(notApplicable).not.toBe("PERMIT");
    expect(notApplicable).not.toBe("DENY");
    // A predicate the fact-only evaluator cannot reduce → UNDECIDED, not a decision.
    const undecided = evaluate(
      { predicate: "(forall o grant_objects (resolvable o genome))", inputs: { grant_objects: "string[]" } },
      { grant_objects: ["x"] },
    );
    expect(undecided).toBe("UNDECIDED");
    expect(undecided).not.toBe("PERMIT");
    expect(undecided).not.toBe("DENY");
  });
});

describe("the institutional-law evaluator — verdict-algebra reduction (table-driven)", () => {
  it("I5 GUARD-SEMANTICS: (=> P Q) is NOT_APPLICABLE when P is false, reduces Q when true", () => {
    // P true → reduces Q (a deny atom) → DENY.
    expect(
      evaluate(lawA.check, {
        actor: { is_agent: true, human_governor: false },
        action: "merge-main",
        target_branch: "main",
      }),
    ).toBe("DENY");
    // P false (non-merge action) → NOT_APPLICABLE.
    expect(
      evaluate(lawA.check, {
        actor: { is_agent: true, human_governor: false },
        action: "open-pr",
        target_branch: "main",
      }),
    ).toBe("NOT_APPLICABLE");
  });

  it("I6 VERDICT-ATOM: a bare allow reduces to PERMIT, a bare deny reduces to DENY", () => {
    expect(
      evaluate(lawB.check, { actor: { is_agent: true }, action: "open-pr", source: "feature-x" }),
    ).toBe("PERMIT"); // Law B's consequent is the atom `allow`
    expect(
      evaluate(lawA.check, {
        actor: { is_agent: true, human_governor: false },
        action: "merge-main",
        target_branch: "main",
      }),
    ).toBe("DENY"); // Law A's consequent is the atom `deny`
  });

  it("I7 REQUIRE-SEMANTICS: (require R) is PERMIT when R holds, DENY when it fails", () => {
    expect(evaluate(lawC.check, { action: "merge-main", "ci-status": "green" })).toBe("PERMIT");
    expect(evaluate(lawC.check, { action: "merge-main", "ci-status": "red" })).toBe("DENY");
  });

  it("I8 UNKNOWN-OPERATOR-AT-RUNTIME: an unimplemented operator returns UNDECIDED", () => {
    const v = evaluate({ predicate: "(florble x)", inputs: { x: "thing" } }, { x: 1 });
    expect(v).toBe("UNDECIDED");
    expect(v).not.toBe("PERMIT");
  });

  it("I9 INTERFACE-STABILITY: the verdict codomain is exactly the five closed values", () => {
    // Compile-time exhaustiveness: this only type-checks while Verdict is exactly the closed union.
    const _closed: (v: Verdict) => "PERMIT" | "DENY" | "NOT_APPLICABLE" | "UNDECIDED" | "DEAD_NAME" = (
      v,
    ) => v;
    void _closed;
    // Runtime codomain closure: no shipped law ever produces a value outside the five.
    for (const law of laws) {
      expect(VERDICTS).toContain(evaluate(law.check, fullValidFacts()));
    }
  });
});

describe("the three shipped Coltrane laws — one refusal and one permission each", () => {
  it("I20 LAW-A-REDUCTION: non-governor merge is DENY, governor or non-merge is NOT_APPLICABLE", () => {
    expect(
      evaluate(lawA.check, {
        actor: { is_agent: true, human_governor: false },
        action: "merge-main",
        target_branch: "main",
      }),
    ).toBe("DENY");
    expect(
      evaluate(lawA.check, {
        actor: { is_agent: true, human_governor: true },
        action: "merge-main",
        target_branch: "main",
      }),
    ).toBe("NOT_APPLICABLE");
  });

  it("I21 LAW-B-REDUCTION: open-pr off a non-main branch is PERMIT, else NOT_APPLICABLE", () => {
    expect(
      evaluate(lawB.check, { actor: { is_agent: true }, action: "open-pr", source: "feature-x" }),
    ).toBe("PERMIT");
    expect(
      evaluate(lawB.check, { actor: { is_agent: true }, action: "open-pr", source: "main" }),
    ).toBe("NOT_APPLICABLE");
  });

  it("I22 LAW-C-REDUCTION: merge with red CI is DENY, green is PERMIT, non-merge is NOT_APPLICABLE", () => {
    expect(evaluate(lawC.check, { action: "merge-main", "ci-status": "red" })).toBe("DENY");
    expect(evaluate(lawC.check, { action: "merge-main", "ci-status": "green" })).toBe("PERMIT");
    expect(evaluate(lawC.check, { action: "open-pr", "ci-status": "green" })).toBe("NOT_APPLICABLE");
  });

  it("I23 PER-LAW-DEAD-NAME: each law missing a declared input is DEAD_NAME", () => {
    // Law A missing `actor`.
    expect(evaluate(lawA.check, { action: "merge-main", target_branch: "main" })).toBe("DEAD_NAME");
    // Law B missing `source`.
    expect(evaluate(lawB.check, { actor: { is_agent: true }, action: "open-pr" })).toBe("DEAD_NAME");
    // Law C missing `ci-status`.
    expect(evaluate(lawC.check, { action: "merge-main" })).toBe("DEAD_NAME");
  });
});

// A compile-time reference so `LawCheck` stays the shape the shipped laws' `check` inhabit; if a
// law's check ever diverged from {predicate, inputs} this assignment would stop type-checking.
const _checkShape: LawCheck = lawA.check;
void _checkShape;
