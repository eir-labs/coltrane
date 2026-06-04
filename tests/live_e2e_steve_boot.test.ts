// live_e2e_steve_boot.test.ts — full Steve boot-to-ledger circuit.
//
// Exercises every piece of the live-slack stack in order, on a real fs scaffold
// in a temp directory. No Slack API, no Claude Code CLI — those are the seams
// stubbed at the bridge layer. What we DO run for real:
//
//   1. materializeScaffold → 4 steve dirs + seed.json + audit.jsonl + manifest
//   2. tune() for each Steve → 4 TuningSeals written to per-Steve audit.jsonl
//   3. bindNewSession() for each Steve → 4 CcSessionBindings appended
//   4. parse each Steve's audit.jsonl → confirm both events present + sealed
//   5. verifyBindingSeal on every binding → tamper-detection works
//   6. ensureSessionId reads back the right session per Steve (multi-Steve filter)
//   7. cross-Steve: confirm session_ids differ across the 4 Steves
//
// This is the integration test the unit-level live_*.test.ts suite was missing.
// Chain-keeper distinctive: end-to-end audit-chain integrity across operators.

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeScaffold, STEVE_COUNT } from "../src/live/scaffold.js";
import { tune } from "../src/live/tuning.js";
import {
  bindNewSession,
  ensureSessionId,
  verifyBindingSeal,
  getActiveSessionBinding,
  type CcSessionBinding,
} from "../src/live/cc_session_binding.js";
import type { TuningSeal } from "../src/live/tuning_types.js";

interface BootResult {
  root: string;
  steveDirs: string[];
  uuids: string[];
  tuningSeals: TuningSeal[];
  bindings: CcSessionBinding[];
}

/**
 * Run the full Steve boot circuit on a temp root.
 * Returns the assembled BootResult for assertions.
 *
 * Real fs writes through scaffold + tune + bind. Project-shape scan reads
 * the temp root (no CLAUDE.md by default — tune handles missing files
 * gracefully via the honest-gap pattern). Deterministic uuids supplied.
 */
async function bootFourSteves(root: string): Promise<BootResult> {
  const uuids = [
    "steve-uuid-aaaaaaaaaa",
    "steve-uuid-bbbbbbbbbb",
    "steve-uuid-cccccccccc",
    "steve-uuid-dddddddddd",
  ];
  // Minimal CLAUDE.md so scanProject has something to read — otherwise the
  // tuning still works but produces all-null project signals.
  const fs = await import("node:fs/promises");
  await fs.writeFile(
    join(root, "CLAUDE.md"),
    "# Test project\n\nA project for e2e Steve boot testing.\n",
    "utf8",
  );

  const scaffold = await materializeScaffold({ root, uuids });
  expect(scaffold.steve_dirs).toHaveLength(STEVE_COUNT);
  expect(scaffold.seeds).toHaveLength(STEVE_COUNT);

  const tuningSeals: TuningSeal[] = [];
  const bindings: CcSessionBinding[] = [];
  const at0 = new Date("2026-06-04T01:00:00.000Z");

  for (let i = 0; i < STEVE_COUNT; i++) {
    const uuid = uuids[i]!;
    const steveDir = scaffold.steve_dirs[i]!;
    const seedPath = join(steveDir, "seed.json");
    const auditPath = join(steveDir, "audit.jsonl");
    // tune writes a TuningSeal to audit.jsonl
    const seal = await tune(uuid, seedPath, root, auditPath, {
      now: () => new Date(at0.getTime() + i * 1000),
    });
    tuningSeals.push(seal);

    // bind a CC session for this Steve
    const binding = await bindNewSession(uuid, auditPath, "worker_boot", {
      now: () => new Date(at0.getTime() + (i + 100) * 1000),
      rng: () => `session-${uuid.slice(-2)}-deterministic`,
    });
    bindings.push(binding);
  }

  return { root, steveDirs: scaffold.steve_dirs, uuids, tuningSeals, bindings };
}

