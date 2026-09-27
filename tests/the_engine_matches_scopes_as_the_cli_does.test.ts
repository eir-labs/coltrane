// THE ENGINE MATCHES A GRANT'S SCOPE EXACTLY AS THE CLAUDE CLI DOES — checked against the CLI's own matcher.
//
// The CLI enforces `--allowedTools Write(<scope>)`; the engine decides which targets a grant covers, which
// protected paths it must deny, and what the diff gate lets through, with its OWN matcher
// (grantCovers / grantMayReach, src/grant_scope.ts). If the two disagree, a grant the engine thinks is
// narrow is wide at the CLI, or a protected path the engine thinks is unreachable is reachable. All six
// of the implementer's dot-path plants survived round 4 because nothing compared the two.
//
// THE ORACLE, VERIFIED BY THE DRAFTER (26 Sep 2026) against the installed CLI 2.1.283
// (~/.local/share/claude/versions/2.1.283, a Bun single-file binary; its JS read from the bytes):
//   · the Edit/Write permission matcher compiles each rule with the bundled `ignore` package —
//     `en.default().add(Array.from(patterns, me => Gn(me, isAllow)))`, and `matchesPathRule` calls
//     `en.default().add(w).test(T).ignored` with T = path.relative(root, target);
//   · the bundled `ignore` is 7.0.5 EXACTLY: it has `checkIgnore`/`checkRegex`/`setupWindows` (7.0.5+),
//     lacks `_basenameOnly` (7.0.7+), and carries 7.0.5's `^\^*\\\*\\\*\\\/` rule rather than 7.0.6's
//     `^\^*(?:\\\*\\\*\\\/)+` and negated-range fix. (The implementer compared against 5.3.2 — a different
//     major.) `ignore@7.0.5` (MIT) is therefore a pinned devDependency of this repo, used only as this
//     test oracle; docs/CONTAINMENT.md allows imports of declared devDependencies.
//   · BEFORE `.add`, an ALLOW rule's content goes through the CLI's own preprocessing, reproduced below as
//     `cliAllowPattern` from the bundle's `dct` / `tn` / `Gn`: a leading `./` is dropped; `//+` collapses
//     to `/`; and `Gn(e, allow=true)` rewrites a trailing `/**`: `x/**` → `/x` when x has no slash (an
//     ANCHORED directory pattern), `a/b/**` → `a/b`, and a bare `/**` stays `/**`. (`//abs` and `~/…`
//     rules are rooted outside the tree and are not part of this corpus.)
//
//   law                                                     kind         drives                              plant
//   the fixed table of tricky cases agrees                   behavioural  grantCovers — src/grant_scope.ts    OWN-A matchesGlob / OWN-C `*` skips dots /
//                                                                                                               OWN-E no directory coverage / OWN-F slashless
//                                                                                                               patterns anchored
//   a generated corpus agrees (fast-check, mixed case)       behavioural  same                                same four plants; round 6: a case-SENSITIVE
//                                                                                                               matcher (ignore({ ignorecase: false }))
//   uppercase rows (SRC/**, .GIT/config, *.JSON …)           behavioural  same                                a case-sensitive matcher
//   the CLI's preprocessing (`./`, `//`, `**/**`) honoured   behavioural  same                                (RED today — `./**` covers nothing in the engine)
//   `x/**` covers `x` itself (the CLI's Gn rewrite)          behavioural  same                                (RED today — the engine does not apply Gn)
//   `[!…]` is NOT a negated class in ignore 7.0.5             behavioural  same                                (RED today — the engine negates it)
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { grantCovers } from "../src/grant_scope.js";
import { cliCovers, ignoreRaw } from "./support/cli_scope_oracle.js";

/** Does the CLI's Gn rewrite (a trailing `/**` dropped) change the answer for this pair? Those pairs
 *  are judged by the rewrite law below, so the differential laws state the remaining agreement exactly. */
const namesItsOwnRoot = (pattern: string, path: string): boolean =>
  pattern.endsWith("/**") && ignoreRaw(pattern, path) !== cliCovers(pattern, path);
