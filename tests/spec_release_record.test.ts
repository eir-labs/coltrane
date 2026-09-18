// THE RELEASE RECORD, COMPILED FROM GIT — what a release changed is READ from the tree at its
// tag, never asserted. (contract-release-record-v1)
//
// THE MEASURED PROBLEM (operator, 2026-09-18). `.github/workflows/publish.yml` cuts a release on
// every push to main and derives the version from conventional-commit prefixes. Across
// v0.24.20..v0.24.31, 0 of 11 subjects carried any prefix, so all 75 tags are patches — including
// v0.24.31, which added a domain-type version, two CLI flags, a gig_dispatch argument and three
// refusal kinds. A changelog grouped by the bump would render one flat list and the bump cannot be
// trusted to say what changed. THE CONTRACT: the repo answers the question mechanically instead —
// `compileReleases({ tree_root })` reads, at each v* tag, the MCP tool registry (src/mcp.ts), the
// CLI help block (src/cli.ts), the worker env table (src/worker_env.ts), each domain type's version
// (domain_types/*.json) and the law/file counts (scripts/laws.sh), and reports a ReleaseRecord per
// tag: derived, deterministic, refusing rather than guessing.
//
// THESE LAWS ARE RED BY DESIGN: the compiler does not exist yet. `compileReleases` lives in a
// not-yet-written src/releases.ts, exported from src/index.ts. Each law reaches it REFLECTIVELY off
// the src/index.js namespace (which exists and compiles today) and LEADS with the assertion that the
// export is absent, stating the contract's reason — so the file COLLECTS and every law fails on the
// CONTRACT, not on an ESM link error or a bare TypeError. When the builder adds the compiler these
// laws go green by describing the truth, not by being weakened.
//
// Every git call runs in a temporary repository the law builds itself (two or three tags over files
// shaped like src/mcp.ts, src/cli.ts, src/worker_env.ts, domain_types/*.json and scripts/laws.sh).
// NO law reads the coltrane repository's own history, invokes a model, or reaches the network.
// See docs/specs/release-record.red-spec.md.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import * as coltrane from "../src/index.js";

// ── the release-record shape the compiler MUST return (O1/O2). Declared here so the laws are typed
//    against the contract, not against whatever the builder happens to produce. ──
interface Commit {
  sha: string;
  subject: string;
}
type SurfaceList = { added: string[]; removed: string[] } | null;
interface ReleaseRecord {
  version: string;
  tag: string;
  date: string;
  commits: Commit[];
  bump: "major" | "minor" | "patch";
  laws: { before: number | null; after: number | null; files: number | null };
  surface: {
    mcp_tools: SurfaceList;
    mcp_tool_args: SurfaceList;
    cli_flags: SurfaceList;
    env_vars: SurfaceList;
    domain_types: SurfaceList;
  };
}
type CompileReleases = (opts: { tree_root: string }) => ReleaseRecord[];

const api = coltrane as unknown as Record<string, unknown>;

/** THE LEADING, CONTRACT-STATING ASSERTION. Red today because src/releases.ts is unwritten and
 *  src/index.ts re-exports nothing named `compileReleases`; green once the compiler exists. Failing
 *  here aborts the `it`, so no downstream assertion can pass on a spurious "not a function". */
function compiler(): CompileReleases {
  const fn = api["compileReleases"];
  expect(
    typeof fn,
    "src/index.ts must re-export compileReleases({ tree_root }) from a new src/releases.ts — the " +
      "release-record compiler that derives what each tag changed from the tree. It does not exist " +
      "yet, so a release's surface cannot be derived and the changelog would fall back to a bump " +
      "that names nothing.",
  ).toBe("function");
  return fn as CompileReleases;
}

const SURFACE_KEYS = ["mcp_tools", "mcp_tool_args", "cli_flags", "env_vars", "domain_types"] as const;

