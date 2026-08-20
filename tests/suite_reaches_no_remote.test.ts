// THE SUITE REACHES NO REMOTE — two halves of one promise.
//
// This file carries TWO independent guards that arrived by different routes and were merged rather
// than one being dropped. They fail for different reasons and neither implies the other:
//
//   1. THE ENVIRONMENT IS SEVERED (from #429). `src/output_mirror.ts` arms a remote append by reading
//      AMBIENT env — remoteConfigured(): COLTRANE_DRAIN_KEY || COLTRANE_DRAIN_PG. A developer box
//      configured to drain, the same box `npm run verify` runs on before a deploy, therefore POSTed
//      every persisted output to that box's real service under that box's real credential, from a
//      GREEN test run. Measured before the guard landed: one full suite sent 428 requests to the
//      configured origin (423 gig rows, 4 output records, 1 artifact upload) and every test passed,
//      because a fire-and-forget drain that SUCCEEDS logs nothing. This half asserts the observable
//      fact — no drain credential and no drain origin is visible to a test.
//
//   2. NO TEST FILE CALLS OUT (from #446). The environment being severed says nothing about a test
//      that hard-codes a URL and fetches it. This half scans the CODE of every file the root config
//      runs. It is green from the outset and must stay green: the dereference snapshot law in
//      a_fetch_claim_carries_its_evidence.test.ts is offline BY DESIGN — it reads a committed fixture
//      — and the only sanctioned network call lives in scripts/refresh_citation_snapshot.ts, which
//      the root vitest config never includes.
//
//      It scans code, not prose. A network primitive named in a comment ("a skill could exfiltrate it
//      with a single fetch") or sitting in a string literal (a skill body handed to a sandbox as data,
//      an enum value "fetch") is not the suite reaching a remote. The scanner strips block comments,
//      line comments, and string/template literals FIRST, then looks for real call sites. Scanning raw
//      text would flag honest prose and produce green-for-the-wrong-reason churn — the exact failure
//      this codebase keeps pinning.
//
// Half 1 catches a configured box; half 2 catches a written test. Keep both.

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

describe("the test suite reaches no remote store", () => {
  it("no drain credential is visible to a test — a green run cannot write to an org store", () => {
    // The exact disjunction remoteConfigured() evaluates. Either being set is sufficient to arm the
    // remote append, so both must be absent for the suite to be hermetic.
    expect(process.env["COLTRANE_DRAIN_KEY"], "COLTRANE_DRAIN_KEY leaked into the suite").toBeUndefined();
    expect(process.env["COLTRANE_DRAIN_PG"], "COLTRANE_DRAIN_PG leaked into the suite").toBeUndefined();
  });

  it("no drain ORIGIN is visible either — the address is severed as well as the credential", () => {
    // Belt and braces, and it carries its own reason: a key with no origin already fails loudly
    // (worker_env refuses the pair), but an ORIGIN left set is what turns a future ambient key into
    // a live POST. Severing both means a single leaked variable is never sufficient.
    expect(process.env["COLTRANE_DRAIN_URL"], "COLTRANE_DRAIN_URL leaked into the suite").toBeUndefined();
  });
});

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
