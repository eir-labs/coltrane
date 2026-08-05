// RED — issue #210 (no ledger path override / default location) and
//       issue #209 (bootstrapServerDeps defaults to MemoryLedger).
//
// These land together: #209 cannot ship without #210, because bootstrapServerDeps() called
// with no root resolves to process.cwd() (src/server.ts:1260), so a naive FileLedger default
// would write into whatever directory the operator — or a test — launched from.
// tests/dispatch_tool_resolution.test.ts:122,130 calls it exactly that way.
//
// The reframe that matters (and the reason #209 is critical rather than merely missing):
// tests/e2e/recorder_durability_mid_crash.spec.ts:1-19 deliberately pins the ABSENCE of a
// ledger row as the signal that a run did not complete — "NO ledger entry exists for the
// crashed gig … no fake seal". A memory ledger converts that load-bearing invariant into a
// FALSE NEGATIVE: after a restart, absence means "we forgot", not "it didn't finish".
// The guard at the bottom of this file pins both halves of the pair, because absence only
// carries information if presence is durable.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapServerDeps, dispatchTool } from "../src/server.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const GENOME_HASH = "a".repeat(64);
const RUN_FP = "b".repeat(64);

type Row = Record<string, unknown>;

function gigRow(over: Row = {}): Row {
  return {
    kind: "gig",
    schema_version: 2,
    entry_id: "G",
    gig_id: "G",
    standard_slug: "readiness-scan",
    genome_hash: GENOME_HASH,
    run_fingerprint: RUN_FP,
    output_hashes: ["oh1"],
    started_at: "2026-05-25T20:00:00.000Z",
    finished_at: "2026-05-25T20:01:00.000Z",
    ...over,
  };
}

/** Minimal loadable genome: loadGenome hard-fails without core_types/. Same seeding shape
 *  as tests/failure_modes/midflight_kill.spec.ts:64-83. */
function seedGenome(root: string): void {
  const coreDir = join(root, "core_types");
  mkdirSync(coreDir, { recursive: true });
  for (const [slug, primitive] of [
    ["Signal", "SENSE"], ["Interpretation", "INTERPRET"], ["Judgment", "JUDGE"],
    ["Plan", "PLAN"], ["Artifact", "CREATE"], ["Verdict", "VERIFY"],
  ] as const) {
    writeFileSync(
      join(coreDir, slug.toLowerCase() + ".json"),
      JSON.stringify({ slug, primitive, description: "", schema: { type: "object", properties: {}, required: [] } }),
    );
  }
}

let root: string;
let sandbox: string;
const SAVED: Record<string, string | undefined> = {};
const TOUCHED = ["COLTRANE_LEDGER_PATH", "COLTRANE_OUTPUTS_DIR", "COLTRANE_GENOME"] as const;

beforeEach(() => {
  for (const k of TOUCHED) SAVED[k] = process.env[k];
  sandbox = mkdtempSync(join(tmpdir(), "ledger-durability-"));
  root = join(sandbox, "genome");
  mkdirSync(root, { recursive: true });
  seedGenome(root);
  // Never let a bootstrap in this file touch the developer's real $HOME/.eir.
  process.env["COLTRANE_OUTPUTS_DIR"] = join(sandbox, "outputs");
});

