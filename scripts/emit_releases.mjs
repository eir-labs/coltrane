#!/usr/bin/env node
// Emit releases.json — the history the package SHIPS, written at publish time.
//
// Why it runs here and not at build time: `.github/workflows/publish.yml` stamps the version, runs
// `npm run verify`, publishes, and pushes the tag LAST. So at the moment the tarball is built, the
// release being shipped has no tag, and `compileReleases` walks tags. `--pending <version>` compiles
// that release too — commits since the last tag, HEAD's date, law counts and surface against it —
// marked `pending: true`, so the package carries its OWN release rather than a history ending one
// release behind itself.
//
// All of the logic is in src/releases.ts under contract-release-record-v1,
// contract-release-surface-real-shapes-v1 and contract-release-history-and-render-v1. This file is a
// wrapper: read the arguments, call the function, write the bytes. Anything it decided on its own
// would be a decision no law covers.
//
//   node scripts/emit_releases.mjs                      # tagged releases only
//   node scripts/emit_releases.mjs --pending 0.24.34    # plus the one about to ship
//   node scripts/emit_releases.mjs --out some/path.json # default: ./releases.json
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { releasesJson } from "../dist/src/releases.js";

// Every line this script prints goes to STDERR. `npm pack --dry-run --json` runs `prepare`, which runs
// the build, which runs this — and anything on stdout lands inside the JSON the pack audits parse.

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const treeRoot = resolve(flag("tree-root") ?? process.cwd());
const out = resolve(flag("out") ?? "releases.json");
const version = flag("pending");

// A `--pending` with no value is a misconfigured workflow, not a request for the tagged-only history:
// it would publish a package whose history silently omits the release it carries. Refuse by name.
if (argv.includes("--pending") && (version === undefined || version.startsWith("--"))) {
  console.error("emit_releases: --pending was given with no version");
  process.exit(2);
}

// `--allow-unavailable` is for the BUILD path. Most CI jobs check out at depth 1 with no tags, so
// compileReleases rightly refuses there — and the package advertises ./releases.json, so the file must
// exist for that subpath to resolve. Under the flag a refusal writes a document that SAYS it could not
// be compiled, carrying the reason: "could not read the history" stays distinguishable from "this
// project has no releases", which is the same rule the surface readers follow. The publish path passes
// no flag, so there a refusal is fatal and nothing ships with an empty history.
const allowUnavailable = argv.includes("--allow-unavailable");

// contract-release-compile-cache-v1 — the document we are about to overwrite is this run's cache. A
// tag is immutable, so a record whose tag still resolves to the commit it names cannot have changed;
// compileReleases re-checks that itself and recompiles anything that fails the check, so a stale,
// hand-edited or truncated file can only ever cost time, never correctness. An unreadable file is
// simply no cache: this is a speed-up, and it must never be the reason a release history fails to
// emit. Measured before it existed: a full 80-tag compile was 3m52s, and vitest's globalSetup ran it
// before EVERY test file.
function readCache(path) {
  if (!existsSync(path)) return undefined;
  try {
    const doc = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(doc?.releases) ? doc.releases : undefined;
  } catch {
    return undefined;
  }
}

let json;
try {
  const cache = readCache(out);
  json = releasesJson({
    tree_root: treeRoot,
    ...(version ? { pending: { version } } : {}),
    ...(cache ? { cache } : {}),
  });
} catch (e) {
  const reason = e instanceof Error ? e.message : String(e);
  if (!allowUnavailable) {
    // compileReleases refuses by name (a tree with no repository, no v* tag, or a pending version a
    // tag already holds). Print that reason; a stack trace in a publish log says less.
    console.error(`emit_releases: ${reason}`);
    process.exit(2);
  }
  writeFileSync(out, `${JSON.stringify({ generated_from: "compileReleases", releases: [], unavailable: reason }, null, 2)}\n`);
  console.error(`emit_releases: history unavailable → ${out} (${reason})`);
  process.exit(0);
}
writeFileSync(out, json);

const { releases } = JSON.parse(json);
const newest = releases[0];
console.error(
  `emit_releases: ${releases.length} release(s) → ${out}` +
    (newest ? ` (newest ${newest.tag}${newest.pending ? ", pending" : ""})` : ""),
);
