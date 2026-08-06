// Reuse a sealed output instead of re-deriving it.
//
// ONE idea, two ranges. A gig CHECKPOINT lets a failed run restart from the phase it died
// on instead of from zero (reuse across attempts at the same gig); a chair-level REUSE CACHE
// lets a chair be served from a prior gig's sealed output instead of invoking the model
// (reuse across gigs). Both answer the same question — "is there an existing sealed output
// that stands in for the one I am about to pay to derive?" — and both live or die on the
// same discipline: an exact, defensible key, and a refusal to serve anything that would not
// pass the seal boundary today.
//
// WHY THIS IS NOT MERELY AN OPTIMISATION. Substituting a sealed output means the artifact an
// operator acts on was produced under conditions that are no longer visible in the run. If
// the genome moved between the two, the provenance chain silently splices two different
// systems together: sealed outputs from run A consumed by chairs from genome B, with nothing
// in `input_shas`, `genome_hash` or `run_fingerprint` recording that it happened. So every
// substitution here is gated on a stated IDENTITY, and every substitution that happens is
// REPORTED. A silent saving is indistinguishable from a bug.
//
// THE GOVERNING ASYMMETRY (borrowed, deliberately, from the downstream precedent in
// grant-writing-coltrane's `dashboard/src/lib/requirements-cache.ts`): a MISS IS FREE — it
// costs the cold run that would have happened anyway. A WRONG HIT IS NOT. Every ambiguous
// case below therefore resolves to "do the work".
//
// PURITY. Key derivation and entry validation are pure functions of their arguments — no
// clock, no filesystem, no registry handle. The file-backed stores at the bottom are the only
// I/O. That split is what makes the correctness half exhaustively testable.

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { writeFileAtomic } from "./fs_atomic.js";
import { sha256Hex, canonJson } from "./canonical_form.js";

/**
 * Bump when the key LAYOUT changes (a new component, a different framing). Old keys then
 * simply stop being addressable, which is the correct outcome: a key computed under a
 * different layout is not a weaker match, it is a different question.
 */
export const REUSE_KEY_VERSION = "cr1";

/** Bump when the on-disk checkpoint shape changes. A checkpoint of another version is refused. */
export const CHECKPOINT_SCHEMA_VERSION = 1;

/** Bump when the on-disk reuse-entry shape changes. An entry of another version is a miss. */
export const REUSE_SCHEMA_VERSION = 1;

export class ReuseStoreError extends Error {}

// ───────────────────────────────────────────────────────────────────────────────
// Type fingerprints — the genome moves under the cache
// ───────────────────────────────────────────────────────────────────────────────

/**
 * How a caller answers "what shape is this type, right now". Supplied by the OutputStore,
 * which is already the single owner of type resolution at the seal boundary (`coreTypeOf`) —
 * #263 was precisely two layers disagreeing about the same question, so this does not become
 * a second owner. Returns "" for a type the registry cannot describe.
 */
export type TypeFingerprintFn = (typeSlug: string) => string;

/**
 * Fingerprint one type definition: its core, its required list, and its whole schema.
 *
 * Deliberately OVER-SENSITIVE — any edit to the type, including a nested one, invalidates
 * every entry sealed under the old shape. Type edits are rare; a miss costs one cold
 * invocation; serving an object the current seal validator would reject costs a run that
 * dies at the terminal phase. The trade is not close.
 */
export function typeShapeFingerprint(def: {
  extends: string;
  required_fields?: readonly string[] | undefined;
  schema?: unknown;
}): string {
  return sha256Hex(
    canonJson({
      extends: def.extends,
      required: [...(def.required_fields ?? [])].sort(),
      schema: def.schema ?? null,
    }),
  );
}

// ───────────────────────────────────────────────────────────────────────────────
// Run identity — what "the same run" means
// ───────────────────────────────────────────────────────────────────────────────

