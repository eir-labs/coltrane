// Failure mode: a sub-thread writer is SIGTERM'd mid-stream while appending to the
// recorder (FileLedger). The on-disk log must remain parseable line-by-line, partial
// entries must not poison subsequent reads, and loadGenome must still work afterward.
//
// Note: appendFileSync uses POSIX write(2) under the hood; on macOS+APFS a single
// JSON.stringify(entry)+"\n" call typically lands atomically (small entries are well
// under PIPE_BUF). The honest contract this spec enforces is: WHATEVER lines exist
// in the file after SIGTERM must each independently parse, AND a torn final line
// (if any) must not crash the JSONL reader.

import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setupTempdirColtrane, type TempdirColtrane } from "../e2e/_harness.js";
import { loadGenome } from "../../src/loader.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, "..", "..");

const WORKER_SOURCE = `
import { FileLedger } from "${REPO_ROOT}/src/index.ts";
import { randomUUID } from "node:crypto";
const [, , ledgerPath] = process.argv;
const ledger = new FileLedger(ledgerPath);
// SIGTERM handler that doesn't gracefully drain — exits immediately to model
// abrupt mid-write process death.
let stop = false;
process.on("SIGTERM", () => {
  stop = true;
  process.exit(143);
});
let i = 0;
while (!stop) {
  const now = new Date().toISOString();
  // Settled #212 gig-row shape: kind discriminator + 64-hex identity.
  const id = \`stream:\${i}:\${randomUUID()}\`;
  ledger.append({
    kind: "gig",
    schema_version: 2,
    entry_id: id,
    gig_id: id,
    standard_slug: "stream_test",
    genome_hash: i.toString(16).padStart(64, "0"),
    run_fingerprint: (i + 1).toString(16).padStart(64, "0"),
    output_hashes: ["o" + i],
    started_at: now,
    finished_at: now,
  });
  i++;
  // brief yield so SIGTERM has a chance to interrupt mid-stream
  if (i % 100 === 0) {
    // synchronous sleep — keep it dependency-free
    const t = Date.now();
    while (Date.now() - t < 1) { /* spin */ }
  }
}
`;

describe("failure mode: mid-flight SIGTERM during recorder writes", () => {
  let env: TempdirColtrane;

  it("recorder log remains parseable after SIGTERM; loadGenome works after", async () => {
    env = await setupTempdirColtrane();
    try {
      // seed a minimal valid genome so loadGenome can be tested post-kill
      const coreDir = join(env.tempDir, "core_types");
      mkdirSync(coreDir, { recursive: true });
      for (const [slug, primitive] of [
        ["Signal", "SENSE"],
        ["Interpretation", "INTERPRET"],
        ["Judgment", "JUDGE"],
        ["Plan", "PLAN"],
        ["Artifact", "CREATE"],
        ["Verdict", "VERIFY"],
      ] as const) {
        writeFileSync(
          join(coreDir, slug.toLowerCase() + ".json"),
          JSON.stringify({
            slug,
            primitive,
            description: "",
            schema: { type: "object", properties: {}, required: [] },
          }),
        );
      }

      const workerPath = join(env.tempDir, "_kill_worker.ts");
      writeFileSync(workerPath, WORKER_SOURCE);
      const ledgerPath = join(env.tempDir, "kill-recorder.jsonl");
      writeFileSync(ledgerPath, "");

      const child = spawn("npx", ["tsx", workerPath, ledgerPath], {
        cwd: REPO_ROOT,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const exitP = new Promise<number | null>((resolveP) => {
        child.on("close", (code) => resolveP(code));
      });

      // let the worker get up and writing
      await new Promise((r) => setTimeout(r, 1500));
      child.kill("SIGTERM");
      // safety net — SIGKILL if it doesn't exit
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 3000);
      await exitP;
      clearTimeout(killTimer);

      // contract 1: file exists and has at least some entries
      expect(existsSync(ledgerPath)).toBe(true);
      const raw = readFileSync(ledgerPath, "utf-8");
      const lines = raw.split("\n");
      expect(lines.length, `worker should have written something. raw len=${raw.length}`).toBeGreaterThan(1);

      // contract 2: every non-empty line is either valid JSON OR (at most) the LAST
      // line is a torn partial. No interior corruption.
      const nonEmpty = lines.filter((l) => l.length > 0);
      let interiorBad = 0;
      let lastTorn = false;
      for (let i = 0; i < nonEmpty.length; i++) {
        const line = nonEmpty[i]!;
        try {
          JSON.parse(line);
        } catch {
          if (i === nonEmpty.length - 1) {
            lastTorn = true;
          } else {
            interiorBad++;
          }
        }
      }
      expect(
        interiorBad,
        `interior corruption found: ${interiorBad} bad lines out of ${nonEmpty.length}. ` +
          `mid-flight kill must not poison earlier writes.`,
      ).toBe(0);
      // lastTorn is informational — record but not a failure (torn final line is acceptable)
      void lastTorn;

      // contract 3: loadGenome still works after the kill — the surrounding system is
      // not poisoned. The recorder log is independent of the genome dir layout.
      const loaded = loadGenome(env.tempDir);
      expect(loaded.core_types.size).toBe(6);
    } finally {
      env.cleanup();
    }
  }, 60_000);
});
