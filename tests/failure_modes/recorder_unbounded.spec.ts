// Failure mode: recorder under sustained append load (10K entries).
// Asserts: file size grows linearly, process RSS stays under 200MB, the resulting
// JSONL is fully parseable (no OOM, no truncated entries), total time < 30s.

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

  it("10K appends complete <30s, RSS <200MB, file grows linearly, re-read parses fully", async () => {
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

      // contract 3: RSS growth bounded
      const rssGrowthMb = (endRss - startRss) / 1024 / 1024;
      const endRssMb = endRss / 1024 / 1024;
      expect(
        endRssMb,
        `endRss=${endRssMb.toFixed(1)}MB, growth=${rssGrowthMb.toFixed(1)}MB`,
      ).toBeLessThan(200);

      // contract 4: full re-parse succeeds and returns N entries
      const parsed = parseRecorderJsonl(ledgerPath);
      expect(parsed.length).toBe(N);
      expect(parsed[0]!.gig_id).toBe("load:0");
      expect(parsed[N - 1]!.gig_id).toBe(`load:${N - 1}`);
    } finally {
      env.cleanup();
    }
  }, 60_000);
});
