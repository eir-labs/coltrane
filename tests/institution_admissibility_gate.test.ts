// RED-first — two defects the admissibility check surfaced on its FIRST real run, plus the gate
// that stops them recurring. Governor's call: an identified defect gets fixed, not accommodated.
//
// WHAT THE FIRST RUN REPORTED. checkInstitutionAdmissibility refused institutions/quartet.json with
// two classes of offender. One class was real; the other was the checker's own bug, and telling them
// apart mattered — the available wrong move was to edit correct laws until a defective gate accepted
// them, which would have weakened a good document to please a broken checker.
//
// DEFECT 1 — QUANTIFIER BINDING (the checker's bug). Two quartet laws read:
//     (forall o grant_objects (resolvable o genome))
//     (forall x cross_institution_access (backed_by_contract x exchange_contracts))
// `o` and `x` are BOUND by the quantifier; `grant_objects`, `genome`, `cross_institution_access`
// and `exchange_contracts` are all declared in check.inputs. But collectSymbols treats every
// non-head symbol as a free variable, so it collected the binders and reported them undeclared.
// The laws are well-formed. `forall` is already in KNOWN_OPERATORS — the evaluator knew the
// operator and not its scoping.
//
// DEFECT 2 — UNMARKED OBLIGATIONS (real). Every quartet chair obligation was neither verified nor
// marked declared-tier. That is not sloppiness: lineage-record 03cacf6a establishes that this
// institution's obligation layer is knowingly unverified and that beginning to ENFORCE it would be
// a design change, not a bug fix. So the fix is to MARK them, making the honest state legible,
// rather than to start enforcing them.
//
// THE GATE. Admissibility shipped as an explicitly-invoked pure function, deliberately NOT a load
// gate, because a universal gate would have refused quartet.json and broken the "every shipped file
// loads unchanged" acceptance — a criterion I wrote, which turned out to be shielding a document
// that overclaimed. Fixing the document dissolves the tension instead of trading against it: the
// gate turns on AND every shipped file still loads, because they now pass.
//
// Note on where the gate lives: `institutions/` has NO loader — zero readers in src/ — so there is
// no load path to gate. CI is the enforcement that exists today, and under Law C of
// institutions/coltrane.json a red gate blocks merge. When the institution loader lands, this
// invariant is what it should refuse on.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkInstitutionAdmissibility, evaluate } from "../src/institution_enforcement.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const INST_DIR = join(REPO_ROOT, "institutions");

interface Doc {
  institution: Record<string, unknown>;
  chairs?: unknown[];
}
const load = (f: string): Doc => JSON.parse(readFileSync(join(INST_DIR, f), "utf8")) as Doc;
const files = (): string[] => readdirSync(INST_DIR).filter((f) => f.endsWith(".json"));

describe("quantifier binding — a bound variable is not an undeclared input", () => {
  it("accepts a forall whose binder is not declared in inputs (it is bound, not free)", () => {
    const law = {
      attributes: "any seated agent",
      deontic: "forbidden",
      aim: "name a thing the genome does not contain",
      conditions: "at all times",
      or_else: "the grant is refused as a dead name",
      check: {
        // `o` is introduced by the quantifier. Only grant_objects and genome are free.
        predicate: "(forall o grant_objects (resolvable o genome))",
        inputs: { grant_objects: "object-list", genome: "genome" },
      },
      content_hash: "sha256:test",
    };
    const r = checkInstitutionAdmissibility({
      institution: { slug: "t", name: "T", kind: "institution", laws: [law] },
      chairs: [],
    });
    const undeclared = r.offenders.filter((o) => /undeclared variable/.test(o.reason));
    expect(
      undeclared,
      "the quantifier's bound variable was reported as an undeclared input — the checker knows " +
        "`forall` as an operator but not as a binder, so a well-formed law is refused",
    ).toEqual([]);
  });

  it("STILL catches a genuinely free undeclared variable inside a quantifier body", () => {
    // The fix must not become a blanket amnesty: `mystery` is free and undeclared.
    const law = {
      attributes: "a", deontic: "forbidden", aim: "b", conditions: "c", or_else: "d",
      check: {
        predicate: "(forall o grant_objects (resolvable o mystery))",
        inputs: { grant_objects: "object-list" },
      },
      content_hash: "sha256:test",
    };
    const r = checkInstitutionAdmissibility({
      institution: { slug: "t", name: "T", kind: "institution", laws: [law] },
      chairs: [],
    });
    expect(
      r.offenders.some((o) => /undeclared variable "mystery"/.test(o.reason)),
      "a genuinely free undeclared variable slipped through — the binder fix over-applied",
    ).toBe(true);
  });

  it("does not report the binder as an unreferenced declared input either", () => {
    const law = {
      attributes: "a", deontic: "forbidden", aim: "b", conditions: "c", or_else: "d",
      check: {
        predicate: "(forall x cross_institution_access (backed_by_contract x exchange_contracts))",
        inputs: { cross_institution_access: "access-list", exchange_contracts: "contract-list" },
      },
      content_hash: "sha256:test",
    };
    const r = checkInstitutionAdmissibility({
      institution: { slug: "t", name: "T", kind: "institution", laws: [law] },
      chairs: [],
    });
    expect(r.offenders, `unexpected offenders: ${JSON.stringify(r.offenders)}`).toEqual([]);
  });

  it("a bound variable still evaluates to UNDECIDED rather than a silent decision", () => {
    // forall is a known-but-not-fact-decidable operator. Fixing the SCOPING must not accidentally
    // make it reducible — the honest answer from facts alone is still UNDECIDED.
    const v = evaluate(
      { predicate: "(forall o grant_objects (resolvable o genome))", inputs: { grant_objects: "object-list", genome: "genome" } },
      { grant_objects: [], genome: {} },
    );
    expect(v).toBe("UNDECIDED");
  });
});

describe("THE GATE — every shipped institution document is admissible", () => {
  it("finds institution documents to check (the guard is not vacuously green)", () => {
    expect(files().length, "no institution documents found — this gate would pass on nothing").toBeGreaterThan(0);
  });

  it.each(files())("%s passes its own admissibility bar", (f) => {
    const doc = load(f);
    const r = checkInstitutionAdmissibility({ institution: doc.institution, chairs: doc.chairs ?? [] });
    expect(
      r.offenders,
      `${f} claims more enforcement than it has:\n` +
        r.offenders.map((o) => `  [${o.kind}] ${o.ref} — ${o.reason}`).join("\n"),
    ).toEqual([]);
    expect(r.admitted).toBe(true);
  });
});
