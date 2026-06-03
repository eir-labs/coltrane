// Independent re-measurement of the FileLedger append/read contract.
//
// Primary path:  write via FileLedger.append() (public API), read via
//                FileLedger.query() (same module).
// Secondary path: write via raw fs.appendFileSync using the documented schema
//                 (one JSON object per line, '\n' separator), read via the
//                 same FileLedger.query() (the read side is shared so the
//                 comparison isolates the write contract).
//
// Agreement = the public append matches "JSON line per entry, no normalisation".
// Divergence = either (a) FileLedger.append normalises something the docs don't
// describe, or (b) the line schema is under-specified. Either is an honest
// finding; the test stays RED until reconciled.

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileLedger, type LedgerEntry } from "../../src/ledger.js";
import { compareHonestBroker } from "../../src/test_honest_broker.js";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "honest-broker-recorder-"));
}

// Five representative entry shapes covering the LedgerEntry surface.
const battery: readonly LedgerEntry[] = [
  // 1. minimal — every required field, single output hash.
  {
    gig_id: "gig-001",
    standard_slug: "scan",
    genome_hash: "gh-001",
    run_fingerprint: "rf-001",
    output_hashes: ["oh-001"],
    started_at: "2026-01-01T00:00:00Z",
    finished_at: "2026-01-01T00:00:05Z",
  },
  // 2. multiple output hashes — typical multi-phase gig.
  {
    gig_id: "gig-002",
    standard_slug: "scan-and-fix",
    genome_hash: "gh-002",
    run_fingerprint: "rf-002",
    output_hashes: ["oh-002-a", "oh-002-b", "oh-002-c"],
    started_at: "2026-02-01T12:00:00Z",
    finished_at: "2026-02-01T12:01:30Z",
  },
  // 3. empty output_hashes — edge case, no outputs produced.
  {
    gig_id: "gig-003",
    standard_slug: "noop",
    genome_hash: "gh-003",
    run_fingerprint: "rf-003",
    output_hashes: [],
    started_at: "2026-03-01T00:00:00Z",
    finished_at: "2026-03-01T00:00:00Z",
  },
  // 4. unicode + special chars in slugs/hashes — round-trip safety.
  {
    gig_id: "gig-004-α",
    standard_slug: "scan/with-slash",
    genome_hash: "gh-004-β",
    run_fingerprint: "rf-004-γ",
    output_hashes: ["oh-004:colon", "oh-004-emoji-🎷"],
    started_at: "2026-04-01T00:00:00Z",
    finished_at: "2026-04-01T00:00:01Z",
  },
  // 5. long hash list — stress the line length.
  {
    gig_id: "gig-005",
    standard_slug: "wide-fanout",
    genome_hash: "gh-005",
    run_fingerprint: "rf-005",
    output_hashes: Array.from({ length: 20 }, (_, i) => `oh-005-${i.toString().padStart(3, "0")}`),
    started_at: "2026-05-01T00:00:00Z",
    finished_at: "2026-05-01T00:00:10Z",
  },
];

describe("R7 honest-broker: FileLedger append contract", () => {
  for (const entry of battery) {
    it(`agrees on entry ${entry.gig_id}`, async () => {
      const cmp = await compareHonestBroker<readonly LedgerEntry[]>(
        async () => {
          // PRIMARY: write via the public API.
          const dir = freshDir();
          try {
            const path = join(dir, "ledger.jsonl");
            const l = new FileLedger(path);
            l.append(entry);
            return new FileLedger(path).query();
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        },
        async () => {
          // SECONDARY: write via raw fs.appendFileSync using the documented
          // line schema (one JSON object + '\n'). Bypasses every line of
          // FileLedger.append() including its validation guards.
          const dir = freshDir();
          try {
            const path = join(dir, "ledger.jsonl");
            // mkdir is owned by the public-API ctor; we replicate manually so
            // the test exercises only the line-schema contract.
            const fl = new FileLedger(path);
            // immediately bypass the writer with a raw append.
            void fl; // keep ctor side-effect (mkdir) without invoking append.
            appendFileSync(path, JSON.stringify(entry) + "\n");
            return new FileLedger(path).query();
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        },
      );
      if (!cmp.agreement) {
        throw new Error(
          `honest-broker divergence on ${entry.gig_id} at ${cmp.divergence?.path}: ` +
            `primary=${cmp.divergence?.primary} secondary=${cmp.divergence?.secondary} ` +
            `(${cmp.divergence?.reason})`,
        );
      }
      expect(cmp.agreement).toBe(true);
      expect(cmp.primary.length).toBe(1);
      expect(cmp.secondary.length).toBe(1);
    });
  }
});
