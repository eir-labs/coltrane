// SHIPPING THE HISTORY, AND RENDERING A NOTE (contract-release-history-and-render-v1).
//
// THE MEASURED PROBLEM (operator, 2026-09-18), two pieces of the changelog tab on coltrane.eir.sh:
//   (1) `.github/workflows/publish.yml` computes the next version, stamps it, runs `npm run verify`,
//       PUBLISHES, and THEN pushes the tag. So at the moment the package is built the release being
//       shipped has NO TAG YET, and `compileReleases` (src/releases.ts) walks tags only — measured on
//       this repo it compiles 75 records whose newest is v0.24.31, the release BEFORE the one a publish
//       run would ship. The package cannot carry the history it is itself part of.
//   (2) The release-note type (release-notes-v0) carries headline/plain_md/formal_md/claims/unreadable
//       and is read by the seats that write and judge it and by NOTHING in src/ — the changelog needs
//       those registers as markdown, and the engine is where that belongs (the UI imports the package
//       rather than reimplementing the rendering).
//
// THE CONTRACT (decided). `compileReleases({ tree_root, pending: { version } })` appends one further
// record for the commits since the last tag, compiled exactly as a tagged release, marked
// `pending: true`; `releasesJson(options)` emits the whole history as a stable JSON document, newest
// first; `renderReleaseNote(note, record)` renders one note to markdown that never presents a claim the
// record does not support.
//
// THESE LAWS ARE RED BY DESIGN: `pending` is not read, and `releasesJson`/`renderReleaseNote` do not
// exist yet. Each law reaches the mechanism REFLECTIVELY off the src/index.js namespace (which exists
// and compiles today) and — for the two absent exports — LEADS with the assertion that the export is
// absent, stating the contract's reason, so the file COLLECTS and every law fails on the CONTRACT, not
// on an ESM link error or a bare TypeError. The `pending` laws call the EXISTING compileReleases and
// fail on the pending behaviour it does not yet have. When the builder adds the mechanism these laws go
// green by describing the truth, not by being weakened.
//
// The history laws build their own fixture git repository (the tests/spec_release_record.test.ts house
// pattern); NO law reads the coltrane repository's own history. The render laws call the renderer with
// plain objects; NO law dispatches a gig, invokes a model, or reaches the network.
// See docs/specs/release-history-and-render.red-spec.md.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import * as coltrane from "../src/index.js";

// ── the shapes the mechanism MUST return/accept. Declared here so the laws are typed against the
//    CONTRACT, not against whatever the builder happens to produce. The `pending` field on the record
//    and the `pending` option on compileReleases are the additions this contract makes. ──
interface Commit {
  sha: string;
  subject: string;
}
type SurfaceList = { added: string[]; removed: string[] } | null;
interface ReleaseSurface {
  mcp_tools: SurfaceList;
  mcp_tool_args: SurfaceList;
  cli_flags: SurfaceList;
  env_vars: SurfaceList;
  domain_types: SurfaceList;
}
interface ReleaseRecord {
  version: string;
  tag: string;
  date: string;
  commits: Commit[];
  bump: "major" | "minor" | "patch";
  laws: { before: number | null; after: number | null; files: number | null };
  surface: ReleaseSurface;
  surface_unread: string[];
  /** false for a tagged release, true for the pending (not-yet-tagged) one this contract adds. */
  pending: boolean;
}
interface ReleaseNoteClaim {
  text: string;
  evidence: string;
  value?: string;
}
interface ReleaseNote {
  version: string;
  headline: string;
  plain_md: string;
  formal_md: string;
  claims: ReleaseNoteClaim[];
  unreadable?: string[];
}
type CompileReleases = (opts: { tree_root: string; pending?: { version: string } }) => ReleaseRecord[];
type ReleasesJson = (options: { tree_root: string; pending?: { version: string } }) => string;
type RenderReleaseNote = (note: ReleaseNote, record: ReleaseRecord) => string;

