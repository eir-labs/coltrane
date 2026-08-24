// WO-F06 — genome provenance ships with its repo.
//
// Today src/ledger.ts resolves ONE ledger at .coltrane/ledger.jsonl (gitignored) that holds
// BOTH kind=genome_mutation seals (the identity of every standard/type/agent authored through
// the blessed MCP write path) AND kind=gig runtime rows. genome_writer.ts snapshots prior
// genome versions to the gitignored .coltrane/history/. Because .gitignore excludes all of
// .coltrane/, a genome repo ships its genome files WITHOUT their seals — so on a fresh clone
// every genome object is an orphan by the engine's own invariant ("a hand-edited file with no
// ledger entry is an orphan — no identity, outside the substrate", src/genome_writer.ts:1-6).
//
// This suite is the RED spec for the split:
//   AC1a  genome_mutation seals route to a git-TRACKED path OUTSIDE .coltrane/ (genome/ledger.jsonl)
//   AC1b  gig rows still route to the gitignored .coltrane/ledger.jsonl, and reads union both
//   AC5   COLTRANE_LEDGER_PATH still overrides the GIG ledger only; a new
//         COLTRANE_GENOME_LEDGER_PATH overrides the genome ledger, and the two do not bleed
//   AC2a  a fully sealed genome dir yields ZERO orphans
//   AC2b  a genome file under standards/ | domain_types/ | agents/ with no seal IS an orphan
//   AC3   `coltrane validate` exits non-zero on an unsealed genome dir, zero on a sealed one
//   AC4   prior-version history snapshots land under genome/history/, not .coltrane/history/
//
// Every test below is RED against the unmodified engine: SplitLedger, defaultGenomeLedgerPath
// and detectGenomeOrphans do not exist yet, the writer still snapshots to .coltrane/history/,
// and `validate` runs no orphan check. That absence is the point — it is exactly the hole this
// change closes.
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileLedger, defaultLedgerPath, LEDGER_SCHEMA_VERSION } from "../src/ledger.js";
import type { Ledger, GenomeMutationLedgerEntry, GigLedgerEntry } from "../src/ledger.js";
import { writeGenomeFileVersioned, sealDefinition } from "../src/genome_writer.js";
import * as ledgerNS from "../src/ledger.js";
import * as writerNS from "../src/genome_writer.js";
import { sha256Hex } from "../src/canonical_form.js";
import { runCli, type CliIO } from "../src/cli.js";
import { TEST_BEHAVIOR } from "./_support/agents.js";

// The three symbols this change introduces do not exist on the unmodified engine. They are
// referenced through a typed shim (the repo's `as unknown as {…}` idiom) so the file TYPECHECKS
// — the shared `tsc` build gate must pass for any test to run — while every call below resolves
// to `undefined` at runtime today and THROWS, which is the RED this spec demands. The shim names
// the exact export name, arity and signature the maker must satisfy; it is the contract, not a
// convenience.
const SplitLedger = (ledgerNS as unknown as {
  SplitLedger: new (genomeLedger: Ledger, gigLedger: Ledger) => Ledger;
}).SplitLedger;
const defaultGenomeLedgerPath = (ledgerNS as unknown as {
  defaultGenomeLedgerPath: (root?: string) => string;
}).defaultGenomeLedgerPath;
const detectGenomeOrphans = (writerNS as unknown as {
  detectGenomeOrphans: (genome_dir: string, ledger: Ledger) => string[];
}).detectGenomeOrphans;

