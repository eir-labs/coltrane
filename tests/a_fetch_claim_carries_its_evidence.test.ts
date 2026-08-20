// RED-first — a grade that CLAIMS A FETCH is unrepresentable without the evidence of that fetch.
//
// Three sites, one shape. Each declares a claim about the world (this primary was fetched; this hit
// was verified; this output was sealed) and each currently lets the claim stand with NOTHING behind
// it. The comment says A; the schema admits B. These laws close the gap at the layer where the shape
// is enforced, so the illegal state is unrepresentable for EVERY caller — not only the rows one
// existing test happens to loop over.
//
//   Site 1  CitationSchema (src/genome_schema.ts): evidence_grade==='archive' means "the primary was
//           fetched, and retrieved_at says when." Today retrieved_at is .optional() with no tie to
//           the grade, and no bound on its value — so {archive, no retrieved_at} parses, and
//           {archive, retrieved_at:'2099-01-01'} parses. A fetch dated 75 years out is a valid
//           archive claim. LAW: archive REQUIRES retrieved_at, and retrieved_at must not be in the
//           future. Attestation (which claims no fetch) is untouched.
//
//   Site 2  prior-art-hit (domain_types/prior-art-hit.json): verified:boolean + verification_method
//           enum[fetch,snippet], required_fields only ['source','title']. So a hit may claim
//           verified:true with no method. The shape is enforced through registry.validate, so the
//           law is written against THAT callsite. LAW: verified===true REQUIRES verification_method.
//
//   Site 3  output_write validate-mode (src/server.ts): returns {ok:true,data:{validated:true,...}}
//           with no field naming what did NOT happen. A truthful compose chair read "validated" as
//           "sealed" and filed a false completion. LAW: the validate-mode response carries an
//           explicit sealed:false (ok:true stays — validation genuinely succeeded), and the tool's
//           declared output_schema advertises that field.
//
//   Snapshot A committed, OFFLINE dereference snapshot (tests/fixtures/citation_dereference_snapshot
//           .json, seeded by an operator act, refreshed by a committed script CI never runs). LAW:
//           every archive-grade GENOME_ATTRIBUTIONS identifier resolves in the snapshot and is marked
//           reachable; where the route is crossref, the snapshot authors/year/title MATCH the record;
//           BookingSchema's citation url is the fetchable GASB PDF, not the 403 marketing summary.
//
// RED BY DESIGN: the four enforcement laws below FAIL against the unmodified tree — the schema admits
// the illegal state, the server omits the field, the snapshot fixture does not yet exist and the
// BookingSchema url is still the summary page. That failure IS the spec. They go GREEN when the
// enforcement (create-change seat) lands. The two POSITIVE guards (attestation still parses; a valid
// archive citation still parses) are green now and MUST stay green — they pin the scope so the
// enforcement cannot over-reach.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CitationSchema,
  GENOME_ATTRIBUTIONS,
  type CitationOutput,
} from "../src/genome_schema.js";
import {
  createRegistry,
  MCP_TOOLS,
  MemoryLedger,
  createOutputStore,
  type DomainType,
} from "../src/index.js";
import { dispatchTool, type ServerDeps } from "../src/server.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

