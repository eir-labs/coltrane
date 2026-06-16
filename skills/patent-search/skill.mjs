// patent-search — grounded prior-art DISCOVERY over the patent corpus, no browser. Google Patents'
// search backend (/xhr/query) is server-side JSON — a plain HTTPS GET returns candidate publication
// numbers. The skill searches, then FETCHES the top-K candidates' full pages (the same
// server-rendered bibliography patent-fetch reads) and hash-pins each, so downstream grounds in real
// fetched text, never a snippet. Output is a coverage-report that attests the corpus actually
// searched + the query log + the fetched candidate records. Deterministic given the offline inputs
// (search_json + pages); the live path is gated to patents.google.com by the skill_runner cage.
import { createHash } from "node:crypto";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const dec = (s) => (s ? s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/<[^>]+>/g, "").trim() : s);
const one = (re, h) => { const m = h.match(re); return m ? dec(m[1]) : null; };
const many = (re, h) => [...h.matchAll(re)].map((m) => dec(m[1])).filter(Boolean);
const uniq = (a) => [...new Set(a)];

function extract(html, number, url) {
  const content_sha = createHash("sha256").update(html).digest("hex");
  const title = one(/<meta name="DC\.title" content="([^"]+)"/, html);
  const claims = many(/<div class="claim-text">([\s\S]*?)<\/div>/g, html).map((t) => t.replace(/\s+/g, " ").trim()).filter((t) => t.length > 4);
  return {
    patent_number: number, source: "Google Patents", url,
    title,
    abstract: one(/<meta name="description" content="([^"]+)"/, html),
    assignee: one(/<dd itemprop="assigneeOriginal"[^>]*>([^<]+)</, html),
    cpc_codes: uniq(many(/<span itemprop="Code">([A-H]\d{2}[A-Z]\d+\/\d+)<\/span>/g, html)),
    claims, claim_count: claims.filter((c) => /^\d+\./.test(c)).length,
    verification_method: "fetch",
    verified: !!title && /itemprop="abstract"/.test(html) && claims.length > 0,
    content_sha,
  };
}

function parseSearch(json, max) {
  const out = [];
  for (const cl of json?.results?.cluster ?? []) {
    for (const r of cl?.result ?? []) {
      const p = r.patent || {};
      if (!p.publication_number) continue;
      out.push({
        publication_number: p.publication_number,
        title: dec(p.title || ""),
        snippet: dec(p.snippet || ""),
        priority_date: p.priority_date || null,
        url: r.id ? `https://patents.google.com/${r.id}` : `https://patents.google.com/patent/${p.publication_number}/en`,
      });
    }
  }
  return out.slice(0, max);
}

// Polite client: jittered pacing + exponential backoff on 503/429. The search backend throttles
// bursts, so we never hammer — one in-flight request at a time, a jittered gap between them, and a
// retry ladder on rate-limit responses. (Offline/fixture paths never reach here, so determinism is
// unaffected.)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (base) => base + Math.floor(Math.random() * 300);

async function politeFetch(url, headers, { retries = 3, baseDelay = 800 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(jitter(baseDelay * 2 ** (attempt - 1))); // backoff + jitter
    const res = await fetch(url, { headers });
    if (res.status === 503 || res.status === 429) { lastErr = new Error(`HTTP ${res.status} (rate-limited after ${attempt + 1} tries)`); continue; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  }
  throw lastErr ?? new Error("fetch failed");
}
async function getJson(url) { return (await politeFetch(url, { "user-agent": UA, "accept": "application/json", "accept-language": "en-US,en;q=0.9" })).json(); }
async function getText(url) { await sleep(jitter(400)); return (await politeFetch(url, { "user-agent": UA, "accept-language": "en" })).text(); }

export default async function run(input) {
  const query = String((input && input.query) || "");
  const max = Number((input && input.max_results) || 5);
  const fetchTop = Number((input && input.fetch_top) || 3);

  // search → candidate publication numbers. The search backend rate-limits/bot-blocks bursts, so a
  // throttle is NOT failure to hide — it's reported honestly (status "unreachable", no candidates),
  // never fabricated. A downstream coverage gate then sees the corpus was not actually covered.
  let json = input && input.search_json;
  if (!json) {
    try {
      const url = `https://patents.google.com/xhr/query?url=${encodeURIComponent(`q=${query}&num=${max}`)}`;
      json = await getJson(url);
    } catch (e) {
      return { corpora_searched: [{ corpus: "Google Patents", status: "unreachable" }], query_log: [query], patent_hit_count: 0, candidates: [], records: [], caveat: `search unreachable: ${String((e && e.message) || e)}` };
    }
  }
  const candidates = parseSearch(json, max);

  // fetch the top-K full pages so downstream grounds in real text (offline: input.pages[number]).
  // A page that won't fetch is recorded unverified, never invented.
  const offlinePages = (input && input.pages) || {};
  const records = [];
  for (const c of candidates.slice(0, fetchTop)) {
    try {
      const html = offlinePages[c.publication_number] ?? (await getText(c.url));
      records.push(extract(html, c.publication_number, c.url));
    } catch (e) {
      records.push({ patent_number: c.publication_number, source: "Google Patents", url: c.url, title: c.title || null, verification_method: "snippet", verified: false, content_sha: "", caveat: `fetch failed: ${String((e && e.message) || e)}` });
    }
  }

  return {
    corpora_searched: [{ corpus: "Google Patents", status: candidates.length > 0 ? "searched" : "searched-empty" }],
    query_log: [query],
    patent_hit_count: candidates.length,
    candidates,
    records,
  };
}
