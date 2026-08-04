// RED — issue #211 (FileLedger.query has no per-line guard) and
//       issue #214 (MemoryLedger returns live entry references).
//
// Both are "the audit trail does not hold the property it advertises" defects, and both
// bite precisely when FileLedger becomes the bootstrap default (#209).
//
// #211 design note carried from the issue: outputs.ts's silent-skip is the WRONG remedy
// for a ledger. Silently dropping a row lets corruption hide an entry. The contract is
// SKIP AND REPORT — surface the corrupt-line count/offsets rather than swallowing them.
// The regression guard below is what stops the fix from being a copy of outputs.ts:180-184.

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileLedger, MemoryLedger, type Ledger } from "../src/ledger.js";

const GENOME_HASH = "a".repeat(64);
const RUN_FP = "b".repeat(64);

type Row = Record<string, unknown>;

function gigRow(over: Row = {}): Row {
  return {
    kind: "gig",
    schema_version: 2,
    entry_id: "g1",
    gig_id: "g1",
    standard_slug: "readiness-scan",
    genome_hash: GENOME_HASH,
    run_fingerprint: RUN_FP,
    output_hashes: ["oh1"],
    started_at: "2026-05-25T20:00:00.000Z",
    finished_at: "2026-05-25T20:01:00.000Z",
    ...over,
  };
}

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "ledger-integrity-"));
}

/** Write N intact rows, then a torn (truncated) final line — the exact residue that
 *  appendFileSync-without-fsync (src/ledger.ts:60) leaves after a crash, and the shape
 *  tests/failure_modes/midflight_kill.spec.ts:5-9 already concedes is expected. */
function seedWithTornTail(path: string, intact: number): void {
  let text = "";
  for (let i = 0; i < intact; i++) {
    text += JSON.stringify(gigRow({ entry_id: `g${i}`, gig_id: `g${i}` })) + "\n";
  }
  const torn = JSON.stringify(gigRow({ entry_id: "torn", gig_id: "torn" }));
  text += torn.slice(0, Math.floor(torn.length / 2)); // no trailing newline — truncated mid-write
  writeFileSync(path, text);
}


/** Query, converting today's hard throw into an explanatory failure rather than a bare
 *  `SyntaxError: Unterminated string in JSON`. The throw IS the defect (#211): src/ledger.ts:79
 *  calls JSON.parse with no per-line guard, so one damaged byte takes the whole audit trail
 *  offline. Without this wrapper the red would read as an incidental parse crash. */
function queryOrExplain(l: { query: (f?: never) => unknown[] }, what: string): Row[] {
  try {
    return l.query() as unknown as Row[];
  } catch (e) {
    expect.fail(
      `${what}: FileLedger.query threw "${(e as Error).message}" instead of returning the ` +
        "intact rows. src/ledger.ts:74-88 has no per-line guard, so a single corrupt line " +
        "takes execution_history_read, gig_monitor's fallback, gig_abort, learning_synthesize " +
        "and health_check offline permanently. src/outputs.ts:173-187 already does this " +
        "correctly one file over.",
    );
  }
}

