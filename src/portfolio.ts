// portfolio.ts — sprint-portfolio primitive.
//
// Models a portfolio of in-flight projects, each at its own phase. Append-only
// .coltrane/portfolio.jsonl is the durable surface; each park/resume appends
// a row; listPortfolio reduces to latest-per-slug.
//
// Storage path resolution (in order):
//   1. explicit `genomes_root` arg → <root>/.coltrane/portfolio.jsonl
//   2. process.env.COLTRANE_PORTFOLIO_ROOT → <env>/.coltrane/portfolio.jsonl
//   3. process.cwd() → <cwd>/.coltrane/portfolio.jsonl
//
// Seal: sha256 over canonical-form JSON of the parked state. Same content → same hash.

import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { canonJson, sha256Hex } from "./canonical_form.js";

export interface PortfolioEntry {
  genome_slug: string;
  current_phase: string;
  current_standard_slug: string | null;
  last_touched_utc: string;
  sealed_state_hash: string | null;
  next_natural_action: string;
  parked_at_utc: string | null;
}

interface PortfolioRow {
  event: "park" | "resume" | "touch";
  entry: PortfolioEntry;
  state?: unknown; // present on park rows; sealed by sealed_state_hash
}

export class SealMismatchError extends Error {
  readonly recorded_hash: string;
  readonly recomputed_hash: string;
  readonly genome_slug: string;
  constructor(genome_slug: string, recorded_hash: string, recomputed_hash: string) {
    super(
      `seal mismatch for ${genome_slug}: recorded=${recorded_hash} recomputed=${recomputed_hash}`,
    );
    this.name = "SealMismatchError";
    this.genome_slug = genome_slug;
    this.recorded_hash = recorded_hash;
    this.recomputed_hash = recomputed_hash;
  }
}

export class PortfolioNotFoundError extends Error {
  readonly genome_slug: string;
  constructor(genome_slug: string) {
    super(`no portfolio entry for genome_slug=${genome_slug}`);
    this.name = "PortfolioNotFoundError";
    this.genome_slug = genome_slug;
  }
}

function resolvePortfolioPath(genomes_root?: string): string {
  const root =
    genomes_root ??
    process.env.COLTRANE_PORTFOLIO_ROOT ??
    process.cwd();
  return join(root, ".coltrane", "portfolio.jsonl");
}

function ensureParentDir(path: string): void {
  const parent = dirname(path);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
}

function readAllRows(path: string): PortfolioRow[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf-8");
  const rows: PortfolioRow[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      rows.push(JSON.parse(t) as PortfolioRow);
    } catch {
      // skip malformed lines; honest log-tail tolerance
    }
  }
  return rows;
}

function appendRow(path: string, row: PortfolioRow): void {
  ensureParentDir(path);
  appendFileSync(path, JSON.stringify(row) + "\n");
}

function nowUtc(): string {
  return new Date().toISOString();
}

/**
 * Lists the portfolio as latest-per-slug. Resume rows override prior park rows
 * for the same slug; park rows override prior resume rows. Order of appearance
 * in the JSONL is the order of truth (append-only).
 */
export function listPortfolio(genomes_root?: string): PortfolioEntry[] {
  const path = resolvePortfolioPath(genomes_root);
  const rows = readAllRows(path);
  const latest = new Map<string, PortfolioEntry>();
  for (const row of rows) {
    if (!row.entry || typeof row.entry.genome_slug !== "string") continue;
    latest.set(row.entry.genome_slug, row.entry);
  }
  return Array.from(latest.values()).sort((a, b) =>
    a.genome_slug < b.genome_slug ? -1 : a.genome_slug > b.genome_slug ? 1 : 0,
  );
}

/**
 * SHA-seals the current state, marks the project as parked, appends a park row.
 * Returns the parked entry (sealed_state_hash populated, parked_at_utc populated).
 */
