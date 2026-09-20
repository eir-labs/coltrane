// THE RELEASE HISTORY IS COMPILED ONCE, NOT ON EVERY BUILD. (contract-release-compile-cache-v1)
//
// THE MEASURED PROBLEM (operator, 2026-09-19). `npm run build` is `tsc` + a copy + a chmod +
// `scripts/emit_releases.mjs`. Measured on the operator's machine, warm:
//
//     tsc                                 13s
//     scripts/emit_releases.mjs        3m 52s
//     npm run build                    4m 23s
//     npx vitest run <one test file>   5m 11s   (its tests execute in 753ms)
//
// `compileReleases` walks all 80 v* tags and, at each one, reads every surface: a `git show` per
// text surface plus one per `domain_types/*.json` — ~75 of those — so the compile spawns on the
// order of 6,000 git subprocesses. 79 of those 80 tags are IMMUTABLE: a tag's tree cannot change,
// so its record cannot change, and recompiling it is re-deriving a settled fact.
//
// It is not merely slow, it is load-bearing. `tests/_support/build_once.ts` is vitest's
// `globalSetup` and runs `npm run build` before ANY test file, so every law-running seat — the
// red-law drafter, `red-law-reviewer` (which runs every law), the builder, `change-verifier` —
// pays ~4 minutes per vitest invocation. The drafting gig that produced this session's laws ran
// vitest 5 times inside a 20-minute chair timeout, spent ~22 minutes of that budget recompiling
// release history, was SIGKILLed at the wall clock, and cost $73.37 that no ledger row recorded.
//
// THE CONTRACT: a compiled record NAMES the commit its tag resolved to, and `compileReleases`
// accepts previously-compiled records and REUSES the ones whose tag still resolves to the commit
// they name. A cached record whose commit no longer matches, or that names a tag the repository no
// longer holds, is never trusted. The pending record is never served from cache — HEAD moves.
//
// THESE LAWS ARE RED BY DESIGN. `ReleaseRecord.commit` does not exist and `compileReleases` takes
// no cache, so each law below fails on the CONTRACT rather than on a link error: the option is
// accepted-and-ignored today, which is exactly the shape that would otherwise pass unnoticed.
//
// The reuse laws work by POISONING a cached record with a sentinel (`laws.after = POISON`) that no
// compile could ever produce, then asserting whether the sentinel survives. A surviving sentinel
// proves the record was REUSED; a vanished one proves it was RECOMPILED. That makes reuse
// observable without timing, which is the only way this law can honestly go red when the wire is
// cut.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { compileReleases as compileReleasesImpl, surfacesAtTag } from "../src/releases.js";

type ReleaseRecord = {
  version: string;
  tag: string;
  commit?: string;
  date: string;
  commits: { sha: string; subject: string }[];
  laws: { before: number | null; after: number | null; files: number | null };
  pending: boolean;
};
type CompileOpts = {
  tree_root: string;
  pending?: { version: string };
  cache?: readonly ReleaseRecord[];
  deps?: { surfaces?: (root: string, tag: string) => unknown };
};
const compileReleases = (opts: CompileOpts): ReleaseRecord[] =>
  (compileReleasesImpl as unknown as (o: CompileOpts) => ReleaseRecord[])(opts);

/** A law/file count no real `scripts/laws.sh` in this fixture ever writes. Its survival is the
 *  only evidence of reuse that does not depend on a clock. */
const POISON = 987654;

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};
function newRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", dir]);
  return dir;
}
function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { env: GIT_ENV }).toString();
}
function writeIn(repo: string, path: string, content: string): void {
  const full = join(repo, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}
function commit(repo: string, subject: string, dateISO: string): string {
  git(repo, ["add", "-A"]);
  const env = { ...GIT_ENV, GIT_AUTHOR_DATE: dateISO, GIT_COMMITTER_DATE: dateISO };
  execFileSync("git", ["-C", repo, "commit", "--quiet", "-m", subject], { env });
  return execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { env: GIT_ENV }).toString().trim();
}

