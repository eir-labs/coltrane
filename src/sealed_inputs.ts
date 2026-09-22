// spec.coltrane-sealed-inputs — a dispatch names SEALED OUTPUTS as inputs instead of copying their data.
//
//   { "<type>": { "$output": "<id | content_sha>" } }                      one record
//   { "<type>": [ { "$output": … }, … ] }                                  several
//   { "<type>": { "$query": { "type": "<type>", "where"?: {…}, "latest_by"?: "<data path>" } } }
//
// Resolution happens in runGig, before any chair runs, so every door that reaches runGig — the CLI,
// the MCP gig_dispatch, the queue worker, a chart movement — gets the same resolution and the same
// refusals. Nothing here trusts the caller: every record is looked up in the store, RE-HASHED against
// its own content_sha, and checked against the type it is offered as. A reference that cannot be
// proved refuses the whole dispatch; it never degrades into "the chair got the marker as data".
import type { OutputRecord, OutputStore, InputResolution } from "./outputs.js";
import { outputContentHash } from "./canonical_form.js";

/** A dispatch that named a sealed input the engine could not prove. Thrown before any chair runs. */
export class SealedInputRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SealedInputRefused";
  }
}

/** One record delivered as a gig input, with the resolution the engine stamps on what consumes it. */
export interface ResolvedInput {
  record: OutputRecord;
  resolution: InputResolution;
}

export interface SealedInputResolution {
  /** The payload with every marker-valued key removed — what chairs see as `gig_input`. */
  gigInput: Record<string, unknown>;
  /** Declared input type → the records resolved for it, each individually, in resolution order. */
  byType: ReadonlyMap<string, readonly ResolvedInput[]>;
}

type Marker = { $output: string } | { $query: Record<string, unknown> };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function asMarker(v: unknown): Marker | undefined {
  if (!isRecord(v)) return undefined;
  const keys = Object.keys(v);
  if (keys.length !== 1) return undefined;
  if (keys[0] === "$output") return { $output: v["$output"] as string };
  if (keys[0] === "$query") return { $query: v["$query"] as Record<string, unknown> };
  return undefined;
}

/** The markers a payload value holds: a single marker, or an array made ONLY of markers. Anything
 *  else is ordinary data and is left alone. A mixed array is refused — half-references are neither. */
function markersOf(key: string, v: unknown): Marker[] | undefined {
  const one = asMarker(v);
  if (one) return [one];
  if (!Array.isArray(v) || v.length === 0) return undefined;
  const ms = v.map(asMarker);
  const n = ms.filter(Boolean).length;
  if (n === 0) return undefined;
  if (n !== v.length) {
    throw new SealedInputRefused(
      `gig input "${key}" mixes sealed-output references with plain data — a value is either data or ` +
        `references to sealed records, never both`,
    );
  }
  return ms as Marker[];
}

