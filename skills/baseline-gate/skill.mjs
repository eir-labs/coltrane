// baseline-gate — the drafting standard's baseline chair (chancery-red-drafting-v0, DS-5). Deterministic, no model, no
// network. Tier 2: it reads git in the gig's working tree, and writes only into throwaway directories of its own.
//
// Every law that exists at the baseline and is NOT named in the change-request's scope must keep, on the drafter's
// branch, its verdict and the outcome of each of its plants (compareBaselineLoop, src/baseline_holds.ts: the engine's
// own expression, imported, never copied). The branch is the drafter's STAGED tree (the index), as the scope gate reads.
//
//   1. the baseline commit is exported into a throwaway directory (git archive | tar), the index into another
//      (git checkout-index --prefix): neither writes the gig's tree or its .git;
//   2. the repository's declared loop result, `loop/loop-result` (an executable, run from the tree's root, writing one
//      JSON {laws: [{id, verdict: pass|fail, plants: [{id, outcome: red|green}]}]} to stdout), is run in each;
//   3. the two results and the scope go to compareBaselineLoop; the verdict seals the violations, the excepted law ids
//      and both results. A missing or malformed loop result is a refusal, never a skip.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, accessSync, constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareBaselineLoop } from "../../dist/src/baseline_holds.js";

function pickRequest(input, context) {
  const up = context && Array.isArray(context.upstream) ? context.upstream : [];
  const hit = up.find((u) => u && u.domain_type === "change-request");
  return (hit && hit.data) || input || {};
}
const sh = (cmd, cwd) => spawnSync("bash", ["-o", "pipefail", "-c", cmd], { cwd, encoding: "utf-8", maxBuffer: 256 * 1024 * 1024, timeout: 600_000 });
const SAFE_REV = /^[A-Za-z0-9][A-Za-z0-9._\/~^-]{0,255}$/;

function loopResult(dir) {
  const exe = join(dir, "loop", "loop-result");
  if (!existsSync(exe)) return { error: "the repository declares no loop/loop-result: there is nothing to hold the baseline with" };
  try { accessSync(exe, constants.X_OK); } catch { return { error: "loop/loop-result is not executable" }; }
  const r = spawnSync(exe, [], { cwd: dir, encoding: "utf-8", maxBuffer: 256 * 1024 * 1024, timeout: 600_000 });
  if (r.status !== 0) return { error: `loop/loop-result exited ${r.status}: ${(r.stderr || "").trim().slice(0, 400)}` };
  let j;
  try { j = JSON.parse(r.stdout); } catch { return { error: "loop/loop-result wrote no JSON" }; }
  const ok = j && Array.isArray(j.laws) && j.laws.every((l) => l && typeof l.id === "string" && (l.verdict === "pass" || l.verdict === "fail")
    && Array.isArray(l.plants) && l.plants.every((p) => p && typeof p.id === "string" && (p.outcome === "red" || p.outcome === "green")));
  return ok ? { result: { laws: j.laws } } : { error: "loop/loop-result's JSON is not {laws: [{id, verdict, plants: [{id, outcome}]}]}" };
}

export default function run(input, context) {
  const req = pickRequest(input, context);
  const scope = req.scope && typeof req.scope === "object" ? req.scope : null;
  const baseline = typeof req.baseline_commit === "string" ? req.baseline_commit.trim() : "";
  const refuse = (method, result) => ({
    id: "baseline-verdict", target_ref: baseline ? `branch vs ${baseline}` : "branch", pass: false,
    checks: [{ method, target_ref: "change-request", result }], violations: [], excepted: [],
  });
  if (!scope) return refuse("scope-present", "the change-request carries no scope: which laws are excepted is unknown");
  if (!baseline || !SAFE_REV.test(baseline)) return refuse("baseline-present", "the change-request carries no baseline_commit git can safely read");
  const resolved = sh(`git rev-parse --verify '${baseline}^{commit}'`);
  if (resolved.status !== 0) return refuse("baseline-resolves", `the baseline ${baseline} does not resolve in this tree`);

  const base = mkdtempSync(join(tmpdir(), "baseline-gate-base-"));
  const branch = mkdtempSync(join(tmpdir(), "baseline-gate-branch-"));
  try {
    const a = sh(`git archive '${resolved.stdout.trim()}' | tar -x -C '${base}'`);
    if (a.status !== 0) return refuse("baseline-export", `exporting the baseline failed: ${(a.stderr || "").trim().slice(0, 300)}`);
    const b = sh(`git checkout-index -a -f --prefix='${branch}/'`);
    if (b.status !== 0) return refuse("branch-export", `exporting the staged branch failed: ${(b.stderr || "").trim().slice(0, 300)}`);
    const atBase = loopResult(base);
    if (atBase.error) return refuse("loop-result-at-baseline", atBase.error);
    const atBranch = loopResult(branch);
    if (atBranch.error) return refuse("loop-result-on-branch", atBranch.error);
    const cmp = compareBaselineLoop({ baseline: atBase.result, branch: atBranch.result, scope });
    return {
      id: "baseline-verdict", target_ref: `branch (index) vs ${resolved.stdout.trim()}`, pass: cmp.pass,
      checks: [{
        method: "every-unscoped-law-holds-the-baseline", target_ref: "loop/loop-result at baseline and on the branch",
        result: cmp.pass
          ? `${atBase.result.laws.length} baseline law(s); every unscoped one keeps its verdict and plant outcomes (excepted: ${cmp.excepted.join(", ") || "none"})`
          : cmp.violations.map((v) => v.reason).join("; "),
      }],
      violations: cmp.violations, excepted: cmp.excepted, baseline: atBase.result, branch: atBranch.result,
    };
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(branch, { recursive: true, force: true });
  }
}
