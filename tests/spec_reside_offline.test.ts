// The reside suite reaches no remote (I21) — a STANDING GUARD, green by design.
//
// This is the ONE residency invariant that is not RED: I21 is a property of the DELIVERABLE (the
// RED suite performs zero network I/O), not of the absent enforcement, so a red assertion would be
// nonsensical. It is written exactly like tests/suite_reaches_no_remote.test.ts — "green from the
// outset and must STAY green" — and scoped to the reside files. It does NOT import ../src/residency.js
// (which is absent), so it runs and stays green while every other reside file is red on that import.
//
// It scans CODE, not prose: the residency transition tests are pure functions and fast-check
// properties with an INJECTED clock and a DI'd store recorder — no fetch, no wall clock, no store
// RPC. If any reside file starts reaching the network, this goes red here, naming the file.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const TESTS_DIR = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function resideSpecFiles(): string[] {
  return readdirSync(TESTS_DIR)
    .filter((n) => n.startsWith("spec_reside_") && n.endsWith(".test.ts") && n !== "spec_reside_offline.test.ts")
    .map((n) => join(TESTS_DIR, n));
}

function stripCommentsAndStrings(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/`(?:\\.|[^`\\])*`/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, '""')
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
}

const NETWORK_PRIMITIVES: { name: string; re: RegExp }[] = [
  { name: "fetch(", re: /\bfetch\s*\(/ },
  { name: "http(s).get/request(", re: /\bhttps?\s*\.\s*(get|request)\s*\(/ },
  { name: "net.connect/createConnection(", re: /\bnet\s*\.\s*(connect|createConnection)\s*\(/ },
  { name: "new WebSocket(", re: /\bnew\s+WebSocket\s*\(/ },
];

describe("the RED residency suite reaches no remote (I21, standing guard)", () => {
  const files = resideSpecFiles();

  it("finds the reside corpus (the guard is not vacuously green)", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("I21 no reside spec file makes a network call in its own code", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const code = stripCommentsAndStrings(readFileSync(file, "utf8"));
      const rel = relative(REPO_ROOT, file);
      for (const p of NETWORK_PRIMITIVES) if (p.re.test(code)) offenders.push(`${rel} → ${p.name}`);
    }
    expect(offenders, `network call sites in the reside suite:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("I21 no reside spec file depends on a real wall clock (Date.now / new Date)", () => {
    // The reflex budget is asserted over an INJECTED clock (deterministic simulation), so a real
    // clock in these files would be exactly the machine-dependent flake defect (5) forbids.
    const offenders: string[] = [];
    for (const file of files) {
      const code = stripCommentsAndStrings(readFileSync(file, "utf8"));
      if (/\bDate\s*\.\s*now\s*\(/.test(code) || /\bnew\s+Date\s*\(/.test(code)) {
        offenders.push(relative(REPO_ROOT, file));
      }
    }
    expect(offenders, `wall-clock reads in the reside suite:\n${offenders.join("\n")}`).toEqual([]);
  });
});