// ── temp-git-repo helpers (the workspace.test.ts / spec_records_by_address house pattern) ──
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
function rmIn(repo: string, path: string): void {
  rmSync(join(repo, path), { force: true });
}
/** Commit every current change at a pinned date, so both the committer date (what the record's
 *  `date` reads) and the commit ordering are deterministic. */
function commit(repo: string, subject: string, dateISO: string, body?: string): string {
  git(repo, ["add", "-A"]);
  const env = { ...GIT_ENV, GIT_AUTHOR_DATE: dateISO, GIT_COMMITTER_DATE: dateISO };
  const args = ["-C", repo, "commit", "--quiet", "-m", subject];
  if (body !== undefined) args.push("-m", body);
  execFileSync("git", args, { env });
  return execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { env: GIT_ENV }).toString().trim();
}
function tag(repo: string, name: string): void {
  git(repo, ["tag", name]);
}

// ── file shapes, faithful to the real modules the surface is read from ──
const mcpFile = (tools: { slug: string; args: string[] }[]): string =>
  `import { obj } from "./genome_schema.js";\n` +
  `export const MCP_TOOLS = [\n` +
  tools
    .map(
      (t) =>
        `  { slug: ${JSON.stringify(t.slug)}, category: "understand", input_schema: obj({ ` +
        t.args.map((a) => `${a}: "string"`).join(", ") +
        ` }) },`,
    )
    .join("\n") +
  `\n];\n`;
const cliFile = (flags: string[]): string =>
  `export const HELP = \`\n` +
  flags.map((f) => `  ${f} <v>    what ${f} does`).join("\n") +
  `\n\`;\n`;
const workerEnvFile = (names: string[]): string =>
  `export const WORKER_ENV_CONTRACT = [\n` +
  names.map((n) => `  { name: ${JSON.stringify(n)}, host: "store", role: "url", required: "always", meaning: "x" },`).join("\n") +
  `\n];\n`;
const domainTypeFile = (slug: string, version: number): string =>
  JSON.stringify({ slug, version, extends: "Artifact", schema: { type: "object", properties: {} } }, null, 2) + "\n";
const lawsFile = (laws: number, files: number): string =>
  `#!/usr/bin/env bash\nset -euo pipefail\n` +
  `EXPECTED_LAWS="\${EXPECTED_LAWS:-${laws}}"\n` +
  `EXPECTED_FILES="\${EXPECTED_FILES:-${files}}"\n`;

/** The v0.1.0 surface: two tools, two flags, two env vars, one domain type, laws 100/files 10. */
function writeSurfaceV1(repo: string): void {
  writeIn(repo, "src/mcp.ts", mcpFile([
    { slug: "type_resolve", args: ["core_type", "extends"] },
    { slug: "type_browse", args: ["domain"] },
  ]));
  writeIn(repo, "src/cli.ts", cliFile(["--input", "--depth"]));
  writeIn(repo, "src/worker_env.ts", workerEnvFile(["COLTRANE_STORE_URL", "COLTRANE_STORE_ANON"]));
  writeIn(repo, "domain_types/claim-draft.json", domainTypeFile("claim-draft", 1));
  writeIn(repo, "scripts/laws.sh", lawsFile(100, 10));
}
/** The v0.2.0 surface: type_browse -> agent_browse, +--budget, +COLTRANE_SERVICE_URL,
 *  claim-draft@1 -> @2, laws 150/files 12. */
function writeSurfaceV2(repo: string): void {
  writeIn(repo, "src/mcp.ts", mcpFile([
    { slug: "type_resolve", args: ["core_type", "extends"] },
    { slug: "agent_browse", args: ["domain", "primitive"] },
  ]));
  writeIn(repo, "src/cli.ts", cliFile(["--input", "--depth", "--budget"]));
  writeIn(repo, "src/worker_env.ts", workerEnvFile(["COLTRANE_STORE_URL", "COLTRANE_STORE_ANON", "COLTRANE_SERVICE_URL"]));
  writeIn(repo, "domain_types/claim-draft.json", domainTypeFile("claim-draft", 2));
  writeIn(repo, "scripts/laws.sh", lawsFile(150, 12));
}

