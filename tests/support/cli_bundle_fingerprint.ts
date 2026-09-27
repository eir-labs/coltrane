// THE `ignore` BUNDLED IN THE INSTALLED CLAUDE CLI, FINGERPRINTED — so the scope oracle is tied to the
// real binary, not merely to the same npm package the engine imports.
//
// The CLI is a Bun single-file binary; its bundled `ignore` is minified, so no byte-for-byte comparison
// with the npm file is possible. What survives minification VERBATIM is (a) every regular-expression
// source the module compiles — `ignore`'s whole matching behaviour is its table of regex replacers — and
// (b) property names. The fingerprint of an `ignore` source is therefore:
//   · the set of regex-literal sources in its index.js, every one of which must appear in the binary, and
//   · for a fixed list of property names that appear or disappear across 7.x releases, whether each is
//     present — which must be the same in the dependency and in the binary.
// Measured by the drafter (27 Sep 2026) against CLI 2.1.283: `ignore` 7.0.5 matches; 7.0.4 differs
// (setupWindows), 7.0.6 differs (its repeated-`**/` regex), 7.0.7 and 7.0.10 differ (regexes and
// `_basenameOnly`), 5.3.2 differs (regexes, checkIgnore).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";

export const MARKER_NAMES = ["_basenameOnly", "_basenameCount", "setupWindows", "checkIgnore", "checkRegex"] as const;

/** Regex-literal sources in a JS source file (comments stripped first). */
export function regexSources(src: string): string[] {
  const s = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");
  const re = /(?<=[[(,=:!&|?{};]\s*|^\s*)\/(?![*/])((?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n[])+)\/[dgimsuy]*/gm;
  return [...new Set([...s.matchAll(re)].map((m) => m[1]!))];
}

export interface FingerprintComparison {
  regexCount: number;
  /** Regex sources of the dependency the binary does not contain. */
  missingInBinary: string[];
  /** Marker names whose presence differs between the dependency and the binary. */
  markerMismatches: string[];
}

export function compareBundledIgnore(dependencySource: string, binary: Buffer): FingerprintComparison {
  const srcs = regexSources(dependencySource);
  return {
    regexCount: srcs.length,
    missingInBinary: srcs.filter((x) => !binary.includes(Buffer.from(x))),
    markerMismatches: MARKER_NAMES.filter((n) => dependencySource.includes(n) !== binary.includes(Buffer.from(n))),
  };
}

/** The installed claude binary: CLAUDE_BIN, else `which claude` resolved. Undefined when absent. */
export function installedClaudeBinary(): string | undefined {
  const env = process.env["CLAUDE_BIN"];
  if (env) return existsSync(env) ? env : undefined;
  try {
    const p = realpathSync(execFileSync("which", ["claude"], { encoding: "utf8" }).trim());
    return existsSync(p) ? p : undefined;
  } catch {
    return undefined;
  }
}

export function readDependencyIgnore(): { version: string; source: string } {
  const root = new URL("../../node_modules/ignore/", import.meta.url);
  return {
    version: (JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as { version: string }).version,
    source: readFileSync(new URL("index.js", root), "utf8"),
  };
}
