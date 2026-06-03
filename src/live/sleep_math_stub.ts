// sleep-math stub.
//
// The real implementation (TDA on the last-24h audit chain, eigenvector-
// weighted scoring, read-only) is shipping in a parallel PR. This file
// holds the interface the CLI + nightly cron call into; the parallel PR
// replaces the body without touching call sites.
//
// Contract:
//   runSleep(uuid, auditPath, sleepDirPath) → { seal_sha, candidate_count }
// where
//   uuid          — steve uuid (matches .coltrane/steve_<uuid>/)
//   auditPath     — full path to the steve's audit.jsonl
//   sleepDirPath  — full path to .coltrane/steve_<uuid>/sleep/
//                   (the real impl writes candidates + a seal here)
// The seal_sha is the content hash of the sleep output; candidate_count
// is the number of ratchet candidates surfaced.

export interface SleepMathResult {
  seal_sha: string;
  candidate_count: number;
}

/** Stub. Returns a fixed sentinel until the real sleep-math PR lands. */
export async function runSleep(
  _uuid: string,
  _auditPath: string,
  _sleepDirPath: string,
): Promise<SleepMathResult> {
  return { seal_sha: "stub", candidate_count: 0 };
}
