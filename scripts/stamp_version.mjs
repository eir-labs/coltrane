#!/usr/bin/env node
// Write one version into BOTH places that state it, atomically enough that they cannot disagree.
//
// THE TWO COPIES ARE DELIBERATE, and this is why they stay safe. `COLTRANE_VERSION` is compiled into
// dist and is what a VENDORED consumer reads at boot — coltrane is cloned as a git checkout as often
// as it is installed, and there a package.json range says what npm was asked for, not what loaded.
// So the constant cannot simply be read from package.json at runtime without giving up the case it
// exists to serve. Two statements of one fact, then — kept in lockstep by a machine instead of by a
// person, with tests/version_identity.test.ts as the check that this script did both.
//
// Usage: node scripts/stamp_version.mjs 0.12.0

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2];

const die = (msg) => {
  process.stderr.write(`stamp_version: ${msg}\n`);
  process.exit(1);
};

if (!version) die("no version given");
// Refuse rather than default: this writes the number a consumer's boot handshake asserts against.
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) die(`"${version}" is not a semver version`);

// 1. package.json — replace only the top-level "version" key, by a narrow anchored match, so a
//    dependency that happens to carry the same string is never rewritten.
const pkgPath = join(ROOT, "package.json");
const pkgRaw = readFileSync(pkgPath, "utf8");
const pkgNext = pkgRaw.replace(/^(\s*"version"\s*:\s*")[^"]+(")/m, `$1${version}$2`);
if (pkgNext === pkgRaw) die("package.json version key not found — refusing to publish an unstamped tree");
writeFileSync(pkgPath, pkgNext);

// 2. src/version.ts — the constant compiled into dist.
const verPath = join(ROOT, "src", "version.ts");
const verRaw = readFileSync(verPath, "utf8");
const verNext = verRaw.replace(/(export const COLTRANE_VERSION = ")[^"]+(")/, `$1${version}$2`);
if (verNext === verRaw) die("COLTRANE_VERSION not found in src/version.ts — refusing to publish a lying handshake");
writeFileSync(verPath, verNext);

process.stdout.write(`stamped ${version}\n`);
