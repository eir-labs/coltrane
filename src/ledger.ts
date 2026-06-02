import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface LedgerEntry {
  gig_id: string;
  standard_slug: string;
  genome_hash: string;
  run_fingerprint: string;
  output_hashes: readonly string[];
  started_at: string;
  finished_at: string;
}

export interface LedgerQuery {
  gig_id?: string;
  standard_slug?: string;
  genome_hash?: string;
  after?: string;
  before?: string;
}

export interface Ledger {
  append(entry: LedgerEntry): void;
  query(filter?: LedgerQuery): LedgerEntry[];
  count(): number;
}

export class LedgerError extends Error {}

export class FileLedger implements Ledger {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
  }

  append(entry: LedgerEntry): void {
    if (!entry.gig_id) throw new LedgerError("ledger entry requires gig_id");
    if (!entry.genome_hash) throw new LedgerError("ledger entry requires genome_hash");
    if (!entry.run_fingerprint) throw new LedgerError("ledger entry requires run_fingerprint");
    appendFileSync(this.path, JSON.stringify(entry) + "\n");
  }

  query(filter: LedgerQuery = {}): LedgerEntry[] {
    if (!existsSync(this.path)) return [];
    const lines = readFileSync(this.path, "utf-8").split("\n").filter((l) => l.length > 0);
    const out: LedgerEntry[] = [];
    for (const line of lines) {
      const e = JSON.parse(line) as LedgerEntry;
      if (filter.gig_id && e.gig_id !== filter.gig_id) continue;
      if (filter.standard_slug && e.standard_slug !== filter.standard_slug) continue;
      if (filter.genome_hash && e.genome_hash !== filter.genome_hash) continue;
      if (filter.after && e.started_at < filter.after) continue;
      if (filter.before && e.started_at > filter.before) continue;
      out.push(e);
    }
    return out;
  }

  count(): number {
    if (!existsSync(this.path)) return 0;
    return readFileSync(this.path, "utf-8")
      .split("\n")
      .filter((l) => l.length > 0).length;
  }
}

export class MemoryLedger implements Ledger {
  private readonly entries: LedgerEntry[] = [];

  append(entry: LedgerEntry): void {
    if (!entry.gig_id) throw new LedgerError("ledger entry requires gig_id");
    if (!entry.genome_hash) throw new LedgerError("ledger entry requires genome_hash");
    if (!entry.run_fingerprint) throw new LedgerError("ledger entry requires run_fingerprint");
    this.entries.push(entry);
  }

  query(filter: LedgerQuery = {}): LedgerEntry[] {
    return this.entries.filter((e) => {
      if (filter.gig_id && e.gig_id !== filter.gig_id) return false;
      if (filter.standard_slug && e.standard_slug !== filter.standard_slug) return false;
      if (filter.genome_hash && e.genome_hash !== filter.genome_hash) return false;
      if (filter.after && e.started_at < filter.after) return false;
      if (filter.before && e.started_at > filter.before) return false;
      return true;
    });
  }

  count(): number {
    return this.entries.length;
  }
}
