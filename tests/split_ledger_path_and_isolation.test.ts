// RED-first — WO-F06 regression correction. The ledger split (bb283e2) routes genome_mutation
// seals to a tracked genome/ledger.jsonl correctly, but broke two contract invariants:
//
//   (1) SplitLedger.integrity().path now returns a CONCATENATION of both backing paths
//       ("<genome-ledger> + <gig-ledger>"). The LedgerIntegrityReport.path contract
//       (src/ledger.ts:181) is a SINGLE ledger path; it lands verbatim in an MCP
//       system_health response an operator reads. A joined string is not a path.
//
//   (2) The genome-ledger path does NOT honor the isolation override. When
//       COLTRANE_LEDGER_PATH relocates the gig ledger, bootstrapServerDeps() still derives
//       the genome ledger from process.cwd() (src/server.ts:3809 → 3860), so a seal leaks to
//       the REAL checkout's genome/ dir instead of resolving beside the override root. The
//       existing tests/bootstrap_root_isolation.test.ts catches this only when the checkout's
//       genome/ledger.jsonl already holds committed seals; on a fresh checkout the leak is
//       latent. The isolation law below proves it DETERMINISTICALLY, by pre-seeding the
//       override's sibling genome ledger and demanding the bootstrap read THAT one — with no
//       write into the real tree.
//
// Method: example-based integration tests against the REAL callsites — the concrete
// SplitLedger (src/ledger.ts:587) and the single production construction seam
// bootstrapServerDeps (src/server.ts:3808). No shim: SplitLedger, FileLedger,
// defaultGenomeLedgerPath and bootstrapServerDeps all already exist on the split engine; the
// enforcement these laws demand — a single path, and a genome ledger that follows the override
// — is what does not exist yet. Every RED assertion below fails on the unmodified split, and
// must pass once the two defects are corrected in src/ WITHOUT weakening
// tests/bootstrap_root_isolation.test.ts or reddening tests/genome_ledger_ships.test.ts.
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileLedger,
  SplitLedger,
  defaultLedgerPath,
  defaultGenomeLedgerPath,
  LEDGER_SCHEMA_VERSION,
  type Ledger,
  type GenomeMutationLedgerEntry,
  type GigLedgerEntry,
} from "../src/ledger.js";
import { bootstrapServerDeps } from "../src/server.js";
import { sha256Hex } from "../src/canonical_form.js";

const hex = (s: string): string => sha256Hex(s);

function genomeMut(slug: string, event = "standard_compose"): GenomeMutationLedgerEntry {
  return {
    kind: "genome_mutation",
    schema_version: LEDGER_SCHEMA_VERSION,
    entry_id: `${event}:${slug}:seed`,
    event,
    subject_slug: slug,
    content_hash: hex(slug),
    dependency_hash: hex(`${slug}:dep`),
    effective_hash: hex(`${slug}:eff`),
    output_hashes: [hex(slug)],
    started_at: "2026-08-24T00:00:00.000Z",
    finished_at: "2026-08-24T00:00:00.000Z",
  };
}

function gig(id: string): GigLedgerEntry {
  return {
    kind: "gig",
    schema_version: LEDGER_SCHEMA_VERSION,
    entry_id: id,
    gig_id: id,
    standard_slug: "s",
    genome_hash: hex(`${id}:gh`),
    run_fingerprint: hex(`${id}:rf`),
    output_hashes: [],
    started_at: "2026-08-24T00:00:00.000Z",
    finished_at: "2026-08-24T00:00:00.000Z",
  };
}