const mcpFile = (tools: string[]): string =>
  `import { obj } from "./genome_schema.js";\nexport const MCP_TOOLS = [\n` +
  tools.map((t) => `  { slug: ${JSON.stringify(t)}, category: "understand", input_schema: obj({ domain: "string" }) },`).join("\n") +
  `\n];\n`;
const cliFile = (flags: string[]): string =>
  `export const HELP = \`\n` + flags.map((f) => `  ${f} <v>    what ${f} does`).join("\n") + `\n\`;\n`;
const workerEnvFile = (names: string[]): string =>
  `export const WORKER_ENV_CONTRACT = [\n` +
  names.map((n) => `  { name: ${JSON.stringify(n)}, host: "store", role: "url", required: "always", meaning: "x" },`).join("\n") +
  `\n];\n`;
const domainTypeFile = (slug: string, version: number): string =>
  JSON.stringify({ slug, version, extends: "Artifact", schema: { type: "object", properties: {} } }, null, 2) + "\n";
const lawsFile = (laws: number, files: number): string =>
  `#!/usr/bin/env bash\nset -euo pipefail\nEXPECTED_LAWS="\${EXPECTED_LAWS:-${laws}}"\nEXPECTED_FILES="\${EXPECTED_FILES:-${files}}"\n`;

/** Three tags, each with a real surface change, so a recompile of any one of them is observable. */
function threeTagRepo(prefix = "relcache-"): string {
  const repo = newRepo(prefix);
  writeIn(repo, "src/mcp.ts", mcpFile(["type_resolve", "type_browse"]));
  writeIn(repo, "src/cli.ts", cliFile(["--input", "--depth"]));
  writeIn(repo, "src/worker_env.ts", workerEnvFile(["COLTRANE_STORE_URL"]));
  writeIn(repo, "domain_types/claim-draft.json", domainTypeFile("claim-draft", 1));
  writeIn(repo, "scripts/laws.sh", lawsFile(100, 10));
  commit(repo, "chore: seed the surface", "2026-01-01T00:00:00Z");
  git(repo, ["tag", "v0.1.0"]);

  writeIn(repo, "src/cli.ts", cliFile(["--input", "--depth", "--budget"]));
  writeIn(repo, "scripts/laws.sh", lawsFile(150, 12));
  commit(repo, "feat: a budget flag", "2026-02-01T00:00:00Z");
  git(repo, ["tag", "v0.2.0"]);

  writeIn(repo, "domain_types/claim-draft.json", domainTypeFile("claim-draft", 2));
  writeIn(repo, "scripts/laws.sh", lawsFile(200, 14));
  commit(repo, "feat: bump the claim-draft type", "2026-03-01T00:00:00Z");
  git(repo, ["tag", "v0.3.0"]);
  return repo;
}

const byTag = (rs: ReleaseRecord[], tag: string): ReleaseRecord | undefined => rs.find((r) => r.tag === tag);
/** A cache built from a real compile, with every record's law count poisoned. */
function poisonedCache(repo: string): ReleaseRecord[] {
  return compileReleases({ tree_root: repo }).map((r) => ({ ...r, laws: { ...r.laws, after: POISON } }));
}

describe("a compiled release record names the commit its tag resolved to", () => {
  it("O3 — every record carries `commit`, equal to what git resolves its tag to", () => {
    const repo = threeTagRepo("relcache-o3-");
    const records = compileReleases({ tree_root: repo });
    expect(records.length, "the fixture cuts three tags").toBe(3);
    for (const r of records) {
      const resolved = git(repo, ["rev-parse", `${r.tag}^{commit}`]).trim();
      expect(
        r.commit,
        `record ${r.tag} names no commit, so a cache entry for it cannot be validated without recompiling it — which is the whole cost this contract removes`,
      ).toBe(resolved);
    }
  }, 30_000);
});

