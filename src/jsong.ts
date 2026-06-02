// JSONG — the substrate's binary tick-log, ported pure-TS + zero-dep from the
// Python reference (sim-in-a-box/sib/jsong.py). Telemetry, NOT genome: a JSONG file
// is referenced by the ledger via its sha256, never imported into the canonical_form
// contract. Fixed little-endian layout: 48-byte file header + N × 280-byte records.
//
// Python struct formats (the source of truth this port reproduces byte-for-byte):
//   header: "<4sHH16s16sQ"   magic, version, reserved, gig_id, agent_id, start_us
//   tick:   "<II HH I 59f d 20s"  tick_idx, delta_us, role, reserved, flags, state_59, score, slug

export const MAGIC = new Uint8Array([0x6a, 0x53, 0x4e, 0x47]); // b"jSNG"
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
  slug: string; // ≤ 20 bytes UTF-8, null-padded on the wire
}

function fitBytes(src: Uint8Array, n: number): Uint8Array {
  // left-justified, null-padded/truncated to exactly n bytes (Python "<16s"/"<20s")
  const out = new Uint8Array(n);
  out.set(src.subarray(0, n));
  return out;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

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
  return {
    version: dv.getUint16(4, true),
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
  const buf = new Uint8Array(TICK_RECORD_SIZE);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, rec.tick_idx, true);
  dv.setUint32(4, rec.delta_us, true);
  dv.setUint16(8, rec.role, true);
  dv.setUint16(10, 0, true); // reserved
  dv.setUint32(12, rec.flags, true);
  for (let i = 0; i < STATE_DIM; i++) dv.setFloat32(16 + i * 4, rec.state_59[i]!, true);
  dv.setFloat64(252, rec.score, true);
  buf.set(fitBytes(enc.encode(rec.slug), SLUG_SIZE), 260);
  return buf;
}

export function unpackTick(buf: Uint8Array): TickRecord {
  if (buf.length < TICK_RECORD_SIZE) throw new JsongError(`tick truncated: ${buf.length} < ${TICK_RECORD_SIZE}`);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const role = dv.getUint16(8, true);
  if (role !== ROLE_OBSERVATION && role !== ROLE_SPEC && role !== ROLE_VERDICT) throw new JsongError(`invalid role ${role}`);
  const state_59: number[] = new Array(STATE_DIM);
  for (let i = 0; i < STATE_DIM; i++) state_59[i] = dv.getFloat32(16 + i * 4, true);
  const slugBytes = buf.slice(260, 280);
  let end = slugBytes.length;
  while (end > 0 && slugBytes[end - 1] === 0) end--; // strip null padding
  return {
    tick_idx: dv.getUint32(0, true),
    delta_us: dv.getUint32(4, true),
    role,
    flags: dv.getUint32(12, true),
    state_59,
    score: dv.getFloat64(252, true),
    slug: dec.decode(slugBytes.subarray(0, end)),
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
