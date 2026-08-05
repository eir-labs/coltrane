// RED — issue #219: tests/failure_modes/ is run by no npm script, and the ledger
// concurrency spec is vacuously broken.
//
// Together these mean the ledger's durability and concurrency guards do not exist in
// practice: the specs are green-by-absence in every CI and local run, and the one spec that
// touches concurrent ledger appends dies before it ever races.
//
// This file lives in the UNIT band on purpose — a guard that is itself unrun would be the
// same disease it is diagnosing.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineAgent } from "../src/composition.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FM_CONFIG = "tests/failure_modes/vitest.config.ts";

function packageScripts(): Record<string, string> {
  return JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf-8")).scripts as Record<string, string>;
}

describe("#219 — the failure-mode band is actually run", () => {
  it("the failure_modes config exists (sanity)", () => {
    expect(existsSync(join(REPO_ROOT, FM_CONFIG))).toBe(true);
  });

  it("some npm script runs the failure_modes config", () => {
    const scripts = packageScripts();
    const runners = Object.entries(scripts).filter(([, cmd]) => cmd.includes(FM_CONFIG));
    expect(
      runners.map(([name]) => name),
      "no npm script references " + FM_CONFIG + ". tests/failure_modes/vitest.config.ts:3 " +
        "documents a manual `npx vitest run --config …` invocation; package.json's test, " +
        "verify and e2e scripts never reference it. These specs — disk_full, midflight_kill, " +
        "recorder_unbounded, concurrent_genome_writes — are green-by-absence in every CI and " +
        `local run. Scripts present: [${Object.keys(scripts).join(", ")}]`,
    ).not.toEqual([]);
  });

  it("`verify` reaches the failure-mode band", () => {
    const scripts = packageScripts();
    const verify = scripts["verify"] ?? "";
    const named = Object.entries(scripts)
      .filter(([, cmd]) => cmd.includes(FM_CONFIG))
      .map(([name]) => name);
    const reached = verify.includes(FM_CONFIG) || named.some((n) => verify.includes(n));
    expect(
      reached,
      `\`verify\` is "${verify}" — a typecheck plus the fast unit band only. The durability ` +
        "and concurrency guards for the audit spine are never executed by the gate that " +
        "developers actually run.",
    ).toBe(true);
  });
});

describe("#219 — the concurrency spec actually races", () => {
  const SPEC = join(REPO_ROOT, "tests/failure_modes/concurrent_genome_writes.spec.ts");

  /** Which agent fields the spec's WORKER_SOURCE actually passes to sealAgentDefinition.
   *  Read from the file so the assertion tracks the spec rather than a copy of it. */
  function declaredWorkerFields(): string[] {
    const src = readFileSync(SPEC, "utf-8");
    const at = src.indexOf("sealAgentDefinition(");
    expect(at, "sealAgentDefinition( not found in the concurrency spec").toBeGreaterThan(-1);
    const open = src.indexOf("{", at);
    const close = src.indexOf("}", open);
    expect(close, "could not locate the agent-def literal in WORKER_SOURCE").toBeGreaterThan(open);
    const block = src.slice(open, close + 1);
    const CANDIDATES = [
      "slug", "primitives", "domain", "identity", "method",
      "constraints", "behavioral_primitives", "input_types", "output_types",
    ];
    return CANDIDATES.filter((f) => new RegExp(`\\b${f}\\s*[,:]`).test(block));
  }

  it("its worker builds an agent the composition layer accepts", () => {
    const declared = declaredWorkerFields();
    // Rebuild the worker's def using ONLY the fields it actually declares.
    const values: Record<string, unknown> = {
      slug: "racer",
      primitives: ["SENSE"],
      domain: "concurrent_test",
      identity: "you race the same slug",
      method: "seal an agent definition concurrently",
      constraints: [],
      behavioral_primitives: ["explorer", "analyst"],
      input_types: [],
      output_types: ["raw-note"],
    };
    const def: Record<string, unknown> = {};
    for (const f of declared) def[f] = values[f];

    let thrown: unknown = null;
    try { defineAgent(def as never); } catch (e) { thrown = e; }

    expect(
      thrown === null,
      "the concurrency spec's worker passes only [" + declared.join(", ") + "], and " +
        "defineAgent rejects that: " +
        `${(thrown as Error)?.constructor?.name}: ${(thrown as Error)?.message}. ` +
        "identity/method became mandatory at src/composition.ts:126-131, so BOTH workers die " +
        "at startup and the spec fails at contract 1 WITHOUT EVER RACING. Concurrent-append " +
        "atomicity for the audit spine is currently assumed, not tested.",
    ).toBe(true);
  });
});

describe("#219 — stale guidance in the failure-mode headers", () => {
  it("disk_full.spec.ts no longer claims the typed write error is missing", () => {
    const header = readFileSync(join(REPO_ROOT, "tests/failure_modes/disk_full.spec.ts"), "utf-8").slice(0, 1400);
    expect(
      header.includes("coltrane has no RecorderWriteError type today"),
      "the header asserts `FileLedger.append` throws a raw NodeJS.SystemError. " +
        "src/ledger.ts:59-71 implements exactly the wrapping it asks for and the spec passes. " +
        "Someone will read that header and re-implement finished work.",
    ).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// GUARD (green today) — the premise the concurrency argument rests on
// ────────────────────────────────────────────────────────────────────────────
describe("GUARD #219 — ledger rows are no longer small", () => {
  it("a realistic gig row with usage + wide output_hashes exceeds a single small write", async () => {
    const { FileLedger } = await import("../src/ledger.js");
    const { mkdtempSync, rmSync, statSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");

    const dir = mkdtempSync(join(tmpdir(), "ledger-size-"));
    try {
      const path = join(dir, "ledger.jsonl");
      const l = new FileLedger(path);
      l.append({
        kind: "gig", schema_version: 2, entry_id: "wide", gig_id: "wide",
        standard_slug: "wide-fanout",
        genome_hash: "a".repeat(64), run_fingerprint: "b".repeat(64),
        output_hashes: Array.from({ length: 200 }, (_, i) => `${i}`.padStart(64, "0")),
        started_at: "2026-05-25T20:00:00.000Z", finished_at: "2026-05-25T20:01:00.000Z",
        usage: {
          input_tokens: 1, output_tokens: 1, total_cost_usd: 1,
          by_model: Object.fromEntries(
            Array.from({ length: 12 }, (_, i) => [`claude-model-variant-${i}`, { input_tokens: 1, output_tokens: 1, cost_usd: 1 }]),
          ),
        },
      } as never);

      expect(
        statSync(path).size,
        "midflight_kill.spec.ts:5-8 justifies assuming append atomicity because 'small entries " +
          "are well under PIPE_BUF'. usage.by_model and wide output_hashes arrays make that " +
          "premise false, so the assumption needs a real interleave test rather than a comment.",
      ).toBeGreaterThan(4096);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
