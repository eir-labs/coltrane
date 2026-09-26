// MCP-sole-writer + canonical identity sealing (the substrate-of-truth loop, O26).
// A definition's identity is its canonical hash chain (content → dependency → effective),
// NOT its bytes. sealAgentDefinition is the blessed write path: validate → hash → (when a
// genome_dir is given) write the content-addressed file AND append a ledger entry keyed
// standard_slug="agent_define", genome_hash=effective_hash. A hand-edited file with no
// such ledger entry is an orphan — no identity, outside the substrate.
import { writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { containedPath } from "./contained_path.js";
import { randomUUID } from "node:crypto";
import { defineAgent, type Agent, type AgentDef } from "./composition.js";
import { canonJson, sha256Hex, effectiveHash, EMPTY_DEPENDENCY_HASH } from "./canonical_form.js";
import { LEDGER_SCHEMA_VERSION, type Ledger } from "./ledger.js";

/**
 * A genome write whose every fallible step has already run, waiting for its commit.
 *
 * WHY STAGED (#559, on top of #218). `sealDefinition` records a definition's identity in the ledger
 * BEFORE the file lands (#218), so a failed append cannot leave a file with no identity. The reverse
 * hazard is a failed WRITE after a successful append: a sealed row naming bytes that never landed.
 * The NUL-byte slug did exactly that — the append succeeded and the write threw — leaving an orphan
 * identity. So a seal now runs in three steps:
 *
 *   1. stage   — containment check, directories, the new bytes and the history snapshot written to
 *                unique temp files. Every step that can fail for a reason of the caller's or the
 *                disk's making (a hostile path, ENOSPC, EACCES) fails HERE, before anything is sealed.
 *   2. seal    — the ledger append. If it throws, `abort()` removes the temps and any directory the
 *                stage created, so no orphan file either (#218's law holds unchanged).
 *   3. commit  — rename(2)s only, history first. What can still fail here is a rename within one
 *                directory the stage just wrote into — not a write.
 */
export interface StagedWrite<T> {
  commit(): T;
  abort(): void;
}

/** Remove the temps a stage wrote and the first directory it created (mkdirSync recursive returns
 *  it), so an aborted stage leaves the tree as it found it. Best-effort: abort runs on a failure
 *  path and must not mask the error that caused it. */
function undoStage(temps: string[], createdDir: string | undefined): void {
  for (const t of temps) {
    try { rmSync(t, { force: true }); } catch { /* the original error is the one to surface */ }
  }
  if (createdDir) {
    try { rmSync(createdDir, { recursive: true, force: true }); } catch { /* as above */ }
  }
}

/** Stage `<subdir>/<slug>.json` (and, when it would displace different bytes, the prior version's
 *  history snapshot under genome/history/<subdir>/<slug>/). Both paths are checked against their
 *  OWN directory before anything is touched: the file against `<subdir>/`, the snapshot against
 *  `genome/history/<subdir>/`. */
export function stageGenomeFileVersioned(
  genome_dir: string,
  subdir: string,
  slug: string,
  jsonText: string,
): StagedWrite<{ overwritten: boolean; prior_content_hash?: string }> {
  const dir = join(genome_dir, subdir);
  const path = containedPath(`genome write (${subdir})`, dir, slug, ".json");
  const histRoot = join(genome_dir, "genome", "history", subdir);
  const histDir = containedPath(`genome history (${subdir})`, histRoot, slug);
  const temps: string[] = [];
  let created: string | undefined;
  try {
    created = mkdirSync(dirname(path), { recursive: true });
    let result: { overwritten: boolean; prior_content_hash?: string } = { overwritten: false };
    let hist: { tmp: string; file: string } | undefined;
    if (existsSync(path)) {
      const oldBytes = readFileSync(path, "utf-8");
      if (oldBytes !== jsonText) {
        const prior = sha256Hex(oldBytes);
        const createdHist = mkdirSync(histDir, { recursive: true });
        created ??= createdHist;
        // History first, and atomically: this is the only copy of the bytes about to be replaced.
        const file = join(histDir, `${prior}.json`);
        const tmp = `${file}.${randomUUID()}.tmp`;
        temps.push(tmp);
        writeFileSync(tmp, oldBytes, "utf8");
        hist = { tmp, file };
        result = { overwritten: true, prior_content_hash: prior };
      }
    }
    // Atomic replace (write a temp, rename over). A bare writeFileSync interrupted partway leaves a
    // truncated file, so the ledger would assert a content hash whose bytes hash to something else.
    const tmp = `${path}.${randomUUID()}.tmp`;
    temps.push(tmp);
    writeFileSync(tmp, jsonText, "utf8");
    return {
      commit() {
        try {
          if (hist) renameSync(hist.tmp, hist.file);
          renameSync(tmp, path);
        } catch (e) {
          undoStage(temps, undefined);
          throw e;
        }
        return result;
      },
      abort() { undoStage(temps, created); },
    };
  } catch (e) {
    undoStage(temps, created);
    throw e;
  }
}

/**
 * Write a genome file, preserving any prior version's BYTES before a destructive
 * overwrite. The ledger already keeps the content-hash *identity* of every seal;
 * this keeps the actual prior *content*, so a re-compose / re-define / evolve over
 * an existing slug is recoverable, not just provably-changed.
 *
 * When <subdir>/<slug>.json already exists with DIFFERENT bytes, the old bytes are
 * snapshotted to genome/history/<subdir>/<slug>/<oldContentHash>.json before the overwrite
 * (WO-F06: a git-TRACKED sibling of genome/ledger.jsonl, so a fresh clone carries prior
 * versions instead of losing them to the gitignored .coltrane/). Identical bytes → no
 * snapshot (idempotent no-op). Returns the prior content hash when an overwrite displaced
 * real content. A slug whose path would leave `<subdir>/` (or whose history would leave
 * genome/history/<subdir>/) is refused before either path is touched (#559).
 */
export function writeGenomeFileVersioned(
  genome_dir: string,
  subdir: string,
  slug: string,
  jsonText: string,
): { overwritten: boolean; prior_content_hash?: string } {
  return stageGenomeFileVersioned(genome_dir, subdir, slug, jsonText).commit();
}

/** Seal, then commit — or, if the seal throws, abort the stage. The one ordering every blessed
 *  writer uses, so a refused or failing write seals nothing and a failed seal writes nothing. */
function sealThenCommit<T>(staged: StagedWrite<T>, seal: () => void): T {
  try {
    seal();
  } catch (e) {
    staged.abort();
    throw e;
  }
  return staged.commit();
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
    // #559 — STAGE FIRST. The containment check and every fallible write run before the seal, so a
    // refused slug (or a disk that will not take the bytes) seals nothing. The file checked is the
    // one written: `fileSlug`, not the ledger identity `slug`.
    const staged = stageGenomeFileVersioned(genome_dir, subdir, fileSlug, JSON.stringify(def, null, 2) + "\n");
    // #218 — SEAL BEFORE the file becomes visible. The reverse order manufactures the exact orphan
    // this module's header calls "outside the substrate": if the append throws (ENOSPC/EACCES — the
    // LedgerError path at src/ledger.ts), the stage is aborted and nothing lands.
    sealThenCommit(staged, () => {
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
    });
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
    // #559 stage, #218 seal, then commit (see sealDefinition).
    const staged = stageGenomeFileVersioned(genome_dir, "agents", def.slug, JSON.stringify(def, null, 2) + "\n");
    sealThenCommit(staged, () => {
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
    });
  }
  return { agent, content_hash, dependency_hash, effective_hash };
}

