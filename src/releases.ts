// THE RELEASE RECORD, COMPILED FROM GIT (contract-release-record-v1).
//
// The measured problem: `.github/workflows/publish.yml` cuts a release on every push to main and
// derives the version from conventional-commit prefixes. Across v0.24.20..v0.24.31, 0 of 11 subjects
// carried a prefix, so every tag shipped as a patch — including one that added a domain-type version,
// two CLI flags, a gig_dispatch argument and three refusal kinds. A changelog grouped by the bump
// renders one flat list, and the bump cannot be trusted to say what changed.
//
// So the repo answers the question MECHANICALLY. Every surface an integrator sees is data readable at
// any tag with `git show <tag>:<path>`: the MCP tool registry (src/mcp.ts), the CLI help block
// (src/cli.ts), the worker env table (src/worker_env.ts), each domain type's version
// (domain_types/*.json) and the law/file counts (scripts/laws.sh). `compileReleases({ tree_root })`
// reads those at each v* tag and reports a ReleaseRecord per tag: derived, deterministic, refusing
// rather than guessing.
//
// Every git read goes through execFileSync("git", ["-C", tree_root, ...]) — no network, no shell
// string, no process.cwd(), and everything is read AT THE TAG so a record compiled today equals the
// record compiled the day the tag was cut. The parse is regex over the text at that revision, in the
// style of src/repo_index.ts (no AST): an old tag's module may not compile against today's types, so
// the surface is text at that revision, never an import of it.

import { execFileSync } from "node:child_process";

/** One commit in a release's range: its full sha and its subject line. */
export interface Commit {
  sha: string;
  subject: string;
}

/** A surface delta against the predecessor tag: both lists sorted, plain strings. `null` when the
 *  file the list is read from was absent or unparseable AT THE TAG — distinguishable from an empty
 *  list, which means "present and nothing changed". */
export type SurfaceList = { added: string[]; removed: string[] } | null;

/** The surface an integrator sees, keyed by what it is read from. */
export interface ReleaseSurface {
  mcp_tools: SurfaceList;
  mcp_tool_args: SurfaceList;
  cli_flags: SurfaceList;
  env_vars: SurfaceList;
  domain_types: SurfaceList;
}

/** One release, compiled from git at a v* tag. */
export interface ReleaseRecord {
  /** The semver — the tag without its `v`. */
  version: string;
  /** The ref. */
  tag: string;
  /** The tag's commit date, ISO. */
  date: string;
  /** The range since the previous tag, oldest first; the earliest tag's range is every commit up to it. */
  commits: Commit[];
  /** Derived the scripts/next_version.mjs way from the range's subjects and trailers, never the tag numbers. */
  bump: "major" | "minor" | "patch";
  /** Law/file counts read from scripts/laws.sh: `after` at this tag, `before` the predecessor's `after`
   *  (`null` for the earliest tag — there is no predecessor count, and `0` would falsely claim an
   *  empty suite the day before). */
  laws: { before: number | null; after: number | null; files: number | null };
  surface: ReleaseSurface;
}

// ── the conventional-commit bump rule, byte-for-byte scripts/next_version.mjs ────────────────────────
const BREAKING = /^[a-zA-Z]+(\([^)]*\))?!:/;
const BREAKING_TRAILER = /^BREAKING[ -]CHANGE:/;
const FEAT = /^feat(\([^)]*\))?:/;

/** Run git under `tree_root`, capturing stdout. Throws on a non-zero exit (an absent path, a bad ref),
 *  which the surface readers catch and turn into `null`. stderr is discarded so a missing file does not
 *  spam the caller's console. */
