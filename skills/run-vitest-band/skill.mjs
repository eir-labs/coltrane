// Pure-code product skill (determinism 1.0): run the deterministic test command and parse
// the verdict. This is the proper fix for "an LLM should not babysit a deterministic
// command" — the command IS the answer; no model resolves any field. Tier 2 (spawns vitest).
import { spawnSync } from "node:child_process";

export default function run(input) {
  const target = input && input.target ? String(input.target) : "";
  const args = ["vitest", "run", "--reporter=json", ...(target ? [target] : [])];
  const r = spawnSync("npx", args, { encoding: "utf-8", maxBuffer: 128 * 1024 * 1024 });
  const out = r.stdout || "";
  let report = null;
  try {
    report = JSON.parse(out.slice(out.indexOf("{")));
  } catch {
    return { passed: 0, total: 0, failures: ["could not parse vitest json report"] };
  }
  const total = report.numTotalTests ?? 0;
  const passed = report.numPassedTests ?? 0;
  const failures = (report.testResults ?? [])
    .flatMap((f) => (f.assertionResults ?? []).filter((a) => a.status === "failed").map((a) => a.fullName ?? a.title));
  return { passed, total, failures };
}
