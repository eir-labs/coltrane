/** THE PUBLISHING BOUNDARY, AS A GATE RATHER THAN A HABIT.
 *
 *  This repo is published. Some vocabulary, and some names, must not cross into it. That rule
 *  previously lived only in an operator's head and in an assistant's local notes — which is to say
 *  it had no failure mode. A rule that cannot fail is not enforced; it is merely remembered, and a
 *  remembered rule is one bad session away from a leak that is public the moment it is pushed.
 *
 *  THE LIST IS NOT IN THIS FILE, AND MUST NEVER BE. A denylist of forbidden terms, committed to a
 *  public repository, publishes exactly the terms it exists to protect — the gate would become the
 *  leak. So the mechanism splits: the SCANNER is public (it is only a string search, and reveals
 *  nothing), and the TERMS are supplied from outside the tree at scan time.
 *
 *  It follows that this module holds no default list, no example terms, and no test fixtures drawn
 *  from the real one. A contributor reading this file learns that a boundary exists and learns
 *  nothing about where it lies.
 */

import { readFileSync } from "node:fs";

/** Where the terms come from. A path OUTSIDE this repository — a private sibling checkout, or a
 *  CI-provisioned file written from a secret. Absent is a distinct state from empty, and the two
 *  are reported differently: see `scanBoundary`. */
export const BOUNDARY_LIST_ENV = "COLTRANE_BOUNDARY_TERMS";

/** One forbidden term and where it was found. The term is echoed back because the finding is
 *  reported to the operator who already holds the list — never written to a public artifact. A
 *  CI job that surfaces these must mask them or print only `path` and `line`. */
export interface BoundaryHit {
  readonly path: string;
  readonly line: number;
  readonly term: string;
}

export type BoundaryOutcome =
  /** The list was supplied and no term appears in the scanned content. */
  | { readonly status: "clean"; readonly terms: number; readonly files: number }
  /** The list was supplied and at least one term appears. */
  | { readonly status: "violation"; readonly terms: number; readonly files: number; readonly hits: readonly BoundaryHit[] }
  /** No list was supplied. NOT a pass — the check did not run. The caller decides whether that is
   *  fatal (CI, where the list is provisioned and its absence means the gate is broken) or a visible
   *  skip (a contributor's laptop, which is not the publishing boundary). */
  | { readonly status: "unavailable"; readonly reason: string };

/** Read the terms from the path in `env[BOUNDARY_LIST_ENV]`.
 *
 *  One term per line; blank lines and `#` comments ignored; matching is case-insensitive because a
 *  boundary that Title Case walks through is not a boundary. Terms are compared as plain substrings
 *  rather than regexes — a regex in a private list is an injection surface nobody reviews, and the
 *  rule being enforced is "this word does not appear", which needs nothing more. */
function loadTerms(env: NodeJS.ProcessEnv): readonly string[] | { readonly reason: string } {
  const path = env[BOUNDARY_LIST_ENV];
  if (!path) return { reason: `${BOUNDARY_LIST_ENV} is not set — no term list to scan against` };
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    return { reason: `${BOUNDARY_LIST_ENV} points at ${path}, which could not be read: ${String(e)}` };
  }
  const terms = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"))
    .map((l) => l.toLowerCase());
  if (terms.length === 0) return { reason: `${BOUNDARY_LIST_ENV} points at ${path}, which holds no terms` };
  return terms;
}

/** Scan supplied content against the private term list.
 *
 *  PURE IN ITS CONTENT INPUT: the caller decides what is in scope — tracked files, a staged diff, a
 *  single PR body — and passes `[path, text]` pairs. This module never walks the filesystem itself,
 *  so the same gate serves a pre-push hook, a CI job over the whole tree, and a check on one
 *  outbound artifact, with no second implementation to drift.
 *
 *  `env` is injected rather than read from `process.env` so a law can exercise every outcome —
 *  including `unavailable` — without mutating the ambient environment. */
export function scanBoundary(
  content: Iterable<readonly [path: string, text: string]>,
  env: NodeJS.ProcessEnv,
): BoundaryOutcome {
  const loaded = loadTerms(env);
  if (!Array.isArray(loaded)) return { status: "unavailable", reason: (loaded as { reason: string }).reason };
  const terms = loaded as readonly string[];

  const hits: BoundaryHit[] = [];
  let files = 0;
  for (const [path, text] of content) {
    files++;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const haystack = lines[i]!.toLowerCase();
      for (const term of terms) {
        if (haystack.includes(term)) hits.push({ path, line: i + 1, term });
      }
    }
  }
  return hits.length === 0
    ? { status: "clean", terms: terms.length, files }
    : { status: "violation", terms: terms.length, files, hits };
}

/** Render an outcome for an operator who HOLDS the list. Never use this to write a public artifact:
 *  it names the matched terms. A public surface gets `path:line` and a count, nothing more. */
export function formatOutcome(o: BoundaryOutcome): string {
  switch (o.status) {
    case "clean":
      return `boundary clean — ${o.files} file(s) scanned against ${o.terms} term(s)`;
    case "unavailable":
      return `boundary NOT CHECKED — ${o.reason}`;
    case "violation": {
      const lines = o.hits.map((h) => `  ${h.path}:${h.line}  ${h.term}`);
      return `boundary VIOLATION — ${o.hits.length} hit(s) across ${o.files} file(s):\n${lines.join("\n")}`;
    }
  }
}
