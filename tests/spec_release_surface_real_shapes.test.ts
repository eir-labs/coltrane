// THE SURFACE PARSERS READ THE SHAPES THIS REPOSITORY ACTUALLY WRITES — and a surface they
// cannot read is LOUD, not silent. (contract-release-surface-real-shapes-v1)
//
// THE MEASURED PROBLEM. The compiler built at dd12c2c (src/releases.ts) compiles all 75 releases,
// and for v0.24.31 it returned `mcp_tools: null`, `mcp_tool_args: null` and `cli_flags: null` —
// three of the five surfaces, silently, on the release that in fact added a `gig_dispatch` argument
// and two CLI flags. Its laws (tests/spec_release_record.test.ts) pass because their fixtures use
// SIMPLIFIED declaration shapes no real module uses. The real shapes, read at HEAD:
//   · src/mcp.ts declares `const TOOL_DEFS: readonly Omit<MCPToolDef, "description">[] = [` with
//     entries `{ slug: "type_resolve", category: "understand", input_schema: obj({ core_type: ... }) }`
//     and exports `export const MCP_TOOLS: readonly MCPToolDef[] = TOOL_DEFS.map((t) => {` — so the
//     parser's `export const MCP_TOOLS\s*=\s*\[` matches NOTHING and the slugs live in a
//     differently-named array (src/releases.ts:92,95).
//   · src/cli.ts has NO `HELP` constant: its flags are lines under an `Options` heading inside a
//     template literal named `USAGE` (src/cli.ts:51,91-106). The parser's `export const HELP\b`
//     matches nothing (src/releases.ts:110).
//   · src/worker_env.ts declares `export const WORKER_ENV_CONTRACT: readonly WorkerEnvVar[] = [` and
//     is the ONE surface that parsed — because its check is a bare identifier match
//     (src/releases.ts:122), which is itself a latent silent-wrong: a file that MENTIONS the
//     contract but declares no entries reads as the previous release's list wiped, not as unread.
//
// A `null` that means "could not tell" is indistinguishable, in a rendered changelog, from a release
// that changed no tools — the absence stands in for a value, the exact defect class this engine
// refuses everywhere else. So the fix has two halves: (1) the parsers read the REAL declaration
// shapes (and keep accepting the simplified ones the control fixtures use), and (2) a surface that
// genuinely cannot be read is named in a `surface_unread` list on the record, so a changelog can say
// "could not read the tool registry here" instead of showing a silent gap.
//
// THESE LAWS ARE RED BY DESIGN. `compileReleases` EXISTS, so the leading assertion is green — the RED
// is in the surface behaviour: the byte-faithful fixtures below are copied VERBATIM from src/mcp.ts,
// src/cli.ts and src/worker_env.ts at HEAD, and today's parsers return `null` on them, and no
// `surface_unread` field exists. When the builder teaches the parsers the real shapes and adds the
// diagnostic, these laws go green by describing the truth, not by being weakened.
//
// Every git call runs in a temporary repository the law builds itself; NO law reads the coltrane
// repository's own history, invokes a model, or reaches the network. tests/spec_release_record.test.ts
// is the CONTROL — its simplified shapes must keep parsing (I1). See
// docs/specs/release-surface-real-shapes.red-spec.md.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import * as coltrane from "../src/index.js";

// ── the record shape the compiler MUST return. Identical to the control's, PLUS `surface_unread`
//    (F1) — declared here so the laws are typed against the contract, not against what exists today. ──
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
  /** F1 — the surfaces that were PRESENT at the tag but yielded no entry. Named so a changelog can
   *  say "could not read the tool registry here" instead of showing a silent gap. */
  surface_unread: string[];
}
type CompileReleases = (opts: { tree_root: string }) => ReleaseRecord[];

const api = coltrane as unknown as Record<string, unknown>;

/** THE LEADING, MECHANISM-STATING ASSERTION. compileReleases already exists (green here); the RED is
 *  in the surface behaviour the laws below assert. Failing here would abort the `it` before any
 *  surface assertion could pass on a spurious "not a function". */
