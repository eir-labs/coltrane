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
  /** contract-release-compile-cache-v1 (O3) — the commit the tag resolved to when this record was
   *  compiled. A tag is immutable, so this is what makes a previously-compiled record REUSABLE: the
   *  compiler can confirm a cached record still describes its tag with one map lookup instead of the
   *  ~75 git reads a recompile costs. It is also the record's own address, in the sense the rest of
   *  the engine now uses the word — a release that names its commit can be checked offline. */
  commit: string;
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
  /** `false` for a tagged release; `true` for the one PENDING record `compileReleases({ pending })`
   *  appends — the version about to be published, compiled from HEAD before its tag is pushed. The
   *  field is always present so a consumer never has to guess whether a record is settled. */
  pending: boolean;
}

/** One claim in a release note, and the evidence path that backs it. `value` is the string a writing
 *  seat recorded as "the value read at that path"; the renderer resolves `evidence` against the record
 *  and marks the row UNSUPPORTED when the path is absent or holds a different value. */
export interface ReleaseNoteClaim {
  text: string;
  evidence: string;
  value?: string;
}

/** A release note (release-notes-v0): two registers of prose, the claims that back the headline, and
 *  the surfaces a compiler could not read. The renderer turns this into markdown; it never presents a
 *  claim the record does not support. */
