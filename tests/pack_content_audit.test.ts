// Gate: content-axis audit — asserts WHAT'S INSIDE the shipped files (issue #150).
//
// Complements the manifest gate (#149, which files ship) by reading the bytes of
// every would-ship text file and asserting none carries internal-only vocabulary.
// The forbidden terms are base64-encoded in the source below so THIS test file
// itself carries no plaintext vocab — it is ship-safe even if it were packed
// (it is not: the files glob excludes tests/).
//
// RED-first: compiled build outputs under dist/ may still carry vocab from before
// the scrub, and the package name is bare `coltrane` — both surface here until the
// packaging + dist-scrub pass lands.

import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

interface PackEntry {
  path: string;
}
interface PackResult {
  files: PackEntry[];
}

// Forbidden vocab, base64-encoded so no plaintext internal term lives in the repo.
// Decoded at runtime into a word-boundary regex. (See issue #150 — encode-in-source
// is the discipline that keeps the gate itself ship-safe.)
const FORBIDDEN_VOCAB_B64 = [
  "YXBvaGE=", // 1
  "a2FybWE=", // 2
  "cmlwZW5lZA==", // 3
  "a2lsbC1maXJlZA==", // 4
  "c2V0dGxlbWVudA==", // 5
  "dm9pY2Vfc3RhdGU=", // 6
  "ZnVuaG91c2U=", // 7
  "ZWlybWF0aA==", // 8
  "c3ViaHV0aQ==", // 9
];

function decodeVocab(): string[] {
  return FORBIDDEN_VOCAB_B64.map((b) => Buffer.from(b, "base64").toString("utf-8"));
}

// Filename patterns that must never appear in the shipped set.
const FORBIDDEN_FILENAME: RegExp[] = [
  /\.test\.(ts|js)$/,
  /^tests\//,
  /^dist\/tests\//,
  /^src\/.*\.ts$/,
];

// Only scan text-ish files for content; skip binaries + maps.
const TEXT_EXT = /\.(js|ts|json|md|txt)$/;
const SKIP_CONTENT = /\.(map)$/;

let shipped: string[] = [];

// #231 — same 10s default-hookTimeout death as pack_contents_audit.test.ts, same cause and
// same budget; see that file's header for the measurements (3.1–5.6s here, 12.76s on the
// machine that filed the issue) and for why a generous budget costs a real break nothing.
//
// These two files are near-duplicates and each pays its own `npm pack` → `prepare` → `tsc`.
// They are deliberately NOT merged: they are two different gates (#149 asks which FILES ship,
// #150 asks what is INSIDE them) with different failure meanings, and they are among the very
// few things in this repo that type-check the test tree by building it. Both stay in the
// default run. The duplicated build is ~2 x 4s and is the price of that.
const PACK_HOOK_TIMEOUT_MS = 120_000;

beforeAll(() => {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
  });
  const parsed = JSON.parse(out) as PackResult[];
  const first = parsed[0];
  if (!first) throw new Error("npm pack --dry-run returned an empty manifest");
  shipped = first.files.map((f) => f.path.replace(/^\.\//, ""));
}, PACK_HOOK_TIMEOUT_MS);

describe("content-axis — shipped filenames", () => {
  it.each(FORBIDDEN_FILENAME.map((re) => [re.source, re] as const))(
    "no shipped path matches forbidden pattern %s",
    (_src, re) => {
      const hits = shipped.filter((p) => re.test(p));
      expect(hits, `forbidden filenames shipped: ${hits.join(", ")}`).toEqual([]);
    },
  );
});

describe("content-axis — shipped file contents", () => {
  it("no shipped text file contains internal-only vocabulary", () => {
    const terms = decodeVocab();
    const pattern = new RegExp(`\\b(${terms.join("|")})\\b`, "i");
    const offenders: string[] = [];

    for (const rel of shipped) {
      if (!TEXT_EXT.test(rel) || SKIP_CONTENT.test(rel)) continue;
      let text: string;
      try {
        text = readFileSync(join(REPO_ROOT, rel), "utf-8");
      } catch {
        continue; // dry-run lists files that exist; defensive only
      }
      const m = text.match(pattern);
      if (m) offenders.push(`${rel} :: «${m[1]}»`);
    }

    expect(offenders, `vocab leak in shipped files:\n${offenders.join("\n")}`).toEqual([]);
  });
});

describe("content-axis — package identity", () => {
  function readPkg(): Record<string, unknown> {
    return JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf-8"));
  }

  it("name is scoped under @eir-labs", () => {
    expect(String(readPkg().name)).toMatch(/^@eir-labs\//);
  });

  it("declares a bin entry", () => {
    const bin = readPkg().bin;
    const count = typeof bin === "string" ? 1 : Object.keys((bin as object) ?? {}).length;
    expect(count).toBeGreaterThan(0);
  });
});
