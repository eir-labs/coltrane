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
import { CORE_TYPES, type CoreType } from "./core_types.js";
import { validateOutput } from "./output_validation.js";
import { outputContentHash } from "./canonical_form.js";

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
  // Runtime-computed content hash of the canonical output (the same shape runFingerprint
  // folds over). Stamped at write() so the provenance chain is hash-anchored without any
  // agent needing a hashing tool: a downstream record's input_refs point at upstream ids
  // whose content_sha pins exactly what was consumed. Deterministic over identical content.
  content_sha: string;
  input_refs: string[];
  // The content_sha of each input_ref, in the same order — the real, engine-computed predecessor
  // hashes (#196). Stamped at write() so the audit chain is byte-reproducible WITHOUT any agent
  // hashing: walk input_refs → input_shas to recompute provenance. Empty for root chairs.
  // Timing: each value is the upstream record's content_sha AS SEALED (records are immutable once
  // written), not a fresh re-hash — so there's no read-vs-write skew if an upstream is touched later.
  input_shas: string[];
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
  /** content_sha of each input_ref (same order) — the real predecessor hashes (#196). When omitted,
   *  write() resolves them from the store by input_refs id. */
  input_shas?: string[] | undefined;
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

/**
 * One unreadable line in a persisted jsonl file. Same vocabulary as the ledger's
 * `LedgerCorruption` (#211) — two stores in one engine should describe damage the same way.
 */
export interface OutputStoreCorruption {
  path: string;
  line_no: number;
  reason: string;
  preview: string;
}

/**
 * #248 — skip-and-REPORT, the shape PR #256 established for the ledger.
 *
 * A silent skip let a torn append (crash mid-write, disk full) delete an output from `all()`,
 * `trace()` and `output_query` with no signal at all, so the engine reported a SHORTER CHAIN
 * as if it were the whole chain. That is the exact INVERSE of the ledger's old problem, where
 * the same situation threw and took the entire audit surface offline. Two stores, opposite
 * failure modes, neither correct: one hid corruption, the other was destroyed by it. Reads
 * stay forgiving — the intact rows keep serving — and this is how an operator learns the
 * store is damaged.
 */
export interface OutputStoreIntegrityReport {
  ok: boolean;
  /** jsonl files actually read this session. 0 for a purely in-memory store. */
  scanned: number;
  corrupt: OutputStoreCorruption[];
}

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
  // Resolve a domain (or core) type slug to its core type. A core type resolves to
  // itself; a domain subtype resolves to its `extends`. Returns null for an unknown
  // type. The runtime uses this to seal each of a multi-output chair's declared types
  // under the right core (a type's core comes from its OWN extends, since an agent's
  // primitives and output_types are not 1:1).
  coreTypeOf(typeSlug: string): string | null;
  // #248: what was skipped while hydrating from disk. `ok: false` means at least one
  // persisted row could not be read, so any chain this store reports may be short.
  integrity(): OutputStoreIntegrityReport;
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

