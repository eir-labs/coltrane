import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

// Actual model spend for a gig, captured from each agent invocation's stream-json `result`
// event (input/output tokens + total_cost_usd + per-model breakdown). This is SETTLED spend —
// distinct from pricing.ts, which ESTIMATES pre-flight. Optional: skill-only gigs (no model
// invocation) and the unit suites that stub the invoker carry no usage.
export interface GigUsage {
  input_tokens: number;
  output_tokens: number;
  total_cost_usd: number;
  /** actual model id → its spend (the model that ran, not just the configured tier). */
  by_model: Record<string, { input_tokens: number; output_tokens: number; cost_usd: number }>;

  // ── attribution (#235) ────────────────────────────────────────────────────────────────────
  // The scalars above used to be reported with no indication of how much of the gig they
  // covered. One boolean (`sawUsage`) gated persistence, flipped by the FIRST result event, so
  // a six-phase gig where five children were SIGKILLed and one completed persisted one chair's
  // cost as the gig's settled spend — and it read as complete. These four fields make the
  // difference between "captured everything", "captured some", and "captured nothing"
  // expressible. All four are absent on ledger rows written before this accounting existed;
  // absence means "unknown coverage", not "complete".

  /** Model invocations this gig STARTED (skill-backed chairs run no model and are not counted). */
  invocations?: number;
  /** Of those, how many produced no usable usage payload. Their spend is UNKNOWN, not zero. */
  unattributed_invocations?: number;
  /** Set ONLY when unattributed_invocations > 0: the scalars above are a LOWER BOUND. */
  partial?: true;
  /** Set ONLY when ≥1 attributed invocation carried no `modelUsage` breakdown: `by_model` does
   *  not account for the whole of `total_cost_usd` and is itself a LOWER BOUND. */
  by_model_partial?: true;
}

/**
 * The ledger records three classes of event, not one (#212).
 *
 * v1 modelled exactly one — *a gig finished* — so every other event class was smuggled into
 * that shape: the event kind stuffed into `standard_slug`, the event class into a `:`-prefix
 * on `gig_id`, and the sentinel `"n/a"` into the identity fields, with the payload dropped
 * entirely. Seven of twelve append sites wrote `"n/a"`.
 *
 * The discriminated union makes that unrepresentable rather than merely discouraged:
 * `genome_hash`/`run_fingerprint` exist ONLY on `kind:"gig"`, so there is nowhere to put a
 * sentinel on a promotion or an abort.
 */
export type LedgerEntryKind = "gig" | "genome_mutation" | "governance";

export const LEDGER_SCHEMA_VERSION = 2;

/** sha256, lowercase — what canonical_form actually emits (src/canonical_form.ts:29-31). */
const HEX64 = /^[0-9a-f]{64}$/;

interface LedgerEntryBase {
  schema_version: typeof LEDGER_SCHEMA_VERSION;
  /** This ROW's identity. v1 overloaded `gig_id` for it, which is why non-gig rows needed a
   *  synthetic `promote:<uuid>` / `abort:<gid>` namespace. */
  entry_id: string;
  kind: LedgerEntryKind;
  output_hashes: readonly string[];
  started_at: string;
  finished_at: string;
  /** Set ONLY by the read-side v1 upgrade. Without this marker the upgrade would launder a
   *  known gap into apparent completeness — the same class of dishonesty as `"n/a"` itself. */
  legacy?: true;
  /**
   * WHO asked for this. Optional, caller-supplied, and **provenance only**.
   *
   * The ledger already answers *what produced this and from what* — `content_sha`,
   * `input_shas`, `skill_provenance`, `genome_hash`, `run_fingerprint`. It answered *who
   * initiated it* nowhere. `principal` is the same category of fact as the rest of that list,
   * which is the whole reason it sits on the base rather than on one arm: a run, a genome
   * mutation, and a governance act can each have an initiator.
   *
   * **This is NOT an access control, and must not be read as one.** The engine records it and
   * never looks at it: it is deliberately absent from `LedgerQuery`, no read handler consults
   * it, and nothing filters on it. That is the architecture, not an oversight —
   * `src/hooks.ts:1-9` states the engine provides "ONLY these types + the loop… ZERO built-in
   * hooks… Everything opinionated lives in the wrapper." Tenancy enforcement is the consumer's
   * job. If you are here because you want rows scoped by principal, that scoping belongs in
   * the wrapper reading the ledger, not in the engine writing it.
   *
   * Landed inside the v1→v2 bump precisely because it is free here: additive, unset by every
   * current call site, and needing no new upgrade arm. Adding it after v2 shipped would have
   * cost a `schema_version: 3` and a second arm in `upgradeV1` for a purely additive field.
   */
  principal?: string;
}

