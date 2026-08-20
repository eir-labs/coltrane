// MCP-sole-writer + canonical identity sealing (the substrate-of-truth loop, O26).
// A definition's identity is its canonical hash chain (content → dependency → effective),
// NOT its bytes. sealAgentDefinition is the blessed write path: validate → hash → (when a
// genome_dir is given) write the content-addressed file AND append a ledger entry keyed
// standard_slug="agent_define", genome_hash=effective_hash. A hand-edited file with no
// such ledger entry is an orphan — no identity, outside the substrate.
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { writeFileAtomic } from "./fs_atomic.js";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { defineAgent, type Agent, type AgentDef } from "./composition.js";
import { canonJson, sha256Hex, effectiveHash, EMPTY_DEPENDENCY_HASH } from "./canonical_form.js";
import { LEDGER_SCHEMA_VERSION, type Ledger } from "./ledger.js";

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
      // History first, and atomically: this is the only copy of the bytes about to be replaced.
      writeFileAtomic(join(histDir, `${prior}.json`), oldBytes);
      result = { overwritten: true, prior_content_hash: prior };
    }
  }
  // Atomic replace. `sealDefinition` records this definition's identity in the ledger BEFORE
  // calling here (#218) — a deliberate ordering, safe only if the write either happens or does
  // not. A bare writeFileSync interrupted partway (crash, SIGKILL, ENOSPC) leaves a truncated
  // file, so the ledger asserts a definition at a content hash whose bytes hash to something
  // else. That is the engine's central provenance claim failing with nothing to notice it.
  writeFileAtomic(path, jsonText);
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
  detail?: Record<string, unknown>,
  // The FILE this definition materialises to, when its ledger identity (`slug`) and its
  // on-disk filename must differ. A version-producing seal (type_extend) records the versioned
  // identity `<slug>@v<n>` in the ledger — the subject the substrate reasons about — while the
  // loader keys domain types by version from file CONTENT and resolves the bare `<slug>.json`
  // (DomainTypeMap.get). An `@v` filename would be an unresolvable file the loader never reads —
  // the same defect wearing a version number. Defaults to `slug`, so every existing caller
  // (type_register, standard_compose) writes `<slug>.json` exactly as before.
  fileSlug: string = slug,
): { content_hash: string; dependency_hash: string; effective_hash: string } {
  const content_hash = sha256Hex(canonJson(def));
  const dependency_hash = EMPTY_DEPENDENCY_HASH;
  const effective_hash = effectiveHash(content_hash, dependency_hash);
  if (genome_dir) {
    // #218 — SEAL BEFORE WRITE. The reverse order manufactures the exact orphan this module's
    // header calls "outside the substrate": if the append throws (ENOSPC/EACCES — the
    // LedgerError path at src/ledger.ts), the definition is already on disk and loadable with
    // no identity, while dispatchTool tells the caller nothing happened. Recording an identity
    // whose file failed to materialise is the safe direction: the next write retries, and the
    // ledger never claims less than reality.
    const now = new Date().toISOString();
    ledger.append({
      kind: "genome_mutation",
      schema_version: LEDGER_SCHEMA_VERSION,
      entry_id: `${kind}:${slug}:${randomUUID()}`,
      event: kind,
      subject_slug: slug,
      content_hash,
      dependency_hash,
      effective_hash,
      output_hashes: [content_hash],
      started_at: now,
      finished_at: now,
      // #234 — the authoring rationale, which the tools accepted and dropped.
      ...(detail && Object.keys(detail).length ? { detail } : {}),
    });
    writeGenomeFileVersioned(genome_dir, subdir, fileSlug, JSON.stringify(def, null, 2) + "\n");
  }
  return { content_hash, dependency_hash, effective_hash };
}

/** Ledger-only identity seal — for version-producing mutations (type_extend, agent_evolve)
 *  whose new-version FILE materialization needs version-aware loader support (the one named
 *  boundary). The identity is still sealed in the append-only ledger, so the mutation is
 *  never a contract lie: its effective_hash is recorded even before the file lands. */