export interface ReleaseNote {
  version: string;
  headline: string;
  plain_md: string;
  formal_md: string;
  claims: ReleaseNoteClaim[];
  unreadable?: string[];
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
export function surfacesAtTag(root: string, tag: string): TagSurfaces {
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

/** Assemble one record from an already-parsed surface bundle. `ref` is the git ref the date and the
 *  commit range END are read from — a tag for a settled release, `HEAD` for the pending one — and
 *  `rangeStart` is the predecessor the range and the surface diff run against (`null` for the earliest
 *  release, which reports its whole surface as added). Pulling this out of the loop lets the pending
 *  record be compiled through EXACTLY the same path as a tagged one, so the two can only differ in the
 *  `pending` flag (I1). `laws.before` is filled by the caller's chaining pass. */
function assembleRecord(
  root: string,
  meta: { version: string; tag: string; ref: string; commit: string; rangeStart: string | null; pending: boolean },
  after: TagSurfaces,
  before: TagSurfaces | null,
): ReleaseRecord {
  // F1 — a surface whose FILE was present but yielded nothing readable is NAMED, so a bare `null` is
  // never mistaken for "nothing changed"; an absent file is not named. mcp.ts backs two surface keys.
  const surfaceUnread: string[] = [];
  if (after.mcpPresent && after.mcp === null) surfaceUnread.push("mcp_tools", "mcp_tool_args");
  if (after.cliPresent && after.cli === null) surfaceUnread.push("cli_flags");
  if (after.envPresent && after.env === null) surfaceUnread.push("env_vars");
  surfaceUnread.sort();

  return {
    version: meta.version,
    tag: meta.tag,
    commit: meta.commit,
    date: gitCapture(root, ["log", "-1", "--format=%cI", meta.ref]).trim(),
    commits: rangeCommits(root, meta.rangeStart, meta.ref),
    bump: rangeBump(root, meta.rangeStart, meta.ref),
    laws: { before: null, after: after.laws.laws, files: after.laws.files },
    surface: {
      mcp_tools: diffSurface(after.mcp ? after.mcp.tools : null, before?.mcp ? before.mcp.tools : null),
      mcp_tool_args: diffSurface(after.mcp ? after.mcp.args : null, before?.mcp ? before.mcp.args : null),
      cli_flags: diffSurface(after.cli, before?.cli ?? null),
      env_vars: diffSurface(after.env, before?.env ?? null),
      domain_types: diffSurface(after.domainTypes, before?.domainTypes ?? null),
    },
    surface_unread: surfaceUnread,
    pending: meta.pending,
  };
}

/**
 * Compile a ReleaseRecord per v* tag, oldest first, reading every field AT the tag. Throws — never
 * returns `[]` — when `tree_root` is not a git repository, or is one that holds no v* tag: an empty
 * list would read as "this project has no releases", a different and false claim from "there is no
 * repository to read" or "there are no tags yet".
 *
 * With `pending: { version }`, ONE further record is appended for the commits since the last tag,
 * compiled through the same path as a tagged release (tag = `v<version>`, date/commits/laws/surface
 * read from HEAD against the last tag) and marked `pending: true`. It is the record the tag WOULD
 * carry once cut — the package can then ship the history it is itself part of. A pending version a tag
 * already holds is refused by name, rather than emit two records for one version.
 */
export function compileReleases(opts: {
  tree_root: string;
  pending?: { version: string };
  /** contract-release-compile-cache-v1 — previously-compiled records. Each one whose `tag` still
   *  resolves to the `commit` it names is REUSED VERBATIM; every other tag is compiled as before.
   *  The repository, never the cache, decides which releases exist: an entry naming a tag the tree no
   *  longer holds is dropped (F1), and a `pending` entry is always ignored because HEAD moves (O6).
   *  Absent or empty means "nothing to reuse" and the compile is exactly what it always was (F2). */
  cache?: readonly ReleaseRecord[];
  /** Injected for tests. Production reads the surface with `surfacesAtTag`; the seam exists so a law
   *  can OBSERVE that a fully-cached compile reads no surface at all (O5), which is the only way the
   *  cost claim can go red when the wire is cut. */
  deps?: { surfaces?: (root: string, tag: string) => TagSurfaces };
}): ReleaseRecord[] {
  const root = opts.tree_root;
  const readSurfaces = opts.deps?.surfaces ?? surfacesAtTag;

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

  // F1 (history) — a pending version a tag already holds would be two records for one version. Refuse
  // by name, before any compilation, naming both the version and the tag that already holds it.
  const pendingTag = opts.pending ? `v${opts.pending.version}` : null;
  if (opts.pending && pendingTag !== null && tags.includes(pendingTag)) {
    throw new Error(
      `compileReleases: pending version ${opts.pending.version} is already released as tag ${pendingTag} — refusing to emit a second record for one version`,
    );
  }

  // contract-release-compile-cache-v1 (O5) — ONE git read resolves every tag, rather than one per
  // tag. A lightweight tag's `objectname` IS its commit; an annotated tag's commit is the
  // dereferenced `*objectname`, so prefer that when it is present.
  const tagCommit = new Map<string, string>();
  for (const line of gitCapture(root, [
    "for-each-ref",
    "--format=%(refname:short)\t%(objectname)\t%(*objectname)",
    "refs/tags/v*",
  ]).split("\n")) {
    if (!line.trim()) continue;
    const [name, obj, deref] = line.split("\t");
    if (!name) continue;
    tagCommit.set(name, (deref && deref.length > 0 ? deref : obj) ?? "");
  }

  // A cached record is usable only for a tag the tree still holds, at the commit the record names.
  // `pending` entries never qualify: the record they describe is HEAD, which moves (O6).
  const reusable = new Map<string, ReleaseRecord>();
  for (const r of opts.cache ?? []) {
    if (r.pending) continue;
    const live = tagCommit.get(r.tag);
    if (live !== undefined && live !== "" && r.commit === live) reusable.set(r.tag, r);
  }

  const records: ReleaseRecord[] = [];
  let before: TagSurfaces | null = null;
  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i]!;
    const prevTag = i > 0 ? tags[i - 1]! : null;

    const cached = reusable.get(tag);
    if (cached) {
      // Reused verbatim, and NO surface is read for it. The next tag's `before` is therefore not in
      // hand; it is read on demand below, once, only if a later tag actually needs compiling.
      // Cloned one level deep because the chaining pass below writes `laws.before`; a reused record
      // must not mutate the caller's cache array under it.
      records.push({ ...cached, laws: { ...cached.laws } });
      before = null;
      continue;
    }

    // Parse every surface at this tag ONCE; the previous iteration's bundle is this tag's "before",
    // so no tag's content is fetched twice. Presence and readability are kept apart inside assemble.
    // After a run of reused records `before` is null, so the predecessor's surface is read here —
    // one read to re-enter the chain, not one per skipped tag.
    if (before === null && prevTag !== null) before = readSurfaces(root, prevTag);
    const after = readSurfaces(root, tag);
    records.push(assembleRecord(root, { version: tag.replace(/^v/, ""), tag, ref: tag, commit: tagCommit.get(tag) ?? gitCapture(root, ["rev-parse", `${tag}^{commit}`]).trim(), rangeStart: prevTag, pending: false }, after, before));
    before = after;
  }

  // The pending release: HEAD compiled as if it were the tag `v<version>`, diffed against the last
  // tag (which `before` still holds), marked pending. Same path as a tagged record, so it equals the
  // record that tag would carry save the flag.
  if (opts.pending && pendingTag !== null) {
    const lastTag = tags[tags.length - 1]!;
    // The pending record diffs against the last tag. If that tag was reused, its surface was never
    // read, so read it now — the pending diff is against the tree, never against the cache.
    if (before === null) before = readSurfaces(root, lastTag);
    const headSurfaces = readSurfaces(root, "HEAD");
    records.push(
      assembleRecord(
        root,
        { version: opts.pending.version, tag: pendingTag, ref: "HEAD", commit: gitCapture(root, ["rev-parse", "HEAD^{commit}"]).trim(), rangeStart: lastTag, pending: true },
        headSurfaces,
        before,
      ),
    );
  }

