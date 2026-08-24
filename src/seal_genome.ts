// WO-F07 Article I — `seal-genome`, the bulk-migration primitive.
//
// The WO-F06 orphan invariant (`coltrane validate` fails on a standards/|domain_types/|agents/ file
// with no `genome_mutation` seal in the git-tracked genome ledger) had no MIGRATION primitive. A
// pre-sealing genome — every file hand-authored or predating the sealed regime — is all orphans,
// and there was no command to bring it in-regime in bulk. `sealGenome` is that primitive: it
// iterates the blessed write path (`sealDefinition`, src/genome_writer.ts:69) over every genome file
// and, for each file not already sealed, records its `genome_mutation` seal.
//
// It seals IDENTITY, it does NOT rewrite content. `sealDefinition` re-serializes the parsed object
// as `JSON.stringify(def, null, 2) + "\n"`; for a genome already in that on-disk form,
// `writeGenomeFileVersioned` writes byte-identical content and snapshots no prior version. So a file
// that was already canonically serialized is byte-unchanged — only the ledger grows.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { canonJson, sha256Hex } from "./canonical_form.js";
import { sealDefinition, ORPHAN_SCAN_SUBDIRS } from "./genome_writer.js";
import type { Ledger, GenomeMutationLedgerEntry } from "./ledger.js";

/** What the bulk seal did, as genome-relative PATHS (not bare counts). Paths — not counts — so the
 *  caller can BOTH tally (`.length`) and NAME which file was sealed / skipped / failed: the CLI
 *  reports counts, and the slug-fold law must assert WHICH file was skipped. Per-file `errors` make
 *  the loop fault-tolerant — a malformed / non-canonicalisable file is reported without aborting the
 *  files after it. */
export interface SealGenomeReport {
  sealed: string[];
  skipped: string[];
  errors: Array<{ path: string; error: string }>;
}

/** The `genome_mutation` event each genome kind seals under — the MCP-tool-name convention
 *  `sealDefinition` already uses (agent_define / standard_compose / type_register). A per-kind event
 *  (not a single generic "seal_genome") keeps kind provenance in the audit trail. */
const KIND_EVENT: Record<(typeof ORPHAN_SCAN_SUBDIRS)[number], string> = {
  standards: "standard_compose",
  domain_types: "type_register",
  agents: "agent_define",
};

/** Fold `<slug>@v<n>` back to `<slug>` — a version-producing seal (agent_evolve / type_extend)
 *  records the versioned identity while still materialising the flat `<slug>.json`. IDENTICAL to the
 *  fold in detectGenomeOrphans (src/genome_writer.ts:260); if it diverged, a versioned-sealed file
 *  would read as an orphan here and be re-sealed, breaking idempotency. */
function baseSlug(subject_slug: string): string {
  return subject_slug.split("@")[0]!;
}

/**
 * Seal every genome file under standards/, domain_types/, agents/ that is not already sealed.
 *
 * A file is ALREADY SEALED when some `genome_mutation` entry carries a matching `content_hash` under
 * a subject_slug that folds to the file's base slug — the same identity `detectGenomeOrphans` reads.
 * Such files are SKIPPED (idempotent: a second run seals nothing). Otherwise the file's parsed def is
 * passed through `sealDefinition`, appending one seal keyed by the per-kind event and re-writing the
 * file byte-identically. Each file is wrapped so a malformed one is reported per-file, not fatal.
 */
export function sealGenome(genome_dir: string, ledger: Ledger): SealGenomeReport {
  const report: SealGenomeReport = { sealed: [], skipped: [], errors: [] };

  // The seal index: base slug → the set of content hashes already sealed under it. Queried once —
  // every file this run seals has a distinct slug, so no in-run entry can shadow a later file.
  const sealedHashes = new Map<string, Set<string>>();
  for (const e of ledger.query({ kind: "genome_mutation" })) {
    const entry = e as GenomeMutationLedgerEntry;
    if (typeof entry.subject_slug !== "string") continue;
    const slug = baseSlug(entry.subject_slug);
    let set = sealedHashes.get(slug);
    if (!set) { set = new Set(); sealedHashes.set(slug, set); }
    if (typeof entry.content_hash === "string") set.add(entry.content_hash);
  }

  for (const subdir of ORPHAN_SCAN_SUBDIRS) {
    const dir = join(genome_dir, subdir);
    if (!existsSync(dir)) continue;
    for (const dirent of readdirSync(dir, { withFileTypes: true })) {
      if (!dirent.isFile() || !dirent.name.endsWith(".json")) continue;
      const slug = dirent.name.slice(0, -".json".length);
      const rel = `${subdir}/${dirent.name}`;
      try {
        const def = JSON.parse(readFileSync(join(dir, dirent.name), "utf-8"));
        const content_hash = sha256Hex(canonJson(def));
        // Already sealed: an entry folding to this base slug carries this exact content hash.
        if (sealedHashes.get(slug)?.has(content_hash)) {
          report.skipped.push(rel);
          continue;
        }
        sealDefinition(KIND_EVENT[subdir], slug, def, ledger, genome_dir, subdir);
        report.sealed.push(rel);
      } catch (e) {
        report.errors.push({ path: rel, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  return report;
}