describe("compileReleases reuses a cached record whose tag still resolves to the commit it names", () => {
  it("O1 — a matching cache entry is reused verbatim: the poisoned law count survives the compile", () => {
    const repo = threeTagRepo("relcache-o1-");
    const cache = poisonedCache(repo);
    const out = compileReleases({ tree_root: repo, cache });
    expect(out.map((r) => r.tag), "every tag is still reported").toEqual(["v0.1.0", "v0.2.0", "v0.3.0"]);
    for (const tag of ["v0.1.0", "v0.2.0", "v0.3.0"]) {
      expect(
        byTag(out, tag)!.laws.after,
        `${tag} was RECOMPILED although its cache entry named the commit the tag still resolves to — the cache is not being read`,
      ).toBe(POISON);
    }
  }, 30_000);

  it("O5 — a fully-cached compile reads NO surface at any tag; an uncached one reads every tag", () => {
    const repo = threeTagRepo("relcache-o5-");
    const cache = poisonedCache(repo);

    const cold: string[] = [];
    compileReleases({
      tree_root: repo,
      deps: { surfaces: (root, tag) => { cold.push(tag); return surfacesAtTag(root, tag); } },
    });
    expect(cold, "an uncached compile must read the surface at every tag").toEqual(["v0.1.0", "v0.2.0", "v0.3.0"]);

    const warm: string[] = [];
    compileReleases({
      tree_root: repo,
      cache,
      deps: { surfaces: (root, tag) => { warm.push(tag); return surfacesAtTag(root, tag); } },
    });
    expect(
      warm,
      "a fully-cached compile still read a surface — the ~75 git reads per tag are what this contract exists to stop spending",
    ).toEqual([]);
  }, 30_000);
});

describe("a cache entry is never trusted past the commit it names", () => {
  it("O2 — an entry whose commit no longer matches its tag is RECOMPILED, and the poison does not survive", () => {
    const repo = threeTagRepo("relcache-o2-");
    const cache = poisonedCache(repo).map((r) =>
      r.tag === "v0.2.0" ? { ...r, commit: "0".repeat(40) } : r,
    );
    const out = compileReleases({ tree_root: repo, cache });
    expect(
      byTag(out, "v0.2.0")!.laws.after,
      "v0.2.0's cache entry named a commit its tag does not resolve to and was trusted anyway — a stale record would then ship as history",
    ).not.toBe(POISON);
    expect(byTag(out, "v0.2.0")!.laws.after, "the recompiled record carries the count actually at the tag").toBe(150);
    expect(byTag(out, "v0.1.0")!.laws.after, "an untouched entry is still reused").toBe(POISON);
  }, 30_000);

  it("F1 — a cache entry naming a tag the repository no longer holds is DROPPED, never carried through", () => {
    const repo = threeTagRepo("relcache-f1-");
    const cache = [
      ...poisonedCache(repo),
      { version: "9.9.9", tag: "v9.9.9", commit: "1".repeat(40), date: "2020-01-01T00:00:00Z", commits: [], laws: { before: null, after: POISON, files: null }, pending: false },
    ];
    const out = compileReleases({ tree_root: repo, cache });
    expect(
      out.map((r) => r.tag),
      "a deleted or retagged release survived in the output because it sat in the cache — the repository, not the cache, says which releases exist",
    ).toEqual(["v0.1.0", "v0.2.0", "v0.3.0"]);
  }, 30_000);

  it("O6 — a cached PENDING record whose version has since been tagged is recompiled, not served as settled", () => {
    // The real scenario, and the only one in which the pending guard can matter. A document emitted
    // while v0.2.0 was still pending records it with `pending: true`. The tag is then cut at exactly
    // that commit. Now the entry's tag DOES resolve, and at the very commit it names — so the
    // commit check alone would happily reuse it, and a release that is settled would ship carrying
    // `pending: true` and the surface diff of a record compiled before its own tag existed.
    const repo = threeTagRepo("relcache-o6-");
    const v2commit = git(repo, ["rev-parse", "v0.2.0^{commit}"]).trim();
    const cache = poisonedCache(repo).map((r) => (r.tag === "v0.2.0" ? { ...r, commit: v2commit, pending: true } : r));
    const out = compileReleases({ tree_root: repo, cache });
    const v2 = byTag(out, "v0.2.0")!;
    expect(
      v2.pending,
      "a cached PENDING record was served for a tag that has since been cut — the release would ship marked pending forever",
    ).toBe(false);
    expect(v2.laws.after, "and it is recompiled from the tree, not reused").toBe(150);
    expect(byTag(out, "v0.1.0")!.laws.after, "a settled neighbour is still reused").toBe(POISON);
  }, 30_000);
});

