// scope-gate — the drafting standard's scope chair (chancery-red-drafting-v0, DS-1). Deterministic,
// no model, no network. Tier 2: it reads git in the gig's working tree.
//
// Reads the change-request's scope ({files, laws, terms}) and baseline_commit, then compares the
// drafter's STAGED tree (the index) with the baseline:
//   (a) every path the index changes against the baseline must be in scope.files;
//   (b) in crossing/laws.sx and crossing/terms.sx, every id the index ADDS, REMOVES or AMENDS must be
//       named (law forms against scope.laws, term forms against scope.terms). A rename is a removal
//       of the old id plus an addition of the new one, so both must be named.
// Anything else is a refusal that names the file or id. Seals one scope-verdict.
import { spawnSync } from "node:child_process";

const arr = (v) => (Array.isArray(v) ? v.map(String) : []);

function pickRequest(input, context) {
  const up = context && Array.isArray(context.upstream) ? context.upstream : [];
  const hit = up.find((u) => u && u.domain_type === "change-request");
  return (hit && hit.data) || input || {};
}

function git(args) {
  const r = spawnSync("git", args, { encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 });
  return { ok: r.status === 0, out: r.stdout || "", err: (r.stderr || "").trim() };
}

// Top-level s-expression forms of the given heads, keyed by their first string (the id). Balanced on
// parentheses, aware of string literals and `;` line comments, so a multi-line form and a one-line
// form read the same.
function formsById(text, head) {
  const out = new Map();
  let depth = 0, start = -1, inStr = false, esc = false, inComment = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inComment) { if (ch === "\n") inComment = false; continue; }
    if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === "\"") inStr = false; continue; }
    if (ch === "\"") { inStr = true; continue; }
    if (ch === ";") { inComment = true; continue; }
    if (ch === "(") { if (depth === 0) start = i; depth++; continue; }
    if (ch === ")") {
      depth--;
      if (depth === 0 && start >= 0) {
        const form = text.slice(start, i + 1);
        const m = form.match(/^\(\s*([^\s()"]+)\s+"((?:[^"\\]|\\.)*)"/);
        if (m && m[1] === head) out.set(m[2], form.replace(/\s+/g, " ").trim());
        start = -1;
      }
    }
  }
  return out;
}

function idDiff(before, after) {
  const added = [], removed = [], amended = [];
  for (const [id, f] of after) { if (!before.has(id)) added.push(id); else if (before.get(id) !== f) amended.push(id); }
  for (const id of before.keys()) if (!after.has(id)) removed.push(id);
  return { added, removed, amended };
}

const SX = [
  { path: "crossing/laws.sx", head: "law", allowedKey: "laws" },
  { path: "crossing/terms.sx", head: "term", allowedKey: "terms" },
];

export default function run(input, context) {
  const req = pickRequest(input, context);
  const scope = req.scope && typeof req.scope === "object" ? req.scope : null;
  const baseline = typeof req.baseline_commit === "string" ? req.baseline_commit.trim() : "";
  const refuse = (method, result) => ({
    id: "scope-verdict", target_ref: baseline ? `index vs ${baseline}` : "index", pass: false,
    checks: [{ method, target_ref: "change-request", result }], refused: [], files: [], ids: {},
  });
  if (!scope) return refuse("scope-present", "the change-request carries no scope {files, laws, terms}: nothing can be admitted");
  if (!baseline) return refuse("baseline-present", "the change-request carries no baseline_commit: the diff has nothing to be measured from");

  const resolved = git(["rev-parse", "--verify", `${baseline}^{commit}`]);
  if (!resolved.ok) return refuse("baseline-resolves", `git cannot resolve baseline_commit ${baseline}: ${resolved.err}`);

  const files = new Set(arr(scope.files));
  const allowed = { laws: new Set(arr(scope.laws)), terms: new Set(arr(scope.terms)) };
  const checks = [];
  const refused = [];

  const diff = git(["diff", "--cached", "--name-only", "--no-renames", "-z", baseline]);
  if (!diff.ok) return refuse("staged-diff", `git diff --cached against ${baseline} failed: ${diff.err}`);
  const changed = diff.out.split("\0").filter(Boolean).sort();
  const outside = changed.filter((p) => !files.has(p));
  for (const p of outside) refused.push({ kind: "file", id: p, change: "written", reason: `${p} is not in the scope's file list` });
  checks.push({
    method: "file-set-within-scope", target_ref: "git diff --cached --name-only --no-renames",
    result: outside.length === 0 ? `all ${changed.length} staged path(s) are in the scope` : `outside the scope: ${outside.join(", ")}`,
  });

  const ids = {};
  for (const sx of SX) {
    if (!changed.includes(sx.path)) continue;
    const before = git(["show", `${baseline}:${sx.path}`]);
    const after = git(["show", `:${sx.path}`]);
    const d = idDiff(formsById(before.ok ? before.out : "", sx.head), formsById(after.ok ? after.out : "", sx.head));
    ids[sx.path] = d;
    const bad = [];
    for (const [change, list] of [["added", d.added], ["removed", d.removed], ["amended", d.amended]]) {
      for (const id of list) {
        if (allowed[sx.allowedKey].has(id)) continue;
        bad.push(id);
        refused.push({ kind: sx.head, id, change, reason: `${sx.head} "${id}" is ${change} in ${sx.path} and the scope does not name it` });
      }
    }
    checks.push({
      method: `${sx.head}-ids-within-scope`, target_ref: sx.path,
      result: bad.length === 0
        ? `added [${d.added.join(", ")}], removed [${d.removed.join(", ")}], amended [${d.amended.join(", ")}]: every id is named`
        : `not named in the scope: ${bad.join(", ")}`,
    });
  }

  return {
    id: "scope-verdict", target_ref: `index vs ${resolved.out.trim()}`, pass: refused.length === 0,
    checks, refused, files: changed, ids,
  };
}