/** A run completed. The only class that carries reproducibility identity. */
export interface GigLedgerEntry extends LedgerEntryBase {
  kind: "gig";
  gig_id: string;
  standard_slug: string;
  genome_hash: string;
  run_fingerprint: string;
  // Settled model spend (#195). Present for gigs with ≥1 real model invocation; the result
  // events carry it (usage + total_cost_usd) and it used to be forwarded-but-dropped.
  usage?: GigUsage;
}

/** A definition entered the substrate. Identity is the canonical hash chain, NOT a run
 *  fingerprint — src/genome_writer.ts used to copy `effective_hash` into both, which was a
 *  small lie: an effective hash is not a run fingerprint. */
export interface GenomeMutationLedgerEntry extends LedgerEntryBase {
  kind: "genome_mutation";
  /** agent_define | agent_evolve | standard_compose | type_register | type_extend | skill_define */
  event: string;
  /** WHICH definition was sealed. v1 buried this in a `:`-delimited gig_id. */
  subject_slug: string;
  content_hash: string;
  dependency_hash?: string;
  effective_hash: string;
}

/** A governance act: a promotion, a registration, a review, a proposal, an abort. */
export interface GovernanceLedgerEntry extends LedgerEntryBase {
  kind: "governance";
  event: string;
  /** WHICH entity the act was about — the promoted slug, the registered tool, the reviewed
   *  agent. v1 recorded none of these. */
  subject_slug: string;
  /** The real gig this act concerns (an abort, a review). First-class so `query({subject_gig_id})`
   *  answers "what happened to gig X" — v1 filed aborts under a synthetic `abort:<gid>` that
   *  exact-equality filtering could never return (#213). */
  subject_gig_id?: string;
  /** The payload. v1 dropped it entirely, leaving a durable trail of content-free UUIDs. */
  detail?: Record<string, unknown>;
}

export type LedgerEntry = GigLedgerEntry | GenomeMutationLedgerEntry | GovernanceLedgerEntry;

export interface LedgerQuery {
  kind?: LedgerEntryKind;
  event?: string;
  subject_slug?: string;
  subject_gig_id?: string;
  gig_id?: string;
  standard_slug?: string;
  genome_hash?: string;
  effective_hash?: string;
  after?: string;
  before?: string;
}

/** One damaged line, located. Skip-and-REPORT: silently dropping a row would let corruption
 *  hide an entry, which is the wrong remedy for an audit trail (contrast src/outputs.ts:180-184). */
export interface LedgerCorruption {
  line_no: number;
  reason: string;
  preview: string;
}

export interface LedgerIntegrityReport {
  ok: boolean;
  path: string;
  entries: number;
  corrupt: LedgerCorruption[];
}

/** Filters that can only ever match a gig row: the discriminator itself, or a field that
 *  exists solely on the gig arm. Narrowing on these is what lets `query({gig_id})[0].usage`
 *  type-check without a cast at every read site. */
export type GigOnlyQuery =
  | (LedgerQuery & { kind: "gig" })
  | (LedgerQuery & { gig_id: string })
  | (LedgerQuery & { standard_slug: string })
  | (LedgerQuery & { genome_hash: string });

// NOTE: the narrowing overloads live on the CONCRETE classes, not here. Keeping the interface
// to one signature per method is what lets a caller implement `Ledger` in three lines (the
// #218 fault-injection double does exactly that); an overloaded interface would force every
// implementor to restate all four signatures for no benefit.
export interface Ledger {
  append(entry: LedgerEntry): void;
  query(filter?: LedgerQuery): LedgerEntry[];
  count(filter?: LedgerQuery): number;
}

export class LedgerError extends Error {}

// Narrowing helpers for consumers holding the `Ledger` interface (whose query() returns the
// union). The concrete classes narrow via overload; these cover the interface-typed path.
export const isGig = (e: LedgerEntry): e is GigLedgerEntry => e.kind === "gig";
export const isGenomeMutation = (e: LedgerEntry): e is GenomeMutationLedgerEntry =>
  e.kind === "genome_mutation";
export const isGovernance = (e: LedgerEntry): e is GovernanceLedgerEntry => e.kind === "governance";

/**
 * Resolve the ledger file. `COLTRANE_LEDGER_PATH` wins; otherwise `<root>/.coltrane/ledger.jsonl`.
 *
 * Genome-scoped, deliberately NOT `$HOME`-global like `defaultOutputsPersistDir` (#210): a
 * `genome_hash` is only meaningful relative to a genome and `standard_slug` is not namespaced,
 * so a global ledger would interleave rows from every genome the operator has ever run and
 * `query({standard_slug})` would return unrelated genomes' runs as one history. Outputs
 * tolerate a global root only because they are sharded into per-gig_id files.
 * `.gitignore` already carries `.coltrane/`.
 */