/** Stage a skill PACKAGE — skills/<slug>/{meta.json, skill.mjs?, skill.md?, fixtures/*.json} — as
 *  temp files beside their targets. The package directory is checked against `skills/` first
 *  (#559): a slug that resolves outside it, or to `skills/` itself, is refused before any directory
 *  is created. Commit renames meta.json LAST: the loader skips a package directory with no
 *  meta.json, so a package becomes loadable only once every other file is in place. Shared by the
 *  blessed writer and the file genome store, so the two file halves cannot drift. */
export function stageSkillPackage(genome_dir: string, def: Record<string, unknown> & { slug: string }): StagedWrite<void> {
  const pkgDir = containedPath("skill package write", join(genome_dir, "skills"), def.slug);
  const temps: string[] = [];
  const renames: Array<[string, string]> = [];
  let created: string | undefined;
  const stage = (file: string, text: string): void => {
    const tmp = `${file}.${randomUUID()}.tmp`;
    temps.push(tmp);
    writeFileSync(tmp, text);
    renames.push([tmp, file]);
  };
  try {
    created = mkdirSync(pkgDir, { recursive: true });
    const { fixtures, code, md, ...meta } = def;
    if (typeof code === "string") stage(join(pkgDir, "skill.mjs"), code);
    if (typeof md === "string") stage(join(pkgDir, "skill.md"), md);
    if (Array.isArray(fixtures)) {
      const fxDir = join(pkgDir, "fixtures");
      const createdFx = mkdirSync(fxDir, { recursive: true });
      created ??= createdFx;
      fixtures.forEach((fx, i) =>
        stage(join(fxDir, `fixture-${String(i + 1).padStart(3, "0")}.json`), JSON.stringify(fx, null, 2) + "\n"),
      );
    }
    stage(join(pkgDir, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
  } catch (e) {
    undoStage(temps, created);
    throw e;
  }
  return {
    commit() {
      try {
        for (const [tmp, file] of renames) renameSync(tmp, file);
      } catch (e) {
        undoStage(temps, undefined);
        throw e;
      }
    },
    abort() { undoStage(temps, created); },
  };
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
    // #559 stage, #218 seal, then commit. This helper was the worst offender in the reverse order:
    // it materialised meta.json, skill.mjs, skill.md and every fixture before appending, so a failed
    // append left a PARTIAL package plus no identity.
    const staged = stageSkillPackage(genome_dir, def);
    sealThenCommit(staged, () => {
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
    });
  }
  return { content_hash, dependency_hash, effective_hash };
}

/** The genome subdirectories whose files each carry a substrate identity — a flat `<slug>.json`
 *  whose slug must match a `genome_mutation` seal. `skills/` is deliberately excluded: a skill is a
 *  PACKAGE directory (`skills/<slug>/meta.json …`, see sealSkillPackage), not a flat file, so it
 *  needs a different scan and is reserved for a follow-up (WO-F06 non-goal). */
export const ORPHAN_SCAN_SUBDIRS = ["standards", "domain_types", "agents"] as const;

/**
 * The orphan detector (WO-F06). Correlate every genome file under `standards/`, `domain_types/`,
 * `agents/` with the `kind:"genome_mutation"` seals in the (git-tracked) genome ledger, and return
 * the files that have NONE — the orphans this module's header calls "outside the substrate": a
 * hand-edited file with no ledger entry has no identity.
 *
 * A file's slug is its basename without `.json`. It is considered sealed when some seal's
 * `subject_slug` equals that slug, OR equals that slug carrying a version tag (`<slug>@v2` — the
 * identity `type_extend`/`agent_evolve` record while still materialising `<slug>.json`, so the
 * versioned seal must not read as leaving the base file an orphan). Returns genome-relative paths
 * (`standards/orphan.json`) so a caller can name the offending file to CI.
 *
 * PURE over its two inputs: it makes no decision about WHETHER orphans should fail a run — that
 * policy (only enforced once the genome ledger actually holds seals) lives at the `coltrane validate`
 * call site, so this stays a reusable "which files lack a seal" query.
 */
export function detectGenomeOrphans(genome_dir: string, ledger: Ledger): string[] {
  const sealed = new Set<string>();
  for (const e of ledger.query({ kind: "genome_mutation" })) {
    const slug = (e as { subject_slug?: string }).subject_slug;
    // Fold `<slug>@v<n>` back to `<slug>`: the versioned identity seals the same flat file.
    if (typeof slug === "string") sealed.add(slug.split("@")[0]!);
  }
  const orphans: string[] = [];
  for (const subdir of ORPHAN_SCAN_SUBDIRS) {
    const dir = join(genome_dir, subdir);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const slug = entry.name.slice(0, -".json".length);
      if (!sealed.has(slug)) orphans.push(`${subdir}/${entry.name}`);
    }
  }
  return orphans;
}