function compiler(): CompileReleases {
  const fn = api["compileReleases"];
  expect(
    typeof fn,
    "src/index.ts must re-export compileReleases({ tree_root }) from src/releases.ts — the release-record compiler whose surface parsers this contract governs.",
  ).toBe("function");
  return fn as CompileReleases;
}

// ── temp-git-repo helpers (the spec_release_record.test.ts house pattern) ──
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
function commit(repo: string, subject: string, dateISO: string): void {
  git(repo, ["add", "-A"]);
  const env = { ...GIT_ENV, GIT_AUTHOR_DATE: dateISO, GIT_COMMITTER_DATE: dateISO };
  execFileSync("git", ["-C", repo, "commit", "--quiet", "-m", subject], { env });
}
function tag(repo: string, name: string): void {
  git(repo, ["tag", name]);
}
function recordFor(records: ReleaseRecord[], t: string): ReleaseRecord {
  const r = records.find((x) => x.tag === t);
  if (!r) throw new Error(`no record for ${t}`);
  return r;
}

// ── BYTE-FAITHFUL src/mcp.ts. The declaration line, the three entries and the .map() export are
//    copied VERBATIM from src/mcp.ts at HEAD (lines 44, 45, 46, 58, 420). The simplified control
//    fixture writes `export const MCP_TOOLS = [`; the REAL module never does. ──
const MCP_HEADER = 'const TOOL_DEFS: readonly Omit<MCPToolDef, "description">[] = [';
const MCP_FOOTER =
  "];\n" +
  "export const MCP_TOOLS: readonly MCPToolDef[] = TOOL_DEFS.map((t) => {\n" +
  '  const description = "d";\n' +
  "  return { ...t, description };\n" +
  "});\n";
const E_TYPE_RESOLVE =
  '  { slug: "type_resolve",                  category: "understand", input_schema: obj({ core_type: "string", extends: "string", domain: "string", required_fields: "array" }), output_schema: obj({ action: "string", candidates: "array", recommendation: "object" }) },';
const E_TYPE_BROWSE =
  '  { slug: "type_browse",                   category: "understand", input_schema: obj({ domain: "string", extends: "string", status: "string", min_usage: "number" }), output_schema: obj({ types: "array", stats: "object" }) },';
const E_AGENT_BROWSE =
  '  { slug: "agent_browse",                  category: "understand", input_schema: obj({ domain: "string", primitive: "string" }), output_schema: obj({ agents: "array", count: "number" }) },';
const E_AGENT_BROWSE_DOMAIN_ONLY =
  '  { slug: "agent_browse",                  category: "understand", input_schema: obj({ domain: "string" }), output_schema: obj({ agents: "array", count: "number" }) },';
function mcpFaithful(entries: string[]): string {
  return MCP_HEADER + "\n" + entries.join("\n") + "\n" + MCP_FOOTER;
}
/** The simplified shape the CONTROL fixture uses — must keep parsing (I1). */
const MCP_SIMPLIFIED =
  'export const MCP_TOOLS = [\n' +
  '  { slug: "type_resolve", category: "understand", input_schema: obj({ core_type: "string", extends: "string" }) },\n' +
  "];\n";

// ── BYTE-FAITHFUL src/cli.ts. `export const USAGE = ` + a template literal named USAGE (NOT HELP),
//    carrying the `${COLTRANE_VERSION}` interpolation, two usage lines that contain `--` tokens NOT
//    at the start of the line (`--check`, `--any`, `--residency`), an `Options` heading, and the
//    flag lines — all copied from src/cli.ts at HEAD (lines 51, 73, 81, 91-96, 106). The `${...}` and
//    `--check` in a double-quoted JS array element are literal text, not interpolation nor a flag. ──
function cliFaithful(optionLines: string[]): string {
  const body = [
    "coltrane ${COLTRANE_VERSION}",
    "",
    "  coltrane work --check                  report whether this box's drain environment is configured",
    "  coltrane reside [--any|--residency <id>]  hold a residency: claim a seat, ack its channel in",
    "",
    "Options",
    ...optionLines,
  ].join("\n");
  return 'import { COLTRANE_VERSION } from "./version.js";\n\nexport const USAGE = `' + body + "`;\n";
}
const CLI_INPUT = "  --input <json|@file|->                dispatch payload; @file reads a file, - reads stdin";
const CLI_DEPTH = "  --depth <skim|standard|deep>          tighten the per-chair turn cap";
const CLI_EFFORT = "  --effort <low|medium|high|xhigh|max>  the reasoning effort the seat runs at";
const CLI_BUDGET = "  --budget <dollars>                    per-gig ceiling; the run stops when it is gone";
const CLI_HELP = "  --help, --version";
/** The simplified shape the CONTROL fixture uses — `export const HELP` — must keep parsing (I1). */
const CLI_SIMPLIFIED = "export const HELP = `\n  --input <v>    what --input does\n  --depth <v>    what --depth does\n`;\n";

