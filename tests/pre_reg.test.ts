// pre_reg.test.ts — sha256_pre_verdict stability, ledger append-only discipline,
// double-seal rejection, replay-verification. Covers the discover→define seam.

import { describe, it, expect } from "vitest";
import {
  computePreRegHash,
  validateSealedFields,
  sealPreReg,
  verifyPreRegSeal,
  MemoryPreRegLedger,
  FilePreRegLedger,
  PreRegSealError,
  type SealedFields,
  type PreReg,
} from "../src/pre_reg.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const validSealed: SealedFields = {
  predict: "the safe-prereg discipline will reduce post-seal field-mutation incidents by ≥80% across the next 30 days of agent runs",
  kill: "any sealed-fields field mutates after sealed_at — sha256_pre_verdict no longer matches recomputation",
  apoha: "this is NOT a runtime enforcement mechanism — only inscribes the seal moment. Runtime enforcement is the conductor's responsibility.",
};

describe("computePreRegHash — chain handle stability", () => {
  it("produces a 64-char hex sha256", () => {
    const h = computePreRegHash(validSealed);
    expect(h).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is stable across object key ordering", () => {
    const reordered: SealedFields = {
      apoha: validSealed.apoha,
      kill: validSealed.kill,
      predict: validSealed.predict,
    };
    expect(computePreRegHash(reordered)).toBe(computePreRegHash(validSealed));
  });

  it("differs if any sealed field changes", () => {
    const h0 = computePreRegHash(validSealed);
    const mutated: SealedFields = { ...validSealed, predict: validSealed.predict + " — refined" };
    expect(computePreRegHash(mutated)).not.toBe(h0);
  });
});

describe("validateSealedFields — apoha-cut minimum-content", () => {
  it("accepts valid triplets", () => {
    expect(() => validateSealedFields(validSealed)).not.toThrow();
  });

  it.each([
    ["predict", { ...validSealed, predict: "short" } as SealedFields],
    ["kill", { ...validSealed, kill: "x" } as SealedFields],
    ["apoha", { ...validSealed, apoha: "" } as SealedFields],
  ])("rejects too-short %s", (_field, fields) => {
    expect(() => validateSealedFields(fields)).toThrow(PreRegSealError);
  });
});

describe("sealPreReg — discover→define seam", () => {
  const fixedNow = () => new Date("2026-06-02T13:00:00Z");

  it("seals a draft + writes a ledger entry + returns the SEALED PreReg", () => {
    const ledger = new MemoryPreRegLedger();
    const { pre_reg, ledger_entry } = sealPreReg(
      {
        pre_reg_id: "test-prereg-1",
        kind: "research-experiment",
        sealed: validSealed,
        sealed_by: "cajal",
        now: fixedNow,
      },
      ledger,
    );
    expect(pre_reg.state).toBe("sealed");
    expect(pre_reg.pre_reg_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(pre_reg.sealed_at).toBe("2026-06-02T13:00:00.000Z");
    expect(pre_reg.sealed_by).toBe("cajal");
    expect(ledger.count()).toBe(1);
    expect(ledger_entry.pre_reg_id).toBe("test-prereg-1");
    expect(ledger_entry.pre_reg_hash).toBe(pre_reg.pre_reg_hash);
  });

  it("rejects a double-seal of the same pre_reg_id", () => {
    const ledger = new MemoryPreRegLedger();
    sealPreReg(
      { pre_reg_id: "test-prereg-2", kind: "code-change", sealed: validSealed, sealed_by: "cajal", now: fixedNow },
      ledger,
    );
    expect(() =>
      sealPreReg(
        { pre_reg_id: "test-prereg-2", kind: "code-change", sealed: validSealed, sealed_by: "cajal", now: fixedNow },
        ledger,
      ),
    ).toThrow(PreRegSealError);
  });

  it("rejects sealing with under-spec'd fields", () => {
    const ledger = new MemoryPreRegLedger();
    expect(() =>
      sealPreReg(
        {
          pre_reg_id: "test-prereg-3",
          kind: "research-experiment",
          sealed: { ...validSealed, kill: "no" },
          sealed_by: "cajal",
          now: fixedNow,
        },
        ledger,
      ),
    ).toThrow(/sealed\.kill too short/);
  });
});

describe("verifyPreRegSeal — replay-verification detects tampering", () => {
  it("verifies a freshly-sealed pre-reg", () => {
    const ledger = new MemoryPreRegLedger();
    const { pre_reg } = sealPreReg(
      { pre_reg_id: "test-prereg-4", kind: "research-experiment", sealed: validSealed, sealed_by: "cajal" },
      ledger,
    );
    const v = verifyPreRegSeal(pre_reg);
    expect(v.valid).toBe(true);
    expect(v.computed_hash).toBe(pre_reg.pre_reg_hash);
  });

  it("detects tampering with the sealed triplet", () => {
    const ledger = new MemoryPreRegLedger();
    const { pre_reg } = sealPreReg(
      { pre_reg_id: "test-prereg-5", kind: "research-experiment", sealed: validSealed, sealed_by: "cajal" },
      ledger,
    );
    // Tamper: silently mutate a sealed field, keep the old hash.
    const tampered: PreReg = {
      ...pre_reg,
      sealed: { ...pre_reg.sealed, predict: pre_reg.sealed.predict + " (silently appended)" },
    };
    const v = verifyPreRegSeal(tampered);
    expect(v.valid).toBe(false);
    expect(v.computed_hash).not.toBe(pre_reg.pre_reg_hash);
  });

  it("rejects unsealed (drafted) pre-regs", () => {
    const drafted: PreReg = {
      id: "drafted-1",
      kind: "research-experiment",
      sealed: validSealed,
      state: "drafted",
      sealed_at: null,
      sealed_by: null,
      pre_reg_hash: null,
    };
    const v = verifyPreRegSeal(drafted);
    expect(v.valid).toBe(false);
  });
});

describe("FilePreRegLedger — durable append-only across restarts", () => {
  it("persists entries across instances", () => {
    const dir = mkdtempSync(join(tmpdir(), "prereg-ledger-"));
    const path = join(dir, "ledger.jsonl");
    try {
      const l1 = new FilePreRegLedger(path);
      sealPreReg(
        { pre_reg_id: "f-1", kind: "research-experiment", sealed: validSealed, sealed_by: "cajal" },
        l1,
      );
      // New instance reads what the previous wrote.
      const l2 = new FilePreRegLedger(path);
      expect(l2.count()).toBe(1);
      expect(l2.has("f-1")).toBe(true);
      // File contents are JSON-lines per line.
      const raw = readFileSync(path, "utf-8");
      expect(raw.split("\n").filter(Boolean).length).toBe(1);
      const parsed = JSON.parse(raw.split("\n")[0]);
      expect(parsed.pre_reg_id).toBe("f-1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects double-seal on a file-backed ledger across instances", () => {
    const dir = mkdtempSync(join(tmpdir(), "prereg-ledger-"));
    const path = join(dir, "ledger.jsonl");
    try {
      const l1 = new FilePreRegLedger(path);
      sealPreReg(
        { pre_reg_id: "f-2", kind: "research-experiment", sealed: validSealed, sealed_by: "cajal" },
        l1,
      );
      const l2 = new FilePreRegLedger(path);
      expect(() =>
        sealPreReg(
          { pre_reg_id: "f-2", kind: "research-experiment", sealed: validSealed, sealed_by: "cajal" },
          l2,
        ),
      ).toThrow(PreRegSealError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