/**
 * The identity a resume must match, field for field.
 *
 * `genome_hash` is the load-bearing one: it folds the standard's phase DAG and every bound
 * agent's type surface, so a resume across an edited pipeline cannot happen. The rest close
 * the holes genome_hash does not cover:
 *
 *  - `gig_input_sha` — the dispatch payload. Phases 1..4 derived from payload A followed by
 *    phase 5 consuming payload B is the same splice as a genome change, one layer down.
 *  - `model_version` — a run whose first half was produced by one model and second half by
 *    another gets ONE `run_fingerprint`, carrying only the final model. That fingerprint then
 *    misdescribes the outputs it covers. Cheap to check; usually "unknown" on both sides, so
 *    it costs nothing for callers that never set it.
 *  - `depth` — #237 made depth shape what the model is asked for. A `skim` half stitched to a
 *    `deep` half is two different pipelines wearing one manifest.
 *  - `canonical_form_version` — content_shas computed under two canonical forms are not
 *    comparable, so every hash-based check below would be comparing incomparable things.
 *
 * NOT included: `run_fingerprint`. It is a RESULT identity, not a run identity — it is
 * computed at the end of a run from the outputs the run produced, so a run that failed at
 * phase 5 does not have one at all, and the fingerprint of the resumed run is precisely the
 * thing resume exists to produce. Gating on it would be circular.
 */
export interface RunIdentity {
  standard_slug: string;
  genome_hash: string;
  /**
   * The WHOLE definition of every bound agent, and every resolved skill's code_hash.
   *
   * `genome_hash` is NOT sufficient and this field exists because it is not. `genomeHash`
   * projects each agent down to `{slug, primitives, input_types, output_types, domain}` —
   * so `identity`, `method`, `constraints`, `behavioral_primitives`, `allowed_tools`,
   * `code_tool_access`, the `max_*` limits and `skill_slugs` are all invisible to it. Those
   * are the fields that BECOME THE PROMPT. Rewrite an agent's method under a stable slug
   * after a bad run — the ordinary response to a bad run — and `genome_hash` does not move,
   * so a resume would splice chairs from genome B onto sealed outputs from genome A and
   * nothing in the manifest would record it. For a skill chair the code IS the producer, and
   * a rewritten `skill.mjs` under an unchanged `meta.version` is the same defect.
   *
   * `reuseCacheKey` already folds exactly this (see `ReuseKeyInput.agent` and `.skills`)
   * with the same reasoning. Two gates guarding one concern must not answer differently.
   */
  producers_sha: string;
  gig_input_sha: string;
  model_version: string;
  depth: string;
  canonical_form_version: string;
}

/**
 * Fold every producer definition a run depends on into one hash.
 *
 * Whole agent definitions, plus each resolved skill's verified `code_hash` — not the slug,
 * which is precisely what an edit-under-a-stable-slug leaves unchanged.
 */
export function producersSha(input: {
  agents: readonly unknown[];
  skills?: ReadonlyArray<{ slug: string; code_hash: string }>;
}): string {
  return sha256Hex(
    canonJson({
      agents: input.agents,
      skills: [...(input.skills ?? [])]
        .map((s) => ({ slug: s.slug, code_hash: s.code_hash }))
        .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0)),
    }),
  );
}