// ── BYTE-FAITHFUL src/worker_env.ts. The interface (whose `name: string;` type field carries NO
//    quotes, so it is not mistaken for an entry) and the typed contract array with two entries,
//    copied from src/worker_env.ts at HEAD (lines 43-52, 59-75). ──
const ENV_HEADER = [
  'export type EnvHost = "service" | "store" | "model" | "none";',
  "export interface WorkerEnvVar {",
  "  name: string;",
  "  host: EnvHost;",
  '  role: "url" | "credential" | "identity" | "tuning";',
  '  required: "always" | "venue" | "player" | "conditional" | "never";',
  "  meaning: string;",
  "}",
  "export const WORKER_ENV_CONTRACT: readonly WorkerEnvVar[] = [",
].join("\n");
function envEntry(name: string): string {
  return [
    "  {",
    `    name: ${JSON.stringify(name)},`,
    '    host: "store",',
    '    role: "url",',
    '    required: "always",',
    "    meaning:",
    '      "The PostgREST base URL of the store that persists gigs, outputs and ledger rows.",',
    "  },",
  ].join("\n");
}
function envFaithful(names: string[]): string {
  return ENV_HEADER + "\n" + names.map(envEntry).join("\n") + "\n];\n";
}
/** O3's silent-wrong case: the identifier appears (a comment, a type) but NO contract array with
 *  entries is declared. The bare-identifier gate reads this as an empty set — and against a
 *  predecessor that HAD entries, the diff silently reports the whole env table as removed. */
const ENV_MENTION_ONLY = [
  "// THE ENUMERATED TABLE was once WORKER_ENV_CONTRACT; the entries now live elsewhere.",
  'export type EnvHost = "service" | "store" | "model" | "none";',
  "export interface WorkerEnvVar { name: string; host: EnvHost; }",
  "// see WORKER_ENV_CONTRACT for the canonical list of variables",
  "",
].join("\n");

