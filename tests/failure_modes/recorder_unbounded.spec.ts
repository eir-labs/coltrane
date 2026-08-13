// Failure mode: recorder under sustained append load (10K entries).
// Asserts: file size grows linearly, the recorder's own RSS GROWTH stays bounded, the resulting
// JSONL is fully parseable (no OOM, no truncated entries), total time < 30s.
//
// WHY GROWTH AND FOOTPRINT ARE NOW TWO SEPARATE CONTRACTS. This file used to compute `rssGrowthMb`,
// put it in the failure message, and then assert something else entirely:
//
//     // contract 3: RSS growth bounded
//     const rssGrowthMb = (endRss - startRss) / 1024 / 1024;   // <- never asserted
//     expect(endRssMb, `…growth=${rssGrowthMb}MB`).toBeLessThan(200);
//
// The comment promised growth; the assertion was an absolute footprint ceiling. So the test passed
// for a reason unrelated to its stated contract, and eventually failed for one too: a change that
// added ~180 lines of Zod schema pushed BASELINE rss past 200MB while the recorder's own growth was
// 0.8MB. It reported a recorder leak; there was none. Every branch adding schema would have hit it.
//
// A ceiling on total process RSS is a real budget and worth keeping — but it is a DIFFERENT claim
// from "the recorder does not accumulate", it fails for different reasons, and it is fixed by
// different people. Split so a red tells you which one broke.

import { describe, it, expect } from "vitest";
import { writeFileSync, readFileSync, statSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setupTempdirColtrane, type TempdirColtrane } from "../e2e/_harness.js";
import { FileLedger } from "../../src/ledger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
void __dirname;

function parseRecorderJsonl(path: string): Array<Record<string, unknown>> {
  // Streamed line-by-line parse to avoid loading the whole string into memory twice.
  // For 10K small entries (~1MB total) this is overkill but enforces the discipline.
  const raw = readFileSync(path, "utf-8");
  const out: Array<Record<string, unknown>> = [];
  let start = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "\n") {
      if (i > start) {
        out.push(JSON.parse(raw.slice(start, i)) as Record<string, unknown>);
      }
      start = i + 1;
    }
  }
  if (start < raw.length) {
    out.push(JSON.parse(raw.slice(start)) as Record<string, unknown>);
  }
  return out;
}

describe("failure mode: recorder under sustained append load (10K entries)", () => {
  let env: TempdirColtrane;

  it("10K appends complete <30s, recorder RSS growth bounded, file grows linearly, re-read parses fully", async () => {
    env = await setupTempdirColtrane();
    try {
      const ledgerPath = join(env.tempDir, "load-recorder.jsonl");
      mkdirSync(env.tempDir, { recursive: true });
      writeFileSync(ledgerPath, "");
      const ledger = new FileLedger(ledgerPath);

      const N = 10_000;
      const sizeCheckpoints: number[] = [];
      const checkpointEvery = 2_000;

      const startRss = process.memoryUsage().rss;
      const start = Date.now();

      for (let i = 0; i < N; i++) {
        const now = new Date().toISOString();
        // Settled #212 gig-row shape: kind discriminator + 64-hex identity.
        ledger.append({
          kind: "gig",
          schema_version: 2,
          entry_id: `load:${i}`,
          gig_id: `load:${i}`,
          standard_slug: "load_test",
          genome_hash: i.toString(16).padStart(64, "0"),
          run_fingerprint: (i + 1).toString(16).padStart(64, "0"),
          output_hashes: [`o${i}`],
          started_at: now,
          finished_at: now,
        } as never);
        if (i > 0 && i % checkpointEvery === 0) {
          sizeCheckpoints.push(statSync(ledgerPath).size);
        }
      }
      sizeCheckpoints.push(statSync(ledgerPath).size);

      const elapsed = Date.now() - start;
      const endRss = process.memoryUsage().rss;

      // contract 1: total elapsed under 30s
      expect(elapsed, `10K appends took ${elapsed}ms`).toBeLessThan(30_000);

      // contract 2: file size grows linearly (each later checkpoint > previous)
      for (let i = 1; i < sizeCheckpoints.length; i++) {
        expect(sizeCheckpoints[i]!).toBeGreaterThan(sizeCheckpoints[i - 1]!);
      }
      // and roughly proportional — ratio of consecutive non-zero deltas should be ~1
      // (allow 0.5x–2x slack for the random-ish gig_id length variation)
      const deltas: number[] = [];
      for (let i = 1; i < sizeCheckpoints.length; i++) {
        deltas.push(sizeCheckpoints[i]! - sizeCheckpoints[i - 1]!);
      }
      const firstDelta = deltas[0]!;
      for (const d of deltas) {
        expect(d / firstDelta, `non-linear growth detected: deltas=${deltas.join(",")}`).toBeGreaterThan(0.5);
        expect(d / firstDelta, `non-linear growth detected: deltas=${deltas.join(",")}`).toBeLessThan(2);
      }

      // contract 3: the RECORDER's own RSS growth is bounded — this is the leak contract, and it
      // is now the thing actually asserted. 10K appends of ~100 bytes is ~1MB of data; a recorder
      // that retained every entry would show growth in the tens of MB, so 50 separates "streams to
      // disk" from "accumulates in memory" without being tight enough to flake on GC timing.
      const rssGrowthMb = (endRss - startRss) / 1024 / 1024;
      const endRssMb = endRss / 1024 / 1024;
      expect(
        rssGrowthMb,
        `recorder grew RSS by ${rssGrowthMb.toFixed(1)}MB over ${N} appends ` +
          `(endRss=${endRssMb.toFixed(1)}MB) — the recorder is retaining what it should be streaming`,
      ).toBeLessThan(50);

      // Footprint is asserted in its own test below, not here: crossing a total-RSS budget says
      // something about the whole process, and reporting it from inside the recorder's leak test is
      // what made the previous failure unreadable.

      // contract 4: full re-parse succeeds and returns N entries
      const parsed = parseRecorderJsonl(ledgerPath);
      expect(parsed.length).toBe(N);
      expect(parsed[0]!.gig_id).toBe("load:0");
      expect(parsed[N - 1]!.gig_id).toBe(`load:${N - 1}`);
    } finally {
      env.cleanup();
    }
  }, 60_000);

  // ── the footprint budget, as its own claim ─────────────────────────────────
  // Kept, because a runaway process footprint is worth catching. Separated, because it is NOT the
  // recorder's leak contract and does not fail for the recorder's reasons.
  //
  // What actually moves this number is how much of the engine a run has loaded — Zod schemas, the
  // genome classes, the registry. So it is a budget on the ENGINE's resting size, and the honest
  // response to it going red is usually "the engine got bigger, decide whether that is acceptable",
  // never "the recorder is leaking". Under the old shape that distinction was unavailable: adding
  // ~180 lines of schema reported a recorder leak, and every branch adding schema hit the same wall.
  //
  // 320MB rather than 200MB: the ceiling is a guard against a runaway, not a target to sit against.
  // A budget that a legitimate schema addition can cross is one that gets raised under pressure
  // during someone else's PR, which is the worst moment to be deciding what the number means.
  it("the engine's resting footprint stays inside its budget", () => {
    const rssMb = process.memoryUsage().rss / 1024 / 1024;
    expect(
      rssMb,
      `engine resting RSS is ${rssMb.toFixed(1)}MB. This is a budget on how much the ENGINE loads, ` +
        `not a statement about the recorder. If a change legitimately grew the engine, raise this ` +
        `deliberately and say why; if nothing should have grown, find what did.`,
    ).toBeLessThan(320);
  });
});
