// grant_scope.ts — THE ONE MATCHER for "does a path-scoped Write/Edit grant reach this path?"
//
// Used by the resolver (target narrowing, the protected-path denials — src/layout_grants.ts) and the
// post-seat diff gate (src/diff_gate.ts, through layout_grants.inWriteScope). There is no second glob
// engine anywhere in the grant path: two matchers that disagree are a grant the engine thinks is narrow
// and the CLI thinks is wide.
//
// WHOSE SEMANTICS. The engine's matcher must agree with the CLAUDE CODE CLI's, because the CLI is what
// enforces `--allowedTools Write(<scope>)`. Established by reading the installed CLI's bundle (2.1.283,
// ~/.local/share/claude/versions/2.1.283, a Bun single-file executable whose JS is readable with
// `strings`): the file-permission matcher (exported there as `matchingRuleForInput`) compiles each rule's
// content with the `ignore` package — GITIGNORE semantics — and tests the target's path RELATIVE to the
// rule's root (the session cwd for a plain pattern). Gitignore semantics differ from node's
// `path.matchesGlob` in exactly the ways that matter here:
//   · dot-paths are NOT special: `**` reaches `.coltrane/x`, `.git/config`, `.claude/settings.json`
//     (node's matchesGlob says false for all three — the seam this module closes);
//   · a pattern with NO slash (other than a trailing one) matches at ANY depth: `*.json` reaches
//     `.coltrane/a.json` and `sub/x.json`, not only root files;
//   · a pattern that matches a DIRECTORY reaches everything under it: `src/*` reaches `src/a/b`;
//   · a leading `/` anchors to the root; a trailing `/` matches directories only.
// The `ignore` package's answers for those cases were checked against a local copy (5.3.2): all true.
// This module reimplements those rules (no new dependency) and ERRS TOWARD DENY where the CLI's answer
// cannot be computed from a tree-relative path: a rule rooted outside the tree (`//abs`, `~/…`) is
// assumed to reach every protected path, and to cover no in-tree target.

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

/** Is this tree-relative path one no grant may reach? */
export function isProtectedPath(path: string): boolean {
  return PROTECTED_PATHS.some((p) => (p.kind === "file" ? path === p.path : path === p.path || path.startsWith(`${p.path}/`)));
}

/** A rule rooted OUTSIDE the tree (absolute `//…`, home `~…`): its reach cannot be judged from a
 *  tree-relative path. */
function rootedOutsideTree(scope: string): boolean {
  return scope.startsWith("//") || scope.startsWith("~");
}

/** One gitignore segment (no `/`) → a regex source over a single path segment. */
function segmentSource(seg: string): string {
  let out = "";
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i]!;
    if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else if (c === "[") {
      const close = seg.indexOf("]", i + 1);
      if (close < 0) { out += "\\["; continue; }
      let cls = seg.slice(i + 1, close);
      if (cls.startsWith("!")) cls = `^${cls.slice(1)}`;
      out += `[${cls.replace(/\\/g, "\\\\")}]`;
      i = close;
    } else out += c.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  return out;
}

interface Compiled {
  re: RegExp;
  dirOnly: boolean;
  anchored: boolean;
  segments: string[];
}

const CACHE = new Map<string, Compiled>();

function compile(pattern: string): Compiled {
  const hit = CACHE.get(pattern);
  if (hit) return hit;
  let p = pattern;
  const dirOnly = p.endsWith("/");
  p = p.replace(/\/+$/, "");
  const anchored = p.includes("/");
  if (p.startsWith("/")) p = p.slice(1);
  const segments = p.split("/");
  let body = "";
  segments.forEach((seg, i) => {
    const last = i === segments.length - 1;
    if (seg === "**") {
      if (segments.length === 1) body += ".*";
      else if (i === 0) body += "(?:.*/)?";
      // `x/**` reaches everything inside x; `x/**/` (directories only) also matches x itself, so it
      // reaches x's files too — the `ignore` package's answer, measured.
      else if (last) body += dirOnly ? "(?:/.*)?" : "/.*";
      else body += "/(?:.*/)?";
      return;
    }
    if (i > 0 && segments[i - 1] !== "**") body += "/";
    body += segmentSource(seg);
  });
  const re = new RegExp(`${anchored ? "^" : "^(?:.*/)?"}${body}$`);
  const c = { re, dirOnly, anchored, segments };
  CACHE.set(pattern, c);
  return c;
}

/**
 * Does a grant scoped to `scope` cover the tree-relative `path`, as the CLI's gitignore matcher reads
 * it? The pattern matches the path itself, or any directory above it (a matched directory covers
 * everything in it). A rule rooted outside the tree covers no in-tree path.
 */
export function grantCovers(scope: string, path: string): boolean {
  if (rootedOutsideTree(scope)) return false;
  if (scope === path) return true;
  const c = compile(scope);
  const parts = path.split("/");
  for (let n = parts.length; n >= 1; n--) {
    const candidate = parts.slice(0, n).join("/");
    const isDir = n < parts.length;
    if ((isDir || !c.dirOnly) && c.re.test(candidate)) return true;
  }
  return false;
}

/**
 * COULD a grant scoped to `scope` (undefined = a bare grant) reach the protected path — for a `"dir"`,
 * the directory or ANYTHING under it? Errs toward yes: an unanchored pattern can match a basename at
 * any depth, so it may reach inside any directory; an anchored pattern reaches a directory unless one
 * of its leading segments provably differs from the directory's path; a rule rooted outside the tree
 * is assumed to reach it.
 */
export function grantMayReach(scope: string | undefined, target: { path: string; kind: "file" | "dir" }): boolean {
  if (scope === undefined || rootedOutsideTree(scope)) return true;
  if (target.kind === "file") return grantCovers(scope, target.path);
  const c = compile(scope);
  if (!c.anchored) return true;
  const dirSegs = target.path.split("/");
  for (let i = 0; i < Math.min(c.segments.length, dirSegs.length); i++) {
    const seg = c.segments[i]!;
    if (seg === "**") return true;
    if (!new RegExp(`^${segmentSource(seg)}$`).test(dirSegs[i]!)) return false;
  }
  return true;
}
