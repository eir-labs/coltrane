// THE ENGINE CHILD A DRAINED CLAUDE SEAT IS HANDED — built from the RUN's registry, never the file genome.
//
// A Claude seat seals in-band: it calls `output_write` on an engine MCP server spawned as a child of
// the `claude` CLI, and that server (validate mode) judges the payload before the runtime seals it.
// Two gates, one predicate (checkWritable, src/outputs.ts) — but only if both hold the SAME types.
//
// The engine child boots `bootstrapServerDeps(COLTRANE_GENOME ?? cwd)`: the FILE genome. On the
// server door that is the genome the run seals against. On the drain it is not — the drain seals
// against the ORG STORE's types, and its cwd is a freshly cloned, untrusted repository. Handing the
// seat the server door's engine config unchanged would put an in-turn gate in front of the chair
// that disagrees with the seal in BOTH directions: accepting what the seal will refuse (the chair
// stops, the gig dies at the seal) and refusing what the seal would accept (the chair is told to
// "fix" a correct payload). So the child is pointed at a genome root holding exactly the run
// registry's types, and that root is checked to reload as the same registry before it is used.
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadGenome } from "./loader.js";
import { loadRegistry, type Registry } from "./registry.js";
import { canonJson, sha256Hex } from "./canonical_form.js";

/** The compiled engine server entry this process can spawn, or undefined when there is no build.
 *  Built output runs beside it (dist/src/server_entry.js); running from source (vitest) it is the
 *  package's own dist/. Absent → the caller wires no engine server, and the Claude invoker refuses
 *  the chair loudly ("cannot seal … no server config resolved") rather than seating it blind. */
export function engineServerEntry(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const sibling = join(here, "server_entry.js");
  if (existsSync(sibling)) return sibling;
  let dir = here;
  for (let i = 0; i < 4; i++) {
    const candidate = join(dir, "dist", "src", "server_entry.js");
    if (existsSync(candidate)) return candidate;
    const up = resolve(dir, "..");
    if (up === dir) break;
    dir = up;
  }
  return undefined;
}

/** What a registry would make the seal enforce, PER TYPE — slug → the canonical form of its core,
 *  domain and effective schema. The reload proof compares CONTENT type by type, so it can name the
 *  type that changed, not merely notice that something did. */
function sealViews(registry: Registry): Map<string, string> {
  return new Map(
    registry
      .listTypes()
      .map((t): [string, string] => [t.slug, canonJson({ extends: t.extends, domain: t.domain, effective: registry.effectiveSchema(t.slug) ?? null })]),
  );
}

