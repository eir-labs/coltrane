import { readFileSync } from "node:fs";

const POSITIVE = /\.(toContain|toBe|toEqual|toMatch|toThrow|toBeTruthy|toBeDefined|toBeInstanceOf|toBeTypeOf|toBeGreaterThan|toBeGreaterThanOrEqual|toBeLessThan|toHaveLength|toHaveProperty)\b/;
const NEGATIVE = /\.not\./;
// The window must clear an assertion MESSAGE, which in a well-commented suite is a full sentence.
// A 60-char window missed a guard that was actually there — a false positive on an already-fixed
// law, which is the worst kind for a tool meant to be trusted.
const NONEMPTY = /\.length\b[\s\S]{0,400}?(toBeGreaterThan|toBeGreaterThanOrEqual)|not\.toHaveLength\(\s*0\s*\)|toHaveLength\(\s*[1-9]|\.length\s*[>!]==?\s*0/;
// A loop over an INLINE ARRAY or a SCREAMING_CASE fixture cannot run zero times, so it is not a
// vacuity risk. Only a DISCOVERED collection is. Both GLOBAL: a law may hold several statically
// safe loops, and a non-global match counts at most one.
const LITERAL_LOOP = /\bfor\s*\((?:const|let|var)\s+\w+\s+of\s*\[/g;
const FIXTURE_LOOP = /\bfor\s*\((?:const|let|var)\s+\w+\s+of\s+[A-Z][A-Z0-9_]*\b/g;

// A law may anchor through a HELPER rather than inline — `const doc = await rendered();` where
// `rendered()` asserts the document exists. Counting only in-block assertions marks every such law
// a false positive, and ten false positives train a reader to ignore the tool.
function anchoringHelpers(src) {
  const names = new Set();
  const re = /(?:const|function)\s+([A-Za-z_$][\w$]*)\s*(?:=|\()/g;
  let m;
  while ((m = re.exec(src))) {
    const slice = src.slice(m.index, m.index + 1400);
    const end = slice.search(/\n(?:const|function|describe|it)\b/);
    const body = end > 0 ? slice.slice(0, end) : slice;
    if (POSITIVE.test(body) && /expect\(/.test(body)) names.add(m[1]);
  }
  return names;
}

export default function run(input) {
  const path = input && input.path ? String(input.path) : "";
  let src = "";
  try { src = readFileSync(path, "utf-8"); }
  catch { return { laws: [], total_laws: 0, hollow_count: 0, error: `cannot read ${path}` }; }

  const helpers = anchoringHelpers(src);
  const helperCall = helpers.size ? new RegExp("\\b(" + [...helpers].join("|") + ")\\s*\\(") : null;

  const laws = [];
  let cur = null;
  for (const line of src.split("\n")) {
    const m = line.match(/\bit\(\s*["'`](.+?)["'`]/);
    if (m) { if (cur) laws.push(finish(cur)); cur = { name: m[1], positive: 0, negative: 0, body: [] }; continue; }
    if (!cur) continue;
    cur.body.push(line);
    if (helperCall && helperCall.test(line)) cur.positive++;
    if (/expect\(/.test(line) || /\.(to[A-Z])/.test(line)) {
      if (NEGATIVE.test(line)) cur.negative++;
      else if (POSITIVE.test(line)) cur.positive++;
    }
  }
  if (cur) laws.push(finish(cur));

  const hollow = laws.filter((l) => l.hollow_passable);
  return {
    path,
    laws,
    total_laws: laws.length,
    hollow_count: hollow.length,
    verdict: hollow.length === 0
      ? "no law in this file is satisfied by an implementation that produces nothing"
      : `${hollow.length} of ${laws.length} laws pass against an implementation that produces nothing`,
  };
}

function finish(l) {
  const text = l.body.join("\n");
  const loops = (text.match(/\bfor\s*\(|\.forEach\(/g) || []).length;
  const safe = (text.match(LITERAL_LOOP) || []).length + (text.match(FIXTURE_LOOP) || []).length;
  const loop = loops > safe;
  const guard = NONEMPTY.test(text);
  const iterables = (text.match(/\bfor\s*\((?:const|let|var)\s+\w+\s+of\s+([^)]{0,48})/g) || [])
    .map((x) => x.replace(/^.*\bof\s+/, "").trim());
  const reasons = [];
  if (l.positive === 0 && l.negative > 0) reasons.push("all assertions are negative — an absence over nothing is satisfied");
  if (loop && !guard) reasons.push("assertion inside a loop with no non-empty guard — an empty collection examines nothing");
  // Always report what it iterates, so a reader settles a borderline call in one glance instead of
  // trusting the classifier.
  return { name: l.name, positive: l.positive, negative: l.negative, iterables, hollow_passable: reasons.length > 0, why: reasons.join("; ") || null };
}