// §13 pre-reg seal substrate — the discover→define seam mechanism.
//
// A pre-reg lives in one of two states:
//   - DRAFTED  — predict/kill/apoha mutable, iteration allowed
//   - SEALED   — sealed fields FROZEN at sealed_at; sha256_pre_verdict immutable
//
// The seal moment is the apoha-cut: before this call, refinement is allowed;
// after, the inscribed shape is committed and any observation appends rather
// than rewrites. The sha256_pre_verdict is the chain handle (per grid-DC §3.1
// voice-registry pattern + Heliograph PROGRAM.md R1).
//
// This module is the engine for problem-definer.md (lane=define, prereg_state=
// seal_fires). The MCP tool `prereg_seal` (src/mcp.ts) wraps `sealPreReg` and
// the dispatcher (src/server.ts) routes calls through the injected
// `PreRegLedger`.

import { canonJson, sha256Hex } from "./canonical_form.js";
import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The sealed-fields shape — the minimum a pre-reg must commit to. Domain
 * extensions add fields beside these; only the SEALED triplet enters the hash.
 *
 * predict — what we PREDICT will happen. Falsifiable: observable enough to be
 *           wrong in a specific way.
 * kill    — the condition that would make us STOP or roll back. Observable
 *           from data we will collect.
 * apoha   — what this pre-reg is explicitly NOT — the scope-bound. Named
 *           before action.
 */
export interface SealedFields {
  readonly predict: string;
  readonly kill: string;
  readonly apoha: string;
}

/**
 * A pre-reg's full shape. `state` is canonical:
 *   - `drafted` — sealed_at + pre_reg_hash are null; fields mutable
 *   - `sealed`  — sealed_at + pre_reg_hash set; SealedFields FROZEN
 */
export interface PreReg {
  readonly id: string;
  readonly kind: string;
  readonly sealed: SealedFields;
  readonly state: "drafted" | "sealed";
  readonly sealed_at: string | null;
  readonly sealed_by: string | null;
  readonly pre_reg_hash: string | null;
  // Open extension area — domain-specific fields ride here. Not included in
  // the hash; appendable post-seal.
  readonly observation?: Readonly<Record<string, unknown>>;
}

/**
 * The ledger entry for a sealed pre-reg. Append-only.
 */
export interface PreRegLedgerEntry {
  readonly pre_reg_id: string;
  readonly pre_reg_hash: string;
  readonly kind: string;
  readonly sealed_at: string;
  readonly sealed_by: string;
}

export interface PreRegLedger {
  append(entry: PreRegLedgerEntry): void;
  has(pre_reg_id: string): boolean;
  query(filter?: { kind?: string; sealed_by?: string }): PreRegLedgerEntry[];
  count(): number;
}

export class PreRegSealError extends Error {}

/**
 * Compute the sha256_pre_verdict over the canonical-JSON of the sealed triplet.
 * This is the immutable chain handle — equivalent to grid-DC §3.1's pattern.
 * Stable across whitespace, key ordering, and field reordering.
 */
export function computePreRegHash(sealed: SealedFields): string {
  // Canonical-JSON over only the sealed-field triplet — domain extensions DO
  // NOT enter the hash. This keeps the chain stable even as observations
  // accumulate post-seal.
  return sha256Hex(canonJson(sealed));
}

/**
 * Validate a SealedFields triplet's minimum content. Per the band's research-
 * methodology discipline: each field must be non-empty + meaningfully long
 * enough to be falsifiable.
 */
export function validateSealedFields(sealed: SealedFields): void {
  const checks: ReadonlyArray<[keyof SealedFields, string]> = [
    ["predict", "what observable outcome the work commits to producing"],
    ["kill", "what observation would prove the commitment was wrong"],
    ["apoha", "what this work explicitly is not"],
  ];
  for (const [field, hint] of checks) {
    const v = sealed[field];
    if (typeof v !== "string") throw new PreRegSealError(`sealed.${field} must be a string (${hint})`);
    if (v.trim().length < 10) throw new PreRegSealError(`sealed.${field} too short — must be ≥10 chars (${hint})`);
  }
}

export interface SealInput {
  readonly pre_reg_id: string;
  readonly kind: string;
  readonly sealed: SealedFields;
  readonly sealed_by: string;
  /** Optional clock injection for test determinism. Defaults to `new Date()`. */
  readonly now?: () => Date;
}

export interface SealResult {
  readonly pre_reg: PreReg;
  readonly ledger_entry: PreRegLedgerEntry;
}

