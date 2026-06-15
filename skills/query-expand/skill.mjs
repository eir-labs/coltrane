// query-expand — claim elements -> prior-art search queries. Pure/deterministic.
// Per element, strip patent boilerplate + stopwords to a keyword query; then a cross-element
// query from the most frequent keywords. Same input -> same queries (determinism_ratio 1.0).
const STOP = new Set([
  "a", "an", "the", "of", "to", "for", "and", "or", "with", "is", "in", "on", "by", "at",
  "from", "as", "that", "such", "said", "wherein", "comprising", "method", "system", "apparatus",
]);

function keywords(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

export default function run(input) {
  const elements = Array.isArray(input.elements) ? input.elements : [];
  const queries = [];
  const freq = {};
  for (const el of elements) {
    const kws = keywords(el);
    if (kws.length) queries.push(kws.slice(0, 6).join(" "));
    for (const w of kws) freq[w] = (freq[w] || 0) + 1;
  }
  const top = Object.keys(freq).sort((x, y) => freq[y] - freq[x] || (x < y ? -1 : 1)).slice(0, 8);
  if (top.length) queries.push(top.join(" "));
  return { queries };
}
