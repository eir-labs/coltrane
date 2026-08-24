// WO-F07 Article I — `coltrane seal-genome`, the bulk-migration primitive.
//
// This suite is the RED spec for a new command that brings a PRE-SEALING genome into the sealed
// regime. It iterates the blessed write path (`sealDefinition`, src/genome_writer.ts:69) over every
// genome file under standards/, domain_types/, agents/ and, for each file not already sealed,
// appends a `genome_mutation` seal to the WO-F06 git-tracked genome ledger
// (`defaultGenomeLedgerPath`, src/ledger.ts:258). It seals IDENTITY — it does not rewrite content.
//
// Acceptance criteria covered (WO-F07 Article I):
//   AC1  seal-genome seals every file under standards/ | domain_types/ | agents/ via sealDefinition —
//        each gains a genome_mutation seal in the tracked genome ledger.               → INV-SEAL-ALL
//   AC2  content is byte-unchanged for every sealed file (seals identity, not the JSON). → INV-BYTES
//   AC3  idempotent: a second run adds no new seals and reports zero newly-sealed.     → INV-IDEMPOTENT
//   AC4  round trip: unsealed fixture → seal-genome → detectGenomeOrphans returns [] and
//        `coltrane validate` passes; a second run seals nothing.       → INV-ORPHAN-CLOSURE / INV-VALIDATE
//   AC5  no genome file's content is modified; only the ledger (+ history) changes.      → INV-BYTES
//   AC6  no change outside src/ and tests/ — a diff-scope obligation, verified at review of the
//        captured red-spec diff, not a runtime assertion (see the spec doc).
//   +    idempotency slug-fold: an agent_evolve seal at `slug@v2` covers the flat `slug.json`, so
//        the fold `split("@")[0]` (matching detectGenomeOrphans, src/genome_writer.ts:260) must not
//        re-seal it (miles risk-3).                                                        → INV-FOLD
//   +    the command dispatches through runCli and is documented in USAGE.                 → INV-CLI
//
// RED today: `src/seal_genome.ts` does not exist, so `sealGenome` cannot be imported — every
// function-level law throws at the load-site (the enforcement is absent). The CLI laws bind to the
// REAL `runCli`/`USAGE`: `seal-genome` is not in KNOWN (src/cli.ts:205) so runCli returns exit 2,
// and USAGE (src/cli.ts:45) does not mention it. That absence is the point — it is exactly the hole
// this change closes.
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileLedger,
  MemoryLedger,
  defaultGenomeLedgerPath,
  LEDGER_SCHEMA_VERSION,
  type Ledger,
  type GenomeMutationLedgerEntry,
} from "../src/ledger.js";
import { detectGenomeOrphans, ORPHAN_SCAN_SUBDIRS } from "../src/genome_writer.js";
import { canonJson, sha256Hex, effectiveHash, EMPTY_DEPENDENCY_HASH } from "../src/canonical_form.js";
import { runCli, USAGE, type CliIO } from "../src/cli.js";
import { TEST_BEHAVIOR } from "./_support/agents.js";

// ── The contract this red-spec pins ─────────────────────────────────────────────────────────────
// `sealGenome(genome_dir, ledger)` returns genome-relative paths (NOT bare counts) for `sealed` and
// `skipped`, plus per-file `errors`, so the caller can BOTH count (`.length`) and NAME which file
// was sealed/skipped/failed — the CLI emits the counts to stderr, and the slug-fold law below must
// assert WHICH file was skipped, which a bare count cannot express. This is the shape the maker must
// satisfy; the runtime-variable dynamic import keeps the shared `tsc` gate green (a non-literal
// specifier resolves to `any`, so no "cannot find module") while resolving to a module-not-found
// throw at runtime today — the RED.
interface SealGenomeReport {
  sealed: string[];
  skipped: string[];
  errors: Array<{ path: string; error: string }>;
}
type SealGenomeFn = (genome_dir: string, ledger: Ledger) => SealGenomeReport;

const SEAL_GENOME_MODULE = "../src/seal_genome.js";
async function loadSealGenome(): Promise<SealGenomeFn> {
  const mod = (await import(SEAL_GENOME_MODULE)) as { sealGenome?: SealGenomeFn };
  if (typeof mod.sealGenome !== "function") {
    throw new Error("src/seal_genome.ts must export sealGenome(genome_dir, ledger: Ledger) — not found");
  }
  return mod.sealGenome;
}

