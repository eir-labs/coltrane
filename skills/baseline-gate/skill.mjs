// baseline-gate — the drafting standard's baseline chair (chancery-red-drafting-v0, DS-5). Deterministic, no model, no
// network of its own. Tier 2: it spawns `docker exec` into the gig's room; it runs nothing of the drafter's on the host.
//
// Every law that exists at the baseline and is NOT named in the change-request's scope must keep, on the drafter's
// branch, its verdict and the outcome of each of its plants (compareBaselineLoop, src/baseline_holds.ts: the engine's
// own expression, imported, never copied). The branch is the drafter's STAGED tree (the index), as the scope gate reads.
//
// IN THE ROOM (Eugene, 2 Nov 2026; independent review of #598, findings 1 and 2). `loop/loop-result` is the drafter's: it runs
// SQL emitted from crossing/laws.sx, and a plant's `:sql` is free text. Run by this process it would be drafter code on the
// engine host, outside the room and its egress proxy; even this gate's git reads in that workspace would run whatever its
// .git/config names. So every step below runs INSIDE the realized room, as the seat, by the same spawn the seats use
// (`docker exec -i -w <dir> <container> …`, src/claude_invoker.ts). The engine hands the room in `context.room`; with no
// room this gate REFUSES. It never falls back to the host.
//
//   1. in the room, the baseline commit is exported into a throwaway directory (git archive | tar), the index into another
//      (git checkout-index --prefix): neither writes the gig's tree or its .git;
//   2. the repository's declared loop result, `loop/loop-result` (an executable, run from the tree's root, writing one
//      JSON {laws: [{id, verdict: pass|fail, plants: [{id, outcome: red|green}]}]} to stdout), is run in each, in the room;
//   3. on the host only the two JSON answers are read: they and the scope go to compareBaselineLoop; the verdict seals the
//      violations, the excepted law ids and both results. A missing or malformed loop result is a refusal, never a skip.
import { spawnSync } from "node:child_process";
import { compareBaselineLoop } from "../../dist/src/baseline_holds.js";

function pickRequest(input, context) {
  const up = context && Array.isArray(context.upstream) ? context.upstream : [];
  const hit = up.find((u) => u && u.domain_type === "change-request");
  return (hit && hit.data) || input || {};
}
const SAFE_REV = /^[A-Za-z0-9][A-Za-z0-9._\/~^-]{0,255}$/;
const SAFE_CONTAINER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;
const SAFE_DIR = /^\/[^\0\n]*$/;

/** The room the engine realized for this gig, or undefined: a container name and an absolute workspace path. */
function pickRoom(context) {
  const r = context && context.room;
  if (!r || typeof r.container !== "string" || typeof r.workspace !== "string") return undefined;
  return SAFE_CONTAINER.test(r.container) && SAFE_DIR.test(r.workspace) ? { container: r.container, workspace: r.workspace } : undefined;
}

/** Run argv INSIDE the room, cwd `dir` (a path in the room), as the seat: the seats' own spawn, never a host process. */
function inRoom(room, dir, argv) {
  const r = spawnSync("docker", ["exec", "-i", "-w", dir, room.container, ...argv], { encoding: "utf-8", maxBuffer: 256 * 1024 * 1024, timeout: 600_000 });
  return { status: r.status, stdout: r.stdout || "", stderr: (r.stderr || (r.error ? String(r.error.message || r.error) : "")) };
}

function loopResult(room, dir) {
  const exe = `${dir}/loop/loop-result`;
  if (inRoom(room, dir, ["test", "-e", exe]).status !== 0) return { error: "the repository declares no loop/loop-result: there is nothing to hold the baseline with" };
  if (inRoom(room, dir, ["test", "-x", exe]).status !== 0) return { error: "loop/loop-result is not executable" };
  const r = inRoom(room, dir, [exe]);
  if (r.status !== 0) return { error: `loop/loop-result exited ${r.status}: ${(r.stderr || "").trim().slice(0, 400)}` };
  let j;
  try { j = JSON.parse(r.stdout); } catch { return { error: "loop/loop-result wrote no JSON" }; }
  const ok = j && Array.isArray(j.laws) && j.laws.every((l) => l && typeof l.id === "string" && (l.verdict === "pass" || l.verdict === "fail")
    && Array.isArray(l.plants) && l.plants.every((p) => p && typeof p.id === "string" && (p.outcome === "red" || p.outcome === "green")));
  return ok ? { result: { laws: j.laws } } : { error: "loop/loop-result's JSON is not {laws: [{id, verdict, plants: [{id, outcome}]}]}" };
}

