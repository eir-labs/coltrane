// patent-fetch — query USPTO PatentsView for prior art.
//
// The deterministic core is the PARSER: given input.mock_response (a PatentsView payload),
// it maps patents -> structured hits with zero I/O (this is what the fixture exercises, so
// determinism_ratio is 1.0). The live path fetches when given input.query; if the cage
// blocks the network, it degrades to { hits: [], error } and the agent's own WebFetch grant
// is the retrieval path. corpus is always 'patentsview' — coverage-report attests it.
function parse(resp) {
  const patents = resp && Array.isArray(resp.patents) ? resp.patents : [];
  return patents.map((p) => ({
    source: "USPTO PatentsView",
    patent_number: p.patent_id ?? p.patent_number ?? "",
    title: p.patent_title ?? p.title ?? "",
    date: p.patent_date ?? p.date ?? "",
    abstract: p.patent_abstract ?? p.abstract ?? "",
  }));
}

export default async function run(input) {
  const query = input && input.query ? String(input.query) : "";
  if (input && input.mock_response) {
    return { corpus: "patentsview", query, hits: parse(input.mock_response) };
  }
  const q = JSON.stringify({ _text_any: { patent_title: query } });
  const f = JSON.stringify(["patent_id", "patent_title", "patent_date", "patent_abstract"]);
  const url = `https://search.patentsview.org/api/v1/patent/?q=${encodeURIComponent(q)}&f=${encodeURIComponent(f)}`;
  try {
    const res = await fetch(url);
    const json = await res.json();
    return { corpus: "patentsview", query, hits: parse({ patents: json.patents ?? [] }) };
  } catch (e) {
    return { corpus: "patentsview", query, hits: [], error: String((e && e.message) || e) };
  }
}
