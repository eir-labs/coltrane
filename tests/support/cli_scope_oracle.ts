// THE CLI'S WRITE/EDIT SCOPE MATCHER, as a test oracle.
//
// Verified by the drafter on 26 Sep 2026 against the installed Claude Code CLI 2.1.283
// (~/.local/share/claude/versions/2.1.283, a Bun single-file binary whose bundled JS is readable in its
// bytes):
//   · the Edit/Write permission matcher compiles allow rules with the bundled `ignore` package:
//     `en.default().add(Array.from(patterns, me => Gn(me, isAllow)))`; `matchesPathRule` is
//     `en.default().add(w).test(T).ignored` with T = path.relative(root, target) — GITIGNORE semantics;
//   · that bundled `ignore` is 7.0.5 exactly (has checkIgnore/checkRegex/setupWindows, lacks the 7.0.7+
//     `_basenameOnly`, carries 7.0.5's `^\^*\\\*\\\*\\\/` rule, not 7.0.6's repeated form or its
//     negated-range fix). `ignore@7.0.5` (MIT, github.com/kaelzhang/node-ignore) is pinned exactly as a
//     devDependency, used ONLY here; docs/CONTAINMENT.md allows imports of declared devDependencies;
//   · before `.add`, an allow rule's content is preprocessed by the bundle's `dct` (drop a leading `./`),
//     `tn` (collapse `//+`), and `Gn(e, true)`: a trailing `/**` is dropped — `x/**` → `/x` when x has no
//     slash, `a/b/**` → `a/b`, a bare `/**` stays. Rules rooted outside the tree (`//abs`, `~/…`) are out
//     of this oracle's scope.
import ignore from "ignore";

export function cliAllowPattern(p: string): string {
  let r = p.startsWith("./") ? p.slice(2) : p;
  r = r.replace(/\/{2,}/g, "/");
  if (r.endsWith("/**")) {
    const s = r.slice(0, -3);
    return /[^/]/.test(s) ? (s.includes("/") || /^[!#]/.test(s) ? s : `/${s}`) : "/**";
  }
  return r;
}

/** Does the CLI's Write/Edit ALLOW rule `pattern` reach the tree-relative `path`? */
export function cliCovers(pattern: string, path: string): boolean {
  return ignore().add(cliAllowPattern(pattern)).ignores(path);
}

/** The raw `ignore` answer with NO CLI preprocessing — used to isolate what the rewrite changes. */
export function ignoreRaw(pattern: string, path: string): boolean {
  return ignore().add(pattern).ignores(path);
}
