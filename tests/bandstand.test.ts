// bandstand.test.ts — atomic claim/release, scope-hash discrimination, TTL expiry.

import { describe, it, expect } from "vitest";
import {
  ClaimLedger,
  BandstandError,
  claimLane,
  releaseLane,
  laneStatus,
  listActiveClaims,
  computeScopeHash,
} from "../src/bandstand.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makeLedger(): { ledger: ClaimLedger; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "bandstand-"));
  const path = join(dir, "claims.jsonl");
  const ledger = new ClaimLedger(path);
  return { ledger, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("computeScopeHash — stable scope identification", () => {
  it("returns 16-char hex", () => {
    expect(computeScopeHash("draft push_05b prereg")).toMatch(/^[a-f0-9]{16}$/);
  });
  it("is stable across whitespace at edges", () => {
    expect(computeScopeHash("  hello  ")).toBe(computeScopeHash("hello"));
  });
  it("differs for different scopes", () => {
    expect(computeScopeHash("a")).not.toBe(computeScopeHash("b"));
  });
});

describe("claimLane — atomic check-and-set", () => {
  const fixedNow = () => new Date("2026-06-02T20:00:00Z");

  it("acquires an unheld lane", () => {
    const { ledger, cleanup } = makeLedger();
    try {
      const r = claimLane(
        { lane: "heliograph-luna", ant: "cajal", intent: "draft push_05b", scope_hash: "abc123", ttl_seconds: 1800, now: fixedNow },
        ledger,
      );
      expect(r.status).toBe("ACQUIRED");
      if (r.status === "ACQUIRED") {
        expect(r.lane).toBe("heliograph-luna");
        expect(r.ant).toBe("cajal");
        expect(r.expires_at).toBe("2026-06-02T20:30:00.000Z");
      }
    } finally {
      cleanup();
    }
  });

  it("second ant on same lane gets HELD_BY_OTHER", () => {
    const { ledger, cleanup } = makeLedger();
    try {
      claimLane(
        { lane: "L1", ant: "cajal", intent: "draft", scope_hash: "abc", ttl_seconds: 600, now: fixedNow },
        ledger,
      );
      const r = claimLane(
        { lane: "L1", ant: "miles", intent: "also-draft", scope_hash: "xyz", ttl_seconds: 600, now: fixedNow },
        ledger,
      );
      expect(r.status).toBe("HELD_BY_OTHER");
      if (r.status === "HELD_BY_OTHER") {
        expect(r.held_by).toBe("cajal");
        expect(r.intent).toBe("draft");
      }
    } finally {
      cleanup();
    }
  });

  it("same ant + same scope_hash returns SAME_SCOPE_REPEAT (idempotent)", () => {
    const { ledger, cleanup } = makeLedger();
    try {
      claimLane(
        { lane: "L1", ant: "cajal", intent: "x", scope_hash: "h1", ttl_seconds: 600, now: fixedNow },
        ledger,
      );
      const r = claimLane(
        { lane: "L1", ant: "cajal", intent: "x", scope_hash: "h1", ttl_seconds: 600, now: fixedNow },
        ledger,
      );
      expect(r.status).toBe("SAME_SCOPE_REPEAT");
    } finally {
      cleanup();
    }
  });

  it("same ant + different scope_hash throws (must release first)", () => {
    const { ledger, cleanup } = makeLedger();
    try {
      claimLane(
        { lane: "L1", ant: "cajal", intent: "x", scope_hash: "h1", ttl_seconds: 600, now: fixedNow },
        ledger,
      );
      expect(() =>
        claimLane(
          { lane: "L1", ant: "cajal", intent: "y", scope_hash: "h2", ttl_seconds: 600, now: fixedNow },
          ledger,
        ),
      ).toThrow(BandstandError);
    } finally {
      cleanup();
    }
  });

  it("expired claim allows re-acquisition by anyone", () => {
    const { ledger, cleanup } = makeLedger();
    try {
      claimLane(
        { lane: "L1", ant: "cajal", intent: "x", scope_hash: "h1", ttl_seconds: 60, now: () => new Date("2026-06-02T20:00:00Z") },
        ledger,
      );
      // 2 minutes later — original TTL has expired
      const r = claimLane(
        { lane: "L1", ant: "miles", intent: "y", scope_hash: "h2", ttl_seconds: 60, now: () => new Date("2026-06-02T20:02:00Z") },
        ledger,
      );
      expect(r.status).toBe("ACQUIRED");
    } finally {
      cleanup();
    }
  });
});

describe("releaseLane — only holder can release", () => {
  const fixedNow = () => new Date("2026-06-02T20:00:00Z");

  it("releases a held lane", () => {
    const { ledger, cleanup } = makeLedger();
    try {
      claimLane({ lane: "L1", ant: "cajal", intent: "x", scope_hash: "h", ttl_seconds: 600, now: fixedNow }, ledger);
      const r = releaseLane({ lane: "L1", ant: "cajal", now: fixedNow }, ledger);
      expect(r.released).toBe(true);
      expect(laneStatus("L1", ledger, fixedNow()).held).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("idempotent release on unheld lane", () => {
    const { ledger, cleanup } = makeLedger();
    try {
      const r = releaseLane({ lane: "never-held", ant: "cajal", now: fixedNow }, ledger);
      expect(r.released).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("other ant cannot release someone else's lane", () => {
    const { ledger, cleanup } = makeLedger();
    try {
      claimLane({ lane: "L1", ant: "cajal", intent: "x", scope_hash: "h", ttl_seconds: 600, now: fixedNow }, ledger);
      expect(() => releaseLane({ lane: "L1", ant: "miles", now: fixedNow }, ledger)).toThrow(BandstandError);
    } finally {
      cleanup();
    }
  });
});

describe("listActiveClaims", () => {
  const fixedNow = () => new Date("2026-06-02T20:00:00Z");

  it("lists multiple active claims", () => {
    const { ledger, cleanup } = makeLedger();
    try {
      claimLane({ lane: "A", ant: "cajal", intent: "a", scope_hash: "1", ttl_seconds: 600, now: fixedNow }, ledger);
      claimLane({ lane: "B", ant: "miles", intent: "b", scope_hash: "2", ttl_seconds: 600, now: fixedNow }, ledger);
      claimLane({ lane: "C", ant: "subhuti", intent: "c", scope_hash: "3", ttl_seconds: 600, now: fixedNow }, ledger);
      const active = listActiveClaims(ledger, fixedNow());
      expect(active.length).toBe(3);
      expect(active.map((a) => a.lane).sort()).toEqual(["A", "B", "C"]);
    } finally {
      cleanup();
    }
  });

  it("excludes released + expired", () => {
    const { ledger, cleanup } = makeLedger();
    try {
      claimLane(
        { lane: "A", ant: "cajal", intent: "a", scope_hash: "1", ttl_seconds: 60, now: () => new Date("2026-06-02T20:00:00Z") },
        ledger,
      );
      claimLane(
        { lane: "B", ant: "miles", intent: "b", scope_hash: "2", ttl_seconds: 600, now: () => new Date("2026-06-02T20:00:00Z") },
        ledger,
      );
      releaseLane({ lane: "B", ant: "miles", now: () => new Date("2026-06-02T20:01:00Z") }, ledger);
      // 2 minutes after start: A is expired, B is released
      const active = listActiveClaims(ledger, new Date("2026-06-02T20:02:00Z"));
      expect(active.length).toBe(0);
    } finally {
      cleanup();
    }
  });
});

describe("ledger durability", () => {
  it("persists claims across ledger instances", () => {
    const { ledger, cleanup } = makeLedger();
    try {
      const fixedNow = () => new Date("2026-06-02T20:00:00Z");
      claimLane({ lane: "L1", ant: "cajal", intent: "x", scope_hash: "h", ttl_seconds: 3600, now: fixedNow }, ledger);
      // new ledger instance reading same file
      const ledger2 = new ClaimLedger((ledger as unknown as { path: string }).path);
      expect(ledger2.activeHolder("L1", fixedNow())?.ant).toBe("cajal");
    } finally {
      cleanup();
    }
  });
});