export function defaultLedgerPath(root?: string): string {
  const override = process.env["COLTRANE_LEDGER_PATH"];
  if (override && override.length > 0) return override;
  return join(root ?? process.cwd(), ".coltrane", "ledger.jsonl");
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function requireHex(row: Record<string, unknown>, field: string, kind: string): void {
  const v = row[field];
  if (typeof v !== "string" || !HEX64.test(v)) {
    throw new LedgerError(
      `${kind} entry requires ${field} to be 64 lowercase hex (sha256); got ${JSON.stringify(v)}. ` +
        "Non-emptiness was the v1 guard, and it is exactly what let 7 call sites write \"n/a\".",
    );
  }
}

/** Gig identity on a non-gig row is not "discouraged", it is invalid — that is what makes the
 *  sentinel unrepresentable rather than merely absent by convention. */
function rejectGigIdentity(row: Record<string, unknown>, kind: string): void {
  for (const field of ["genome_hash", "run_fingerprint"] as const) {
    if (row[field] !== undefined) {
      throw new LedgerError(
        `${kind} entry must not carry ${field} — reproducibility identity is gig-only. ` +
          "A promotion is not a run.",
      );
    }
  }
}

/**
 * THE shared validator. Both implementations call this; the duplicated guard triplet it
 * replaces (v1 `src/ledger.ts:56-58` and `:102-104`) is how the MemoryLedger/FileLedger
 * immutability divergence in #214 crept in unnoticed.
 */
export function validateEntry(entry: LedgerEntry): void {
  const row = entry as unknown as Record<string, unknown>;
  const kind = row["kind"];
  if (kind !== "gig" && kind !== "genome_mutation" && kind !== "governance") {
    throw new LedgerError(
      `ledger entry requires kind ∈ {gig, genome_mutation, governance}; got ${JSON.stringify(kind)}`,
    );
  }
  if (!isNonEmptyString(row["entry_id"])) throw new LedgerError("ledger entry requires entry_id");
  if (!isNonEmptyString(row["started_at"])) throw new LedgerError("ledger entry requires started_at");
  if (!isNonEmptyString(row["finished_at"])) throw new LedgerError("ledger entry requires finished_at");
  if (!Array.isArray(row["output_hashes"])) throw new LedgerError("ledger entry requires output_hashes");

  if (kind === "gig") {
    if (!isNonEmptyString(row["gig_id"])) throw new LedgerError("gig entry requires gig_id");
    if (!isNonEmptyString(row["standard_slug"])) throw new LedgerError("gig entry requires standard_slug");
    requireHex(row, "genome_hash", "gig");
    requireHex(row, "run_fingerprint", "gig");
    return;
  }

  if (!isNonEmptyString(row["event"])) throw new LedgerError(`${kind} entry requires event`);
  if (!isNonEmptyString(row["subject_slug"])) {
    throw new LedgerError(
      `${kind} entry requires subject_slug — WHICH entity the event was about. ` +
        "v1 recorded a bare UUID and no subject at all.",
    );
  }
  rejectGigIdentity(row, kind);
  if (kind === "genome_mutation") {
    requireHex(row, "content_hash", "genome_mutation");
    requireHex(row, "effective_hash", "genome_mutation");
  }
}

/** Deep copy, so neither implementation hands out a live reference (#214). */
function freezeCopy(entry: LedgerEntry): LedgerEntry {
  return structuredClone(entry);
}

function matches(entry: LedgerEntry, filter: LedgerQuery): boolean {
  const e = entry as unknown as Record<string, unknown>;
  if (filter.kind && e["kind"] !== filter.kind) return false;
  if (filter.event && e["event"] !== filter.event) return false;
  if (filter.subject_slug && e["subject_slug"] !== filter.subject_slug) return false;
  if (filter.subject_gig_id && e["subject_gig_id"] !== filter.subject_gig_id) return false;
  if (filter.gig_id && e["gig_id"] !== filter.gig_id) return false;
  if (filter.standard_slug && e["standard_slug"] !== filter.standard_slug) return false;
  if (filter.genome_hash && e["genome_hash"] !== filter.genome_hash) return false;
  if (filter.effective_hash && e["effective_hash"] !== filter.effective_hash) return false;
  if (filter.after && String(e["started_at"]) < filter.after) return false;
  if (filter.before && String(e["started_at"]) > filter.before) return false;
  return true;
}

// ── v1 read-side upgrade ────────────────────────────────────────────────────
// v1 rows are upgraded to the v2 VIEW on read. The file is NEVER rewritten: an append-only
// ledger that silently self-heals is indistinguishable from one that was tampered with.

/** v1 governance rows keyed `standard_slug` to the MCP tool name. */
const V1_GOVERNANCE_EVENTS = new Set([
  "charter_suggest_update", "proposal_create", "gig_abort", "tool_register",
  "agent_promote", "standard_promote", "skill_promote",
  "session_review_write", "learning_synthesize",
]);

const V1_MUTATION_EVENTS = new Set([
  "agent_define", "agent_evolve", "standard_compose",
  "type_register", "type_extend", "skill_define",
]);

function upgradeV1(row: Record<string, unknown>): LedgerEntry {
  const event = typeof row["standard_slug"] === "string" ? row["standard_slug"] : "";
  const gig_id = typeof row["gig_id"] === "string" ? row["gig_id"] : "";
  const started_at = typeof row["started_at"] === "string" ? row["started_at"] : "";
  // NOTE: `principal` is deliberately left undefined here. A v1 row genuinely has no
  // principal — the field did not exist when it was written — and inventing one (from a
  // process owner, an env var, "unknown") would fabricate provenance, which is exactly the
  // dishonesty `legacy: true` exists to prevent. Absent means absent.
  const base = {
    schema_version: LEDGER_SCHEMA_VERSION,
    entry_id: gig_id,
    output_hashes: Array.isArray(row["output_hashes"]) ? (row["output_hashes"] as string[]) : [],
    started_at,
    finished_at: typeof row["finished_at"] === "string" ? row["finished_at"] : started_at,
    legacy: true,
  } as const;

  if (V1_GOVERNANCE_EVENTS.has(event)) {
    // `abort:<gid>` is the only v1 governance namespace whose subject is recoverable. The
    // rest genuinely recorded nothing — leaving subject_slug absent is the honest result, and
    // `legacy: true` is what says so.
    const subject_gig_id = gig_id.startsWith("abort:") ? gig_id.slice("abort:".length) : undefined;
    return {
      ...base, kind: "governance", event,
      ...(subject_gig_id ? { subject_gig_id } : {}),
    } as unknown as LedgerEntry;
  }

  if (V1_MUTATION_EVENTS.has(event)) {
    const gh = row["genome_hash"];
    const oh = base.output_hashes;
    return {
      ...base, kind: "genome_mutation", event,
      ...(typeof gh === "string" && HEX64.test(gh) ? { effective_hash: gh } : {}),
      ...(typeof oh[0] === "string" && HEX64.test(oh[0]) ? { content_hash: oh[0] } : {}),
    } as unknown as LedgerEntry;
  }

  // A real run. Identity is carried forward verbatim — never fabricated, never "n/a".
  const gh = row["genome_hash"];
  const rf = row["run_fingerprint"];
  return {
    ...base, kind: "gig", gig_id,
    standard_slug: event,
    ...(typeof gh === "string" && gh !== "n/a" ? { genome_hash: gh } : {}),
    ...(typeof rf === "string" && rf !== "n/a" ? { run_fingerprint: rf } : {}),
    ...(row["usage"] ? { usage: row["usage"] } : {}),
  } as unknown as LedgerEntry;
}

/** Parse one JSONL line into a v2 row view, or explain why it cannot be. */
function parseLine(line: string): { entry?: LedgerEntry; reason?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (e) {
    return { reason: `unparseable JSON: ${(e as Error).message}` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    // `42` and `null` parse fine and would otherwise be handed to execution_history_read as
    // an "execution" — src/ledger.ts:79 was an unchecked cast.
    return { reason: `line is ${parsed === null ? "null" : typeof parsed}, not a ledger row` };
  }
  const row = parsed as Record<string, unknown>;
  if (row["kind"] === undefined && row["schema_version"] === undefined) {
    return { entry: upgradeV1(row) };
  }
  return { entry: row as unknown as LedgerEntry };
}

// Both implementations expose their methods as bound arrow properties rather than prototype
// methods. `deps.ledger.query` is routinely passed around and destructured, and a detached
// `const q = ledger.query; q(...)` would otherwise throw on `this` — a footgun with no upside
// for an object that is always used as a service handle, never as a prototype.

export class FileLedger implements Ledger {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
    // Bound so a detached `const q = ledger.query; q(...)` works. `deps.ledger` is a service
    // handle that gets passed around and destructured, never used as a prototype.
    this.append = this.append.bind(this);
    this.query = this.query.bind(this) as typeof this.query;
    this.count = this.count.bind(this);
    this.integrity = this.integrity.bind(this);
    // NOTE: no eager mkdir. bootstrapServerDeps() with no root resolves to process.cwd(), so
    // constructing the production ledger must not seed `.coltrane/` into the developer's
    // checkout just because something built a ServerDeps. The directory is created on the
    // first append instead.
  }

  append(entry: LedgerEntry): void {
    validateEntry(entry);
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, JSON.stringify(entry) + "\n");
    } catch (e) {
      // Wrap raw fs failures (EACCES / EPERM / EROFS / ENOSPC) in a typed
      // LedgerError so callers see a structured error, not a leaking SystemError.
      // The append is stateless — once the path is writable again, a retry on the
      // same instance succeeds (no cached fd to reset).
      const sys = e as NodeJS.ErrnoException;
      const err = new LedgerError(`failed to append to ledger at ${this.path}: ${sys.message}`);
      (err as { cause?: unknown }).cause = e;
      if (sys.code !== undefined) (err as { code?: string }).code = sys.code;
      throw err;
    }
  }

  /** Single read pass shared by query / count / integrity, so the three can never disagree
   *  about what the file contains (v1 `count()` never parsed, so it reported a healthy total
   *  for a ledger `query()` could not open). */
  private read(): { entries: LedgerEntry[]; corrupt: LedgerCorruption[] } {
    const entries: LedgerEntry[] = [];
    const corrupt: LedgerCorruption[] = [];
    if (!existsSync(this.path)) return { entries, corrupt };
    const lines = readFileSync(this.path, "utf-8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i]!;
      // `.trim()`, not `.length > 0` — a lone `\r` from a CRLF file is length 1 and would
      // otherwise reach JSON.parse (contrast the v1 filter).
      const line = raw.trim();
      if (line.length === 0) continue;
      const { entry, reason } = parseLine(line);
      if (entry) entries.push(entry);
      else corrupt.push({ line_no: i + 1, reason: reason ?? "unreadable", preview: line.slice(0, 120) });
    }
    return { entries, corrupt };
  }

  query(filter: GigOnlyQuery): GigLedgerEntry[];
  query(filter: LedgerQuery & { kind: "genome_mutation" }): GenomeMutationLedgerEntry[];
  query(filter: LedgerQuery & { kind: "governance" }): GovernanceLedgerEntry[];
  query(filter?: LedgerQuery): LedgerEntry[];
  query(filter: LedgerQuery = {}): LedgerEntry[] {
    return this.read().entries.filter((e) => matches(e, filter));
  }

  count(filter: LedgerQuery = {}): number {
    return this.read().entries.filter((e) => matches(e, filter)).length;
  }

  /**
   * Skip-and-REPORT. A silent skip (the src/outputs.ts:180-184 shape) is the wrong remedy for
   * an audit trail: it lets a single corrupted byte delete a row with no trace. `query()`
   * keeps serving the intact rows; this is how an operator learns the ledger is damaged.
   */
  integrity(): LedgerIntegrityReport {
    const { entries, corrupt } = this.read();
    return { ok: corrupt.length === 0, path: this.path, entries: entries.length, corrupt };
  }
}

