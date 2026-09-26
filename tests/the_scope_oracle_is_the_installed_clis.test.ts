// THE SCOPE ORACLE IS THE INSTALLED CLI'S — a CLI or dependency change that moves the matcher goes red.
//
// Blocking finding 5 of the non-author grade (#553): tests/support/cli_scope_oracle.ts imports the SAME
// `ignore` package the engine imports, and no law read the CLI. Swapping in ignore@7.0.7 left 95/95 oracle
// and spelling laws green — the oracle agreed with the engine because it WAS the engine's dependency.
//
// These laws tie the dependency to the binary the seats actually run (tests/support/cli_bundle_fingerprint.ts):
// every regex source of node_modules/ignore must be present in the installed claude binary, and the
// release-marker property names must agree. The binary is found by CLAUDE_BIN or `which claude`; without
// one the real comparison is SKIPPED and printed UNVERIFIED — but the comparator's power is proven on
// every host by the fixture laws below, which need no binary.
//
//   law                                                      kind         drives                                        plant
//   package.json pins ignore exactly, and it is installed     behavioural  package.json + node_modules/ignore           a caret range, or a bumped install
//   the installed binary bundles exactly the dependency's      behavioural  compareBundledIgnore over the installed      bump the dependency (npm i ignore@7.0.7), or point
//   ignore (regex sources + release markers)                               claude binary                                 CLAUDE_BIN at a binary bundling another ignore
//   control: the comparator accepts the dependency itself     behavioural  compareBundledIgnore                          —
//   the comparator REFUSES a binary bundling ignore 7.0.6     behavioural  compareBundledIgnore over a fixture binary     a comparator that ignores regex sources
//   the comparator REFUSES a binary bundling ignore 7.0.7     behavioural  same                                           a comparator that ignores release markers
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compareBundledIgnore, installedClaudeBinary, readDependencyIgnore } from "./support/cli_bundle_fingerprint.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const dep = readDependencyIgnore();

describe("the engine's `ignore` is exactly the one the installed CLI bundles", () => {
  it("package.json pins ignore EXACTLY, and node_modules holds that version", () => {
    const pin = (JSON.parse(readFileSync(`${ROOT}/package.json`, "utf8")) as { dependencies: Record<string, string> }).dependencies["ignore"];
    expect(pin, "ignore is not an exact runtime pin").toMatch(/^\d+\.\d+\.\d+$/);
    expect(dep.version, "the installed ignore is not the pinned one").toBe(pin);
  });

  const bin = installedClaudeBinary();
  if (!bin) console.warn("[UNVERIFIED] the_scope_oracle_is_the_installed_clis: no claude binary (CLAUDE_BIN unset, none on PATH) — the dependency was not compared with the CLI");
  it.skipIf(!bin)("the installed claude binary bundles exactly node_modules/ignore — every regex source present, every release marker agreeing", () => {
    const c = compareBundledIgnore(dep.source, readFileSync(bin!));
    expect(c.regexCount, "non-vacuity: the fingerprint has regexes to compare").toBeGreaterThan(15);
    expect(c.missingInBinary, `ignore@${dep.version}'s matching regexes are not in the CLI at ${bin} — the CLI's matcher is a different ignore`).toEqual([]);
    expect(c.markerMismatches, `release markers differ between ignore@${dep.version} and the CLI at ${bin}`).toEqual([]);
  });
});

describe("the comparator can go red (fixture binaries — no claude needed)", () => {
  it("control: a 'binary' that bundles the dependency's own source matches", () => {
    const c = compareBundledIgnore(dep.source, Buffer.from(dep.source));
    expect(c.missingInBinary).toEqual([]);
    expect(c.markerMismatches).toEqual([]);
  });

  it("a binary bundling ignore 7.0.6 (its repeated-`**/` rule) is refused", () => {
    const v706 = dep.source.replace("/^\\^*\\\\\\*\\\\\\*\\\\\\//", "/^\\^*(?:\\\\\\*\\\\\\*\\\\\\/)+/");
    expect(v706, "fixture construction: the 7.0.5 rule was not found to rewrite").not.toBe(dep.source);
    const c = compareBundledIgnore(dep.source, Buffer.from(v706));
    expect(c.missingInBinary.length, "the comparator accepted a binary whose ignore compiles a different rule").toBeGreaterThan(0);
  });

  it("a binary bundling ignore 7.0.7 (which adds _basenameOnly) is refused", () => {
    const v707 = `${dep.source}\nclass X { _basenameOnly = true; _basenameCount = 0 }`;
    const c = compareBundledIgnore(dep.source, Buffer.from(v707));
    expect(c.markerMismatches, "the comparator accepted a binary with 7.0.7's release markers").toEqual(expect.arrayContaining(["_basenameOnly"]));
  });
});
