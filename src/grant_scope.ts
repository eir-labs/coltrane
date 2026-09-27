// grant_scope.ts — THE ONE MATCHER for "does a path-scoped Write/Edit grant reach this path?"
//
// Used by the resolver (target narrowing, the protected-path denials — src/layout_grants.ts) and the
// post-seat diff gate (src/diff_gate.ts, through layout_grants.inWriteScope). There is no second glob
// engine anywhere in the grant path: two matchers that disagree are a grant the engine thinks is narrow
// and the CLI thinks is wide — or the reverse, where the diff gate excuses a Bash write the CLI's own
// Write rule would never have allowed.
//
// WHOSE SEMANTICS: THE CLI'S, BY CONSTRUCTION. The Claude Code CLI (2.1.283) enforces
// `--allowedTools Write(<scope>)` with its file-permission matcher (`matchingRuleForInput`), which:
//   1. PREPROCESSES each allow rule (the bundle's `Gn(e, true)`, after dropping a leading `./` and
//      collapsing `//`): a trailing `/**` is dropped — `x/**` → `/x` when x has no slash (an anchored
//      pattern that names x itself and everything in it), `a/b/**` → `a/b`, a bare `/**` stays;
//   2. compiles the result with the bundled `ignore` package — version 7.0.5 EXACTLY (it has
//      checkIgnore/checkRegex/setupWindows, lacks 7.0.7's `_basenameOnly`, carries 7.0.5's `**/` rule
//      and not 7.0.6's negated-range fix) — with its defaults (case-INSENSITIVE);
//   3. tests `path.relative(root, target)`, rejecting what `ignore.isPathValid` rejects.
// (Read from the installed binary; the drafter verified the version independently in round 5.)
//
// So this module does not reimplement gitignore: it USES `ignore` 7.0.5, pinned exactly as a production
// dependency, and applies the CLI's preprocessing (cliAllowPattern) in ONE place, before both
// grantCovers and grantMayReach. Two earlier reimplementations drifted (a 5.3.2 comparison; `[!a]`,
// which 7.0.5 reads as a literal `!`, not a negation); using the same code the CLI bundles makes
// agreement a property of construction rather than of a corpus.
//
// ERR TOWARD DENY where the CLI's answer cannot be computed from a tree-relative path: a rule rooted
// outside the tree (`//abs`, `~/…`) is assumed to reach every protected path and to cover no in-tree
// target.
import ignore, { type Ignore } from "ignore";

/** The layout file's name, at the root of the tree a gig runs against. */
export const LAYOUT_FILE = "coltrane.layout.json";

/** The paths no grant may ever reach: the grant boundary itself, git's own state, the CLI's settings,
 *  and the engine's own state. `kind: "file"` is denied by its exact path; `"dir"` by `<dir>/**`. */
export const PROTECTED_PATHS: ReadonlyArray<{ path: string; kind: "file" | "dir" }> = [
  { path: LAYOUT_FILE, kind: "file" },
  { path: ".git", kind: "dir" },
  { path: ".claude", kind: "dir" },
  { path: ".coltrane", kind: "dir" },
];

/**
 * THE FOLD a protected name is compared under — never its literal spelling. APFS (every macOS drain
 * host) is case-insensitive AND normalization-insensitive with Unicode case folding: it opens
 * `coltrane.layout.jſon` (U+017F) as `coltrane.layout.json`. So a name is folded by: compatibility
 * decomposition (NFKD — ſ→s, fullwidth and mathematical letters → ASCII, ligatures → their letters),
 * dropping every combining mark (so `.ġit` and `.g` + U+0307 `it` are `.git`), full case folding
 * (upper then lower, so ß→ss), and NFKC. It over-approximates any real file system's folding, which is
 * the direction a guard over protected paths must err in.
 */
export function foldName(s: string): string {
  return s.normalize("NFKD").replace(/\p{M}/gu, "").toUpperCase().toLowerCase().normalize("NFKC");
}

