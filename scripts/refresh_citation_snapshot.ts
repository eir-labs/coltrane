/**
 * Refresh the citation dereference snapshot — an OPERATOR act, never run by CI.
 *
 *   npx tsx scripts/refresh_citation_snapshot.ts
 *
 * WHY THIS IS A SCRIPT AND NOT A TEST. `evidence_grade: "archive"` claims the primary was
 * fetched. Proving that claim requires reaching the network, and the test suite must not —
 * `tests/suite_reaches_no_remote.test.ts` is the standing guard that keeps it offline. So the
 * fetch happens HERE, deliberately, by a human running this command; the suite then checks the
 * committed record of that fetch. The network call and the law are separated on purpose.
 *
 * WHAT IT REFUSES TO DO. It never writes `authors`/`year`/`title` it did not verify. For a DOI
 * the authority is Crossref: the script compares the registered record against what the citation
 * claims, and writes the verified fields ONLY when they agree. On a mismatch it writes the
 * divergence instead — so `a_fetch_claim_carries_its_evidence.test.ts` goes RED and a human reads
 * why, rather than the snapshot quietly agreeing with whatever the citation happens to say. A
 * snapshot that always matches would be a tautology, which is the exact defect this change closes.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GENOME_ATTRIBUTIONS } from "../src/genome_schema.js";
import type { CitationOutput } from "../src/genome_schema.js";

const UA = "coltrane-citation-audit (+https://github.com/eir-labs/coltrane)";
const OUT = fileURLToPath(new URL("../tests/fixtures/citation_dereference_snapshot.json", import.meta.url));

type SnapshotRecord = {
  identifier: string;
  route: "crossref" | "direct";
  reachable: boolean;
  status: number;
  subject: string;
  fetched_at: string;
  authors?: string[];
  year?: number;
  title?: string;
  divergence?: string;
  bytes?: number;
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Crossref gives family names ("Ostrom"); a citation gives "Ostrom, E.". Agreement means every
 *  registered family name is claimed by the citation, and the counts match — not string equality. */
function authorsAgree(claimed: readonly string[], registered: readonly string[]): boolean {
  if (registered.length !== claimed.length) return false;
  return registered.every((fam) => claimed.some((c) => norm(c).includes(norm(fam))));
}

function titlesAgree(claimed: string, registered: string): boolean {
  const a = norm(claimed), b = norm(registered);
  return a.includes(b) || b.includes(a);
}

async function viaCrossref(c: CitationOutput, subject: string, at: string): Promise<SnapshotRecord> {
  const base = { identifier: c.doi!, route: "crossref" as const, subject, fetched_at: at };
  const r = await fetch(`https://api.crossref.org/works/${encodeURIComponent(c.doi!)}`, {
    headers: { "User-Agent": UA },
  });
  if (!r.ok) {
    return { ...base, reachable: false, status: r.status, divergence: `crossref returned ${r.status}` };
  }
  const m = (await r.json()).message;
  const registeredAuthors: string[] = (m.author ?? [])
    .map((a: { family?: string; name?: string }) => a.family ?? a.name)
    .filter(Boolean);
  const registeredYear: number | undefined = m.issued?.["date-parts"]?.[0]?.[0];
  const registeredTitle: string = (m.title ?? [])[0] ?? "";

  const mismatches: string[] = [];
  if (!authorsAgree(c.authors, registeredAuthors)) {
    mismatches.push(`authors: citation ${JSON.stringify(c.authors)} vs registered ${JSON.stringify(registeredAuthors)}`);
  }
  if (registeredYear !== c.year) mismatches.push(`year: citation ${c.year} vs registered ${registeredYear}`);
  if (!titlesAgree(c.title, registeredTitle)) {
    mismatches.push(`title: citation ${JSON.stringify(c.title)} vs registered ${JSON.stringify(registeredTitle)}`);
  }

  if (mismatches.length > 0) {
    // Reachable, but the record does NOT support the claim. Write the divergence and no verified
    // fields — the law reads the absence and goes red.
    return { ...base, reachable: true, status: 200, divergence: mismatches.join(" · ") };
  }
  // Verified: the citation's own strings are the ones that agreed with the registered record.
  return { ...base, reachable: true, status: 200, authors: [...c.authors], year: c.year, title: c.title };
}

async function viaDirect(c: CitationOutput, subject: string, at: string): Promise<SnapshotRecord> {
  const base = { identifier: c.url!, route: "direct" as const, subject, fetched_at: at };
  try {
    const r = await fetch(c.url!, { headers: { "User-Agent": `Mozilla/5.0 ${UA}` }, redirect: "follow" });
    if (!r.ok) return { ...base, reachable: false, status: r.status, divergence: `fetch returned ${r.status}` };
    const bytes = (await r.arrayBuffer()).byteLength;
    return { ...base, reachable: true, status: r.status, bytes };
  } catch (e) {
    return { ...base, reachable: false, status: 0, divergence: String((e as Error).message ?? e) };
  }
}

const fetchedAt = new Date().toISOString().slice(0, 10);
const archive = GENOME_ATTRIBUTIONS.filter((a) => a.citation.evidence_grade === "archive");
const records: SnapshotRecord[] = [];

for (const row of archive) {
  const c = row.citation;
  const rec = c.doi
    ? await viaCrossref(c, row.subject, fetchedAt)
    : await viaDirect(c, row.subject, fetchedAt);
  records.push(rec);
  const flag = rec.divergence ? `DIVERGENCE — ${rec.divergence}` : `ok (${rec.route})`;
  console.log(`  ${row.subject.padEnd(32)} ${flag}`);
}

writeFileSync(OUT, `${JSON.stringify({ fetched_at: fetchedAt, records }, null, 2)}\n`);
const bad = records.filter((r) => !r.reachable || r.divergence);
console.log(`\n  wrote ${OUT}`);
console.log(`  ${records.length} archive-grade citations dereferenced, ${bad.length} unresolved or divergent`);
if (bad.length > 0) {
  console.log("  A divergence means the primary does not support the claim — fix the citation or the grade.");
}
