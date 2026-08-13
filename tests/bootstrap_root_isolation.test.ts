// RED-first — #328. A test file's audit spine must be ITS OWN, so system_health's scan is bounded.
//
// The flake: two tests that call `system_health` failed intermittently in the full suite and never
// in isolation — 2 failures in 4 full-suite runs on clean main, always `Error: Test timed out in
// 5000ms`, against a 2263ms runtime when run alone.
//
// The cause was not a race. vitest.config.ts pinned COLTRANE_LEDGER_PATH / COLTRANE_MIRROR_DIR to
// one fixed path for the whole suite — correctly, to stop an unrooted bootstrap seeding the
// developer's checkout — which also meant all 213 files shared one ledger and one mirror. Every
// sealing test appended to them, so they grew monotonically through the run, and `system_health`
// scans both whole (`ledger.integrity()` + `outputs.integrity()`). The cost of those two tests
// therefore tracked suite progress, not their own work.
//
// The assertion below is the one that measured it: before the fix this reported 2428 entries
// inherited from other files.
//
// NOTE ON SCOPE. The first fix attempted here changed PRODUCTION precedence — making an explicit
// root outrank the env override in defaultLedgerPath/defaultMirrorDir. It was reverted: it broke
// tests/ledger_durability.test.ts, which pins the resolution rules on purpose, and the change is
// questionable on its own merits (an operator running `--genome` with COLTRANE_LEDGER_PATH aimed at
// a mounted volume has a fair claim on the override winning). The defect was in the harness, so the
// fix is in the harness. Whether an explicit root SHOULD outrank the override is a real design
// question and is deliberately left open rather than settled as a side effect of a flake fix.
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapServerDeps } from "../src/server.js";

describe("#328 — each test file gets its own audit spine", () => {
  it("this file's ledger carries NO entries from any other test file", () => {
    // The load-bearing property. If per-file isolation regresses, this count climbs with whatever
    // else the suite has already sealed, and the system_health tests start timing out again.
    const entries = bootstrapServerDeps().ledger.integrity().entries;
    expect(
      entries,
      `this file's ledger already holds ${entries} entries written by other test files. The suite ` +
        "is sharing one audit spine again, so every system_health scan pays for the whole run.",
    ).toBe(0);
  });

  it("the ledger override points inside a per-file spine, not the suite-wide path", () => {
    const path = process.env["COLTRANE_LEDGER_PATH"];
    expect(path, "the setup file did not run — no ledger override is set").toBeTruthy();
    expect(
      path!.includes("coltrane-test-spine-"),
      `ledger resolved to "${path}" — that is the suite-wide path, not a per-file spine`,
    ).toBe(true);
  });

  it("the mirror override points inside the same per-file spine", () => {
    const mirror = process.env["COLTRANE_MIRROR_DIR"];
    expect(mirror, "the setup file did not run — no mirror override is set").toBeTruthy();
    expect(mirror!.includes("coltrane-test-spine-")).toBe(true);
    expect(
      process.env["COLTRANE_LEDGER_PATH"]!.startsWith(mirror!),
      "ledger and mirror landed in different spines — they are meant to sit beside each other",
    ).toBe(true);
  });

  it("an UNROOTED bootstrap still resolves to the override, never the checkout", () => {
    // The protection the original config existed for, preserved: without a root there is nothing to
    // isolate to, and resolving to cwd would seed the developer's working tree with audit rows.
    expect(bootstrapServerDeps().ledger.integrity().path).toBe(process.env["COLTRANE_LEDGER_PATH"]);
  });

  it("an explicitly-rooted bootstrap still honors the override (production semantics UNCHANGED)", () => {
    // Pinned deliberately: the reverted attempt changed exactly this, and the revert should be
    // visible as an invariant rather than as an absence. tests/ledger_durability.test.ts owns the
    // full resolution contract; this is the one line that failed under the reverted approach.
    const root = mkdtempSync(join(tmpdir(), "coltrane-iso-root-"));
    try {
      expect(bootstrapServerDeps(root).ledger.integrity().path).toBe(process.env["COLTRANE_LEDGER_PATH"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
