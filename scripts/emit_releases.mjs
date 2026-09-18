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
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { releasesJson } from "../dist/src/releases.js";

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

let json;
try {
  json = releasesJson({ tree_root: treeRoot, ...(version ? { pending: { version } } : {}) });
} catch (e) {
  // compileReleases refuses by name (a tree with no repository, no v* tag, or a pending version a tag
  // already holds). Print that reason; a stack trace in a publish log says less.
  console.error(`emit_releases: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
}
writeFileSync(out, json);

const { releases } = JSON.parse(json);
const newest = releases[0];
console.log(
  `emit_releases: ${releases.length} release(s) → ${out}` +
    (newest ? ` (newest ${newest.tag}${newest.pending ? ", pending" : ""})` : ""),
);
