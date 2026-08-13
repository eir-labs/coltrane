// RED-first spec for INSTITUTION-DOCUMENT ADMISSIBILITY (item 2 of "Coltrane enforces the laws it
// declares"). A document may not claim more enforcement than it has. Every assertion runs against
// the REAL callsite — `checkInstitutionAdmissibility(doc)` in src/institution_enforcement.ts — and
// against synthetic bad documents plus the two shipped institutions. It is RED because that check
// is an unimplemented stub that throws; it is not red for a type error (the signature and result
// shape are authored, so `tsc --noEmit` is clean). The GREEN change fills the body.
//
// Admissibility is an explicitly-invoked pure function, deliberately NOT wired into loadGenome — a
// universal gate would refuse quartet.json (unmarked obligations, non-fact-decidable operators) and
// break the "every shipped file loads unchanged" acceptance (I16).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { InstitutionSchema, InstitutionalChairSchema } from "../src/genome_schema.js";
import { checkInstitutionAdmissibility } from "../src/institution_enforcement.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

interface RawDoc {
  institution: { laws: Array<Record<string, unknown>>; [k: string]: unknown };
  chairs: Array<Record<string, unknown>>;
}
function load(file: string): RawDoc {
  return JSON.parse(readFileSync(join(REPO_ROOT, "institutions", file), "utf8")) as RawDoc;
}
const coltrane = load("coltrane.json");
const quartet = load("quartet.json");

/** A clean law: predicate references exactly its declared inputs, non-empty or_else, real operators. */
function goodLaw(): Record<string, unknown> {
  return {
    attributes: "any seated agent",
    deontic: "forbidden",
    aim: "merge into the protected main line",
    conditions: "at all times",
    or_else: "the merge is refused",
    check: { predicate: '(=> (= action "merge-main") deny)', inputs: { action: "action-kind" } },
    content_hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  };
}
/** A clean chair carrying the given obligations. */
function chairWith(obligations: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    id: "synthetic.chair.builder",
    institution_slug: "synthetic",
    role: "builder",
    function: "CREATE",
    mission: "hold the office that makes the thing, from the upstream record alone",
    required_skills: [],
    caps: [],
    obligations,
  };
}
/** A synthetic document built from clean parts plus explicit overrides. */
function doc(
  laws: Array<Record<string, unknown>>,
  chairs: Array<Record<string, unknown>>,
): { institution: Record<string, unknown>; chairs: Array<Record<string, unknown>> } {
  return {
    institution: { slug: "synthetic", name: "Synthetic", kind: "institution", laws, sovereign: false, lineage: [] },
    chairs,
  };
}

