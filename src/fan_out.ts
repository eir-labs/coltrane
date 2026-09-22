// FAN-OUT — one chair template, seated once per item of an input set (ChairSchema.fan_out).
//
// The split is deterministic and the engine's: the instance count and each instance's slice come
// from the data, never from a model. An instance is the template chair under role `<role>#<key>`,
// handed its inputs with the `over` set narrowed to its one item and every `join` set narrowed to
// the items that share a value with it. Nothing new is sealed to do this — the slices are views of
// the whole records, which is what `input_refs`/`input_shas` keep naming — and the seal each
// instance makes carries a ShardStamp saying exactly which part it read (sha of the slice).
//
// Whatever cannot be split unambiguously is refused before any instance runs: no source, two
// sources, a path that is not an array, an empty set, an item with no key, two items with one key.
// A split the engine had to guess at is not a split anyone can later check.
import type { Chair } from "./composition.js";
import type { OutputRecord, ShardStamp } from "./outputs.js";
import { sha256Hex, canonJson } from "./canonical_form.js";

export class FanOutRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FanOutRefused";
  }
}

/** One seat of a fanned-out chair: the instance chair and what it is to be handed. */
export interface FanOutInstance {
  chair: Chair;
  /** Source record id → the narrowed view the instance receives in its place. */
  records: ReadonlyMap<string, OutputRecord>;
  /** Payload type → the narrowed value, for sets that arrived in the gig payload. */
  gig_input: Readonly<Record<string, unknown>>;
  stamp: ShardStamp;
}

