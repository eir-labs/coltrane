// §6 — the universal output store + output_refs provenance graph + findings view.
// Pure-TS (in-memory by default; optional disk-backed jsonl persistence), ledger.ts
// style. Validation is NOT reimplemented here: write() wires registry.validate() and
// rejects bad-schema outputs AT WRITE (T3).
//
// Persistence (PR #78 follow-up): when a `persistDir` is supplied, every
// write() appends a json line to `<persistDir>/outputs/<gig_id>.jsonl` and every
// addRef() appends to `<persistDir>/refs/<from_gig_id>.jsonl`. Reads (get / all /
// findings / trace / refs) lazy-hydrate from disk on first access, so a fresh
// process can serve outputs written by an earlier session. Matches the
// append-only jsonl-chain shape used elsewhere in the audit substrate.
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Registry } from "./registry.js";

// §6 output_refs.relation CHECK constraint, as a closed set.
export const REF_RELATIONS = [
  "derived_from",
  "validates",
  "challenges",
  "refines",
  "triggers",
  "contains",
] as const;
export type RefRelation = (typeof REF_RELATIONS)[number];

// §6 `outputs` row. The universal typed-output store: one table, all output shapes.
export interface OutputRecord {
  id: string;
  core_type: string;
  domain_type: string;
  domain_type_version: number;
  domain: string;
  gig_id: string;
  agent_slug: string;
  // The chair role within the standard that produced this output. Populated by
  // the runtime when the writer is a chair (the normal path); legacy hand-rolled
  // writes that don't supply a role leave it undefined. Downstream chairs use it
  // to address each upstream's output individually (per-role addressability), so
  // that N parallel upstreams binding the SAME agent are still distinguishable.
  from_role?: string | undefined;
  phase?: string | undefined;
  primitive: string;
  data: Record<string, unknown>; // validated against core + domain schema at write
  input_refs: string[];
  created_at: string;
  cost_usd?: number | undefined;
  tokens_used?: number | undefined;
  duration_ms?: number | undefined;
  // When the producer is a skill-backed chair (deterministic code, no model), this pins
  // WHICH skill produced the output — slug + version + verified code_hash + permission tier.
  // It closes the chair→skill provenance gap: an audit can trace the ledger entry back to the
  // exact SkillChainEvent. Absent for model-backed (agent) chairs; agent_slug carries those.
  skill_provenance?: { slug: string; version: number; code_hash: string; tier: number } | undefined;
}

// What a caller supplies to write(). id + created_at are assigned by the store;
// domain_type_version + input_refs + the cost fields are optional.
export interface OutputWrite {
  core_type: string;
  domain_type: string;
  domain_type_version?: number | undefined;
  domain: string;
  gig_id: string;
  agent_slug: string;
  from_role?: string | undefined;
  phase?: string | undefined;
  primitive: string;
  data: Record<string, unknown>;
  input_refs?: string[] | undefined;
  cost_usd?: number | undefined;
  tokens_used?: number | undefined;
  duration_ms?: number | undefined;
  skill_provenance?: { slug: string; version: number; code_hash: string; tier: number } | undefined;
}

// §6 `output_refs` row — one typed edge of the provenance graph.
export interface OutputRef {
  id: string;
  from_output_id: string;
  to_output_id: string;
  relation: RefRelation;
  primitive: string;
  created_at: string;
}

// §6 backward-compat `findings` VIEW shape (projection over outputs where
// domain_type='finding' AND domain='eirtests').
export interface Finding {
  id: string;
  gig_id: string;
  pattern_key?: string | undefined;
  severity?: string | undefined;
  title?: string | undefined;
  evidence?: string | undefined;
  location?: string | undefined;
  recommendation?: string | undefined;
  is_novel?: boolean | undefined;
  kpi_impacts?: unknown;
  status?: string | undefined;
  agent_role: string;
  dimension?: string | undefined;
  created_at: string;
}

export class OutputStoreError extends Error {}

