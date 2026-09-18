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
  /** The surface keys that were PRESENT at the tag but yielded no readable entry, sorted. A surface
   *  whose FILE is absent is NOT unread — it is simply absent, and its list is `null` for that reason;
   *  only a file that was there and could not be parsed is named here. Always present, empty when
   *  every present surface read. Named so a changelog can say "could not read the tool registry here"
   *  instead of showing a silent gap that reads as "nothing changed". */
  surface_unread: string[];
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

/** The MCP tool slugs and their advertised argument names from src/mcp.ts. Read from the tool
 *  ENTRIES themselves — any `{ slug: "<name>" … input_schema: obj({ … }) }` object — so the array's
 *  NAME, its type annotation and any `.map()` export are irrelevant: the real registry is a typed
 *  `TOOL_DEFS` array exported through `.map()`, and the simplified control fixture is
 *  `export const MCP_TOOLS = [`, and both parse the same way. `null` when no such entry can be read
 *  (the file is absent, or present but not a tool registry). Args are `"<slug>.<argument>"`. */
function parseMcp(content: string | null): { tools: Set<string>; args: Set<string> } | null {
  if (content === null) return null;
  const tools = new Set<string>();
  const args = new Set<string>();
  const toolRe = /slug:\s*"([^"]+)"[\s\S]*?input_schema:\s*obj\(\{([\s\S]*?)\}\)/g;
  let m: RegExpExecArray | null;
  while ((m = toolRe.exec(content)) !== null) {
    const slug = m[1]!;
    tools.add(slug);
    // TOP-LEVEL keys only. A nested object argument (`budget: { type: "object", properties: { … } }`)
    // carries JSON-Schema keywords, and a flat scan reports `type` and `properties` as arguments the
    // tool accepts — measured on this repo's own gig_dispatch. Walk the body tracking brace depth and
    // take a key only at depth 0; the nested argument is still named, by its own key.
    const body = m[2]!;
    let depth = 0;
    let key = "";
    for (let i = 0; i < body.length; i++) {
      const ch = body[i]!;
      if (ch === "{" || ch === "(" || ch === "[") { depth++; key = ""; continue; }
      if (ch === "}" || ch === ")" || ch === "]") { depth = Math.max(0, depth - 1); key = ""; continue; }
      if (depth > 0) continue;
      if (/[A-Za-z0-9_$]/.test(ch)) { key += ch; continue; }
      if (ch === ":" && key.length > 0) args.add(`${slug}.${key}`);
      if (!/\s/.test(ch) || ch === ",") key = "";
      if (/\s/.test(ch) && key.length > 0) continue;
    }
  }
  // No tool ENTRY could be read — the file is present but not a tool registry. `null`, so the record
  // NAMES it unread rather than passing an empty tool set off as "nothing changed".
  if (tools.size === 0) return null;
  return { tools, args };
}

/** The long `--flags` from src/cli.ts. A flag is any line whose FIRST non-space characters are
 *  `--<name>`, anywhere in the file; the leading token is taken WITHOUT its `<placeholder>`
 *  (`--effort <low|…>` → `--effort`). No `HELP`/`USAGE` constant is required — the real block is a
 *  `USAGE` template literal — and a `--` token that is NOT the start of its line (`--check` inside a
 *  `coltrane …` usage example) is not a flag. `null` when no flag line can be read. */
function parseCli(content: string | null): Set<string> | null {
  if (content === null) return null;
  const flags = new Set<string>();
  const lineRe = /^[ \t]*(--[a-z][a-z0-9-]*)/;
  for (const line of content.split("\n")) {
    const m = lineRe.exec(line);
    if (m) flags.add(m[1]!);
  }
  if (flags.size === 0) return null;
  return flags;
}

/** The variable names from the worker environment contract in src/worker_env.ts, read from the
 *  `name: "…"` values of the ENTRIES — not from the bare identifier. A file that only MENTIONS
 *  WORKER_ENV_CONTRACT (a comment, a type whose `name: string;` field carries no quotes) but declares
 *  no entry array yields nothing, so it reads `null` (present-but-unread, NAMED by the record) rather
 *  than an empty set that would render the predecessor's whole env table as removed. `null` also when
 *  the file is absent. */
