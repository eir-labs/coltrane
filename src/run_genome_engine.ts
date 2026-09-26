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

/** What a registry would make the seal enforce, per type — the comparison the round trip must pass. */
function sealView(registry: Registry): string {
  return canonJson(
    registry
      .listTypes()
      .map((t) => ({ slug: t.slug, extends: t.extends, domain: t.domain, effective: registry.effectiveSchema(t.slug) ?? null }))
      .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0)),
  );
}

/**
 * Materialize `registry`'s types as a genome root the engine child can boot from, and PROVE it: the
 * root is reloaded through the same loader the child runs, and its registry must answer every type
 * exactly as `registry` does. A type the loader would drop (a defect, a shape failure) makes the two
 * gates disagree silently — so a mismatch is a refusal naming the difference, never a best effort.
 *
 * Content-addressed under the OS temp dir, so a drain that claims many gigs over one org's types
 * reuses one root instead of accumulating one per claim; a root found on disk is re-proved before use.
 */
export function materializeRunGenome(registry: Registry): string {
  const want = sealView(registry);
  const root = join(tmpdir(), `coltrane-run-genome-${sha256Hex(want).slice(0, 24)}`);
  const proves = (dir: string): boolean => {
    try {
      return sealView(loadRegistry(loadGenome(dir))) === want;
    } catch {
      return false;
    }
  };
  if (existsSync(root) && proves(root)) return root;

  const staging = mkdtempSync(join(tmpdir(), "coltrane-run-genome-staging-"));
  const typesDir = join(staging, "domain_types");
  mkdirSync(typesDir);
  for (const t of registry.listTypes()) {
    writeFileSync(
      join(typesDir, `${t.slug}.json`),
      JSON.stringify({
        slug: t.slug,
        version: t.version ?? 1,
        extends: t.extends,
        domain: t.domain,
        status: "active",
        schema: t.schema,
        required_fields: [...t.required_fields],
      }),
    );
  }
  if (!proves(staging)) {
    const got = (() => {
      try {
        return new Set(loadRegistry(loadGenome(staging)).listTypes().map((t) => t.slug));
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    })();
    rmSync(staging, { recursive: true, force: true });
    const lost = typeof got === "string" ? got : registry.listTypes().map((t) => t.slug).filter((s) => !got.has(s)).join(", ") || "(same slugs, different schemas)";
    throw new Error(
      `cannot seat a Claude chair on the drain: the run's types do not reload as the same registry in the ` +
        `engine child (${lost}) — its in-turn output_write gate would judge by a different genome than the seal`,
    );
  }
  try {
    rmSync(root, { recursive: true, force: true });
    renameSync(staging, root);
  } catch {
    // A concurrent drain won the rename; its root is content-addressed to the same types. Use it if it
    // proves, else keep our own staging copy (proved above) rather than the unproved one.
    if (existsSync(root) && proves(root)) {
      rmSync(staging, { recursive: true, force: true });
      return root;
    }
    return staging;
  }
  return root;
}

/**
 * The engine MCP server config for a seat that seals against `registry`: the compiled entry, run
 * directly (no hot-reload relay — a seat's child lives one turn), with COLTRANE_GENOME pointed at the
 * run registry's materialized root. Undefined when there is no build (see engineServerEntry).
 */
export function engineServerForRegistry(registry: Registry): Record<string, unknown> | undefined {
  const entry = engineServerEntry();
  if (!entry) return undefined;
  return {
    command: process.execPath,
    args: [entry],
    env: { COLTRANE_GENOME: materializeRunGenome(registry), COLTRANE_SERVER_DIRECT: "1" },
  };
}