function readJsonl<T>(file: string, corrupt: OutputStoreCorruption[]): T[] {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, "utf8");
  const rows: T[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    // `.trim()`, not `.length > 0` — a lone `\r` from a CRLF file is length 1 and would
    // otherwise reach JSON.parse (same reasoning as FileLedger.read).
    const line = lines[i]!.trim();
    if (!line) continue;
    try {
      rows.push(JSON.parse(line) as T);
    } catch (e) {
      // Still forgiving (chain_keeper.py's shape), but no longer silent (#248). Compatibility
      // with a forgiving reader is an argument for skipping the line, never for hiding it.
      corrupt.push({
        path: file,
        line_no: i + 1,
        reason: `unparseable JSON: ${e instanceof Error ? e.message : String(e)}`,
        preview: line.slice(0, 120),
      });
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

  // #248 — corruption accumulated across every hydrate. Keyed by file so the defensive
  // orphan-refs re-read in hydrateAll can't double-report the same damaged line.
  const scannedFiles = new Set<string>();
  const corruption: OutputStoreCorruption[] = [];
  function readRows<T>(file: string): T[] {
    if (!fs.existsSync(file)) return [];
    if (scannedFiles.has(file)) return readJsonl<T>(file, []); // already accounted for
    scannedFiles.add(file);
    return readJsonl<T>(file, corruption);
  }

  function asStr(v: unknown): string | undefined {
    return typeof v === "string" ? v : undefined;
  }

  // The registry's answer to "what core is this type, really". A bare core is itself;
  // a registered domain type is its `extends`; anything unregistered is unresolvable.
  // Exposed as `coreTypeOf` below AND consulted by `write` — deliberately one function,
  // because #263 was precisely two layers disagreeing about the same question.
  function resolveCoreType(typeSlug: string): string | null {
    if ((CORE_TYPES as readonly string[]).includes(typeSlug)) return typeSlug;
    const dt = registry.listTypes().find((t) => t.slug === typeSlug);
    return dt ? dt.extends : null;
  }

  function hydrateGig(gig_id: string): void {
    if (!outputsDir || hydratedGigs.has(gig_id)) return;
    hydratedGigs.add(gig_id);
    const file = path.join(outputsDir, `${gig_id}.jsonl`);
    for (const rec of readRows<OutputRecord>(file)) {
      if (!outputs.has(rec.id)) outputs.set(rec.id, rec);
    }
    if (refsDir) {
      const refsFile = path.join(refsDir, `${gig_id}.jsonl`);
      for (const ref of readRows<OutputRef>(refsFile)) {
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
        for (const ref of readRows<OutputRef>(file)) {
          if (!edges.some((e) => e.id === ref.id)) edges.push(ref);
        }
      }
    }
  }

  return {
    write(o) {
      // #263 — the asserted core must agree with the registry's answer.
      //
      // #227/#228 made `core_type` load-bearing: it selects which substance floor is
      // enforced. So a caller asserting the wrong core does not merely mislabel the record —
      // it gets the WRONG core's floor applied, and can satisfy `Verdict.checks[]` while
      // sealing something the registry says is an Interpretation that owed `claims[]`.
      //
      // ORDER: this runs FIRST, ahead of the schema validation below, and that placement is
      // load-bearing in a way the first draft of this fix got wrong. The agreement check is
      // pure METADATA — it compares two declarations and never looks at the payload — so it
      // does not need the schema to have passed. Running it second meant that for a CLOSED
      // schema (the default, and what every shipped domain type uses) a payload carrying the
      // wrong core's substance field died on Ajv first, telling the operator to delete
      // `checks` when the actual repair is to fix the declared core. The diagnosis for a
      // contradicted core has to come from the check that understands cores.
      //
      // Unresolvable slugs still fall through untouched: an unregistered domain_type is the
      // registry's `unknown domain_type` rejection below, and this must not become a second,
      // competing owner of that error.
      if (o.domain_type) {
        const registered = resolveCoreType(o.domain_type);
        if (registered !== null && registered !== o.core_type) {
          throw new OutputStoreError(
            `output rejected: ${o.domain_type} was sealed as core_type "${o.core_type}" but the ` +
              `registry defines it as "${registered}" — one of the two is wrong, and the core ` +
              `decides which substance invariant applies`,
          );
        }
      }
      // #263 follow-on — a `core_type` that is not a core type at all.
      //
      // The check above only fires when a domain_type RESOLVES. With no domain_type (the
      // freeform path, Rob #133) any string sailed through: `core_type: "Nonsense"` sealed,
      // and so did `core_type: ""`. `validateOutput` returns valid for an unrecognised core,
      // so those records carried NO substance floor whatsoever — the purest form of the very
      // defect #263 describes, reachable without a registry entry at all.
      if (!(CORE_TYPES as readonly string[]).includes(o.core_type)) {
        throw new OutputStoreError(
          `output rejected: "${o.core_type}" is not a core type — expected one of ` +
            `[${CORE_TYPES.join(", ")}]. The core selects which substance invariant applies, ` +
            `so an unrecognised one silently means "no floor at all".`,
        );
      }
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
      // #227/#228 — the CORE-type invariant, checked on every write regardless of whether
      // a domain schema applied. registry.validate above returns {valid:true} without
      // looking at the data for a bare core type and for an absent domain_type, and a
      // subtype can overload away an inherited floor (#230) — so the substance floor an
      // Artifact/Verdict carries by definition has to be enforced here, at the one seal
      // boundary, not delegated to the domain schema that may not exist.
      //
      // validateOutput was already written and already tested; it was simply never called
      // (#228). Path (b) per the #228 ruling: an ABSENT substance key is rejected, not just
      // an empty one — an Artifact nobody can check is not an artifact, and a Verdict with
      // no evidence is not a verification.
      //
      // Per the #227 ruling ("there's no subtype thing — it's all the way top to bottom")
      // ALL SIX cores now carry a floor, not just Artifact and Verdict, and it applies to
      // bare cores and domain subtypes alike. src/output_validation.ts holds the table.
      const core = validateOutput({
        core_type: o.core_type as CoreType,
        domain_type: o.domain_type,
        data: o.data,
      });
      if (!core.valid) {
        throw new OutputStoreError(
          `output rejected: ${o.domain_type || o.core_type} failed core-type invariant — ${core.reason}`,
        );
      }
      const domain_type_version = o.domain_type_version ?? 1;
      const rec: OutputRecord = {
        id: randomUUID(),
        core_type: o.core_type,
        domain_type: o.domain_type,
        domain_type_version,
        domain: o.domain,
        gig_id: o.gig_id,
        agent_slug: o.agent_slug,
        from_role: o.from_role,
        phase: o.phase,
        primitive: o.primitive,
        data: o.data,
        content_sha: outputContentHash({
          core_type: o.core_type,
          domain_type: o.domain_type,
          domain_type_version,
          domain: o.domain,
          primitive: o.primitive,
          phase: o.phase,
          agent_slug: o.agent_slug,
          data: o.data,
        }),
        input_refs: o.input_refs ?? [],
        // Real predecessor hashes (#196): prefer caller-supplied, else resolve each input_ref's
        // content_sha from the store. The chain is then walkable input_refs[i] ↔ input_shas[i].
        input_shas: o.input_shas ?? (o.input_refs ?? []).map((id) => outputs.get(id)?.content_sha ?? ""),
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
    coreTypeOf(typeSlug) {
      return resolveCoreType(typeSlug);
    },

    integrity() {
      // Force the full scan first — an integrity report over a partially-hydrated store
      // would itself be the "shorter chain reported as the whole chain" failure (#248).
      hydrateAll();
      return { ok: corruption.length === 0, scanned: scannedFiles.size, corrupt: [...corruption] };
    },
  };
}
