// statutory-checklist — the §101/§102/§103/§112 rubric the examiner must complete in full.
// Pure/deterministic. Every statute is always present with its question; the examiner supplies
// per-statute { cleared, rejection } in input.assessments keyed by statute. all_cleared is
// derived (true iff every statute is explicitly cleared) — an unaddressed statute is NOT cleared,
// so the adversary cannot pass a claim by silence.
const STATUTES = [
  { statute: "§101", question: "Is the claim directed to patent-eligible subject matter (not an abstract idea / law of nature without an inventive concept)?" },
  { statute: "§102", question: "Is the claim anticipated — does a single prior-art reference disclose every element?" },
  { statute: "§103", question: "Is the claim obvious over a combination of references to a person of ordinary skill?" },
  { statute: "§112", question: "Is the claim enabled and definite — could a skilled person build it, and is each term bounded?" },
];
export default function run(input) {
  const a = (input && typeof input.assessments === "object" && input.assessments) || {};
  const checklist = STATUTES.map((s) => {
    const got = a[s.statute] || {};
    return {
      statute: s.statute,
      question: s.question,
      cleared: got.cleared === true,
      rejection: typeof got.rejection === "string" ? got.rejection : null,
    };
  });
  const all_cleared = checklist.every((c) => c.cleared);
  return { checklist, all_cleared, statutes_checked: STATUTES.map((s) => s.statute) };
}