describe("with no cache the compiler behaves exactly as it did", () => {
  it("F2 — an uncached compile over the same tree is byte-identical to one given an empty cache", () => {
    const repo = threeTagRepo("relcache-f2-");
    const none = compileReleases({ tree_root: repo });
    const empty = compileReleases({ tree_root: repo, cache: [] });
    expect(empty, "an empty cache must mean 'nothing to reuse', never a different compile").toEqual(none);
  }, 30_000);
});

describe("the emitter reaches the cache — a rebuild does not recompile settled history", () => {
  // THE REACH LAW. Everything above proves the cache WORKS; this proves it is CALLED. A cache no
  // caller passes is the defect class this repo keeps producing — a mechanism with passing laws and
  // nothing wired to it — and the only way to catch it is to drive the real entry point.
  it("O4 — scripts/emit_releases.mjs passes the document it is overwriting as the compile's cache", () => {
    const repo = threeTagRepo("relcache-o4-");
    const out = join(repo, "releases.json");
    const script = join(process.cwd(), "scripts", "emit_releases.mjs");

    execFileSync("node", [script, "--tree-root", repo, "--out", out], { env: GIT_ENV, stdio: "ignore" });
    const first = JSON.parse(readFileSync(out, "utf8")) as { releases: ReleaseRecord[] };
    expect(first.releases.map((r) => r.tag), "the first emit compiles the whole history").toEqual([
      "v0.3.0", "v0.2.0", "v0.1.0",
    ]);

    // Poison the emitted document, then emit again over it. A poisoned count that SURVIVES proves
    // the second run read this file and reused the records it holds; one that vanishes proves the
    // emitter recompiled all three tags and never looked.
    writeFileSync(
      out,
      JSON.stringify(
        { ...first, releases: first.releases.map((r) => ({ ...r, laws: { ...r.laws, after: POISON } })) },
        null,
        2,
      ) + "\n",
    );
    execFileSync("node", [script, "--tree-root", repo, "--out", out], { env: GIT_ENV, stdio: "ignore" });
    const second = JSON.parse(readFileSync(out, "utf8")) as { releases: ReleaseRecord[] };
    for (const tag of ["v0.1.0", "v0.2.0", "v0.3.0"]) {
      expect(
        second.releases.find((r) => r.tag === tag)!.laws.after,
        `the emitter recompiled ${tag} although its own document already held a record naming the commit the tag still resolves to — the cache exists but nothing hands it over`,
      ).toBe(POISON);
    }
  }, 30_000);

  it("F3 — an unreadable or absent cache document costs time, never correctness", () => {
    const repo = threeTagRepo("relcache-f3-");
    const out = join(repo, "releases.json");
    const script = join(process.cwd(), "scripts", "emit_releases.mjs");
    writeFileSync(out, "{ this is not json");
    execFileSync("node", [script, "--tree-root", repo, "--out", out], { env: GIT_ENV, stdio: "ignore" });
    const doc = JSON.parse(readFileSync(out, "utf8")) as { releases: ReleaseRecord[] };
    expect(doc.releases.map((r) => r.tag), "a torn cache is no cache — the history still emits in full").toEqual([
      "v0.3.0", "v0.2.0", "v0.1.0",
    ]);
    expect(doc.releases.find((r) => r.tag === "v0.2.0")!.laws.after, "and it is compiled from the tree").toBe(150);
  }, 30_000);
});
