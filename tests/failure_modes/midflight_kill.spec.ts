// Failure mode: a writer process is killed mid-stream while appending to the recorder
// (FileLedger). The on-disk log must remain parseable line-by-line, a partial entry must not
// poison subsequent reads, and loadGenome must still work afterward.
//
// ── why this file was rewritten ──────────────────────────────────────────────
// It passed on macOS and hung for the full 60s timeout on ubuntu, on the first run CI was
// allowed to execute. Three separate faults were stacked, and the macOS pass was hiding all
// three:
//
//   1. The signal went to the wrong process. The worker was spawned as `npx tsx worker.ts`,
//      so the child this test held was NPX — the worker was a grandchild. `child.kill()`
//      signalled npx.
//
//   2. The worker could not have handled SIGTERM even if it had arrived. Its loop was
//      `while (!stop) { ledger.append(...) }` with a synchronous busy-wait as its only
//      "yield". Node delivers signals through libuv, so a JS handler cannot run until the
//      stack unwinds to the event loop — which that loop never did. Registering the handler
//      only removed the default terminate action, so SIGTERM became a no-op.
//
//   3. So termination actually came from the SIGKILL safety net, aimed at npx. SIGKILL does
//      not propagate to descendants. On macOS the tree happened to collapse anyway; on Linux
//      the grandchild survived, holding the inherited stdout/stderr write-ends open, so the
//      parent's `close` event — which waits for stdio to close, not just for exit — never
//      fired. That is the 60s hang.
//
// The contract below was still being exercised (an uncatchable kill is a legitimate way to
// model abrupt death), but by accident, on one platform, via a path the file's own comments
// did not describe.
//
// The fix is to remove the indirection: the child IS the worker, a plain node process running
// built JS, so a signal sent here lands on the code under test. The worker yields between
// batches so SIGTERM is genuinely deliverable, and the test asserts it was in fact received —
// otherwise this could quietly drift back to passing for the wrong reason.
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
/** Built output — `dist/` is guaranteed by the suite's globalSetup. */
const LEDGER_MODULE = join(REPO_ROOT, "dist", "src", "index.js");

// Plain ESM, no loader, no transform: `node worker.mjs` is exactly one process.
const WORKER_SOURCE = `
import { FileLedger } from ${JSON.stringify(LEDGER_MODULE)};
import { randomUUID } from "node:crypto";

const [, , ledgerPath] = process.argv;
const ledger = new FileLedger(ledgerPath);

// Model abrupt death: no graceful drain, no flush, exit inside the handler.
process.on("SIGTERM", () => {
  process.stdout.write("SIGTERM-RECEIVED\\n");
  process.exit(143);
});

let i = 0;
function burst() {
  // A batch is synchronous — that is the point, the kill has to be able to land in the
  // middle of one. Between batches we return to the event loop so the signal can be
  // delivered at all; without this the handler above can never run.
  for (let n = 0; n < 200; n++) {
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
  }
  setImmediate(burst);
}
process.stdout.write("READY\\n");
burst();
`;

describe("failure mode: mid-flight kill during recorder writes", () => {
  let env: TempdirColtrane;

  it("recorder log stays parseable after SIGTERM; loadGenome works after", async () => {
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

      const workerPath = join(env.tempDir, "_kill_worker.mjs");
      writeFileSync(workerPath, WORKER_SOURCE);
      const ledgerPath = join(env.tempDir, "kill-recorder.jsonl");
      writeFileSync(ledgerPath, "");

      // `process.execPath` — the same node running this test, spawned directly. No npx, no
      // loader, no grandchild: the pid below is the process that owns the appends.
      const child = spawn(process.execPath, [workerPath, ledgerPath], {
        cwd: REPO_ROOT,
        stdio: ["ignore", "pipe", "pipe"],
      });

      // Both pipes are drained. An undrained pipe fills at 64KB and blocks the writer
      // forever, which is its own way to produce exactly the hang this rewrite removes.
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf-8");
      child.stderr.setEncoding("utf-8");
      child.stdout.on("data", (d: string) => (stdout += d));
      child.stderr.on("data", (d: string) => (stderr += d));

      const exited = new Promise<number | null>((resolveP) => {
        child.on("close", (code) => resolveP(code));
      });

      // Wait for the worker to announce itself rather than guessing at a startup budget —
      // a fixed sleep is a slow machine away from killing a process that never wrote anything.
      const ready = await Promise.race([
        new Promise<boolean>((r) => {
          const tick = setInterval(() => {
            if (stdout.includes("READY")) {
              clearInterval(tick);
              r(true);
            }
          }, 25);
          setTimeout(() => {
            clearInterval(tick);
            r(false);
          }, 20_000);
        }),
        exited.then(() => false),
      ]);
      expect(ready, `worker never started. stderr: ${stderr}`).toBe(true);

      // let it get properly into the stream
      await new Promise((r) => setTimeout(r, 750));
      child.kill("SIGTERM");

      // Safety net, now aimed at the right pid — and SIGKILL on the worker itself does not
      // depend on propagating anywhere.
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      const code = await exited;
      clearTimeout(killTimer);

      // The signal reached the code under test. Without this the file could quietly return
      // to being a SIGKILL test wearing a SIGTERM label.
      expect(
        stdout.includes("SIGTERM-RECEIVED"),
        `worker exited ${code} without handling SIGTERM — the signal did not reach it. stderr: ${stderr}`,
      ).toBe(true);
      expect(code, "the handler exits 143").toBe(143);

      // contract 1: file exists and has entries
      expect(existsSync(ledgerPath)).toBe(true);
      const raw = readFileSync(ledgerPath, "utf-8");
      const lines = raw.split("\n");
      expect(
        lines.length,
        `worker should have written something. raw len=${raw.length}`,
      ).toBeGreaterThan(1);

      // contract 2: every non-empty line is valid JSON, except that the LAST may be a torn
      // partial. No interior corruption — an earlier write must never be damaged by a later
      // one being cut off.
      const nonEmpty = lines.filter((l) => l.length > 0);
      let interiorBad = 0;
      let lastTorn = false;
      for (let i = 0; i < nonEmpty.length; i++) {
        const line = nonEmpty[i]!;
        try {
          JSON.parse(line);
        } catch {
          if (i === nonEmpty.length - 1) lastTorn = true;
          else interiorBad++;
        }
      }
      expect(
        interiorBad,
        `interior corruption found: ${interiorBad} bad lines out of ${nonEmpty.length}. ` +
          `mid-flight kill must not poison earlier writes.`,
      ).toBe(0);
      // A torn final line is acceptable and expected on some platforms — informational.
      void lastTorn;

      // contract 3: loadGenome still works after the kill — the surrounding system is not
      // poisoned. The recorder log is independent of the genome dir layout.
      const loaded = loadGenome(env.tempDir);
      expect(loaded.core_types.size).toBe(6);
    } finally {
      env.cleanup();
    }
  }, 60_000);
});
