// Failure mode: two writers race the same agent file via sealAgentDefinition.
//
// REQUIRES (for full GREEN): coltrane currently has no file-locking or typed conflict
// error on concurrent writes to agents/<slug>.json. Last-writer-wins via writeFileSync
// is the de facto behaviour. To make the typed-conflict branch GREEN, coltrane would
// need either (a) atomic write-then-rename + flock-style mutex producing a typed
// ConflictError, or (b) explicit doc + branch that last-writer-wins is by design.
// The current contract this spec enforces is the weaker (and honest) one: whatever
// lands on disk MUST be parseable JSON — no half-written byte corruption.

import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setupTempdirColtrane, type TempdirColtrane } from "../e2e/_harness.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, "..", "..");

// Worker is a tsx-launched script that races to seal a single agent slug.
// Communicates result back via a single JSON line on stdout.
const WORKER_SOURCE = `
import { sealAgentDefinition } from "${REPO_ROOT}/src/genome_writer.ts";
import { FileLedger } from "${REPO_ROOT}/src/ledger.ts";
const [, , genomeDir, slug, ledgerPath, primitive] = process.argv;
try {
  const ledger = new FileLedger(ledgerPath);
  const result = sealAgentDefinition(
    { slug, primitives: [primitive], domain: "concurrent_test" },
    ledger,
    genomeDir,
  );
  process.stdout.write(JSON.stringify({ ok: true, effective_hash: result.effective_hash }) + "\\n");
} catch (e) {
  const err = e as { constructor?: { name: string }; message?: string };
  process.stdout.write(
    JSON.stringify({
      ok: false,
      name: err?.constructor?.name ?? "Error",
      message: err?.message ?? String(e),
    }) + "\\n",
  );
  process.exit(1);
}
`;

interface WorkerResult {
  ok: boolean;
  name?: string;
  message?: string;
  effective_hash?: string;
}

function runWorker(args: string[]): Promise<WorkerResult> {
  return new Promise((resolveP) => {
    const child = spawn("npx", ["tsx", ...args], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString();
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    child.on("close", () => {
      const lastJsonLine = stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .reverse()
        .find((l) => l.startsWith("{"));
      if (!lastJsonLine) {
        resolveP({
          ok: false,
          name: "NoOutput",
          message: `worker stderr: ${stderr.slice(0, 400)}`,
        });
        return;
      }
      try {
        resolveP(JSON.parse(lastJsonLine) as WorkerResult);
      } catch {
        resolveP({
          ok: false,
          name: "UnparseableOutput",
          message: lastJsonLine.slice(0, 200),
        });
      }
    });
  });
}

describe("failure mode: concurrent genome writes to same agent slug", () => {
  let env: TempdirColtrane;

  it("two forks racing the same slug; on-disk JSON parseable; either both succeed or one typed-fails", async () => {
    env = await setupTempdirColtrane();
    try {
      // seed core_types (required for any subsequent load)
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

      const workerPath = join(env.tempDir, "_concurrent_worker.ts");
      writeFileSync(workerPath, WORKER_SOURCE);

      const slug = "racer";
      const ledgerPath = join(env.tempDir, "racer-ledger.jsonl");
      writeFileSync(ledgerPath, "");

      const [r1, r2] = await Promise.all([
        runWorker([workerPath, env.tempDir, slug, ledgerPath, "SENSE"]),
        runWorker([workerPath, env.tempDir, slug, ledgerPath, "INTERPRET"]),
      ]);

      // contract 1: the on-disk file MUST be parseable JSON (no half-written corruption)
      const onDisk = join(env.tempDir, "agents", slug + ".json");
      expect(
        existsSync(onDisk),
        `agent file should exist after at least one writer succeeded. r1=${JSON.stringify(r1)} r2=${JSON.stringify(r2)}`,
      ).toBe(true);
      const raw = readFileSync(onDisk, "utf-8");
      expect(() => JSON.parse(raw)).not.toThrow();
      const parsed = JSON.parse(raw) as { slug: string; primitives: string[] };
      expect(parsed.slug).toBe(slug);

      // contract 2: outcome is one of:
      //   (a) both succeeded (last-writer-wins, documented)
      //   (b) one succeeded and one failed with a TYPED conflict (not generic "Error")
      const failures = [r1, r2].filter((r) => !r.ok);

      if (failures.length > 0) {
        for (const f of failures) {
          // RED-honest line: today, generic "Error" is what surfaces from writeFileSync
          // collisions / unguarded write races. A typed error (ConflictError / WriteError)
          // is what we WANT — this assert fails until coltrane introduces it.
          expect(
            f.name,
            `expected typed conflict error, got ${f.name}: ${f.message}`,
          ).not.toBe("Error");
        }
      } else {
        // both succeeded — last-writer-wins regime; the JSON on disk must match ONE writer.
        expect(["SENSE", "INTERPRET"]).toContain(parsed.primitives[0]);
      }
    } finally {
      env.cleanup();
    }
  }, 60_000);
});
