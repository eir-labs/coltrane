// #255 — the integrity reports exist and nothing asks for them.
//
// #211 gave FileLedger a real skip-and-REPORT path, and `outputs.ts` has the same
// (`integrity()`, #248). Both compute an honest damage report. Neither is reachable from
// an operator's seat: `grep -c integrity src/server.ts` is 0. No MCP tool surfaces either,
// and the `Ledger` interface does not even DECLARE `integrity()` — which is why
// tests/ledger_integrity.test.ts has to cast through `Record<string, unknown>` to call it.
//
// This is the same disease as #263: a validity check that is never consulted is not a
// validity check. #209 made FileLedger the production default, so the failure mode went
// from theoretical to live.
//
// And there is a second, sharper edge. `system_health` reports `gigs_run`, `cost`, and
// `outputs` — numbers DERIVED from a store that has silently dropped its corrupt lines.
// So the operator is handed a confident total that is quietly short, with nothing marking
// it short. A number that is wrong and looks right is worse than a missing one; the
// missing one gets investigated. `#238`/`#248` are the same finding in other places.
//
// `load_errors` (server.ts, Rob #129) is the precedent: a soft-failure channel surfaced
// on `system_health`, which CLAUDE.md tells operators to run first thing in a session.
// Corruption belongs in exactly that spot and should read exactly as loudly.
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileLedger, MemoryLedger, type Ledger } from "../src/ledger.js";
import { createRegistry, createOutputStore, type DomainType } from "../src/index.js";
import { dispatchTool } from "../src/server.js";
import type { ServerDeps } from "../src/index.js";

const GENOME_HASH = "a".repeat(64);
const RUN_FP = "b".repeat(64);

const note: DomainType = {
  slug: "note", extends: "Signal", domain: "demo",
  schema: { properties: { t: { type: "string" } } }, required_fields: ["t"],
};

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "integrity-surfaced-"));
}

function gigLine(id: string): string {
  return JSON.stringify({
    kind: "gig", schema_version: 2, entry_id: id, gig_id: id,
    standard_slug: "readiness-scan", genome_hash: GENOME_HASH, run_fingerprint: RUN_FP,
    output_hashes: [], started_at: "2026-05-25T20:00:00.000Z", finished_at: "2026-05-25T20:01:00.000Z",
  });
}

/** N intact rows then a torn final line — the residue an unfsynced append leaves on a crash. */
function seedWithTornTail(path: string, n: number): void {
  const rows = Array.from({ length: n }, (_, i) => gigLine(`g${i + 1}`));
  const torn = gigLine("g999").slice(0, 30); // truncated mid-object
  writeFileSync(path, rows.join("\n") + "\n" + torn + "\n", "utf8");
}

function deps(ledger: Ledger, outputsDir?: string): ServerDeps {
  const registry = createRegistry();
  registry.registerType(note);
  return {
    registry,
    outputs: createOutputStore(registry, outputsDir ? { persistDir: outputsDir } : undefined),
    ledger,
  };
}

