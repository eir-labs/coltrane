// snapshot.test.ts — pluggable snapshot modes over chain windows.
// Same-shape windows → identical fingerprints + zero distance. Different
// shapes → different fingerprints + positive distance. Mode-mismatch on
// distance throws. Registry rejects collisions and surfaces unknowns.

import { describe, it, expect } from "vitest";
import { chainEvent, AuditEvent } from "../src/audit_chain.js";
import {
  cognitiveShapeV0,
  getMode,
  listModes,
  registerMode,
  snapshot,
  type Snapshot,
  type Snapshotter,
} from "../src/snapshot.js";

function makeEvent(
  prev: AuditEvent | null,
  ts: string,
  kind: AuditEvent["kind"],
  surface: AuditEvent["surface"],
  primitive: AuditEvent["primitive"] = null,
): AuditEvent {
  return chainEvent(prev, {
    session_uuid: "test-session",
    ts,
    surface,
    kind,
    primitive,
    payload: { note: kind },
  });
}

function buildWindow(
  spec: ReadonlyArray<{
    kind: AuditEvent["kind"];
    surface: AuditEvent["surface"];
    primitive?: AuditEvent["primitive"];
  }>,
): AuditEvent[] {
  const out: AuditEvent[] = [];
  let prev: AuditEvent | null = null;
  spec.forEach((s, i) => {
    const ts = `2026-06-04T14:${String(40 + i).padStart(2, "0")}:00Z`;
    const e = makeEvent(prev, ts, s.kind, s.surface, s.primitive ?? null);
    out.push(e);
    prev = e;
  });
  return out;
}

describe("cognitiveShapeV0", () => {
  it("counts events and tallies kind/surface/primitive distributions", () => {
    const events = buildWindow([
      { kind: "react", surface: "hands" },
      { kind: "post", surface: "hands", primitive: "CREATE" },
      { kind: "post", surface: "head", primitive: "INTERPRET" },
      { kind: "verdict", surface: "head", primitive: "JUDGE" },
    ]);

    const snap = cognitiveShapeV0.snapshot(events);
    const stats = snap.stats as {
      node_count: number;
      kind_dist: Record<string, number>;
      surface_dist: Record<string, number>;
      primitive_dist: Record<string, number>;
      ts_span: { start: string; end: string };
    };

    expect(snap.mode).toBe("cognitive-shape-v0");
    expect(snap.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(stats.node_count).toBe(4);
    expect(stats.kind_dist).toEqual({ react: 1, post: 2, verdict: 1 });
    expect(stats.surface_dist).toEqual({ hands: 2, head: 2 });
    expect(stats.primitive_dist).toEqual({ CREATE: 1, INTERPRET: 1, JUDGE: 1 });
    expect(stats.ts_span).toEqual({
      start: "2026-06-04T14:40:00Z",
      end: "2026-06-04T14:43:00Z",
    });
  });

  it("is deterministic — same window → same fingerprint", () => {
    const spec = [
      { kind: "react" as const, surface: "hands" as const },
      { kind: "tool_call" as const, surface: "head" as const, primitive: "SENSE" as const },
    ];
    const a = cognitiveShapeV0.snapshot(buildWindow(spec));
    const b = cognitiveShapeV0.snapshot(buildWindow(spec));
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.stats).toEqual(b.stats);
  });

  it("returns null ts_span on empty window", () => {
    const snap = cognitiveShapeV0.snapshot([]);
    const stats = snap.stats as { node_count: number; ts_span: unknown };
    expect(stats.node_count).toBe(0);
    expect(stats.ts_span).toBeNull();
  });

  it("zero distance when distributions match exactly", () => {
    const spec = [
      { kind: "react" as const, surface: "hands" as const, primitive: "SENSE" as const },
      { kind: "post" as const, surface: "head" as const, primitive: "CREATE" as const },
    ];
    const a = cognitiveShapeV0.snapshot(buildWindow(spec));
    const b = cognitiveShapeV0.snapshot(buildWindow(spec));
    expect(cognitiveShapeV0.distance(a, b)).toBe(0);
  });

  it("positive distance scales with the L1 of distribution differences", () => {
    // Window A: 2 react/hands, 0 verdicts.
    const a = cognitiveShapeV0.snapshot(
      buildWindow([
        { kind: "react", surface: "hands" },
        { kind: "react", surface: "hands" },
      ]),
    );
    // Window B: 0 react, 2 verdict/head with JUDGE.
    const b = cognitiveShapeV0.snapshot(
      buildWindow([
        { kind: "verdict", surface: "head", primitive: "JUDGE" },
        { kind: "verdict", surface: "head", primitive: "JUDGE" },
      ]),
    );
    // L1 split: kind 2+2 = 4, surface 2+2 = 4, primitive 0+2 = 2. Total 10.
    expect(cognitiveShapeV0.distance(a, b)).toBe(10);
  });

  it("similarity ordering: closer windows get smaller distances", () => {
    const baseline = cognitiveShapeV0.snapshot(
      buildWindow([
        { kind: "react", surface: "hands" },
        { kind: "react", surface: "hands" },
        { kind: "post", surface: "head", primitive: "CREATE" },
      ]),
    );
    const near = cognitiveShapeV0.snapshot(
      buildWindow([
        { kind: "react", surface: "hands" },
        { kind: "post", surface: "hands" },
        { kind: "post", surface: "head", primitive: "CREATE" },
      ]),
    );
    const far = cognitiveShapeV0.snapshot(
      buildWindow([
        { kind: "verdict", surface: "head", primitive: "JUDGE" },
        { kind: "verdict", surface: "head", primitive: "JUDGE" },
        { kind: "verdict", surface: "head", primitive: "JUDGE" },
      ]),
    );
    expect(cognitiveShapeV0.distance(baseline, near)).toBeLessThan(
      cognitiveShapeV0.distance(baseline, far),
    );
  });

  it("rejects cross-mode distance — defined within a mode only", () => {
    const a = cognitiveShapeV0.snapshot(buildWindow([{ kind: "react", surface: "hands" }]));
    const stranger: Snapshot = { mode: "psi-v0", fingerprint: "x", stats: {} };
    expect(() => cognitiveShapeV0.distance(a, stranger)).toThrow(/cognitive-shape-v0/);
  });
});