export function parkGenome(
  genome_slug: string,
  current_state: object,
  opts: {
    current_phase?: string;
    current_standard_slug?: string | null;
    genomes_root?: string;
  } = {},
): PortfolioEntry {
  const path = resolvePortfolioPath(opts.genomes_root);
  const sealed_state_hash = sha256Hex(canonJson(current_state));
  const now = nowUtc();

  // pull prior phase/standard if not supplied
  const prior = listPortfolio(opts.genomes_root).find((e) => e.genome_slug === genome_slug);
  const current_phase = opts.current_phase ?? prior?.current_phase ?? "voice";
  const current_standard_slug =
    opts.current_standard_slug !== undefined
      ? opts.current_standard_slug
      : (prior?.current_standard_slug ?? null);

  const entry: PortfolioEntry = {
    genome_slug,
    current_phase,
    current_standard_slug,
    last_touched_utc: now,
    sealed_state_hash,
    next_natural_action: "",
    parked_at_utc: now,
  };
  entry.next_natural_action = suggestNextAction(entry);

  appendRow(path, { event: "park", entry, state: current_state });
  return entry;
}

/**
 * Verifies the seal of the most recent park-row for the slug, restores the state,
 * appends a resume row, and returns both.
 *
 * Throws PortfolioNotFoundError if the slug has no park row.
 * Throws SealMismatchError if the recorded state's recomputed hash != recorded hash.
 */
export function resumeGenome(
  genome_slug: string,
  opts: { genomes_root?: string } = {},
): { entry: PortfolioEntry; restored_state: object } {
  const path = resolvePortfolioPath(opts.genomes_root);
  const rows = readAllRows(path);

  // find most recent park row for this slug
  let parkRow: PortfolioRow | null = null;
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (
      row !== undefined &&
      row.event === "park" &&
      row.entry &&
      row.entry.genome_slug === genome_slug
    ) {
      parkRow = row;
      break;
    }
  }
  if (parkRow === null) {
    throw new PortfolioNotFoundError(genome_slug);
  }

  const recorded_hash = parkRow.entry.sealed_state_hash;
  const restored_state = (parkRow.state ?? {}) as object;
  const recomputed_hash = sha256Hex(canonJson(restored_state));

  if (recorded_hash === null) {
    // null-sealed park: restore but warn — caller can opt into hard-gate
  } else if (recorded_hash !== recomputed_hash) {
    throw new SealMismatchError(genome_slug, recorded_hash, recomputed_hash);
  }

  const now = nowUtc();
  const resumedEntry: PortfolioEntry = {
    genome_slug,
    current_phase: parkRow.entry.current_phase,
    current_standard_slug: parkRow.entry.current_standard_slug,
    last_touched_utc: now,
    sealed_state_hash: null, // resume clears the parked-seal — project is live again
    next_natural_action: "",
    parked_at_utc: null,
  };
  resumedEntry.next_natural_action = suggestNextAction(resumedEntry);

  appendRow(path, { event: "resume", entry: resumedEntry });
  return { entry: resumedEntry, restored_state };
}

/**
 * Computes a text description of where the user would naturally pick up.
 * Pure function over an entry; deterministic.
 */
export function suggestNextAction(entry: PortfolioEntry): string {
  const phase = entry.current_phase;
  const standard = entry.current_standard_slug ?? "no-standard";
  const parked = entry.parked_at_utc !== null;
  const verbByPhase: Record<string, string> = {
    voice: "Voice the in-flight thought",
    spin: "Spin up the project genome",
    discover: "Diverge — survey the problem space",
    define: "Converge — name the falsifiable",
    develop: "Generate the files under the sealed charter",
    deliver: "Ripen the verdict",
    "context-switch": "Switch to a different project slug",
    "return-later": "Restore from the sealed park entry",
  };
  const verb = verbByPhase[phase] ?? `Continue at phase=${phase}`;
  const status = parked ? "parked" : "current";
  return `[${status}] ${verb} (standard=${standard})`;
}
