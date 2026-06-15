// verdict-gate — the hard guard on the triage verdict. Pure/deterministic.
//
// The judge constructs its final recommendation by running this gate, so a FILEABLE that the
// evidence doesn't support can never be emitted:
//   - coverage gate: FILEABLE requires a patent corpus to have actually been searched
//     (>=1 patent corpus named in corpora_searched). Searched-and-found-nothing still counts;
//     never-searched does not.
//   - survival gate: FILEABLE requires survival_count >= 1 (the claim cleared an examine round).
// A FILEABLE failing either is downgraded to INSUFFICIENT-EVIDENCE with the reason recorded.
// Non-FILEABLE candidates pass through unchanged.
const PATENT_CORPUS = /patent|patentsview|uspto|espacenet|lens/i;

export default function run(input) {
  const recommended = String((input && input.recommended) || "");
  const corpora = Array.isArray(input && input.corpora_searched) ? input.corpora_searched : [];
  const survival = Number((input && input.survival_count) || 0);
  const hasPatentCoverage = corpora.some((c) => PATENT_CORPUS.test(String(c)));

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
  return {
    recommended: finalRec,
    original_recommended: recommended,
    gated: finalRec !== recommended,
    gate_reasons,
    has_patent_coverage: hasPatentCoverage,
    survival_count: survival,
  };
}
