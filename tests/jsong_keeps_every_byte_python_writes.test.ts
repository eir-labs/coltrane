// JSONG KEEPS EVERY BYTE PYTHON WRITES — a file sib/jsong.py writes comes back from readAll → writeAll byte for byte, and a file
// Python refuses, this module refuses.
//
// THE GAP. conformance room-stream-jsong JS-1 (law at 38c3728) drives this module against sib/jsong.py over the whole byte space Python
// accepts, and 6 of 6 Python-written files came back changed. Three causes, each a byte the port lost and Python keeps:
//   - the slug is bytes in Python (bytes20, trailing NULs stripped); the port decoded it as UTF-8, so a slug that is not UTF-8 was
//     rewritten as U+FFFD; and on write it truncated an over-long slug silently, possibly mid-character, where Python refuses;
//   - state_59 and score are wire bits; a JS number cannot hold a signalling NaN's payload (V8 quiets it through getFloat32 and
//     getFloat64), so a NaN came back quieted;
//   - Python refuses any version but 0; the port read anything.
// The spec is conformance's plant/jsong.ts. Eugene, 19 Oct 2026 (relayed by Vör): "stack fixes and ship local tarball so it doesn't
// block IMPL of this."
//
// J1  a slug that is not UTF-8 comes back as its bytes, and the file re-emits byte for byte
// J2  a signalling NaN in state_59 keeps its payload through readAll → writeAll
// J3  a signalling NaN in score keeps its payload likewise
// J4  a value changed after the read is written as the new value, never the stale wire bits
// J5  a file of version 1 is refused on read, by name
// J6  a slug over 20 bytes is refused on write, never truncated
import { describe, it, expect } from "vitest";
import { readAll, writeAll, emptyState, JsongError, FILE_HEADER_SIZE, ROLE_SPEC, FLAG_MUSICAL, type FileHeader, type TickRecord } from "../src/jsong.js";

const header = (): FileHeader => ({ version: 0, gig_id: new Uint8Array(16).fill(0x11), agent_id: new Uint8Array(16).fill(0x22), start_us: 1_760_000_000_000_000n });
const tick = (over: Partial<TickRecord> = {}): TickRecord => ({ tick_idx: 1, delta_us: 1000, role: ROLE_SPEC, flags: FLAG_MUSICAL, state_59: emptyState(), score: 0.25, slug: "vor", ...over });
const file = () => writeAll(header(), [tick()]);
// offsets in the one-tick file: tick at 48; state_59 at +16 (59 × f32), score at +252 (f64), slug at +260 (20 bytes)
const STATE = FILE_HEADER_SIZE + 16, SCORE = FILE_HEADER_SIZE + 252, SLUG = FILE_HEADER_SIZE + 260;
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

describe("JSONG keeps every byte Python writes", () => {
  it("J1 — a slug that is not UTF-8 comes back as its bytes, and the file re-emits byte for byte", () => {
    const bytes = file();
    bytes.set([0xff, 0xfe, 0x80, 0x41], SLUG);   // no UTF-8 decoder keeps these
    const { header: h, ticks } = readAll(bytes);
    const slug: unknown = ticks[0]!.slug;   // the bytes as read, whichever type the module hands back
    expect(hex(slug instanceof Uint8Array ? slug : new TextEncoder().encode(String(slug)))).toBe("fffe8041");
    expect(hex(writeAll(h, ticks))).toBe(hex(bytes));
  });

  it("J2 — a signalling NaN in state_59 keeps its payload through readAll → writeAll", () => {
    const bytes = file();
    new DataView(bytes.buffer).setUint32(STATE + 4 * 10, 0x7f800001, true);   // f32 sNaN, payload 1
    const { header: h, ticks } = readAll(bytes);
    expect(hex(writeAll(h, ticks).subarray(STATE + 40, STATE + 44))).toBe("0100807f");
  });

  it("J3 — a signalling NaN in score keeps its payload likewise", () => {
    const bytes = file();
    new DataView(bytes.buffer).setBigUint64(SCORE, 0x7ff0000000000001n, true);   // f64 sNaN, payload 1
    const { header: h, ticks } = readAll(bytes);
    expect(hex(writeAll(h, ticks).subarray(SCORE, SCORE + 8))).toBe("010000000000f07f");
  });

  it("J4 — a value changed after the read is written as the new value, never the stale wire bits", () => {
    const { header: h, ticks } = readAll(file());
    const t = ticks[0]!; (t.state_59 as number[])[3] = 2.5; t.score = -1;
    const back = readAll(writeAll(h, [t])).ticks[0]!;
    expect(back.state_59[3]).toBe(2.5);
    expect(back.score).toBe(-1);
  });

  it("J5 — a file of version 1 is refused on read, by name", () => {
    const bytes = file();
    new DataView(bytes.buffer).setUint16(4, 1, true);
    expect(() => readAll(bytes)).toThrow(JsongError);
    expect(() => readAll(bytes)).toThrow(/unsupported version 1/);
  });

  it("J6 — a slug over 20 bytes is refused on write, never truncated", () => {
    expect(() => writeAll(header(), [tick({ slug: "á".repeat(11) })])).toThrow(/slug too long \(22 > 20 bytes\)/);
  });
});
