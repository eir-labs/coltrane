// TWO OPERATOR SETS, BOTH PINNED TO THE DISPATCH. (contract-operator-sets-v1)
//
// THE MEASURED DEFECT (review of #547, 2026-09-20). `obligation-adjudicate` reports which operator
// an obligation asked for that the evaluator cannot supply — the field whose whole job is "build
// this one next". It first carried its own copy of the operator list, which was a drift hazard, so
// the copy was replaced by importing `KNOWN_OPERATORS`. That made the structure right and the
// ANSWER wrong, because the two questions are not the same question:
//
//   KNOWN_OPERATORS (17)  — VOCABULARY. "Is this a word in the language, or a typo?" Its own
//                           comment says it is "the UNION across both shipped institutions":
//                           coltrane's fact-decidable core plus quartet's collection/temporal
//                           operators. `checkLaw` is right to use it — a misspelling must be
//                           refused at admissibility.
//   the dispatch     (10) — REDUCIBLE. What `asBool` and `asVerdict` actually `case` on:
//                           and or not = is-agent human-governor / => require allow deny.
//
// The other seven — subseteq, forall, resolvable, nonempty, declared_before, has,
// backed_by_contract — are known-but-not-fact-decidable BY DESIGN. They parse, they are real
// words, and they return UNDECIDED honestly. The file says so at :147 and :237.
//
// So an obligation whose predicate uses `subseteq` now comes back UNDECIDED with an EMPTY
// needs_operators, and the mechanism is silent for exactly the seven operators most likely to
// appear in a bearing law rather than a payment clause. The original copy of 10 was correct for
// the skill's purpose; the vocabulary set is not.
//
// THE CONTRACT. Name the second set, and pin BOTH directions against the dispatch so neither can
// drift: every reducible operator is dispatched, and every dispatched operator is declared
// reducible. Today NOTHING asserts either — not that a word in the vocabulary can be reduced, and
// not that a dispatched case is in the vocabulary. A predicate using an operator that is dispatched
// but absent from KNOWN_OPERATORS would be refused by admissibility while working perfectly at
// runtime, and nothing would catch it.
//
// And the skill must distinguish the two failures it can report, because they are different work:
// an UNKNOWN operator is a malformed law (admissibility should have caught it); an UNREDUCIBLE one
// is a real word this evaluator cannot decide from facts, and that is the "build this next" list.
//
// THESE LAWS ARE RED BY DESIGN: `REDUCIBLE_OPERATORS` does not exist, and the skill reads the
// vocabulary set.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import * as enforcement from "../src/institution_enforcement.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = readFileSync(join(REPO_ROOT, "src/institution_enforcement.ts"), "utf-8");

const KNOWN = (enforcement as unknown as { KNOWN_OPERATORS: ReadonlySet<string> }).KNOWN_OPERATORS;
const REDUCIBLE = (enforcement as unknown as { REDUCIBLE_OPERATORS?: ReadonlySet<string> }).REDUCIBLE_OPERATORS;

/**
 * The operators the evaluator ACTUALLY dispatches, read from the source of the two reducer
 * functions. Parsed rather than imported on purpose: the point is to compare a declaration against
 * the implementation, and importing the declaration twice would compare it to itself — the
 * self-satisfying-corpus failure this repo has already been bitten by.
 */
function dispatchedOperators(): Set<string> {
  const out = new Set<string>();
  for (const fn of ["asBool", "asVerdict"]) {
    const start = SRC.indexOf(`function ${fn}(`);
    expect(start, `${fn} must exist in institution_enforcement.ts for this law to mean anything`).toBeGreaterThan(-1);
    // to the next top-level `function ` declaration, or end of file
    const rest = SRC.slice(start + 1);
    const nextIdx = rest.indexOf("\nfunction ");
    const body = nextIdx === -1 ? rest : rest.slice(0, nextIdx);
    for (const m of body.matchAll(/case\s+"([^"]+)"\s*:/g)) out.add(m[1]!);
  }
  return out;
}