/** The first law that differs between two loop results of one commit, by id, or undefined when they are the same. */
function firstMoved(a, b) {
  const key = (r) => new Map(r.laws.map((l) => [l.id, JSON.stringify(l)]));
  const A = key(a), B = key(b);
  for (const [id, v] of A) if (B.get(id) !== v) return id;
  for (const id of B.keys()) if (!A.has(id)) return id;
  return undefined;
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
  // FAIL CLOSED: no room, no run. The drafter's loop result is never run on the engine host.
  const room = pickRoom(context);
  if (!room) return refuse("room-present", "no seat-bearing room stands for this gig: the drafter's loop/loop-result runs only inside the room, never on the host");
  const ws = room.workspace;
  const resolved = inRoom(room, ws, ["git", "rev-parse", "--verify", `${baseline}^{commit}`]);
  if (resolved.status !== 0) return refuse("baseline-resolves", `the baseline ${baseline} does not resolve in this tree: ${resolved.stderr.trim().slice(0, 300)}`);
  const sha = resolved.stdout.trim();

  const mk = (tag) => { const r = inRoom(room, ws, ["mktemp", "-d", `/tmp/baseline-gate-${tag}-XXXXXX`]); return r.status === 0 ? r.stdout.trim() : ""; };
  const base = mk("base");
  const branch = mk("branch");
  try {
    if (!base || !branch) return refuse("room-scratch", "the room gave no throwaway directory to export the trees into");
    const a = inRoom(room, ws, ["bash", "-o", "pipefail", "-c", 'git archive "$1" | tar -x -C "$2"', "baseline-gate", sha, base]);
    if (a.status !== 0) return refuse("baseline-export", `exporting the baseline failed: ${a.stderr.trim().slice(0, 300)}`);
    const b = inRoom(room, ws, ["git", "checkout-index", "-a", "-f", `--prefix=${branch}/`]);
    if (b.status !== 0) return refuse("branch-export", `exporting the staged branch failed: ${b.stderr.trim().slice(0, 300)}`);
    const atBase = loopResult(room, base);
    if (atBase.error) return refuse("loop-result-at-baseline", atBase.error);
    // RR-4, DETERMINISM FIRST (wiki spec.coltrane.the-red-pass-runs-in-its-room): the instrument is checked before it is
    // trusted. A second run on the same baseline must give the same laws, verdicts and plant outcomes; if it does not, every
    // comparison below would read the instrument's noise as the branch's fault (gig 3243a92c spent three rounds that way).
    const again = loopResult(room, base);
    if (again.error) return refuse("loop-result-at-baseline", again.error);
    const moved = firstMoved(atBase.result, again.result);
    if (moved) return refuse("loop-result-is-deterministic", `the loop result is not deterministic: two runs on the baseline differ at law ${JSON.stringify(moved)}, so no comparison with the branch can be trusted`);
    const atBranch = loopResult(room, branch);
    if (atBranch.error) return refuse("loop-result-on-branch", atBranch.error);
    const cmp = compareBaselineLoop({ baseline: atBase.result, branch: atBranch.result, scope });
    return {
      id: "baseline-verdict", target_ref: `branch (index) vs ${sha}`, pass: cmp.pass,
      checks: [{
        method: "every-unscoped-law-holds-the-baseline", target_ref: `loop/loop-result at baseline and on the branch, in room ${room.container}`,
        result: cmp.pass
          ? `${atBase.result.laws.length} baseline law(s); every unscoped one keeps its verdict and plant outcomes (excepted: ${cmp.excepted.join(", ") || "none"})`
          : cmp.violations.map((v) => v.reason).join("; "),
      }],
      violations: cmp.violations, excepted: cmp.excepted, baseline: atBase.result, branch: atBranch.result,
    };
  } finally {
    const scratch = [base, branch].filter(Boolean);
    if (scratch.length) inRoom(room, ws, ["rm", "-rf", "--", ...scratch]);
  }
}