function gitCapture(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** The text of `<path>` AT `<tag>`, or `null` when it does not exist there. */
function showAtTag(root: string, tag: string, path: string): string | null {
  try {
    return gitCapture(root, ["show", `${tag}:${path}`]);
  } catch {
    return null;
  }
}

/** The MCP tool slugs and their advertised argument names from src/mcp.ts. `null` when no MCP_TOOLS
 *  array can be parsed out of the file (absent or garbled). Args are `"<slug>.<argument>"`. */
function parseMcp(content: string | null): { tools: Set<string>; args: Set<string> } | null {
  if (content === null) return null;
  if (!/export const MCP_TOOLS\s*=\s*\[/.test(content)) return null;
  const tools = new Set<string>();
  const args = new Set<string>();
  const toolRe = /slug:\s*"([^"]+)"[\s\S]*?input_schema:\s*obj\(\{([\s\S]*?)\}\)/g;
  let m: RegExpExecArray | null;
  while ((m = toolRe.exec(content)) !== null) {
    const slug = m[1]!;
    tools.add(slug);
    const argRe = /(\w+)\s*:/g;
    let a: RegExpExecArray | null;
    while ((a = argRe.exec(m[2]!)) !== null) args.add(`${slug}.${a[1]}`);
  }
  return { tools, args };
}

/** The long `--flags` from the CLI help block in src/cli.ts. `null` when no HELP block is present. */
function parseCli(content: string | null): Set<string> | null {
  if (content === null) return null;
  if (!/export const HELP\b/.test(content)) return null;
  const flags = new Set<string>();
  const re = /--[a-z][a-z0-9-]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) flags.add(m[0]);
  return flags;
}

/** The variable names from the worker environment contract in src/worker_env.ts. `null` when the
 *  WORKER_ENV_CONTRACT table is not present. */
function parseEnv(content: string | null): Set<string> | null {
  if (content === null) return null;
  if (!/WORKER_ENV_CONTRACT/.test(content)) return null;
  const names = new Set<string>();
  const re = /name:\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) names.add(m[1]!);
  return names;
}

/** EXPECTED_LAWS and EXPECTED_FILES from scripts/laws.sh, each `null` when the count is absent. */
function parseLaws(content: string | null): { laws: number | null; files: number | null } {
  if (content === null) return { laws: null, files: null };
  const lm = /EXPECTED_LAWS="\$\{EXPECTED_LAWS:-(\d+)\}"/.exec(content);
  const fm = /EXPECTED_FILES="\$\{EXPECTED_FILES:-(\d+)\}"/.exec(content);
  return { laws: lm ? Number(lm[1]) : null, files: fm ? Number(fm[1]) : null };
}

/** `"<slug>@<version>"` per file under domain_types/ AT `<tag>`. `null` when no domain_types directory
 *  exists at the tag; an individual unparseable file contributes nothing rather than nulling the set. */
function parseDomainTypes(root: string, tag: string): Set<string> | null {
  let listing: string;
  try {
    listing = gitCapture(root, ["ls-tree", "-r", "--name-only", tag, "domain_types"]);
  } catch {
    return null;
  }
  const files = listing.split("\n").filter((p) => p.endsWith(".json"));
  if (files.length === 0) return null;
  const set = new Set<string>();
  for (const file of files) {
    const content = showAtTag(root, tag, file);
    if (content === null) continue;
    try {
      const j = JSON.parse(content) as { slug?: string; version?: number };
      if (j.slug !== undefined && j.version !== undefined) set.add(`${j.slug}@${j.version}`);
    } catch {
      /* an unparseable domain-type file contributes nothing */
    }
  }
  return set;
}

/** The surface delta: everything in `after` not in `before` is added, and vice versa, both sorted.
 *  `null` when the file is absent/unparseable AT THE TAG (`after` is `null`); a `before` that is
 *  absent (an older release predating the file, or no predecessor at all) counts as the empty set, so
 *  the tag that introduced a file reports its whole contents as `added`, never `null`. */
function diffSurface(after: Set<string> | null, before: Set<string> | null): SurfaceList {
  if (after === null) return null;
  const prev = before ?? new Set<string>();
  const added = [...after].filter((x) => !prev.has(x)).sort();
  const removed = [...prev].filter((x) => !after.has(x)).sort();
  return { added, removed };
}

