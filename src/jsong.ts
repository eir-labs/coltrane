// JSONG — the substrate's binary tick-log, ported pure-TS + zero-dep from the
// Python reference (sim-in-a-box/sib/jsong.py). Telemetry, NOT genome: a JSONG file
// is referenced by the ledger via its sha256, never imported into the canonical_form
// contract. Fixed little-endian layout: 48-byte file header + N × 280-byte records.
//
// Every byte Python writes comes back: the slug is BYTES (Python's bytes20), state_59 and score keep their WIRE BITS (a JS number
// cannot hold a signalling NaN's payload, so a read keeps the bytes and a write emits them while the value is unchanged), and any
// version but 0 is refused, as Python refuses it (conformance room-stream-jsong JS-1).
//
// Python struct formats (the source of truth this port reproduces byte-for-byte):
//   header: "<4sHH16s16sQ"   magic, version, reserved, gig_id, agent_id, start_us
//   tick:   "<II HH I 59f d 20s"  tick_idx, delta_us, role, reserved, flags, state_59, score, slug

export const MAGIC = new Uint8Array([0x6a, 0x53, 0x4e, 0x47]); // b"jSNG"
export const VERSION = 0; // the only version Python reads or writes
export const FILE_HEADER_SIZE = 48;
export const TICK_RECORD_SIZE = 280;
export const STATE_DIM = 59;
export const SLUG_SIZE = 20;

export const ROLE_OBSERVATION = 0;
export const ROLE_SPEC = 1;
export const ROLE_VERDICT = 2;

export const FLAG_MUSICAL = 1 << 0;
export const FLAG_ANOMALY = 1 << 1;
export const FLAG_BOUNDARY = 1 << 2;
export const FLAG_CLAIM_NUMERIC = 1 << 3;
export const FLAG_CLAIM_STRING = 1 << 4;
export const FLAG_CLAIM_IMPORT_REQUIRED = 1 << 5;
export const FLAG_CLAIM_IMPORT_FORBIDDEN = 1 << 6;
export const FLAG_CLAIM_NO_CYCLES = 1 << 7;
export const FLAG_BAND_PROFILE = 1 << 8;

export class JsongError extends Error {}

export interface FileHeader {
  version: number;
  gig_id: Uint8Array; // 16 bytes
  agent_id: Uint8Array; // 16 bytes
  start_us: bigint; // uint64 — UTC µs since epoch
}

export interface TickRecord {
  tick_idx: number;
  delta_us: number;
  role: number; // 0 observation | 1 spec | 2 verdict
  flags: number;
  state_59: number[]; // exactly 59 float32 values, canonical order
  score: number; // float64 coherence C = R − E²
  slug: string | Uint8Array; // ≤ 20 bytes, null-padded on the wire; read back as its bytes (a string is UTF-8 encoded on write)
  /** the wire bytes of state_59 and score as read; written back while the values still decode to them */
  wire?: { state: Uint8Array; score: Uint8Array };
}

function fitBytes(src: Uint8Array, n: number): Uint8Array {
  // left-justified, null-padded/truncated to exactly n bytes (Python "<16s"/"<20s")
  const out = new Uint8Array(n);
  out.set(src.subarray(0, n));
  return out;
}

const enc = new TextEncoder();
// the same value, NaN for NaN (a NaN's payload is the wire's to keep, not the number's)
const same = (a: number, b: number) => Object.is(a, b) || (Number.isNaN(a) && Number.isNaN(b));

export function packHeader(h: FileHeader): Uint8Array {
  const buf = new Uint8Array(FILE_HEADER_SIZE);
  const dv = new DataView(buf.buffer);
  buf.set(MAGIC, 0);
  dv.setUint16(4, h.version, true);
  dv.setUint16(6, 0, true); // reserved
  buf.set(fitBytes(h.gig_id, 16), 8);
  buf.set(fitBytes(h.agent_id, 16), 24);
  dv.setBigUint64(40, h.start_us, true);
  return buf;
}

export function unpackHeader(buf: Uint8Array): FileHeader {
  if (buf.length < FILE_HEADER_SIZE) throw new JsongError(`header truncated: ${buf.length} < ${FILE_HEADER_SIZE}`);
  for (let i = 0; i < 4; i++) {
    if (buf[i] !== MAGIC[i]) throw new JsongError("bad magic (expected jSNG)");
  }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const version = dv.getUint16(4, true);
  if (version !== VERSION) throw new JsongError(`unsupported version ${version} (reader supports ${VERSION})`);
  return {
    version,
    gig_id: buf.slice(8, 24),
    agent_id: buf.slice(24, 40),
    start_us: dv.getBigUint64(40, true),
  };
}

