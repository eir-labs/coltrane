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
import { FileLedger, type GigLedgerEntry, type LedgerEntry } from "../../src/ledger.js";
import { compareHonestBroker } from "../../src/test_honest_broker.js";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "honest-broker-recorder-"));
}

// #212 fixture migration. Three changes, none of which alter what this file asserts (the
// append/read contract: one JSON object per line, no normalisation):
//   1. `kind`/`schema_version`/`entry_id` added — the discriminated-union shape.
//   2. Identity fields are now 64 lowercase hex, the shape sha256Hex/runFingerprint actually
//      emit and the shared validator enforces. `gh-001`-style placeholders were only ever
//      accepted because the old guard (src/ledger.ts:56-58) tested non-emptiness.
//   3. Timestamps gained millisecond precision across all five entries ("…:00Z" → "…:00.000Z"),
//      matching `new Date().toISOString()` — the form every real writer produces
//      (src/runtime.ts:787, src/genome_writer.ts:73) and the form an ISO-8601 validator will
//      round-trip. The honest-broker comparison is over parsed values, so precision is not
//      itself under test; this only keeps the fixtures writable once validation lands.
// Unicode round-trip safety (entry 4) is preserved on the fields that remain free-form:
// gig_id, entry_id, standard_slug and output_hashes all still carry non-ASCII.
const hex = (nibble: string): string => nibble.repeat(64);

// Five representative entry shapes covering the gig-row surface. Typed as GigLedgerEntry
// (not the LedgerEntry union) so `entry.gig_id` resolves — every row here is kind:"gig".
const battery: readonly GigLedgerEntry[] = ([
  // 1. minimal — every required field, single output hash.
  {
    kind: "gig", schema_version: 2, entry_id: "gig-001",
    gig_id: "gig-001",
    standard_slug: "scan",
    genome_hash: hex("1"),
    run_fingerprint: hex("a"),
    output_hashes: ["oh-001"],
    started_at: "2026-01-01T00:00:00.000Z",
    finished_at: "2026-01-01T00:00:05.000Z",
  },
  // 2. multiple output hashes — typical multi-phase gig.
  {
    kind: "gig", schema_version: 2, entry_id: "gig-002",
    gig_id: "gig-002",
    standard_slug: "scan-and-fix",
    genome_hash: hex("2"),
    run_fingerprint: hex("b"),
    output_hashes: ["oh-002-a", "oh-002-b", "oh-002-c"],
    started_at: "2026-02-01T12:00:00.000Z",
    finished_at: "2026-02-01T12:01:30.000Z",
  },
  // 3. empty output_hashes — edge case, no outputs produced.
  {
    kind: "gig", schema_version: 2, entry_id: "gig-003",
    gig_id: "gig-003",
    standard_slug: "noop",
    genome_hash: hex("3"),
    run_fingerprint: hex("c"),
    output_hashes: [],
    started_at: "2026-03-01T00:00:00.000Z",
    finished_at: "2026-03-01T00:00:00.000Z",
  },
  // 4. unicode + special chars in the free-form fields — round-trip safety.
  {
    kind: "gig", schema_version: 2, entry_id: "gig-004-α",
    gig_id: "gig-004-α",
    standard_slug: "scan/with-slash",
    genome_hash: hex("4"),
    run_fingerprint: hex("d"),
    output_hashes: ["oh-004:colon", "oh-004-emoji-🎷"],
    started_at: "2026-04-01T00:00:00.000Z",
    finished_at: "2026-04-01T00:00:01.000Z",
  },
  // 5. long hash list — stress the line length.
  {
    kind: "gig", schema_version: 2, entry_id: "gig-005",
    gig_id: "gig-005",
    standard_slug: "wide-fanout",
    genome_hash: hex("5"),
    run_fingerprint: hex("e"),
    output_hashes: Array.from({ length: 20 }, (_, i) => `oh-005-${i.toString().padStart(3, "0")}`),
    started_at: "2026-05-01T00:00:00.000Z",
    finished_at: "2026-05-01T00:00:10.000Z",
  },
] as unknown) as readonly GigLedgerEntry[];

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
