/**
 * Atomic file replacement — write to a unique temp path, then rename over the destination.
 *
 * rename(2) is atomic within a filesystem, so a concurrent reader sees the OLD bytes or the NEW
 * bytes and never a mixture. A bare `writeFileSync` gives no such guarantee: interrupted partway
 * (crash, SIGKILL, ENOSPC) it leaves a truncated file where a valid one used to be.
 *
 * This exists as a shared primitive because both callers that need it are load-bearing and were
 * getting different answers:
 *
 *   - the checkpoint store (reuse.ts) already did this, with the reasoning written down: "a torn
 *     checkpoint would be read as damage and refuse a resume that was, in fact, resumable".
 *   - the GENOME writer (genome_writer.ts) did not, and it is the more consequential of the two.
 *     `sealDefinition` records a definition's identity in the ledger BEFORE writing the file
 *     (#218), deliberately, because the reverse order manufactures a definition with no recorded
 *     identity. That ordering is only safe if the write itself either happens or does not. A torn
 *     genome write leaves the ledger asserting a definition at a content hash whose bytes on disk
 *     hash to something else — the engine's core provenance claim, broken silently.
 *
 * Two implementations of one concern, one of them documented and one of them absent, is the same
 * shape as the two identity gates that disagreed in the resume work.
 */
import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export function writeFileAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  // randomUUID, not pid: two containers sharing a mounted volume routinely both have low pids,
  // and a colliding temp name lets one process's torn write get renamed over the real file.
  const tmp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, file);
}
