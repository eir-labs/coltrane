// element-mapping-matrix — scaffold the element x reference anticipation grid + a recomputable
// coverage_fraction. Pure/deterministic. Rows = claim elements, cols = prior-art references;
// each cell defaults 'unmapped' unless a status is supplied in input.cells (keyed
// "<elementIndex>:<refIndex>" -> "present"|"absent"|"partial"). coverage_fraction is the share
// of (element x ref) cells judged present|partial — a derived number, not a hand-typed score.
const FILLED = new Set(["present", "partial"]);
export default function run(input) {
  const elements = Array.isArray(input.elements) ? input.elements : [];
  const references = Array.isArray(input.references) ? input.references : [];
  const cells = (input && typeof input.cells === "object" && input.cells) || {};
  const matrix = elements.map((el, i) => ({
    element: el,
    cells: references.map((ref, j) => ({ reference: ref, status: cells[`${i}:${j}`] ?? "unmapped" })),
  }));
  const total = elements.length * references.length;
  let filled = 0;
  for (const row of matrix) for (const c of row.cells) if (FILLED.has(c.status)) filled++;
  const coverage_fraction = total > 0 ? filled / total : 0;
  return { matrix, coverage_fraction, element_count: elements.length, reference_count: references.length };
}
