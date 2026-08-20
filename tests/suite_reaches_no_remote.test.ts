// THE STANDING GUARD — the root unit suite reaches no remote.
//
// This is NOT a RED-first law. It is green from the outset and must STAY green through every edit in
// this change (and after it). Its job is structural: the dereference snapshot law in
// a_fetch_claim_carries_its_evidence.test.ts is offline by DESIGN — it reads a committed fixture, it
// does not fetch — and the only place a network call is permitted to appear is the operator refresh
// script under scripts/, which the root vitest config never includes. This guard makes that promise
// enforceable rather than aspirational: if any file the root config runs starts reaching the network,
// the suite goes red here, loudly, naming the file and the primitive.
//
// It scans CODE, not prose. A network primitive named in a comment ("a skill could exfiltrate it with
// a single fetch") or embedded in a string literal (skill body handed to a sandbox as data, an enum
// value "fetch") is not the suite reaching a remote. So the scanner strips block comments, line
// comments, and string/template literals FIRST, then looks for actual call sites. Scanning the raw
// text would flag honest prose and produce green-for-the-wrong-reason churn — the exact failure mode
// this codebase keeps pinning.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const TESTS_DIR = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

// The exact set the ROOT vitest config runs: include tests/**/*.test.ts, minus its declared
// excludes. Kept in lockstep with vitest.config.ts — a band delegated to its own config (e2e,
// security, honest_broker, the live venue-room spec) has its own network posture and is not this
// guard's to police.
const EXCLUDED_DIRS = ["e2e", "security", "honest_broker"];
const EXCLUDED_FILES = ["spec_venue_room_live.test.ts"];

function rootConfigTestFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (EXCLUDED_DIRS.includes(ent.name)) continue;
        walk(full);
        continue;
      }
      if (!ent.name.endsWith(".test.ts")) continue;
      if (EXCLUDED_FILES.includes(ent.name)) continue;
      out.push(full);
    }
  };
  walk(TESTS_DIR);
  return out;
}

// Remove block comments, line comments, then string + template literals. What survives is code.
function stripCommentsAndStrings(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ") // block comments
    .replace(/\/\/[^\n]*/g, " ") // line comments
    .replace(/`(?:\\.|[^`\\])*`/g, '""') // template literals
    .replace(/'(?:\\.|[^'\\])*'/g, '""') // single-quoted strings
    .replace(/"(?:\\.|[^"\\])*"/g, '""'); // double-quoted strings
}

// Actual network CALL SITES — not the mere appearance of a word. Imports are scanned separately.
const NETWORK_PRIMITIVES: { name: string; re: RegExp }[] = [
  { name: "fetch(", re: /\bfetch\s*\(/ },
  { name: "http(s).get/request(", re: /\bhttps?\s*\.\s*(get|request)\s*\(/ },
  { name: "net.connect/createConnection(", re: /\bnet\s*\.\s*(connect|createConnection)\s*\(/ },
  { name: "new WebSocket(", re: /\bnew\s+WebSocket\s*\(/ },
];

// Imports need the pre-strip text (the module specifier is a string literal we strip out for the
// call-site scan), so scan for network module imports separately against the raw source.
const NETWORK_IMPORT_RE =
  /(?:import[^;]*from|require\s*\(|import\s*\()\s*['"](?:node:)?(?:http|https|net|tls|dgram|undici|axios|node-fetch|got|superagent)['"]/;

describe("the root unit suite reaches no remote (standing guard)", () => {
  const files = rootConfigTestFiles();

  it("finds the test corpus (the guard is not vacuously green)", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("no root-config test file makes a network call in its own code", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const raw = readFileSync(file, "utf8");
      const code = stripCommentsAndStrings(raw);
      const rel = relative(REPO_ROOT, file);
      for (const p of NETWORK_PRIMITIVES) {
        if (p.re.test(code)) offenders.push(`${rel} → ${p.name}`);
      }
    }
    expect(offenders, `network call sites in the unit suite:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("no root-config test file imports a network module", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const raw = readFileSync(file, "utf8");
      // Strip comments only — the module specifier is itself a string literal we must keep.
      const noComments = raw.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
      if (NETWORK_IMPORT_RE.test(noComments)) {
        offenders.push(relative(REPO_ROOT, file));
      }
    }
    expect(offenders, `network module imports in the unit suite:\n${offenders.join("\n")}`).toEqual([]);
  });
});