describe("institution-document admissibility — a document may not overclaim its enforcement", () => {
  it("I10 ADMISSIBILITY-PARSE: a law whose predicate does not parse is refused", () => {
    const bad = goodLaw();
    (bad.check as Record<string, unknown>).predicate = "(=> (and (unbalanced"; // not a well-formed s-expr
    const result = checkInstitutionAdmissibility(doc([bad], [chairWith([])]));
    expect(result.admitted).toBe(false);
    expect(result.offenders.some((o) => o.kind === "law")).toBe(true);
  });

  it("I11 VAR-DECLARATION-CLOSURE: an undeclared variable or an unused declaration is refused", () => {
    // (a) predicate references `mystery`, which is not declared in inputs.
    const undeclared = goodLaw();
    (undeclared.check as Record<string, unknown>).predicate = '(=> (= mystery "x") deny)';
    const rA = checkInstitutionAdmissibility(doc([undeclared], [chairWith([])]));
    expect(rA.admitted, "an undeclared free variable must be refused").toBe(false);
    // (b) inputs declares `target_branch`, which the predicate never references (a typo-mask).
    const unused = goodLaw();
    (unused.check as Record<string, unknown>).inputs = { action: "action-kind", target_branch: "branch-name" };
    const rB = checkInstitutionAdmissibility(doc([unused], [chairWith([])]));
    expect(rB.admitted, "an unused declared input must be refused").toBe(false);
  });

  it("I12 OPERATOR-IMPLEMENTED-STATIC: an unimplemented operator is refused at admissibility", () => {
    const bad = goodLaw();
    (bad.check as Record<string, unknown>).predicate = "(florble action)";
    const result = checkInstitutionAdmissibility(doc([bad], [chairWith([])]));
    expect(result.admitted).toBe(false);
    expect(result.offenders.some((o) => o.kind === "law")).toBe(true);
  });

  it("I13 OR_ELSE-NONEMPTY: an empty or_else is refused, a non-empty one admitted", () => {
    const empty = goodLaw();
    empty.or_else = ""; // the schema's z.string() lets '' through; admissibility must catch it
    expect(checkInstitutionAdmissibility(doc([empty], [chairWith([])])).admitted).toBe(false);
    expect(checkInstitutionAdmissibility(doc([goodLaw()], [chairWith([])])).admitted).toBe(true);
  });

  it("I14 OBLIGATION-TIER: an unmarked unverified obligation is refused, a declared-tier one admitted", () => {
    const bareObligation = { attributes: "the builder", aim: "settle the structure before building", deontic: "obliged" };
    const unmarked = checkInstitutionAdmissibility(doc([goodLaw()], [chairWith([bareObligation])]));
    expect(unmarked.admitted, "an unmarked unverified obligation must be refused").toBe(false);
    expect(unmarked.offenders.some((o) => o.kind === "obligation")).toBe(true);

    const markedObligation = { ...bareObligation, tier: "declared" };
    const marked = checkInstitutionAdmissibility(doc([goodLaw()], [chairWith([markedObligation])]));
    expect(marked.admitted, "a declared-tier obligation must be admitted").toBe(true);
  });

  it("I15 COLLECT-ALL-REFUSE-ONCE: two distinct offenders both appear in one refusal", () => {
    const emptyOrElse = goodLaw();
    emptyOrElse.or_else = "";
    const bareObligation = { attributes: "the builder", aim: "do the thing", deontic: "obliged" };
    const result = checkInstitutionAdmissibility(doc([emptyOrElse], [chairWith([bareObligation])]));
    expect(result.admitted).toBe(false);
    expect(result.offenders.some((o) => o.kind === "law")).toBe(true);
    expect(result.offenders.some((o) => o.kind === "obligation")).toBe(true);
    expect(result.offenders.length, "collect-all must not stop at the first offender").toBeGreaterThanOrEqual(2);
  });

  it("I16 ADMISSIBILITY-IS-NOT-SCHEMA-VALIDITY: an inadmissible document still parses", () => {
    // AMENDED by governor decision. This assertion originally read "quartet.json is inadmissible yet
    // still loads", using a SHIPPED file as its example of an overclaiming document. Two problems
    // with that: it pinned a defect in our own genome as intended behaviour, and it made a general
    // invariant depend on one of our documents staying broken. quartet.json has since been fixed —
    // its 17 obligations are marked declared-tier, and the two laws reported as referencing
    // undeclared variables were never broken at all (the checker mistook `forall`'s binder for a
    // free variable; see tests/institution_admissibility_gate.test.ts).
    //
    // The invariant the test was really for survives intact and is stated here on a SYNTHETIC
    // document: admissibility and schema validity are different bars. A document can be structurally
    // well-formed and still claim more enforcement than it has, which is precisely why the
    // admissibility check exists as something separate from `.parse()`.
    const overclaiming = {
      institution: { slug: "overclaim", name: "Overclaim", kind: "institution" as const, laws: [] },
      chairs: [
        {
          slug: "c",
          institution_slug: "overclaim",
          role: "a-role",
          function: "JUDGE",
          mission: "m",
          // An obligation neither verified nor marked declared-tier: silence passing for a rule.
          obligations: [{ attributes: "the incumbent", aim: "do the thing", deontic: "obliged" as const }],
        },
      ],
    };
    const admissibility = checkInstitutionAdmissibility(overclaiming);
    expect(admissibility.admitted, "an unmarked, unverified obligation must be refused").toBe(false);
    // Yet the section schemas still parse it whole — parsing is structure, admissibility is claim.
    expect(() => InstitutionSchema.parse(overclaiming.institution)).not.toThrow();
    for (const chair of overclaiming.chairs) {
      expect(() => InstitutionalChairSchema.parse(chair)).not.toThrow();
    }
  });

  it("I16b: every SHIPPED institution document is now admissible — the defect was fixed, not pinned", () => {
    for (const [name, doc] of [["quartet.json", quartet], ["coltrane.json", coltrane]] as const) {
      const r = checkInstitutionAdmissibility({ institution: doc.institution, chairs: doc.chairs });
      expect(r.admitted, `${name} offenders: ${JSON.stringify(r.offenders)}`).toBe(true);
    }
  });

  it("I19 COLTRANE-ADMISSIBLE: institutions/coltrane.json passes its own admissibility bar", () => {
    const result = checkInstitutionAdmissibility({ institution: coltrane.institution, chairs: coltrane.chairs });
    expect(
      result.admitted,
      `coltrane.json must be the worked example that passes; offenders: ${JSON.stringify(result.offenders)}`,
    ).toBe(true);
  });
});