/** A join item no instance received — reported, never silently dropped. */
export interface FanOutUnmatched {
  role: string;
  type: string;
  path: string;
  on: string;
  values: unknown[];
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function pathGet(data: unknown, path: string): unknown {
  let cur: unknown = data;
  for (const seg of path.split(".")) {
    if (!isObj(cur)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

/** A copy of `data` with the value at `path` replaced. Only the spine is copied. */
function pathSet(data: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const [head, ...rest] = path.split(".");
  const out = { ...data };
  out[head!] = rest.length === 0 ? value : pathSet(isObj(data[head!]) ? (data[head!] as Record<string, unknown>) : {}, rest.join("."), value);
  return out;
}

const asValues = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);
const shares = (a: unknown[], b: unknown[]): boolean => a.some((x) => b.some((y) => canonJson(x) === canonJson(y)));

type Source =
  | { kind: "record"; record: OutputRecord; data: Record<string, unknown> }
  | { kind: "payload"; data: Record<string, unknown> };

function sourceFor(
  role: string,
  type: string,
  records: readonly OutputRecord[],
  gigInput: Record<string, unknown>,
  satisfies: (rec: OutputRecord, type: string) => boolean,
): Source {
  const recs = records.filter((r) => satisfies(r, type));
  if (recs.length > 1) {
    throw new FanOutRefused(
      `fan-out of chair "${role}": "${type}" has ${recs.length} sources (${recs.map((r) => r.id).join(", ")}) — ` +
        `the engine does not choose which set to split`,
    );
  }
  if (recs.length === 1) return { kind: "record", record: recs[0]!, data: recs[0]!.data };
  const p = gigInput[type];
  if (isObj(p)) return { kind: "payload", data: p };
  throw new FanOutRefused(`fan-out of chair "${role}": no input of type "${type}" reached it — nothing to split`);
}

function arrayAt(role: string, type: string, src: Source, path: string): unknown[] {
  const v = pathGet(src.data, path);
  if (!Array.isArray(v)) {
    throw new FanOutRefused(`fan-out of chair "${role}": "${type}" at "${path}" is not an array`);
  }
  return v;
}

/**
 * Expand a fan-out chair into its instances, or refuse. `records` are the whole records the template
 * chair would receive; `gigInput` the payload it would see.
 */
export function expandFanOut(
  chair: Chair,
  records: readonly OutputRecord[],
  gigInput: Record<string, unknown>,
  satisfies: (rec: OutputRecord, type: string) => boolean,
): { instances: FanOutInstance[]; unmatched: FanOutUnmatched[] } {
  const fan = chair.fan_out;
  if (!fan) throw new FanOutRefused(`chair "${chair.role}" declares no fan_out`);
  const role = chair.role;

  const over = sourceFor(role, fan.over.type, records, gigInput, satisfies);
  const items = arrayAt(role, fan.over.type, over, fan.over.path);
  if (items.length === 0) {
    throw new FanOutRefused(`fan-out of chair "${role}": "${fan.over.type}" at "${fan.over.path}" has no items — a chair seated zero times is not a run`);
  }
  const keys = items.map((it, i) => {
    const k = isObj(it) ? it[fan.over.key] : undefined;
    if (typeof k !== "string" && typeof k !== "number") {
      throw new FanOutRefused(`fan-out of chair "${role}": item ${i} of "${fan.over.path}" has no "${fan.over.key}" (a string or number)`);
    }
    return String(k);
  });
  const dup = keys.find((k, i) => keys.indexOf(k) !== i);
  if (dup !== undefined) {
    throw new FanOutRefused(`fan-out of chair "${role}": duplicate key "${dup}" in "${fan.over.path}" — two seats cannot share a role`);
  }

  const joins = (fan.join ?? []).map((j) => {
    const src = sourceFor(role, j.type, records, gigInput, satisfies);
    return { spec: j, src, items: arrayAt(role, j.type, src, j.path) };
  });

  const unmatchedIdx = joins.map((j) => new Set(j.items.map((_, i) => i)));
  const slice = (type: string, src: Source, path: string, narrowed: unknown[]) => {
    const data = pathSet(src.data, path, narrowed);
    return {
      data,
      entry: {
        type,
        source: src.kind === "record" ? src.record.id : "gig_input",
        ...(src.kind === "record" ? { content_sha: src.record.content_sha } : {}),
        path,
        count: narrowed.length,
        slice_sha: sha256Hex(canonJson(data)),
      },
    };
  };

  const instances: FanOutInstance[] = items.map((item, idx) => {
    const value = keys[idx]!;
    const recs = new Map<string, OutputRecord>();
    const payload: Record<string, unknown> = {};
    const slices: ShardStamp["slices"][number][] = [];
    const place = (type: string, src: Source, data: Record<string, unknown>): void => {
      if (src.kind === "record") recs.set(src.record.id, { ...src.record, data });
      else payload[type] = data;
    };

    const o = slice(fan.over.type, over, fan.over.path, [item]);
    place(fan.over.type, over, o.data);
    slices.push(o.entry);

    joins.forEach((j, ji) => {
      const want = asValues(pathGet(item, j.spec.match));
      const picked: unknown[] = [];
      j.items.forEach((it, i) => {
        if (shares(asValues(pathGet(it, j.spec.on)), want)) {
          picked.push(it);
          unmatchedIdx[ji]!.delete(i);
        }
      });
      const s = slice(j.spec.type, j.src, j.spec.path, picked);
      place(j.spec.type, j.src, s.data);
      slices.push(s.entry);
    });

    const { fan_out: _template, ...rest } = chair;
    void _template;
    return {
      chair: { ...rest, role: `${role}#${value}` },
      records: recs,
      gig_input: payload,
      stamp: { of: role, key: fan.over.key, value, slices },
    };
  });

  const unmatched: FanOutUnmatched[] = joins.flatMap((j, ji) =>
    unmatchedIdx[ji]!.size === 0
      ? []
      : [{
          role, type: j.spec.type, path: j.spec.path, on: j.spec.on,
          values: [...unmatchedIdx[ji]!].map((i) => pathGet(j.items[i], j.spec.on)),
        }],
  );
  return { instances, unmatched };
}
