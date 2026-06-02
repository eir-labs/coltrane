import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";

export interface SubthreadEntry {
  session_id: string;
  turn_idx: number;
  parent_session_id: string | null;
  api_version: string;
  genome_hash: string;
  run_fingerprint: string;
  tool_call_sequence: string[];
  started_at: string;
  finished_at: string | null;
  // Non-empty only when a typed seam error is recorded (e.g. api_version_mismatch).
  error?: string;
  observability_log?: Record<string, unknown>;
}

export interface RecorderOptions {
  path: string;
  session_id: string;
  parent_session_id?: string | null | undefined;
  api_version: string;
  genome_hash: string;
  run_fingerprint: string;
}

export class ApiVersionMismatchError extends Error {
  readonly recorded: string;
  readonly current: string;
  constructor(recorded: string, current: string) {
    super(`api_version_mismatch: recorded=${recorded} current=${current}`);
    this.name = "ApiVersionMismatchError";
    this.recorded = recorded;
    this.current = current;
  }
}

function readAllEntries(path: string): SubthreadEntry[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf-8").split("\n").filter((l) => l.length > 0);
  const out: SubthreadEntry[] = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line) as SubthreadEntry);
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

function writeAllEntries(path: string, entries: readonly SubthreadEntry[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const body = entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length > 0 ? "\n" : "");
  writeFileSync(path, body);
}

/**
 * A file-backed recorder that captures one entry per sub-thread turn, keyed on
 * session_id. Each turn is one server lifetime; resume across lifetimes increments
 * turn_idx. Entries carry deterministic provenance fields (genome_hash,
 * run_fingerprint, tool_call_sequence) plus lifecycle timestamps that callers
 * can exclude from hash-stability checks.
 */
export class SubthreadRecorder {
  readonly path: string;
  readonly session_id: string;
  readonly parent_session_id: string | null;
  readonly api_version: string;
  readonly genome_hash: string;
  readonly run_fingerprint: string;
  readonly turn_idx: number;

  private tool_call_sequence: string[] = [];
  private observability_log: Record<string, unknown> = {};
  private started_at: string;
  private finished_at: string | null = null;
  private error: string | null = null;
  private flushed = false;

  private constructor(opts: RecorderOptions, turn_idx: number) {
    this.path = opts.path;
    this.session_id = opts.session_id;
    this.parent_session_id = opts.parent_session_id ?? null;
    this.api_version = opts.api_version;
    this.genome_hash = opts.genome_hash;
    this.run_fingerprint = opts.run_fingerprint;
    this.turn_idx = turn_idx;
    this.started_at = new Date().toISOString();
  }

  /**
   * Open a recorder for this server lifetime. Detects api_version mismatch
   * against prior turns for the same session_id and throws
   * `ApiVersionMismatchError`; the typed error is also sealed into the recorder
   * before throwing so the failure is auditable.
   */
  static open(opts: RecorderOptions): SubthreadRecorder {
    const prior = readAllEntries(opts.path).filter((e) => e.session_id === opts.session_id);
    const turn_idx = prior.length;
    if (prior.length > 0) {
      const firstApi = prior[0]!.api_version;
      if (firstApi !== opts.api_version) {
        const mismatchEntry: SubthreadEntry = {
          session_id: opts.session_id,
          turn_idx,
          parent_session_id: opts.parent_session_id ?? null,
          api_version: opts.api_version,
          genome_hash: opts.genome_hash,
          run_fingerprint: opts.run_fingerprint,
          tool_call_sequence: [],
          started_at: new Date().toISOString(),
          finished_at: new Date().toISOString(),
          error: `api_version_mismatch: recorded=${firstApi} current=${opts.api_version}`,
        };
        appendFileSync(opts.path, JSON.stringify(mismatchEntry) + "\n");
        throw new ApiVersionMismatchError(firstApi, opts.api_version);
      }
    }
    const rec = new SubthreadRecorder(opts, turn_idx);
    rec.persist();
    return rec;
  }

  recordToolCall(name: string): void {
    if (this.flushed) return;
    this.tool_call_sequence.push(name);
    this.persist();
  }

  recordObservability(key: string, value: unknown): void {
    if (this.flushed) return;
    this.observability_log[key] = value;
    this.persist();
  }

  flush(): void {
    if (this.flushed) return;
    this.finished_at = new Date().toISOString();
    this.flushed = true;
    this.persist();
  }

  private current(): SubthreadEntry {
    const entry: SubthreadEntry = {
      session_id: this.session_id,
      turn_idx: this.turn_idx,
      parent_session_id: this.parent_session_id,
      api_version: this.api_version,
      genome_hash: this.genome_hash,
      run_fingerprint: this.run_fingerprint,
      tool_call_sequence: [...this.tool_call_sequence],
      started_at: this.started_at,
      finished_at: this.finished_at,
      observability_log: { ...this.observability_log },
    };
    if (this.error) entry.error = this.error;
    return entry;
  }

  private persist(): void {
    const all = readAllEntries(this.path);
    const idx = all.findIndex(
      (e) => e.session_id === this.session_id && e.turn_idx === this.turn_idx,
    );
    const next = this.current();
    if (idx >= 0) all[idx] = next;
    else all.push(next);
    writeAllEntries(this.path, all);
  }
}

/**
 * Stable hash over a recorder file scoped to deterministic provenance fields —
 * excludes session_id (varies per Claude session), timestamps, and observability
 * payloads. Used by reproducibility checks to compare two runs against the same
 * genome.
 */
export function hashRecorderDeterministicFields(path: string): string {
  const entries = readAllEntries(path);
  if (entries.length === 0) return "EMPTY";
  const scoped = entries.map((e) => ({
    turn_idx: e.turn_idx,
    api_version: e.api_version,
    genome_hash: e.genome_hash,
    run_fingerprint: e.run_fingerprint,
    tool_call_sequence: e.tool_call_sequence,
    parent_present: e.parent_session_id !== null,
  }));
  // Order by turn_idx so resume-order matters but session-id-suffix doesn't leak in.
  scoped.sort((a, b) => a.turn_idx - b.turn_idx);
  return createHash("sha256").update(JSON.stringify(scoped)).digest("hex");
}
