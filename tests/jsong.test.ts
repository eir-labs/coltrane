// O16 — JSONG pure-TS port conformance. The counter-claim that matters:
// byte-for-byte agreement with the Python reference impl (sim-in-a-box/sib/jsong.py).
// The two golden hex vectors below were emitted by the Python `pack_header` /
// `pack_tick` from fixed inputs; if this TS port produces different bytes, the
// cross-language format has forked — exactly what JSONG's fixed layout exists
// to prevent.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  packHeader, unpackHeader, packTick, unpackTick, readAll, writeAll, emptyState,
  JsongError, MAGIC, FILE_HEADER_SIZE, TICK_RECORD_SIZE, STATE_DIM,
  FLAG_MUSICAL, FLAG_BAND_PROFILE, ROLE_SPEC,
  type FileHeader, type TickRecord,
} from "../src/jsong.js";

const toHex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");

// === the golden vectors — read from a fixture written DIRECTLY by the Python
// reference impl (tests/fixtures/jsong_golden.json), so the cross-language contract
// is reproducible and free of hand-transcription error. ===
const golden = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/jsong_golden.json", import.meta.url)), "utf-8"),
) as { header_hex: string; tick_hex: string };
const HEADER_HEX = golden.header_hex;
const TICK_HEX = golden.tick_hex;

// the fixed inputs that produced those golden bytes
function goldenHeader(): FileHeader {
  return {
    version: 0,
    gig_id: new Uint8Array(Array.from({ length: 16 }, (_, i) => i)),
    agent_id: new Uint8Array(Array.from({ length: 16 }, (_, i) => i + 16)),
    start_us: 1779791700000000n,
  };
}
function goldenTick(): TickRecord {
  const s = emptyState();
  s[0] = 1.5; s[1] = 2.25; s[4] = 0.75; s[10] = 3.125; s[58] = -1.0;
  return { tick_idx: 7, delta_us: 12345, role: ROLE_SPEC, flags: FLAG_MUSICAL | FLAG_BAND_PROFILE, state_59: s, score: 0.5, slug: "verse-1" };
}

describe("JSONG: fixed layout", () => {
  it("magic is jSNG and sizes are 48 / 280", () => {
    expect(toHex(MAGIC)).toBe("6a534e47");
    expect(FILE_HEADER_SIZE).toBe(48);
    expect(TICK_RECORD_SIZE).toBe(280);
    expect(STATE_DIM).toBe(59);
  });
});

describe("JSONG: byte-for-byte conformance with the Python reference (O16)", () => {
  it("packHeader reproduces the golden header bytes exactly", () => {
    const b = packHeader(goldenHeader());
    expect(b.length).toBe(FILE_HEADER_SIZE);
    expect(toHex(b)).toBe(HEADER_HEX);
  });

  it("packTick reproduces the golden tick bytes exactly", () => {
    const b = packTick(goldenTick());
    expect(b.length).toBe(TICK_RECORD_SIZE);
    expect(toHex(b)).toBe(TICK_HEX);
  });

  it("unpacks the golden bytes back to the known values", () => {
    const fromHex = (h: string) => new Uint8Array((h.match(/../g) ?? []).map((x) => parseInt(x, 16)));
    const h = unpackHeader(fromHex(HEADER_HEX));
    expect(h.version).toBe(0);
    expect(Array.from(h.gig_id)).toEqual(Array.from({ length: 16 }, (_, i) => i));
    expect(h.start_us).toBe(1779791700000000n);
    const t = unpackTick(fromHex(TICK_HEX));
    expect(t.tick_idx).toBe(7);
    expect(t.delta_us).toBe(12345);
    expect(t.role).toBe(ROLE_SPEC);
    expect(t.flags).toBe(FLAG_MUSICAL | FLAG_BAND_PROFILE);
    expect(t.state_59[0]).toBe(1.5);
    expect(t.state_59[10]).toBe(3.125);
    expect(t.state_59[58]).toBe(-1.0);
    expect(t.score).toBe(0.5);
    expect(t.slug).toBe("verse-1");
  });
});

describe("JSONG: round-trip + multi-tick file", () => {
  it("pack→unpack is identity for header and tick", () => {
    expect(unpackHeader(packHeader(goldenHeader())).start_us).toBe(1779791700000000n);
    const t = unpackTick(packTick(goldenTick()));
    expect(t).toEqual(goldenTick());
  });

  it("writeAll → readAll preserves header + every tick in order", () => {
    const ticks = [goldenTick(), { ...goldenTick(), tick_idx: 8, slug: "chorus" }];
    const { header, ticks: out } = readAll(writeAll(goldenHeader(), ticks));
    expect(header.start_us).toBe(1779791700000000n);
    expect(out.length).toBe(2);
    expect(out[1]!.tick_idx).toBe(8);
    expect(out[1]!.slug).toBe("chorus");
  });
});

describe("JSONG: malformed input is rejected, never silently accepted", () => {
  it("rejects bad magic", () => {
    const b = packHeader(goldenHeader());
    b[0] = 0x00;
    expect(() => unpackHeader(b)).toThrow(JsongError);
  });
  it("rejects a wrong-length state vector", () => {
    expect(() => packTick({ ...goldenTick(), state_59: [1, 2, 3] })).toThrow(JsongError);
  });
  it("rejects an invalid role", () => {
    expect(() => packTick({ ...goldenTick(), role: 9 })).toThrow(JsongError);
  });
  it("rejects a body that is not a whole number of records", () => {
    const bad = new Uint8Array(FILE_HEADER_SIZE + 10);
    bad.set(packHeader(goldenHeader()), 0);
    expect(() => readAll(bad)).toThrow(JsongError);
  });
});
