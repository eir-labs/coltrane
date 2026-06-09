import { readdirSync, readFileSync, existsSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, extname } from "node:path";
import { defineAgent, composeStandard, CompositionError, type Agent, type Standard, type PhaseDef } from "./composition.js";
import type { Primitive } from "./core_types.js";
import { CANONICAL_CORE_TYPES } from "./canonical_core_types.js";

export interface CoreTypeRecord {
  slug: string;
  primitive: string;
  description: string;
  schema: object;
}

export interface DomainTypeRecord {
  slug: string;
  version: number;
  extends: string;
  domain: string;
  status: "active" | "deprecated" | "retired";
  schema: object;
  required_fields: readonly string[];
}

// On-disk shapes for the remaining three definition classes. Agents are AgentDef-shaped
// (validated through defineAgent). A standard file references its agents by slug (DRY —
// agents are authored once under agents/) and is composed through composeStandard.
export interface AgentFileDef {
  slug: string;
  primitives: readonly Primitive[];
  input_types?: readonly string[];
  output_types?: readonly string[];
  domain?: string;
  allowed_tools?: readonly string[];   // blast-radius cage — declared in the genome file
  disallowed_tools?: readonly string[];
}
export interface StandardFileDef {
  slug: string;
  domain: string;
  agent_slugs: readonly string[];
  phases: readonly PhaseDef[];
  eval_slugs?: readonly string[];
}
// Skills and evals have no composer yet — load them as slug-keyed records (structurally
// validated: slug present + unique). Their richer contracts are a later layer.
export interface SkillRecord { slug: string; [k: string]: unknown }
export interface EvalRecord { slug: string; [k: string]: unknown }

// Per-definition load failure record. Surfaced via LoadedGenome.load_errors
// so one broken file no longer blocks the whole genome (Rob #129). The strict
// gate around core_types still hard-throws — that's the minimum the system
// needs to function. Anything past that softens.
export interface LoadError {
  readonly kind: "domain_type" | "agent" | "standard" | "skill" | "eval";
  readonly path: string;
  readonly slug: string | null;
  readonly error: string;
}

export interface LoadedGenome {
  core_types: ReadonlyMap<string, CoreTypeRecord>;
  domain_types: ReadonlyMap<string, DomainTypeRecord>;
  agents: ReadonlyMap<string, Agent>;
  // Mutable: the live server shares this map as deps.standards so MCP write-path
  // tools (standard_compose) can make a definition dispatchable in-session.
  standards: Map<string, Standard>;
  // Mutable: shared as deps.skills so skill_define writes through to the live map.
  skills: Map<string, SkillRecord>;
  evals: Map<string, EvalRecord>;
  // Rob #129 — per-definition load failures recorded here instead of throwing.
  load_errors: LoadError[];
}

export class GenomeLoadError extends Error {}

interface LoadedJsonFile<T> { readonly path: string; readonly data: T }
interface ParseFailure { readonly path: string; readonly error: string }

/**
 * Read every *.json file in `dir`. Files that fail to read or parse are
 * accumulated into `parse_failures` instead of throwing — the caller (per
 * Rob #129) decides whether the failure is hard (core types) or soft
 * (definitions). Filesystem-level errors (readFileSync) still throw because
 * they indicate the directory itself is unreadable.
 */
function readJsonDir<T>(dir: string): { files: LoadedJsonFile<T>[]; parse_failures: ParseFailure[] } {
  if (!existsSync(dir)) return { files: [], parse_failures: [] };
  const files: LoadedJsonFile<T>[] = [];
  const parse_failures: ParseFailure[] = [];
  for (const name of readdirSync(dir)) {
    if (extname(name) !== ".json") continue;
    const path = join(dir, name);
    if (!statSync(path).isFile()) continue;
    let raw: string;
    try {
      raw = readFileSync(path, "utf-8");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new GenomeLoadError(`failed to read ${path}: ${msg}`);
    }
    try {
      files.push({ path, data: JSON.parse(raw) as T });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      parse_failures.push({ path, error: `malformed JSON at ${path}: ${msg}` });
    }
  }
  return { files, parse_failures };
}

