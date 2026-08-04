import { describe, it, expect } from "vitest";
import { MemoryLedger, FileLedger, LedgerError, type LedgerEntry } from "../src";
import { join } from "node:path";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// Identity values are 64 lowercase hex — the shape sha256Hex/effectiveHash/runFingerprint
// actually produce (src/canonical_form.ts:29-31, :93-113, :130-132) and the shape the
// shared validator enforces once #212 lands. The previous "gh1"/"rf1" placeholders were
// the same blind spot that let 7 call sites write "n/a".
const HEX = (seed: string): string => seed.repeat(64).slice(0, 64);

function entry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  const row: Record<string, unknown> = {
    kind: "gig",
    schema_version: 2,
    gig_id: "g1",
    standard_slug: "readiness-scan",
    genome_hash: HEX("a"),
    run_fingerprint: HEX("b"),
    output_hashes: ["oh1"],
    started_at: "2026-05-25T20:00:00.000Z",
    finished_at: "2026-05-25T20:01:00.000Z",
    ...overrides,
  };
  row["entry_id"] ??= row["gig_id"];
  return row as unknown as LedgerEntry;
}

describe("ledger: append-only", () => {
  it("MemoryLedger exposes no update or delete methods", () => {
    const l = new MemoryLedger();
    const api = l as unknown as Record<string, unknown>;
    expect(api.update).toBeUndefined();
    expect(api.delete).toBeUndefined();
    expect(api.remove).toBeUndefined();
  });

  it("FileLedger exposes no update or delete methods", () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-"));
    const l = new FileLedger(join(dir, "ledger.jsonl"));
    const api = l as unknown as Record<string, unknown>;
    expect(api.update).toBeUndefined();
    expect(api.delete).toBeUndefined();
    expect(api.remove).toBeUndefined();
    rmSync(dir, { recursive: true });
  });
});

describe("MemoryLedger: append + query", () => {
  it("appends and counts", () => {
    const l = new MemoryLedger();
    expect(l.count()).toBe(0);
    l.append(entry());
    l.append(entry({ gig_id: "g2" }));
    expect(l.count()).toBe(2);
  });

  it("rejects entry missing required keys", () => {
    const l = new MemoryLedger();
    expect(() => l.append(entry({ gig_id: "" }))).toThrow(LedgerError);
    expect(() => l.append(entry({ genome_hash: "" }))).toThrow(LedgerError);
    expect(() => l.append(entry({ run_fingerprint: "" }))).toThrow(LedgerError);
  });

  it("queries by gig_id", () => {
    const l = new MemoryLedger();
    l.append(entry({ gig_id: "g1" }));
    l.append(entry({ gig_id: "g2" }));
    expect(l.query({ gig_id: "g1" }).length).toBe(1);
    expect(l.query({ gig_id: "g2" }).length).toBe(1);
  });

  it("queries by standard_slug + genome_hash", () => {
    const l = new MemoryLedger();
    l.append(entry({ standard_slug: "scan", genome_hash: HEX("1") }));
    l.append(entry({ standard_slug: "fix",  genome_hash: HEX("2") }));
    expect(l.query({ standard_slug: "scan" }).length).toBe(1);
    expect(l.query({ genome_hash: HEX("2") }).length).toBe(1);
  });

  it("queries by time range", () => {
    const l = new MemoryLedger();
    l.append(entry({ started_at: "2026-05-25T19:00:00Z" }));
    l.append(entry({ started_at: "2026-05-25T20:00:00Z" }));
    l.append(entry({ started_at: "2026-05-25T21:00:00Z" }));
    expect(l.query({ after: "2026-05-25T19:30:00Z" }).length).toBe(2);
    expect(l.query({ before: "2026-05-25T20:30:00Z" }).length).toBe(2);
    expect(
      l.query({ after: "2026-05-25T19:30:00Z", before: "2026-05-25T20:30:00Z" }).length,
    ).toBe(1);
  });
});

describe("FileLedger: persistence across instances", () => {
  it("entries persist across new FileLedger instances on the same path", () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-"));
    const path = join(dir, "ledger.jsonl");

    const writer = new FileLedger(path);
    writer.append(entry({ gig_id: "g1" }));
    writer.append(entry({ gig_id: "g2" }));

    const reader = new FileLedger(path);
    expect(reader.count()).toBe(2);
    expect(reader.query({ gig_id: "g1" }).length).toBe(1);

    rmSync(dir, { recursive: true });
  });
});