/** Read a dotted path out of a record's data. */
function pathGet(data: unknown, path: string): unknown {
  let cur: unknown = data;
  for (const seg of path.split(".")) {
    if (!isRecord(cur)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

/** The content_sha the record's bytes produce NOW. A held record whose bytes changed after sealing
 *  no longer hashes to its own `content_sha`, and is refused. */
function rehash(r: OutputRecord): string {
  return outputContentHash({
    core_type: r.core_type,
    domain_type: r.domain_type,
    domain_type_version: r.domain_type_version,
    domain: r.domain,
    primitive: r.primitive,
    phase: r.phase,
    agent_slug: r.agent_slug,
    data: r.data,
  });
}

/**
 * Resolve every sealed-output reference in a dispatch payload, or refuse.
 *
 * `declared` is the standard's gig contract (`input_types`): a reference under a key the standard
 * does not declare could reach no chair, and is refused rather than quietly dropped. `satisfies` is
 * the runtime's own type rule (`outputSatisfiesType`), passed in so there is exactly one.
 */
export function resolveSealedInputs(
  payload: Record<string, unknown>,
  opts: {
    outputs: OutputStore;
    declared: ReadonlySet<string>;
    satisfies: (rec: OutputRecord, type: string) => boolean;
    now?: () => string;
  },
): SealedInputResolution {
  const now = opts.now ?? (() => new Date().toISOString());
  const gigInput: Record<string, unknown> = {};
  const byType = new Map<string, ResolvedInput[]>();
  let all: readonly OutputRecord[] | undefined;
  const store = (): readonly OutputRecord[] => (all ??= opts.outputs.all());

  const admit = (key: string, rec: OutputRecord, resolution: InputResolution, into: ResolvedInput[]): void => {
    if (!opts.satisfies(rec, key)) {
      throw new SealedInputRefused(
        `gig input "${key}" names sealed output ${rec.id}, whose type is "${rec.domain_type}" — ` +
          `it does not satisfy the declared input "${key}"`,
      );
    }
    const now_sha = rehash(rec);
    if (now_sha !== rec.content_sha) {
      throw new SealedInputRefused(
        `gig input "${key}" names sealed output ${rec.id}, whose bytes no longer hash to its content_sha ` +
          `(${rec.content_sha} sealed, ${now_sha} now) — refusing a record that is not what was sealed`,
      );
    }
    if (into.some((x) => x.record.id === rec.id)) return; // named twice → delivered once
    into.push({ record: rec, resolution });
  };

  for (const [key, value] of Object.entries(payload)) {
    const markers = markersOf(key, value);
    if (!markers) {
      gigInput[key] = value;
      continue;
    }
    if (!opts.declared.has(key)) {
      throw new SealedInputRefused(
        `gig input "${key}" names sealed outputs, but the standard does not declare "${key}" as an input — ` +
          `no chair could receive them`,
      );
    }
    const into: ResolvedInput[] = [];
    for (const m of markers) {
      if ("$output" in m) {
        const ref = m.$output;
        if (typeof ref !== "string" || ref === "") {
          throw new SealedInputRefused(`gig input "${key}": "$output" must name a sealed output id or content_sha`);
        }
        const rec = opts.outputs.get(ref) ?? store().find((r) => r.content_sha === ref);
        if (!rec) {
          throw new SealedInputRefused(`gig input "${key}" names "${ref}", which is no sealed output in this store`);
        }
        admit(key, rec, { output_id: rec.id, content_sha: rec.content_sha, from_gig: rec.gig_id, resolved_at: now(), resolved_by: "dispatch" }, into);
        continue;
      }
      const q = m.$query;
      if (!isRecord(q) || typeof q["type"] !== "string") {
        throw new SealedInputRefused(`gig input "${key}": "$query" must be an object naming a "type"`);
      }
      const qtype = q["type"] as string;
      const where = isRecord(q["where"]) ? (q["where"] as Record<string, unknown>) : {};
      const latestBy = typeof q["latest_by"] === "string" ? (q["latest_by"] as string) : undefined;
      let matches = store().filter(
        (r) => opts.satisfies(r, qtype) && Object.entries(where).every(([p, v]) => pathGet(r.data, p) === v),
      );
      if (latestBy !== undefined) {
        // Newest record per distinct value of the path. `>=` so, on an equal timestamp, the later
        // insertion wins — all() is insertion-ordered.
        const newest = new Map<string, OutputRecord>();
        for (const r of matches) {
          const k = JSON.stringify(pathGet(r.data, latestBy) ?? null);
          const cur = newest.get(k);
          if (!cur || r.created_at >= cur.created_at) newest.set(k, r);
        }
        matches = [...newest.values()];
      }
      if (matches.length === 0) {
        throw new SealedInputRefused(
          `gig input "${key}": query ${JSON.stringify(q)} matched no sealed output — a declared input ` +
            `cannot be satisfied by nothing`,
        );
      }
      for (const rec of matches) {
        admit(key, rec, {
          output_id: rec.id, content_sha: rec.content_sha, from_gig: rec.gig_id,
          resolved_at: now(), resolved_by: "query", query: q,
        }, into);
      }
    }
    byType.set(key, into);
  }
  return { gigInput, byType };
}