const REQUIRED_CORE_SLUGS = new Set([
  "Signal",
  "Interpretation",
  "Judgment",
  "Plan",
  "Artifact",
  "Verdict",
]);

export function loadGenome(root: string): LoadedGenome {
  const load_errors: LoadError[] = [];

  // core_types/ stays STRICTLY hard-fail: the system can't function without
  // the six core slugs, so soft-fail would just delay the inevitable crash
  // somewhere downstream. Parse failures here throw too — same logic.
  const coreRead = readJsonDir<CoreTypeRecord>(join(root, "core_types"));
  const firstCoreFailure = coreRead.parse_failures[0];
  if (firstCoreFailure) {
    throw new GenomeLoadError(firstCoreFailure.error);
  }
  // Genome extension Phase 1 (docs/genome-extension.md): when a genome root has NO
  // core_types/ of its own, seed the canonical, immutable 6 the engine owns — so a
  // downstream consumer boots without hand-copying core substrate. A PARTIAL
  // core_types/ (some-but-not-all 6) still hard-fails the strict gate below; that's
  // a corrupt genome, not a fresh one.
  const coreList =
    coreRead.files.length > 0
      ? coreRead.files
      : CANONICAL_CORE_TYPES.map((data) => ({ path: "<engine-canonical>", data }));

  const core_types = new Map<string, CoreTypeRecord>();
  const core_type_paths = new Map<string, string>();
  for (const { path, data: c } of coreList) {
    if (core_types.has(c.slug)) {
      throw new GenomeLoadError(
        `duplicate core type slug "${c.slug}" in ${path} (first seen in ${core_type_paths.get(c.slug)})`,
      );
    }
    core_types.set(c.slug, c);
    core_type_paths.set(c.slug, path);
  }

  const missing = [...REQUIRED_CORE_SLUGS].filter((s) => !core_types.has(s));
  if (missing.length > 0) {
    throw new GenomeLoadError(
      `core_types/ missing required slugs: ${missing.join(", ")}`,
    );
  }
  if (core_types.size !== REQUIRED_CORE_SLUGS.size) {
    const extra = [...core_types.keys()].filter((s) => !REQUIRED_CORE_SLUGS.has(s));
    throw new GenomeLoadError(
      `core_types/ contains non-spec slugs: ${extra.join(", ")} (core set is immutable; v2 spec §2)`,
    );
  }

  // domain_types/ — past the core gate, soft-fail. One broken type no longer
  // kills the genome. Each parse-failure becomes a typed LoadError.
  const domainRead = readJsonDir<DomainTypeRecord>(join(root, "domain_types"));
  for (const f of domainRead.parse_failures) {
    load_errors.push({ kind: "domain_type", path: f.path, slug: null, error: f.error });
  }
  const domain_types = new Map<string, DomainTypeRecord>();
  const domain_type_paths = new Map<string, string>();
  for (const { path, data: d } of domainRead.files) {
    try {
      const key = `${d.slug}@${d.version}`;
      if (domain_types.has(key)) {
        throw new Error(
          `duplicate domain type "${key}" in ${path} (first seen in ${domain_type_paths.get(key)})`,
        );
      }
      if (!core_types.has(d.extends)) {
        throw new Error(
          `field "extends" references "${d.extends}" which is not a core type`,
        );
      }
      domain_types.set(key, d);
      domain_type_paths.set(key, path);
    } catch (e) {
      load_errors.push({
        kind: "domain_type",
        path,
        slug: typeof d?.slug === "string" ? d.slug : null,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // agents/ — each file is an AgentDef; validated through defineAgent. Soft-fail
  // per file: a broken agent does not block other agents from loading.
  const agentRead = readJsonDir<AgentFileDef>(join(root, "agents"));
  for (const f of agentRead.parse_failures) {
    load_errors.push({ kind: "agent", path: f.path, slug: null, error: f.error });
  }
  const agents = new Map<string, Agent>();
  const agent_paths = new Map<string, string>();
  for (const { path, data: def } of agentRead.files) {
    const slug = typeof def?.slug === "string" ? def.slug : null;
    try {
      if (!def.slug || typeof def.slug !== "string") {
        throw new Error(`missing required "slug" field`);
      }
      if (agents.has(def.slug)) {
        throw new Error(
          `duplicate agent slug "${def.slug}" (first seen in ${agent_paths.get(def.slug)})`,
        );
      }
      agents.set(def.slug, defineAgent(def));
      agent_paths.set(def.slug, path);
    } catch (e) {
      load_errors.push({
        kind: "agent",
        path,
        slug,
        error: e instanceof CompositionError || e instanceof Error ? e.message : String(e),
      });
    }
  }

  // standards/ — resolve agent_slugs against loaded agents, then composeStandard.
  // Soft-fail per file. A standard that references a missing-or-broken agent
  // gets skipped + recorded; other standards still load.
  const standardRead = readJsonDir<StandardFileDef>(join(root, "standards"));
  for (const f of standardRead.parse_failures) {
    load_errors.push({ kind: "standard", path: f.path, slug: null, error: f.error });
  }
  const standards = new Map<string, Standard>();
  const standard_paths = new Map<string, string>();
  for (const { path, data: def } of standardRead.files) {
    const slug = typeof def?.slug === "string" ? def.slug : null;
    try {
      if (!def.slug || typeof def.slug !== "string") {
        throw new Error(`missing required "slug" field`);
      }
      if (standards.has(def.slug)) {
        throw new Error(
          `duplicate standard slug "${def.slug}" (first seen in ${standard_paths.get(def.slug)})`,
        );
      }
      const resolved: Agent[] = [];
      for (const aslug of def.agent_slugs ?? []) {
        const a = agents.get(aslug);
        if (!a) {
          throw new Error(`field "agent_slugs" references unknown agent "${aslug}"`);
        }
        resolved.push(a);
      }
      // Pass eval_slugs through to composeStandard when present (added in #128).
      standards.set(def.slug, composeStandard({
        slug: def.slug,
        domain: def.domain,
        agents: resolved,
        phases: def.phases,
        ...(def.eval_slugs ? { eval_slugs: def.eval_slugs } : {}),
      }));
      standard_paths.set(def.slug, path);
    } catch (e) {
      load_errors.push({
        kind: "standard",
        path,
        slug,
        error: e instanceof CompositionError || e instanceof Error ? e.message : String(e),
      });
    }
  }

  // skills/ + evals/ — slug-keyed records. Soft-fail per file.
  const skillRead = readJsonDir<SkillRecord>(join(root, "skills"));
  for (const f of skillRead.parse_failures) {
    load_errors.push({ kind: "skill", path: f.path, slug: null, error: f.error });
  }
  const skills = new Map<string, SkillRecord>();
  const skill_paths = new Map<string, string>();
  for (const { path, data: s } of skillRead.files) {
    const slug = typeof s?.slug === "string" ? s.slug : null;
    try {
      if (!s.slug) throw new Error(`required field "slug" is missing`);
      if (skills.has(s.slug)) {
        throw new Error(`duplicate skill slug "${s.slug}" (first seen in ${skill_paths.get(s.slug)})`);
      }
      skills.set(s.slug, s);
      skill_paths.set(s.slug, path);
    } catch (e) {
      load_errors.push({ kind: "skill", path, slug, error: e instanceof Error ? e.message : String(e) });
    }
  }

  const evalRead = readJsonDir<EvalRecord>(join(root, "evals"));
  for (const f of evalRead.parse_failures) {
    load_errors.push({ kind: "eval", path: f.path, slug: null, error: f.error });
  }
  const evals = new Map<string, EvalRecord>();
  const eval_paths = new Map<string, string>();
  for (const { path, data: e } of evalRead.files) {
    const slug = typeof e?.slug === "string" ? e.slug : null;
    try {
      if (!e.slug) throw new Error(`required field "slug" is missing`);
      if (evals.has(e.slug)) {
        throw new Error(`duplicate eval slug "${e.slug}" (first seen in ${eval_paths.get(e.slug)})`);
      }
      evals.set(e.slug, e);
      eval_paths.set(e.slug, path);
    } catch (err) {
      load_errors.push({ kind: "eval", path, slug, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { core_types, domain_types, agents, standards, skills, evals, load_errors };
}
