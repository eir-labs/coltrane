// landscape-evidence-check — deterministic evidence verification for a landscape. No model.
//
// A skill-backed CHAIR between the scouts and everything downstream. For every item in every
// landscape-scan (read from context.upstream, one record per scout role — the shallow merge in
// `input` would collapse eight scans into one), fetch each evidence URL in THIS run and test
// whether the quote is an EXACT substring of the fetched text. An item survives if at least one
// of its evidence entries resolves.
//
// "Exact" means: no lowercasing, no tokenising, no stripping of non-ASCII — so it works the same
// for an English spec page and for e-Gov 法令XML. Two normalisations are applied to BOTH sides
// before comparing, because the scout reads a rendered page and we fetch raw bytes: HTML tags are
// removed and entities decoded, and runs of whitespace collapse to one space. Nothing else.
//
// The deterministic core is `verify(scans, pages)`; `pages` maps url -> fetched text. Fixtures pass
// `mock_pages`, so no network is used under test. The live path fetches with a per-request timeout
// and bounded concurrency so the whole check fits inside the skill timeout.
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function normalise(s) {
  return String(s ?? "")
    .replace(/<script\b[\s\S]*?<\/script\b[^>]*>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style\b[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/\s+/g, " ")
    .trim();
}

function scansFrom(input, context) {
  const up = context && Array.isArray(context.upstream) ? context.upstream : [];
  const fromCtx = up.filter((u) => u && u.domain_type === "landscape-scan").map((u) => u.data);
  if (fromCtx.length > 0) return fromCtx;
  if (input && Array.isArray(input.scans)) return input.scans; // fixtures
  return input && input.data ? [input] : [];
}

export function verify(scans, pages) {
  const verified_handles = [];
  const refused = [];
  const checks = [];
  for (const scan of scans) {
    const items = Array.isArray(scan?.data?.items) ? scan.data.items : [];
    for (const it of items) {
      const handle = String(it?.handle ?? "");
      const evidence = Array.isArray(it?.evidence) ? it.evidence : [];
      let ok = false;
      const reasons = [];
      evidence.forEach((e, i) => {
        const url = String(e?.url ?? "");
        const quote = normalise(e?.quote);
        const page = pages[url];
        let result;
        if (!url || !quote) result = "no url or empty quote";
        else if (page === undefined || page === null) result = "not fetched";
        else if (normalise(page).includes(quote)) { result = "match"; ok = true; }
        else result = "quote not found on fetched page";
        checks.push({ method: "fetch+exact-substring", target_ref: `${handle}#evidence[${i}]`, result });
        if (result !== "match") reasons.push(`${url || "(no url)"}: ${result}`);
      });
      if (evidence.length === 0) {
        checks.push({ method: "fetch+exact-substring", target_ref: `${handle}#evidence`, result: "no evidence" });
        reasons.push("no evidence");
      }
      if (ok) verified_handles.push(handle);
      else refused.push({ handle, reason: reasons.join("; ") });
    }
  }
  return { verified_handles, refused, checks };
}

// The runtime gives a skill chair a fixed 120s window (runtime.ts:3180) and meta.timeout_ms can only
// lower it (skill_subprocess.ts:185). So the fetch loop carries its own deadline well inside that:
// no new fetch starts after DEADLINE_MS, and whatever is left is recorded as not fetched — the
// check returns a partial, honest verification instead of the chair being killed mid-run.
const DEADLINE_MS = 95_000;

async function fetchAll(urls, perRequestMs = 10_000, concurrency = 16) {
  const pages = {};
  const log = [];
  const queue = [...urls];
  const started = Date.now();
  async function worker() {
    while (queue.length) {
      if (Date.now() - started > DEADLINE_MS) {
        for (const url of queue.splice(0)) { pages[url] = null; log.push({ url, status: "skipped: time budget", chars: 0 }); }
        return;
      }
      const url = queue.shift();
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), perRequestMs);
      try {
        const res = await fetch(url, { signal: ac.signal, redirect: "follow", headers: { "user-agent": "coltrane-landscape-evidence/0" } });
        const buf = new Uint8Array(await res.arrayBuffer());
        const ct = res.headers.get("content-type") || "";
        let charset = (ct.match(/charset=([^;]+)/i) || [])[1];
        if (!charset) {
          const head = new TextDecoder("latin1").decode(buf.slice(0, 2048));
          charset = (head.match(/charset=["']?([\w-]+)/i) || [])[1] || "utf-8";
        }
        let text;
        try { text = new TextDecoder(charset.trim().toLowerCase()).decode(buf); } catch { text = new TextDecoder("utf-8").decode(buf); }
        pages[url] = res.ok ? text : null;
        log.push({ url, status: String(res.status), chars: text.length });
      } catch (err) {
        pages[url] = null;
        log.push({ url, status: `error: ${err?.name || "fetch failed"}`, chars: 0 });
      } finally { clearTimeout(t); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
  return { pages, log };
}

export default async function run(input, context) {
  const scans = scansFrom(input, context);
  let pages, fetch_log;
  if (input && input.mock_pages) { pages = input.mock_pages; fetch_log = []; }
  else {
    const urls = [...new Set(scans.flatMap((s) => (s?.data?.items || []).flatMap((it) => (it?.evidence || []).map((e) => String(e?.url || "")))).filter(Boolean))];
    ({ pages, log: fetch_log } = await fetchAll(urls));
  }
  const { verified_handles, refused, checks } = verify(scans, pages);
  return {
    id: "landscape-verification",
    target_ref: scans.map((s) => s?.source || s?.data?.layer || "scan").join(","),
    pass: refused.length === 0 && verified_handles.length > 0,
    checks: checks.length ? checks : [{ method: "fetch+exact-substring", target_ref: "scans", result: "no items to check" }],
    verified_handles,
    refused,
    fetch_log,
  };
}