afterEach(() => {
  for (const k of TOUCHED) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k]!;
  }
  rmSync(sandbox, { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────────────────────────
// #210 — the path resolver
// ────────────────────────────────────────────────────────────────────────────
describe("#210 — defaultLedgerPath()", () => {
  it("src/ledger.ts exports defaultLedgerPath", async () => {
    const mod = (await import("../src/ledger.js")) as unknown as Record<string, unknown>;
    expect(
      typeof mod["defaultLedgerPath"],
      "no default ledger location exists anywhere in the tree. Every peer subsystem has one " +
        "(outputs: COLTRANE_OUTPUTS_DIR, src/outputs.ts:157; portfolio: COLTRANE_PORTFOLIO_ROOT, " +
        "src/portfolio.ts:58; recorder: COLTRANE_RECORDER_PATH, src/server.ts:1334) — the audit " +
        "spine has none. This is the hard prerequisite for #209.",
    ).toBe("function");
  });

  it("COLTRANE_LEDGER_PATH is honored verbatim", async () => {
    const mod = (await import("../src/ledger.js")) as unknown as Record<string, unknown>;
    const resolve = mod["defaultLedgerPath"] as ((root?: string) => string) | undefined;
    expect(typeof resolve, "defaultLedgerPath not exported — see preceding test").toBe("function");

    const override = join(sandbox, "custom", "audit.jsonl");
    process.env["COLTRANE_LEDGER_PATH"] = override;
    expect(
      resolve!(root),
      "the env override must win over the derived default, mirroring " +
        "defaultOutputsPersistDir (src/outputs.ts:158-159). Without it, tests that call " +
        "bootstrapServerDeps() cannot redirect the ledger away from the real filesystem.",
    ).toBe(override);
  });

  it("without the override, resolves under the genome root's .coltrane/ dir", async () => {
    const mod = (await import("../src/ledger.js")) as unknown as Record<string, unknown>;
    const resolve = mod["defaultLedgerPath"] as ((root?: string) => string) | undefined;
    expect(typeof resolve).toBe("function");
    delete process.env["COLTRANE_LEDGER_PATH"];
    expect(
      resolve!(root),
      "DECIDED: <root>/.coltrane/ledger.jsonl, genome-scoped — not a $HOME-global path.\n" +
        "The argument is audit correctness, not precedent: a genome_hash is only meaningful " +
        "RELATIVE TO A GENOME, and standard_slug is not namespaced. A global ledger would " +
        "interleave rows from every genome the operator has ever run, so " +
        "query({standard_slug:'scan'}) would return runs from unrelated genomes as one " +
        "history. Outputs tolerate a global root only because they are sharded per gig_id " +
        "file. The portfolio precedent (src/portfolio.ts:58-64) agrees, and " +
        "writeGenomeFileVersioned already writes .coltrane/history/ into the genome root, so " +
        "a read-only consumer clone is no new constraint.",
    ).toBe(join(root, ".coltrane", "ledger.jsonl"));
  });
});

// ────────────────────────────────────────────────────────────────────────────
// #209 — the bootstrap default
// ────────────────────────────────────────────────────────────────────────────
describe("#209 — bootstrapServerDeps hands the server a DURABLE ledger", () => {
  it("a row appended through bootstrapped deps survives a re-bootstrap", () => {
    process.env["COLTRANE_LEDGER_PATH"] = join(sandbox, "ledger.jsonl");

    const first = bootstrapServerDeps(root);
    first.ledger.append(gigRow() as never);
    expect(first.ledger.query({ gig_id: "G" }).length, "sanity: the row was appended").toBe(1);

    const reborn = bootstrapServerDeps(root);
    expect(
      reborn.ledger.query({ gig_id: "G" }).length,
      "run provenance did not survive a process restart. src/server.ts:1283 is " +
        "`ledger: new MemoryLedger()` — directly below the line that gives OUTPUTS a " +
        "persistDir under an explicit 'the audit chain must survive an MCP session close' " +
        "requirement (PR #78). FileLedger is complete, exported, and has zero production " +
        "call sites.",
    ).toBe(1);
  });

  it("the bootstrapped ledger writes to the resolved path on disk", () => {
    const ledgerPath = join(sandbox, "ledger.jsonl");
    process.env["COLTRANE_LEDGER_PATH"] = ledgerPath;

    const deps = bootstrapServerDeps(root);
    deps.ledger.append(gigRow() as never);

    expect(
      existsSync(ledgerPath),
      `nothing was written to ${ledgerPath} — the bootstrap ledger is not file-backed`,
    ).toBe(true);
  });

  it("a COMPLETED gig still reads as complete after a restart (the sharpest consequence)", async () => {
    process.env["COLTRANE_LEDGER_PATH"] = join(sandbox, "ledger.jsonl");

    // Stand in for src/runtime.ts:781 — the seal a finished gig writes.
    const first = bootstrapServerDeps(root);
    first.ledger.append(gigRow({ gig_id: "finished-gig", entry_id: "finished-gig" }) as never);

    const reborn = bootstrapServerDeps(root);
    const res = await dispatchTool("gig_monitor", { gig_id: "finished-gig" }, reborn);
    expect(res.ok).toBe(true);
    expect(
      (res.data as { status: string }).status,
      "gig_monitor's post-restart fallback is `entry ? \"complete\" : outs.length > 0 ? " +
        "\"running\" : \"unknown\"` (src/server.ts:478). With an in-memory ledger the entry is " +
        "gone, so a FINISHED gig reports running (outputs persist) or unknown — permanently. " +
        "gig_abort on that same gig then returns {status:'running', aborted:true}: the engine " +
        "claims to have aborted a run that succeeded.",
    ).toBe("complete");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// GUARD (green today, must stay green) — absence must keep meaning "un-sealed"
// ────────────────────────────────────────────────────────────────────────────
describe("GUARD #209 — a durable ledger must not fabricate rows", () => {
  it("a gig that was never sealed has no row after a restart, and does not read as complete", async () => {
    process.env["COLTRANE_LEDGER_PATH"] = join(sandbox, "ledger.jsonl");

    const first = bootstrapServerDeps(root);
    first.ledger.append(gigRow({ gig_id: "sealed", entry_id: "sealed" }) as never);

    const reborn = bootstrapServerDeps(root);
    expect(
      reborn.ledger.query({ gig_id: "never-sealed" }).length,
      "making the ledger durable must not invent a row for a gig that never completed. " +
        "tests/e2e/recorder_durability_mid_crash.spec.ts:209-221 pins absence-of-row as the " +
        "'no fake seal' half of the durability contract — that invariant stays.",
    ).toBe(0);

    const res = await dispatchTool("gig_monitor", { gig_id: "never-sealed" }, reborn);
    expect(
      (res.data as { status: string }).status,
      "an unsealed gig must never report complete",
    ).not.toBe("complete");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// GUARD — the unit suite must not write a ledger into the repo working tree
// ────────────────────────────────────────────────────────────────────────────
describe("GUARD #209/#210 — no repo-tree pollution", () => {
  // The fix has two halves and this describe pins BOTH, because either alone regresses
  // silently. The first version of this guard only asserted that CONSTRUCTING deps wrote
  // nothing — which lazy construction satisfies trivially, while server_bootstrap.test.ts and
  // server_relay.test.ts went on to dispatch real gigs through bootstrapped deps and landed 15
  // rows in <repo>/.coltrane/ledger.jsonl with the guard still green. A guard that cannot see
  // the leak it exists to catch is worse than no guard.

  it("half 1 — constructing bootstrapped deps writes nothing (lazy FileLedger)", () => {
    // bootstrapServerDeps() with no argument resolves the genome root to process.cwd()
    // (src/server.ts) — the repo itself. tests/dispatch_tool_resolution.test.ts:122,130
    // calls it exactly that way. With the override removed, the resolved path IS inside the
    // checkout, so this passes only if FileLedger creates nothing until the first append.
    delete process.env["COLTRANE_LEDGER_PATH"];
    const repoLedger = join(REPO_ROOT, ".coltrane", "ledger.jsonl");
    const preexisting = existsSync(repoLedger);

    try {
      bootstrapServerDeps();
      expect(
        existsSync(repoLedger) && !preexisting,
        `bootstrapServerDeps() created ${repoLedger}. The audit spine must not be seeded into ` +
          "the developer's checkout as a side effect of running the unit suite — it would be " +
          "committed, or worse, silently accumulate rows from every test run and be mistaken " +
          "for real history.",
      ).toBe(false);
    } finally {
      // Never let this guard be the thing that pollutes the tree.
      if (!preexisting && existsSync(repoLedger)) rmSync(repoLedger, { force: true });
    }
  });

  it("half 2 — the suite redirects the ledger out of the checkout", () => {
    // The override is the half that survives a real write. It is set by vitest.config.ts (and
    // tests/failure_modes/vitest.config.ts) rather than by any individual test, so deleting it
    // there must break something — this is that something.
    const override = process.env["COLTRANE_LEDGER_PATH"];
    expect(
      override,
      "COLTRANE_LEDGER_PATH is not set for the unit suite. Without it, every suite that " +
        "bootstraps against the repo root and dispatches a gig appends to " +
        "<repo>/.coltrane/ledger.jsonl. Set it in vitest.config.ts `test.env`.",
    ).toBeTruthy();
    expect(
      override!.startsWith(REPO_ROOT),
      `COLTRANE_LEDGER_PATH points inside the checkout (${override}) — the override has to ` +
        "redirect OUT of the working tree, not to another place within it.",
    ).toBe(false);
  });

  it("half 2 — APPENDING through no-root bootstrapped deps leaves the checkout clean", () => {
    // The assertion the original guard was missing: exercise the write path, not just the
    // constructor. This is the shape server_bootstrap.test.ts / server_relay.test.ts hit in
    // production, and the shape that actually leaked.
    const repoLedger = join(REPO_ROOT, ".coltrane", "ledger.jsonl");
    const preexisting = existsSync(repoLedger);
    const sizeBefore = preexisting ? statSync(repoLedger).size : 0;

    try {
      const deps = bootstrapServerDeps(); // no root → cwd → the repo checkout
      deps.ledger.append(gigRow({ gig_id: "pollution-probe", entry_id: "pollution-probe" }) as never);

      expect(
        existsSync(repoLedger) && !preexisting,
        `appending through bootstrapped deps created ${repoLedger}. The audit spine must not ` +
          "be seeded into the developer's checkout by running the suite — those rows get " +
          "committed, or silently accumulate and get mistaken for real history.",
      ).toBe(false);
      if (preexisting) {
        expect(
          statSync(repoLedger).size,
          `the suite appended to the pre-existing ${repoLedger}`,
        ).toBe(sizeBefore);
      }
    } finally {
      if (!preexisting && existsSync(repoLedger)) rmSync(repoLedger, { force: true });
    }
  });
});