/** Is this tree-relative path one no grant may reach? Compared under foldName, so no Unicode, case or
 *  normalization spelling of a protected path escapes it. */
export function isProtectedPath(path: string): boolean {
  const p = foldName(path);
  return PROTECTED_PATHS.some((x) => (x.kind === "file" ? p === x.path : p === x.path || p.startsWith(`${x.path}/`)));
}

/** A rule rooted OUTSIDE the tree (absolute `//…`, home `~…`): its reach cannot be judged from a
 *  tree-relative path. Judged on the RAW scope, before `//` is collapsed. */
function rootedOutsideTree(scope: string): boolean {
  return scope.startsWith("//") || scope.startsWith("~");
}

/**
 * THE CLI'S PREPROCESSING of a Write/Edit allow rule, before it reaches `ignore`: a leading `./` is
 * dropped, runs of `/` collapse to one, and a trailing `/**` is rewritten (`Gn(e, true)` in the
 * bundle): `x/**` → `/x` (x without a slash; not for a `!`/`#`-led x), `a/b/**` → `a/b`, `/**` stays.
 */
export function cliAllowPattern(scope: string): string {
  let r = scope.startsWith("./") ? scope.slice(2) : scope;
  r = r.replace(/\/{2,}/g, "/");
  if (r.endsWith("/**")) {
    const s = r.slice(0, -3);
    if (!/[^/]/.test(s)) return "/**";
    return s.includes("/") || /^[!#]/.test(s) ? s : `/${s}`;
  }
  return r;
}

const MATCHERS = new Map<string, Ignore>();

function matcherFor(scope: string): Ignore {
  let m = MATCHERS.get(scope);
  if (!m) {
    m = ignore().add(cliAllowPattern(scope));
    MATCHERS.set(scope, m);
  }
  return m;
}

/**
 * Does a grant scoped to `scope` cover the tree-relative `path`, exactly as the CLI's matcher reads
 * it? A rule rooted outside the tree covers no in-tree path; a path `ignore` refuses as not relative
 * is covered by nothing.
 */
export function grantCovers(scope: string, path: string): boolean {
  if (rootedOutsideTree(scope)) return false;
  if (!ignore.isPathValid(path)) return false;
  return matcherFor(scope).ignores(path);
}

/**
 * COULD a grant scoped to `scope` (undefined = a bare grant) reach the protected path — for a `"dir"`,
 * the directory or ANYTHING under it? A file is judged exactly (grantCovers). A directory errs toward
 * yes: a pattern with no inner slash (after the CLI's preprocessing) matches basenames at any depth, so
 * it may reach inside any directory; an anchored pattern reaches the directory unless one of its leading
 * segments provably cannot match the directory's segment at that depth (judged by `ignore` itself); a
 * rule rooted outside the tree is assumed to reach it.
 */
export function grantMayReach(scope: string | undefined, target: { path: string; kind: "file" | "dir" }): boolean {
  if (scope === undefined || rootedOutsideTree(scope)) return true;
  // A scope that SPELLS a protected path another way (ſ, fullwidth, a combining dot) reaches it on a
  // folding file system: judge the folded scope too, and deny if either reading reaches.
  const folded = foldName(scope);
  return reaches(scope, target) || (folded !== scope && reaches(folded, target));
}

function reaches(scope: string, target: { path: string; kind: "file" | "dir" }): boolean {
  if (target.kind === "file") return grantCovers(scope, target.path);
  const pattern = cliAllowPattern(scope);
  if (pattern.startsWith("!")) return false; // a lone negation rule ignores (grants) nothing
  const anchored = /\/(?!$)/.test(pattern);
  if (!anchored) return true;
  const segs = pattern.replace(/\/+$/, "").replace(/^\//, "").split("/");
  const dirSegs = target.path.split("/");
  for (let i = 0; i < Math.min(segs.length, dirSegs.length); i++) {
    const seg = segs[i]!;
    if (seg === "**") return true;
    if (!ignore().add(`/${seg}`).ignores(dirSegs[i]!)) return false;
  }
  return true;
}