/**
 * Seal a pre-reg: validate the sealed fields, compute the chain handle, write
 * to the ledger, and return the SEALED PreReg + the ledger entry it wrote.
 *
 * Throws PreRegSealError if:
 *   - any sealed field fails minimum-content validation
 *   - the pre_reg_id has already been sealed in this ledger (double-seal rejected)
 */
export function sealPreReg(input: SealInput, ledger: PreRegLedger): SealResult {
  validateSealedFields(input.sealed);
  if (ledger.has(input.pre_reg_id)) {
    throw new PreRegSealError(`pre-reg "${input.pre_reg_id}" is already sealed in this ledger`);
  }
  const now = (input.now ?? (() => new Date()))();
  const sealed_at = now.toISOString();
  const pre_reg_hash = computePreRegHash(input.sealed);

  const entry: PreRegLedgerEntry = {
    pre_reg_id: input.pre_reg_id,
    pre_reg_hash,
    kind: input.kind,
    sealed_at,
    sealed_by: input.sealed_by,
  };
  ledger.append(entry);

  const pre_reg: PreReg = {
    id: input.pre_reg_id,
    kind: input.kind,
    sealed: input.sealed,
    state: "sealed",
    sealed_at,
    sealed_by: input.sealed_by,
    pre_reg_hash,
  };
  return { pre_reg, ledger_entry: entry };
}

/**
 * Verify a previously-sealed pre-reg: recompute the hash from its sealed fields
 * and confirm it matches the stored pre_reg_hash. Detects tampering with the
 * frozen triplet.
 */
export function verifyPreRegSeal(pre_reg: PreReg): { valid: boolean; computed_hash: string } {
  if (pre_reg.state !== "sealed" || !pre_reg.pre_reg_hash) {
    return { valid: false, computed_hash: "" };
  }
  const computed_hash = computePreRegHash(pre_reg.sealed);
  return { valid: computed_hash === pre_reg.pre_reg_hash, computed_hash };
}

/* -------------------------- ledger implementations -------------------------- */

export class MemoryPreRegLedger implements PreRegLedger {
  private readonly entries: PreRegLedgerEntry[] = [];
  private readonly ids: Set<string> = new Set();

  append(entry: PreRegLedgerEntry): void {
    if (!entry.pre_reg_id) throw new PreRegSealError("ledger entry requires pre_reg_id");
    if (!entry.pre_reg_hash) throw new PreRegSealError("ledger entry requires pre_reg_hash");
    if (this.ids.has(entry.pre_reg_id)) {
      throw new PreRegSealError(`pre-reg "${entry.pre_reg_id}" already in ledger`);
    }
    this.entries.push(entry);
    this.ids.add(entry.pre_reg_id);
  }

  has(pre_reg_id: string): boolean {
    return this.ids.has(pre_reg_id);
  }

  query(filter: { kind?: string; sealed_by?: string } = {}): PreRegLedgerEntry[] {
    return this.entries.filter((e) => {
      if (filter.kind && e.kind !== filter.kind) return false;
      if (filter.sealed_by && e.sealed_by !== filter.sealed_by) return false;
      return true;
    });
  }

  count(): number {
    return this.entries.length;
  }
}

export class FilePreRegLedger implements PreRegLedger {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
  }

  append(entry: PreRegLedgerEntry): void {
    if (!entry.pre_reg_id) throw new PreRegSealError("ledger entry requires pre_reg_id");
    if (!entry.pre_reg_hash) throw new PreRegSealError("ledger entry requires pre_reg_hash");
    if (this.has(entry.pre_reg_id)) {
      throw new PreRegSealError(`pre-reg "${entry.pre_reg_id}" already in ledger`);
    }
    appendFileSync(this.path, JSON.stringify(entry) + "\n");
  }

  has(pre_reg_id: string): boolean {
    return this.query().some((e) => e.pre_reg_id === pre_reg_id);
  }

  query(filter: { kind?: string; sealed_by?: string } = {}): PreRegLedgerEntry[] {
    if (!existsSync(this.path)) return [];
    const lines = readFileSync(this.path, "utf-8").split("\n").filter((l) => l.length > 0);
    const out: PreRegLedgerEntry[] = [];
    for (const line of lines) {
      const e = JSON.parse(line) as PreRegLedgerEntry;
      if (filter.kind && e.kind !== filter.kind) continue;
      if (filter.sealed_by && e.sealed_by !== filter.sealed_by) continue;
      out.push(e);
    }
    return out;
  }

  count(): number {
    if (!existsSync(this.path)) return 0;
    return readFileSync(this.path, "utf-8").split("\n").filter((l) => l.length > 0).length;
  }
}