// A minimal, always-parseable set of the OTHER surface files, so a fixture can isolate one surface.
function writeOtherSurfaces(repo: string): void {
  writeIn(repo, "domain_types/claim-draft.json", JSON.stringify({ slug: "claim-draft", version: 1 }) + "\n");
  writeIn(
    repo,
    "scripts/laws.sh",
    '#!/usr/bin/env bash\nset -euo pipefail\nEXPECTED_LAWS="${EXPECTED_LAWS:-100}"\nEXPECTED_FILES="${EXPECTED_FILES:-10}"\n',
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("release surface — the MCP registry is read from the real TOOL_DEFS shape (O1)", () => {
  it("O1 — a typed TOOL_DEFS array exported through .map() yields the slugs and <slug>.<arg> args", () => {
    const compileReleases = compiler();
    const repo = newRepo("relsurf-o1-");
    writeIn(repo, "src/mcp.ts", mcpFaithful([E_TYPE_RESOLVE, E_TYPE_BROWSE, E_AGENT_BROWSE]));
    writeIn(repo, "src/cli.ts", cliFaithful([CLI_INPUT, CLI_DEPTH, CLI_HELP]));
    writeIn(repo, "src/worker_env.ts", envFaithful(["COLTRANE_STORE_URL"]));
    writeOtherSurfaces(repo);
    commit(repo, "chore: seed the real-shaped surface", "2026-01-01T00:00:00Z");
    tag(repo, "v0.1.0");

    const first = recordFor(compileReleases({ tree_root: repo }), "v0.1.0");

    // RED today: parseMcp gates on `export const MCP_TOOLS\s*=\s*\[`, but the real export is
    // `= TOOL_DEFS.map(...)` and the array is named TOOL_DEFS — so mcp_tools comes back null on the
    // one shape the repository actually writes.
    expect(
      first.surface.mcp_tools,
      "mcp_tools is null on the REAL src/mcp.ts shape (a typed TOOL_DEFS array exported via .map) — the parser must read the array whatever its name and annotation",
    ).not.toBeNull();
    expect(first.surface.mcp_tool_args, "mcp_tool_args must be read from the same array").not.toBeNull();

    // the earliest tag reports its whole surface as `added`.
    const tools = first.surface.mcp_tools!.added;
    for (const slug of ["type_resolve", "type_browse", "agent_browse"]) {
      expect(tools, `slug ${slug} must be read from the TOOL_DEFS array`).toContain(slug);
    }
    const args = first.surface.mcp_tool_args!.added;
    for (const a of [
      "type_resolve.core_type",
      "type_resolve.required_fields",
      "type_browse.min_usage",
      "agent_browse.primitive",
    ]) {
      expect(args, `arg ${a} must be read as "<slug>.<argument>" from input_schema obj({...})`).toContain(a);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("release surface — the CLI flags are read from flag lines, no HELP constant (O2)", () => {
  it("O2 — flag lines under an Options heading in USAGE read as their names, without placeholders", () => {
    const compileReleases = compiler();
    const repo = newRepo("relsurf-o2-");
    writeIn(repo, "src/mcp.ts", mcpFaithful([E_TYPE_RESOLVE]));
    writeIn(repo, "src/cli.ts", cliFaithful([CLI_INPUT, CLI_DEPTH, CLI_EFFORT, CLI_BUDGET, CLI_HELP]));
    writeIn(repo, "src/worker_env.ts", envFaithful(["COLTRANE_STORE_URL"]));
    writeOtherSurfaces(repo);
    commit(repo, "chore: seed the real-shaped CLI", "2026-01-01T00:00:00Z");
    tag(repo, "v0.1.0");

    const first = recordFor(compileReleases({ tree_root: repo }), "v0.1.0");

    // RED today: parseCli gates on `export const HELP`, but the real block is `export const USAGE`
    // (no HELP constant anywhere), so cli_flags comes back null.
    expect(
      first.surface.cli_flags,
      "cli_flags is null on the REAL src/cli.ts shape (flag lines under an Options heading in USAGE, no HELP constant) — the parser must read the flag lines themselves",
    ).not.toBeNull();
    const flags = first.surface.cli_flags!.added;

    // the flag name is taken WITHOUT its `<placeholder>`: `--effort <low|...>` reads as `--effort`.
    for (const f of ["--input", "--depth", "--effort", "--budget", "--help"]) {
      expect(flags, `flag ${f} must be read from its line, placeholder stripped`).toContain(f);
    }
    // a `--` token that is NOT the first non-space characters of its line is NOT a flag: `--check`,
    // `--any` and `--residency` appear only inside usage lines that begin with `coltrane`.
    for (const notFlag of ["--check", "--any", "--residency"]) {
      expect(flags, `${notFlag} is mid-line in a usage example, not a flag line — it must not be read as a flag`).not.toContain(notFlag);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("release surface — env vars are read from array ENTRIES, not a bare identifier (O3)", () => {
  it("O3 — a file that only MENTIONS the contract does not silently erase the predecessor's env table", () => {
    const compileReleases = compiler();
    const repo = newRepo("relsurf-o3-");
    // v0.1.0: two real env entries.
    writeIn(repo, "src/mcp.ts", mcpFaithful([E_TYPE_RESOLVE]));
    writeIn(repo, "src/cli.ts", cliFaithful([CLI_INPUT, CLI_HELP]));
    writeIn(repo, "src/worker_env.ts", envFaithful(["COLTRANE_STORE_URL", "COLTRANE_STORE_ANON"]));
    writeOtherSurfaces(repo);
    commit(repo, "chore: seed two env vars", "2026-01-01T00:00:00Z");
    tag(repo, "v0.1.0");
    // v0.2.0: worker_env.ts MENTIONS WORKER_ENV_CONTRACT (a comment, the type) but declares NO entry
    // array. The bare-identifier gate (src/releases.ts:122) reads this as an empty set.
    writeIn(repo, "src/worker_env.ts", ENV_MENTION_ONLY);
    commit(repo, "refactor: move the env table out of worker_env.ts", "2026-02-01T00:00:00Z");
    tag(repo, "v0.2.0");

    const second = recordFor(compileReleases({ tree_root: repo }), "v0.2.0");

    // RED today: the bare-name match returns an empty set, so the diff reports the WHOLE predecessor
    // env table as removed — a silent, false "all env vars deleted". A surface read from ENTRIES,
    // finding none it can read, must NOT produce that: it is unread, not emptied.
    expect(
      second.surface.env_vars,
      "a worker_env.ts that only MENTIONS WORKER_ENV_CONTRACT (no entry array) must not read as the predecessor's whole env table removed",
    ).not.toEqual({ added: [], removed: ["COLTRANE_STORE_ANON", "COLTRANE_STORE_URL"] });
    // and it is reported as unread, loudly — not passed off as a value.
    expect(
      second.surface_unread,
      "an env surface whose entries could not be read must be NAMED in surface_unread, not silently emptied",
    ).toContain("env_vars");
    expect(second.surface.env_vars, "the unread env surface is null, distinguishable from a present-but-empty list").toBeNull();
  });

  it("O3 — a real WORKER_ENV_CONTRACT array with entries still reads its names (the presence half)", () => {
    const compileReleases = compiler();
    const repo = newRepo("relsurf-o3b-");
    writeIn(repo, "src/mcp.ts", mcpFaithful([E_TYPE_RESOLVE]));
    writeIn(repo, "src/cli.ts", cliFaithful([CLI_INPUT, CLI_HELP]));
    writeIn(repo, "src/worker_env.ts", envFaithful(["COLTRANE_STORE_URL", "COLTRANE_STORE_ANON"]));
    writeOtherSurfaces(repo);
    commit(repo, "chore: seed", "2026-01-01T00:00:00Z");
    tag(repo, "v0.1.0");

    const first = recordFor(compileReleases({ tree_root: repo }), "v0.1.0");
    expect(first.surface.env_vars, "a real entry array reads as a present list").not.toBeNull();
    expect(first.surface.env_vars!.added, "the entries' names are read from the array").toEqual(
      ["COLTRANE_STORE_ANON", "COLTRANE_STORE_URL"],
    );
    // and, the record having read every surface, surface_unread is present and empty (RED today —
    // the field does not exist yet — while the env-parse guard above stays green through the change).
    expect(first.surface_unread, "a fully-read record reports an empty surface_unread").toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("release surface — both the simplified and the real shapes parse (I1)", () => {
  it("I1 — the control's simplified fixtures AND the byte-faithful ones each yield a non-null surface", () => {
    const compileReleases = compiler();

    // (a) the SIMPLIFIED shape the control test uses — must keep parsing (the parsers accept BOTH).
    const simple = newRepo("relsurf-i1-simple-");
    writeIn(simple, "src/mcp.ts", MCP_SIMPLIFIED);
    writeIn(simple, "src/cli.ts", CLI_SIMPLIFIED);
    writeIn(simple, "src/worker_env.ts", envFaithful(["COLTRANE_STORE_URL"]));
    writeOtherSurfaces(simple);
    commit(simple, "chore: simplified shapes", "2026-01-01T00:00:00Z");
    tag(simple, "v0.1.0");
    const s = recordFor(compileReleases({ tree_root: simple }), "v0.1.0").surface;
    expect(s.mcp_tools, "the simplified MCP_TOOLS = [ ... ] shape must keep parsing").not.toBeNull();
    expect(s.mcp_tools!.added, "the simplified fixture's slug is read").toContain("type_resolve");
    expect(s.cli_flags, "the simplified `export const HELP` shape must keep parsing").not.toBeNull();
    expect(s.cli_flags!.added).toContain("--input");

    // (b) the BYTE-FAITHFUL shape — the same KIND of answer, non-null with the slugs/flags it declares.
    const real = newRepo("relsurf-i1-real-");
    writeIn(real, "src/mcp.ts", mcpFaithful([E_TYPE_RESOLVE, E_TYPE_BROWSE]));
    writeIn(real, "src/cli.ts", cliFaithful([CLI_INPUT, CLI_DEPTH, CLI_HELP]));
    writeIn(real, "src/worker_env.ts", envFaithful(["COLTRANE_STORE_URL"]));
    writeOtherSurfaces(real);
    commit(real, "chore: real shapes", "2026-01-01T00:00:00Z");
    tag(real, "v0.1.0");
    const r = recordFor(compileReleases({ tree_root: real }), "v0.1.0").surface;
    expect(r.mcp_tools, "the real TOOL_DEFS/.map shape must ALSO parse — same kind of answer").not.toBeNull();
    expect(r.mcp_tools!.added, "the real fixture's slugs are read").toContain("type_browse");
    expect(r.cli_flags, "the real USAGE shape must ALSO parse").not.toBeNull();
    expect(r.cli_flags!.added).toContain("--depth");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("release surface — a real-shaped change reports the change, not null (I2)", () => {
  it("I2 — one tool arg and one CLI flag added across two byte-faithful tags read as .added", () => {
    const compileReleases = compiler();
    const repo = newRepo("relsurf-i2-");
    // v0.1.0: agent_browse with a single `domain` arg; CLI without --effort.
    writeIn(repo, "src/mcp.ts", mcpFaithful([E_TYPE_RESOLVE, E_AGENT_BROWSE_DOMAIN_ONLY]));
    writeIn(repo, "src/cli.ts", cliFaithful([CLI_INPUT, CLI_DEPTH, CLI_BUDGET, CLI_HELP]));
    writeIn(repo, "src/worker_env.ts", envFaithful(["COLTRANE_STORE_URL"]));
    writeOtherSurfaces(repo);
    commit(repo, "chore: seed", "2026-01-01T00:00:00Z");
    tag(repo, "v0.1.0");
    // v0.2.0: agent_browse gains `primitive`; CLI gains --effort.
    writeIn(repo, "src/mcp.ts", mcpFaithful([E_TYPE_RESOLVE, E_AGENT_BROWSE]));
    writeIn(repo, "src/cli.ts", cliFaithful([CLI_INPUT, CLI_DEPTH, CLI_EFFORT, CLI_BUDGET, CLI_HELP]));
    commit(repo, "feat: advertise agent_browse.primitive and --effort", "2026-02-01T00:00:00Z");
    tag(repo, "v0.2.0");

    const second = recordFor(compileReleases({ tree_root: repo }), "v0.2.0");

    // RED today: both surfaces are null on the real shapes, so a real change reads as "unknown"
    // rather than as the addition it is.
    expect(second.surface.mcp_tool_args, "mcp_tool_args must be non-null to report the added argument").not.toBeNull();
    expect(second.surface.mcp_tool_args!.added, "the added argument reads as <slug>.<arg>").toContain("agent_browse.primitive");
    expect(second.surface.cli_flags, "cli_flags must be non-null to report the added flag").not.toBeNull();
    expect(second.surface.cli_flags!.added, "the added flag reads by name").toContain("--effort");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("release surface — a present-but-unreadable surface is NAMED, not silently null (F1)", () => {
  it("F1 — every record carries a surface_unread list; a fully-read record names nothing", () => {
    const compileReleases = compiler();
    const repo = newRepo("relsurf-f1a-");
    writeIn(repo, "src/mcp.ts", mcpFaithful([E_TYPE_RESOLVE, E_TYPE_BROWSE]));
    writeIn(repo, "src/cli.ts", cliFaithful([CLI_INPUT, CLI_DEPTH, CLI_HELP]));
    writeIn(repo, "src/worker_env.ts", envFaithful(["COLTRANE_STORE_URL"]));
    writeOtherSurfaces(repo);
    commit(repo, "chore: seed", "2026-01-01T00:00:00Z");
    tag(repo, "v0.1.0");

    const first = recordFor(compileReleases({ tree_root: repo }), "v0.1.0");
    // RED today: ReleaseRecord has no surface_unread field at all.
    expect(Array.isArray(first.surface_unread), "every record carries a surface_unread array").toBe(true);
    expect(first.surface_unread, "a record whose every surface parsed names NO unread surface").toEqual([]);
  });

  it("F1 — a present-but-garbled src/mcp.ts nulls its lists AND names them in surface_unread", () => {
    const compileReleases = compiler();
    const repo = newRepo("relsurf-f1b-");
    // src/mcp.ts is PRESENT but carries no readable tool-definition array — a garble, not an absence.
    writeIn(repo, "src/mcp.ts", "export const NOT_A_REGISTRY = 42; // no tool definitions here at all\n");
    writeIn(repo, "src/cli.ts", cliFaithful([CLI_INPUT, CLI_HELP]));
    writeIn(repo, "src/worker_env.ts", envFaithful(["COLTRANE_STORE_URL"]));
    writeOtherSurfaces(repo);
    commit(repo, "chore: seed with a garbled mcp.ts", "2026-01-01T00:00:00Z");
    tag(repo, "v0.1.0");

    const first = recordFor(compileReleases({ tree_root: repo }), "v0.1.0");
    // the lists themselves are null (this half already holds in the control) ...
    expect(first.surface.mcp_tools, "a garbled mcp.ts nulls mcp_tools").toBeNull();
    expect(first.surface.mcp_tool_args, "and its args list").toBeNull();
    // ... but the RED half: the record must SAY it could not read them, so a changelog can render
    // "could not read the tool registry here" instead of a silent gap.
    expect(
      first.surface_unread,
      "a present-but-unreadable src/mcp.ts must be NAMED in surface_unread — a bare null is the silent gap this contract closes",
    ).toEqual(expect.arrayContaining(["mcp_tools", "mcp_tool_args"]));
    // a surface read from a DIFFERENT file is not implicated.
    expect(first.surface_unread, "the readable CLI surface is not named unread").not.toContain("cli_flags");
  });
});


// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Found by running the compiler against this repository at HEAD: v0.24.31 reported
// `gig_dispatch.properties`, `gig_dispatch.type` and `gig_dispatch.description` as added arguments.
// They are not arguments. They are JSON-Schema keywords INSIDE gig_dispatch's nested `budget` object
// (`budget: { type: "object", description: "…", properties: { max_usd: … } }`), which the flat
// `(\w+)\s*:` scan cannot tell from a top-level argument. A changelog that names arguments no tool
// has is worse than one that names none: it is confidently wrong in public.
describe("release surface — only TOP-LEVEL arguments are arguments (O1)", () => {
  it("O1 — a nested object argument yields its own name, never the JSON-Schema keywords inside it", () => {
    const compileReleases = compiler();
    const repo = newRepo("relsurf-nested-");
    // gig_dispatch's real shape, reduced: two flat arguments and one NESTED object argument.
    writeIn(repo, "src/mcp.ts",
      'const TOOL_DEFS: readonly Omit<MCPToolDef, "description">[] = [\n' +
      '  { slug: "gig_dispatch", category: "run", input_schema: obj({ standard_slug: "string", wait: "boolean", ' +
      'budget: { type: "object", description: "per-gig cost ceiling in US dollars", properties: { max_usd: { type: "number" } } } }) },\n' +
      '];\n' +
      'export const MCP_TOOLS: readonly MCPToolDef[] = TOOL_DEFS.map((t) => t);\n');
    commit(repo, "chore: seed", "2026-01-01T00:00:00Z");
    tag(repo, "v0.1.0");

    const [only] = compileReleases({ tree_root: repo });
    const args = only!.surface.mcp_tool_args;
    expect(args, "the tool registry parsed").not.toBeNull();
    const added = args!.added;
    expect(added, "the nested argument is named by ITS OWN key").toContain("gig_dispatch.budget");
    for (const keyword of ["type", "properties", "description"]) {
      expect(added,
        `"gig_dispatch.${keyword}" is a JSON-Schema keyword inside the nested budget object, not an argument gig_dispatch accepts — a changelog naming it is confidently wrong in public`,
      ).not.toContain(`gig_dispatch.${keyword}`);
    }
    expect(added.filter((a) => a.startsWith("gig_dispatch.")).sort(),
      "exactly the three top-level arguments").toEqual(["gig_dispatch.budget", "gig_dispatch.standard_slug", "gig_dispatch.wait"]);
  });
});
