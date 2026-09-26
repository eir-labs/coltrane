// layout_grants.ts — a seat's grants come from the layout of the repository it runs against.
//
// An agent's `allowed_tools` may hold ROLE TOKENS — `Write(@source)`, `Edit(@tests)`, `Bash(@laws)` —
// alongside literal grants. A role token is a question to the repository ("what is your source?"),
// and ONLY the layout of the tree the gig runs against (`coltrane.layout.json`, LayoutSchema in
// src/genome_schema.ts) answers it. Before this, a new repository shape was an agent amendment, and
// the amendment applied to every repository that agent was ever seated in (chancery 000022/000023).
//
// resolveSeatGrants is the ONE resolution, called by both invokers and by runGig (preflight and the
// chair record), in this order — and only the first step may produce a string the agent did not
// literally write:
//
//   1. EXPAND role tokens through the layout: a path role → one `<Tool>(<glob>)` per glob; a command
//      role → `Bash(<prefix>:*)` per prefix. Literal grants pass through untouched, in order.
//      A token whose role the layout does not declare — or any token with NO layout — grants
//      NOTHING and yields a refusal naming the role. Never a `**` default: that is the widening this
//      module exists to end, arriving by omission instead of by amendment.
//   2. NARROW Write/Edit by the change's `target_paths`: a grant survives only for the targets its
//      glob covers, narrowed to exactly those paths. Absent → no narrowing (`target_paths_applied:
//      false`, recorded, never silent). `[]` → no Write/Edit at all (applied: true). Bash, Read and
//      every other grant are not path grants and pass through.
//   3. NARROW by the venue's equipment, through the shared `venueEffectiveTools` oracle.
//
// NO SELF-WIDENING. The layout file lives in the tree the seat edits; a seat that can rewrite it
// authors its own ceiling for every later gig. A glob such as `**` cannot be written "minus one file"
// in the CLI's permission syntax, so the form is a DENY: whenever a Write/Edit the seat holds covers
// the layout file, `denials` carries `Write(coltrane.layout.json)` / `Edit(coltrane.layout.json)`, and
// the exact grant is never returned (the Claude invoker's NO OVER-DENIAL filter deletes a scoped deny
// when an exact grant of the same string is present). KNOWN LIMIT: Bash grants are not path-scoped —
// a Bash prefix that can write files (`sed -i`, `cp`) can still write the layout file.
//
// Resolution never mutates the agent it is handed.
import { posix } from "node:path";
import { lstatSync } from "node:fs";
import { venueEffectiveTools, type Venue } from "./chart.js";
import type { Agent } from "./composition.js";
import { carriesGrantStructure, type Layout } from "./genome_schema.js";
import { toolBaseName } from "./tool_providers.js";
import { grantCovers, grantMayReach, isProtectedPath, PROTECTED_PATHS, LAYOUT_FILE } from "./grant_scope.js";

export { LAYOUT_FILE } from "./grant_scope.js";

export type { Layout } from "./genome_schema.js";


/** The path-scoped write tools target_paths narrow and the layout-file deny covers. */
const WRITE_TOOLS: ReadonlySet<string> = new Set(["Write", "Edit"]);

/** Glob metacharacters. A target_paths entry is a PATH; one carrying these would become a grant
 *  pattern and widen the seat through the payload. */
const GLOB_META = /[*?[\]{}]/;

export interface RoleRefusal {
  /** The grant exactly as the agent declared it, e.g. `Write(@migrations)`. */
  token: string;
  /** The role the layout did not answer, e.g. `migrations`. */
  role: string;
  reason: string;
}

export interface SeatGrants {
  /** The effective grant set: expanded, narrowed by target_paths, narrowed by the venue. */
  grants: string[];
  /** One per role token the layout could not answer. Non-empty → the chair must be refused. */
  refusals: RoleRefusal[];
  /** Whether target_paths narrowed Write/Edit (present, even as []) or were absent. */
  target_paths_applied: boolean;
  /** Deny entries the spawn must carry so no grant can write the layout file. */
  denials: string[];
  /** The roles this seat HOLDS — each role token the layout answered. */
  held_roles: string[];
  /** The hosts the seat's Bash sandbox may reach: the layout's `egress` for the roles it holds, and
   *  nothing else. Empty by default (strictAllowlist, no host). */
  egress_hosts: string[];
  /** Whether the seat holds a git role (Bash(@git_stage|@git_commit|@git_push)): its sandbox then
   *  opens `.git` — never `.git/hooks` or `.git/config`. */
  git_open: boolean;
}