describe("#255 — ledger corruption reaches the operator", () => {
  // THE case.
  it("system_health reports the damage when the ledger has a torn line", async () => {
    const dir = freshDir();
    try {
      const path = join(dir, "ledger.jsonl");
      seedWithTornTail(path, 3);
      const r = await dispatchTool("system_health", {}, deps(new FileLedger(path)));
      const d = r.data as { ledger_integrity?: { ok: boolean; corrupt: unknown[] } };
      expect(
        d.ledger_integrity,
        "the report is computed and thrown away — system_health is where CLAUDE.md sends " +
          "operators first, and it is where load_errors already lives",
      ).toBeDefined();
      expect(d.ledger_integrity!.ok).toBe(false);
      expect(d.ledger_integrity!.corrupt.length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The sharper edge: the derived numbers are computed over what SURVIVED the parse.
  it("marks the derived counts as incomplete rather than reporting a short total as whole", async () => {
    const dir = freshDir();
    try {
      const path = join(dir, "ledger.jsonl");
      seedWithTornTail(path, 3);
      const r = await dispatchTool("system_health", {}, deps(new FileLedger(path)));
      const d = r.data as { gigs_run: number; counts_complete?: boolean | null; counts_complete_basis?: string };
      expect(d.gigs_run, "three rows survived the torn tail").toBe(3);
      expect(
        d.counts_complete,
        "gigs_run/cost are computed over the rows that PARSED. With a corrupt line present " +
          "the total is short, and an unmarked short total is a fabricated measurement.",
      ).toBe(false);
      expect(d.counts_complete_basis, "say WHICH surface is damaged, not just that something is").toMatch(/ledger/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Positive control — a healthy system must not cry wolf, or operators learn to ignore it.
  it("an intact ledger reports ok with no corruption, and does NOT claim the counts are whole", async () => {
    const dir = freshDir();
    try {
      const path = join(dir, "ledger.jsonl");
      writeFileSync(path, [gigLine("g1"), gigLine("g2")].join("\n") + "\n", "utf8");
      const r = await dispatchTool("system_health", {}, deps(new FileLedger(path)));
      const d = r.data as {
        gigs_run: number; counts_complete?: boolean | null; counts_complete_basis?: string;
        ledger_integrity?: { ok: boolean; corrupt: unknown[] };
      };
      expect(d.ledger_integrity!.ok).toBe(true);
      expect(d.ledger_integrity!.corrupt).toEqual([]);
      expect(d.gigs_run).toBe(2);
      // The heart of the round-2 correction. `true` here would be inferring completeness from
      // the absence of a parse error, which does not follow — see the next test.
      expect(
        d.counts_complete,
        "no corruption found is not proof nothing is missing; a labelled null is the answer",
      ).toBeNull();
      expect(d.counts_complete_basis).toMatch(/NOT proof/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The case that makes `counts_complete: true` indefensible, and the reason it can never be
  // returned. Truncating at a LINE BOUNDARY is the likeliest way an append-only file gets
  // damaged — an interrupted write, a truncated copy — and it destroys whole rows while
  // leaving every surviving line perfectly parseable.
  it("a ledger truncated at a line boundary loses rows while reporting no corruption", async () => {
    const dir = freshDir();
    try {
      const path = join(dir, "ledger.jsonl");
      writeFileSync(path, [gigLine("g1"), gigLine("g2"), gigLine("g3")].join("\n") + "\n", "utf8");
      // Keep only the first row, cut cleanly after its newline.
      writeFileSync(path, gigLine("g1") + "\n", "utf8");
      const r = await dispatchTool("system_health", {}, deps(new FileLedger(path)));
      const d = r.data as { gigs_run: number; counts_complete?: boolean | null };
      expect(d.gigs_run, "two rows are simply gone").toBe(1);
      expect(
        d.counts_complete,
        "nothing detectable is wrong, and the count is still short. This is exactly why the " +
          "field must never say `true` — it would be the #238 fabricated attestation again.",
      ).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // #248's whole scenario is a torn append — which means the file the RUNNING process just
  // wrote. `write()` marks that gig hydrated, so the store never read it back and reported
  // `{ok:true, scanned:0}` for a directory full of its own output.
  it("scans files this process itself wrote, not just ones it hydrated for reading", async () => {
    const dir = freshDir();
    try {
      const registry = createRegistry();
      registry.registerType(note);
      const store = createOutputStore(registry, { persistDir: dir });
      store.write({
        core_type: "Signal", domain_type: "note", domain: "demo", gig_id: "g1",
        agent_slug: "a", primitive: "SENSE", data: { t: "x", source: "fixture://demo" },
      });
      // A torn append lands after ours — the crash residue #248 is about.
      appendFileSync(join(dir, "outputs", "g1.jsonl"), '{"id":"o2","gig_id":"g1"\n', "utf8");
      const report = store.integrity();
      expect(report.ok, "the store must read the file it just wrote").toBe(false);
      expect(report.scanned, "scanned:0 over a populated dir is a report about nothing").toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // CLAUDE.md sends operators to system_health FIRST, which pins the snapshot at the earliest
  // possible moment. Memoizing meant every later call re-asserted that t=0 answer.
  it("re-scans on every call rather than repeating its first answer", async () => {
    const dir = freshDir();
    try {
      const registry = createRegistry();
      registry.registerType(note);
      const store = createOutputStore(registry, { persistDir: dir });
      store.write({
        core_type: "Signal", domain_type: "note", domain: "demo", gig_id: "g1",
        agent_slug: "a", primitive: "SENSE", data: { t: "x", source: "fixture://demo" },
      });
      expect(store.integrity().ok, "clean to begin with").toBe(true);
      appendFileSync(join(dir, "outputs", "g1.jsonl"), "{not json\n", "utf8");
      expect(store.integrity().ok, "damage that arrived after the first call must still be seen").toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("surfaces the output store's damage too — the ledger is not the only audit surface", async () => {
    const dir = freshDir();
    try {
      const outDir = join(dir, "outputs-root");
      const gigFile = join(outDir, "outputs", "g1.jsonl");
      mkdirSync(join(outDir, "outputs"), { recursive: true });
      writeFileSync(gigFile, '{"id":"o1","gig_id":"g1"\n', "utf8"); // torn
      const r = await dispatchTool("system_health", {}, deps(new MemoryLedger(), outDir));
      const d = r.data as { outputs_integrity?: { ok: boolean; corrupt: unknown[] } };
      expect(d.outputs_integrity, "outputs.integrity() has the same zero call sites").toBeDefined();
      expect(d.outputs_integrity!.ok).toBe(false);
      expect(d.outputs_integrity!.corrupt.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#255 — integrity() is reachable without narrowing", () => {
  // tests/ledger_integrity.test.ts casts through `Record<string, unknown>` to call it.
  // That cast IS the defect: a consumer holding the interface cannot ask the question.
  //
  // NOTE ON WHAT ENFORCES THIS. `typeof l.integrity` is "function" at runtime whichever
  // way the interface is written, because the FileLedger INSTANCE carries the method —
  // so vitest alone cannot fail this. `tsc --noEmit` is what sees it, and did:
  //   tests/integrity_surfaced.test.ts: error TS2339: Property 'integrity' does not
  //   exist on type 'Ledger'.
  // Keep the binding annotated `: Ledger` and DO NOT cast — the annotation is the
  // assertion, and the `typecheck` band is the thing that reports it. Read as a runtime
  // test this is hollow; read as a compile-time one it is exact.
  it("the Ledger interface declares integrity(), so an interface-typed binding can call it", () => {
    const dir = freshDir();
    try {
      const path = join(dir, "ledger.jsonl");
      writeFileSync(path, gigLine("g1") + "\n", "utf8");
      const l: Ledger = new FileLedger(path); // interface-typed ON PURPOSE — no cast below
      expect(typeof (l as Ledger).integrity).toBe("function");
      expect(l.integrity().ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Every Ledger must answer the question, including the one that cannot corrupt.
  // "In-memory, so it cannot tear" is an ANSWER; a missing method is a gap.
  it("MemoryLedger answers it too, honestly", () => {
    const m = new MemoryLedger();
    const l: Ledger = m;
    expect(typeof l.integrity).toBe("function");
    const report = l.integrity();
    expect(report.ok).toBe(true);
    expect(report.corrupt).toEqual([]);
    // Mutating either of these left the whole suite green. `path` in particular is argued for
    // at length in the PR description and was asserted nowhere — and it lands in an MCP
    // response, so a wrong value is something an operator reads.
    expect(report.path, "there is no file; an empty string says so without naming a fake one").toBe("");
    expect(report.entries, "in-memory rows are still entries this report covers").toBe(0);
  });
});
