// claim-element-decompose — independent claim text -> functional elements. Pure/deterministic.
// Splits on the preamble 'comprising:' then on ';' (the standard element separators), with
// 'wherein' clauses kept as their own elements. Same claim -> same elements.
export default function run(input) {
  const text = input && input.claim_text ? String(input.claim_text) : "";
  const afterPreamble = text.split(/comprising:?/i).slice(1).join("comprising") || text;
  const raw = afterPreamble
    .split(/;|\bwherein\b/i)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 0);
  // drop a trailing bare period fragment
  const elements = raw.filter((s) => s.replace(/[.\s]/g, "").length > 2);
  return { elements };
}