/**
 * THE CLI's `--allowedTools` SPLITTER (Claude Code 2.1.283's `Hp`), mirrored here: a value splits into
 * grants on `,` and on space OUTSIDE parentheses; `(` enters, the first `)` leaves (no nesting). The
 * engine uses it to prove every grant it emits is ONE grant to the CLI — a grant that splits into more
 * (a smuggled `Write`) is refused, and the invoker re-splits the joined argv before spawning.
 */
export function splitAsTheCliDoes(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    if (!v) continue;
    let cur = "";
    let inside = false;
    for (const ch of v) {
      if (ch === "(") { inside = true; cur += ch; }
      else if (ch === ")") { inside = false; cur += ch; }
      else if (ch === "," && !inside) { if (cur.trim()) out.push(cur.trim()); cur = ""; }
      else if (ch === " " && !inside) { if (cur.trim()) { out.push(cur.trim()); cur = ""; } }
      else if (ch === "," || ch === " ") cur += ch;
      else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
  }
  return out;
}

/** Is `grant` exactly one grant to the CLI? */
function isOneGrant(grant: string): boolean {
  const split = splitAsTheCliDoes([grant]);
  return split.length === 1 && split[0] === grant;
}

/** Git role → the layout's `git.<op>` key. */
const GIT_ROLE_KEYS: Readonly<Record<string, "stage" | "commit" | "push">> = { git_stage: "stage", git_commit: "commit", git_push: "push" };

export interface ResolveSeatGrantsArgs {
  agent: Agent;
  layout?: Layout | undefined;
  target_paths?: readonly string[] | undefined;
  venue?: Venue | undefined;
}

const ROLE_TOKEN = /^([A-Za-z_][A-Za-z0-9_]*)\(@([A-Za-z0-9_-]+)\)$/;

/** `Write(@source)` → { tool: "Write", role: "source" }; anything else → undefined (a literal). */
export function parseRoleToken(grant: string): { tool: string; role: string } | undefined {
  const m = ROLE_TOKEN.exec(grant.trim());
  return m ? { tool: m[1]!, role: m[2]! } : undefined;
}

/** The scope inside a grant's parentheses, or undefined for a bare grant. */
function scopeOf(grant: string): string | undefined {
  const open = grant.indexOf("(");
  if (open < 0 || !grant.endsWith(")")) return undefined;
  return grant.slice(open + 1, -1);
}

/** Does the grant's glob cover this repository-relative path, as the CLI reads it (src/grant_scope.ts,
 *  the one matcher)? A bare grant covers everything. */
function covers(scope: string | undefined, path: string): boolean {
  return scope === undefined || grantCovers(scope, path);
}

/**
 * Does this target_paths entry try to name a path OUTSIDE the tree, or by a spelling the grant check
 * does not see? A `..` segment (`src/../coltrane.layout.json` — which `src/**` matches by prefix), an
 * absolute path (`/etc/x`, `C:\\x`), a backslash (a Windows separator the posix glob reads as a
 * filename character), or a leading `~` (the CLI reads `Write(~/x)` as the home directory). Such an
 * entry is REFUSED — never normalised into something that looks plain, because the change did not
 * name that plain path.
 */
export function escapesTree(t: string): boolean {
  if (t.includes("\\")) return true;
  if (t.startsWith("/") || t.startsWith("~") || /^[A-Za-z]:/.test(t)) return true;
  return t.split("/").some((seg) => seg === "..");
}

/** A target as the grant will name it. Undefined → unusable (escaping, globbed, or empty) and narrowed
 *  away; the dispatch door has already refused the chair by name for the first two. Only a harmless
 *  spelling is tidied (a leading `./`, a doubled `/`) — nothing that could move the path. */
