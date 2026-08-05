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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
      const d = r.data as { gigs_run: number; counts_complete?: boolean };
      expect(d.gigs_run, "three rows survived the torn tail").toBe(3);
      expect(
        d.counts_complete,
        "gigs_run/cost are computed over the rows that PARSED. With a corrupt line present " +
          "the total is short, and an unmarked short total is a fabricated measurement.",
      ).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Positive control — a healthy system must not cry wolf, or operators learn to ignore it.
  it("an intact ledger reports ok with no corruption and complete counts", async () => {
    const dir = freshDir();
    try {
      const path = join(dir, "ledger.jsonl");
      writeFileSync(path, [gigLine("g1"), gigLine("g2")].join("\n") + "\n", "utf8");
      const r = await dispatchTool("system_health", {}, deps(new FileLedger(path)));
      const d = r.data as {
        gigs_run: number; counts_complete?: boolean;
        ledger_integrity?: { ok: boolean; corrupt: unknown[] };
      };
      expect(d.ledger_integrity!.ok).toBe(true);
      expect(d.ledger_integrity!.corrupt).toEqual([]);
      expect(d.counts_complete).toBe(true);
      expect(d.gigs_run).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("surfaces the output store's damage too — the ledger is not the only audit surface", async () => {
    const dir = freshDir();
    try {
      const outDir = join(dir, "outputs-root");
      const gigFile = join(outDir, "outputs", "g1.jsonl");
      require("node:fs").mkdirSync(join(outDir, "outputs"), { recursive: true });
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
  });
});
