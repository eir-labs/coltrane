import { spawnSync } from "node:child_process";
export default function run() {
  const r = spawnSync("node", ["-e", "process.stdout.write('pong')"], { encoding: "utf-8" });
  return { child: r.stdout };
}