export function packTick(rec: TickRecord): Uint8Array {
  if (rec.state_59.length !== STATE_DIM) throw new JsongError(`state_59 must be ${STATE_DIM} floats, got ${rec.state_59.length}`);
  if (rec.role !== ROLE_OBSERVATION && rec.role !== ROLE_SPEC && rec.role !== ROLE_VERDICT) {
    throw new JsongError(`invalid role ${rec.role}`);
  }
  const slug = typeof rec.slug === "string" ? enc.encode(rec.slug) : rec.slug;
  if (slug.length > SLUG_SIZE) throw new JsongError(`slug too long (${slug.length} > ${SLUG_SIZE} bytes)`); // Python refuses; never truncate
  const buf = new Uint8Array(TICK_RECORD_SIZE);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, rec.tick_idx, true);
  dv.setUint32(4, rec.delta_us, true);
  dv.setUint16(8, rec.role, true);
  dv.setUint16(10, 0, true); // reserved
  dv.setUint32(12, rec.flags, true);
  const w = rec.wire, wv = w ? new DataView(w.state.buffer, w.state.byteOffset, w.state.byteLength) : null;
  for (let i = 0; i < STATE_DIM; i++) {
    const v = rec.state_59[i]!;
    if (wv && same(wv.getFloat32(i * 4, true), Math.fround(v))) buf.set(w!.state.subarray(i * 4, i * 4 + 4), 16 + i * 4);
    else dv.setFloat32(16 + i * 4, v, true);
  }
  if (w && same(new DataView(w.score.buffer, w.score.byteOffset, 8).getFloat64(0, true), rec.score)) buf.set(w.score, 252);
  else dv.setFloat64(252, rec.score, true);
  buf.set(fitBytes(slug, SLUG_SIZE), 260);
  return buf;
}

export function unpackTick(buf: Uint8Array): TickRecord {
  if (buf.length < TICK_RECORD_SIZE) throw new JsongError(`tick truncated: ${buf.length} < ${TICK_RECORD_SIZE}`);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const role = dv.getUint16(8, true);
  if (role !== ROLE_OBSERVATION && role !== ROLE_SPEC && role !== ROLE_VERDICT) throw new JsongError(`invalid role ${role}`);
  const state_59: number[] = new Array(STATE_DIM);
  for (let i = 0; i < STATE_DIM; i++) state_59[i] = dv.getFloat32(16 + i * 4, true);
  let end = SLUG_SIZE;
  while (end > 0 && buf[260 + end - 1] === 0) end--; // strip null padding, as Python's rstrip(b"\\0")
  return {
    tick_idx: dv.getUint32(0, true),
    delta_us: dv.getUint32(4, true),
    role,
    flags: dv.getUint32(12, true),
    state_59,
    score: dv.getFloat64(252, true),
    slug: buf.slice(260, 260 + end),
    wire: { state: buf.slice(16, 252), score: buf.slice(252, 260) },
  };
}

/** Decode a whole JSONG buffer (header + N ticks). Mirrors Python read_all. */
export function readAll(data: Uint8Array): { header: FileHeader; ticks: TickRecord[] } {
  if (data.length < FILE_HEADER_SIZE) throw new JsongError(`file truncated: ${data.length} < ${FILE_HEADER_SIZE}`);
  const header = unpackHeader(data.subarray(0, FILE_HEADER_SIZE));
  const body = data.subarray(FILE_HEADER_SIZE);
  if (body.length % TICK_RECORD_SIZE !== 0) throw new JsongError(`body size ${body.length} not a multiple of ${TICK_RECORD_SIZE}`);
  const ticks: TickRecord[] = [];
  for (let off = 0; off < body.length; off += TICK_RECORD_SIZE) {
    ticks.push(unpackTick(body.subarray(off, off + TICK_RECORD_SIZE)));
  }
  return { header, ticks };
}

/** Encode a header + ticks into a single JSONG buffer. */
export function writeAll(header: FileHeader, ticks: readonly TickRecord[]): Uint8Array {
  const out = new Uint8Array(FILE_HEADER_SIZE + ticks.length * TICK_RECORD_SIZE);
  out.set(packHeader(header), 0);
  ticks.forEach((t, i) => out.set(packTick(t), FILE_HEADER_SIZE + i * TICK_RECORD_SIZE));
  return out;
}

/** A zero-valued 59-float state vector (Python empty_state). */
export function emptyState(): number[] {
  return new Array(STATE_DIM).fill(0);
}