describe("the reducible operator set is declared, and pinned to the dispatch both ways", () => {
  it("O1 — REDUCIBLE_OPERATORS is exported, distinct from the vocabulary set", () => {
    expect(
      REDUCIBLE,
      "no REDUCIBLE_OPERATORS is exported, so the only set a caller can reach is the VOCABULARY — and a reader asking 'which operator can this evaluator not reduce' gets the wrong answer for every known-but-undecidable operator",
    ).toBeInstanceOf(Set);
    expect(REDUCIBLE!.size, "the reducible set is smaller than the vocabulary; they are not the same question").toBeLessThan(KNOWN.size);
  });

  it("O2 — every declared reducible operator is actually dispatched by asBool or asVerdict", () => {
    const dispatched = dispatchedOperators();
    expect(dispatched.size, "the parse found the reducer cases").toBeGreaterThan(5);
    const declaredNotDispatched = [...(REDUCIBLE ?? [])].filter((op) => !dispatched.has(op)).sort();
    expect(
      declaredNotDispatched,
      "an operator is declared REDUCIBLE and no case in asBool/asVerdict handles it — it would report as available while returning UNDECIDED at run",
    ).toEqual([]);
  });

  it("O3 — every dispatched operator is declared reducible", () => {
    const dispatched = dispatchedOperators();
    const dispatchedNotDeclared = [...dispatched].filter((op) => !(REDUCIBLE ?? new Set()).has(op)).sort();
    expect(
      dispatchedNotDeclared,
      "asBool/asVerdict dispatch an operator that REDUCIBLE_OPERATORS does not name — whoever adds a case must not have to remember a second list, which is the drift this contract exists to stop",
    ).toEqual([]);
  });

  it("O4 — reducible is a subset of the vocabulary: nothing decides a word the language lacks", () => {
    const reducibleNotKnown = [...(REDUCIBLE ?? [])].filter((op) => !KNOWN.has(op)).sort();
    expect(
      reducibleNotKnown,
      "an operator the evaluator reduces at runtime is absent from KNOWN_OPERATORS, so admissibility would refuse a predicate using it as an 'unimplemented operator' while the runtime decides it perfectly — a law refused for using a thing that works",
    ).toEqual([]);
  });

  it("O5 — the vocabulary-only remainder is real, and each member is an honest UNDECIDED", () => {
    const vocabularyOnly = [...KNOWN].filter((op) => !(REDUCIBLE ?? new Set()).has(op)).sort();
    expect(
      vocabularyOnly.length,
      "the two sets are identical, which would mean the distinction this contract draws does not exist",
    ).toBeGreaterThan(0);
    // Each one must reduce to UNDECIDED rather than throwing or, worse, deciding.
    for (const op of vocabularyOnly) {
      const verdict = enforcement.evaluate({ predicate: `(=> (${op} a b) allow)`, inputs: { a: "x", b: "y" } }, { a: "x", b: "y" });
      expect(
        verdict,
        `a known-but-unreducible operator "${op}" did not come back UNDECIDED — a word the evaluator cannot decide from facts must say so, never round into a decision`,
      ).toBe("UNDECIDED");
    }
  });
});

describe("obligation-adjudicate names what it cannot reduce, and separates that from a typo", () => {
  const law = (predicate: string) => ({
    slug: "obligation-under-test",
    status: "executed",
    law: { debtor: "acme", check: { predicate, inputs: { a: "a", b: "b" } } },
  });
  const snapshot = { supplied_by: "creditor-co", facts: { a: "a", b: "b" } };

  async function adjudicate(predicate: string) {
    const mod = await import(join(REPO_ROOT, "skills/obligation-adjudicate/skill.mjs"));
    const run = mod.default ?? mod.run;
    return run({ laws: [law(predicate)], facts: snapshot }, { upstream: [] }) as {
      results: { outcome: string; needs_operators?: string[]; unknown_operators?: string[] }[];
    };
  }

  it("O6 — an obligation using a KNOWN-but-unreducible operator names it as the thing to build", async () => {
    const out = await adjudicate("(=> (subseteq a b) allow)");
    const r = out.results[0]!;
    expect(r.outcome, "it cannot be reduced from facts, so it is UNDECIDED").toBe("UNDECIDED");
    expect(
      r.needs_operators,
      "the obligation asked for `subseteq`, which this evaluator cannot reduce, and the field whose job is 'build this next' said nothing — because it is reading the VOCABULARY set, which contains subseteq",
    ).toContain("subseteq");
  });

  it("O7 — a typo is reported as an unknown word, not as work to do", async () => {
    const out = await adjudicate("(=> (subsetof a b) allow)");
    const r = out.results[0]!;
    expect(
      r.unknown_operators,
      "`subsetof` is not a word in the language at all — a malformed law admissibility should have refused, which is different work from an operator worth implementing, and must not be reported as a build request",
    ).toContain("subsetof");
    expect(
      r.needs_operators ?? [],
      "a typo must not land on the build-this-next list",
    ).not.toContain("subsetof");
  });
});