function normaliseTarget(t: string): string | undefined {
  if (GLOB_META.test(t) || escapesTree(t)) return undefined;
  const n = posix.normalize(t).replace(/^\.\//, "");
  if (n === "" || n === "." || escapesTree(n)) return undefined;
  return n;
}

/** target_paths entries that escape the tree — the dispatch door refuses these by name. */
export function escapingTargetPaths(targets: readonly string[] | undefined): string[] {
  return (targets ?? []).filter(escapesTree);
}

const own = (o: object | undefined, k: string): boolean => o !== undefined && Object.prototype.hasOwnProperty.call(o, k);

/**
 * The target_paths a gig payload carries, as the resolver takes them. Absent (or null) → undefined:
 * no narrowing. An array → its string entries. Anything else PRESENT is malformed and fails closed
 * as `[]` — a seat that cannot tell which paths its change names gets no Write/Edit.
 */
export function targetPathsOf(gigInput: Record<string, unknown> | undefined): string[] | undefined {
  const raw = gigInput?.["target_paths"];
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === "string");
}

/** target_paths entries carrying glob metacharacters — the dispatch door refuses these by name. */
export function globbedTargetPaths(targets: readonly string[] | undefined): string[] {
  return (targets ?? []).filter((t) => GLOB_META.test(t));
}

