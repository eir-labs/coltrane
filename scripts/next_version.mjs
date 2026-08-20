#!/usr/bin/env node
// Compute the next release version from the commits since the last tag.
//
// WHY THIS EXISTS. publish.yml has always published correctly — on every push to main, iff
// package.json's version is not already on npm. What rotted was the INPUT: the version was a number
// a human had to remember to bump. On 2026-08-20 ten merges landed on main after 0.11.0 shipped,
// including the fix that unblocked the Fly drain, and every one of them ran the workflow, found
// 0.11.0 already published, and correctly no-op'd. Nothing failed. Nothing shipped either.
//
// The semver intent was never missing from this repo — every commit is conventional. It was just
// never read. So the version stops being remembered and starts being derived.
//
// Usage (what .github/workflows/publish.yml runs):
//   git log --format=%B "$LAST..HEAD" | node scripts/next_version.mjs --last "$LAST"
//
// Prints the next version to stdout and exits 0. Exits non-zero, printing NOTHING to stdout, when
// there is no release to make or the input cannot be trusted — a caller must be able to tell those
// apart from a version, and a default here would republish or overwrite. Absent means DECLINE.

const args = process.argv.slice(2);
const lastArg = args.indexOf("--last");
const last = lastArg >= 0 ? args[lastArg + 1] : undefined;

const die = (msg) => {
  process.stderr.write(`next_version: ${msg}\n`);
  process.exit(1);
};

if (!last) die("no --last <tag> given");

// The tag convention is ours and could change; the parse should not be what breaks a release.
const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(last).trim());
if (!m) die(`--last "${last}" is not a semver tag — refusing to invent a base version`);

const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];

const body = await new Promise((resolve) => {
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => (buf += c));
  process.stdin.on("end", () => resolve(buf));
});

const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);
if (lines.length === 0) die("no commits since the last tag — nothing to release");

// Conventional commits, highest bump wins. A `!` after the type/scope and a `BREAKING CHANGE:`
// trailer are the two spellings of the same intent; both are read, so neither notation silently
// ships as a patch.
const BREAKING = /^[a-zA-Z]+(\([^)]*\))?!:/;
const BREAKING_TRAILER = /^BREAKING[ -]CHANGE:/;
const FEAT = /^feat(\([^)]*\))?:/;

let bump = "patch"; // every merge to main is a release — housekeeping ships too
for (const line of lines) {
  if (BREAKING.test(line) || BREAKING_TRAILER.test(line)) { bump = "major"; break; }
  if (FEAT.test(line)) bump = "minor";
}

const next =
  bump === "major" ? `${major + 1}.0.0` : bump === "minor" ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;

process.stdout.write(`${next}\n`);
