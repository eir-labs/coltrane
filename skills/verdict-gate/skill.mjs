// verdict-gate — the hard guard on the triage verdict. Pure/deterministic.
//
// Runs as a skill-backed CHAIR (not bound prompt guidance): the gate is the seat between the
// judge's candidate verdict and the final triage-verdict, so a FILEABLE the evidence doesn't
// support can never be sealed downstream:
//   - coverage gate: FILEABLE requires a patent corpus to have actually been searched
//     (>=1 patent corpus named in corpora_searched). Searched-and-found-nothing still counts;
//     never-searched does not.
//   - survival gate: FILEABLE requires survival_count >= 1 (the claim cleared an examine round).
// A FILEABLE failing either is downgraded to INSUFFICIENT-EVIDENCE with the reason recorded.
// Non-FILEABLE candidates pass through unchanged.
//
// As a chair, its input is the MERGE of its depends_on roles (the judge's candidate verdict +
// the search coverage-report + the latest examine-round-record), so it reads:
//   recommended      ← the candidate verdict
//   corpora_searched ← the coverage-report (entries may be strings OR {corpus,status} objects)
//   survival_count   ← explicit, else derived from the examine-round-record's `survived` boolean
// It seals a triage-verdict: a deterministic recommended + rationale, plus the gate provenance.
const PATENT_CORPUS = /patent|patentsview|uspto|espacenet|lens/i;

// A coverage-report corpus entry is either a bare string or an object {corpus|name, status}.
function corpusName(c) {
  if (typeof c === "string") return c;
  if (c && typeof c === "object") return String(c.corpus ?? c.name ?? "");
  return "";
}

export default function run(input) {
  const recommended = String((input && input.recommended) || "");
  const corpora = Array.isArray(input && input.corpora_searched) ? input.corpora_searched : [];
  // survival_count is preferred when supplied; otherwise derive it from the examine-round-record's
  // `survived` boolean (survived → the claim cleared >=1 round). Absent both → 0 (never survived).
  let survival = Number(input && input.survival_count);
  if (!Number.isFinite(survival) || (input && input.survival_count == null)) {
    survival = input && input.survived === true ? 1 : 0;
  }
  const hasPatentCoverage = corpora.some((c) => PATENT_CORPUS.test(corpusName(c)));

  const gate_reasons = [];
  let finalRec = recommended;
  if (recommended === "FILEABLE") {
    if (!hasPatentCoverage) {
      finalRec = "INSUFFICIENT-EVIDENCE";
      gate_reasons.push("coverage gate: no patent corpus was searched — novelty cannot be asserted");
    } else if (survival < 1) {
      finalRec = "INSUFFICIENT-EVIDENCE";
      gate_reasons.push("survival gate: the claim did not survive an examine round");
    }
  }
  const gated = finalRec !== recommended;
  // Deterministic rationale — the gate does NOT borrow the candidate's prose (the merged blob
  // can carry other roles' `rationale`); it states the gate outcome plainly. The judge's full
  // reasoning lives in the separately-sealed verdict-record.
  const rationale = gated
    ? `Gated to ${finalRec} from ${recommended}: ${gate_reasons.join("; ")}.`
    : `${finalRec} upheld — patent coverage: ${hasPatentCoverage}; survived rounds: ${survival}.`;
  return {
    recommended: finalRec,
    rationale,
    original_recommended: recommended,
    gated,
    gate_reasons,
    has_patent_coverage: hasPatentCoverage,
    survival_count: survival,
  };
}