// ── Site 1 — CitationSchema: an archive grade is a claim about a fetch that happened ───────────────
describe("Site 1 — CitationSchema: 'archive' means fetched, and carries WHEN, and the when is real", () => {
  // A resolvable identifier is orthogonally required (the existing .refine). Include a doi so the
  // ONLY reason these fail is the archive/retrieved_at law under test — never a missing identifier.
  const archiveNoWhen = {
    authors: ["Nobody"],
    year: 2020,
    title: "A paper that was supposedly fetched",
    venue: "Nowhere",
    doi: "10.9999/definitely.not.real",
    evidence_grade: "archive" as const,
    // retrieved_at deliberately absent
  };

  it("INV-1 REJECTS an archive citation with NO retrieved_at — the grade claims a fetch, so name when", () => {
    const r = CitationSchema.safeParse(archiveNoWhen);
    expect(
      r.success,
      "an archive-grade citation parsed with no retrieved_at — 'the primary was fetched' is backed by nothing",
    ).toBe(false);
  });

  it("INV-2 REJECTS an archive citation whose retrieved_at is in the future — a fetch cannot have happened later", () => {
    const r = CitationSchema.safeParse({ ...archiveNoWhen, retrieved_at: "2099-01-01" });
    expect(
      r.success,
      "an archive citation dated 2099 parsed — a fetch 75 years from now is not a fetch that happened",
    ).toBe(false);
  });

  it("INV-2 (property) REJECTS an archive citation for EVERY retrieved_at strictly after now", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 200_000 }), (offsetDays) => {
        const future = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000)
          .toISOString()
          .slice(0, 10);
        const r = CitationSchema.safeParse({ ...archiveNoWhen, retrieved_at: future });
        expect(
          r.success,
          `an archive citation dated ${future} (now +${offsetDays}d) parsed — the future is not a fetch`,
        ).toBe(false);
      }),
    );
  });

  // ── POSITIVE guards: the law must not over-reach. Green now, and must STAY green after enforcement.
  it("INV-1/2 (scope guard) ACCEPTS an archive citation with a safely-past retrieved_at", () => {
    const r = CitationSchema.safeParse({ ...archiveNoWhen, retrieved_at: "2020-01-01" });
    expect(
      r.success,
      "a well-formed archive citation with a past fetch date was refused — the law over-reached",
    ).toBe(true);
  });

  it("INV-1/2 (scope guard) ACCEPTS an attestation citation with NO retrieved_at — it claims no fetch", () => {
    const r = CitationSchema.safeParse({
      authors: ["Nobody"],
      year: 2020,
      title: "A paper that was merely declared",
      venue: "Nowhere",
      doi: "10.9999/definitely.not.real",
      evidence_grade: "attestation" as const,
    });
    expect(
      r.success,
      "an attestation citation was forced to carry a fetch timestamp — attestation claims no fetch",
    ).toBe(true);
  });
});

// ── Site 2 — prior-art-hit: 'verified' is a claim about HOW, enforced where the shape is enforced ──
describe("Site 2 — prior-art-hit: verified:true requires verification_method, at registry.validate", () => {
  // Load the ACTUAL domain type from disk and register it — this is the exact object the seal path
  // (outputs.write → registry.validate) compiles. Testing the raw JSON with a fresh ajv would NOT
  // prove enforcement, because the seal validates the reconstructed `effective()` schema, not the
  // authored file. So the law rides the real callsite.
  const priorArtHit = JSON.parse(
    readFileSync(new URL("../domain_types/prior-art-hit.json", import.meta.url), "utf8"),
  ) as DomainType;

  const registry = () => createRegistry([priorArtHit]);
  const validateHit = (data: Record<string, unknown>) =>
    registry().validate({ core_type: "Signal", domain_type: "prior-art-hit", data });

  it("INV-3 REJECTS a hit that claims verified:true with NO verification_method — a claim, not a record", () => {
    const res = validateHit({ source: "USPTO", title: "Some prior patent", verified: true });
    expect(
      res.valid,
      "a prior-art-hit claimed verified:true with no method and validated — 'verified' backed by nothing",
    ).toBe(false);
  });

  it("INV-3 (scope guard) ACCEPTS a verified:true hit that names its verification_method", () => {
    const res = validateHit({
      source: "USPTO",
      title: "Some prior patent",
      verified: true,
      verification_method: "fetch",
    });
    expect(res.valid, `a fully-evidenced hit was refused: ${JSON.stringify(res.errors)}`).toBe(true);
  });

  it("INV-3 (scope guard) ACCEPTS a hit that makes no verified claim at all", () => {
    const res = validateHit({ source: "USPTO", title: "Some prior patent" });
    expect(res.valid, `an unverified hit was refused: ${JSON.stringify(res.errors)}`).toBe(true);
  });
});

