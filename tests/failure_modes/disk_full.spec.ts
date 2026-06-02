// Failure mode: recorder append against a read-only parent dir (simulates disk-full /
// EACCES / mounted-RO scenarios). Asserts the failure surfaces as a TYPED
// RecorderWriteError (or LedgerError subclass) — NOT a raw ENOENT/EACCES bubble.
//
// REQUIRES (for GREEN): coltrane has no RecorderWriteError type today. FileLedger.append
// calls appendFileSync which throws a raw NodeJS.SystemError with code "EACCES" / "EPERM"
// / "EROFS". The MCP server path that wraps recorder writes does NOT currently catch +
// wrap these into a structured error response — a crash in the writer would propagate
// up to the JSON-RPC handler.
//
// To make this spec GREEN, coltrane needs:
//   1) A RecorderWriteError class (or LedgerError variant) thrown by FileLedger.append
//      that wraps the underlying SystemError and is tagged with .cause + .code.
//   2) MCP server tool handlers that catch RecorderWriteError and return a structured
//      tool-error response without crashing the process.
//   3) Idempotent retry semantics: once the dir becomes writable again, the next
//      append must succeed without process restart.

import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync, chmodSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setupTempdirColtrane, type TempdirColtrane } from "../e2e/_harness.js";
import { FileLedger } from "../../src/ledger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
void __dirname;

const SAMPLE_ENTRY = {
  gig_id: "ro:1",
  standard_slug: "ro_test",
  genome_hash: "h",
  run_fingerprint: "r",
  output_hashes: ["o"],
  started_at: "2026-01-01T00:00:00Z",
  finished_at: "2026-01-01T00:00:00Z",
};

describe("failure mode: recorder write to read-only directory", () => {
  let env: TempdirColtrane;

  it("append to ledger in chmod-0444 dir surfaces a TYPED error (not raw EACCES)", async () => {
    env = await setupTempdirColtrane();
    let lockedDir: string | null = null;
    try {
      // create a dedicated dir, drop the ledger into it, then lock parent RO.
      lockedDir = join(env.tempDir, "locked_recorder_dir");
      mkdirSync(lockedDir, { recursive: true });
      const ledgerPath = join(lockedDir, "recorder.jsonl");
      writeFileSync(ledgerPath, "");
      // chmod 0444 — read-only. appendFileSync to an existing file inside an RO dir
      // fails with EACCES on macOS (file open for write requires dir-write on some FS
      // ops; on others the existing fd works. We chmod the FILE too to force EACCES.)
      chmodSync(ledgerPath, 0o444);
      chmodSync(lockedDir, 0o555);

      // Skip-condition: if running as root, the chmod won't actually block writes.
      // Detect via process.getuid (Linux/macOS only).
      const uid = typeof process.getuid === "function" ? process.getuid() : -1;
      if (uid === 0) {
        // Running as root — chmod won't block writes. The test cannot meaningfully
        // assert the EACCES path. Skip with explicit reason rather than fake green.
        console.warn("[disk_full.spec] skipping: running as root, chmod cannot block writes");
        return;
      }

      const ledger = new FileLedger(ledgerPath);

      // contract 1: append must throw — the write IS blocked.
      let thrown: unknown = null;
      try {
        ledger.append(SAMPLE_ENTRY);
      } catch (e) {
        thrown = e;
      }
      expect(thrown, "append to RO file must throw").not.toBeNull();

      // contract 2: the thrown error must be a TYPED RecorderWriteError (or LedgerError
      // subclass). A raw NodeJS SystemError with code EACCES/EPERM/EROFS leaking through
      // is the FAIL signal — it means coltrane doesn't wrap fs errors.
      const err = thrown as { constructor?: { name: string }; name?: string; code?: string };
      const typeName = err?.constructor?.name ?? err?.name ?? "unknown";
      // RED-honest assertion: we want a RecorderWriteError or LedgerError. Today this
      // surfaces as a raw "Error" (NodeJS SystemError) with code=EACCES/EPERM.
      expect(
        ["RecorderWriteError", "LedgerError"],
        `expected typed write error, got ${typeName} (code=${err?.code ?? "n/a"})`,
      ).toContain(typeName);

      // contract 3: after un-locking the dir + file, the SAME ledger instance can write
      // again without process restart. (Tests the idempotent-retry path.)
      chmodSync(lockedDir, 0o755);
      chmodSync(ledgerPath, 0o644);
      expect(() => ledger.append({ ...SAMPLE_ENTRY, gig_id: "ro:2" })).not.toThrow();
    } finally {
      // restore perms before cleanup so rmSync can succeed
      if (lockedDir && existsSync(lockedDir)) {
        try {
          chmodSync(lockedDir, 0o755);
          const ledgerFile = join(lockedDir, "recorder.jsonl");
          if (existsSync(ledgerFile)) chmodSync(ledgerFile, 0o644);
        } catch {
          /* best effort */
        }
      }
      env.cleanup();
    }
  }, 60_000);
});