export class MemoryLedger implements Ledger {
  private readonly entries: LedgerEntry[] = [];

  constructor() {
    this.append = this.append.bind(this);
    this.query = this.query.bind(this) as typeof this.query;
    this.count = this.count.bind(this);
  }

  append(entry: LedgerEntry): void {
    validateEntry(entry);
    // Clone IN: v1 pushed the caller's object, so a caller that reused or mutated an entry
    // after append() silently rewrote sealed history (#214).
    this.entries.push(freezeCopy(entry));
  }

  query(filter: GigOnlyQuery): GigLedgerEntry[];
  query(filter: LedgerQuery & { kind: "genome_mutation" }): GenomeMutationLedgerEntry[];
  query(filter: LedgerQuery & { kind: "governance" }): GovernanceLedgerEntry[];
  query(filter?: LedgerQuery): LedgerEntry[];
  query(filter: LedgerQuery = {}): LedgerEntry[] {
    // Clone OUT: v1 returned live references, so `ledger.query()[0].genome_hash = "forged"`
    // rewrote history in place. FileLedger was immune only by accident of serialization —
    // the two implementations of one interface had different immutability semantics.
    return this.entries.filter((e) => matches(e, filter)).map(freezeCopy);
  }

  count(filter: LedgerQuery = {}): number {
    return this.entries.filter((e) => matches(e, filter)).length;
  }
}