// ── Site 3 — output_write validate-mode names what it is: VALIDATED, not SEALED ────────────────────
describe("Site 3 — output_write validate-mode: 'validated' can never be read as 'sealed'", () => {
  const REPORT_TYPE: DomainType = {
    slug: "report",
    extends: "Interpretation",
    domain: "test",
    schema: {
      type: "object",
      properties: { title: { type: "string" }, claims: { type: "array" } },
      required: ["title"],
    },
    required_fields: ["title"],
  };
  const validateDeps = (): ServerDeps => {
    const registry = createRegistry([REPORT_TYPE]);
    return {
      registry,
      outputs: createOutputStore(registry),
      ledger: new MemoryLedger(),
      gig_runs: new Map(),
      output_write_mode: "validate",
    };
  };

  it("INV-4 the validate-mode success response carries an explicit sealed:false (ok:true stays true)", async () => {
    const r = await dispatchTool(
      "output_write",
      {
        core_type: "Interpretation",
        domain_type: "report",
        domain: "test",
        gig_id: "g1",
        phase: "interpret",
        agent_slug: "reporter",
        data: { title: "the finding", claims: ["a"] },
      },
      validateDeps(),
    );
    expect(r.ok, "validation genuinely succeeded — ok must stay true").toBe(true);
    const data = r.data as { validated?: boolean; sealed?: boolean };
    expect(data.validated, "validate mode still reports validated:true").toBe(true);
    expect(
      data.sealed,
      "validate-mode response has no sealed:false — a reader cannot tell VALIDATED from SEALED",
    ).toBe(false);
  });

  it("INV-4 the output_write output_schema ADVERTISES the sealed field — a returned field an operator can discover", () => {
    const tool = MCP_TOOLS.find((t) => t.slug === "output_write")!;
    const declared = Object.keys(
      (tool.output_schema as { properties: Record<string, unknown> }).properties,
    );
    expect(
      declared,
      "output_write returns sealed but does not advertise it — an undiscoverable field is folklore",
    ).toContain("sealed");
  });
});

// ── Snapshot — every archive claim resolves in a committed, offline dereference record ─────────────
describe("Snapshot — every archive-grade citation resolves in the committed offline snapshot", () => {
  type SnapshotRecord = {
    identifier: string;
    route: "crossref" | "direct";
    reachable: boolean;
    authors?: string[];
    year?: number;
    title?: string;
  };
  type Snapshot = { records: SnapshotRecord[] };

  // OFFLINE by construction: this reads a committed JSON fixture and GENOME_ATTRIBUTIONS in-process.
  // No network — tests/suite_reaches_no_remote.test.ts forbids it and stays green. RED now because
  // the fixture does not yet exist (operator act) and BookingSchema.url is still the 403 summary.
  const loadSnapshot = (): Snapshot =>
    JSON.parse(
      readFileSync(new URL("./fixtures/citation_dereference_snapshot.json", import.meta.url), "utf8"),
    ) as Snapshot;

  const archiveRows = GENOME_ATTRIBUTIONS.filter((a) => a.citation.evidence_grade === "archive");
  const identifierOf = (c: CitationOutput): string => c.doi ?? c.url ?? "";

  it("INV-5 there is at least one archive-grade citation to hold to account (fixture is not vacuous)", () => {
    expect(archiveRows.length).toBeGreaterThan(0);
  });

  it("INV-5 every archive-grade identifier resolves in the snapshot and is marked reachable", () => {
    const snap = loadSnapshot();
    const byId = new Map(snap.records.map((r) => [r.identifier, r]));
    for (const row of archiveRows) {
      const id = identifierOf(row.citation);
      const rec = byId.get(id);
      expect(rec, `archive citation for ${row.subject} (${id}) has no dereference record`).toBeDefined();
      expect(rec!.reachable, `snapshot marks ${id} unreachable — an archive claim that does not resolve`).toBe(true);
    }
  });

  it("INV-5 where the route is crossref, snapshot authors/year/title MATCH the record", () => {
    const snap = loadSnapshot();
    const byId = new Map(snap.records.map((r) => [r.identifier, r]));
    for (const row of archiveRows) {
      const id = identifierOf(row.citation);
      const rec = byId.get(id);
      if (!rec || rec.route !== "crossref") continue;
      expect(rec.authors, `crossref record ${id} carries no authors to match`).toEqual(row.citation.authors);
      expect(rec.year, `crossref record ${id} year mismatch`).toBe(row.citation.year);
      expect(rec.title, `crossref record ${id} title mismatch`).toBe(row.citation.title);
    }
  });

  it("INV-5 BookingSchema's citation url is the fetchable GASB PDF, not the 403 marketing summary", () => {
    const booking = GENOME_ATTRIBUTIONS.find((a) => a.subject === "BookingSchema");
    expect(booking, "BookingSchema attribution row is missing").toBeDefined();
    expect(
      booking!.citation.url,
      "BookingSchema still points at the summary page — the snapshot must be keyed by the doc actually fetched",
    ).toBe("https://storage.gasb.org/GASBS%2054.pdf");
  });
});
