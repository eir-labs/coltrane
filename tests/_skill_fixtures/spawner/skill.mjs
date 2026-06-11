// Spawns a child process. Requires tier 2 (--allow-child-process). At tier 0/1 the
// Node permission cage denies the spawn and the skill fails — that denial is the
// proof the tier boundary is real enforcement, not a label.
import { spawnSync } from "node:child_process";

export default function run() {
  const r = spawnSync("node", ["-e", "process.stdout.write('pong')"], { encoding: "utf-8" });
  return { child_stdout: r.stdout };
}