/** A two-tag fixture: v0.1.0 (the v1 surface) then v0.2.0 (the v2 surface), with a real commit
 *  range and pinned dates. Returns the tree_root. */
function twoTagRepo(): string {
  const repo = newRepo("relrec-two-");
  writeSurfaceV1(repo);
  commit(repo, "chore: seed the surface", "2026-01-01T00:00:00Z");
  tag(repo, "v0.1.0");
  writeSurfaceV2(repo);
  commit(repo, "feat: swap type_browse for agent_browse", "2026-02-01T00:00:00Z");
  commit(repo, "chore: bump the law counts", "2026-02-02T00:00:00Z");
  tag(repo, "v0.2.0");
  return repo;
}

const isSorted = (a: string[]): boolean => JSON.stringify(a) === JSON.stringify([...a].sort());

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("release record — one record per tag, oldest first (O1)", () => {
  it("O1 — returns a ReleaseRecord per v* tag, oldest first, with the whole shape filled", () => {
    const compileReleases = compiler();
    const repo = twoTagRepo();
    const records = compileReleases({ tree_root: repo });

    expect(records.map((r) => r.tag), "one record per tag, oldest first").toEqual(["v0.1.0", "v0.2.0"]);
    const first = records[0]!;
    const second = records[1]!;

    // version is the semver, tag is the ref — the two are distinct fields for a reason.
    expect(first.version, "version is the tag without its v-prefix").toBe("0.1.0");
    expect(first.tag).toBe("v0.1.0");

    // date is the tag's commit date, ISO — equal in instant to the date the tag's commit was made.
    expect(new Date(first.date).getTime(), "date is the tag's commit date").toBe(new Date("2026-01-01T00:00:00Z").getTime());
    expect(Number.isNaN(new Date(second.date).getTime()), "date parses as an ISO instant").toBe(false);

    // commits: the range since the previous tag, oldest first. v0.2.0 carries its two commits;
    // the earliest tag carries every commit up to it (here just the seed).
    expect(first.commits.map((c) => c.subject)).toEqual(["chore: seed the surface"]);
    expect(second.commits.map((c) => c.subject)).toEqual([
      "feat: swap type_browse for agent_browse",
      "chore: bump the law counts",
    ]);
    for (const c of second.commits) expect(c.sha, "each commit carries a real sha").toMatch(/^[0-9a-f]{7,40}$/);
  });

  it("O1 — the earliest tag's `before` law count is null (not 0); later tags chain before<-after", () => {
    const compileReleases = compiler();
    const records = compileReleases({ tree_root: twoTagRepo() });
    const first = records[0]!;
    const second = records[1]!;

    // NULL, not 0: there is no predecessor to read a count from, and 0 would read as "the suite was
    // empty the day before", a claim the tree never makes.
    expect(first.laws.before, "the earliest tag has no predecessor — before is null, never 0").toBeNull();
    expect(first.laws.after, "after is read from scripts/laws.sh at v0.1.0").toBe(100);
    expect(first.laws.files, "files is read from scripts/laws.sh at v0.1.0").toBe(10);

    expect(second.laws.before, "a later tag's before is the predecessor's after").toBe(100);
    expect(second.laws.after, "after is read at v0.2.0").toBe(150);
    expect(second.laws.files).toBe(12);
  });

  it("O1 — bump is present and, when the range carries a feat:, reads minor", () => {
    const compileReleases = compiler();
    const records = compileReleases({ tree_root: twoTagRepo() });
    // v0.2.0's range carries `feat: …`, so the bump derived the next_version.mjs way is minor —
    // even though both tag NAMES (v0.1.0 -> v0.2.0) are a minor bump only by coincidence.
    expect(records[1]!.bump, "a feat: in the range derives a minor bump").toBe("minor");
    expect(["major", "minor", "patch"]).toContain(records[0]!.bump);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("release record — the surface an integrator sees (O2)", () => {
  it("O2 — surface names mcp_tools/mcp_tool_args/cli_flags/env_vars/domain_types as sorted added/removed strings", () => {
    const compileReleases = compiler();
    const records = compileReleases({ tree_root: twoTagRepo() });
    const s = records[1]!.surface;

    // every surface key present, each an {added, removed} of plain strings, both sorted.
    for (const key of SURFACE_KEYS) {
      const list = s[key];
      expect(list, `surface.${key} must be present`).not.toBeNull();
      const l = list!;
      expect(Array.isArray(l.added) && Array.isArray(l.removed), `surface.${key} has added/removed arrays`).toBe(true);
      for (const v of [...l.added, ...l.removed]) expect(typeof v, `surface.${key} entries are plain strings`).toBe("string");
      expect(isSorted(l.added), `surface.${key}.added is sorted`).toBe(true);
      expect(isSorted(l.removed), `surface.${key}.removed is sorted`).toBe(true);
    }

    // the specific deltas v0.1.0 -> v0.2.0.
    expect(s.mcp_tools).toEqual({ added: ["agent_browse"], removed: ["type_browse"] });
    // args are "<slug>.<argument>"; type_resolve's two args are unchanged and appear in neither list.
    expect(s.mcp_tool_args).toEqual({
      added: ["agent_browse.domain", "agent_browse.primitive"],
      removed: ["type_browse.domain"],
    });
    expect(s.cli_flags).toEqual({ added: ["--budget"], removed: [] });
    expect(s.env_vars).toEqual({ added: ["COLTRANE_SERVICE_URL"], removed: [] });
    // a version bump reads as one removed and one added: "<slug>@<version>".
    expect(s.domain_types).toEqual({ added: ["claim-draft@2"], removed: ["claim-draft@1"] });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("release record — read at the tag, never the working tree (O3)", () => {
  it("O3 — a dirty working tree does not change an already-cut tag's record (git show <tag>:<path>)", () => {
    const compileReleases = compiler();
    const repo = newRepo("relrec-o3-");
    writeSurfaceV1(repo);
    commit(repo, "chore: seed", "2026-01-01T00:00:00Z");
    tag(repo, "v0.1.0");

    const before = compileReleases({ tree_root: repo });

    // Now MUTATE the working tree — add a tool, a flag, an env var — but DO NOT commit or tag it.
    // A record compiled today must equal the record compiled the day the tag was cut, so this
    // uncommitted surface must not leak into v0.1.0's record.
    writeIn(repo, "src/mcp.ts", mcpFile([
      { slug: "type_resolve", args: ["core_type", "extends"] },
      { slug: "type_browse", args: ["domain"] },
      { slug: "smuggled_tool", args: ["sneaky"] },
    ]));
    writeIn(repo, "src/cli.ts", cliFile(["--input", "--depth", "--smuggled"]));

    const after = compileReleases({ tree_root: repo });
    expect(after, "the working-tree edit leaked into an already-cut tag's record — it was read from the tree, not from git show <tag>").toEqual(before);
    // and specifically the smuggled surface is nowhere in the record.
    expect(JSON.stringify(after)).not.toMatch(/smuggled/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("release record — deterministic and stable under later tags (I1)", () => {
  it("I1 — compiling twice is deeply equal, and a tag's record is unchanged when a later tag is added", () => {
    const compileReleases = compiler();
    const repo = twoTagRepo();

    const runA = compileReleases({ tree_root: repo });
    const runB = compileReleases({ tree_root: repo });
    expect(runB, "compiling twice returns deeply equal records").toEqual(runA);

    // Add a THIRD tag with further changes, then compile again: the first two records must be
    // byte-for-byte the same objects as the first run's.
    writeIn(repo, "src/mcp.ts", mcpFile([
      { slug: "type_resolve", args: ["core_type", "extends"] },
      { slug: "agent_browse", args: ["domain", "primitive"] },
      { slug: "chart_browse", args: ["venue"] },
    ]));
    writeIn(repo, "scripts/laws.sh", lawsFile(200, 14));
    commit(repo, "feat: add chart_browse", "2026-03-01T00:00:00Z");
    tag(repo, "v0.3.0");

    const runC = compileReleases({ tree_root: repo });
    expect(runC.length, "the third tag appears").toBe(3);
    expect(runC.slice(0, 2), "the first two records do not change when a later tag is added").toEqual(runA);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("release record — a no-op release says so explicitly (I2)", () => {
  it("I2 — a tag whose only commit edits a comment returns every surface list present and empty", () => {
    const compileReleases = compiler();
    const repo = newRepo("relrec-i2-");
    writeSurfaceV1(repo);
    commit(repo, "chore: seed", "2026-01-01T00:00:00Z");
    tag(repo, "v0.1.0");

    // The only change: a comment appended to src/mcp.ts. No slug, arg, flag, env var, domain-type
    // version or law count moves.
    writeIn(repo, "src/mcp.ts", mcpFile([
      { slug: "type_resolve", args: ["core_type", "extends"] },
      { slug: "type_browse", args: ["domain"] },
    ]) + "// a clarifying comment, changing nothing an integrator can see\n");
    commit(repo, "docs: clarify a comment", "2026-02-01T00:00:00Z");
    tag(repo, "v0.2.0");

    const records = compileReleases({ tree_root: repo });
    expect(records.map((r) => r.tag), "the no-op release is still RETURNED, not omitted").toEqual(["v0.1.0", "v0.2.0"]);
    const s = records[1]!.surface;
    for (const key of SURFACE_KEYS) {
      expect(s[key], `surface.${key} is PRESENT (not null) on a no-op release — an empty list means "nothing changed", not "unknown"`).toEqual({ added: [], removed: [] });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("release record — the bump is DERIVED, not read from version numbers (I3)", () => {
  it("I3 — feat:->minor, BREAKING-CHANGE:->major, plain->patch, whatever the tag names say", () => {
    const compileReleases = compiler();
    const repo = newRepo("relrec-i3-");
    // All three tags are consecutive PATCH-looking names (v0.1.0/.1/.2). The bump must come from the
    // commit subjects, not from the numbers — so a patch-named tag can still report minor or major.
    writeSurfaceV1(repo);
    commit(repo, "chore: seed", "2026-01-01T00:00:00Z");
    tag(repo, "v0.1.0"); // earliest range: a plain chore -> patch
    writeIn(repo, "README.md", "a\n");
    commit(repo, "feat: add a flag", "2026-02-01T00:00:00Z");
    tag(repo, "v0.1.1"); // feat: in range -> minor
    writeIn(repo, "README.md", "b\n");
    commit(repo, "refactor: reshape a call", "2026-03-01T00:00:00Z", "BREAKING-CHANGE: drop an argument");
    tag(repo, "v0.1.2"); // BREAKING-CHANGE trailer -> major

    const records = compileReleases({ tree_root: repo });
    expect(records.map((r) => r.tag)).toEqual(["v0.1.0", "v0.1.1", "v0.1.2"]);
    expect(records[0]!.bump, "a plain chore range is a patch").toBe("patch");
    expect(records[1]!.bump, "a feat: range is a minor, though the tag name only ticked the patch digit").toBe("minor");
    expect(records[2]!.bump, "a BREAKING-CHANGE: trailer is a major, though the tag name only ticked the patch digit").toBe("major");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("release record — an absent or unparseable surface file is null, not empty (F1)", () => {
  it("F1 — a surface file ABSENT at a tag makes THAT list null; the rest of the record still compiles", () => {
    const compileReleases = compiler();
    const repo = newRepo("relrec-f1a-");
    // v0.1.0 predates worker_env.ts entirely: it does not exist at this tag.
    writeIn(repo, "src/mcp.ts", mcpFile([{ slug: "type_resolve", args: ["core_type"] }]));
    writeIn(repo, "src/cli.ts", cliFile(["--input"]));
    writeIn(repo, "domain_types/claim-draft.json", domainTypeFile("claim-draft", 1));
    writeIn(repo, "scripts/laws.sh", lawsFile(100, 10));
    commit(repo, "chore: seed without worker_env", "2026-01-01T00:00:00Z");
    tag(repo, "v0.1.0");
    // v0.2.0 introduces worker_env.ts.
    writeIn(repo, "src/worker_env.ts", workerEnvFile(["COLTRANE_STORE_URL"]));
    commit(repo, "feat: add the worker env contract", "2026-02-01T00:00:00Z");
    tag(repo, "v0.2.0");

    const records = compileReleases({ tree_root: repo });
    const first = records[0]!;
    // NULL — the file the env_vars list is read from does not exist at v0.1.0 — distinguishable from
    // an empty list, which would falsely claim "present and nothing changed".
    expect(first.surface.env_vars, "env_vars is null at a tag that predates src/worker_env.ts").toBeNull();
    // the rest of the record still compiles: other surfaces are present, not null.
    expect(first.surface.mcp_tools, "an absent env file does not null the whole surface").not.toBeNull();
    expect(first.laws.after, "the record still compiles around the null list").toBe(100);
    // and once the file exists, the list is present again.
    expect(records[1]!.surface.env_vars, "present at the tag that introduced it").not.toBeNull();
  });

  it("F1 — a surface file UNPARSEABLE at a tag makes THAT list null; the rest still compiles", () => {
    const compileReleases = compiler();
    const repo = newRepo("relrec-f1b-");
    writeSurfaceV1(repo);
    commit(repo, "chore: seed", "2026-01-01T00:00:00Z");
    tag(repo, "v0.1.0");
    // v0.2.0 corrupts src/mcp.ts: no MCP_TOOLS array can be parsed out of it.
    writeIn(repo, "src/mcp.ts", "export const NOT_THE_REGISTRY = 42; // no MCP_TOOLS here\n");
    commit(repo, "chore: garble mcp.ts", "2026-02-01T00:00:00Z");
    tag(repo, "v0.2.0");

    const records = compileReleases({ tree_root: repo });
    const second = records[1]!;
    expect(second.surface.mcp_tools, "an unparseable mcp.ts nulls mcp_tools (not an empty list)").toBeNull();
    expect(second.surface.mcp_tool_args, "and its args list too").toBeNull();
    // other surfaces read from other files still compile.
    expect(second.surface.cli_flags, "an unparseable mcp.ts does not null the CLI surface").not.toBeNull();
    expect(second.laws.after).toBe(150);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("release record — refuses a non-repo or a tagless repo by NAME (F2)", () => {
  it("F2 — a tree_root that is not a git repository throws, naming that it found no repository", () => {
    const compileReleases = compiler();
    const notARepo = mkdtempSync(join(tmpdir(), "relrec-f2a-"));
    writeIn(notARepo, "README.md", "not a repo\n");
    let threw: unknown;
    try {
      compileReleases({ tree_root: notARepo });
    } catch (e) {
      threw = e;
    }
    expect(threw, "a non-repo must throw, never return []").toBeInstanceOf(Error);
    expect(String((threw as Error).message), "the refusal names that it found no git repository").toMatch(/repositor/i);
  });

  it("F2 — a git repository with NO v* tag throws naming the absent tags — never returns [] as if there were no releases", () => {
    const compileReleases = compiler();
    const repo = newRepo("relrec-f2b-");
    writeSurfaceV1(repo);
    commit(repo, "chore: seed but never tag", "2026-01-01T00:00:00Z");
    // deliberately NO tag.
    let threw: unknown;
    try {
      compileReleases({ tree_root: repo });
    } catch (e) {
      threw = e;
    }
    expect(threw, "a tagless repo must THROW — an empty list would read as 'this project has no releases', a different and false claim").toBeInstanceOf(Error);
    expect(String((threw as Error).message), "the refusal names the absent v* tags").toMatch(/tag/i);
  });
});