// ────────────────────────────────────────────────────────────────────────────
// #211 — a torn line must not take the whole audit trail offline
// ────────────────────────────────────────────────────────────────────────────
describe("#211 — FileLedger.query survives a corrupt line", () => {
  it("does not throw when the final line is torn", () => {
    const dir = freshDir();
    try {
      const path = join(dir, "ledger.jsonl");
      seedWithTornTail(path, 3);
      const l = new FileLedger(path);
      expect(
        () => l.query(),
        "FileLedger.query threw on a torn final line. src/ledger.ts:79 calls JSON.parse with " +
          "no per-line guard, so one bad byte takes execution_history_read, gig_monitor's " +
          "fallback, gig_abort, learning_synthesize and health_check offline permanently. " +
          "src/outputs.ts:173-187 already does this correctly one file over.",
      ).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns exactly the intact rows (no row silently lost, none invented)", () => {
    const dir = freshDir();
    try {
      const path = join(dir, "ledger.jsonl");
      seedWithTornTail(path, 3);
      const rows = queryOrExplain(new FileLedger(path), "torn tail");
      expect(
        rows.length,
        "the 3 rows written before the tear must all still be readable",
      ).toBe(3);
      expect(rows.map((r) => r["gig_id"])).toEqual(["g0", "g1", "g2"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("survives interior corruption, not just a torn tail", () => {
    const dir = freshDir();
    try {
      const path = join(dir, "ledger.jsonl");
      writeFileSync(
        path,
        JSON.stringify(gigRow({ entry_id: "a", gig_id: "a" })) + "\n" +
          "{not json at all\n" +
          JSON.stringify(gigRow({ entry_id: "b", gig_id: "b" })) + "\n",
      );
      const rows = queryOrExplain(new FileLedger(path), "interior corruption");
      expect(
        rows.map((r) => r["gig_id"]),
        "a corrupt INTERIOR line must not hide the rows after it",
      ).toEqual(["a", "b"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tolerates a whitespace-only line (the .length>0 vs .trim() gap)", () => {
    const dir = freshDir();
    try {
      const path = join(dir, "ledger.jsonl");
      writeFileSync(
        path,
        JSON.stringify(gigRow({ entry_id: "a", gig_id: "a" })) + "\n" + "   \n" +
          JSON.stringify(gigRow({ entry_id: "b", gig_id: "b" })) + "\n",
      );
      const rows = queryOrExplain(new FileLedger(path), "whitespace-only line");
      expect(
        rows.length,
        "src/ledger.ts:76 filters on `l.length > 0`, not `.trim()` (contrast " +
          "src/outputs.ts:178) — a whitespace-only line reaches JSON.parse and throws",
      ).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("GUARD (green today) — tolerates CRLF line endings", () => {
    const dir = freshDir();
    try {
      const path = join(dir, "ledger.jsonl");
      writeFileSync(
        path,
        JSON.stringify(gigRow({ entry_id: "a", gig_id: "a" })) + "\r\n" +
          JSON.stringify(gigRow({ entry_id: "b", gig_id: "b" })) + "\r\n",
      );
      const rows = queryOrExplain(new FileLedger(path), "CRLF line endings");
      expect(rows.length, "a lone \\r is length 1 and reaches JSON.parse").toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a JSON-valid but non-object line does not become a fake entry", () => {
    const dir = freshDir();
    try {
      const path = join(dir, "ledger.jsonl");
      writeFileSync(
        path,
        JSON.stringify(gigRow({ entry_id: "a", gig_id: "a" })) + "\n42\nnull\n",
      );
      const rows = queryOrExplain(new FileLedger(path), "non-object JSON line");
      expect(
        rows.length,
        "src/ledger.ts:79 is an unchecked cast (`JSON.parse(line) as LedgerEntry`). " +
          "`42` parses fine, passes every filter, and is returned to execution_history_read " +
          "as an 'execution'; `null` throws a TypeError on e.gig_id.",
      ).toBe(1);
      expect(rows[0]!["gig_id"]).toBe("a");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#211 — corruption is REPORTED, never silently swallowed", () => {
  // Implementation-shape decision flagged in the hand-off report: the issue mandates
  // "skip and report — surface the corrupt-line count/offsets" but does not name the
  // surface. `integrity()` is this test's choice. If the implementer picks a different
  // surface the NAME here may change; the assertion must not.
  it("FileLedger exposes an integrity report", async () => {
    const dir = freshDir();
    try {
      const path = join(dir, "ledger.jsonl");
      seedWithTornTail(path, 3);
      const l = new FileLedger(path) as unknown as Record<string, unknown>;
      expect(
        typeof l["integrity"],
        "no way to learn that the ledger is damaged. A silent skip (the outputs.ts:180-184 " +
          "shape) is the WRONG fix for an audit trail: it lets a single corrupted byte " +
          "delete a row with no trace. Skip-and-report is the contract.",
      ).toBe("function");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the integrity report counts and locates the corrupt lines", async () => {
    const dir = freshDir();
    try {
      const path = join(dir, "ledger.jsonl");
      seedWithTornTail(path, 3);
      const l = new FileLedger(path) as unknown as {
        integrity?: () => { ok: boolean; corrupt: Array<{ line_no: number }> };
      };
      expect(typeof l.integrity, "integrity() not implemented — see preceding test").toBe("function");
      const report = l.integrity!();
      expect(report.ok, "a ledger with a torn line must not report ok:true").toBe(false);
      expect(report.corrupt.length, "the one torn line must be reported").toBe(1);
      expect(
        report.corrupt[0]!.line_no,
        "the report must locate the damage (line 4 — after the 3 intact rows)",
      ).toBe(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an intact ledger reports ok with zero corrupt lines", () => {
    const dir = freshDir();
    try {
      const path = join(dir, "ledger.jsonl");
      const l = new FileLedger(path);
      l.append(gigRow() as never);
      const probe = l as unknown as { integrity?: () => { ok: boolean; corrupt: unknown[] } };
      expect(typeof probe.integrity).toBe("function");
      const report = probe.integrity!();
      expect(report.ok, "a healthy ledger must report ok:true").toBe(true);
      expect(report.corrupt.length).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#211 — count() and query() agree on a damaged file", () => {
  it("count() does not count a corrupt line as an entry", () => {
    const dir = freshDir();
    try {
      const path = join(dir, "ledger.jsonl");
      seedWithTornTail(path, 3);
      const l = new FileLedger(path);
      expect(
        l.count(),
        "src/ledger.ts:90-95 counts non-empty LINES without parsing, so count() reports a " +
          "healthy gig total for a ledger execution_history_read cannot even open. " +
          "count() must agree with query().length.",
      ).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("count() === query().length on a damaged file", () => {
    const dir = freshDir();
    try {
      const path = join(dir, "ledger.jsonl");
      seedWithTornTail(path, 5);
      const l = new FileLedger(path);
      const q = queryOrExplain(l, "count/query agreement").length;
      expect(l.count(), `count()=${l.count()} but query().length=${q}`).toBe(q);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reading a damaged ledger does not repair or truncate the file", () => {
    const dir = freshDir();
    try {
      const path = join(dir, "ledger.jsonl");
      seedWithTornTail(path, 3);
      const before = readFileSync(path, "utf-8");
      const l = new FileLedger(path);
      queryOrExplain(l, "read-does-not-repair");
      l.count();
      expect(
        readFileSync(path, "utf-8"),
        "skipping a corrupt line must not rewrite the file — an append-only ledger that " +
          "silently self-heals is indistinguishable from one that was tampered with",
      ).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// #214 — append-only must mean immutable, in BOTH implementations
// ────────────────────────────────────────────────────────────────────────────
const IMPLS: Array<[string, (dir: string) => Ledger]> = [
  ["MemoryLedger", () => new MemoryLedger()],
  ["FileLedger", (dir: string) => new FileLedger(join(dir, "ledger.jsonl"))],
];

describe.each(IMPLS)("#214 — %s honors append-only immutability", (name, make) => {
  it("mutating the caller's object AFTER append does not change the sealed row", () => {
    const dir = freshDir();
    try {
      const l = make(dir);
      const entry = gigRow() as never as { genome_hash: string };
      l.append(entry as never);
      entry.genome_hash = "f".repeat(64); // caller mutates its own object afterwards

      const [row] = l.query() as unknown as Row[];
      expect(
        row!["genome_hash"],
        `${name} stored the CALLER's object by reference (src/ledger.ts:105), so a caller ` +
          "that reuses or mutates an entry after append() silently rewrites sealed history",
      ).toBe(GENOME_HASH);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("mutating a row returned by query() does not change the ledger", () => {
    const dir = freshDir();
    try {
      const l = make(dir);
      l.append(gigRow() as never);

      const first = l.query() as unknown as Row[];
      first[0]!["genome_hash"] = "forged";

      const second = l.query() as unknown as Row[];
      expect(
        second[0]!["genome_hash"],
        `${name}.query() handed back live references (src/ledger.ts:109), so ` +
          "`ledger.query()[0].genome_hash = \"forged\"` rewrites history in place. " +
          "tests/ledger.test.ts:20-38 claims to verify append-only-ness but only checks " +
          "that no method NAMED update/delete/remove exists — it passes against a freely " +
          "mutable ledger.",
      ).toBe(GENOME_HASH);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the output_hashes array is not aliased with the caller's", () => {
    const dir = freshDir();
    try {
      const l = make(dir);
      const hashes = ["oh1"];
      l.append(gigRow({ output_hashes: hashes }) as never);
      hashes.push("smuggled-in-after-seal");

      const [row] = l.query() as unknown as Row[];
      expect(
        (row!["output_hashes"] as string[]).length,
        `${name} aliased the caller's array. \`output_hashes: readonly string[]\` ` +
          "(src/ledger.ts:21) is compile-time only; src/runtime.ts:762 builds that array and " +
          "keeps a live handle on it after sealing.",
      ).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("two query() calls return independent objects", () => {
    const dir = freshDir();
    try {
      const l = make(dir);
      l.append(gigRow() as never);
      const a = l.query() as unknown as Row[];
      const b = l.query() as unknown as Row[];
      expect(
        a[0] === b[0],
        `${name} returned the same object identity from two independent query() calls — ` +
          "a mutation through one read corrupts every other reader",
      ).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
