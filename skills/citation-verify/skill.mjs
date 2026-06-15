// citation-verify — is a claim about a source actually grounded in that source's FETCHED text?
// Pure/deterministic given { claim, fetched_text }: a claim is verified only when enough of its
// content terms appear in the fetched text, and the method is recorded as 'fetch' (vs 'snippet').
// This is the retrieved-not-recalled gate: no fetched_text -> unverified, never a guess.
const STOP = new Set(["a","an","the","of","to","for","and","or","with","is","in","on","by","at","from","as","that","it","its","this","these","those","not","does","do"]);

function terms(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 3 && !STOP.has(w));
}

export default function run(input) {
  const claim = input && input.claim ? String(input.claim) : "";
  const fetched = input && typeof input.fetched_text === "string" ? input.fetched_text : null;
  const method = input && input.method === "snippet" ? "snippet" : "fetch";
  if (fetched === null) {
    return { verified: false, method, reason: "no fetched_text — cannot ground a claim without retrieving the source", matched_terms: [] };
  }
  const hay = fetched.toLowerCase();
  const t = terms(claim);
  const matched = t.filter((w) => hay.includes(w));
  const ratio = t.length ? matched.length / t.length : 0;
  // a claim is grounded only when most of its content terms are present in the fetched text,
  // and only fetched (not snippet) provenance can support an anticipation finding.
  const verified = method === "fetch" && ratio >= 0.6;
  return { verified, method, coverage: ratio, matched_terms: matched };
}