export function recordIdentity(kind: string, slug: string, def: unknown, ledger: Ledger, detail?: Record<string, unknown>): { content_hash: string; dependency_hash: string; effective_hash: string } {
  const content_hash = sha256Hex(canonJson(def));
  const dependency_hash = EMPTY_DEPENDENCY_HASH;
  const effective_hash = effectiveHash(content_hash, dependency_hash);
  const now = new Date().toISOString();
  ledger.append({
    kind: "genome_mutation",
    schema_version: LEDGER_SCHEMA_VERSION,
    entry_id: `${kind}:${slug}:${randomUUID()}`,
    event: kind,
    subject_slug: slug,
    content_hash,
    dependency_hash,
    effective_hash,
    output_hashes: [content_hash],
    started_at: now,
    finished_at: now,
    // #234 — the authoring tools advertised a `reason` and threw it away, so the seal recorded
    // what changed and never why. Omitted entirely when there is nothing to say, so an entry
    // with no rationale stays byte-identical to one written before the field existed.
    ...(detail && Object.keys(detail).length ? { detail } : {}),
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
    // #218 — seal before write (see sealDefinition).
    const now = new Date().toISOString();
    ledger.append({
      kind: "genome_mutation",
      schema_version: LEDGER_SCHEMA_VERSION,
      entry_id: `agent_define:${def.slug}:${randomUUID()}`,
      event: "agent_define",
      subject_slug: def.slug,
      content_hash,
      dependency_hash,
      effective_hash, // the agent's identity claim
      output_hashes: [content_hash],
      started_at: now,
      finished_at: now,
    });
    writeGenomeFileVersioned(genome_dir, "agents", def.slug, JSON.stringify(def, null, 2) + "\n");
  }
  return { agent, content_hash, dependency_hash, effective_hash };
}

/** Persist a skill as the LOADABLE PACKAGE the loader reads — skills/<slug>/{meta.json, skill.mjs?,
 *  skill.md?, fixtures/*.json} — not a flat skills/<slug>.json the loader skips. The content fields
 *  (`code` → skill.mjs, `md` → skill.md) and each fixture become their own files; meta.json holds the
 *  remaining declared fields. Identity is hashed over the full canonical def, so the content_hash is
 *  stable regardless of the on-disk split. Closes the skill_define → reload roundtrip (audit E).
 *  The caller MUST pre-validate completeness (≥1 fixture + a code/reasoning half) — the loader
 *  hard-fails an incomplete package, so an incomplete write would crash the next genome load. */
export function sealSkillPackage(
  def: Record<string, unknown> & { slug: string },
  ledger: Ledger,
  genome_dir?: string,
): { content_hash: string; dependency_hash: string; effective_hash: string } {
  const content_hash = sha256Hex(canonJson(def));
  const dependency_hash = EMPTY_DEPENDENCY_HASH;
  const effective_hash = effectiveHash(content_hash, dependency_hash);
  if (genome_dir) {
    // #218 — seal before write. This helper is the worst offender in the reverse order: it
    // materialises meta.json, skill.mjs, skill.md and every fixture before appending, so a
    // failed append left a PARTIAL package plus no identity.
    const sealedAt = new Date().toISOString();
    ledger.append({
      kind: "genome_mutation",
      schema_version: LEDGER_SCHEMA_VERSION,
      entry_id: `skill_define:${def.slug}:${randomUUID()}`,
      event: "skill_define",
      subject_slug: def.slug,
      content_hash,
      dependency_hash,
      effective_hash,
      output_hashes: [content_hash],
      started_at: sealedAt,
      finished_at: sealedAt,
    });
    const pkgDir = join(genome_dir, "skills", def.slug);
    mkdirSync(pkgDir, { recursive: true });
    const { fixtures, code, md, ...meta } = def;
    writeFileSync(join(pkgDir, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
    if (typeof code === "string") writeFileSync(join(pkgDir, "skill.mjs"), code);
    if (typeof md === "string") writeFileSync(join(pkgDir, "skill.md"), md);
    if (Array.isArray(fixtures)) {
      const fxDir = join(pkgDir, "fixtures");
      mkdirSync(fxDir, { recursive: true });
      fixtures.forEach((fx, i) =>
        writeFileSync(join(fxDir, `fixture-${String(i + 1).padStart(3, "0")}.json`), JSON.stringify(fx, null, 2) + "\n"),
      );
    }
  }
  return { content_hash, dependency_hash, effective_hash };
}