/** A negated bracket class — judged by its own law below. */
const negatedClass = (pattern: string): boolean => /\[!/.test(pattern);

const TABLE: Array<[string, string]> = [
  // dot-directories and `**`
  ["**", ".coltrane/x"], ["**", ".git/config"], ["**", ".claude/settings.json"], ["**", "coltrane.layout.json"],
  ["**/*.json", ".coltrane/a.json"], ["*", ".git/config"], ["*", ".env"], [".*", ".git/hooks/pre-commit"],
  [".*/**", ".claude/settings.json"], [".*/**", "coltrane.layout.json"], ["**/.git", "sub/.git/config"],
  // `*.ext` at depth; slashless patterns match at any depth
  ["*.json", "a.json"], ["*.json", "sub/x.json"], ["*.json", ".coltrane/a.json"], ["*.ts", "deep/src/a.ts"],
  ["config", "config"], ["config", "sub/config"], ["config", ".git/config"], ["config", "config/x"],
  // anchored vs unanchored
  ["/config", "sub/config"], ["/config", "config"], ["src/*.ts", "deep/src/a.ts"], ["src/*.ts", "src/a.ts"],
  ["**/config", "a/b/config"], ["a/**/b", "a/x/y/b"], ["a/**/b", "a/b"],
  // directory covers its contents
  ["src/*", "src/a/b"], ["src", "src/a/b.ts"], ["src/", "src/a"], ["src/", "src"], [".claude/", ".claude/x"],
  ["src/**", "src/a/b.ts"], ["/src/**", "src/a"], ["a/b/**", "a/b/c/d"], ["x/**/", "x/y"],
  // ranges, single-character wildcards, literal names
  ["[a-c]*", "b"], ["docs/?.md", "docs/a.md"], ["docs/?.md", "docs/ab.md"], ["coltrane.layout.json", "coltrane.layout.json"],
  ["*.layout.json", "coltrane.layout.json"],
  // negation: a single-rule `!x` ignore never ignores anything — a negated grant grants nothing
  ["!src", "src"], ["!src/**", "src/a.ts"], ["!*.json", "a.json"],
  // CASE (round 6): the CLI builds its matcher with `ignore()` defaults — ignorecase: true — so a
  // grant's case never narrows or widens what it reaches (and macOS/Windows file systems fold case too).
  ["SRC/**", "src/a"], ["src/**", "SRC/A.ts"], ["**", ".GIT/config"], ["*.JSON", "a.json"], ["*.json", "A.JSON"],
  [".Claude/", ".claude/settings.json"], ["Config", ".git/config"], ["src/*", "SRC/A/B"], ["COLTRANE.LAYOUT.JSON", "coltrane.layout.json"],
];

describe("the engine's scope matcher agrees with the CLI's (ignore 7.0.5 + the CLI's Gn preprocessing)", () => {
  it("non-vacuity: the oracle itself says what the CLI measurably does on the dot-path seam", () => {
    expect(cliCovers("**", ".git/config"), "the oracle does not reach dot-dirs with ** — it is not the CLI's matcher").toBe(true);
    expect(cliCovers("*.json", ".coltrane/a.json")).toBe(true);
    expect(cliCovers("src/*", "src/a/b")).toBe(true);
    expect(cliCovers("/config", "sub/config")).toBe(false);
  });

  for (const [pattern, path] of TABLE) {
    it(`Write(${pattern}) on "${path}": engine and CLI agree`, () => {
      expect(grantCovers(pattern, path), `grantCovers("${pattern}", "${path}") disagrees with the CLI (${cliCovers(pattern, path)})`).toBe(cliCovers(pattern, path));
    });
  }

  it("a generated corpus of patterns × paths (dot-dirs, **, *.ext at depth, anchored/unanchored, trailing /) agrees", () => {
    const seg = fc.constantFrom("src", "a", "b", "config", ".git", ".claude", ".coltrane", ".env", "x.json", "y.ts", "hooks", "coltrane.layout.json", "SRC", ".GIT", ".Claude", "X.JSON", "Config");
    const pathArb = fc.array(seg, { minLength: 1, maxLength: 4 }).map((s) => s.join("/"));
    const pseg = fc.constantFrom("*", "**", "*.json", "*.ts", ".*", "src", "a", "config", "?", "[ab]*", ".git", ".claude", "x.*", "SRC", "*.JSON", ".GIT", "Config", "[AB]*");
    const patArb = fc.tuple(fc.boolean(), fc.array(pseg, { minLength: 1, maxLength: 3 }), fc.constantFrom("", "/", "/**"))
      .map(([lead, segs, tail]) => `${lead ? "/" : ""}${segs.join("/")}${tail}`)
      .filter((p) => p !== "/" && !/\*\*\*/.test(p));
    fc.assert(
      fc.property(patArb, pathArb, (pattern, path) => {
        // Judged by their own laws below: the CLI's rewrite of `x/**` onto `x` itself, a run of `**`
        // segments (which the rewrite collapses), and negated classes.
        if (namesItsOwnRoot(pattern, path) || negatedClass(pattern) || /(^|\/)\*\*\/\*\*(\/|$)/.test(pattern)) return true;
        const cli = cliCovers(pattern, path);
        if (grantCovers(pattern, path) !== cli) throw new Error(`grantCovers("${pattern}", "${path}") = ${!cli}, the CLI says ${cli}`);
        return true;
      }),
      { numRuns: 5000 },
    );
  });

  it("the CLI's own preprocessing is honoured: `./x`, `a//b`, and a run of `**` segments mean what the CLI makes them mean", () => {
    // `./**` is the sharpest of these: the CLI drops the `./` and reads `**` — every path, protected ones
    // included. An engine that reads `./**` literally covers nothing and (see the protected-path law)
    // denies nothing, while the CLI hands the seat the whole tree.
    for (const [pattern, path] of [["./**", ".git/config"], ["./src/**", "src/a.ts"], ["src//a", "src/a"], ["**/**", "src/src"], ["./*.json", ".coltrane/a.json"]] as const) {
      expect(cliCovers(pattern, path), `oracle sanity for ${pattern}`).toBe(true);
      expect(grantCovers(pattern, path), `grantCovers("${pattern}", "${path}") ignores the CLI's preprocessing — the CLI says true`).toBe(true);
    }
  });

  it("`x/**` covers `x` itself, as the CLI's Gn rewrite (`x/**` → `/x`) makes it", () => {
    for (const [pattern, path] of [["src/**", "src"], [".git/**", ".git"], [".*/**", ".claude"], ["a/b/**", "a/b"], ["*/*/**", "src/src"]] as const) {
      expect(cliCovers(pattern, path), `oracle sanity for ${pattern}`).toBe(true);
      expect(grantCovers(pattern, path), `grantCovers("${pattern}", "${path}") is narrower than the CLI — fail-closed at the gate, but a disagreement`).toBe(true);
    }
  });

  it("`[!…]` is a literal-`!` class in ignore 7.0.5 (negated ranges arrived in 7.0.6), exactly as the CLI reads it", () => {
    for (const [pattern, path] of [["[!a]*", "b"], ["[!a]*", "!x"], ["[!a]*", "a"]] as const) {
      expect(grantCovers(pattern, path), `grantCovers("${pattern}", "${path}") disagrees with the CLI's ignore 7.0.5 (${cliCovers(pattern, path)})`).toBe(cliCovers(pattern, path));
    }
  });
});