export function runIdentityMismatch(a: RunIdentity, b: RunIdentity): string[] {
  const out: string[] = [];
  for (const k of Object.keys(a) as Array<keyof RunIdentity>) {
    if (a[k] !== b[k]) out.push(`${k}: checkpoint="${a[k]}" current="${b[k]}"`);
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────────
// The checkpoint
// ───────────────────────────────────────────────────────────────────────────────

/** One completed chair, as recorded for a possible resume. */
export interface CheckpointRole {
  role: string;
  phase: string;
  /** The sealed records, by store id. Resolved against the OutputStore at resume time. */
  output_ids: string[];
  /** Their content_shas, in the same order — so a store whose bytes moved is caught. */
  content_shas: string[];
  /** Their domain types, in the same order. */
  domain_types: string[];
  /** Each domain type's shape when it was sealed. Re-checked at resume. */
  type_fingerprints: string[];
  sealed_at: string;
}

export interface GigCheckpoint {
  schema_version: number;
  gig_id: string;
  identity: RunIdentity;
  started_at: string;
  updated_at: string;
  roles: CheckpointRole[];
  /**
   * What the run that wrote this checkpoint had spent when it wrote it, as JSON. Reported by a
   * resumed run under `resumed_from.prior_usage` and deliberately NOT folded into the resumed
   * run's own `usage`: #235/#236 made `usage` mean "what THIS run actually captured", and
   * quietly widening it to "what the gig cost across attempts" would undo that. Two numbers,
   * both true, kept apart.
   */
  prior_usage?: unknown;
}

export interface CheckpointStore {
  /** The checkpoint for this gig, or undefined if none was ever written. Throws on damage. */
  read(gig_id: string): GigCheckpoint | undefined;
  write(cp: GigCheckpoint): void;
  /**
   * Drop a gig's checkpoint. Called when a gig COMPLETES.
   *
   * A checkpoint exists to resume unfinished work, so a completed gig's is dead weight — and
   * without this every gig a deployment ever runs leaves a file behind forever. A FAILED or
   * aborted gig's checkpoint is kept, because that is precisely what resume reads.
   *
   * Best-effort: a checkpoint that cannot be removed is disk to reclaim, not a reason to fail
   * a run that has already succeeded.
   */
  remove(gig_id: string): void;
}

// ───────────────────────────────────────────────────────────────────────────────
// The chair-level reuse cache
// ───────────────────────────────────────────────────────────────────────────────

/** One sealed output, carried with everything `OutputStore.write` needs to re-seal it. */
export interface ReuseOutput {
  core_type: string;
  domain_type: string;
  domain: string;
  primitive: string;
  agent_slug: string;
  phase: string;
  data: Record<string, unknown>;
  /** The content_sha the ORIGINAL seal produced. Re-derived on injection and compared. */
  content_sha: string;
  /** The shape `domain_type` had when this was sealed. Re-checked on every read. */
  type_fingerprint: string;
  source_output_id: string;
  skill_provenance?: { slug: string; version: number; code_hash: string; tier: number } | undefined;
}

/**
 * One cached chair invocation. A chair is cached ALL-OR-NOTHING, mirroring the invariant #243
 * established for a fresh chair: it seals its whole contract or it seals nothing. A
 * half-served chair would be a shape the engine does not otherwise admit.
 */
export interface ReuseEntry {
  schema_version: number;
  cache_key: string;
  outputs: ReuseOutput[];
  source_gig_id: string;
  source_role: string;
  created_at: string;
}

export interface ReuseStore {
  /** The entry for this key, or undefined. Throws ReuseStoreError on a damaged entry. */
  get(cache_key: string): ReuseEntry | undefined;
  put(entry: ReuseEntry): void;
}

/**
 * Everything that determines what a chair's invocation WOULD produce. Every field is part of
 * the key; nothing here is decoration.
 */
export interface ReuseKeyInput {
  /** Over-scoping, on purpose: two standards with identical chairs do not share entries. */
  standard_slug: string;
  phase: string;
  /** The chair definition, canonically. Its contracts and deps decide what it is asked for. */
  chair: unknown;
  /**
   * The bound agent's WHOLE definition (identity, method, constraints, tools, tier, limits) —
   * because that is what becomes the prompt. An agent edited under a stable slug is a
   * different producer, and keying on the slug alone would serve the old agent's work as the
   * new one's.
   */
  agent: unknown;
  /** For a skill-backed chair: slug + version + verified code_hash. The code IS the producer. */
  skill_provenance?: unknown;
  /**
   * The resolved skill packages the agent actually holds (slug/version/code_hash). A run that
   * silently lost a skill binding (#241) produces different work under an identical agent
   * definition, and used to be cryptographically indistinguishable from a skilled one.
   */
  skills: readonly { slug: string; version: number; code_hash: string }[];
  /**
   * The content_shas of the inputs this chair consumed — CONTENT, not object identity. Sorted,
   * because a chair consuming the same two records in a different `depends_on` order consumed
   * the same thing (and #240 established that nothing an operator sees may depend on the order
   * of a JSON array).
   */
  input_shas: readonly string[];
  /**
   * The hash of the WHOLE dispatch payload.
   *
   * Narrower would be a guess. Every invocation receives `gig_input` entire — the invoker
   * hands the model the whole payload — so the engine cannot know which keys a chair read.
   * Restricting this to the gig-input types the chair's `input_contract` names would be
   * exactly the kind of plausible inference #240 removed from provenance stamping. The cost
   * is stated plainly: the cache is per-payload, so it serves re-runs and retries of the same
   * dispatch, not cross-payload sharing. A consumer who KNOWS which payload fields matter can
   * build a narrower cache; the engine cannot.
   */
  gig_input_sha: string;
  model_version: string;
  depth: string;
  /** The types this chair promised THIS run (#174's subset), which is what it was asked for. */
  output_types: readonly string[];
  canonical_form_version: string;
}

/**
 * The cache key. Length-prefixed framing so no component can forge a delimiter and
 * masquerade as a different key layout.
 *
 * NOT in the key: the TYPE FINGERPRINTS of the sealed outputs. Those ride on the ENTRY and
 * are re-checked on read. Putting them in the key (as the downstream precedent does) would
 * make a stale entry unaddressable — safe, but a SILENT miss, indistinguishable from
 * never-cached. This engine has spent a lot of effort making refusals say why they happened,
 * and the entry-side check gives a stale entry a name (`type-fingerprint-mismatch`) instead
 * of a shrug. It is equally safe here because, unlike that precedent, every injection also
 * crosses the real seal boundary before anything becomes durable.
 */
export function reuseCacheKey(input: ReuseKeyInput): string {
  const frame = (...parts: string[]): string => parts.map((p) => `${p.length}:${p}`).join("|");
  return sha256Hex(
    frame(
      REUSE_KEY_VERSION,
      input.canonical_form_version,
      input.standard_slug,
      input.phase,
      canonJson(input.chair),
      canonJson(input.agent ?? null),
      canonJson(input.skill_provenance ?? null),
      canonJson([...input.skills].map((s) => [s.slug, s.version, s.code_hash]).sort()),
      canonJson([...input.input_shas].sort()),
      input.gig_input_sha,
      input.model_version,
      input.depth,
      canonJson([...input.output_types].sort()),
    ),
  );
}

/** Why an entry that WAS found is not being served. Never a silent miss. */
export type ReuseRejection =
  | "schema-version"
  | "empty-entry"
  | "type-unfingerprintable"
  | "type-fingerprint-mismatch"
  | "content-sha-mismatch"
  | "seal-rejected"
  | "unreadable";

export interface ReuseCheck {
  ok: boolean;
  reason?: ReuseRejection;
  detail?: string;
}

/**
 * Is this entry still safe to serve — on the evidence available WITHOUT touching the store?
 *
 * This is the cheap half of the guard. The authoritative half is that every injected output
 * is re-validated through `OutputStore.validateWrite` and then re-sealed through
 * `OutputStore.write`, so it crosses exactly the boundary a fresh output crosses: the #263
 * core-agreement check, the registry schema, and the #227/#228 core substance floor. Nothing
 * is injected that a fresh seal would have refused.
 *
 * Both halves exist because they fail in different directions. The fingerprint catches a
 * genome edit BEFORE any data is touched and can name it. The seal catches everything else —
 * a hand-edited entry, an entry written by an older engine whose substance floor was looser,
 * a registry that resolves the type to a different core than it did. Neither subsumes the
 * other, and the expensive one is the one that must not be skipped.
 */
export function checkReuseEntry(entry: ReuseEntry, fingerprintOf: TypeFingerprintFn): ReuseCheck {
  if (entry.schema_version !== REUSE_SCHEMA_VERSION) {
    return { ok: false, reason: "schema-version", detail: `entry is v${entry.schema_version}, engine reads v${REUSE_SCHEMA_VERSION}` };
  }
  if (!Array.isArray(entry.outputs) || entry.outputs.length === 0) {
    // A chair that sealed nothing is legal (#243, every promised type optional) but it is not
    // cacheable: "sealed nothing" and "was never cached" are the same bytes, so serving it
    // would be asserting a fact the entry cannot carry.
    return { ok: false, reason: "empty-entry", detail: "entry records no sealed outputs" };
  }
  for (const o of entry.outputs) {
    const now = fingerprintOf(o.domain_type);
    if (now === "") {
      // A cache that cannot check its entries must not serve them.
      return { ok: false, reason: "type-unfingerprintable", detail: `the registry cannot describe "${o.domain_type}"` };
    }
    if (now !== o.type_fingerprint) {
      return { ok: false, reason: "type-fingerprint-mismatch", detail: `"${o.domain_type}" has changed shape since this entry was sealed` };
    }
  }
  return { ok: true };
}

// ───────────────────────────────────────────────────────────────────────────────
// File-backed stores
// ───────────────────────────────────────────────────────────────────────────────

// Write-then-rename. A torn checkpoint would be read as damage and refuse a resume that was,
// in fact, resumable — the failure mode a partial `appendFileSync` would introduce.
//
// Shared with the genome writer (src/fs_atomic.ts), which needed the same guarantee and did not
// have it. Two implementations of one concern, one documented and one absent, is how the two
// identity gates in this file came to disagree.
const writeAtomic = writeFileAtomic;

function readJsonFile<T>(file: string): T | undefined {
  if (!fs.existsSync(file)) return undefined;
  const text = fs.readFileSync(file, "utf8");
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new ReuseStoreError(`"${file}" is unreadable: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Checkpoints under `<dir>/checkpoints/<gig_id>.json`, alongside `outputs/` and `refs/`. */
export function createCheckpointStore(persistDir: string): CheckpointStore {
  const dir = path.join(persistDir, "checkpoints");
  return {
    read(gig_id) {
      // A gig id reaches this from a caller's argument; it must not be able to name a path.
      if (!/^[A-Za-z0-9._-]+$/.test(gig_id)) return undefined;
      return readJsonFile<GigCheckpoint>(path.join(dir, `${gig_id}.json`));
    },
    write(cp) {
      writeAtomic(path.join(dir, `${cp.gig_id}.json`), JSON.stringify(cp));
    },
    remove(gig_id) {
      // Same path guard as read(): a gig id arrives from a caller's argument and must not be
      // able to name a path. Doubly so here, where the operation DELETES.
      if (!/^[A-Za-z0-9._-]+$/.test(gig_id)) return;
      try { fs.rmSync(path.join(dir, `${gig_id}.json`), { force: true }); } catch { /* best-effort */ }
    },
  };
}

/** Reuse entries under `<dir>/reuse/<cache_key>.json`. Keys are sha256 hex — flat is fine. */
export function createReuseStore(persistDir: string): ReuseStore {
  const dir = path.join(persistDir, "reuse");
  return {
    get(cache_key) {
      if (!/^[0-9a-f]{64}$/.test(cache_key)) return undefined;
      return readJsonFile<ReuseEntry>(path.join(dir, `${cache_key}.json`));
    },
    put(entry) {
      writeAtomic(path.join(dir, `${entry.cache_key}.json`), JSON.stringify(entry));
    },
  };
}

/** An in-memory pair for tests and for a caller that wants reuse within one process. */
export function createMemoryCheckpointStore(): CheckpointStore {
  const m = new Map<string, string>();
  return {
    read: (id) => {
      const raw = m.get(id);
      return raw === undefined ? undefined : (JSON.parse(raw) as GigCheckpoint);
    },
    write: (cp) => void m.set(cp.gig_id, JSON.stringify(cp)),
    remove: (id) => void m.delete(id),
  };
}

export function createMemoryReuseStore(): ReuseStore {
  const m = new Map<string, string>();
  return {
    get: (k) => {
      const raw = m.get(k);
      return raw === undefined ? undefined : (JSON.parse(raw) as ReuseEntry);
    },
    put: (e) => void m.set(e.cache_key, JSON.stringify(e)),
  };
}