/** The commits in `prev..tag`, oldest first; the earliest tag's range is every commit up to it. */
function rangeCommits(root: string, prevTag: string | null, tag: string): Commit[] {
  const range = prevTag ? `${prevTag}..${tag}` : tag;
  const out = gitCapture(root, ["log", "--reverse", "--format=%H%x09%s", range]);
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf("\t");
      return { sha: line.slice(0, tab), subject: line.slice(tab + 1) };
    });
}

/** The bump for `prev..tag`, derived the scripts/next_version.mjs way over the range's full commit
 *  bodies (subjects and trailers): a `!:` prefix or a BREAKING-CHANGE trailer is major, a feat: is
 *  minor, everything else is patch. Highest bump wins. */
function rangeBump(root: string, prevTag: string | null, tag: string): "major" | "minor" | "patch" {
  const range = prevTag ? `${prevTag}..${tag}` : tag;
  const body = gitCapture(root, ["log", "--format=%B", range]);
  const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);
  let bump: "major" | "minor" | "patch" = "patch";
  for (const line of lines) {
    if (BREAKING.test(line) || BREAKING_TRAILER.test(line)) return "major";
    if (FEAT.test(line)) bump = "minor";
  }
  return bump;
}

/**
 * Compile a ReleaseRecord per v* tag, oldest first, reading every field AT the tag. Throws — never
 * returns `[]` — when `tree_root` is not a git repository, or is one that holds no v* tag: an empty
 * list would read as "this project has no releases", a different and false claim from "there is no
 * repository to read" or "there are no tags yet".
 */
export function compileReleases(opts: { tree_root: string }): ReleaseRecord[] {
  const root = opts.tree_root;

  // F2 — a tree_root that is not a git repository. Refuse by name rather than return [].
  try {
    execFileSync("git", ["-C", root, "rev-parse", "--git-dir"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    throw new Error(`compileReleases: "${root}" is not a git repository — no releases to compile`);
  }

  // Tags in version order, oldest first.
  const tags = gitCapture(root, ["tag", "--list", "v*", "--sort=version:refname"])
    .split("\n")
    .filter(Boolean);

  // F2 — a git repository with no v* tag. Refuse by name rather than return [].
  if (tags.length === 0) {
    throw new Error(
      `compileReleases: "${root}" is a git repository but holds no v* tags — there are no releases to compile`,
    );
  }

  const records: ReleaseRecord[] = [];
  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i]!;
    const prevTag = i > 0 ? tags[i - 1]! : null;

    const afterMcp = parseMcp(showAtTag(root, tag, "src/mcp.ts"));
    const beforeMcp = prevTag ? parseMcp(showAtTag(root, prevTag, "src/mcp.ts")) : null;
    const lawsAt = parseLaws(showAtTag(root, tag, "scripts/laws.sh"));

    records.push({
      version: tag.replace(/^v/, ""),
      tag,
      date: gitCapture(root, ["log", "-1", "--format=%cI", tag]).trim(),
      commits: rangeCommits(root, prevTag, tag),
      bump: rangeBump(root, prevTag, tag),
      laws: { before: null, after: lawsAt.laws, files: lawsAt.files },
      surface: {
        mcp_tools: diffSurface(afterMcp ? afterMcp.tools : null, beforeMcp ? beforeMcp.tools : null),
        mcp_tool_args: diffSurface(afterMcp ? afterMcp.args : null, beforeMcp ? beforeMcp.args : null),
        cli_flags: diffSurface(
          parseCli(showAtTag(root, tag, "src/cli.ts")),
          prevTag ? parseCli(showAtTag(root, prevTag, "src/cli.ts")) : null,
        ),
        env_vars: diffSurface(
          parseEnv(showAtTag(root, tag, "src/worker_env.ts")),
          prevTag ? parseEnv(showAtTag(root, prevTag, "src/worker_env.ts")) : null,
        ),
        domain_types: diffSurface(
          parseDomainTypes(root, tag),
          prevTag ? parseDomainTypes(root, prevTag) : null,
        ),
      },
    });
  }

  // laws.before chains from the predecessor's after; the earliest tag keeps null.
  for (let i = 1; i < records.length; i++) {
    records[i]!.laws.before = records[i - 1]!.laws.after;
  }

  return records;
}