function root(prefix = "split-ledger-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ── INV-INTEGRITY-PATH-SINGLE — integrity().path is ONE ledger path, never a concatenation ──
describe("SplitLedger.integrity().path is a single ledger path, not a concatenation", () => {
  it("returns the gig ledger's resolved path even when both backing ledgers hold entries", () => {
    // The unit law at the seam that broke. Both sides are populated so a concatenation would be
    // maximally visible — and maximally wrong.
    const dir = root();
    try {
      const genomePath = join(dir, "genome", "ledger.jsonl");
      const gigPath = join(dir, ".coltrane", "ledger.jsonl");
      const led: Ledger = new SplitLedger(new FileLedger(genomePath), new FileLedger(gigPath));
      led.append(genomeMut("alpha"));
      led.append(gig("gig-1"));

      const report = led.integrity();
      // THE assertion. Today: "<genomePath> + <gigPath>". The contract is the single gig path.
      expect(
        report.path,
        "integrity().path is a single ledger path (LedgerIntegrityReport.path, src/ledger.ts:181); " +
          "it must be the gig ledger's path, not both joined with ' + '",
      ).toBe(gigPath);
      expect(report.path, "a real path never contains the join separator").not.toContain(" + ");
      expect(
        report.path,
        "the genome-ledger path must not be concatenated into integrity().path",
      ).not.toContain(genomePath);

      // Health reporting stays complete: the union count and corruption union are unchanged by
      // the path correction — only the path field is wrong. Guards against over-correcting.
      expect(report.entries, "entries still union both backing ledgers").toBe(2);
      expect(report.ok, "both backing files are intact").toBe(true);
      expect(report.corrupt, "neither backing file is torn").toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an UNROOTED bootstrap under COLTRANE_LEDGER_PATH reports that single override path", () => {
    // The production seam, unrooted: integrity().path must equal the gig override exactly —
    // the same property tests/bootstrap_root_isolation.test.ts:64 pins, proven here directly
    // against bootstrapServerDeps so this red-spec stands on its own callsite.
    const savedGig = process.env["COLTRANE_LEDGER_PATH"];
    const savedGenome = process.env["COLTRANE_GENOME"];
    const savedGenomeLedger = process.env["COLTRANE_GENOME_LEDGER_PATH"];
    const spine = root("split-ledger-spine-");
    try {
      delete process.env["COLTRANE_GENOME"];
      delete process.env["COLTRANE_GENOME_LEDGER_PATH"];
      const override = join(spine, "ledger.jsonl");
      process.env["COLTRANE_LEDGER_PATH"] = override;

      const path = bootstrapServerDeps().ledger.integrity().path;
      expect(
        path,
        `integrity().path was "${path}" — the gig override is "${override}". A concatenation or a ` +
          "leaked checkout path here is exactly the regression this spec closes.",
      ).toBe(override);
    } finally {
      if (savedGig === undefined) delete process.env["COLTRANE_LEDGER_PATH"];
      else process.env["COLTRANE_LEDGER_PATH"] = savedGig;
      if (savedGenome === undefined) delete process.env["COLTRANE_GENOME"];
      else process.env["COLTRANE_GENOME"] = savedGenome;
      if (savedGenomeLedger === undefined) delete process.env["COLTRANE_GENOME_LEDGER_PATH"];
      else process.env["COLTRANE_GENOME_LEDGER_PATH"] = savedGenomeLedger;
      rmSync(spine, { recursive: true, force: true });
    }
  });

  it("an explicitly-rooted bootstrap also reports a single path (the gig override)", () => {
    // The explicit-root arm (bootstrap_root_isolation.test.ts:73): even with a root argument,
    // integrity().path must be the single gig override, never "<root>/genome/... + <override>".
    const savedGig = process.env["COLTRANE_LEDGER_PATH"];
    const savedGenomeLedger = process.env["COLTRANE_GENOME_LEDGER_PATH"];
    const spine = root("split-ledger-spine-");
    const explicitRoot = root("split-ledger-root-");
    try {
      delete process.env["COLTRANE_GENOME_LEDGER_PATH"];
      const override = join(spine, "ledger.jsonl");
      process.env["COLTRANE_LEDGER_PATH"] = override;

      const path = bootstrapServerDeps(explicitRoot).ledger.integrity().path;
      expect(
        path,
        "an explicit root must not append its genome-ledger path onto the gig override",
      ).toBe(override);
    } finally {
      if (savedGig === undefined) delete process.env["COLTRANE_LEDGER_PATH"];
      else process.env["COLTRANE_LEDGER_PATH"] = savedGig;
      if (savedGenomeLedger === undefined) delete process.env["COLTRANE_GENOME_LEDGER_PATH"];
      else process.env["COLTRANE_GENOME_LEDGER_PATH"] = savedGenomeLedger;
      rmSync(spine, { recursive: true, force: true });
      rmSync(explicitRoot, { recursive: true, force: true });
    }
  });
});

// ── INV-GENOME-ISOLATES-UNDER-OVERRIDE — the genome ledger follows the isolation override ──
describe("the genome ledger resolves under the same override root as the gig ledger", () => {
  it("an unrooted bootstrap under COLTRANE_LEDGER_PATH reads the genome ledger BESIDE the override, never the real checkout", () => {
    // DETERMINISTIC proof of the leak, independent of the checkout's own genome/ledger.jsonl.
    // We seed a uniquely-slugged genome seal ONLY in the override's sibling genome ledger
    // (<dirname(COLTRANE_LEDGER_PATH)>/genome/ledger.jsonl) and write NOTHING into the real
    // tree. When the bootstrap honors the override, its genome ledger resolves to that seeded
    // file and the query finds the seal. Today it resolves to <cwd>/genome/ledger.jsonl — the
    // real checkout — so the seed is invisible and the query is empty. RED.
    const savedGig = process.env["COLTRANE_LEDGER_PATH"];
    const savedGenome = process.env["COLTRANE_GENOME"];
    const savedGenomeLedger = process.env["COLTRANE_GENOME_LEDGER_PATH"];
    const spine = root("split-ledger-spine-");
    try {
      // No COLTRANE_GENOME / COLTRANE_GENOME_LEDGER_PATH — the whole point is that the GIG
      // override alone must carry the genome ledger with it, without a second env var.
      delete process.env["COLTRANE_GENOME"];
      delete process.env["COLTRANE_GENOME_LEDGER_PATH"];
      const override = join(spine, "ledger.jsonl");
      process.env["COLTRANE_LEDGER_PATH"] = override;

      // The genome ledger the bootstrap MUST resolve to once the override is honored.
      const seededGenomeLedger = join(spine, "genome", "ledger.jsonl");
      expect(
        seededGenomeLedger,
        "defaultGenomeLedgerPath(dirname(override)) is where an isolated genome ledger belongs",
      ).toBe(defaultGenomeLedgerPath(spine));
      mkdirSync(join(spine, "genome"), { recursive: true });
      writeFileSync(seededGenomeLedger, JSON.stringify(genomeMut("isolated-seal")) + "\n", "utf8");

      const led = bootstrapServerDeps().ledger;
      // `led` is the `Ledger` INTERFACE (single-signature query → LedgerEntry[]); narrow to the
      // genome arm the same way tests/genome_ledger_ships.test.ts does.
      const found = led
        .query({ kind: "genome_mutation" })
        .map((e) => (e as GenomeMutationLedgerEntry).subject_slug);

      expect(
        found,
        "the genome ledger must resolve beside the COLTRANE_LEDGER_PATH override, not the real " +
          "checkout's genome/ dir — the seal seeded under the override is the one it must read",
      ).toContain("isolated-seal");
      // ...and it must read ONLY the isolated ledger: a leak to the checkout would union in
      // whatever seals the real genome/ledger.jsonl holds (or miss the seed entirely).
      expect(
        found,
        "reading exactly the one seeded seal proves the genome ledger is the isolated file, " +
          "not the checkout's",
      ).toEqual(["isolated-seal"]);
    } finally {
      if (savedGig === undefined) delete process.env["COLTRANE_LEDGER_PATH"];
      else process.env["COLTRANE_LEDGER_PATH"] = savedGig;
      if (savedGenome === undefined) delete process.env["COLTRANE_GENOME"];
      else process.env["COLTRANE_GENOME"] = savedGenome;
      if (savedGenomeLedger === undefined) delete process.env["COLTRANE_GENOME_LEDGER_PATH"];
      else process.env["COLTRANE_GENOME_LEDGER_PATH"] = savedGenomeLedger;
      rmSync(spine, { recursive: true, force: true });
    }
  });
});

// ── Guards — the fix's boundaries must NOT move (GREEN today; here to stay green) ────────────
describe("the correction preserves the split's design (regression guards)", () => {
  it("defaultGenomeLedgerPath ignores COLTRANE_LEDGER_PATH — the two overrides stay independent", () => {
    // The rejected fix would couple defaultGenomeLedgerPath to COLTRANE_LEDGER_PATH's directory.
    // This guard (already GREEN, mirrored from genome_ledger_ships.test.ts AC5) forbids that: the
    // isolation must be wired in bootstrapServerDeps, never by making the resolver read the gig
    // override. GREEN now, and it must STAY green through the fix.
    const dir = root();
    const savedGig = process.env["COLTRANE_LEDGER_PATH"];
    const savedGenomeLedger = process.env["COLTRANE_GENOME_LEDGER_PATH"];
    try {
      delete process.env["COLTRANE_GENOME_LEDGER_PATH"];
      process.env["COLTRANE_LEDGER_PATH"] = join(dir, "custom-gig.jsonl");
      expect(
        defaultGenomeLedgerPath(dir),
        "COLTRANE_LEDGER_PATH must govern only the gig ledger — never bleed into the genome path",
      ).toBe(join(dir, "genome", "ledger.jsonl"));
      // The gig override is still honored by its own resolver.
      expect(defaultLedgerPath(dir)).toBe(join(dir, "custom-gig.jsonl"));
    } finally {
      if (savedGig === undefined) delete process.env["COLTRANE_LEDGER_PATH"];
      else process.env["COLTRANE_LEDGER_PATH"] = savedGig;
      if (savedGenomeLedger === undefined) delete process.env["COLTRANE_GENOME_LEDGER_PATH"];
      else process.env["COLTRANE_GENOME_LEDGER_PATH"] = savedGenomeLedger;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("SplitLedger still routes genome_mutation to the genome ledger and gig rows to the gig ledger", () => {
    // The WO-F06 routing is DESIGN, not a defect — the path/isolation correction must not disturb
    // it. GREEN now; guards against a fix that collapses the split.
    const dir = root();
    try {
      const genomeLedger = new FileLedger(join(dir, "genome", "ledger.jsonl"));
      const gigLedger = new FileLedger(join(dir, ".coltrane", "ledger.jsonl"));
      const led: Ledger = new SplitLedger(genomeLedger, gigLedger);
      led.append(genomeMut("alpha"));
      led.append(gig("gig-1"));

      expect(genomeLedger.query({ kind: "genome_mutation" }).map((e) => e.subject_slug)).toEqual(["alpha"]);
      expect(genomeLedger.query({ kind: "gig" }), "no gig row on the genome side").toEqual([]);
      expect(gigLedger.query({ kind: "gig" }).map((e) => e.gig_id)).toEqual(["gig-1"]);
      expect(gigLedger.query({ kind: "genome_mutation" }), "no genome seal on the gig side").toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