export function resolveSeatGrants(args: ResolveSeatGrantsArgs): SeatGrants {
  const { agent, layout, target_paths, venue } = args;
  const declared: readonly string[] = agent.allowed_tools ?? [];

  // ── 1 · expand role tokens through THIS repository's layout ──────────────────────────────────
  const expanded: string[] = [];
  const refusals: RoleRefusal[] = [];
  const refusedLiterals = new Set<string>();
  const heldRoles: string[] = [];
  /** An answered role whose entries carry grant structure is refused, naming the entry — an injected
   *  layout that never passed LayoutSchema is held to the same grammar. */
  const structural = (entries: readonly string[]): string | undefined => entries.find(carriesGrantStructure);
  const pushGenerated = (g: string) => {
    if (!expanded.includes(g)) expanded.push(g);
  };
  for (const g of declared) {
    const token = parseRoleToken(g);
    if (!token) {
      expanded.push(g);
      // A path-scoped Write/Edit LITERAL spelled `./x` or `a//b` is REFUSED, not rewritten: the CLI
      // silently preprocesses those spellings (src/grant_scope.ts cliAllowPattern — `./**` IS `**` to
      // it), so a grant that reads narrow and acts wide is not seated. It stays in the expansion so the
      // protected-path denials below are still computed over what it would have reached.
      const sc = scopeOf(g);
      if (WRITE_TOOLS.has(toolBaseName(g)) && sc !== undefined && isAmbiguousSpelling(sc)) {
        refusedLiterals.add(g);
        refusals.push({
          token: g, role: "(literal scope)",
          reason: `the scope "${sc}" is spelled with a leading "./" or an inner "//", which the CLI silently rewrites (./** is ** to it) — write it plainly`,
        });
      }
      continue;
    }
    const { tool, role } = token;
    if (layout === undefined) {
      refusals.push({
        token: g, role,
        reason: `no layout: the tree this gig runs against has no ${LAYOUT_FILE}, so role "${role}" has no answer and the token grants nothing`,
      });
      continue;
    }
    if (tool === "Bash") {
      const gitKey = own(GIT_ROLE_KEYS, role) ? GIT_ROLE_KEYS[role] : undefined;
      const prefixes = gitKey !== undefined
        ? (own(layout.git, gitKey) ? layout.git![gitKey] : undefined)
        : own(layout.commands, role) ? layout.commands![role as keyof NonNullable<Layout["commands"]>] : undefined;
      if (!prefixes || prefixes.length === 0) {
        refusals.push({ token: g, role, reason: `the layout declares no ${gitKey !== undefined ? "git" : "command"} role "${role}", so the token grants nothing` });
        continue;
      }
      const bad = structural(prefixes);
      if (bad !== undefined) {
        refusals.push({ token: g, role, reason: `the layout's entry "${bad}" for role "${role}" carries ( ) , or edge whitespace — the CLI would read it as grant structure and seat a grant nobody declared` });
        continue;
      }
      for (const p of prefixes) pushGenerated(`Bash(${p}:*)`);
      heldRoles.push(role);
      continue;
    }
    const globs = own(layout.paths, role) ? layout.paths![role as keyof NonNullable<Layout["paths"]>] : undefined;
    if (!globs || globs.length === 0) {
      refusals.push({ token: g, role, reason: `the layout declares no path role "${role}", so the token grants nothing` });
      continue;
    }
    const bad = structural(globs);
    if (bad !== undefined) {
      refusals.push({ token: g, role, reason: `the layout's entry "${bad}" for role "${role}" carries ( ) , or edge whitespace — the CLI would read it as grant structure and seat a grant nobody declared` });
      continue;
    }
    for (const glob of globs) pushGenerated(`${tool}(${glob})`);
    heldRoles.push(role);
  }

  // ── no self-widening: deny every PROTECTED path (the layout file, .git, .claude, .coltrane) to
  // every Write/Edit that could reach it under the CLI's own matching (grantMayReach — gitignore
  // semantics, where `**` DOES reach dot-directories). `code_tool_access` "write"/"full" keeps bare
  // Write/Edit in the Claude cage whether or not they are granted (claude_invoker.ts codeToolsKept), so
  // the seat holds them and every protected path is denied for them too. A file is denied by its path,
  // a directory by `<dir>/**`.
  const implicitWrite = agent.code_tool_access === "write" || agent.code_tool_access === "full";
  const denials: string[] = [];
  for (const target of PROTECTED_PATHS) {
    for (const tool of WRITE_TOOLS) {
      if (implicitWrite || expanded.some((g) => toolBaseName(g) === tool && grantMayReach(scopeOf(g), target))) {
        denials.push(`${tool}(${target.kind === "file" ? target.path : `${target.path}/**`})`);
      }
    }
  }
  // A grant whose scope NAMES a protected path is never returned: the Claude invoker's NO OVER-DENIAL
  // filter deletes a scoped deny when an exact grant of the same string is present.
  const isProtectedGrant = (g: string) => {
    if (!WRITE_TOOLS.has(toolBaseName(g))) return false;
    const sc = scopeOf(g);
    if (sc === undefined) return false;
    const n = posix.normalize(sc).replace(/^\.\//, "").replace(/\/\*\*$/, "").replace(/\/+$/, "");
    return denials.includes(g) || isProtectedPath(n);
  };

  // ── 2 · narrow Write/Edit to the change's target_paths ───────────────────────────────────────
  const target_paths_applied = target_paths !== undefined;
  let narrowed: string[];
  if (!target_paths_applied) {
    narrowed = expanded.filter((g) => !isProtectedGrant(g) && !refusedLiterals.has(g));
  } else {
    const targets = target_paths
      .map(normaliseTarget)
      .filter((t): t is string => t !== undefined && !isProtectedPath(t));
    narrowed = [];
    for (const g of expanded.filter((x) => !isProtectedGrant(x) && !refusedLiterals.has(x))) {
      const tool = toolBaseName(g);
      if (!WRITE_TOOLS.has(tool)) {
        narrowed.push(g);
        continue;
      }
      const scope = scopeOf(g);
      for (const t of targets) {
        const n = `${tool}(${t})`;
        if (covers(scope, t) && !narrowed.includes(n)) narrowed.push(n);
      }
    }
  }

  // ── 3 · narrow by the room (the shared oracle; a room can only ever remove) ──────────────────
  const roomed = venue ? venueEffectiveTools({ ...agent, allowed_tools: narrowed }, venue) : narrowed;

  // ── the CLI's grammar: every grant the seat is handed must be ONE grant to the CLI's splitter. A
  // literal that is several (`Bash(x),Write`) is refused, naming it — never emitted.
  const grants: string[] = [];
  for (const g of roomed) {
    if (isOneGrant(g)) { grants.push(g); continue; }
    refusals.push({ token: g, role: "(grant grammar)", reason: `the CLI's --allowedTools splitter reads "${g}" as ${JSON.stringify(splitAsTheCliDoes([g]))} — a grant that smuggles another is never seated` });
  }

  // ── the network and git the seat's Bash may reach: only what the layout declares for roles it holds.
  const egress_hosts: string[] = [];
  for (const role of heldRoles) {
    const hosts = layout?.egress && own(layout.egress, role) ? layout.egress[role as keyof NonNullable<Layout["egress"]>] : undefined;
    for (const h of hosts ?? []) {
      if (carriesGrantStructure(h)) continue;
      if (!egress_hosts.includes(h)) egress_hosts.push(h);
    }
  }
  const git_open = heldRoles.some((r) => own(GIT_ROLE_KEYS, r));

  return { grants, refusals, target_paths_applied, denials, held_roles: heldRoles, egress_hosts, git_open };
}

/** A path scope spelled in a form the CLI silently rewrites: a leading `./`, or `//` anywhere after the
 *  first character (a leading `//` is an ABSOLUTE rule, judged as rooted outside the tree). */
function isAmbiguousSpelling(scope: string): boolean {
  return scope.startsWith("./") || scope.slice(1).includes("//");
}

/** One line naming every refused role token — the message a refused chair carries. */
export function describeRoleRefusals(agentSlug: string, refusals: readonly RoleRefusal[]): string {
  return (
    `agent "${agentSlug}" holds grant(s) that cannot be seated — ` +
    refusals.map((r) => `${r.token} (role "${r.role}": ${r.reason})`).join("; ") +
    `. Such a grant grants nothing and the chair is refused rather than widened.`
  );
}

/**
 * THE WRITE SCOPE a seat holds, as the post-seat DIFF GATE judges it (runGig): the scopes of its
 * resolved Write/Edit grants — target-narrowed when target_paths applied, the expanded globs when not.
 * A bare Write/Edit grant, or `code_tool_access` "write"/"full" (which keeps bare Write/Edit in the
 * cage), reaches every path. Bash contributes NOTHING: a command prefix names no paths, so whatever a
 * seat's Bash changed must still lie inside its Write/Edit scope.
 */
export interface WriteScope {
  everywhere: boolean;
  globs: string[];
}

export function writeScopeOf(agent: Agent, grants: readonly string[]): WriteScope {
  let everywhere = agent.code_tool_access === "write" || agent.code_tool_access === "full";
  const globs: string[] = [];
  for (const g of grants) {
    if (!WRITE_TOOLS.has(toolBaseName(g))) continue;
    const s = scopeOf(g);
    if (s === undefined) everywhere = true;
    else if (!globs.includes(s)) globs.push(s);
  }
  return { everywhere, globs };
}

/** Is this repository-relative path one the scope may change? Protected paths never are. */
export function inWriteScope(path: string, scope: WriteScope): boolean {
  if (isProtectedPath(path)) return false;
  return scope.everywhere || scope.globs.some((g) => covers(g, path));
}

/**
 * Can this seat change the tree at all through its host tools? A Write/Edit scope, or Bash (granted,
 * or kept by `code_tool_access` "full"). A seat with none of these has no host tool that writes — the
 * cage denies every unheld builtin — so the diff gate has nothing of its to judge. Every seat that CAN
 * write is gated, and refused if its tree cannot be read.
 */
export function seatCanWrite(agent: Agent, grants: readonly string[]): boolean {
  const scope = writeScopeOf(agent, grants);
  return scope.everywhere || scope.globs.length > 0 || agent.code_tool_access === "full" || grants.some((g) => toolBaseName(g) === "Bash");
}

/**
 * A target that names a protected file by ANOTHER PATH: a symlink (the target itself or any directory
 * above it), or a hardlink. Protection follows the FILE, not its name — `alias.json -> coltrane.layout.json`
 * and a second link to the layout file's inode are the layout file. Judged against the real tree where
 * the path exists: any component that is a symlink, or an existing file with more than one link, refuses
 * the target (a hardlink's other names cannot be enumerated cheaply, so none is trusted). Returns the
 * reason, or undefined for a plain path (including one that does not exist yet).
 */
export function linkedTargetRefusal(tree: string, target: string): string | undefined {
  const parts = target.split("/").filter((p) => p.length > 0);
  let cur = tree;
  for (let i = 0; i < parts.length; i++) {
    cur = `${cur}/${parts[i]}`;
    let st;
    try { st = lstatSync(cur); } catch { return undefined; } // does not exist from here down: a new file
    if (st.isSymbolicLink()) {
      return `target_paths entry "${target}" passes through a symlink ("${parts.slice(0, i + 1).join("/")}") — a protected path is judged by the file, and a link can name a protected one`;
    }
    if (i === parts.length - 1 && st.isFile() && st.nlink > 1) {
      return `target_paths entry "${target}" is a hardlink (${st.nlink} links) — a protected path is judged by the file, and a link can be the layout file`;
    }
  }
  return undefined;
}
