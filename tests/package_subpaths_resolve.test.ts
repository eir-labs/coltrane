// EVERY SUBPATH THIS PACKAGE ADVERTISES CAN ACTUALLY BE IMPORTED.
//
// THE GAP THIS CLOSES. `exports` is the package's promise to a consumer, and nothing checked it.
// tests/pack_content_audit.test.ts audits the shipped FILES (scoped name, bin entry, no internal
// vocabulary) and never looks at the exports map, so an entry naming a path the package does not
// ship would fail for exactly one audience: someone outside this repo. Inside it, every relative
// import keeps working and the suite stays green.
//
// That asymmetry is the point. `resolveSeatBacking` was reachable within src/ and unimportable from
// outside for its whole life, and the orphan ratchet passed the entire time — correctly, because
// reachable-within and importable-from-outside are different properties and only the first had a
// law. This is the second one.
//
// It was written when two modules a downstream needed turned out to be unreachable:
// @eir-labs/coltrane/worker_env and /genome_schema both threw ERR_PACKAGE_PATH_NOT_EXPORTED, so
// WORKER_ENV_CONTRACT and VenueSchema — both already law-enforced, both already machine-readable,
// the two best sources in the estate for a generated operations reference — could not be read by
// the app that documents this engine.
//
// HOW IT AVOIDS BEING VACUOUS. It resolves each subpath the way NODE does, against the exports
// map, rather than checking a file exists on disk: a path can exist and still be unexported, which
// is the exact failure. And it asserts the map is non-empty and contains the subpaths this repo is
// known to publish, so a map emptied by accident cannot pass by having nothing to check.
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const ROOT = join(__dirname, "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  name: string;
  files: string[];
  exports: Record<string, string | Record<string, string>>;
};

/** The file(s) a subpath entry names, whether it is a bare string or a conditions object. */
function targetsOf(key: string): string[] {
  const entry = pkg.exports[key];
  if (typeof entry === "string") return [entry];
  return entry ? Object.values(entry) : [];
}

/** Every subpath the package advertises, minus the bare "./package.json" convenience. */
function subpaths(): string[] {
  return Object.keys(pkg.exports).filter((k) => k !== "./package.json");
}

describe("every subpath this package advertises can be imported", () => {
  it("the exports map is non-empty and still carries the known subpaths", () => {
    // Guards the derivation: an emptied map would otherwise satisfy every law below.
    expect(subpaths().length).toBeGreaterThanOrEqual(4);
    for (const known of ["./tool_surface", "./genome_store", "./worker_env", "./genome_schema"]) {
      expect(subpaths(), `${known} is advertised to downstreams`).toContain(known);
    }
  });

  it("law 1 — every advertised subpath RESOLVES from outside the package, as Node resolves it", () => {
    // Not existsSync on the target. A file can exist and still be unexported — that IS the failure
    // (@eir-labs/coltrane/worker_env threw ERR_PACKAGE_PATH_NOT_EXPORTED while worker_env.js sat in
    // dist the whole time), so a law that checks the path exists would have passed straight through
    // it. This stands where a consumer stands: a directory outside the package, with the package
    // linked under node_modules, resolving BY NAME through the exports map.
    const consumer = mkdtempSync(join(tmpdir(), "coltrane-consumer-"));
    try {
      mkdirSync(join(consumer, "node_modules", "@eir-labs"), { recursive: true });
      symlinkSync(ROOT, join(consumer, "node_modules", "@eir-labs", "coltrane"), "dir");
      writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "consumer", type: "module" }));
      const anchor = join(consumer, "index.js");
      writeFileSync(anchor, "");
      const req = createRequire(anchor);

      const unreachable: string[] = [];
      for (const key of subpaths()) {
        const specifier = key === "." ? pkg.name : `${pkg.name}/${key.replace(/^\.\//, "")}`;
        try {
          req.resolve(specifier);
        } catch (e) {
          unreachable.push(`${specifier} -> ${(e as { code?: string }).code ?? (e as Error).message}`);
        }
      }
      expect(
        unreachable,
        `a downstream cannot import these, whatever dist holds:\n${unreachable.join("\n")}`,
      ).toEqual([]);
    } finally {
      rmSync(consumer, { recursive: true, force: true });
    }
  });

  it("law 1b — and the files those entries name are actually built", () => {
    const missing: string[] = [];
    for (const key of subpaths()) {
      for (const t of targetsOf(key)) {
        if (!existsSync(join(ROOT, t))) missing.push(`${key} -> ${t}`);
      }
    }
    expect(
      missing,
      `these subpaths name files the build does not produce (run npm run build first):\n${missing.join("\n")}`,
    ).toEqual([]);
  });

  it("law 2 — every advertised subpath is inside a shipped `files` root", () => {
    // An entry can resolve here and still be absent from the published tarball, which fails only
    // for a consumer — the exact asymmetry this file exists for.
    const outside: string[] = [];
    for (const key of subpaths()) {
      for (const t of targetsOf(key)) {
        const rel = t.replace(/^\.\//, "");
        if (!pkg.files.some((root) => rel === root || rel.startsWith(root.replace(/\/$/, "") + "/"))) {
          outside.push(`${key} -> ${t}`);
        }
      }
    }
    expect(
      outside,
      `these subpaths resolve locally but are not in package.json "files", so they ship broken:\n${outside.join("\n")}`,
    ).toEqual([]);
  });

  it("law 3 — the two the knowledge base needs export the symbols it needs", () => {
    // Reachability, not existence. A rename inside either module leaves the subpath resolving and
    // the downstream generator silently empty — which is this repo's named defect, a legitimate
    // -looking value where an absence should have refused.
    const require_ = createRequire(join(ROOT, "package.json"));

    const workerEnv = require_(join(ROOT, "dist/src/worker_env.js")) as Record<string, unknown>;
    expect(
      workerEnv.WORKER_ENV_CONTRACT,
      "WORKER_ENV_CONTRACT is the one enumerated table of the worker's environment",
    ).toBeDefined();

    const schema = require_(join(ROOT, "dist/src/genome_schema.js")) as Record<string, unknown>;
    for (const sym of ["VenueSchema", "AgentSchema", "StandardSchema"]) {
      expect(schema[sym], `${sym} is the single Zod source every restatement derives from`).toBeDefined();
    }
  });
});
