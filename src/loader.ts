import { readdirSync, readFileSync, existsSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, extname } from "node:path";
import { defineAgent, composeStandard, CompositionError, type Agent, type Standard, type PhaseDef } from "./composition.js";
import type { Primitive } from "./core_types.js";

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
}
// Skills and evals have no composer yet — load them as slug-keyed records (structurally
// validated: slug present + unique). Their richer contracts are a later layer.
export interface SkillRecord { slug: string; [k: string]: unknown }
export interface EvalRecord { slug: string; [k: string]: unknown }

export interface LoadedGenome {
  core_types: ReadonlyMap<string, CoreTypeRecord>;
  domain_types: ReadonlyMap<string, DomainTypeRecord>;
  agents: ReadonlyMap<string, Agent>;
  standards: ReadonlyMap<string, Standard>;
  skills: ReadonlyMap<string, SkillRecord>;
  evals: ReadonlyMap<string, EvalRecord>;
}

interface LoadedJsonFile<T> { readonly path: string; readonly data: T }

function readJsonDir<T>(dir: string): LoadedJsonFile<T>[] {
  if (!existsSync(dir)) return [];
  const out: LoadedJsonFile<T>[] = [];
  for (const name of readdirSync(dir)) {
    if (extname(name) !== ".json") continue;
    const path = join(dir, name);
    if (!statSync(path).isFile()) continue;
    out.push({ path, data: JSON.parse(readFileSync(path, "utf-8")) as T });
  }
  return out;
}

const REQUIRED_CORE_SLUGS = new Set([
  "Signal",
  "Interpretation",
  "Judgment",
  "Plan",
  "Artifact",
  "Verdict",
]);

export class GenomeLoadError extends Error {}

export function loadGenome(root: string): LoadedGenome {
  const coreList = readJsonDir<CoreTypeRecord>(join(root, "core_types"));
  const domainList = readJsonDir<DomainTypeRecord>(join(root, "domain_types"));

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

  const domain_types = new Map<string, DomainTypeRecord>();
  const domain_type_paths = new Map<string, string>();
  for (const { path, data: d } of domainList) {
    const key = `${d.slug}@${d.version}`;
    if (domain_types.has(key)) {
      throw new GenomeLoadError(
        `duplicate domain type "${key}" in ${path} (first seen in ${domain_type_paths.get(key)})`,
      );
    }
    if (!core_types.has(d.extends)) {
      throw new GenomeLoadError(
        `domain type "${d.slug}" in ${path}: field "extends" references "${d.extends}" which is not a core type`,
      );
    }
    domain_types.set(key, d);
    domain_type_paths.set(key, path);
  }

  // agents/ — each file is an AgentDef; validated through defineAgent (same path as code).
  const agents = new Map<string, Agent>();
  const agent_paths = new Map<string, string>();
  for (const { path, data: def } of readJsonDir<AgentFileDef>(join(root, "agents"))) {
    if (agents.has(def.slug)) {
      throw new GenomeLoadError(
        `duplicate agent slug "${def.slug}" in ${path} (first seen in ${agent_paths.get(def.slug)})`,
      );
    }
    try {
      agents.set(def.slug, defineAgent(def));
      agent_paths.set(def.slug, path);
    } catch (e) {
      if (e instanceof CompositionError) throw new GenomeLoadError(`agent "${def.slug}" in ${path}: ${e.message}`);
      throw e;
    }
  }

  // standards/ — resolve agent_slugs against loaded agents, then composeStandard.
  const standards = new Map<string, Standard>();
  const standard_paths = new Map<string, string>();
  for (const { path, data: def } of readJsonDir<StandardFileDef>(join(root, "standards"))) {
    if (standards.has(def.slug)) {
      throw new GenomeLoadError(
        `duplicate standard slug "${def.slug}" in ${path} (first seen in ${standard_paths.get(def.slug)})`,
      );
    }
    const resolved: Agent[] = [];
    for (const slug of def.agent_slugs ?? []) {
      const a = agents.get(slug);
      if (!a) {
        throw new GenomeLoadError(
          `standard "${def.slug}" in ${path}: field "agent_slugs" references unknown agent "${slug}"`,
        );
      }
      resolved.push(a);
    }
    try {
      standards.set(def.slug, composeStandard({ slug: def.slug, domain: def.domain, agents: resolved, phases: def.phases }));
      standard_paths.set(def.slug, path);
    } catch (e) {
      if (e instanceof CompositionError) throw new GenomeLoadError(`standard "${def.slug}" in ${path}: ${e.message}`);
      throw e;
    }
  }

  // skills/ + evals/ — slug-keyed records (no composer yet; slug present + unique).
  const skills = new Map<string, SkillRecord>();
  const skill_paths = new Map<string, string>();
  for (const { path, data: s } of readJsonDir<SkillRecord>(join(root, "skills"))) {
    if (!s.slug) throw new GenomeLoadError(`skill file ${path}: required field "slug" is missing`);
    if (skills.has(s.slug)) {
      throw new GenomeLoadError(
        `duplicate skill slug "${s.slug}" in ${path} (first seen in ${skill_paths.get(s.slug)})`,
      );
    }
    skills.set(s.slug, s);
    skill_paths.set(s.slug, path);
  }
  const evals = new Map<string, EvalRecord>();
  const eval_paths = new Map<string, string>();
  for (const { path, data: e } of readJsonDir<EvalRecord>(join(root, "evals"))) {
    if (!e.slug) throw new GenomeLoadError(`eval file ${path}: required field "slug" is missing`);
    if (evals.has(e.slug)) {
      throw new GenomeLoadError(
        `duplicate eval slug "${e.slug}" in ${path} (first seen in ${eval_paths.get(e.slug)})`,
      );
    }
    evals.set(e.slug, e);
    eval_paths.set(e.slug, path);
  }

  return { core_types, domain_types, agents, standards, skills, evals };
}