function parseEnv(content: string | null): Set<string> | null {
  if (content === null) return null;
  const names = new Set<string>();
  const re = /name:\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) names.add(m[1]!);
  if (names.size === 0) return null;
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

/** Every surface read AT one tag, parsed ONCE. Each of the three text surfaces carries its parsed
 *  form AND whether its file was present at the tag (F1 turns on present-but-unread ≠ absent). Cached
 *  per tag so tag `i`'s bundle is reused as tag `i+1`'s "before" — a tag's content is deterministic,
 *  so re-fetching it a second time only spends git subprocesses without changing the record. */
interface TagSurfaces {
  mcp: { tools: Set<string>; args: Set<string> } | null;
  mcpPresent: boolean;
  cli: Set<string> | null;
  cliPresent: boolean;
  env: Set<string> | null;
  envPresent: boolean;
  domainTypes: Set<string> | null;
  laws: { laws: number | null; files: number | null };
}

/** Read and parse every surface at `tag` with the minimum number of git reads — one `git show` per
 *  text surface, one `ls-tree` (+ a show per domain-type file) for domain_types, one for laws.sh. */
function surfacesAtTag(root: string, tag: string): TagSurfaces {
  const mcpContent = showAtTag(root, tag, "src/mcp.ts");
  const cliContent = showAtTag(root, tag, "src/cli.ts");
  const envContent = showAtTag(root, tag, "src/worker_env.ts");
  return {
    mcp: parseMcp(mcpContent),
    mcpPresent: mcpContent !== null,
    cli: parseCli(cliContent),
    cliPresent: cliContent !== null,
    env: parseEnv(envContent),
    envPresent: envContent !== null,
    domainTypes: parseDomainTypes(root, tag),
    laws: parseLaws(showAtTag(root, tag, "scripts/laws.sh")),
  };
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
  let before: TagSurfaces | null = null;
  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i]!;
    const prevTag = i > 0 ? tags[i - 1]! : null;

    // Parse every surface at this tag ONCE; the previous iteration's bundle is this tag's "before",
    // so no tag's content is fetched twice. Presence (was the file there?) is kept apart from
    // readability (could it be parsed?) — the distinction F1's surface_unread turns on.
    const after = surfacesAtTag(root, tag);

    // F1 — a surface whose FILE was present at the tag but yielded nothing readable is NAMED, so a
    // bare `null` is never mistaken for "nothing changed". A surface whose file is absent is not
    // named — absence is not the same as unread. mcp.ts backs two surface keys.
    const surfaceUnread: string[] = [];
    if (after.mcpPresent && after.mcp === null) surfaceUnread.push("mcp_tools", "mcp_tool_args");
    if (after.cliPresent && after.cli === null) surfaceUnread.push("cli_flags");
    if (after.envPresent && after.env === null) surfaceUnread.push("env_vars");
    surfaceUnread.sort();

    records.push({
      version: tag.replace(/^v/, ""),
      tag,
      date: gitCapture(root, ["log", "-1", "--format=%cI", tag]).trim(),
      commits: rangeCommits(root, prevTag, tag),
      bump: rangeBump(root, prevTag, tag),
      laws: { before: null, after: after.laws.laws, files: after.laws.files },
      surface: {
        mcp_tools: diffSurface(after.mcp ? after.mcp.tools : null, before?.mcp ? before.mcp.tools : null),
        mcp_tool_args: diffSurface(after.mcp ? after.mcp.args : null, before?.mcp ? before.mcp.args : null),
        cli_flags: diffSurface(after.cli, before?.cli ?? null),
        env_vars: diffSurface(after.env, before?.env ?? null),
        domain_types: diffSurface(after.domainTypes, before?.domainTypes ?? null),
      },
      surface_unread: surfaceUnread,
    });

    before = after;
  }

  // laws.before chains from the predecessor's after; the earliest tag keeps null.
  for (let i = 1; i < records.length; i++) {
    records[i]!.laws.before = records[i - 1]!.laws.after;
  }

  return records;
}