export interface OutputStore {
  // Validates against core+domain schema via registry; throws on invalid (T3). Returns the stored row.
  write(o: OutputWrite): OutputRecord;
  get(id: string): OutputRecord | undefined;
  all(): readonly OutputRecord[];
  // Provenance edge. relation must be in REF_RELATIONS; both endpoints must exist.
  addRef(from_output_id: string, to_output_id: string, relation: RefRelation, primitive: string): OutputRef;
  refs(): readonly OutputRef[];
  // E6: walk backward from an artifact to its source signals (input_refs + derived_from/refines edges).
  // Optional opts: max_depth caps the walk at N hops backward from the seed.
  // gig_id scoping: the walk only follows edges into the seed's gig_id (cross-gig
  // ancestors are not surfaced).
  trace(id: string, opts?: { max_depth?: number }): OutputRecord[];
  // T8: the backward-compat findings view.
  findings(): Finding[];
}

export interface OutputStoreOptions {
  // When set, every write/addRef append-flushes to jsonl files under this dir,
  // and reads lazy-hydrate from disk. Cross-session persistence for MCP clients
  // that close + reopen between gigs (PR #78 follow-up).
  persistDir?: string | undefined;
}

// Default disk-persistence root, matching chain_keeper.py's ~/.eir/<chain>/ shape.
// Resolved against COLTRANE_OUTPUTS_DIR (test override) or $HOME.
export function defaultOutputsPersistDir(): string {
  const override = process.env["COLTRANE_OUTPUTS_DIR"];
  if (override && override.length > 0) return override;
  const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? ".";
  return path.join(home, ".eir", "coltrane_outputs");
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function appendJsonl(file: string, row: unknown): void {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(row) + "\n", "utf8");
}

function readJsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, "utf8");
  const rows: T[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try {
      rows.push(JSON.parse(line) as T);
    } catch {
      // Skip malformed lines — chain_keeper.py uses the same forgiving shape.
    }
  }
  return rows;
}

function listJsonl(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith(".jsonl")) out.push(path.join(dir, name));
  }
  return out;
}

