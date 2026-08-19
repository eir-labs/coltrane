#!/usr/bin/env node
/** THE GATE, WIRED TO WHAT IS ACTUALLY PUBLISHED.
 *
 *  `boundary_scan.ts` is pure and knows nothing about this repository. This is the half that decides
 *  WHAT is in scope and WHAT an outcome costs, and it makes exactly two decisions:
 *
 *  SCOPE IS WHAT GIT TRACKS. Not the working tree — an untracked scratch file is not published, and
 *  failing on it trains an operator to ignore the gate. Not the diff either: a term introduced on an
 *  earlier commit is still public today, so the whole tracked surface is scanned every run and the
 *  gate cannot be walked past by landing the leak in two steps.
 *
 *  AN UNAVAILABLE LIST IS FATAL WHERE PUBLISHING HAPPENS. On a contributor's laptop the list is
 *  legitimately absent, and a hard failure there teaches people to skip the suite. In CI the list is
 *  provisioned from a secret, so its absence means the gate is BROKEN, and a broken gate must never
 *  read as a pass. `CI` (set by GitHub Actions) selects between the two, and `--require-list` forces
 *  the strict reading anywhere.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { scanBoundary, formatOutcome } from "./boundary_scan.js";

/** Paths git tracks, minus what cannot carry prose. Binary content would only produce noise. */
function trackedText(): Array<readonly [string, string]> {
  const out = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const skip = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|woff2?|ttf|mp4|wasm)$/i;
  const files: Array<readonly [string, string]> = [];
  for (const p of out.split("\0")) {
    if (!p || skip.test(p)) continue;
    try {
      files.push([p, readFileSync(p, "utf8")] as const);
    } catch {
      /* unreadable or genuinely binary — not publishable prose, so not this gate's business */
    }
  }
  return files;
}

export function main(argv: readonly string[], env: NodeJS.ProcessEnv): number {
  const strict = argv.includes("--require-list") || env["CI"] === "true";
  const outcome = scanBoundary(trackedText(), env);

  if (outcome.status === "violation") {
    // The matched terms print for the operator who already holds the list. A public CI log would
    // republish them, so under CI the locations print and the terms do not.
    if (env["CI"] === "true") {
      console.error(`boundary VIOLATION — ${outcome.hits.length} hit(s):`);
      for (const h of outcome.hits) console.error(`  ${h.path}:${h.line}`);
    } else {
      console.error(formatOutcome(outcome));
    }
    return 1;
  }

  if (outcome.status === "unavailable") {
    if (strict) {
      console.error(`boundary GATE BROKEN — ${outcome.reason}`);
      return 2;
    }
    console.warn(`boundary skipped — ${outcome.reason}`);
    return 0;
  }

  console.log(formatOutcome(outcome));
  return 0;
}

/* c8 ignore start — entry wiring */
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "")) {
  process.exit(main(process.argv.slice(2), process.env));
}
/* c8 ignore stop */
