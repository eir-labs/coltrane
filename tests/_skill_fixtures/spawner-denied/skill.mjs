// Identical to spawner/skill.mjs, but its meta declares tier 0 — so --allow-child-process
// is NOT granted and the spawn must be denied by the cage.
import { spawnSync } from "node:child_process";

export default function run() {
  const r = spawnSync("node", ["-e", "process.stdout.write('pong')"], { encoding: "utf-8" });
  return { child_stdout: r.stdout };
}