function root(prefix = "genome-ships-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** 64 lowercase hex — what validateEntry requires for the hash fields. */
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

// ── AC1 / AC5 — the ledger split routes by kind ────────────────────────────────────────────
describe("the ledger split routes seals by kind (AC1, AC5)", () => {
  it("routes kind=genome_mutation to the tracked genome ledger OUTSIDE .coltrane/, and kind=gig to .coltrane/", () => {
    const dir = root();
    try {
      const genomePath = join(dir, "genome", "ledger.jsonl");
      const gigPath = join(dir, ".coltrane", "ledger.jsonl");
      const led: Ledger = new SplitLedger(new FileLedger(genomePath), new FileLedger(gigPath));

      led.append(genomeMut("alpha"));
      led.append(gig("gig-1"));

      // The genome seal is provenance that must TRAVEL with the repo: it lands in genome/, a
      // git-tracked path, and the path does not sit under the gitignored .coltrane/.
      expect(
        genomePath.split(/[\\/]/).includes(".coltrane"),
        "the genome ledger must live outside .coltrane/ so a clone ships it",
      ).toBe(false);
      expect(existsSync(genomePath), "genome_mutation seal must be written to genome/ledger.jsonl").toBe(true);
      expect(readFileSync(genomePath, "utf-8")).toContain('"subject_slug":"alpha"');
      // ...and the genome seal must NOT leak into the gitignored gig ledger.
      const gigBytes = existsSync(gigPath) ? readFileSync(gigPath, "utf-8") : "";
      expect(gigBytes, "a genome seal must not land in the machine-local gig ledger").not.toContain("alpha");

      // The gig row is machine-local runtime state: it stays under .coltrane/, not in genome/.
      expect(existsSync(gigPath), "gig row must be written to .coltrane/ledger.jsonl").toBe(true);
      expect(readFileSync(gigPath, "utf-8")).toContain('"gig_id":"gig-1"');
      expect(readFileSync(genomePath, "utf-8"), "a gig row must not travel with the genome").not.toContain('"gig_id":"gig-1"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads union both sources, so genome_reload and existing consumers see every entry", () => {
    const dir = root();
    try {
      const led: Ledger = new SplitLedger(
        new FileLedger(join(dir, "genome", "ledger.jsonl")),
        new FileLedger(join(dir, ".coltrane", "ledger.jsonl")),
      );
      led.append(genomeMut("alpha"));
      led.append(gig("gig-1"));

      expect(led.count(), "a union read must return both the genome seal and the gig row").toBe(2);
      expect(led.query({ kind: "genome_mutation" }).map((e) => (e as GenomeMutationLedgerEntry).subject_slug)).toContain("alpha");
      expect(led.query({ kind: "gig" }).map((e) => (e as GigLedgerEntry).gig_id)).toContain("gig-1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("COLTRANE_LEDGER_PATH still overrides the GIG ledger only; COLTRANE_GENOME_LEDGER_PATH overrides the genome ledger, and neither bleeds", () => {
    const dir = root();
    const savedGig = process.env["COLTRANE_LEDGER_PATH"];
    const savedGenome = process.env["COLTRANE_GENOME_LEDGER_PATH"];
    try {
      delete process.env["COLTRANE_LEDGER_PATH"];
      delete process.env["COLTRANE_GENOME_LEDGER_PATH"];

      // Defaults: gig under .coltrane/, genome under genome/ (a tracked sibling of the genome files).
      expect(defaultLedgerPath(dir)).toBe(join(dir, ".coltrane", "ledger.jsonl"));
      expect(defaultGenomeLedgerPath(dir)).toBe(join(dir, "genome", "ledger.jsonl"));

      // The gig override still governs the gig ledger (unchanged behaviour).
      const gigOverride = join(dir, "custom-gig.jsonl");
      process.env["COLTRANE_LEDGER_PATH"] = gigOverride;
      expect(defaultLedgerPath(dir)).toBe(gigOverride);
      // ...and it must NOT bleed into the genome ledger path.
      expect(
        defaultGenomeLedgerPath(dir),
        "COLTRANE_LEDGER_PATH must govern only the gig ledger after the split",
      ).toBe(join(dir, "genome", "ledger.jsonl"));

      // The genome override governs only the genome ledger.
      const genomeOverride = join(dir, "custom-genome.jsonl");
      process.env["COLTRANE_GENOME_LEDGER_PATH"] = genomeOverride;
      expect(defaultGenomeLedgerPath(dir)).toBe(genomeOverride);
      expect(
        defaultLedgerPath(dir),
        "COLTRANE_GENOME_LEDGER_PATH must not disturb the gig ledger",
      ).toBe(gigOverride);
    } finally {
      if (savedGig === undefined) delete process.env["COLTRANE_LEDGER_PATH"];
      else process.env["COLTRANE_LEDGER_PATH"] = savedGig;
      if (savedGenome === undefined) delete process.env["COLTRANE_GENOME_LEDGER_PATH"];
      else process.env["COLTRANE_GENOME_LEDGER_PATH"] = savedGenome;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── AC2 — the orphan detector ──────────────────────────────────────────────────────────────
describe("the orphan detector correlates genome files with their seals (AC2)", () => {
  it("a fully sealed genome dir yields ZERO orphans", () => {
    const dir = root();
    try {
      const genomeLedger: Ledger = new FileLedger(join(dir, "genome", "ledger.jsonl"));
      // The blessed write path: each seal writes the file AND appends its genome_mutation row.
      sealDefinition("standard_compose", "sealed-standard", { slug: "sealed-standard" }, genomeLedger, dir, "standards");
      sealDefinition("type_register", "sealed-type", { slug: "sealed-type" }, genomeLedger, dir, "domain_types");
      sealDefinition("agent_define", "sealed-agent", { slug: "sealed-agent" }, genomeLedger, dir, "agents");

      const orphans = detectGenomeOrphans(dir, genomeLedger);
      expect(orphans, "every file authored through the blessed path has a matching seal").toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a genome file with no matching seal IS reported as an orphan; sealed siblings are not", () => {
    const dir = root();
    try {
      const genomeLedger: Ledger = new FileLedger(join(dir, "genome", "ledger.jsonl"));
      sealDefinition("standard_compose", "sealed-standard", { slug: "sealed-standard" }, genomeLedger, dir, "standards");

      // A hand-edited file, dropped straight into the genome with no MCP, no hash, no seal.
      mkdirSync(join(dir, "standards"), { recursive: true });
      writeFileSync(join(dir, "standards", "orphan.json"), JSON.stringify({ slug: "orphan" }, null, 2) + "\n");

      const orphans = detectGenomeOrphans(dir, genomeLedger);
      expect(
        orphans.some((o) => o.includes("orphan")),
        "an unsealed standard must be flagged — no identity, outside the substrate",
      ).toBe(true);
      expect(
        orphans.some((o) => o.includes("sealed-standard")),
        "a file WITH a matching seal must not be flagged",
      ).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── AC3 — the orphan invariant ships inside `coltrane validate` ─────────────────────────────
describe("`coltrane validate` enforces the orphan invariant (AC3)", () => {
  const TYPE = {
    slug: "note", version: 1, extends: "Signal", domain: "demo",
    schema: { properties: { t: { type: "string" } } }, required_fields: ["t"],
  };
  const AGENT = {
    slug: "scout", version: 1, domain: "demo", primitives: ["SENSE"],
    input_types: [], output_types: ["note"], description: "d", status: "active",
    allowed_tools: [], disallowed_tools: [], skill_slugs: [],
    ...TEST_BEHAVIOR,
  };
  const STANDARD = {
    slug: "live", domain: "demo", agent_slugs: ["scout"],
    phases: [{
      name: "p",
      chairs: [{ role: "r", agent_slug: "scout", depends_on: [], input_contract: [], output_contract: ["note"], required_skills: [] }],
    }],
  };

  function genomeRoot(): string {
    const dir = root("cli-genome-ships-");
    for (const [rel, body] of Object.entries({
      "domain_types/note.json": TYPE,
      "agents/scout.json": AGENT,
      "standards/live.json": STANDARD,
    })) {
      const full = join(dir, rel);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, JSON.stringify(body, null, 2));
    }
    return dir;
  }

  function seal(dir: string, slugs: Array<[string, string]>): void {
    const led = new FileLedger(join(dir, "genome", "ledger.jsonl"));
    for (const [slug, event] of slugs) led.append(genomeMut(slug, event));
  }

  function io(): CliIO & { stdout: string[]; stderr: string[] } {
    const stdout: string[] = [];
    const stderr: string[] = [];
    return { stdout, stderr, out: (s: string) => stdout.push(s), err: (s: string) => stderr.push(s) } as CliIO & { stdout: string[]; stderr: string[] };
  }

  it("exits 0 when every genome file is sealed", async () => {
    const dir = genomeRoot();
    const savedGenome = process.env["COLTRANE_GENOME_LEDGER_PATH"];
    try {
      process.env["COLTRANE_GENOME_LEDGER_PATH"] = join(dir, "genome", "ledger.jsonl");
      seal(dir, [["note", "type_register"], ["scout", "agent_define"], ["live", "standard_compose"]]);
      const o = io();
      const code = await runCli(["validate", "--genome", dir], o);
      expect(code, o.stderr.join("")).toBe(0);
    } finally {
      if (savedGenome === undefined) delete process.env["COLTRANE_GENOME_LEDGER_PATH"];
      else process.env["COLTRANE_GENOME_LEDGER_PATH"] = savedGenome;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits NON-ZERO and names the offender when a loadable genome file has no seal", async () => {
    const dir = genomeRoot();
    const savedGenome = process.env["COLTRANE_GENOME_LEDGER_PATH"];
    try {
      process.env["COLTRANE_GENOME_LEDGER_PATH"] = join(dir, "genome", "ledger.jsonl");
      // Same loadable genome, but the agent `scout` is left UNSEALED — an orphan the current
      // `validate` (which only checks load_errors) cannot see. The genome still LOADS, so a
      // non-zero exit here can only be the orphan check firing, never a load error.
      seal(dir, [["note", "type_register"], ["live", "standard_compose"]]);
      const o = io();
      const code = await runCli(["validate", "--genome", dir], o);
      expect(code, "an unsealed genome file must fail the CI gate").toBe(1);
      expect(
        o.stderr.join(""),
        "validate must name the orphan so CI says WHICH file has no provenance",
      ).toContain("scout");
    } finally {
      if (savedGenome === undefined) delete process.env["COLTRANE_GENOME_LEDGER_PATH"];
      else process.env["COLTRANE_GENOME_LEDGER_PATH"] = savedGenome;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── AC4 — prior-version history ships with the genome ────────────────────────────────────────
describe("prior-version history snapshots ship with the genome (AC4)", () => {
  it("snapshots a displaced version under genome/history/, not .coltrane/history/", () => {
    const dir = root();
    try {
      writeGenomeFileVersioned(dir, "domain_types", "note", '{"v":1}\n');
      const r = writeGenomeFileVersioned(dir, "domain_types", "note", '{"v":2}\n');
      expect(r.overwritten).toBe(true);
      expect(r.prior_content_hash).toBeTruthy();

      const tracked = join(dir, "genome", "history", "domain_types", "note", `${r.prior_content_hash}.json`);
      expect(existsSync(tracked), "the prior bytes must be snapshotted to the tracked genome/history/ path").toBe(true);
      expect(readFileSync(tracked, "utf-8")).toBe('{"v":1}\n');

      expect(
        existsSync(join(dir, ".coltrane", "history", "domain_types", "note")),
        "no snapshot may land under the gitignored .coltrane/history/",
      ).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