const api = coltrane as unknown as Record<string, unknown>;

/** THE LEADING, CONTRACT-STATING ASSERTION for an export that does not exist yet. Failing here aborts
 *  the `it`, so no downstream assertion can pass on a spurious "not a function". */
function requireFn<T>(name: string, why: string): T {
  const fn = api[name];
  expect(typeof fn, why).toBe("function");
  return fn as T;
}
const getCompileReleases = (): CompileReleases =>
  requireFn<CompileReleases>(
    "compileReleases",
    "src/index.ts must re-export compileReleases from src/releases.ts — the release-record compiler.",
  );
const getReleasesJson = (): ReleasesJson =>
  requireFn<ReleasesJson>(
    "releasesJson",
    "src/index.ts must re-export releasesJson(options) from src/releases.ts — the stable JSON document " +
      "of the whole history the package ships. It does not exist yet, so the package cannot carry its history.",
  );
const getRenderReleaseNote = (): RenderReleaseNote =>
  requireFn<RenderReleaseNote>(
    "renderReleaseNote",
    "src/index.ts must re-export renderReleaseNote(note, record) from src/releases.ts — the markdown " +
      "rendering of a release note. It does not exist yet, so the changelog UI would reimplement the rendering.",
  );

// ── temp-git-repo helpers (the tests/spec_release_record.test.ts house pattern) ──
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
/** Commit every current change at a pinned date, so both the committer date (what the record's `date`
 *  reads) and the commit ordering are deterministic. */
function commit(repo: string, subject: string, dateISO: string, body?: string): void {
  git(repo, ["add", "-A"]);
  const env = { ...GIT_ENV, GIT_AUTHOR_DATE: dateISO, GIT_COMMITTER_DATE: dateISO };
  const args = ["-C", repo, "commit", "--quiet", "-m", subject];
  if (body !== undefined) args.push("-m", body);
  execFileSync("git", args, { env });
}
function tag(repo: string, name: string): void {
  git(repo, ["tag", name]);
}

// ── file shapes, faithful to the real modules the surface is read from (the simplified control
//    shapes — spec_release_surface_real_shapes.test.ts already proves the byte-faithful ones parse) ──
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
  `export const USAGE = \`\n` + flags.map((f) => `  ${f} <v>    what ${f} does`).join("\n") + `\n\`;\n`;
const workerEnvFile = (names: string[]): string =>
  `export const WORKER_ENV_CONTRACT = [\n` +
  names
    .map((n) => `  { name: ${JSON.stringify(n)}, host: "store", role: "url", required: "always", meaning: "x" },`)
    .join("\n") +
  `\n];\n`;
const domainTypeFile = (slug: string, version: number): string =>
  JSON.stringify({ slug, version, extends: "Artifact", schema: { type: "object", properties: {} } }, null, 2) + "\n";
const lawsFile = (laws: number, files: number): string =>
  `#!/usr/bin/env bash\nset -euo pipefail\n` +
  `EXPECTED_LAWS="\${EXPECTED_LAWS:-${laws}}"\n` +
  `EXPECTED_FILES="\${EXPECTED_FILES:-${files}}"\n`;

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
 *  claim-draft@1 -> @2, laws 150/files 12 — identical to the control's v2. */
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

/** A repo with v0.1.0 tagged and ONE commit beyond it that carries the whole v2 surface — the shape a
 *  publish run sees: HEAD is the release about to ship, and it has no tag yet. */
function pendingRepo(): string {
  const repo = newRepo("relhist-pending-");
  writeSurfaceV1(repo);
  commit(repo, "chore: seed the surface", "2026-01-01T00:00:00Z");
  tag(repo, "v0.1.0");
  writeSurfaceV2(repo);
  commit(repo, "feat: swap type_browse for agent_browse and add --budget", "2026-02-01T00:00:00Z");
  // deliberately NOT tagged — this is the pending release.
  return repo;
}