describe("snapshot mode registry", () => {
  it("lists the OSS default mode out of the box", () => {
    const modes = listModes();
    expect(modes).toContain("cognitive-shape-v0");
  });

  it("getMode returns the registered snapshotter", () => {
    const m = getMode("cognitive-shape-v0");
    expect(m.mode).toBe("cognitive-shape-v0");
  });

  it("unknown mode throws with the available list in the message", () => {
    expect(() => getMode("does-not-exist")).toThrow(/does-not-exist/);
    expect(() => getMode("does-not-exist")).toThrow(/cognitive-shape-v0/);
  });

  it("registerMode attaches a new mode and rejects collisions", () => {
    const stub: Snapshotter = {
      mode: "test-stub-v0",
      snapshot: () => ({ mode: "test-stub-v0", fingerprint: "stub", stats: {} }),
      distance: () => 0,
    };
    registerMode(stub);
    expect(listModes()).toContain("test-stub-v0");
    expect(getMode("test-stub-v0")).toBe(stub);
    expect(() => registerMode(stub)).toThrow(/already registered/);
  });
});

describe("snapshot convenience wrapper", () => {
  it("uses the OSS default mode when no mode is specified", () => {
    const events = buildWindow([
      { kind: "react", surface: "hands" },
      { kind: "post", surface: "head", primitive: "CREATE" },
    ]);
    const snap = snapshot(events);
    expect(snap.mode).toBe("cognitive-shape-v0");
    expect(snap.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches an explicit cognitiveShapeV0.snapshot call exactly", () => {
    const events = buildWindow([
      { kind: "tool_call", surface: "hands", primitive: "PLAN" },
      { kind: "verdict", surface: "head", primitive: "VERIFY" },
    ]);
    const a = snapshot(events);
    const b = cognitiveShapeV0.snapshot(events);
    expect(a).toEqual(b);
  });
});