  // laws.before chains from the predecessor's after; the earliest release keeps null.
  for (let i = 1; i < records.length; i++) {
    records[i]!.laws.before = records[i - 1]!.laws.after;
  }

  return records;
}

/** The whole release history as a stable JSON document, NEWEST first — the file the package ships so
 *  the changelog UI reads a settled artifact rather than shelling out to git. Pretty-printed (2-space)
 *  with a single trailing newline, byte-identical for the same inputs. Same options as
 *  `compileReleases`, so a pending version leads the document. */
export function releasesJson(options: {
  tree_root: string;
  pending?: { version: string };
  /** contract-release-compile-cache-v1 — passed straight to `compileReleases`. The emitter hands it
   *  the records from the document it is about to overwrite, which is what makes a rebuild
   *  incremental instead of a full 80-tag recompile. */
  cache?: readonly ReleaseRecord[];
}): string {
  const releases = compileReleases(options).reverse();
  return JSON.stringify({ generated_from: "compileReleases", releases }, null, 2) + "\n";
}

/** Resolve a dotted/indexed evidence path (`laws.after`, `surface.cli_flags.added[0]`) against a
 *  record. Returns whether the path resolved and the value it reached — the plain way: a segment is a
 *  key, and any `[n]` on it is an array index applied in order. A key missing on an object, or an
 *  index off the end of an array, does not resolve. */
function resolveEvidencePath(record: ReleaseRecord, path: string): { resolved: boolean; value: unknown } {
  let cur: unknown = record;
  for (const segment of path.split(".")) {
    const keyMatch = /^[^[\]]*/.exec(segment);
    const key = keyMatch ? keyMatch[0] : "";
    const steps: (string | number)[] = [];
    if (key !== "") steps.push(key);
    const idxRe = /\[(\d+)\]/g;
    let idx: RegExpExecArray | null;
    while ((idx = idxRe.exec(segment)) !== null) steps.push(Number(idx[1]));
    for (const step of steps) {
      if (cur === null || cur === undefined) return { resolved: false, value: undefined };
      if (typeof step === "number") {
        if (!Array.isArray(cur) || step >= cur.length) return { resolved: false, value: undefined };
        cur = cur[step];
      } else {
        if (typeof cur !== "object" || cur === null || !(step in (cur as Record<string, unknown>))) {
          return { resolved: false, value: undefined };
        }
        cur = (cur as Record<string, unknown>)[step];
      }
    }
  }
  return { resolved: true, value: cur };
}

/** The value at an evidence path, as the string a claim's `value` is compared against: a string is
 *  itself, anything else is JSON-stringified so `150` reads as `"150"` and an array reads as its JSON. */
function evidenceValueString(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Render one release note to markdown: the headline as a heading, then the plain register, then the
 *  formal register, then an evidence section with one row per claim. Every field the note declares is
 *  rendered; a surface named in `unreadable` is STATED as unreadable, never omitted. A claim whose
 *  `evidence` path does not resolve in the record, or resolves to a different value than its `value`,
 *  is marked UNSUPPORTED naming what the record actually holds — it is never dropped and never shown
 *  as if evidenced. The rendering is derived from the NOTE: no evidence row appears that the note did
 *  not claim (I2). */
export function renderReleaseNote(note: ReleaseNote, record: ReleaseRecord): string {
  const lines: string[] = [];
  lines.push(`# ${note.headline}`, "");
  lines.push(note.plain_md, "");
  lines.push(note.formal_md, "");

  lines.push("## Evidence", "");
  for (const claim of note.claims) {
    const { resolved, value } = resolveEvidencePath(record, claim.evidence);
    const held = resolved ? evidenceValueString(value) : null;
    const claimed = claim.value;
    // Supported iff the path resolved AND (no value was claimed, or the claimed value matches what the
    // record holds). Otherwise the row is marked UNSUPPORTED naming what the record actually holds.
    const supported = resolved && (claimed === undefined || held === claimed);
    if (supported) {
      lines.push(`- ${claim.text} — \`${claim.evidence}\` → \`${held ?? ""}\``);
    } else if (!resolved) {
      lines.push(`- ${claim.text} — \`${claim.evidence}\` → UNSUPPORTED (the path does not resolve in the record)`);
    } else {
      lines.push(`- ${claim.text} — \`${claim.evidence}\` → UNSUPPORTED (the record holds \`${held}\`)`);
    }
  }

  const unreadable = note.unreadable ?? [];
  if (unreadable.length > 0) {
    lines.push("", "## Unreadable surfaces", "");
    for (const surface of unreadable) {
      lines.push(`- \`${surface}\` could not be read at this release`);
    }
  }

  return lines.join("\n") + "\n";
}