/** A two-tag repo (v0.1.0 then v0.2.0), for the JSON-document laws that need a settled history. */
function twoTagRepo(): string {
  const repo = newRepo("relhist-two-");
  writeSurfaceV1(repo);
  commit(repo, "chore: seed the surface", "2026-01-01T00:00:00Z");
  tag(repo, "v0.1.0");
  writeSurfaceV2(repo);
  commit(repo, "feat: swap type_browse for agent_browse and add --budget", "2026-02-01T00:00:00Z");
  tag(repo, "v0.2.0");
  return repo;
}

// ── a plain release-record for the render laws (the contract: "both as plain objects") ──
function sampleRecord(): ReleaseRecord {
  return {
    version: "0.2.0",
    tag: "v0.2.0",
    date: "2026-02-01T00:00:00Z",
    commits: [{ sha: "a1b2c3d", subject: "feat: add the --budget flag" }],
    bump: "minor",
    laws: { before: 100, after: 150, files: 12 },
    surface: {
      mcp_tools: { added: ["agent_browse"], removed: ["type_browse"] },
      mcp_tool_args: { added: ["agent_browse.domain"], removed: [] },
      cli_flags: { added: ["--budget"], removed: [] },
      env_vars: null,
      domain_types: { added: ["claim-draft@2"], removed: ["claim-draft@1"] },
    },
    surface_unread: ["env_vars"],
    pending: false,
  };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// O1 — a pending record for the version about to be published
// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe("release history — a pending record for the version about to be published (O1)", () => {
  it("O1 — pending {version} appends one record for the commits since the last tag, marked pending", () => {
    const compileReleases = getCompileReleases();
    const repo = pendingRepo();

    const records = compileReleases({ tree_root: repo, pending: { version: "0.2.0" } });

    // The pending release is appended, oldest first, as the v-prefixed pending version.
    expect(records.map((r) => r.tag), "the pending release is appended as v<version>").toEqual(["v0.1.0", "v0.2.0"]);
    const tagged = records[0]!;
    const pending = records[1]!;

    // pending flag: false on the tagged record, true on the appended one.
    expect(tagged.pending, "a tagged release carries pending:false").toBe(false);
    expect(pending.pending, "the appended release carries pending:true").toBe(true);

    // compiled exactly as a tagged release would be:
    expect(pending.version).toBe("0.2.0");
    expect(pending.tag, "tag is the v-prefixed pending version").toBe("v0.2.0");
    // date is HEAD's commit date (the release being shipped has no tag, so HEAD stands in).
    expect(new Date(pending.date).getTime(), "date is HEAD's commit date").toBe(new Date("2026-02-01T00:00:00Z").getTime());
    // commits are the range since the last tag, oldest first.
    expect(pending.commits.map((c) => c.subject)).toEqual([
      "feat: swap type_browse for agent_browse and add --budget",
    ]);
    // law counts read HEAD against the last tag: after at HEAD, before the last tag's after.
    expect(pending.laws.after, "after is read from scripts/laws.sh at HEAD").toBe(150);
    expect(pending.laws.before, "before chains from the last tag's after").toBe(100);
    // surface diffs HEAD against the last tag — the same deltas the control asserts for a real v0.2.0.
    expect(pending.surface.mcp_tools).toEqual({ added: ["agent_browse"], removed: ["type_browse"] });
    expect(pending.surface.cli_flags).toEqual({ added: ["--budget"], removed: [] });
    // and the bump is derived from the range (a feat: -> minor), never from the pending number.
    expect(pending.bump, "a feat: in the range derives minor").toBe("minor");
  });

  it("O1 — without a pending option the result is unchanged: only tagged records, each pending:false", () => {
    const compileReleases = getCompileReleases();
    const repo = pendingRepo();

    // No pending option: HEAD's untagged commit is NOT a release — only v0.1.0 is returned.
    const records = compileReleases({ tree_root: repo });
    expect(records.map((r) => r.tag), "without pending, only tagged releases are compiled").toEqual(["v0.1.0"]);
    // and every tagged record still carries pending:false (the field is always present).
    expect(records[0]!.pending, "a tagged record carries pending:false even when no pending was asked for").toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// I1 — a pending record is the record that tag would have carried
// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe("release history — a pending record equals the record its tag would carry (I1)", () => {
  it("I1 — compile pending, then really cut the tag: the two records agree on all but the pending flag", () => {
    const compileReleases = getCompileReleases();
    const repo = pendingRepo();

    const pendingRun = compileReleases({ tree_root: repo, pending: { version: "0.2.0" } });
    expect(pendingRun.map((r) => r.tag), "the pending record is present to compare").toEqual(["v0.1.0", "v0.2.0"]);
    const pendingRec = pendingRun[1]!;

    // Now really cut the tag at HEAD and compile WITHOUT pending.
    tag(repo, "v0.2.0");
    const taggedRun = compileReleases({ tree_root: repo });
    expect(taggedRun.map((r) => r.tag)).toEqual(["v0.1.0", "v0.2.0"]);
    const taggedRec = taggedRun[1]!;

    // They agree on commits, surface, laws, bump, version, date — everything the record derives from
    // the tree — and differ ONLY in the pending flag, as declared.
    expect(pendingRec.pending, "the pending record is marked pending").toBe(true);
    expect(taggedRec.pending, "the tagged record is not").toBe(false);
    expect(
      { ...pendingRec, pending: false },
      "a pending record must be exactly the record the tag would have carried, save the pending flag",
    ).toEqual(taggedRec);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// F1 — a pending version that is already tagged is refused by name
// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe("release history — a pending version already tagged is refused (F1)", () => {
  it("F1 — pending {version} that is already tagged throws, naming the version and the tag that holds it", () => {
    const compileReleases = getCompileReleases();
    const repo = pendingRepo(); // holds tag v0.1.0

    let threw: unknown;
    try {
      // 0.1.0 is already the tag v0.1.0 — emitting a pending record for it would be two records for one
      // version. It must refuse rather than duplicate.
      compileReleases({ tree_root: repo, pending: { version: "0.1.0" } });
    } catch (e) {
      threw = e;
    }
    expect(threw, "an already-tagged pending version must THROW, never emit a second record for one version").toBeInstanceOf(Error);
    const msg = String((threw as Error).message);
    expect(msg, "the refusal names the version").toMatch(/0\.1\.0/);
    expect(msg, "the refusal names the tag that already holds it").toMatch(/v0\.1\.0/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// O2 — a stable JSON document of the whole history, newest first
// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe("release history — a stable JSON document, newest first (O2)", () => {
  it("O2 — releasesJson returns { generated_from, releases } newest first, the same records compileReleases returns", () => {
    const compileReleases = getCompileReleases();
    const releasesJson = getReleasesJson();
    const repo = twoTagRepo();

    const json = releasesJson({ tree_root: repo });
    const doc = JSON.parse(json) as { generated_from: string; releases: ReleaseRecord[] };

    expect(doc.generated_from, "the document names what generated it").toBe("compileReleases");
    expect(Array.isArray(doc.releases)).toBe(true);
    // NEWEST FIRST — the reverse of compileReleases' oldest-first order.
    expect(doc.releases.map((r) => r.tag), "newest first").toEqual(["v0.2.0", "v0.1.0"]);
    const compiled = compileReleases({ tree_root: repo });
    expect(doc.releases, "the same records compileReleases returns, reversed").toEqual([...compiled].reverse());
  });

  it("O2 — the document is pretty-printed with a trailing newline, and byte-identical for the same inputs", () => {
    const releasesJson = getReleasesJson();
    const repo = twoTagRepo();

    const json = releasesJson({ tree_root: repo });
    const doc = JSON.parse(json) as unknown;
    // Pretty-printed (2-space) with a single trailing newline — a stable document a diff can track.
    expect(json, "pretty-printed with a trailing newline").toBe(JSON.stringify(doc, null, 2) + "\n");
    // Same inputs, byte-identical output — the shipped file must not churn between builds.
    expect(releasesJson({ tree_root: repo }), "byte-identical for the same inputs").toBe(json);
  });

  it("O2 — with a pending version the document leads with the pending release (still newest first)", () => {
    const releasesJson = getReleasesJson();
    const repo = pendingRepo();

    const json = releasesJson({ tree_root: repo, pending: { version: "0.2.0" } });
    const doc = JSON.parse(json) as { releases: ReleaseRecord[] };
    expect(doc.releases.map((r) => r.tag), "the pending release leads, newest first").toEqual(["v0.2.0", "v0.1.0"]);
    expect(doc.releases[0]!.pending, "and it is marked pending").toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// O3 — markdown for one note: every field rendered, in order, with evidence
// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe("release render — markdown carrying every field of the note, in order (O3)", () => {
  const note: ReleaseNote = {
    version: "0.2.0",
    headline: "agent_browse replaces type_browse and a spend ceiling arrives",
    plain_md: "You can now cap what a single run spends with the new command-line ceiling.",
    formal_md: "Release 0.2.0 was a minor step: the tool registry gained one verb and lost one.",
    claims: [
      { text: "the suite grew to 150 laws", evidence: "laws.after", value: "150" },
      { text: "the spend ceiling flag was added", evidence: "surface.cli_flags.added[0]", value: "--budget" },
    ],
    unreadable: ["env_vars"],
  };

  it("O3 — renders the headline as a heading, then the plain register, then the formal register, in order", () => {
    const renderReleaseNote = getRenderReleaseNote();
    const md = renderReleaseNote(note, sampleRecord());

    // The headline is a markdown heading.
    const headingLine = md.split("\n").find((l) => /^#{1,6}\s/.test(l));
    expect(headingLine, "the headline is rendered as a markdown heading").toBeDefined();
    expect(headingLine!, "the heading carries the headline text").toContain(note.headline);

    // Both registers are rendered verbatim.
    expect(md, "the plain register is rendered").toContain(note.plain_md);
    expect(md, "the formal register is rendered").toContain(note.formal_md);

    // ORDER: headline heading, then plain, then formal, then the evidence section.
    const iHead = md.indexOf(note.headline);
    const iPlain = md.indexOf(note.plain_md);
    const iFormal = md.indexOf(note.formal_md);
    const iEvidence = md.search(/evidence/i);
    expect(iPlain, "plain register comes after the headline").toBeGreaterThan(iHead);
    expect(iFormal, "formal register comes after the plain register").toBeGreaterThan(iPlain);
    expect(iEvidence, "the evidence section comes after the formal register").toBeGreaterThan(iFormal);
  });

  it("O3 — the evidence section lists each claim with the record path behind it and the value read there", () => {
    const renderReleaseNote = getRenderReleaseNote();
    const md = renderReleaseNote(note, sampleRecord());
    for (const claim of note.claims) {
      expect(md, `the claim text is rendered: ${claim.text}`).toContain(claim.text);
      expect(md, `the record path behind it is named: ${claim.evidence}`).toContain(claim.evidence);
      expect(md, `the value read at the path is shown: ${claim.value}`).toContain(claim.value!);
    }
  });

  it("O3 — a surface the record marks unread is STATED as unreadable, never omitted", () => {
    const renderReleaseNote = getRenderReleaseNote();
    const md = renderReleaseNote(note, sampleRecord());
    // note.unreadable names env_vars — the reader must be told it could not be read, not left to infer
    // "nothing changed" from its absence.
    expect(md, "the unreadable surface is named").toContain("env_vars");
    expect(md, "and stated AS unreadable").toMatch(/unread|could not read|unreadable/i);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// I2 — the rendering is derived from the note, not decorated
// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe("release render — derived from the note, not decorated (I2)", () => {
  it("I2 — a note whose claims name two paths renders exactly those two evidence rows; dropping a claim drops its row", () => {
    const renderReleaseNote = getRenderReleaseNote();
    const record = sampleRecord();

    const claimA: ReleaseNoteClaim = { text: "the suite grew to 150 laws", evidence: "laws.after", value: "150" };
    const claimB: ReleaseNoteClaim = { text: "this was a minor release", evidence: "bump", value: "minor" };
    const twoClaimNote: ReleaseNote = {
      version: "0.2.0",
      headline: "Two claims, two rows",
      plain_md: "A plain sentence a user reads about the release.",
      formal_md: "A formal sentence naming the version and nothing else.",
      claims: [claimA, claimB],
      unreadable: [],
    };

    const md2 = renderReleaseNote(twoClaimNote, record);
    // Both claims present, each with its path.
    expect(md2).toContain(claimA.text);
    expect(md2).toContain(claimB.text);
    expect(md2).toContain("laws.after");
    expect(md2).toContain("bump");

    // Derived from the NOTE, not the record: remove claimB and its row disappears — the renderer does
    // not re-add it from the record's own `bump` field. This is what "not decorated" means: no evidence
    // row appears that the note did not claim.
    const oneClaimNote: ReleaseNote = { ...twoClaimNote, claims: [claimA] };
    const md1 = renderReleaseNote(oneClaimNote, record);
    expect(md1, "the surviving claim still renders").toContain(claimA.text);
    expect(md1, "the dropped claim's row is gone — the rendering follows the note").not.toContain(claimB.text);
    expect(md1, "and its record path is not decorated back in from the record").not.toContain("bump");
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// F2 — an unsupported claim is marked UNSUPPORTED, never dropped, never shown as evidenced
// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe("release render — an unsupported claim is marked, not dropped (F2)", () => {
  it("F2 — a claim whose path does not resolve, or resolves to a different value, is marked UNSUPPORTED naming what the record holds", () => {
    const renderReleaseNote = getRenderReleaseNote();
    const record = sampleRecord(); // laws.after === 150, bump === "minor"

    const wrongValue: ReleaseNoteClaim = { text: "the suite grew to 999 laws", evidence: "laws.after", value: "999" };
    const noSuchPath: ReleaseNoteClaim = { text: "a surface that does not exist changed", evidence: "surface.does_not_exist.added", value: "x" };
    const supported: ReleaseNoteClaim = { text: "this was a minor release", evidence: "bump", value: "minor" };

    const note: ReleaseNote = {
      version: "0.2.0",
      headline: "One good claim and two bad ones",
      plain_md: "A plain sentence for the reader.",
      formal_md: "A formal sentence for the record.",
      claims: [wrongValue, noSuchPath, supported],
      unreadable: [],
    };

    const md = renderReleaseNote(note, record);

    // NEVER SILENTLY DROPPED — every claim's text is present.
    expect(md, "a mismatched claim is not dropped").toContain(wrongValue.text);
    expect(md, "an unresolvable claim is not dropped").toContain(noSuchPath.text);
    expect(md, "the supported claim is present").toContain(supported.text);

    // The two bad claims are MARKED UNSUPPORTED; a mismatch names what the record actually holds (150).
    expect(md, "a value mismatch is marked UNSUPPORTED").toMatch(/unsupported/i);
    expect(md, "and names the value the record actually holds").toContain("150");

    // The supported claim is NOT rendered as unsupported: split the markdown at the supported claim's
    // text and confirm the word UNSUPPORTED does not attach to its own row's value.
    const rows = md.split("\n").filter((l) => l.includes("bump") || l.includes("minor"));
    for (const row of rows) {
      expect(/unsupported/i.test(row), "the supported claim must not be marked UNSUPPORTED").toBe(false);
    }
  });
});