function root(prefix = "seal-genome-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Write a genome file in sealDefinition's EXACT on-disk serialization — `JSON.stringify(def, null,
 *  2) + "\n"` (src/genome_writer.ts:112). A pre-sealing genome that is already in this canonical
 *  form is what makes "byte-unchanged" a real invariant rather than an artifact of formatting: the
 *  blessed path re-serializes the parsed object, so identical-in → identical-out. */
function writeCanonical(dir: string, subdir: string, slug: string, body: Record<string, unknown>): void {
  const d = join(dir, subdir);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `${slug}.json`), JSON.stringify(body, null, 2) + "\n");
}

/** A minimal 3-file unsealed genome: one standard, one type, one agent. Not schema-validated (the
 *  blessed `sealDefinition` hashes canonJson(def) without a loader pass), so simple objects suffice
 *  for the function-level laws; the CLI/validate law below uses a fully loadable genome. */
function writeUnsealedGenome(dir: string): void {
  writeCanonical(dir, "standards", "s1", { slug: "s1", domain: "demo", note: "unsealed standard" });
  writeCanonical(dir, "domain_types", "t1", { slug: "t1", domain: "demo", note: "unsealed type" });
  writeCanonical(dir, "agents", "a1", { slug: "a1", domain: "demo", note: "unsealed agent" });
}

function io(): CliIO & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, out: (s: string) => stdout.push(s), err: (s: string) => stderr.push(s) } as CliIO & {
    stdout: string[];
    stderr: string[];
  };
}

// ── INV-SEAL-ALL (AC1) ───────────────────────────────────────────────────────────────────────────
describe("seal-genome seals every genome file through the blessed sealDefinition path (INV-SEAL-ALL)", () => {
  it("appends a genome_mutation seal for every file under standards/, domain_types/, agents/, keyed by the per-kind event", async () => {
    const sealGenome = await loadSealGenome();
    const dir = root();
    try {
      writeUnsealedGenome(dir);
      const ledger = new MemoryLedger();

      const report = sealGenome(dir, ledger);

      // The shape the maker must return: named paths, not bare counts.
      expect(Array.isArray(report.sealed), "sealGenome must return `sealed` as genome-relative paths").toBe(true);
      expect(report.sealed.length, "every one of the three unsealed files must be sealed").toBe(3);
      expect(report.errors, "a clean pre-sealing genome must seal without per-file errors").toEqual([]);

      const seals = ledger.query({ kind: "genome_mutation" });
      const bySlug = new Map(seals.map((e) => [(e as GenomeMutationLedgerEntry).subject_slug, e as GenomeMutationLedgerEntry]));

      // Every file carries a seal, keyed by the KIND-appropriate event (the MCP-tool-name convention
      // sealDefinition already uses), NOT a single generic "seal_genome" — so kind provenance
      // survives in the audit trail.
      expect(bySlug.get("s1")?.event, "a standard seals with event standard_compose").toBe("standard_compose");
      expect(bySlug.get("t1")?.event, "a domain type seals with event type_register").toBe("type_register");
      expect(bySlug.get("a1")?.event, "an agent seals with event agent_define").toBe("agent_define");

      // The blessed path records identity as the canonical hash of the file's parsed content — the
      // same content_hash the idempotency check will later match on. This proves sealDefinition (which
      // writes the file AND the seal) was used, not a fabricated ledger row.
      const t1Bytes = readFileSync(join(dir, "domain_types", "t1.json"), "utf-8");
      expect(bySlug.get("t1")?.content_hash, "the seal's content_hash must be the canonical hash of the file's content").toBe(
        sha256Hex(canonJson(JSON.parse(t1Bytes))),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── INV-BYTES (AC2, AC5) ──────────────────────────────────────────────────────────────────────────
describe("seal-genome leaves every genome file byte-unchanged — it seals identity, not the JSON (INV-BYTES)", () => {
  it("every file's bytes AND parsed content are identical after a full run; only the ledger changes", async () => {
    const sealGenome = await loadSealGenome();
    const dir = root();
    try {
      writeUnsealedGenome(dir);

      // Snapshot every genome file's bytes before the run.
      const before = new Map<string, string>();
      for (const subdir of ORPHAN_SCAN_SUBDIRS) {
        const d = join(dir, subdir);
        if (!existsSync(d)) continue;
        for (const slug of ["s1", "t1", "a1"]) {
          const p = join(d, `${slug}.json`);
          if (existsSync(p)) before.set(p, readFileSync(p, "utf-8"));
        }
      }
      expect(before.size, "the fixture must have written three files to snapshot").toBe(3);

      sealGenome(dir, new MemoryLedger());

      for (const [p, bytes] of before) {
        const after = readFileSync(p, "utf-8");
        // The core AC: CONTENT (the parsed JSON) is unchanged — the command seals identity.
        expect(JSON.parse(after), `content of ${p} must be unchanged`).toEqual(JSON.parse(bytes));
        // The stronger form: for a genome already in the blessed on-disk serialization, sealing is
        // byte-idempotent — no rewrite of the JSON, no history snapshot for identical bytes.
        expect(after, `bytes of ${p} must be byte-identical — sealing must not rewrite the file`).toBe(bytes);
      }

      // No prior-version history is snapshotted when the bytes did not change.
      expect(
        existsSync(join(dir, "genome", "history")),
        "byte-identical seals must not snapshot any prior version under genome/history/",
      ).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── INV-IDEMPOTENT (AC3) ──────────────────────────────────────────────────────────────────────────
describe("seal-genome is idempotent — a second run seals nothing already sealed (INV-IDEMPOTENT)", () => {
  it("first run seals N and skips 0; second run seals 0 and skips N, adding no new ledger entries", async () => {
    const sealGenome = await loadSealGenome();
    const dir = root();
    try {
      writeUnsealedGenome(dir);
      const ledger = new MemoryLedger();

      const first = sealGenome(dir, ledger);
      expect(first.sealed.length, "the first run seals all three unsealed files").toBe(3);
      expect(first.skipped.length, "nothing is skipped on the first run").toBe(0);
      const afterFirst = ledger.count({ kind: "genome_mutation" });
      expect(afterFirst, "the first run appends one seal per file").toBe(3);

      const second = sealGenome(dir, ledger);
      expect(second.sealed.length, "a file whose content already matches a seal is skipped — zero newly-sealed").toBe(0);
      expect(second.skipped.length, "all three files are recognized as already sealed").toBe(3);
      expect(
        ledger.count({ kind: "genome_mutation" }),
        "the second run must add NO new genome_mutation entries — the ledger length is unchanged",
      ).toBe(afterFirst);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── INV-FOLD (idempotency slug-fold, miles risk-3) ────────────────────────────────────────────────
describe("seal-genome folds slug@vN to the base slug and does not re-seal a versioned file (INV-FOLD)", () => {
  it("an agent_evolve seal recorded at subject_slug='evo@v2' covers agents/evo.json — the fold matches, so it is skipped not re-sealed", async () => {
    const sealGenome = await loadSealGenome();
    const dir = root();
    try {
      // A file on disk named evo.json, sealed in the ledger ONLY under the versioned identity evo@v2
      // (as agent_evolve records it, src/genome_writer.ts recordIdentity). The base slug is `evo`.
      const agent = { slug: "evo", domain: "demo", note: "an evolved agent, sealed at v2" };
      writeCanonical(dir, "agents", "evo", agent);
      const ledger = new MemoryLedger();

      const content_hash = sha256Hex(canonJson(agent)); // the on-disk file's canonical content hash
      const now = "2026-08-24T00:00:00.000Z";
      ledger.append({
        kind: "genome_mutation",
        schema_version: LEDGER_SCHEMA_VERSION,
        entry_id: "agent_evolve:evo@v2:seed",
        event: "agent_evolve",
        subject_slug: "evo@v2",
        content_hash,
        dependency_hash: EMPTY_DEPENDENCY_HASH,
        effective_hash: effectiveHash(content_hash, EMPTY_DEPENDENCY_HASH),
        output_hashes: [content_hash],
        started_at: now,
        finished_at: now,
      });

      const report = sealGenome(dir, ledger);

      // The fold split("@")[0] === "evo" matches the base slug AND the content_hash matches, so the
      // file is already sealed — it must be SKIPPED, never re-sealed. Re-sealing would append a
      // duplicate entry and break idempotency for every agent_evolve-produced file.
      expect(report.skipped.some((p) => p.includes("evo")), "the versioned-sealed file must be recognized via the fold and skipped").toBe(true);
      expect(report.sealed.some((p) => p.includes("evo")), "the versioned-sealed file must NOT be re-sealed").toBe(false);
      expect(
        ledger.count({ kind: "genome_mutation" }),
        "no new genome_mutation entry may be appended for the already-(versioned-)sealed file",
      ).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── INV-ORPHAN-CLOSURE (AC4) ──────────────────────────────────────────────────────────────────────
describe("seal-genome closes the orphan invariant — orphans before, none after (INV-ORPHAN-CLOSURE)", () => {
  it("detectGenomeOrphans is non-empty on the unsealed fixture and returns [] after a full run", async () => {
    const sealGenome = await loadSealGenome();
    const dir = root();
    try {
      writeUnsealedGenome(dir);
      const ledger = new MemoryLedger();

      // Precondition (NOT the RED): with an empty ledger every file is an orphan.
      const before = detectGenomeOrphans(dir, ledger);
      expect(before.length, "the unsealed fixture must start with orphans — no seals yet").toBe(3);

      sealGenome(dir, ledger);

      const after = detectGenomeOrphans(dir, ledger);
      expect(after, "after a full seal-genome run every file carries its seal — zero orphans").toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── INV-VALIDATE (AC4) + INV-CLI ──────────────────────────────────────────────────────────────────
// A fully loadable genome (real type/agent/standard) so `coltrane validate` runs genome_reload AND
// the orphan check against seals seal-genome actually wrote.
const TYPE = {
  slug: "note",
  version: 1,
  extends: "Signal",
  domain: "demo",
  schema: { properties: { t: { type: "string" } } },
  required_fields: ["t"],
};
const AGENT = {
  slug: "scout",
  version: 1,
  domain: "demo",
  primitives: ["SENSE"],
  input_types: [],
  output_types: ["note"],
  description: "d",
  status: "active",
  allowed_tools: [],
  disallowed_tools: [],
  skill_slugs: [],
  ...TEST_BEHAVIOR,
};
const STANDARD = {
  slug: "live",
  domain: "demo",
  agent_slugs: ["scout"],
  phases: [
    {
      name: "p",
      chairs: [{ role: "r", agent_slug: "scout", depends_on: [], input_contract: [], output_contract: ["note"], required_skills: [] }],
    },
  ],
};

function loadableGenome(): string {
  const dir = root("seal-genome-cli-");
  writeCanonical(dir, "domain_types", "note", TYPE);
  writeCanonical(dir, "agents", "scout", AGENT);
  writeCanonical(dir, "standards", "live", STANDARD);
  return dir;
}

describe("`coltrane seal-genome` dispatches through the CLI and its output passes `coltrane validate` (INV-CLI, INV-VALIDATE)", () => {
  it("is a documented, known command — USAGE names it and runCli does not reject it as malformed", async () => {
    // Usage-stays-true: a documented command that does not exist, or one that exists undocumented,
    // is the same drift the tests/cli.test.ts usage law guards against.
    expect(USAGE, "USAGE must document the new command").toContain("coltrane seal-genome");

    const dir = root("seal-genome-empty-");
    try {
      // An empty genome dir: nothing to seal, no errors → exit 0. In RED this returns 2 (unknown
      // command), so this pins that seal-genome is wired into KNOWN and runCli's dispatch.
      const o = io();
      const code = await runCli(["seal-genome", dir], o);
      expect(code, `seal-genome must be a recognized command (got exit ${code}: ${o.stderr.join("")})`).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("seals a loadable genome, then `coltrane validate` passes and a second seal-genome seals nothing", async () => {
    const dir = loadableGenome();
    const savedGenome = process.env["COLTRANE_GENOME_LEDGER_PATH"];
    try {
      // Both seal-genome and validate must agree on WHERE the genome ledger lives.
      process.env["COLTRANE_GENOME_LEDGER_PATH"] = join(dir, "genome", "ledger.jsonl");

      const o1 = io();
      const sealCode = await runCli(["seal-genome", dir], o1);
      expect(sealCode, `seal-genome must exit 0 on a clean genome (got ${sealCode}: ${o1.stderr.join("")})`).toBe(0);

      // The seals seal-genome wrote must be exactly what makes the orphan check pass. validate's
      // orphan gate only fires when the genome ledger holds seals, so a 0 here is the check PASSING
      // against a non-empty ledger, not being skipped over an empty one.
      const genomeLedger = new FileLedger(defaultGenomeLedgerPath(dir));
      expect(genomeLedger.count({ kind: "genome_mutation" }), "seal-genome must have written seals to the tracked genome ledger").toBe(3);
      expect(detectGenomeOrphans(dir, genomeLedger), "the sealed canon has no orphans").toEqual([]);

      const o2 = io();
      const validateCode = await runCli(["validate", "--genome", dir], o2);
      expect(validateCode, `validate must pass against the fully-sealed canon (stderr: ${o2.stderr.join("")})`).toBe(0);

      // A second run over the already-sealed genome seals nothing.
      const o3 = io();
      const secondCode = await runCli(["seal-genome", dir], o3);
      expect(secondCode, "a second seal-genome run over a sealed canon still exits 0").toBe(0);
      expect(
        genomeLedger.count({ kind: "genome_mutation" }),
        "the second run must add no new seals — the ledger length is unchanged",
      ).toBe(3);
    } finally {
      if (savedGenome === undefined) delete process.env["COLTRANE_GENOME_LEDGER_PATH"];
      else process.env["COLTRANE_GENOME_LEDGER_PATH"] = savedGenome;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
