// obligation-adjudicate — the first caller of the predicate evaluator. Deterministic, no model.
//
// evaluate() has been in this engine with no production call-site: a mechanism with passing tests
// and nothing wired to it. This chair is the wire. It takes bearing-law records and a fact
// snapshot, evaluates each law's `check`, and seals one verdict per obligation.
//
// It deliberately does NOT widen the operator set. Every obligation whose predicate needs an
// operator the evaluator lacks comes back UNDECIDED, named, with the operator that was missing —
// so the next operator to implement is chosen by an obligation that asked for it rather than by
// a design guess. U is never rounded into a decision; that is the evaluator's own discipline and
// this chair keeps it.
//
// Decisions it makes on its own, and why:
//   - an obligation with NO check is `unadjudicable`, not a pass. A clause the machine cannot
//     decide is prose-tier work and belongs with a person.
//   - a `proposed` bearing law is not adjudicated at all: nothing is in force until it is executed.
//   - an obligor may not certify its own discharge, so this chair refuses to adjudicate a law whose
//     fact snapshot was supplied by the debtor (`facts.supplied_by === law.debtor`).
import { evaluate, KNOWN_OPERATORS } from "../../dist/src/institution_enforcement.js";

/** Operators a predicate names that the evaluator does not implement. Textual, deliberately: the
 *  point is to REPORT what an obligation asked for, not to decide it. */
function missingOperators(predicate) {
  const heads = String(predicate ?? "").match(/\(\s*([^\s()]+)/g) ?? [];
  const named = heads.map((h) => h.replace(/^\(\s*/, ""));
  // The evaluator's own set, imported rather than copied: a copy would keep naming an operator as
  // missing after it was implemented, which is backwards for a field whose whole job is "build this
  // one next". One home, two readers.
  return [...new Set(named.filter((op) => !KNOWN_OPERATORS.has(op)))];
}

export default function run(input, context) {
  const up = context && Array.isArray(context.upstream) ? context.upstream : [];
  const laws = input?.laws ?? up.filter((u) => u?.domain_type === "bearing-law").map((u) => u.data) ?? [];
  const snapshot = input?.facts ?? {};
  const facts = snapshot.facts ?? snapshot;

  const results = [];
  for (const law of laws) {
    const slug = String(law?.slug ?? law?.subject_ref ?? "(unnamed)");
    const status = String(law?.status ?? "");
    const check = law?.law?.check;
    const debtor = law?.law?.debtor ?? law?.bearer;

    if (status === "proposed") {
      results.push({ obligation: slug, outcome: "not-in-force", why: "status is proposed; nothing is in force until it is executed" });
      continue;
    }
    if (!check || !check.predicate) {
      results.push({ obligation: slug, outcome: "unadjudicable", why: "the law carries no check — a clause the machine cannot decide is a person's" });
      continue;
    }
    // An obligor does not certify its own discharge — and an UNATTRIBUTED snapshot cannot be shown
    // not to come from the debtor, so absence declines rather than passes. A settlement resting on
    // facts nobody stands behind is the case this rule exists for.
    if (!snapshot.supplied_by) {
      results.push({ obligation: slug, outcome: "refused", why: "the fact snapshot names no supplier; an unattributed snapshot cannot be shown not to come from the debtor" });
      continue;
    }
    if (debtor && snapshot.supplied_by === debtor) {
      results.push({ obligation: slug, outcome: "refused", why: `the fact snapshot was supplied by the debtor (${debtor}); an obligor does not certify its own discharge` });
      continue;
    }
    const verdict = evaluate({ predicate: check.predicate, inputs: check.inputs ?? {} }, facts);
    const missing = verdict === "UNDECIDED" ? missingOperators(check.predicate) : [];
    results.push({
      obligation: slug,
      outcome: verdict,
      why: verdict === "DEAD_NAME" ? "a declared input the snapshot does not supply" :
           verdict === "UNDECIDED" ? (missing.length ? `operators the evaluator does not implement: ${missing.join(", ")}` : "the predicate could not be reduced from these facts") :
           "decided from the snapshot",
      needs_operators: missing,
    });
  }

  const settled = results.filter((r) => r.outcome === "PERMIT" || r.outcome === "DENY");
  const needs_person = results.filter((r) => !["PERMIT", "DENY", "not-in-force"].includes(r.outcome));
  return {
    id: "obligation-adjudication",
    target_ref: String(input?.matter ?? "obligations"),
    // An empty set is not a clean sweep: nothing adjudicated is nothing proved.
    pass: results.length > 0 && needs_person.length === 0,
    checks: results.length
      ? results.map((r) => ({ method: "evaluate(check, fact-snapshot)", target_ref: r.obligation, result: `${r.outcome}: ${r.why}` }))
      : [{ method: "evaluate(check, fact-snapshot)", target_ref: "none", result: "no obligations supplied" }],
    results,
    settled: settled.map((r) => r.obligation),
    needs_person: needs_person.map((r) => r.obligation),
    operators_wanted: [...new Set(results.flatMap((r) => r.needs_operators ?? []))],
  };
}
