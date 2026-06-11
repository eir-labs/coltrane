// Ignores SIGTERM and writes a heartbeat marker forever (self-capped at ~8s so a RED
// run can't leak a permanent spinner). spawnSync's default SIGTERM bounces off; only a
// SIGKILL escalation stops the heartbeat. The test watches the marker's mtime: still
// advancing after the executor returns => the child survived => escalation is missing.
import { writeFileSync } from "node:fs";

process.on("SIGTERM", () => {
  /* swallow — refuse the polite kill */
});

export default function run(input) {
  const marker = input.marker;
  const start = Date.now();
  // self-caps at 4s so a RED run (no escalation) can't leak a permanent spinner
  while (Date.now() - start < 4000) {
    writeFileSync(marker, String(Date.now()));
  }
  return { heartbeat: "stopped" };
}