describe("live e2e — Steve boot circuit", () => {
  it("scaffold + tune + bind for 4 Steves produces a verifiable audit chain", async () => {
    const root = mkdtempSync(join(tmpdir(), "live-e2e-"));
    try {
      const r = await bootFourSteves(root);

      // 4 Steves, 4 dirs, 4 seals, 4 bindings
      expect(r.steveDirs).toHaveLength(STEVE_COUNT);
      expect(r.tuningSeals).toHaveLength(STEVE_COUNT);
      expect(r.bindings).toHaveLength(STEVE_COUNT);

      // Each Steve's dir has audit.jsonl with exactly 2 events
      for (let i = 0; i < STEVE_COUNT; i++) {
        const audit = readFileSync(join(r.steveDirs[i]!, "audit.jsonl"), "utf8");
        const lines = audit.trim().split("\n").filter((l) => l.length > 0);
        expect(lines).toHaveLength(2);
        const parsed = lines.map((l) => JSON.parse(l) as { kind: string });
        expect(parsed[0]!.kind).toBe("tuning");
        expect(parsed[1]!.kind).toBe("cc_session_bound");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("every binding's sha_seal verifies (no tamper on a clean run)", async () => {
    const root = mkdtempSync(join(tmpdir(), "live-e2e-"));
    try {
      const r = await bootFourSteves(root);
      for (const b of r.bindings) {
        expect(verifyBindingSeal(b)).toBe(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("session_ids are distinct across the 4 Steves (no aliasing across audit streams)", async () => {
    const root = mkdtempSync(join(tmpdir(), "live-e2e-"));
    try {
      const r = await bootFourSteves(root);
      const sids = new Set(r.bindings.map((b) => b.session_id));
      expect(sids.size).toBe(STEVE_COUNT);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("getActiveSessionBinding reads back the right session per Steve", async () => {
    const root = mkdtempSync(join(tmpdir(), "live-e2e-"));
    try {
      const r = await bootFourSteves(root);
      for (let i = 0; i < STEVE_COUNT; i++) {
        const uuid = r.uuids[i]!;
        const auditPath = join(r.steveDirs[i]!, "audit.jsonl");
        const found = await getActiveSessionBinding(uuid, auditPath);
        expect(found).not.toBeNull();
        expect(found!.session_id).toBe(r.bindings[i]!.session_id);
        // confirm getActiveSessionBinding doesn't return another Steve's session
        const wrongSteveUuid = r.uuids[(i + 1) % STEVE_COUNT]!;
        const foundForWrongSteve = await getActiveSessionBinding(
          wrongSteveUuid,
          auditPath,
        );
        // wrongSteveUuid never bound in this audit file → null
        expect(foundForWrongSteve).toBeNull();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ensureSessionId returns the existing session (no fresh mint on second call)", async () => {
    const root = mkdtempSync(join(tmpdir(), "live-e2e-"));
    try {
      const r = await bootFourSteves(root);
      const uuid = r.uuids[0]!;
      const auditPath = join(r.steveDirs[0]!, "audit.jsonl");
      const before = readFileSync(auditPath, "utf8");

      const result = await ensureSessionId(uuid, auditPath, "manual_resume");
      expect(result.fresh).toBe(false);
      expect(result.session_id).toBe(r.bindings[0]!.session_id);

      const after = readFileSync(auditPath, "utf8");
      expect(after).toBe(before); // no new lines written
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("tampering with a binding's session_id is detectable via verifyBindingSeal", async () => {
    const root = mkdtempSync(join(tmpdir(), "live-e2e-"));
    try {
      const r = await bootFourSteves(root);
      const tampered: CcSessionBinding = {
        ...r.bindings[0]!,
        session_id: "session-tampered",
      };
      expect(verifyBindingSeal(tampered)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the 4 Steves' tuning seal_hashes are distinct (orthogonal seeds → distinct seals)", async () => {
    const root = mkdtempSync(join(tmpdir(), "live-e2e-"));
    try {
      const r = await bootFourSteves(root);
      const sealHashes = new Set(r.tuningSeals.map((s) => s.seal_hash));
      expect(sealHashes.size).toBe(STEVE_COUNT);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("scaffold creates the expected layout (manifest + env template + 4 dirs)", async () => {
    const root = mkdtempSync(join(tmpdir(), "live-e2e-"));
    try {
      const r = await bootFourSteves(root);
      expect(existsSync(join(root, "coltrane", "slack-app-manifest.yaml"))).toBe(true);
      expect(existsSync(join(root, ".env.template"))).toBe(true);
      for (const d of r.steveDirs) {
        expect(existsSync(join(d, "audit.jsonl"))).toBe(true);
        expect(existsSync(join(d, "seed.json"))).toBe(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("running ensureSessionId on a freshly-scaffolded Steve mints + seals (round-trip)", async () => {
    const root = mkdtempSync(join(tmpdir(), "live-e2e-"));
    try {
      const fs = await import("node:fs/promises");
      await fs.writeFile(join(root, "CLAUDE.md"), "# test\n", "utf8");
      const scaffold = await materializeScaffold({
        root,
        uuids: ["fresh-steve-uuid"],
      });
      const auditPath = join(scaffold.steve_dirs[0]!, "audit.jsonl");
      const result = await ensureSessionId(
        "fresh-steve-uuid",
        auditPath,
        "first_inbox_event",
      );
      expect(result.fresh).toBe(true);
      expect(result.session_id.length).toBeGreaterThan(0);
      // re-read: now non-fresh
      const second = await ensureSessionId(
        "fresh-steve-uuid",
        auditPath,
        "first_inbox_event",
      );
      expect(second.fresh).toBe(false);
      expect(second.session_id).toBe(result.session_id);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