/** One string for the whole registry — the content address of the root. */
function sealDigest(views: ReadonlyMap<string, string>): string {
  return sha256Hex(canonJson([...views.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
}

/** The file that carries one type. Named by the SHA-256 of its own bytes: SLUGS ARE NOT IDENTIFIERS
 *  (founder ruling). A slug is tenant-controlled text — `../../x`, `/abs`, a NUL, `a/b`, `.` — and it
 *  never becomes a path segment. The loader reads every file in domain_types/ and takes each type's
 *  slug from what the file SAYS, so the child resolves a type by its content, never by a path join. */
function typeFile(t: ReturnType<Registry["listTypes"]>[number]): { name: string; bytes: string } {
  const bytes = JSON.stringify({
    slug: t.slug,
    version: t.version ?? 1,
    extends: t.extends,
    domain: t.domain,
    status: "active",
    schema: t.schema,
    required_fields: [...t.required_fields],
  });
  return { name: `${sha256Hex(bytes)}.json`, bytes };
}

/** How a root differs from what the run seals against, type by type. Empty = it proves. */
interface ReloadDiff { dropped: { slug: string; reason: string }[]; changed: string[]; unexpected: string[] }

function reloadDiff(dir: string, want: ReadonlyMap<string, string>, slugOfFile: ReadonlyMap<string, string>): ReloadDiff | string {
  let genome: ReturnType<typeof loadGenome>;
  try {
    genome = loadGenome(dir);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  const got = sealViews(loadRegistry(genome));
  // The loader's own reason for each file it refused, carried back to the type through the engine's
  // hash → slug index (the file's name is the engine's, so this is the only way back to the slug).
  const reasonOf = new Map<string, string>();
  for (const le of genome.load_errors) {
    const file = le.path.split(/[\\/]/).pop() ?? "";
    const slug = slugOfFile.get(file) ?? (typeof le.slug === "string" ? le.slug : undefined);
    if (slug !== undefined && !reasonOf.has(slug)) reasonOf.set(slug, le.error);
  }
  const diff: ReloadDiff = { dropped: [], changed: [], unexpected: [] };
  for (const [slug, view] of want) {
    const back = got.get(slug);
    if (back === undefined) diff.dropped.push({ slug, reason: reasonOf.get(slug) ?? "absent on reload, no loader error" });
    else if (back !== view) diff.changed.push(slug);
  }
  for (const slug of got.keys()) if (!want.has(slug)) diff.unexpected.push(slug);
  return diff;
}

const isClean = (d: ReloadDiff | string): d is ReloadDiff =>
  typeof d !== "string" && d.dropped.length === 0 && d.changed.length === 0 && d.unexpected.length === 0;

/** The refusal an operator reads — in the chair's error and in the gig's terminal record. */
function refusal(d: ReloadDiff | string): string {
  const parts = typeof d === "string"
    ? [`the root does not load: ${d}`]
    : [
        ...d.dropped.map((x) => `type ${JSON.stringify(x.slug)} is DROPPED on reload — ${x.reason}`),
        ...d.changed.map((s) => `type ${JSON.stringify(s)} CHANGES on reload — its effective schema is not what the run seals against (a value JSON cannot carry?)`),
        ...d.unexpected.map((s) => `type ${JSON.stringify(s)} APPEARS on reload but the run does not hold it`),
      ];
  return (
    `cannot seat a Claude chair on the drain: the run's types do not reload as the same registry in the ` +
    `engine child, so its in-turn output_write gate would judge by a different genome than the seal. ` +
    parts.join("; ")
  );
}

/**
 * Materialize `registry`'s types as a genome root the engine child can boot from, and PROVE it: the
 * root is reloaded through the same loader the child runs, and its registry must answer every type
 * with the same CONTENT as `registry` does. A type the loader would drop, or one that comes back
 * different, makes the two gates disagree silently — so a mismatch is a refusal naming each type and
 * why, never a best effort.
 *
 * Every path is the engine's: the root is named by the digest of the run's types, each file by the
 * hash of its bytes. No part of any slug reaches the filesystem. Content-addressed under the OS temp
 * dir, so a drain that claims many gigs over one org's types reuses one root; a root found on disk is
 * re-proved before use.
 */
export function materializeRunGenome(registry: Registry): string {
  const want = sealViews(registry);
  const files = registry.listTypes().map((t) => ({ slug: t.slug, ...typeFile(t) }));
  const slugOfFile = new Map(files.map((f) => [f.name, f.slug]));
  const root = join(tmpdir(), `coltrane-run-genome-${sealDigest(want).slice(0, 24)}`);
  if (existsSync(root) && isClean(reloadDiff(root, want, slugOfFile))) return root;

  const staging = mkdtempSync(join(tmpdir(), "coltrane-run-genome-staging-"));
  const typesDir = join(staging, "domain_types");
  mkdirSync(typesDir);
  for (const f of files) writeFileSync(join(typesDir, f.name), f.bytes);
  const diff = reloadDiff(staging, want, slugOfFile);
  if (!isClean(diff)) {
    rmSync(staging, { recursive: true, force: true });
    throw new Error(refusal(diff));
  }
  try {
    rmSync(root, { recursive: true, force: true });
    renameSync(staging, root);
  } catch {
    // A concurrent drain won the rename; its root is content-addressed to the same types. Use it if it
    // proves, else keep our own staging copy (proved above) rather than the unproved one.
    if (existsSync(root) && isClean(reloadDiff(root, want, slugOfFile))) {
      rmSync(staging, { recursive: true, force: true });
      return root;
    }
    return staging;
  }
  return root;
}

/**
 * THE ONE ENGINE-CHILD CONFIG BOTH DOORS HAND A CLAUDE SEAT. The compiled entry by ABSOLUTE path (so it
 * starts whatever the `claude` CLI's cwd is — a relative `dist/src/server_entry.js` resolves against
 * the seat's cwd, which is a clone or a worktree, not the engine), run directly (no hot-reload relay —
 * a seat's child lives one turn), with COLTRANE_GENOME pinned to the genome root the RUN seals against
 * (never left to fall back to the cwd's genome). `extraEnv` carries a deployment's own additions; the
 * two pins win over it. Undefined when there is no build (see engineServerEntry).
 */
export function engineServerAt(genomeRoot: string, extraEnv: Record<string, unknown> = {}): Record<string, unknown> | undefined {
  const entry = engineServerEntry();
  if (!entry) return undefined;
  return {
    command: process.execPath,
    args: [entry],
    env: { ...extraEnv, COLTRANE_GENOME: resolve(genomeRoot), COLTRANE_SERVER_DIRECT: "1" },
  };
}

/** The drain's door: the run registry has no genome root of its own (it is the org store's), so it is
 *  materialized as one first and proved to reload identically. */
export function engineServerForRegistry(registry: Registry): Record<string, unknown> | undefined {
  if (!engineServerEntry()) return undefined;
  return engineServerAt(materializeRunGenome(registry));
}

/** The server door's: the engine entry of the deployment's server map (.mcp.json) re-pinned to the
 *  door's own bootstrap genome root. Any other server, and the declared entry's own env, pass through. */
export function withEngineServerAt(configs: Record<string, unknown>, genomeRoot: string, engineSlug: string): Record<string, unknown> {
  const declared = configs[engineSlug];
  const declaredEnv = declared && typeof declared === "object" && (declared as { env?: unknown }).env && typeof (declared as { env?: unknown }).env === "object"
    ? ((declared as { env: Record<string, unknown> }).env)
    : {};
  const pinned = engineServerAt(genomeRoot, declaredEnv);
  return pinned ? { ...configs, [engineSlug]: pinned } : configs;
}
