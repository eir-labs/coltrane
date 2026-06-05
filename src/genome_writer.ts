// MCP-sole-writer + canonical identity sealing (the substrate-of-truth loop, O26).
// A definition's identity is its canonical hash chain (content → dependency → effective),
// NOT its bytes. sealAgentDefinition is the blessed write path: validate → hash → (when a
// genome_dir is given) write the content-addressed file AND append a ledger entry keyed
// standard_slug="agent_define", genome_hash=effective_hash. A hand-edited file with no
// such ledger entry is an orphan — no identity, outside the substrate.
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { defineAgent, type Agent, type AgentDef } from "./composition.js";
import { canonJson, sha256Hex, effectiveHash, EMPTY_DEPENDENCY_HASH } from "./canonical_form.js";
import type { Ledger } from "./ledger.js";

/**
 * Write a genome file, preserving any prior version's BYTES before a destructive
 * overwrite. The ledger already keeps the content-hash *identity* of every seal;
 * this keeps the actual prior *content*, so a re-compose / re-define / evolve over
 * an existing slug is recoverable, not just provably-changed.
 *
 * When <subdir>/<slug>.json already exists with DIFFERENT bytes, the old bytes are
 * snapshotted to .coltrane/history/<subdir>/<slug>/<oldContentHash>.json (gitignored,
 * local) before the overwrite. Identical bytes → no snapshot (idempotent no-op).
 * Returns the prior content hash when an overwrite displaced real content.
 */
export function writeGenomeFileVersioned(
  genome_dir: string,
  subdir: string,
  slug: string,
  jsonText: string,
): { overwritten: boolean; prior_content_hash?: string } {
  const dir = join(genome_dir, subdir);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${slug}.json`);
  let result: { overwritten: boolean; prior_content_hash?: string } = { overwritten: false };
  if (existsSync(path)) {
    const oldBytes = readFileSync(path, "utf-8");
    if (oldBytes !== jsonText) {
      const prior = sha256Hex(oldBytes);
      const histDir = join(genome_dir, ".coltrane", "history", subdir, slug);
      mkdirSync(histDir, { recursive: true });
      writeFileSync(join(histDir, `${prior}.json`), oldBytes);
      result = { overwritten: true, prior_content_hash: prior };
    }
  }
  writeFileSync(path, jsonText);
  return result;
}

export interface SealResult {
  agent: Agent;
  content_hash: string;
  dependency_hash: string;
  effective_hash: string;
}

/** Generic substrate seal for ANY genome definition (agent / standard / type / skill).
 *  Computes the canonical identity, and when a genome_dir is given, writes the
 *  content-addressed file under <subdir>/<slug>.json AND appends the ledger seal keyed
 *  standard_slug=<kind>, genome_hash=effective_hash. The single blessed write path. */
export function sealDefinition(
  kind: string,
  slug: string,
  def: unknown,
  ledger: Ledger,
  genome_dir: string | undefined,
  subdir: string,
): { content_hash: string; dependency_hash: string; effective_hash: string } {
  const content_hash = sha256Hex(canonJson(def));
  const dependency_hash = EMPTY_DEPENDENCY_HASH;
  const effective_hash = effectiveHash(content_hash, dependency_hash);
  if (genome_dir) {
    writeGenomeFileVersioned(genome_dir, subdir, slug, JSON.stringify(def, null, 2) + "\n");
    const now = new Date().toISOString();
    ledger.append({
      gig_id: `${kind}:${slug}:${randomUUID()}`,
      standard_slug: kind,
      genome_hash: effective_hash,
      run_fingerprint: effective_hash,
      output_hashes: [content_hash],
      started_at: now,
      finished_at: now,
    });
  }
  return { content_hash, dependency_hash, effective_hash };
}

/** Ledger-only identity seal — for version-producing mutations (type_extend, agent_evolve)
 *  whose new-version FILE materialization needs version-aware loader support (the one named
 *  boundary). The identity is still sealed in the append-only ledger, so the mutation is
 *  never a contract lie: its effective_hash is recorded even before the file lands. */
export function recordIdentity(kind: string, slug: string, def: unknown, ledger: Ledger): { content_hash: string; dependency_hash: string; effective_hash: string } {
  const content_hash = sha256Hex(canonJson(def));
  const dependency_hash = EMPTY_DEPENDENCY_HASH;
  const effective_hash = effectiveHash(content_hash, dependency_hash);
  const now = new Date().toISOString();
  ledger.append({
    gig_id: `${kind}:${slug}:${randomUUID()}`,
    standard_slug: kind,
    genome_hash: effective_hash,
    run_fingerprint: effective_hash,
    output_hashes: [content_hash],
    started_at: now,
    finished_at: now,
  });
  return { content_hash, dependency_hash, effective_hash };
}

/** The canonical identity of an agent definition. PURE + deterministic from the def, so
 *  the same input always yields the same effective_hash (cross-machine interoperable). */
export function agentIdentity(def: AgentDef): { content_hash: string; dependency_hash: string; effective_hash: string } {
  const content_hash = sha256Hex(canonJson(def)); // canonical JSON → stable across formatting
  const dependency_hash = EMPTY_DEPENDENCY_HASH; // v0: dependency closure (referenced types) is the next layer
  const effective_hash = effectiveHash(content_hash, dependency_hash);
  return { content_hash, dependency_hash, effective_hash };
}

/** Validate, hash, and (when a genome_dir is provided) PERSIST + LEDGER-SEAL. Without a
 *  genome_dir the identity is still computed + returned (validation path); with one, the
 *  agent is written to agents/<slug>.json and the effective_hash is recorded in the
 *  append-only ledger — the only way an agent enters the substrate of truth. */
export function sealAgentDefinition(def: AgentDef, ledger: Ledger, genome_dir?: string): SealResult {
  const agent = defineAgent(def); // composition-rule validation (throws on illegal pipeline)
  const { content_hash, dependency_hash, effective_hash } = agentIdentity(def);
  if (genome_dir) {
    writeGenomeFileVersioned(genome_dir, "agents", def.slug, JSON.stringify(def, null, 2) + "\n");
    const now = new Date().toISOString();
    ledger.append({
      gig_id: `define:${def.slug}:${randomUUID()}`,
      standard_slug: "agent_define",
      genome_hash: effective_hash, // the agent's identity claim
      run_fingerprint: effective_hash,
      output_hashes: [content_hash],
      started_at: now,
      finished_at: now,
    });
  }
  return { agent, content_hash, dependency_hash, effective_hash };
}