export function createOutputStore(registry: Registry, options?: OutputStoreOptions): OutputStore {
  const outputs = new Map<string, OutputRecord>();
  const edges: OutputRef[] = [];
  const persistDir = options?.persistDir;
  const outputsDir = persistDir ? path.join(persistDir, "outputs") : undefined;
  const refsDir = persistDir ? path.join(persistDir, "refs") : undefined;

  // Track which gig_ids we've hydrated so a single gig file is read at most once.
  const hydratedGigs = new Set<string>();
  let fullyHydrated = false;

  function asStr(v: unknown): string | undefined {
    return typeof v === "string" ? v : undefined;
  }

  function hydrateGig(gig_id: string): void {
    if (!outputsDir || hydratedGigs.has(gig_id)) return;
    hydratedGigs.add(gig_id);
    const file = path.join(outputsDir, `${gig_id}.jsonl`);
    for (const rec of readJsonl<OutputRecord>(file)) {
      if (!outputs.has(rec.id)) outputs.set(rec.id, rec);
    }
    if (refsDir) {
      const refsFile = path.join(refsDir, `${gig_id}.jsonl`);
      for (const ref of readJsonl<OutputRef>(refsFile)) {
        if (!edges.some((e) => e.id === ref.id)) edges.push(ref);
      }
    }
  }

  function hydrateAll(): void {
    if (!outputsDir || fullyHydrated) return;
    fullyHydrated = true;
    for (const file of listJsonl(outputsDir)) {
      const base = path.basename(file, ".jsonl");
      hydrateGig(base);
    }
    // Also pull in any orphan refs files (defensive — addRef writes by from_gig_id).
    if (refsDir) {
      for (const file of listJsonl(refsDir)) {
        for (const ref of readJsonl<OutputRef>(file)) {
          if (!edges.some((e) => e.id === ref.id)) edges.push(ref);
        }
      }
    }
  }

  return {
    write(o) {
      // T2/T3: reject bad-schema output AT WRITE by wiring the registry validator.
      const result = registry.validate({
        core_type: o.core_type,
        domain_type: o.domain_type,
        data: o.data,
      });
      if (!result.valid) {
        throw new OutputStoreError(
          `output rejected: ${o.domain_type} failed schema validation — ${result.errors.join("; ")}`,
        );
      }
      const rec: OutputRecord = {
        id: randomUUID(),
        core_type: o.core_type,
        domain_type: o.domain_type,
        domain_type_version: o.domain_type_version ?? 1,
        domain: o.domain,
        gig_id: o.gig_id,
        agent_slug: o.agent_slug,
        from_role: o.from_role,
        phase: o.phase,
        primitive: o.primitive,
        data: o.data,
        input_refs: o.input_refs ?? [],
        created_at: new Date().toISOString(),
        cost_usd: o.cost_usd,
        tokens_used: o.tokens_used,
        duration_ms: o.duration_ms,
        skill_provenance: o.skill_provenance,
      };
      outputs.set(rec.id, rec);
      if (outputsDir) {
        // Mark this gig hydrated so we don't re-read what we just wrote.
        hydratedGigs.add(rec.gig_id);
        appendJsonl(path.join(outputsDir, `${rec.gig_id}.jsonl`), rec);
      }
      return rec;
    },

    get(id) {
      const hit = outputs.get(id);
      if (hit) return hit;
      // Lazy-hydrate on miss: a fresh session reading an id from an earlier run.
      hydrateAll();
      return outputs.get(id);
    },

    all() {
      hydrateAll();
      return [...outputs.values()];
    },

    addRef(from_output_id, to_output_id, relation, primitive) {
      if (!REF_RELATIONS.includes(relation)) {
        throw new OutputStoreError(`invalid relation "${relation}"`);
      }
      // Ensure endpoints exist (possibly hydrating to find them).
      const fromRec = outputs.get(from_output_id) ?? (hydrateAll(), outputs.get(from_output_id));
      if (!fromRec) {
        throw new OutputStoreError(`from_output_id "${from_output_id}" does not exist`);
      }
      if (!outputs.has(to_output_id)) {
        throw new OutputStoreError(`to_output_id "${to_output_id}" does not exist`);
      }
      const ref: OutputRef = {
        id: randomUUID(),
        from_output_id,
        to_output_id,
        relation,
        primitive,
        created_at: new Date().toISOString(),
      };
      edges.push(ref);
      if (refsDir) {
        appendJsonl(path.join(refsDir, `${fromRec.gig_id}.jsonl`), ref);
      }
      return ref;
    },

    refs() {
      hydrateAll();
      return [...edges];
    },

    trace(id, opts) {
      // Walk backward: a node's parents are its input_refs plus the targets of
      // its derived_from/refines edges. Returns every reachable ancestor (the
      // provenance closure), cycle-safe.
      hydrateAll();
      //
      // max_depth: hard cap on hop count from the seed. depth=0 → no walk
      // (returns []); depth=1 → only direct parents; etc.
      //
      // gig_id scope: the walk only follows into nodes that share the seed's
      // gig_id. Cross-gig ancestors are not surfaced.
      const maxDepth = opts?.max_depth;
      const seed = outputs.get(id);
      const seedGigId = seed?.gig_id;
      const seen = new Set<string>();
      const order: OutputRecord[] = [];
      const stack: Array<{ id: string; depth: number }> = [{ id, depth: 0 }];
      while (stack.length) {
        const { id: cur, depth } = stack.pop()!;
        if (seen.has(cur)) continue;
        seen.add(cur);
        const rec = outputs.get(cur);
        if (!rec) continue;
        if (cur !== id) {
          if (seedGigId !== undefined && rec.gig_id !== seedGigId) continue;
          order.push(rec);
        }
        if (maxDepth !== undefined && depth >= maxDepth) continue;
        for (const p of rec.input_refs) stack.push({ id: p, depth: depth + 1 });
        for (const e of edges) {
          if (e.from_output_id === cur && (e.relation === "derived_from" || e.relation === "refines")) {
            stack.push({ id: e.to_output_id, depth: depth + 1 });
          }
        }
      }
      return order;
    },

    findings() {
      hydrateAll();
      const rows: Finding[] = [];
      for (const o of outputs.values()) {
        if (o.domain_type !== "finding" || o.domain !== "eirtests") continue;
        const d = o.data;
        rows.push({
          id: o.id,
          gig_id: o.gig_id,
          pattern_key: asStr(d["pattern_key"]),
          severity: asStr(d["severity"]),
          title: asStr(d["title"]),
          evidence: asStr(d["evidence"]),
          location: asStr(d["location"]),
          recommendation: asStr(d["recommendation"]),
          is_novel: typeof d["is_novel"] === "boolean" ? (d["is_novel"] as boolean) : undefined,
          kpi_impacts: d["kpi_impacts"],
          status: asStr(d["status"]),
          agent_role: o.agent_slug,
          dimension: asStr(d["dimension"]),
          created_at: o.created_at,
        });
      }
      return rows;
    },
  };
}
