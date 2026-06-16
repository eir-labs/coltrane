// patent-fetch — grounded prior-art retrieval. Google Patents server-renders the bibliography
// into HTML, so a plain HTTPS GET yields a full, verifiable patent-record (no browser, no API key).
// Deterministic by construction: given the page bytes, the extracted record + content_sha are a
// pure function. Two paths share one extractor:
//   - offline/fixture: input.html supplied → parse it (CI replays a recorded page deterministically)
//   - live: input.patent_number → fetch from Google Patents (allowed only because meta.permission
//     .network grants patents.google.com; the skill_runner cage denies any other host)
// content_sha is the hash of the fetched bytes — the grounding anchor: a citation is admissible
// only when its real text was fetched (verification_method "fetch") and pinned.
import { createHash } from "node:crypto";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const dec = (s) => (s ? s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/<[^>]+>/g, "").trim() : s);
const one = (re, h) => { const m = h.match(re); return m ? dec(m[1]) : null; };
const many = (re, h) => [...h.matchAll(re)].map((m) => dec(m[1])).filter(Boolean);
const uniq = (a) => [...new Set(a)];

function extract(html, number, url) {
  const content_sha = createHash("sha256").update(html).digest("hex");
  const title = one(/<meta name="DC\.title" content="([^"]+)"/, html);
  const abstract = one(/<meta name="description" content="([^"]+)"/, html);
  const inventors = uniq(many(/<dd itemprop="inventor"[^>]*>([^<]+)</g, html));
  const cpc_codes = uniq(many(/<span itemprop="Code">([A-H]\d{2}[A-Z]\d+\/\d+)<\/span>/g, html));
  const claims = many(/<div class="claim-text">([\s\S]*?)<\/div>/g, html)
    .map((t) => t.replace(/\s+/g, " ").trim()).filter((t) => t.length > 4);
  const claim_count = claims.filter((c) => /^\d+\./.test(c)).length;
  const backwardSection = (html.match(/itemprop="backwardReferences"[\s\S]*?<\/tbody>/) || [""])[0];
  const backward_citations = uniq(many(/<span itemprop="publicationNumber">([^<]+)</g, backwardSection))
    .concat(uniq(many(/patent\/([A-Z]{2}\d{6,}[A-Z]\d?)\/en/g, backwardSection)));
  // verified: a real fetched document (not a snippet) — title present, abstract section present,
  // and at least one claim extracted.
  const verified = !!title && /itemprop="abstract"/.test(html) && claims.length > 0;
  return {
    patent_number: number,
    source: "Google Patents",
    url,
    title,
    abstract: abstract ? dec(abstract) : null,
    inventors,
    assignee: one(/<dd itemprop="assigneeOriginal"[^>]*>([^<]+)</, html),
    priority_date: one(/<time itemprop="priorityDate"[^>]*>([^<]+)</, html),
    filing_date: one(/<time itemprop="filingDate"[^>]*>([^<]+)</, html),
    grant_date: one(/<time itemprop="publicationDate"[^>]*>([^<]+)</, html),
    cpc_codes,
    claims,
    claim_count,
    backward_citations: uniq(backward_citations).slice(0, 24),
    verification_method: "fetch",
    verified,
    content_sha,
  };
}

export default async function run(input) {
  const number = String((input && input.patent_number) || "");
  const url = (input && input.url) || `https://patents.google.com/patent/${number}/en`;
  let html = input && input.html;
  if (!html) {
    const res = await fetch(url, { headers: { "user-agent": UA, "accept-language": "en" } });
    html = await res.text();
  }
  return extract(html, number, url);
}
